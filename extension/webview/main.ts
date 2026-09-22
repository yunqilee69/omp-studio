import MarkdownIt from "markdown-it";
import type { ExtensionUIResponse } from "../src/rpc/types";
import type {
	HostMessage,
	HistoryEntryView,
	InstanceState,
	Item,
	McpServerView,
	ModelChoice,
	SlashCommandView,
	TabSummary,
	UIRequestView,
	ViewLayer,
	WebviewMessage,
} from "../src/shared/protocol";
import { applyItems, applySession, applyTabs } from "./session-view";

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

interface HostApi {
	postMessage(message: WebviewMessage): void;
	state: unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): HostApi;

const api = acquireVsCodeApi();
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

function send(message: WebviewMessage): void {
	api.postMessage(message);
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
	const node = el("button", className, label);
	node.addEventListener("click", onClick);
	return node;
}

/** Render markdown with raw HTML disabled; links are routed through the host. */
function markdownEl(text: string): HTMLElement {
	const node = el("div", "md");
	node.innerHTML = markdown.render(text);
	for (const anchor of node.querySelectorAll("a")) {
		anchor.addEventListener("click", (event) => {
			event.preventDefault();
			const href = anchor.getAttribute("href");
			if (href) send({ type: "link/open", url: href });
		});
	}
	return node;
}

