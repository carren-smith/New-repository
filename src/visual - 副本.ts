"use strict";
import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import DataView = powerbi.DataView;
import ISelectionManager = powerbi.extensibility.ISelectionManager;

// ============================================================
// 【迭代4 新增】报表上下⽂接⼝
// ============================================================
interface ReportContext {
    pageName: string;
    filters: FilterInfo[];
    measures: MeasureInfo[];
    tableData: TableRow[];
    columnNames: string[];
    dataRowCount: number;
    lastUpdated: string;
}

interface FilterInfo {
    table: string;
    column: string;
    values: string[];
    filterType: string;
}

interface MeasureInfo {
    name: string;
    value: string | number | null;
    formattedValue: string;
}

interface TableRow {
    [columnName: string]: string | number | null;
}

interface Message {
    text: string;
    isUser: boolean;
    timestamp: Date;
}

interface ChatHistory {
    messages: Message[];
    lastUpdate: Date;
}

interface Settings {
    llmProvider: string;
    apiKey: string;
    modelName: string;
    apiEndpoint?: string;
}

interface LLMProvider {
    id: string;
    name: string;
    defaultEndpoint: string;
    models: string[];
    requiresEndpoint: boolean;
}

export class Visual implements IVisual {
    private target: HTMLElement;
    private host: IVisualHost;
    private container: HTMLElement;
    private chatHeader: HTMLElement;
    private suggestionsArea: HTMLElement;
    private messagesContainer: HTMLElement;
    private inputContainer: HTMLElement;
    private inputField: HTMLInputElement;
    private sendButton: HTMLButtonElement;
    private settingsButton: HTMLElement;
    private settingsModal: HTMLElement;
    private messages: Message[];
    private settings: Settings;
    private historyTimeout: number;

    // ============================================================
    // 【迭代4 新增】报表上下⽂
    // ============================================================
    private reportContext: ReportContext;
    private contextBar: HTMLElement;
    private llmProviders: LLMProvider[];
    private suggestedQuestions: string[];

    constructor(options: VisualConstructorOptions) {
        this.target = options.element;
        this.host = options.host;
        this.historyTimeout = 30 * 60 * 1000;
        this.settings = {
            llmProvider: "openai",
            apiKey: "",
            modelName: "gpt-3.5-turbo",
            apiEndpoint: "https://api.openai.com/v1/chat/completions"
        };
        this.reportContext = {
            pageName: "未知⻚⾯",
            filters: [],
            measures: [],
            tableData: [],
            columnNames: [],
            dataRowCount: 0,
            lastUpdated: ""
        };
        this.llmProviders = [
            {
                id: "openai",
                name: "OpenAI",
                defaultEndpoint: "https://api.openai.com/v1/chat/completions",
                models: ["gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"],
                requiresEndpoint: false
            },
            {
                id: "deepseek",
                name: "DeepSeek",
                defaultEndpoint: "https://api.deepseek.com/v1/chat/completions",
                models: ["deepseek-chat", "deepseek-reasoner"],
                requiresEndpoint: false
            },
            {
                id: "claude",
                name: "Anthropic Claude",
                defaultEndpoint: "https://api.anthropic.com/v1/messages",
                models: ["claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307"],
                requiresEndpoint: false
            },
            {
                id: "gemini",
                name: "Google Gemini",
                defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
                models: ["gemini-pro", "gemini-1.5-pro", "gemini-1.5-flash"],
                requiresEndpoint: false
            },
            {
                id: "custom",
                name: "⾃定义模型",
                defaultEndpoint: "",
                models: [],
                requiresEndpoint: true
            }
        ];
        this.suggestedQuestions = [
            "当前⻚⾯数据概览",
            "筛选器状态是什么？",
            "帮我分析当前数据",
            "有哪些异常数据？"
        ];
        this.messages = [];
        this.loadChatHistory();
        this.createUI();
        this.loadSettings();
        if (this.messages.length === 0) {
            this.addWelcomeMessage();
        } else {
            this.renderAllMessages();
        }
        this.startHistoryCleanup();
    }

    // ============================================================
    // 【迭代4 核⼼】update() - Power BI 数据更新回调
    // ============================================================
    public update(options: VisualUpdateOptions): void {
        const dataViews = options.dataViews;
        this.reportContext = {
            pageName: this.reportContext.pageName,
            filters: [],
            measures: [],
            tableData: [],
            columnNames: [],
            dataRowCount: 0,
            lastUpdated: new Date().toLocaleString("zh-CN")
        };
        if (!dataViews || dataViews.length === 0 || !dataViews[0]) {
            this.updateContextBar();
            return;
        }
        const dataView: DataView = dataViews[0];
        this.extractFilters(dataView);
        this.extractTableData(dataView);
        this.extractMeasures(dataView);
        this.updateContextBar();
    }

    // ============================================================
    // 【迭代4 新增】提取筛选器信息
    // ============================================================
    private extractFilters(dataView: DataView): void {
        try {
            const metadata = dataView.metadata;
            if (!metadata) {
                return;
            }
            const columns = metadata.columns || [];
            columns.forEach(col => {
                if (col.isMeasure) {
                    return;
                }
                const queryName = col.queryName || "";
                const parts = queryName.split(".");
                if (parts.length >= 2) {
                    const table = parts[0];
                    const column = parts[1];
                    if (col.expr) {
                        this.reportContext.filters.push({
                            table: table,
                            column: column,
                            values: ["(已筛选)"],
                            filterType: "column"
                        });
                    }
                }
            });
        } catch (e) {
            console.warn("提取筛选器失败:", e);
        }
    }