function fileChip(path: string): HTMLElement {
	const chip = el("button", "file-chip", path.split("/").slice(-2).join("/"));
	chip.title = path;
	chip.addEventListener("click", () => send({ type: "file/open", path }));
	return chip;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const app = document.getElementById("app") ?? document.body;
const tabStrip = el("div", "tab-strip");
// `hidden` from the start: an empty `.overlay` is a full-screen sheet that would
// swallow every click until the first panel opens and closes.
const viewHeader = el("div", "view-header hidden");
const stream = el("div", "stream");
const composer = el("div", "composer hidden");
const toastArea = el("div", "toasts");
const overlay = el("div", "overlay hidden");

app.replaceChildren(tabStrip, viewHeader, stream, composer, toastArea, overlay);

const promptInput = el("textarea", "prompt");
promptInput.rows = 3;
promptInput.placeholder = "输入提示，Enter 发送，Shift+Enter 换行，Esc 中止";
const sendButton = button("发送", "primary", () => submitPrompt(false));
sendButton.title = "Enter 发送；运行中为 follow-up";
const abortButton = button("中止", "danger", () => abortPrompt());
abortButton.title = "中止当前一轮（Esc）";
const commandHint = el("div", "command-hint");
const pendingList = el("div", "pending-list hidden");
const composerMeta = el("div", "composer-meta");
const actions = el("div", "composer-actions");
composer.append(promptInput, commandHint, pendingList, composerMeta, actions);

interface ViewState {
	tabs: TabSummary[];
	activeId?: string;
	id?: string;
	state?: InstanceState;
	stack: ViewLayer[];
	/** Items of the active tab: kept so returning from a view re-renders the chat. */
	items: Item[];
	models: ModelChoice[];
	commands: SlashCommandView[];
	mcp: McpServerView[];
	mcpNote?: string;
	history: HistoryEntryView[];
}

const view: ViewState = { tabs: [], stack: [], items: [], models: [], commands: [], mcp: [], history: [] };
const itemElements = new Map<string, HTMLElement>();
type OverlayKind = "none" | "model" | "history" | "mcp" | "ui";
let overlayKind: OverlayKind = "none";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function renderTabs(): void {
	tabStrip.replaceChildren();
	for (const tab of view.tabs) {
		const tabEl = el("div", "tab");
		if (tab.id === view.activeId) tabEl.classList.add("active");
		if (tab.failed) tabEl.classList.add("failed");
		const dot = el("span", "dot");
		dot.classList.add(tab.failed ? "error" : tab.busy ? "running" : tab.running ? "ok" : "idle");
		const title = el("span", "tab-title", tab.title);
		title.title = tab.sessionFile ?? tab.title;
		tabEl.append(dot, title);
		if (tab.unread) tabEl.append(el("span", "unread", "·"));
		const close = button("×", "tab-close", () => {
			send({ type: "tab/close", id: tab.id });
		});
		close.title = "关闭这个实例（结束它的进程）";
		tabEl.append(close);
		tabEl.addEventListener("click", (event) => {
			if (event.target === close) return;
			if (tab.id !== view.activeId) send({ type: "tab/select", id: tab.id });
		});
		tabStrip.append(tabEl);
	}
	tabStrip.append(
		button("+", "tab-new", () => {
			send({ type: "tab/new" });
		}),
	);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/** Editable queue of prompts not yet sent to omp; entries vanish once dispatched. */
function renderPending(): void {
	const state = view.state;
	const pending = state?.pending ?? [];
	pendingList.replaceChildren();
	pendingList.classList.toggle("hidden", pending.length === 0);
	for (const entry of pending) {
		const row = el("div", "pending-row");
		const input = el("textarea", "pending-text") as HTMLTextAreaElement;
		input.value = entry.text;
		input.rows = 2;
		input.disabled = state?.state === "failed" || state?.state === "gone";
		input.addEventListener("change", () => {
			send({ type: "prompt/update", id: entry.id, text: input.value });
		});
		row.append(input);
		row.append(
			button("立即发送", "chip", () => {
				send({ type: "prompt/send-now", id: entry.id });
			}),
		);
		row.append(
			button("取消", "chip", () => {
				send({ type: "prompt/cancel", id: entry.id });
			}),
		);
		pendingList.append(row);
	}
}

/** Session chips live under the prompt: mode / model / thinking / context. */
function renderComposerChrome(): void {
	composerMeta.replaceChildren();
	actions.replaceChildren();
	renderPending();
	const state = view.state;
	if (!state) return;

	const mode = el("span", "chip mode", state.mode);
	if (state.modeNote) {
		mode.title = state.modeNote;
		mode.classList.add("readonly");
	}
	composerMeta.append(mode);

	const modelLabel = state.modelsLoading && !state.model ? "正在拉取模型…" : (state.model ?? "选择模型");
	composerMeta.append(button(modelLabel, "chip", () => openModelPicker()));
	composerMeta.append(
		button(`thinking: ${state.thinkingLevel ?? "?"}`, "chip", () => send({ type: "thinking/cycle" })),
	);
	if (state.contextPercent !== undefined) {
		const context = el("span", "chip", `上下文 ${Math.round(state.contextPercent)}%`);
		if (state.contextWindow) context.title = `窗口 ${state.contextWindow} tokens`;
		composerMeta.append(context);
	}
	if (state.compacting) composerMeta.append(el("span", "chip warn", "压缩中"));
	if (state.pending.length > 0) composerMeta.append(el("span", "chip", `待发 ${state.pending.length}`));
	if (isRunActive()) composerMeta.append(el("span", "chip running", "运行中"));

	if (state.planFile) {
		const plan = button("计划", "chip", () => send({ type: "view/open-plan" }));
		plan.title = state.planFile;
		actions.append(plan);
	}
	actions.append(
		button("MCP", "chip", () => {
			send({ type: "mcp/refresh" });
			openMcpPanel();
		}),
	);
	if (isRunActive()) actions.append(abortButton);
	actions.append(sendButton);
}

// ---------------------------------------------------------------------------
// Chat / view stack
// ---------------------------------------------------------------------------

function renderItems(items: Item[]): void {
	const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
	for (const item of items) {
		const existing = itemElements.get(item.key);
		const next = itemEl(item);
		if (existing) existing.replaceWith(next);
		else stream.append(next);
		itemElements.set(item.key, next);
	}
	if (atBottom) stream.scrollTop = stream.scrollHeight;
}

function itemEl(item: Item): HTMLElement {
	switch (item.kind) {
		case "user":
			return el("div", "item user", item.text);
		case "assistant": {
			const node = el("div", "item assistant");
			if (item.thinking.trim()) {
				const details = el("details", "thinking");
				details.append(el("summary", undefined, "思考过程"));
				details.append(markdownEl(item.thinking));
				node.append(details);
			}
			if (item.text.trim()) node.append(markdownEl(item.text));
			if (item.error) node.append(el("div", "item-error", item.error));
			if (item.streaming) node.append(el("span", "caret", "▍"));
			return node;
		}
		case "tool": {
			const node = el("div", "item tool");
			const head = el("div", "tool-head");
			const dot = el("span", "dot");
			dot.classList.add(item.status === "ok" ? "ok" : item.status === "error" ? "error" : "running");
			head.append(dot, el("span", "tool-name", item.name));
			if (item.intent) head.append(el("span", "muted", item.intent));
			head.append(el("span", "spacer"));
			if (item.subagentId) {
				const id = item.subagentId;
				head.append(button("查看输出", "chip", () => send({ type: "view/open-subagent", id })));
			}
			node.append(head);
			if (item.progress) node.append(el("div", "muted progress", item.progress));
			if (item.summary) {
				const details = el("details");
				details.append(el("summary", undefined, item.status === "error" ? "错误输出" : "结果"));
				details.append(el("pre", "summary", item.summary));
				node.append(details);
			}
			if (item.files.length > 0) {
				const files = el("div", "files");
				for (const path of item.files) files.append(fileChip(path));
				node.append(files);
			}
			return node;
		}
		case "notice": {
			const node = el("div", `item notice ${item.level}`);
			node.textContent = item.text;
			return node;
		}
		case "command":
			return el("pre", "item command", item.text);
		default:
			return el("div", "item");
	}
}

/**
 * Drop every DOM artifact of the active tab: cached item nodes, the visible
 * transcript, and tab-scoped overlays. Workspace-level panels (`history`,
 * `mcp`) survive because they do not belong to a session.
 */
function clearSessionElements(): void {
	itemElements.clear();
	if (overlayKind === "model" || overlayKind === "ui") closeOverlay();
}

/** Chat, a read-only stacked layer, the failure panel, or the hero - never two at once. */
function renderBody(): void {
	const state = view.state;
	viewHeader.replaceChildren();
	if (view.id === undefined || state === undefined) {
		viewHeader.classList.add("hidden");
		composer.classList.add("hidden");
		renderHero();
		return;
	}
	if (state.state === "failed" || state.state === "gone") {
		viewHeader.classList.add("hidden");
		// A dead process cannot accept a prompt: the composer must not pretend otherwise.
		composer.classList.add("hidden");
		renderFailure(state);
		return;
	}
	composer.classList.remove("hidden");
	renderComposerChrome();
	const top = view.stack[view.stack.length - 1];
	if (view.stack.length === 1 || !top) {
		viewHeader.classList.add("hidden");
		stream.replaceChildren();
		itemElements.clear();
		renderItems(view.items);
		return;
	}
	// Locked product decision: a stacked view replaces the chat inside the same tab.
	viewHeader.classList.remove("hidden");
	viewHeader.append(button("← 返回对话", "chip", () => send({ type: "view/back" })));
	viewHeader.append(el("span", "view-title", top.title));
	if (top.status) viewHeader.append(el("span", "muted small", top.status));
	if (top.source) viewHeader.append(fileChip(top.source));
	const body = el("div", "item view-body");
	body.append(top.body?.trim() ? markdownEl(top.body) : el("div", "muted", "（空）"));
	stream.replaceChildren(body);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function isRunActive(): boolean {
	const state = view.state;
	return !!state && (state.streaming || state.compacting || state.queued > 0 || state.state === "streaming");
}

function abortPrompt(): void {
	if (!isRunActive()) return;
	send({ type: "prompt/abort" });
}

function submitPrompt(_steer: boolean): void {
	const text = promptInput.value.trim();
	if (!text) return;
	promptInput.value = "";
	renderCommandHint();
	renderComposerChrome();
	send({ type: "prompt/send", text });
}

function renderCommandHint(): void {
	const value = promptInput.value;
	if (!value.startsWith("/") || value.includes(" ")) {
		commandHint.classList.add("hidden");
		commandHint.replaceChildren();
		return;
	}
	const matches = view.commands.filter((command) => command.name.startsWith(value)).slice(0, 12);
	commandHint.replaceChildren();
	commandHint.classList.toggle("hidden", matches.length === 0);
	for (const command of matches) {
		const row = button(`/${command.name}`, "command-row", () => {
			promptInput.value = `/${command.name} `;
			promptInput.focus();
			renderCommandHint();
		});
		if (command.description) row.append(el("span", "muted small", command.description));
		commandHint.append(row);
	}
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function openOverlay(kind: OverlayKind, children: HTMLElement[]): void {
	overlayKind = kind;
	const panel = el("div", "panel");
	panel.append(...children);
	overlay.replaceChildren(panel);
	overlay.classList.remove("hidden");
}

function closeOverlay(): void {
	overlayKind = "none";
	overlay.classList.add("hidden");
	overlay.replaceChildren();
}

function applyModels(id: string, models: ModelChoice[], loading?: boolean, error?: string): void {
	if (id !== view.id) return;
	// A later empty snapshot (handshake `pushSession` before catalog) must not
	// wipe a list we already have. Tab switches go through `session`.
	if (models.length > 0 || view.models.length === 0 || loading === false) {
		view.models = models;
	}
	if (view.state) {
		if (loading !== undefined) view.state.modelsLoading = loading;
		if (error !== undefined) view.state.modelsError = error;
		else if (loading === false) view.state.modelsError = undefined;
	}
	if (overlayKind === "model") openModelPicker(false);
}

function openModelPicker(requestRefresh = true): void {
	const loading = view.state?.modelsLoading === true;
	if (requestRefresh && view.models.length === 0 && !loading && view.id) send({ type: "models/refresh" });
	const children: HTMLElement[] = [el("div", "panel-title", `模型（${view.models.length}）`)];
	if (loading) children.push(el("div", "muted", "正在从 omp 拉取模型列表（后台发现可能还没结束）"));
	else if (view.models.length === 0) {
		children.push(el("div", "muted", view.state?.modelsError ?? "omp 未报告任何已配置凭证的模型"));
		children.push(button("重新拉取", "chip", () => send({ type: "models/refresh" })));
	}
	for (const model of view.models) {
		const row = button(model.label, "panel-row", () => {
			send({ type: "model/set", provider: model.provider, id: model.id });
			closeOverlay();
		});
		row.append(el("span", "muted small", `${model.provider}/${model.id}`));
		children.push(row);
	}
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("model", children);
}

function openHistoryPanel(): void {
	const children: HTMLElement[] = [el("div", "panel-title", "本工作区历史会话")];
	if (view.history.length === 0) {
		children.push(el("div", "muted", "没有找到会话文件（~/.omp/agent/sessions）"));
	}
	for (const entry of view.history) {
		const label = entry.openTabId ? `${entry.title}（已在 Tab 打开）` : entry.title;
		const row = button(label, "panel-row", () => {
			if (entry.openTabId) return;
			send({ type: "tab/open-history", file: entry.file });
			closeOverlay();
		});
		if (entry.openTabId) row.disabled = true;
		row.title = entry.file;
		row.append(el("span", "muted small", `${new Date(entry.updatedAt).toLocaleString()} · ${entry.mode}`));
		children.push(row);
	}
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("history", children);
}

function openMcpPanel(): void {
	const children: HTMLElement[] = [el("div", "panel-title", "MCP 服务器")];
	if (view.mcpNote) children.push(el("div", "muted", view.mcpNote));
	for (const server of view.mcp) {
		const row = el("div", "panel-row mcp-row");
		const toggle = button(server.enabled ? "禁用" : "启用", "chip", () =>
			send({ type: "mcp/toggle", name: server.name, enabled: !server.enabled }),
		);
		row.append(el("span", "mcp-name", server.name), el("span", "muted small", `${server.transport} · ${server.scope}`));
		if (!server.enabled) row.classList.add("off");
		row.append(el("span", "spacer"), toggle);
		if (server.detail) {
			const detail = el("div", "muted small mcp-detail", server.detail);
			detail.title = server.detail;
			row.append(detail);
		}
		row.append(
			button("打开配置", "chip", () => {
				send({ type: "mcp/open-file", path: server.configPath });
			}),
		);
		children.push(row);
	}
	if (view.mcp.length === 0 && !view.mcpNote) children.push(el("div", "muted", "没有配置 MCP 服务器"));
	children.push(el("div", "muted small", "开关通过 omp 自己的 /mcp 命令写入配置；对已启动的实例需重开 Tab 生效。"));
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("mcp", children);
}

function openApproval(request: UIRequestView): void {
	const children: HTMLElement[] = [el("div", "panel-title", `omp 请求：${request.method}`)];
	if (request.title) children.push(el("div", "panel-subtitle", request.title));
	if (request.message) children.push(el("div", "panel-message", request.message));

	const respond = (response: ExtensionUIResponse) => {
		send({ type: "ui/respond", response });
		closeOverlay();
	};

	if (request.method === "select") {
		for (const option of request.options ?? []) {
			children.push(
				button(option, "panel-row", () =>
					respond({ type: "extension_ui_response", id: request.id, value: option }),
				),
			);
		}
	} else if (request.method === "confirm") {
		children.push(
			button("Approve", "panel-row primary", () =>
				respond({ type: "extension_ui_response", id: request.id, confirmed: true }),
			),
			button("Deny", "panel-row", () =>
				respond({ type: "extension_ui_response", id: request.id, confirmed: false }),
			),
		);
	} else if (request.method === "input") {
		const input = el("input", "panel-input");
		input.placeholder = request.placeholder ?? "";
		const submit = () => respond({ type: "extension_ui_response", id: request.id, value: input.value });
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") submit();
		});
		children.push(input, button("提交", "panel-row primary", submit));
	} else {
		const area = el("textarea", "panel-input");
		area.rows = 10;
		area.value = request.prefill ?? "";
		children.push(
			area,
			button("提交", "panel-row primary", () => respond({ type: "extension_ui_response", id: request.id, value: area.value })),
		);
	}

	if (request.timeoutMs) {
		children.push(el("div", "muted small", `omp 超时 ${Math.round(request.timeoutMs / 1000)}s 后会自行按默认处理`));
	}
	children.push(
		button("取消", "chip", () =>
			respond({ type: "extension_ui_response", id: request.id, cancelled: true }),
		),
	);
	openOverlay("ui", children);
}

function toast(text: string, level: string, url?: string): void {
	const node = el("div", `toast ${level}`, text);
	if (url) {
		const open = button("打开链接", "chip", () => send({ type: "link/open", url }));
		node.append(open);
	}
	const dismiss = () => node.remove();
	node.addEventListener("click", dismiss);
	toastArea.append(node);
	setTimeout(dismiss, level === "error" ? 15_000 : 8_000);
}

function renderHero(): void {
	composer.classList.add("hidden");
	stream.replaceChildren();
	const hero = el("div", "hero");
	hero.append(el("h2", undefined, "OMP Studio"));
	hero.append(
		el(
			"p",
			"muted",
			"每个 Tab 是一个独立的 omp 实例。模式切换、审批策略由 omp 自己维护；这里只显示它实际的状态。",
		),
	);
	hero.append(button("新建实例", "primary", () => send({ type: "tab/new" })));
	hero.append(button("打开历史会话", "chip", () => send({ type: "history/refresh" })));
	stream.append(hero);
}

function renderFailure(state: InstanceState): void {
	composer.classList.add("hidden");
	stream.replaceChildren();
	const panel = el("div", "hero failure");
	panel.append(el("h2", undefined, "这个 Tab 的 omp 已停止"));
	panel.append(el("pre", "summary", state.failure ?? "进程已退出"));
	panel.append(el("p", "muted", `工作区：${state.cwd}`));
	panel.append(button("关闭 Tab", "chip", () => send({ type: "tab/close", id: view.id ?? "" })));
	panel.append(button("新建实例", "primary", () => send({ type: "tab/new" })));
	stream.append(panel);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case "session": {
			const empty = message.id === undefined;
			const tabChanged = applySession(view, message);
			if (empty) {
				// No active tab: the body must drop to the hero, not repaint the
				// closed transcript. `renderItems` would cover the hero again.
				clearSessionElements();
				renderTabs();
				renderBody();
				return;
			}
			if (overlayKind === "model") {
				if (tabChanged) closeOverlay();
				else openModelPicker(false);
			}
			renderTabs();
			renderBody();
			renderItems(message.items);
			return;
		}
		case "tabs":
			applyTabs(view, message);
			renderTabs();
			if (message.activeId === undefined) {
				// Defensive: the last tab closing must reach the hero even if the
				// empty `session` snapshot was lost.
				clearSessionElements();
				renderBody();
			}
			return;
		case "items":
			if (applyItems(view, message)) renderItems(message.items);
			return;
		case "state":
			if (message.id !== view.id) return;
			view.state = message.state;
			renderBody();
			return;
		case "pending":
			if (message.id !== view.id) return;
			if (view.state) view.state.pending = message.pending;
			renderPending();
			return;
		case "stack":
			if (message.id !== view.id) return;
			view.stack = message.stack;
			renderBody();
			return;
		case "models":
			applyModels(message.id, message.models, message.loading, message.error);
			return;
		case "commands":
			if (message.id !== view.id) return;
			view.commands = message.commands;
			return;
		case "mcp":
			view.mcp = message.servers;
			view.mcpNote = message.note;
			return;
		case "history":
			view.history = message.entries;
			openHistoryPanel();
			return;
		case "ui":
			if (message.id !== view.id) return;
			if (message.request) openApproval(message.request);
			else closeOverlay();
			return;
		case "notice":
			toast(message.text, message.level, message.url);
			return;
		default:
			return;
	}
});

promptInput.addEventListener("input", renderCommandHint);
promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		submitPrompt(event.altKey);
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		if (!overlay.classList.contains("hidden")) closeOverlay();
		else abortPrompt();
	}
});
promptInput.focus();

// Hero (or a surviving failure panel) until the host answers `ready`.
renderBody();
send({ type: "ready" });