    // ============================================================
    // 【迭代4 新增】提取表格数据
    // ============================================================
    private extractTableData(dataView: DataView): void {
        try {
            if (dataView.table) {
                const table = dataView.table;
                const columns = table.columns || [];
                this.reportContext.columnNames = columns.map(col => {
                    return col.displayName || col.queryName || "未知列";
                });
                const rows = table.rows || [];
                this.reportContext.dataRowCount = rows.length;
                const maxRows = Math.min(rows.length, 50);
                for (let i = 0; i < maxRows; i++) {
                    const row = rows[i];
                    const rowObj: TableRow = {};
                    columns.forEach((col, idx) => {
                        const colName = col.displayName || "列" + (idx + 1);
                        const val = row[idx];
                        if (val === null || val === undefined) {
                            rowObj[colName] = null;
                        } else if (typeof val === "object") {
                            rowObj[colName] = String(val);
                        } else {
                            rowObj[colName] = val as string | number;
                        }
                    });
                    this.reportContext.tableData.push(rowObj);
                }
                columns.forEach((col, idx) => {
                    if (col.isMeasure) {
                        const measureName = col.displayName || col.queryName || "度量值";
                        const firstRowVal = rows.length > 0 ? rows[0][idx] : null;
                        const measureValue = (firstRowVal !== null && firstRowVal !== undefined) ? firstRowVal : null;
                        const formattedValue = (firstRowVal !== null && firstRowVal !== undefined) ? String(firstRowVal) : "N/A";
                        this.reportContext.measures.push({
                            name: measureName,
                            value: measureValue as any,
                            formattedValue: formattedValue
                        });
                    }
                });
                return;
            }
            if (dataView.categorical) {
                const cat = dataView.categorical;
                const categories = cat.categories || [];
                const values = cat.values || [];
                categories.forEach(c => {
                    this.reportContext.columnNames.push(c.source.displayName || "维度");
                });
                values.forEach(v => {
                    const measureName = v.source.displayName || "度量值";
                    this.reportContext.columnNames.push(measureName);
                    const numericVals: number[] = [];
                    const allVals = v.values || [];
                    allVals.forEach(x => {
                        if (x !== null && typeof x === "number") {
                            numericVals.push(x);
                        }
                    });
                    const sum = numericVals.reduce((a, b) => a + b, 0);
                    const measureValue = numericVals.length > 0 ? sum : null;
                    const formattedValue = numericVals.length > 0 ? sum.toLocaleString("zh-CN") : "N/A";
                    this.reportContext.measures.push({
                        name: measureName,
                        value: measureValue,
                        formattedValue: formattedValue
                    });
                });
                const rowCount = categories.length > 0 ? (categories[0].values || []).length : 0;
                this.reportContext.dataRowCount = rowCount;
                const maxRows = Math.min(rowCount, 50);
                for (let i = 0; i < maxRows; i++) {
                    const rowObj: TableRow = {};
                    categories.forEach(c => {
                        const colName = c.source.displayName || "维度";
                        const val = c.values[i];
                        rowObj[colName] = (val === null || val === undefined) ? null : String(val);
                    });
                    values.forEach(v => {
                        const colName = v.source.displayName || "度量值";
                        const val = v.values[i];
                        if (val === null || val === undefined) {
                            rowObj[colName] = null;
                        } else if (typeof val === "number") {
                            rowObj[colName] = val;
                        } else {
                            rowObj[colName] = String(val);
                        }
                    });
                    this.reportContext.tableData.push(rowObj);
                }
            }
        } catch (e) {
            console.warn("提取表格数据失败:", e);
        }
    }

    // ============================================================
    // 【迭代4 新增】提取度量值
    // ============================================================
    private extractMeasures(dataView: DataView): void {
        try {
            const metadata = dataView.metadata;
            if (!metadata || !metadata.columns) {
                return;
            }
            metadata.columns.forEach(col => {
                if (!col.isMeasure) {
                    return;
                }
                const measureDisplayName = col.displayName || col.queryName;
                const alreadyAdded = this.reportContext.measures.some(m => m.name === measureDisplayName);
                if (!alreadyAdded) {
                    this.reportContext.measures.push({
                        name: measureDisplayName || "度量值",
                        value: null,
                        formattedValue: "N/A"
                    });
                }
            });
        } catch (e) {
            console.warn("提取度量值失败:", e);
        }
    }

    // ============================================================
    // 【迭代4 新增】构建 System Prompt
    // ============================================================
    private buildSystemPrompt(): string {
        const ctx = this.reportContext;
        let prompt = "你是一位拥有 15 年经验的资深商业智能 (BI) 专家和首席数据分析师。你擅长从错综复杂的 Power BI 报表数据中识别趋势、发现异常，并结合行业通用的分析框架（如：趋势分析、对比分析、帕累托分析等）提供决策支\n";
        prompt += "⽤户正在查看 Power BI 报表，你需要基于以下实时数据上下⽂回答⽤户的问题。你的任务是根据提供的 Power BI 报表上下文信息（页面、筛选器、度量值、数据摘要），进行专业级的解读。你的回答不仅要告诉用户“发生了什么”，更要尝试分析“为什么发生”以及“下一步该怎么做”\n\n";
        prompt += "请严格按照以下要求回答：请在分析时遵循以下思考链条（CoT）：环境认知：首先识别在当前的筛选条件下，数据代表的是哪一个细分市场/时间段/维度。显著性检测：识别度量值中是否存在大幅度波动、偏离均值的异常或明显的增长/下滑趋势。关联分析：尝试寻找不同维度之间的潜在关联（例如：某一地区的销售下滑是否与特定产品线的筛选有关）。业务诊断：基于数据表现，推测可能的业务原因\n";
        prompt += "=== 当前报表上下⽂ ===\n";
        prompt += "⻚⾯: " + ctx.pageName + "\n";
        prompt += "数据更新时间: " + ctx.lastUpdated + "\n";
        prompt += "总⾏数: " + ctx.dataRowCount + " ⾏（当前传⼊最多 50 ⾏⽤于分析）\n";
        if (ctx.filters.length > 0) {
            prompt += "\n当前筛选器:\n";
            ctx.filters.forEach(f => {
                prompt += " - " + f.table + "." + f.column + ": " + f.values.join(", ") + "\n";
            });
        } else {
            prompt += "\n当前筛选器: ⽆（显示全量数据）\n";
        }
        if (ctx.measures.length > 0) {
            prompt += "\n当前度量值:\n";
            ctx.measures.forEach(m => {
                prompt += " - " + m.name + ": " + m.formattedValue + "\n";
            });
        }
        if (ctx.columnNames.length > 0) {
            prompt += "\n数据列: " + ctx.columnNames.join(", ") + "\n";
        }
        if (ctx.tableData.length > 0) {
            prompt += "\n数据样本（前 " + ctx.tableData.length + " ⾏）:\n";
            const cols = ctx.columnNames.length > 0 ? ctx.columnNames : Object.keys(ctx.tableData[0]);
            prompt += cols.join("\t") + "\n";
            ctx.tableData.forEach(row => {
                const vals: string[] = [];
                cols.forEach(c => {
                    const v = row[c];
                    vals.push(v === null || v === undefined ? "" : String(v));
                });
                prompt += vals.join("\t") + "\n";
            });
        } else {
            prompt += "\n注意：当前视觉对象未绑定数据字段，⽆法获取具体数值。";
            prompt += "请提示⽤户在\"字段\"⾯板中拖⼊数据。\n";
        }
        prompt += "\n=== 分析要求 ===\n";
        prompt += "1. 优先基于以上数据上下⽂回答问题\n";
        prompt += "2. 如数据不⾜，说明原因并给出分析建议\n";
        prompt += "3. 回答简洁专业，可以使⽤数字、百分⽐、趋势描述\n";
        prompt += "4. 中⽂回答";
        return prompt;
    }

    // ============================================================
    // 【迭代4 新增】创建上下⽂状态栏
    // ============================================================
    private createContextBar(): void {
        this.contextBar = document.createElement("div");
        this.contextBar.className = "context-bar";
        this.updateContextBar();
    }

    private updateContextBar(): void {
        if (!this.contextBar) {
            return;
        }
        const ctx = this.reportContext;
        const hasData = ctx.columnNames.length > 0 || ctx.measures.length > 0;
        const statusIcon = hasData ? "✅" : "⚠️";
        let html = "<span class=\"ctx-icon\">" + statusIcon + "</span>";
        html += "<span class=\"ctx-text\">";
        html += ctx.columnNames.length + " 列 · ";
        html += ctx.dataRowCount + " ⾏ · ";
        html += ctx.measures.length + " 个度量值";
        html += "</span>";
        html += "<span class=\"ctx-badge\">" + (hasData ? "数据已就绪" : "未绑定数据") + "</span>";
        this.contextBar.innerHTML = html;
    }

    private createUI(): void {
        this.container = document.createElement("div");
        this.container.className = "chat-container";
        this.createHeader();
        this.createContextBar();
        this.createSuggestionsArea();
        this.messagesContainer = document.createElement("div");
        this.messagesContainer.className = "messages-container";
        this.createInputArea();
        this.createSettingsModal();
        this.container.appendChild(this.chatHeader);
        this.container.appendChild(this.contextBar);
        this.container.appendChild(this.suggestionsArea);
        this.container.appendChild(this.messagesContainer);
        this.container.appendChild(this.inputContainer);
        this.container.appendChild(this.settingsModal);
        this.target.appendChild(this.container);
        this.addStyles();
    }

    private createHeader(): void {
        this.chatHeader = document.createElement("div");
        this.chatHeader.className = "chat-header";
        const title = document.createElement("span");
        title.className = "chat-title";
        title.textContent = "ABI Chat Pro";
        const icons = document.createElement("div");
        icons.className = "chat-icons";
        const ctxBtn = document.createElement("span");
        ctxBtn.className = "icon-ctx";
        ctxBtn.innerHTML = "👁️";
        ctxBtn.title = "查看当前数据上下⽂";
        ctxBtn.addEventListener("click", () => this.showContextPreview());
        this.settingsButton = document.createElement("span");
        this.settingsButton.className = "icon-settings";
        this.settingsButton.innerHTML = "⚙";
        this.settingsButton.title = "设置";
        this.settingsButton.addEventListener("click", () => this.openSettings());
        const newChatBtn = document.createElement("span");
        newChatBtn.className = "icon-add";
        newChatBtn.innerHTML = "+";
        newChatBtn.title = "新对话";
        newChatBtn.addEventListener("click", () => this.clearChat());
        icons.appendChild(ctxBtn);
        icons.appendChild(this.settingsButton);
        icons.appendChild(newChatBtn);
        this.chatHeader.appendChild(title);
        this.chatHeader.appendChild(icons);
    }

    // ============================================================
    // 【迭代4 新增】显示上下⽂预览
    // ============================================================
    private showContextPreview(): void {
        const ctx = this.reportContext;
        const lines: string[] = [];
        lines.push(" 当前报表上下⽂");
        lines.push("─────────────────");
        lines.push("更新时间：" + (ctx.lastUpdated || "暂⽆"));
        lines.push("数据：" + ctx.columnNames.length + " 列 × " + ctx.dataRowCount + " ⾏");
        if (ctx.columnNames.length > 0) {
            const displayCols = ctx.columnNames.slice(0, 8);
            const colsText = displayCols.join("、");
            const suffix = ctx.columnNames.length > 8 ? "..." : "";
            lines.push("列名：" + colsText + suffix);
        }
        if (ctx.measures.length > 0) {
            lines.push("度量值：");
            ctx.measures.forEach(m => {
                lines.push(" • " + m.name + " = " + m.formattedValue);
            });
        }
        if (ctx.filters.length > 0) {
            lines.push("筛选器：");
            ctx.filters.forEach(f => {
                lines.push(" • " + f.table + "." + f.column);
            });
        } else {
            lines.push("筛选器：⽆");
        }
        if (ctx.columnNames.length === 0 && ctx.measures.length === 0) {
            lines.push(" 尚未绑定数据字段");
            lines.push("请在右侧\"字段\"⾯板拖⼊数据列或度量值");
        }
        const previewMsg: Message = {
            text: lines.join("\n"),
            isUser: false,
            timestamp: new Date()
        };
        this.messages.push(previewMsg);
        this.renderMessage(previewMsg);
        this.saveChatHistory();
    }

    private createSuggestionsArea(): void {
        this.suggestionsArea = document.createElement("div");
        this.suggestionsArea.className = "suggestions-area";
        const title = document.createElement("div");
        title.className = "suggestions-title";
        title.textContent = "快速提问";
        const container = document.createElement("div");
        container.className = "suggestions-container";
        this.suggestedQuestions.forEach(question => {
            const btn = document.createElement("button");
            btn.className = "suggestion-button";
            btn.textContent = question;
            btn.type = "button";
            btn.addEventListener("click", () => {
                this.inputField.value = question;
                this.sendMessage();
            });
            container.appendChild(btn);
        });
        this.suggestionsArea.appendChild(title);
        this.suggestionsArea.appendChild(container);
    }

    private createInputArea(): void {
        this.inputContainer = document.createElement("div");
        this.inputContainer.className = "input-container";
        this.inputField = document.createElement("input");
        this.inputField.type = "text";
        this.inputField.className = "input-field";
        this.inputField.placeholder = "针对当前报表⻚提问...";
        this.inputField.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.sendMessage();
            }
        });
        this.sendButton = document.createElement("button");
        this.sendButton.type = "button";
        this.sendButton.className = "send-button";
        this.sendButton.innerHTML = "→";
        this.sendButton.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.sendMessage();
        });
        this.inputContainer.appendChild(this.inputField);
        this.inputContainer.appendChild(this.sendButton);
    }

    private createSettingsModal(): void {
        this.settingsModal = document.createElement("div");
        this.settingsModal.className = "settings-modal";
        this.settingsModal.style.display = "none";
        const modalContent = document.createElement("div");
        modalContent.className = "modal-content";
        const title = document.createElement("h3");
        title.textContent = "AI 模型设置";
        title.className = "modal-title";
        const providerLabel = document.createElement("label");
        providerLabel.textContent = "LLM 提供商:";
        providerLabel.className = "settings-label";
        const providerSelect = document.createElement("select");
        providerSelect.className = "settings-input";
        providerSelect.id = "providerSelect";
        this.llmProviders.forEach(provider => {
            const option = document.createElement("option");
            option.value = provider.id;
            option.textContent = provider.name;
            if (provider.id === this.settings.llmProvider) {
                option.selected = true;
            }
            providerSelect.appendChild(option);
        });
        const apiKeyLabel = document.createElement("label");
        apiKeyLabel.textContent = "API Key:";
        apiKeyLabel.className = "settings-label";
        const apiKeyInput = document.createElement("input");
        apiKeyInput.type = "password";
        apiKeyInput.className = "settings-input";
        apiKeyInput.id = "apiKeyInput";
        apiKeyInput.placeholder = "请输⼊ API Key";
        apiKeyInput.value = this.settings.apiKey;
        const modelContainer = document.createElement("div");
        modelContainer.id = "modelContainer";
        const endpointContainer = document.createElement("div");
        endpointContainer.id = "endpointContainer";
        endpointContainer.style.display = "none";
        const endpointLabel = document.createElement("label");
        endpointLabel.textContent = "API 端点:";
        endpointLabel.className = "settings-label";
        const endpointInput = document.createElement("input");
        endpointInput.type = "text";
        endpointInput.className = "settings-input";
        endpointInput.id = "endpointInput";
        endpointInput.placeholder = "https://your-api.com/v1/chat/completions";
        endpointInput.value = this.settings.apiEndpoint || "";
        endpointContainer.appendChild(endpointLabel);
        endpointContainer.appendChild(endpointInput);
        const hintDiv = document.createElement("div");
        hintDiv.className = "settings-hint";
        hintDiv.id = "providerHint";
        const btnContainer = document.createElement("div");
        btnContainer.className = "modal-buttons";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "modal-btn save-btn";
        saveBtn.textContent = "保存设置";
        saveBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.saveSettings();
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "modal-btn cancel-btn";
        cancelBtn.textContent = "取消";
        cancelBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.closeSettings();
        });
        btnContainer.appendChild(saveBtn);
        btnContainer.appendChild(cancelBtn);
        modalContent.appendChild(title);
        modalContent.appendChild(providerLabel);
        modalContent.appendChild(providerSelect);
        modalContent.appendChild(apiKeyLabel);
        modalContent.appendChild(apiKeyInput);
        modalContent.appendChild(modelContainer);
        modalContent.appendChild(endpointContainer);
        modalContent.appendChild(hintDiv);
        modalContent.appendChild(btnContainer);
        this.settingsModal.appendChild(modalContent);
        providerSelect.addEventListener("change", () => {
            this.updateModelOptions(providerSelect.value);
        });
        this.updateModelOptions(this.settings.llmProvider);
        this.settingsModal.addEventListener("click", (e) => {
            if (e.target === this.settingsModal) {
                this.closeSettings();
            }
        });
    }

    private updateModelOptions(providerId: string): void {
        const provider = this.llmProviders.find(p => p.id === providerId);
        if (!provider) {
            return;
        }
        const modelContainer = document.getElementById("modelContainer");
        const endpointContainer = document.getElementById("endpointContainer");
        const hintDiv = document.getElementById("providerHint");
        if (!modelContainer || !endpointContainer || !hintDiv) {
            return;
        }
        modelContainer.innerHTML = "";
        const modelLabel = document.createElement("label");
        modelLabel.textContent = "模型名称:";
        modelLabel.className = "settings-label";
        modelContainer.appendChild(modelLabel);
        if (provider.id === "custom") {
            const modelInput = document.createElement("input");
            modelInput.type = "text";
            modelInput.className = "settings-input";
            modelInput.id = "modelNameInput";
            modelInput.placeholder = "例如: llama-3, qwen-max, mistral-7b";
            modelInput.value = this.settings.modelName;
            modelContainer.appendChild(modelInput);
            endpointContainer.style.display = "block";
            hintDiv.innerHTML = " ⾃定义模式：⽀持任何兼容 OpenAI API 格式的模型<br>端点示例：http://localhost:11434/v1/chat/completions";
        } else {
            const modelSelect = document.createElement("select");
            modelSelect.className = "settings-input";
            modelSelect.id = "modelSelect";
            provider.models.forEach(model => {
                const option = document.createElement("option");
                option.value = model;
                option.textContent = model;
                if (model === this.settings.modelName) {
                    option.selected = true;
                }
                modelSelect.appendChild(option);
            });
            modelContainer.appendChild(modelSelect);
            endpointContainer.style.display = "none";
            const hints: { [key: string]: string } = {
                "openai": " OpenAI 模型，API Key 以 sk- 开头",
                "deepseek": " DeepSeek 模型，前往 platform.deepseek.com 获取 API Key",
                "claude": " Anthropic Claude 模型，API Key 以 sk-ant- 开头",
                "gemini": " Google Gemini 模型，在 Google AI Studio 获取 API Key"
            };
            hintDiv.innerHTML = hints[provider.id] || "";
        }
    }

    private addStyles(): void {
        const style = document.createElement("style");
        style.textContent = `
            .chat-container {
                width: 100%;
                height: 100%;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
                background: #f5f7fa;
                position: relative;
            }
            .chat-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 14px 20px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
                flex-shrink: 0;
            }
            .chat-title {
                font-size: 18px;
                font-weight: 600;
                letter-spacing: -0.5px;
            }
            .chat-icons {
                display: flex;
                gap: 12px;
            }
            .chat-icons span {
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 16px;
                opacity: 0.9;
                transition: all 0.2s;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.15);
            }
            .chat-icons span:hover {
                opacity: 1;
                background: rgba(255, 255, 255, 0.28);
                transform: scale(1.08);
            }
            .chat-icons span:active {
                transform: scale(0.93);
            }
            .context-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 16px;
                background: #eef2ff;
                border-bottom: 1px solid #c7d2fe;
                font-size: 12px;
                color: #4338ca;
                flex-shrink: 0;
            }
            .ctx-icon {
                font-size: 11px;
            }
            .ctx-text {
                flex: 1;
                font-weight: 500;
            }
            .ctx-badge {
                padding: 2px 8px;
                background: #c7d2fe;
                color: #3730a3;
                border-radius: 20px;
                font-size: 11px;
                font-weight: 600;
            }
            .suggestions-area {
                background: white;
                padding: 10px 16px;
                border-bottom: 1px dashed #e0e5eb;
                flex-shrink: 0;
            }
            .suggestions-title {
                font-size: 11px;
                color: #8e8e93;
                margin-bottom: 6px;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .suggestions-container {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }
            .suggestion-button {
                padding: 5px 12px;
                background: #f0f4ff;
                border: 1px solid #c7d2fe;
                color: #4338ca;
                border-radius: 14px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s;
                white-space: nowrap;
            }
            .suggestion-button:hover {
                background: #667eea;
                color: white;
                border-color: #667eea;
                transform: translateY(-1px);
                box-shadow: 0 3px 8px rgba(102, 126, 234, 0.25);
            }
            .suggestion-button:active {
                transform: translateY(0);
            }
            .messages-container {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                background: white;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .message {
                display: flex;
                flex-direction: column;
                max-width: 78%;
                animation: msgIn 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            @keyframes msgIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .message.user {
                align-self: flex-end;
            }
            .message.bot {
                align-self: flex-start;
            }
            .message-bubble {
                padding: 10px 14px;
                border-radius: 16px;
                word-wrap: break-word;
                line-height: 1.55;
                white-space: pre-wrap;
                font-size: 14px;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
            }
            .message.user .message-bubble {
                background: #667eea;
                color: white;
                border-bottom-right-radius: 4px;
            }
            .message.bot .message-bubble {
                background: #f4f6fb;
                color: #1c1c1e;
                border-bottom-left-radius: 4px;
            }
            .message-time {
                font-size: 10px;
                color: #9ca3af;
                margin-top: 3px;
                padding: 0 3px;
            }
            .input-container {
                display: flex;
                flex-wrap: wrap;
                padding: 12px 16px 14px;
                background: white;
                border-top: 1px solid #e8ecf0;
                gap: 10px;
                flex-shrink: 0;
                box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.03);
            }
            .input-field {
                flex: 1;
                min-width: 0;
                padding: 10px 16px;
                border: 1.5px solid #e0e5eb;
                border-radius: 22px;
                font-size: 14px;
                outline: none;
                transition: all 0.2s;
                background: #f8fafc;
            }
            .input-field:focus {
                border-color: #667eea;
                background: white;
                box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.12);
            }
            .send-button {
                width: 44px;
                height: 44px;
                flex-shrink: 0;
                border: none;
                background: #667eea;
                color: white;
                border-radius: 50%;
                cursor: pointer;
                font-size: 18px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
                box-shadow: 0 3px 10px rgba(102, 126, 234, 0.35);
            }
            .send-button:hover {
                background: #5568d3;
                transform: scale(1.06);
            }
            .send-button:active {
                transform: scale(0.94);
            }
            .send-button:disabled {
                background: #c7c7cc;
                cursor: not-allowed;
                box-shadow: none;
                transform: none;
            }
            .settings-modal {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.48);
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            }
            .modal-content {
                background: white;
                padding: 28px;
                border-radius: 14px;
                min-width: 400px;
                max-width: 92%;
                max-height: 88vh;
                overflow-y: auto;
                box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
                animation: modalIn 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            @keyframes modalIn {
                from { opacity: 0; transform: translateY(-16px) scale(0.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .modal-title {
                margin: 0 0 20px;
                color: #1c1c1e;
                font-size: 20px;
                font-weight: 600;
            }
            .settings-label {
                display: block;
                margin-bottom: 7px;
                color: #3c3c43;
                font-size: 14px;
                font-weight: 500;
            }
            .settings-input {
                width: 100%;
                padding: 10px 14px;
                margin-bottom: 16px;
                border: 1.5px solid #e0e5eb;
                border-radius: 9px;
                font-size: 14px;
                box-sizing: border-box;
                background: #f8fafc;
                transition: all 0.2s;
            }
            .settings-input:focus {
                outline: none;
                border-color: #667eea;
                background: white;
                box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
            }
            .settings-hint {
                padding: 10px 14px;
                margin-bottom: 16px;
                background: #f0f9ff;
                border-left: 4px solid #667eea;
                border-radius: 7px;
                font-size: 13px;
                color: #1e40af;
                line-height: 1.6;
            }
            .modal-buttons {
                display: flex;
                gap: 10px;
                margin-top: 24px;
            }
            .modal-btn {
                flex: 1;
                padding: 12px 20px;
                border: none;
                border-radius: 10px;
                cursor: pointer;
                font-size: 15px;
                font-weight: 600;
                transition: all 0.2s;
            }
            .save-btn {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                box-shadow: 0 3px 10px rgba(102, 126, 234, 0.3);
            }
            .save-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 5px 16px rgba(102, 126, 234, 0.4);
            }
            .save-btn:active {
                transform: translateY(0);
            }
            .cancel-btn {
                background: #f5f7fa;
                color: #3c3c43;
                border: 1.5px solid #e0e5eb;
            }
            .cancel-btn:hover {
                background: #e8eaed;
            }
            .typing-indicator {
                display: flex;
                gap: 5px;
                padding: 10px 14px;
            }
            .typing-dot {
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background: #9ca3af;
                animation: typing 1.4s infinite ease-in-out;
            }
            .typing-dot:nth-child(2) {
                animation-delay: 0.2s;
            }
            .typing-dot:nth-child(3) {
                animation-delay: 0.4s;
            }
            @keyframes typing {
                0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
                30% { opacity: 1; transform: translateY(-5px); }
            }
            .messages-container::-webkit-scrollbar {
                width: 5px;
            }
            .messages-container::-webkit-scrollbar-track {
                background: transparent;
            }
            .messages-container::-webkit-scrollbar-thumb {
                background: #d1d5db;
                border-radius: 3px;
            }
            .messages-container::-webkit-scrollbar-thumb:hover {
                background: #9ca3af;
            }
            .error-message {
                color: #ef4444;
                font-size: 12px;
                margin-top: 6px;
                padding: 7px 11px;
                background: #fef2f2;
                border-radius: 7px;
                border: 1px solid #fecaca;
                width: 100%;
                box-sizing: border-box;
            }
        `;
        document.head.appendChild(style);
    }

    private addWelcomeMessage(): void {
        const welcomeMsg = "你好！我是 ABI Chat Pro \n\n";
        const welcomeMsg2 = "我能读取当前 Power BI 报表⻚的数据，帮你分析趋势、解读指标。\n\n";
        const welcomeMsg3 = "使⽤步骤：\n";
        const welcomeMsg4 = "1. 点击右上⻆ ⚙ 配置 AI 模型和 API Key\n";
        const welcomeMsg5 = "2. 在右侧\"字段\"⾯板拖⼊数据列或度量值\n";
        const welcomeMsg6 = "3. 直接提问，如\"帮我分析当前数据\"";
        const welcomeMessage: Message = {
            text: welcomeMsg + welcomeMsg2 + welcomeMsg3 + welcomeMsg4 + welcomeMsg5 + welcomeMsg6,
            isUser: false,
            timestamp: new Date()
        };
        this.messages.push(welcomeMessage);
        this.renderMessage(welcomeMessage);
        this.saveChatHistory();
    }

    // ============================================================
    // 【迭代4 更新】sendMessage - 注⼊报表上下⽂
    // ============================================================
    private async sendMessage(): Promise<void> {
        const text = this.inputField.value.trim();
        if (!text) {
            return;
        }
        if (!this.settings.apiKey) {
            this.showError("请先在设置中配置 API Key");
            return;
        }
        const userMessage: Message = {
            text: text,
            isUser: true,
            timestamp: new Date()
        };
        this.messages.push(userMessage);
        this.renderMessage(userMessage);
        this.saveChatHistory();
        this.inputField.value = "";
        this.sendButton.disabled = true;
        this.showTypingIndicator();
        try {
            const systemPrompt = this.buildSystemPrompt();
            const answer = await this.callLLM(text, systemPrompt);
            this.hideTypingIndicator();
            const botMessage: Message = {
                text: answer,
                isUser: false,
                timestamp: new Date()
            };
            this.messages.push(botMessage);
            this.renderMessage(botMessage);
            this.saveChatHistory();
        } catch (error) {
            this.hideTypingIndicator();
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorMessage: Message = {
                text: "请求失败：" + errorMsg,
                isUser: false,
                timestamp: new Date()
            };
            this.messages.push(errorMessage);
            this.renderMessage(errorMessage);
            this.saveChatHistory();
        } finally {
            this.sendButton.disabled = false;
        }
    }

    // ============================================================
    // 【迭代4 更新】callLLM - 增加 systemPrompt 参数
    // ============================================================
    private async callLLM(userMessage: string, systemPrompt: string): Promise<string> {
        const provider = this.llmProviders.find(p => p.id === this.settings.llmProvider);
        if (!provider) {
            throw new Error("未知的 LLM 提供商，请重新打开设置选择");
        }
        switch (provider.id) {
            case "openai":
                return await this.callOpenAI(userMessage, systemPrompt);
            case "deepseek":
                return await this.callOpenAI(userMessage, systemPrompt);
            case "claude":
                return await this.callClaude(userMessage, systemPrompt);
            case "gemini":
                return await this.callGemini(userMessage, systemPrompt);
            case "custom":
                return await this.callCustomLLM(userMessage, systemPrompt);
            default:
                throw new Error("不⽀持的提供商: " + provider.id);
        }
    }

    // ============================================================
    // 【迭代4 更新】callOpenAI - 增加 system message
    // ============================================================
    private async callOpenAI(userMessage: string, systemPrompt: string): Promise<string> {
        const apiUrl = this.settings.apiEndpoint || "https://api.openai.com/v1/chat/completions";
        const historyMessages: Array<{ role: string; content: string }> = [];
        const recentMsgs = this.messages.slice(-8);
        recentMsgs.forEach(m => {
            if (m.text === userMessage && m.isUser) {
                return;
            }
            historyMessages.push({
                role: m.isUser ? "user" : "assistant",
                content: m.text
            });
        });
        const requestMessages: Array<{ role: string; content: string }> = [];
        requestMessages.push({ role: "system", content: systemPrompt });
        historyMessages.forEach(hm => {
            requestMessages.push(hm);
        });
        requestMessages.push({ role: "user", content: userMessage });
        const requestBody = {
            model: this.settings.modelName,
            messages: requestMessages,
            temperature: 0.7,
            max_tokens: 1500
        };
        let response: Response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + this.settings.apiKey
                },
                body: JSON.stringify(requestBody)
            });
        } catch (networkErr) {
            const errMsg1 = "⽹络请求失败 (Failed to fetch)\n";
            const errMsg2 = "请检查：\n";
            const errMsg3 = "1. capabilities.json 已配置 WebAccess 权限\n";
            const errMsg4 = "2. ⽹络连接正常\n";
            const errMsg5 = "请求地址：" + apiUrl;
            throw new Error(errMsg1 + errMsg2 + errMsg3 + errMsg4 + errMsg5);
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            if (response.status === 401) {
                throw new Error("API Key ⽆效或已过期（401）");
            } else if (response.status === 402) {
                throw new Error("账户余额不⾜（402），请充值");
            } else if (response.status === 429) {
                throw new Error("请求频率超限（429），请稍后重试");
            } else {
                const errMsg = errorData.error && errorData.error.message ? errorData.error.message : "未知错误";
                throw new Error(errMsg);
            }
        }
        const data = await response.json();
        return data.choices[0].message.content;
    }

    // ============================================================
    // 【迭代4 更新】callClaude - 增加 system 字段
    // ============================================================
    private async callClaude(userMessage: string, systemPrompt: string): Promise<string> {
        const apiUrl = this.settings.apiEndpoint || "https://api.anthropic.com/v1/messages";
        const historyMessages: Array<{ role: string; content: string }> = [];
        const recentMsgs = this.messages.slice(-8);
        recentMsgs.forEach(m => {
            if (m.text === userMessage && m.isUser) {
                return;
            }
            historyMessages.push({
                role: m.isUser ? "user" : "assistant",
                content: m.text
            });
        });
        historyMessages.push({ role: "user", content: userMessage });
        const requestBody = {
            model: this.settings.modelName,
            system: systemPrompt,
            messages: historyMessages,
            max_tokens: 1500
        };
        let response: Response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": this.settings.apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify(requestBody)
            });
        } catch (networkErr) {
            throw new Error("⽹络请求失败，⽆法连接到 Claude API");
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errMsg = errorData.error && errorData.error.message ? errorData.error.message : "未知错误";
            throw new Error(errMsg);
        }
        const data = await response.json();
        return data.content[0].text;
    }

    // ============================================================
    // 【迭代4 更新】callGemini - 增加 systemInstruction
    // ============================================================
    private async callGemini(userMessage: string, systemPrompt: string): Promise<string> {
        const baseUrl = this.settings.apiEndpoint || "https://generativelanguage.googleapis.com/v1beta/models";
        const apiUrl = baseUrl + "/" + this.settings.modelName + ":generateContent?key=" + this.settings.apiKey;
        const requestBody = {
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
            contents: [{ parts: [{ text: userMessage }] }]
        };
        let response: Response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody)
            });
        } catch (networkErr) {
            throw new Error("⽹络请求失败，⽆法连接到 Gemini API");
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errMsg = errorData.error && errorData.error.message ? errorData.error.message : "未知错误";
            throw new Error(errMsg);
        }
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    }

    // ============================================================
    // 【迭代4 更新】callCustomLLM - 增加 system message
    // ============================================================
    private async callCustomLLM(userMessage: string, systemPrompt: string): Promise<string> {
        if (!this.settings.apiEndpoint) {
            throw new Error("请在设置中填写⾃定义 API 端点");
        }
        let apiUrl = this.settings.apiEndpoint.trim();
        apiUrl = apiUrl.replace(/\/$/, "");
        if (!apiUrl.endsWith("/chat/completions")) {
            apiUrl = apiUrl + "/chat/completions";
        }
        const historyMessages: Array<{ role: string; content: string }> = [];
        const recentMsgs = this.messages.slice(-8);
        recentMsgs.forEach(m => {
            if (m.text === userMessage && m.isUser) {
                return;
            }
            historyMessages.push({
                role: m.isUser ? "user" : "assistant",
                content: m.text
            });
        });
        const requestMessages: Array<{ role: string; content: string }> = [];
        requestMessages.push({ role: "system", content: systemPrompt });
        historyMessages.forEach(hm => {
            requestMessages.push(hm);
        });
        requestMessages.push({ role: "user", content: userMessage });
        const requestBody = {
            model: this.settings.modelName,
            messages: requestMessages,
            temperature: 0.7,
            max_tokens: 1500
        };
        let response: Response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + this.settings.apiKey
                },
                body: JSON.stringify(requestBody)
            });
        } catch (networkErr) {
            throw new Error("⽹络请求失败，⽆法连接到：" + apiUrl);
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            if (response.status === 401) {
                throw new Error("API Key ⽆效（401）");
            } else if (response.status === 404) {
                throw new Error("端点不存在（404）：" + apiUrl);
            } else {
                const errMsg = errorData.error && errorData.error.message ? errorData.error.message : "未知错误";
                throw new Error(errMsg);
            }
        }
        const data = await response.json();
        return data.choices[0].message.content;
    }

    private showTypingIndicator(): void {
        const indicator = document.createElement("div");
        indicator.className = "message bot typing-indicator-container";
        let html = "<div class=\"message-bubble typing-indicator\">";
        html += "<div class=\"typing-dot\"></div>";
        html += "<div class=\"typing-dot\"></div>";
        html += "<div class=\"typing-dot\"></div>";
        html += "</div>";
        indicator.innerHTML = html;
        this.messagesContainer.appendChild(indicator);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    private hideTypingIndicator(): void {
        const el = this.messagesContainer.querySelector(".typing-indicator-container");
        if (el) {
            el.remove();
        }
    }

    private showError(message: string): void {
        const errorDiv = document.createElement("div");
        errorDiv.className = "error-message";
        errorDiv.textContent = message;
        this.inputContainer.appendChild(errorDiv);
        setTimeout(() => {
            errorDiv.remove();
        }, 4000);
    }

    private renderMessage(message: Message): void {
        const messageDiv = document.createElement("div");
        const className = message.isUser ? "user" : "bot";
        messageDiv.className = "message " + className;
        const time = message.timestamp.toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit"
        });
        const bubbleDiv = document.createElement("div");
        bubbleDiv.className = "message-bubble";
        bubbleDiv.innerHTML = this.escapeHtml(message.text);
        const timeDiv = document.createElement("div");
        timeDiv.className = "message-time";
        timeDiv.textContent = time;
        messageDiv.appendChild(bubbleDiv);
        messageDiv.appendChild(timeDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    private renderAllMessages(): void {
        this.messagesContainer.innerHTML = "";
        this.messages.forEach(msg => this.renderMessage(msg));
    }

    private escapeHtml(text: string): string {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML.replace(/\n/g, "<br>");
    }

    private clearChat(): void {
        this.messages = [];
        this.messagesContainer.innerHTML = "";
        this.addWelcomeMessage();
    }

    private openSettings(): void {
        this.settingsModal.style.display = "flex";
        const apiKeyInput = document.getElementById("apiKeyInput") as HTMLInputElement;
        if (apiKeyInput) {
            apiKeyInput.value = this.settings.apiKey;
        }
        const endpointInput = document.getElementById("endpointInput") as HTMLInputElement;
        if (endpointInput) {
            endpointInput.value = this.settings.apiEndpoint || "";
        }
        const providerSelect = document.getElementById("providerSelect") as HTMLSelectElement;
        if (providerSelect) {
            providerSelect.value = this.settings.llmProvider;
        }
        this.updateModelOptions(this.settings.llmProvider);
    }

    private closeSettings(): void {
        this.settingsModal.style.display = "none";
    }

    private saveSettings(): void {
        const providerSelect = document.getElementById("providerSelect") as HTMLSelectElement;
        const apiKeyInput = document.getElementById("apiKeyInput") as HTMLInputElement;
        const endpointInput = document.getElementById("endpointInput") as HTMLInputElement;
        if (!providerSelect || !apiKeyInput) {
            return;
        }
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            this.showError("请输⼊ API Key");
            return;
        }
        let modelName = "";
        const modelSelect = document.getElementById("modelSelect") as HTMLSelectElement;
        const modelNameInput = document.getElementById("modelNameInput") as HTMLInputElement;
        if (modelSelect) {
            modelName = modelSelect.value;
        } else if (modelNameInput) {
            modelName = modelNameInput.value.trim();
        }
        if (!modelName) {
            this.showError("请输⼊模型名称");
            return;
        }
        const provider = this.llmProviders.find(p => p.id === providerSelect.value);
        let apiEndpoint = "";
        if (provider && provider.requiresEndpoint) {
            apiEndpoint = endpointInput ? endpointInput.value.trim() : "";
            if (!apiEndpoint) {
                this.showError("请输⼊ API 端点");
                return;
            }
        } else if (provider) {
            apiEndpoint = provider.defaultEndpoint;
        }
        this.settings.llmProvider = providerSelect.value;
        this.settings.apiKey = apiKey;
        this.settings.modelName = modelName;
        this.settings.apiEndpoint = apiEndpoint;
        try {
            localStorage.setItem("chatbot_settings", JSON.stringify(this.settings));
        } catch (e) {
            console.error("保存设置失败:", e);
        }
        this.closeSettings();
        const providerName = provider ? provider.name : "未知";
        const successText = " 设置已保存\n提供商：" + providerName + "\n模型：" + modelName;
        const successMsg: Message = {
            text: successText,
            isUser: false,
            timestamp: new Date()
        };
        this.messages.push(successMsg);
        this.renderMessage(successMsg);
        this.saveChatHistory();
    }

    private loadSettings(): void {
        try {
            const saved = localStorage.getItem("chatbot_settings");
            if (saved) {
                const s = JSON.parse(saved);
                this.settings = {
                    llmProvider: s.llmProvider || "openai",
                    apiKey: s.apiKey || "",
                    modelName: s.modelName || "gpt-3.5-turbo",
                    apiEndpoint: s.apiEndpoint || "https://api.openai.com/v1/chat/completions"
                };
            }
        } catch (e) {
            console.error("加载设置失败:", e);
        }
    }

    private saveChatHistory(): void {
        try {
            const history = {
                messages: this.messages,
                lastUpdate: new Date()
            };
            localStorage.setItem("chatbot_history", JSON.stringify(history));
        } catch (e) {
            console.error("保存历史失败:", e);
        }
    }

    private loadChatHistory(): void {
        try {
            const saved = localStorage.getItem("chatbot_history");
            if (saved) {
                const history: ChatHistory = JSON.parse(saved);
                const lastUpdate = new Date(history.lastUpdate);
                const now = new Date();
                const timeDiff = now.getTime() - lastUpdate.getTime();
                if (timeDiff < this.historyTimeout) {
                    this.messages = history.messages.map(msg => {
                        return {
                            text: msg.text,
                            isUser: msg.isUser,
                            timestamp: new Date(msg.timestamp)
                        };
                    });
                } else {
                    this.messages = [];
                    localStorage.removeItem("chatbot_history");
                }
            } else {
                this.messages = [];
            }
        } catch (e) {
            console.error("加载历史失败:", e);
            this.messages = [];
        }
    }

    private startHistoryCleanup(): void {
        setInterval(() => {
            try {
                const saved = localStorage.getItem("chatbot_history");
                if (saved) {
                    const history: ChatHistory = JSON.parse(saved);
                    const lastUpdate = new Date(history.lastUpdate);
                    const now = new Date();
                    const timeDiff = now.getTime() - lastUpdate.getTime();
                    if (timeDiff >= this.historyTimeout) {
                        localStorage.removeItem("chatbot_history");
                    }
                }
            } catch (e) {
                console.error("清理历史失败:", e);
            }
        }, 60000);
    }

    public destroy(): void {
        // 清理资源
    }
}