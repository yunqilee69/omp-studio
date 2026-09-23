import MarkdownIt from "markdown-it";
import type { ExtensionUIResponse, ThinkingLevel } from "../src/rpc/types";
import { formatTokens } from "../src/shared/model-drafts";
import type {
	AttachmentView,
	BranchPointView,
	ChoiceOptionView,
	HostMessage,
	HostToolCallView,
	HistoryEntryView,
	InstanceState,
	Item,
	ListPrefs,
	LoginProviderView,
	MessageImage,
	ModelChoice,
	NewSessionView,
	SessionStatsView,
	SlashCommandView,
	TabSummary,
	ToolItem,
	UIRequestView,
	ViewLayer,
	WebviewMessage,
} from "../src/shared/protocol";
import { applyItems, applyItemsRemoved, applySession, applyTabs } from "./session-view";
import { buildSessionList, STATUS_LABELS, type HistoryRow, type ListRow, type SessionRow, type SessionStatus } from "./sessions-view";
import { computeCompletions, cycleActive, type Completions } from "./completions";
import { button, el, svgIcon } from "./dom";
import { IMAGE_MIME_TYPES, imageName, pastedAttachment } from "./images";
import { humanDuration, thinkingLabel, toolLine } from "./tool-line";

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

interface HostApi {
	postMessage(message: WebviewMessage): void;
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

/** True while an IME composition is in flight, so Enter confirms candidates instead of submitting. keyCode 229 covers browsers that keep isComposing false on the keydown. */
function isComposing(event: KeyboardEvent): boolean {
	return event.isComposing || event.keyCode === 229;
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

const MODE_LABELS: Record<string, string> = {
	none: "Agent",
	plan: "Plan",
	goal: "Goal",
	vibe: "Vibe",
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Panel-header switches, drawn like VS Code's own view actions: stroked marks on a 16×16
 * grid, no chrome until hover. `⌕` opens the filter field, `▥` folds the panel away.
 */
const SEARCH_ICON = ["M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9", "M10.4 10.4 13.5 13.5"];
const PANEL_ICON = ["M2.5 3.5h11v9h-11z", "M10 3.5v9"];

/** One header switch: an icon that reads as a label, so it never needs its own toolbar row. */
function headButton(icon: readonly string[], title: string, onClick: () => void): HTMLButtonElement {
	const node = button("", "head-btn", onClick);
	node.title = title;
	node.append(svgIcon(icon, "head-icon"));
	return node;
}

const app = document.getElementById("app") ?? document.body;
// Two panes in one view (dev-plan §1.2): the chat area owns the left, the Sessions panel is
// docked right. `viewHeader` starts `hidden` because the blank page has no title; `overlay`
// likewise, since an empty one is a full-screen sheet that would swallow every click.
const mainPane = el("div", "main-pane");
const viewHeader = el("div", "view-header hidden");
const stream = el("div", "stream");
// The chat's own column. Past its max width the transcript stops widening and centers
// instead, so a wide sidebar reads as a conversation rather than a full-bleed log.
const streamColumn = el("div", "stream-column");
stream.append(streamColumn);
const composer = el("div", "composer hidden");
const toastArea = el("div", "toasts");
const overlay = el("div", "overlay hidden");

// Sessions panel: title, its two switches, then the list. The filter field sits between them,
// outside the scrolling list, because the list is rebuilt on every host message: a
// re-attached input would lose focus and caret mid-typing.
const panel = el("aside", "sessions-panel");
const sessionsHead = el("div", "sessions-head");
sessionsHead.append(el("h2", "sessions-title", "Sessions"), el("span", "spacer"));
const searchToggle = headButton(SEARCH_ICON, "搜索会话名称", () => setSearchOpen(!searchOpen));
const collapseToggle = headButton(PANEL_ICON, "折叠会话面板（聊天区占满整宽）", () => setPanelOpen(false));
sessionsHead.append(searchToggle, collapseToggle);

// Search row: VS Code's own view-filter field - one bordered input with the funnel mark and
// a clear button - closed until the magnifier asks for it. Filtering only hides rows; it
// never swaps the source.
const searchBar = el("div", "search-bar hidden");
const searchField = el("div", "search-field");
const searchInput = el("input", "search-input");
// Plain text, not `type=search`: Chromium draws its own clear button inside a search input,
// which would sit next to ours.
searchInput.type = "text";
searchInput.placeholder = "搜索会话名称";
searchInput.autocomplete = "off";
searchInput.spellcheck = false;
const filterIcon = svgIcon(["M2.5 3.5h11l-4 4.6v5.2l-3-1.5V8.1z"], "filter-icon");
filterIcon.setAttribute("title", "按会话名称过滤");
const clearSearch = button("✕", "search-clear", () => {
	setQuery("");
	searchInput.focus();
});
clearSearch.title = "清空搜索";
searchField.append(searchInput, filterIcon, clearSearch);
searchBar.append(searchField);
searchInput.addEventListener("input", () => {
	view.query = searchInput.value;
	renderSessionList();
});
searchInput.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	event.preventDefault();
	// An empty field has nothing to clear, so Escape closes the field itself - which is how
	// the filter goes away without hunting for the magnifier again.
	if (view.query === "") setSearchOpen(false);
	else setQuery("");
});
/** The list's rows; refilled in place so the filter field keeps its focus and caret. */
const sessionsList = el("div", "sessions-list");
const panelBody = el("div", "sessions-body");
panelBody.append(sessionsList);
panel.append(sessionsHead, searchBar, panelBody);

// Folded panel: the same switch, kept in the chat area's corner, so the panel is never more
// than one click away from the side that is still showing.
const revealToggle = headButton(PANEL_ICON, "展开会话面板", () => setPanelOpen(true));
revealToggle.classList.add("reveal");
mainPane.append(viewHeader, stream, composer, revealToggle);

app.replaceChildren(mainPane, panel, toastArea, overlay);

// New composer structure, modeled after the screenshot:
//   [attachment chips]                      (above the input, when present)
//   [textarea]
//   [+ attach] [mode menu] [model] [thinking] [context ring] ...spacer... [queue] [mic] [send/stop]
const PLACEHOLDER_IDLE = "Describe what to build（Enter 发送，Shift+Enter 换行）";
const PLACEHOLDER_QUEUED = "继续输入以排队后续修改，本轮结束后按顺序发送";
const PLACEHOLDER_NEW_SESSION = "描述一个任务，发送即新建会话（Enter 发送，Shift+Enter 换行）";

const promptInput = el("textarea", "prompt");
promptInput.rows = 3;
promptInput.placeholder = PLACEHOLDER_IDLE;
const composerBar = el("div", "composer-bar");
// One bordered shell: textarea on top, the [+] [Agent] [model] ... [send] row
// inside its bottom edge, the way the reference screenshot draws the composer.
const inputShell = el("div", "input-shell");
const attachChips = el("div", "attach-chips hidden");
const commandHint = el("div", "command-hint");
const pendingList = el("div", "pending-list hidden");
// Queued cards sit above the shell, like the reference screenshot. Everything is inside one
// column so the composer lines up with the transcript above it, centered past `--chat-max`.
const composerInner = el("div", "composer-inner");
composerInner.append(pendingList, attachChips, inputShell, commandHint);
// omp 提问/审批不走全屏弹窗：提问面板停泊在 composer 的位置（`uiDock`），整个输入区
// (`composerInner`) 隐藏。对话历史在上方继续滚动，输入中的文字留在 textarea 里不丢。
const uiDock = el("div", "ui-dock hidden");
composer.append(composerInner, uiDock);
// The request id the panel already answered. omp clears the multi-select it is
// collecting when the same id is answered twice, so a second response never leaves.
let answeredRequestId: string | undefined;
inputShell.append(promptInput, composerBar);

const attachButton = button("＋", "icon-btn", () => send({ type: "attachments/pick" }));
attachButton.title = "添加图片附件";
const modeButton = button("Agent", "pill", () => toggleMenu("mode"));
const modelButton = button("Auto", "pill", () => toggleMenu("model"));
const thinkingButton = button("High", "pill", () => toggleMenu("thinking"));

/**
 * Context budget ring, right of the thinking pill: the arc is `contextUsage.percent`, the
 * number in the hole is that percent, the tooltip is the counts omp reported. Nothing shows
 * until omp has answered with a percent - 0% on a session that never reported would be a
 * made-up number, and the list composer has no instance to ask.
 *
 * Radius and inset stroke leave the hole wide enough for a 7px `100%` (see styles.css).
 */
const RING_RADIUS = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** One circle of the ring on the shared 24×24 viewBox, starting at 12 o'clock. */
function ringCircle(className: string): SVGCircleElement {
	const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	circle.setAttribute("class", className);
	circle.setAttribute("cx", "12");
	circle.setAttribute("cy", "12");
	circle.setAttribute("r", String(RING_RADIUS));
	circle.setAttribute("transform", "rotate(-90 12 12)");
	return circle;
}

const contextRing = el("div", "context-ring hidden");
const contextRingArc = ringCircle("ring-arc");
contextRingArc.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
const contextRingValue = el("span", "context-ring-value");
{
	// The number sits in the hole, so it is a sibling of the svg rather than inside it.
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.append(ringCircle("ring-track"), contextRingArc);
	contextRing.append(svg, contextRingValue);
}
const micButton = button("", "icon-btn", () => toggleDictation());
micButton.title = "语音输入（语音转文字）";
const sendButton = button("", "icon-btn send", () => (isRunActive() ? abortPrompt() : submitPrompt()));
sendButton.title = "发送（Enter）";
composerBar.append(attachButton, modeButton, modelButton, thinkingButton, contextRing);
// Left cluster ends here; push [mic] [send/stop] to the right edge.
composerBar.append(el("span", "bar-spacer"));
composerBar.append(micButton, sendButton);
// Quiet footer row under the composer: plan shortcut only; MCP lives in omp.
const composerFooter = el("div", "composer-footer");
const planChip = button("计划", "footer-chip hidden", () => send({ type: "view/open-plan" }));
planChip.title = "打开当前计划";
composerFooter.append(planChip);
composerInner.append(composerFooter);

/**
 * What the chat area shows. `sessions` = no session picked (the blank page the next task
 * starts from), `session` = that instance's transcript. The Sessions panel is not a page any
 * more: it is docked next to whichever one of these is showing.
 */
type Page = "sessions" | "session";

interface ViewState {
	tabs: TabSummary[];
	activeId?: string;
	page: Page;
	id?: string;
	state?: InstanceState;
	stack: ViewLayer[];
	/** Items of the active tab: kept so returning from a view re-renders the chat. */
	items: Item[];
	models: ModelChoice[];
	commands: SlashCommandView[];
	/** This workspace's session files: the list rows that have no live instance. */
	history: HistoryEntryView[];
	/** The search field's text over the one list: a title substring, `""` = show everything. */
	query: string;
	/** Composer-scoped: images waiting to ride the next prompt, on either composer. */
	attachments: AttachmentView[];
	/** Defaults + catalog for the list composer's pills, pushed by the host. */
	newSession?: NewSessionView;
	/** What the pills picked for the session the next send starts; cleared once it starts. */
	draft: { mode?: string; model?: ModelChoice; thinking?: ThinkingLevel };
	/** Workspace files for `@` completion, pushed by the host. */
	workspaceFiles: string[];
	completions: Completions | undefined;
}

const view: ViewState = {
	tabs: [],
	page: "sessions",
	stack: [],
	items: [],
	models: [],
	commands: [],
	history: [],
	query: "",
	attachments: [],
	draft: {},
	workspaceFiles: [],
	completions: undefined,
};
const itemElements = new Map<string, HTMLElement>();
/**
 * Viewport lazy render: a freshly opened long transcript only materializes its tail;
 * earlier rows are placeholders (height measured from the tail's average) that swap
 * to real rows when scrolled into view. Unobserved placeholders render on demand, so
 * the "open a 1000-row session" cost stays one screen, not the whole transcript.
 */
const LAZY_TAIL = 40;
/** Placeholder min-height keeps the scrollbar roughly honest before measurement. */
const LAZY_PLACEHOLDER_MIN = 48;
let lazyObserver: IntersectionObserver | undefined;
/** Placeholder elements by item key, awaiting their row. */
const lazyPending = new Map<string, HTMLElement>();
/**
 * Set while a session is being opened (list row click, or send = new session). The
 * next `session` snapshot then switches to the detail page; without it the landing
 * page stays put, so a webview reload never yanks the user into a chat.
 */
let enteringSession = false;

/**
 * Pinned and finished (archived) sessions, by session key: their jsonl, else the instance id.
 * Both are view preferences - order and scope - so the host stores them across webview
 * reloads (`workspaceState`) and hands them back before the first `tabs`; the host order,
 * which is creation order, stays authoritative for everything else.
 */
const pins = new Set<string>();
const archived = new Set<string>();
/** The 更多 section's switch: finished rows stay folded under the live list until it opens. */
let showArchived = false;
/** The Sessions panel: docked right and open, until the header switch folds it away. */
let panelOpen = true;
/** The filter field: closed until the magnifier asks for it. */
let searchOpen = false;

/** Load what the host kept: one message covers all three, so none may be dropped. */
function applyPrefs(prefs: ListPrefs): void {
	for (const key of prefs.pins) if (typeof key === "string") pins.add(key);
	for (const key of prefs.archived) if (typeof key === "string") archived.add(key);
	panelOpen = prefs.panelOpen !== false;
	setPanelOpen(panelOpen);
}

/** Hand the whole preference set to the host, which stores it in `workspaceState`. */
function savePrefs(): void {
	send({ type: "list/prefs", prefs: { pins: [...pins], archived: [...archived], panelOpen } });
}

/**
 * Fold the Sessions panel or bring it back. Folded, the chat area has the whole width and the
 * same switch sits in its top-right corner, so the panel is one click away from either side.
 */
function setPanelOpen(on: boolean): void {
	panelOpen = on;
	panel.classList.toggle("hidden", !on);
	revealToggle.classList.toggle("hidden", on);
	savePrefs();
}

/**
 * Reveal or hide the filter field behind the magnifier. Hiding it clears the filter: a query
 * that keeps filtering a list with no visible field is a list that lies about its rows.
 */
function setSearchOpen(on: boolean, focus = true): void {
	searchOpen = on;
	searchBar.classList.toggle("hidden", !on);
	searchToggle.classList.toggle("active", on);
	searchToggle.title = on ? "收起搜索（Esc）" : "搜索会话名称";
	if (!on) setQuery("");
	else if (focus) {
		searchInput.focus();
		searchInput.select();
	}
}

function togglePin(key: string): void {
	if (!pins.delete(key)) pins.add(key);
	savePrefs();
	// The list is the only surface these flags show on, and the host pushes nothing for a
	// view-only change - renderBody() would repaint the chat and leave the row untouched.
	renderSessionList();
}

/**
 * 完成（归档）for a live instance: it stops first. The list is the only place a running
 * process can be reached from, so archiving one without stopping it would strand it behind a
 * hidden row. A mid-turn instance asks for the same confirmation a close does.
 */
function archiveLive(row: SessionRow): void {
	if (row.status === "busy") {
		openOverlay("session", [
			el("div", "panel-title", "会话正在运行"),
			el("div", "muted", "归档会先停掉这一轮（未完成的工作会丢失），再把这个会话移出列表。"),
			button("停止并归档", "panel-row danger", () => {
				send({ type: "tab/close", id: row.key });
				setArchived(row.sessionKey, true);
				closeOverlay();
			}),
			button("取消", "chip", closeOverlay),
		]);
		return;
	}
	send({ type: "tab/close", id: row.key });
	setArchived(row.sessionKey, true);
	// Closing the instance re-frees its jsonl, but the host does not push a new history
	// snapshot on close: the stale one still carries the row's `openTabId` and would hide
	// the archived row from 更多. Ask for a fresh one.
	send({ type: "history/refresh" });
}

function setArchived(key: string, on: boolean): void {
	if (on) archived.add(key);
	else archived.delete(key);
	// Nothing left to fold away: the 更多 line goes with it, and the list closes back to its
	// normal scope.
	if (archived.size === 0) showArchived = false;
	savePrefs();
	// Same as togglePin: the row moves in the list, so the list is what must re-render.
	renderSessionList();
}

type OverlayKind =
	| "none"
	| "model"
	| "switch"
	| "stats"
	| "branch"
	| "login"
	| "session"
	| "ui"
	| "mode"
	| "thinking"
	/** A clicked thumbnail, shown at full size over the transcript. */
	| "image"
	/** A row menu, opened at the pointer (right-click). */
	| "context";

const POPUP_KINDS: Partial<Record<OverlayKind, true>> = { mode: true, model: true, thinking: true, context: true };

let overlayKind: OverlayKind = "none";

/** Composer menus anchor to their pill; the session menu opens as an overlay panel. */
function toggleMenu(kind: "mode" | "model" | "thinking"): void {
	if (overlayKind === kind) {
		closeOverlay();
		return;
	}
	if (kind === "mode") openModeMenu();
	else if (kind === "model") openModelMenu();
	else openThinkingMenu();
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/**
 * Queued prompts as compact cards above the composer: text on the left, three
 * actions on the right — 立即 pushes to omp now (steer path), 编辑 loads the text
 * back into the composer and drops the entry, 删除 discards it.
 */
function renderPending(): void {
	if (view.page === "sessions") {
		// Queued prompts belong to an instance; the new-session composer has none.
		pendingList.replaceChildren();
		pendingList.classList.add("hidden");
		return;
	}
	const state = view.state;
	const pending = state?.pending ?? [];
	pendingList.replaceChildren();
	pendingList.classList.toggle("hidden", pending.length === 0);
	for (const entry of pending) {
		const dead = state?.state === "failed" || state?.state === "gone";
		const card = el("div", "pending-card");
		const text = el("div", "pending-text", entry.text);
		text.title = entry.text;
		const actions = el("div", "pending-actions");
		const sendNow = button("↑ 立即", "chip", () => send({ type: "prompt/send-now", id: entry.id }));
		sendNow.disabled = dead;
		sendNow.title = "不等本轮结束，立刻推送给 omp";
		const edit = button("✎", "icon-btn", () => {
			send({ type: "prompt/cancel", id: entry.id });
			promptInput.value = entry.text;
			// Queued images were never sent to omp: they come back with the text.
			if (entry.attachments?.length) {
				view.attachments = view.attachments.concat(
					entry.attachments.map((image, index) => ({ ...image, name: imageName(image.mimeType, index) })),
				);
				renderAttachments();
			}
			promptInput.focus();
			renderCommandHint();
		});
		edit.title = "放回输入框二次编辑";
		const remove = button("🗑", "icon-btn", () => send({ type: "prompt/cancel", id: entry.id }));
		remove.title = "从队列中删除";
		remove.disabled = dead;
		actions.append(sendNow, edit, remove);
		// Images first: an image-only entry is a card of thumbnails with no text line.
		card.append(actions);
		if (entry.attachments?.length) card.prepend(imageStrip(entry.attachments));
		if (entry.text) card.prepend(text);
		pendingList.append(card);
	}
	renderComposerBar();
}

/** Attachment chips above the textarea, on either composer; removable until the prompt leaves. */
function renderAttachments(): void {
	attachChips.classList.toggle("hidden", view.attachments.length === 0);
	attachChips.replaceChildren();
	for (const [index, attachment] of view.attachments.entries()) {
		const chip = el("span", "attach-chip", attachment.name);
		chip.title = `${attachment.name} · ${attachment.mimeType}`;
		const remove = button("×", "attach-remove", () => {
			view.attachments.splice(index, 1);
			renderAttachments();
		});
		chip.append(remove);
		attachChips.append(chip);
	}
}


// ---------------------------------------------------------------------------
// Images: paste, thumbnails, preview
// ---------------------------------------------------------------------------

/**
 * The image bytes a paste carries. Unsupported formats are left alone, so the
 * browser's own paste still delivers the text or the file path.
 */
function clipboardImages(data: DataTransfer | null): File[] {
	if (!data) return [];
	const files: File[] = [];
	for (const item of data.items) {
		if (item.kind !== "file" || IMAGE_MIME_TYPES[item.type] !== true) continue;
		const file = item.getAsFile();
		if (file) files.push(file);
	}
	return files;
}

/**
 * A pasted image is already bytes in this process, so it never needs the host's
 * file dialog: the composer list is the webview's own (dev-plan §1.2).
 */
async function addPastedImages(files: readonly File[]): Promise<void> {
	const added: AttachmentView[] = [];
	for (const [index, file] of files.entries()) {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (bytes.length === 0) continue;
			added.push(pastedAttachment(file, bytes, index));
		} catch {
			// One unreadable clipboard item must not lose the rest of the paste.
		}
	}
	if (added.length === 0) {
		toast("粘贴的图片读不出来", "warn");
		return;
	}
	view.attachments = view.attachments.concat(added);
	renderAttachments();
}

/** The images one turn carries, drawn under its text as clickable thumbnails. */
function imageStrip(images: readonly MessageImage[]): HTMLElement {
	const strip = el("div", "msg-images");
	images.forEach((image, index) => {
		const thumb = el("img", "msg-thumb");
		thumb.src = `data:${image.mimeType};base64,${image.data}`;
		thumb.alt = `图片 ${index + 1}`;
		thumb.title = "点击查看大图";
		thumb.addEventListener("click", () => openImagePreview(images, index));
		strip.append(thumb);
	});
	return strip;
}

/** A thumbnail opened: the image fills the view; a click anywhere or Esc closes it. */
function openImagePreview(images: readonly MessageImage[], index: number): void {
	const image = images[index];
	if (!image) return;
	const stage = el("div", "image-preview");
	stage.tabIndex = -1;
	stage.title = "点击或按 Esc 关闭";
	const full = el("img", "image-preview-img");
	full.src = `data:${image.mimeType};base64,${image.data}`;
	full.alt = `图片 ${index + 1}`;
	stage.append(full);
	stage.addEventListener("click", closeOverlay);
	stage.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeOverlay();
	});
	overlayKind = "image";
	overlay.replaceChildren(stage);
	overlay.classList.remove("hidden");
	stage.focus();
}
/**
 * The single bottom bar: [＋] [mode] [model] [thinking] [ring] ... [queue] [mic] [send/stop].
 * Send becomes stop (square) while a turn is running. On the list page the pills describe
 * the session the next send will start, so they show omp's config defaults until picked.
 */
function renderComposerBar(): void {
	const state = view.state;
	const onSessionsPage = view.page === "sessions";

	// Clickable on both pages: the host's menu carries the truth per mode (what works here,
	// and what a disabled row is waiting for) instead of one blanket read-only pill.
	const modeNote = state?.modeNote ?? (onSessionsPage ? view.newSession?.modeNote : undefined);
	const draftMode = onSessionsPage ? view.draft.mode : undefined;
	const shown = draftMode ?? (onSessionsPage ? "none" : state?.mode);
	modeButton.textContent = shown ? (MODE_LABELS[shown] ?? shown) : "Agent";
	modeButton.title = modeNote ?? "切换模式";

	const pickedModel = onSessionsPage ? view.draft.model ?? view.newSession?.model : undefined;
	const modelText = onSessionsPage
		? pickedModel?.label ?? "默认"
		: state?.modelsLoading && !state.model
			? "拉取模型…"
			: state?.model ?? "默认";
	modelButton.textContent = modelText;
	modelButton.title = onSessionsPage
		? view.draft.model
			? `${view.draft.model.provider}/${view.draft.model.id}`
			: "新会话默认用 config.yml 的 modelRoles.default；点这里临时换一个"
		: state?.model ?? "选择模型";

	const thinkingText = onSessionsPage
		? view.draft.thinking ?? view.newSession?.thinking ?? "默认"
		: state?.thinkingLevel ?? "off";
	thinkingButton.textContent = thinkingText;
	thinkingButton.title = "思考等级";

	// The list composer has no instance behind it, so it has no context to draw.
	renderContextRing(onSessionsPage ? undefined : state);

	planChip.classList.toggle("hidden", onSessionsPage || !state?.planFile);
	if (!onSessionsPage && state?.planFile) planChip.title = state.planFile;

	const running = isRunActive();
	promptInput.placeholder = running ? PLACEHOLDER_QUEUED : onSessionsPage ? PLACEHOLDER_NEW_SESSION : PLACEHOLDER_IDLE;
	sendButton.textContent = running ? "■" : "↑";
	sendButton.title = running ? "停止当前一轮（Esc）" : onSessionsPage ? "发送并新建会话（Enter）" : "发送（Enter）";
	sendButton.disabled = !running && !onSessionsPage && (state?.state === "failed" || state?.state === "gone");
	micButton.classList.toggle("recording", dictating);
}

/**
 * Ring, number and tooltip from one `contextUsage` reading. The arc and the percent are
 * omp's; the tooltip carries the counts it reported verbatim, and says less when it
 * reported less - a "used" number back-computed from the percent would be invented.
 */
function renderContextRing(state: InstanceState | undefined): void {
	const percent = state?.contextPercent;
	if (percent === undefined) {
		contextRing.classList.add("hidden");
		return;
	}
	contextRing.classList.remove("hidden");
	const filled = Math.min(100, Math.max(0, percent));
	contextRingArc.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - filled / 100)));
	// Same ramp for the same reason as everywhere else: near the window is worth noticing.
	contextRing.classList.toggle("warn", filled >= 75 && filled < 90);
	contextRing.classList.toggle("danger", filled >= 90);

	const label = `${Math.round(percent)}%`;
	contextRingValue.textContent = label;
	contextRingValue.classList.toggle("tight", label.length > 3);

	const used = formatTokens(state?.contextTokens);
	const windowTokens = formatTokens(state?.contextWindow);
	const exact = `${Math.round(percent * 10) / 10}%`;
	contextRing.title = used && windowTokens
		? `上下文 ${used} / ${windowTokens} tokens（${exact}）`
		: windowTokens
			? `上下文 ${exact} / ${windowTokens} tokens`
			: `上下文 ${exact}`;
}

/** Session chips live under the prompt: mode / model / thinking / context. */
function renderComposerChrome(): void {
	renderAttachments();
	renderPending();
	renderComposerBar();
}

// ---------------------------------------------------------------------------
// Chat / view stack
// ---------------------------------------------------------------------------

/**
 * Render signature of the item a node was built from. Streaming pushes the same
 * row many times with identical content (state ticks, tool progress polling); a
 * stable signature lets those no-ops skip DOM work entirely.
 */
const renderSignatures = new Map<string, string>();

function signatureOf(item: Item): string {
	switch (item.kind) {
		case "user":
			return `u:${item.text}:${item.images?.length ?? 0}:${item.timestamp ?? ""}`;
		case "assistant":
			return `a:${item.text}:${item.thinking}:${item.streaming}:${item.error ?? ""}:${item.model ?? ""}:${item.thinkingMs ?? ""}`;
		case "tool":
			return [
				item.status, item.name, item.intent ?? "", item.summary ?? "", item.progress ?? "",
				item.path ?? "", item.command ?? "", item.errorText ?? "", item.durationMs ?? "",
				item.added ?? "", item.removed ?? "", item.files.length, item.subagentId ?? "",
			].join("|");
		case "notice":
			return `n:${item.level}:${item.text}`;
		case "command":
			return `c:${item.text}`;
		case "divider":
			return `d:${item.text}`;
	}
}

/**
 * Paint the transcript's changed rows. `lazy` = opening a snapshot: rows beyond the
 * tail window become placeholders instead of DOM (streaming upserts pass `lazy=false`
 * and always paint - they live in the tail by construction).
 */
function renderItems(items: Item[], lazy = false): void {
	const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
	const firstReal = lazy && items.length > LAZY_TAIL ? items.length - LAZY_TAIL : 0;
	const estimate = firstReal > 0 ? measureAverageRowHeight() : 0;
	for (const [index, item] of items.entries()) {
		if (index < firstReal) {
			materializePlaceholder(item.key, estimate);
			continue;
		}
		const existing = itemElements.get(item.key);
		const signature = signatureOf(item);
		if (existing && renderSignatures.get(item.key) === signature) continue;
		const next = itemEl(item);
		const placeholder = lazyPending.get(item.key);
		if (placeholder) {
			lazyPending.delete(item.key);
			placeholder.replaceWith(next);
		} else if (existing) {
			carryOpenState(existing, next);
			existing.replaceWith(next);
		} else streamColumn.append(next);
		itemElements.set(item.key, next);
		renderSignatures.set(item.key, signature);
	}
	if (atBottom) stream.scrollTop = stream.scrollHeight;
}

/** Mean rendered height of the materialized tail, for placeholder sizing. */
function measureAverageRowHeight(): number {
	const heights: number[] = [];
	for (const node of itemElements.values()) {
		const height = node.getBoundingClientRect().height;
		if (height > 0) heights.push(height);
	}
	if (heights.length === 0) return LAZY_PLACEHOLDER_MIN;
	return heights.reduce((sum, value) => sum + value, 0) / heights.length;
}

/**
 * Put a placeholder where a row will later render. The row itself is looked up from
 * `view.items` when the observer fires, so no row is built twice.
 */
function materializePlaceholder(key: string, estimate: number): void {
	if (itemElements.has(key)) return;
	const existing = lazyPending.get(key);
	if (existing) return;
	const placeholder = el("div", "item lazy-placeholder");
	placeholder.style.minHeight = `${Math.max(LAZY_PLACEHOLDER_MIN, estimate)}px`;
	placeholder.dataset.key = key;
	lazyPending.set(key, placeholder);
	streamColumn.append(placeholder);
	lazyObserver ??= new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const node = entry.target as HTMLElement;
			lazyObserver?.unobserve(node);
			const key = node.dataset.key;
			if (!key) continue;
			lazyPending.delete(key);
			const item = view.items.find((candidate) => candidate.key === key);
			if (!item) {
				node.remove();
				continue;
			}
			const row = itemEl(item);
			node.replaceWith(row);
			itemElements.set(key, row);
			renderSignatures.set(key, signatureOf(item));
		}
	});
	lazyObserver.observe(placeholder);
}

/** Tear down lazy state: real rows' placeholders and queued observations. */
function resetLazyRender(): void {
	lazyObserver?.disconnect();
	lazyObserver = undefined;
	lazyPending.clear();
}

/**
 * A row being streamed updates in place, and every update replaces its node: an
 * expanded thinking block or tool result would slam shut mid-read. Pair the
 * `<details>` of both nodes by position, which is stable for one item's shape.
 */
function carryOpenState(previous: HTMLElement, next: HTMLElement): void {
	const before = previous.querySelectorAll("details");
	const after = next.querySelectorAll("details");
	for (let index = 0; index < before.length && index < after.length; index += 1) {
		if (before[index].open) after[index].open = true;
	}
}

/** Drops transcript rows the host removed (e.g. a retry line that recovered). */
function removeItems(keys: string[]): void {
	for (const key of keys) {
		itemElements.get(key)?.remove();
		itemElements.delete(key);
		renderSignatures.delete(key);
	}
}

function itemEl(item: Item): HTMLElement {
	switch (item.kind) {
		case "user": {
			const node = el("div", "item user", item.text);
			if (item.timestamp) {
				const at = new Date(item.timestamp);
				const pad = (value: number) => String(value).padStart(2, "0");
				node.title = `发送于 ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
			}
			if (item.images?.length) node.append(imageStrip(item.images));
			return node;
		}
		case "assistant": {
			const node = el("div", "item assistant");
			if (item.thinking.trim()) node.append(thinkingRow(item.thinking, item.thinkingMs));
			if (item.text.trim()) node.append(markdownEl(item.text));
			if (item.error) node.append(el("div", "item-error", item.error));
			if (item.streaming) node.append(el("span", "caret", "▍"));
			return node;
		}
		case "tool": {
			const line = toolLine(item);
			const node = el("div", "item tool");
			const details = el("details", "tool");
			const summary = el("summary", "tool-line");
			summary.title = line.title ?? line.subject ?? item.name;
			const glyph = el("span", "glyph", line.glyph);
			glyph.classList.add(item.status);
			summary.append(glyph, el("span", "verb", line.verb));
			if (line.subject) summary.append(el("span", line.mono ? "subject mono" : "subject", line.subject));
			if (line.directory) summary.append(el("span", "muted directory", line.directory));
			if (item.added !== undefined) summary.append(el("span", "diff-add", `+${item.added}`));
			if (item.removed !== undefined) summary.append(el("span", "diff-remove", `-${item.removed}`));
			if (line.failed) summary.append(el("span", "diff-fail", "执行失败"));
			details.append(summary, toolBody(item));
			node.append(details);
			if (item.subagentId) {
				const id = item.subagentId;
				node.append(button("查看输出", "chip", () => send({ type: "view/open-subagent", id })));
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
		case "divider": {
			const node = el("div", "item divider");
			node.append(el("span", "divider-line"), el("span", "divider-label", item.text), el("span", "divider-line"));
			return node;
		}
		default:
			return el("div", "item");
	}
}

/** Thinking is a timeline row, not a block: the prose stays one click away. */
function thinkingRow(thinking: string, thinkingMs?: number): HTMLElement {
	const details = el("details", "thinking");
	const summary = el("summary", "thinking-line");
	summary.title = "展开思考正文";
	summary.append(el("span", "glyph", "⏱"), el("span", "verb", thinkingLabel(thinkingMs)));
	const body = el("div", "row-body");
	body.append(markdownEl(thinking));
	details.append(summary, body);
	return details;
}

/** What the old card showed, one click down: progress, result, files, runtime. */
function toolBody(item: ToolItem): HTMLElement {
	const body = el("div", "row-body");
	if (item.progress) body.append(el("div", "muted progress", item.progress));
	if (item.summary) {
		const result = el("details", "result");
		result.append(el("summary", undefined, item.status === "error" ? "错误输出" : "结果"));
		result.append(el("pre", "summary", item.summary));
		body.append(result);
	}
	if (item.durationMs !== undefined) body.append(el("div", "muted small", `耗时 ${humanDuration(item.durationMs)}`));
	if (item.files.length > 0) {
		const files = el("div", "files");
		for (const path of item.files) files.append(fileChip(path));
		body.append(files);
	}
	if (body.childElementCount === 0) {
		body.append(el("div", "muted small", item.status === "running" ? "正在执行…" : "（无输出）"));
	}
	return body;
}

/**
 * Drop every DOM artifact of the active instance: cached item nodes, the visible
 * transcript, and session-scoped overlays/popups.
 */
function clearSessionElements(): void {
	itemElements.clear();
	renderSignatures.clear();
	resetLazyRender();
	if (overlayKind === "model" || overlayKind === "ui") closeOverlay();
}

/** Detail top bar: back button + title. Back pops a stacked layer, else clears the selection. */
function renderDetailHeader(state: InstanceState): void {
	const top = view.stack[view.stack.length - 1];
	viewHeader.classList.remove("hidden");
	viewHeader.replaceChildren();
	if (view.stack.length > 1 && top) {
		viewHeader.append(button("← 返回对话", "chip", () => send({ type: "view/back" })));
		viewHeader.append(el("span", "view-title", top.title));
		if (top.status) viewHeader.append(el("span", "muted small", top.status));
		if (top.source) viewHeader.append(fileChip(top.source));
		return;
	}
	const back = button("←", "icon-btn back", () => openSessionsPage());
	back.title = "回到空白页（进程继续运行）";
	const tab = view.tabs.find((candidate) => candidate.id === view.id);
	viewHeader.append(back, el("span", "view-title", tab?.title ?? state.sessionName ?? "会话"));
}

/**
 * No session picked: the chat area is the blank surface the next task starts from, and the
 * Sessions panel beside it is where the existing ones are. The list is not a page any more -
 * it never needed to be (dev-plan §1.2) - so an empty chat area is the whole landing state.
 */
function renderOverview(): void {
	viewHeader.classList.add("hidden");
	viewHeader.replaceChildren();
	composer.classList.remove("hidden");
	renderComposerChrome();
	streamColumn.replaceChildren();
	itemElements.clear();
	renderSignatures.clear();
	resetLazyRender();
}

/** The one list: live instances plus this workspace's session files, filtered in place. */
function renderSessionList(): void {
	sessionsList.replaceChildren();
	const filtering = view.query.trim() !== "";
	const list = buildSessionList(view.tabs, view.history, { pins, archived, showArchived, query: view.query });
	// The module sorts finished rows last, so the rows split at that flag: everything before it
	// is the live list, everything carrying it belongs in 更多 - and only the section's open
	// state decides whether the module handed those rows over at all.
	const live = list.rows.filter((row) => !row.row.archived);
	const finished = list.rows.filter((row) => row.row.archived);

	// The count line only when something matched: at zero the empty state below says it once.
	if (filtering && live.length > 0) sessionsList.append(el("div", "muted sessions-empty", filterHint(live)));
	for (const row of live) sessionsList.append(row.kind === "live" ? sessionRowEl(row.row) : historyRowEl(row.row));
	if (list.archived > 0) {
		// Every row is folded away, so say why the list looks empty - the section below it is
		// what the workspace has left.
		if (live.length === 0 && !filtering) sessionsList.append(el("div", "muted sessions-empty", "这里都已归档。"));
		sessionsList.append(moreSection(list.archived, finished));
		return;
	}
	if (live.length === 0) {
		const empty = filtering ? "没有匹配的会话。" : "还没有任何会话。在左边输入框描述任务，发送后会新建一个。";
		sessionsList.append(el("div", "muted sessions-empty", empty));
	}
}

/**
 * 更多: the finished rows, folded under the live list. The whole line is the switch, so the
 * count and the disclosure read as one control, and the rows it opens are the same row
 * elements as the live list - which is what lets one be opened (点行 = 恢复/切到它) or restored
 * (取消归档) without the section growing actions of its own.
 */
function moreSection(count: number, rows: ListRow[]): HTMLElement {
	const section = el("div", `session-more${showArchived ? " open" : ""}`);
	const line = button("", "session-more-line", () => {
		showArchived = !showArchived;
		renderSessionList();
	});
	line.title = showArchived ? "收起已归档的会话" : `展开已归档的 ${count} 个会话`;
	line.setAttribute("aria-expanded", showArchived ? "true" : "false");
	line.append(svgIcon([CHEVRON_ICON], "chevron"), el("span", "session-more-label", `更多 · ${count} 个已归档`));
	section.append(line);
	if (rows.length > 0) {
		const group = el("div", "session-more-rows");
		for (const row of rows) group.append(row.kind === "live" ? sessionRowEl(row.row) : historyRowEl(row.row));
		section.append(group);
	}
	return section;
}

/** Count line over the filtered list: `N 个会话（M 个运行中）`, so a search's effect is visible. */
function filterHint(rows: ListRow[]): string {
	const live = rows.filter((row) => row.kind === "live").length;
	return `${rows.length} 个会话${live > 0 ? `（${live} 个运行中）` : ""}。`;
}

/** Set the search text from anywhere in the UI, keeping the input and the list in step. */
function setQuery(value: string): void {
	view.query = value;
	if (searchInput.value !== value) searchInput.value = value;
	renderSessionList();
}

/**
 * The `打开历史会话` command lands here: the panel unfolded, the filter field open, the caret
 * in it. The field is the only part of the panel chrome that can be closed, so opening it is
 * part of landing on the list.
 */
function focusSearch(): void {
	setPanelOpen(true);
	setSearchOpen(true);
}

/**
 * How narrow the view has to be for the panel to overlay the chat instead of sitting beside it.
 * Must match the `max-width` in styles.css: same switch, one in layout and one in behaviour.
 */
const NARROW_VIEW = "(max-width: 480px)";

/**
 * Opening a session is a request to read it. In a narrow view the panel overlays the chat, so
 * it folds away here - otherwise the click would look like it did nothing.
 */
function collapsePanelIfNarrow(): void {
	if (panelOpen && window.matchMedia(NARROW_VIEW).matches) setPanelOpen(false);
}

/**
 * The two row glyphs, taken from VS Code's own codicon set (MIT) so a row's actions read like
 * the rest of the workbench. They are fill-based, unlike the stroked funnel in the search field.
 */
const PIN_ICON =
	"M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z";
const CHECK_ICON =
	"M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z";
/** The 更多 disclosure: a stroked chevron that turns down when the section opens. */
const CHEVRON_ICON = "M6.2 3.6 10.6 8l-4.4 4.4";

/** `session-row` plus the flags both kinds carry: pinned keeps a left accent, finished dims. */
function rowShell(pinned: boolean, archived: boolean): HTMLElement {
	return el("div", `session-row${pinned ? " pinned" : ""}${archived ? " archived" : ""}`);
}

/** One instance: state dot, title, `mode · state` meta, and the hover pair. */
function sessionRowEl(row: SessionRow): HTMLElement {
	const node = rowShell(row.pinned, row.archived);
	// The row the chat area is showing: with both panes on screen at once, the panel is what
	// says which conversation the transcript belongs to.
	if (row.key === view.id) node.classList.add("active");
	if (row.sessionFile) node.title = row.sessionFile;
	// `idle` means no instance is running: no dot at all, just the 可加载 meta.
	if (row.status !== "idle") {
		const dot = el("span", `dot ${dotClass(row.status)}`);
		node.append(dot);
	}
	const main = el("div", "session-main");
	main.append(el("div", "session-title", row.title));
	main.append(el("div", "session-meta small", row.archived ? `${sessionMeta(row)} · 已归档` : sessionMeta(row)));
	node.append(main);
	if (row.unread) node.append(el("span", "unread", "·"));
	node.append(sessionActions(row, () => archiveLive(row)));
	// Click selects the session; right-click opens everything else.
	node.addEventListener("click", () => enterSession(row.key));
	rowContextMenu(node, { kind: "live", row });
	return node;
}

/** One session file no live instance owns: a click resumes it into a new instance. */
function historyRowEl(row: HistoryRow): HTMLElement {
	const node = rowShell(row.pinned, row.archived);
	node.title = row.file;
	const main = el("div", "session-main");
	main.append(el("div", "session-title", row.title));
	main.append(el("div", "session-meta small", `${historyMeta(row)} · ${row.archived ? "已归档" : "可加载"}`));
	node.append(main);
	node.append(sessionActions(row, () => setArchived(row.file, true)));
	node.addEventListener("click", () => enterHistory(row.file));
	rowContextMenu(node, { kind: "history", row });
	return node;
}

/** A list row opened: the next `session` snapshot switches the chat area to it. */
function enterSession(id: string): void {
	enteringSession = true;
	collapsePanelIfNarrow();
	send({ type: "tab/select", id });
}

/** A file row opened: the host starts another instance, resuming this jsonl. */
function enterHistory(file: string): void {
	enteringSession = true;
	collapsePanelIfNarrow();
	send({ type: "tab/open-history", file });
}

/**
 * The hover pair every row has, and nothing else: 置顶 and 完成（归档）. 改名, 关闭 and the copy
 * entries moved into the row menu, so a row at rest is a title and its meta.
 */
function sessionActions(row: SessionRow | HistoryRow, archive: () => void): HTMLElement {
	const actions = el("div", "session-actions");
	actions.append(
		rowAction(PIN_ICON, row.pinned ? "取消置顶" : "置顶（排到列表最前）", row.pinned, () => togglePin(row.sessionKey)),
		rowAction(CHECK_ICON, row.archived ? "取消归档" : "标记完成（归档），不再显示在列表里", row.archived, () =>
			row.archived ? setArchived(row.sessionKey, false) : archive(),
		),
	);
	return actions;
}

/** One hover action: an icon button that never doubles as a click on the row itself. */
function rowAction(icon: string, title: string, on: boolean, onClick: () => void): HTMLButtonElement {
	const node = el("button", `session-action${on ? " on" : ""}`);
	node.type = "button";
	node.title = title;
	node.append(svgIcon([icon], "icon"));
	node.addEventListener("click", (event) => {
		event.stopPropagation();
		onClick();
	});
	return node;
}

/**
 * Right-click opens the row menu at the pointer. VS Code would put its own webview menu
 * (cut/copy/paste) there, so the event is consumed; `preventDefaultContextMenuItems` is the
 * same belt over the braces, for a row whose menu never carries those entries.
 */
function rowContextMenu(node: HTMLElement, row: ListRow): void {
	node.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true });
	node.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		openRowMenu(row, event.clientX, event.clientY);
	});
}

/** Everything a row can do, minus what the hover pair already offers. */
function openRowMenu(row: ListRow, x: number, y: number): void {
	const menu = openPopup("context", row.kind === "live" ? liveRowMenu(row.row) : fileRowMenu(row.row), "context-menu");
	menu.style.left = `${x}px`;
	menu.style.top = `${y}px`;
	// Opened near an edge it comes back in: the sidebar is narrow enough to reach both.
	const rect = menu.getBoundingClientRect();
	if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
	if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height)}px`;
}

/** A menu entry closes the popup first: every one of them acts on a row that then moves. */
function menuItem(rows: HTMLElement[], label: string, onClick: () => void): void {
	rows.push(
		button(label, "menu-row", () => {
			closeOverlay();
			onClick();
		}),
	);
}

function liveRowMenu(row: SessionRow): HTMLElement[] {
	const rows: HTMLElement[] = [];
	menuItem(rows, "打开会话", () => enterSession(row.key));
	menuItem(rows, "重命名…", () => promptRenameSession(row.key, row.title));
	menuItem(rows, row.pinned ? "取消置顶" : "置顶", () => togglePin(row.sessionKey));
	// A busy instance confirms inside `archiveLive`; the popup is already gone by then.
	menuItem(rows, row.archived ? "取消归档" : "标记完成（归档）", () =>
		row.archived ? setArchived(row.sessionKey, false) : archiveLive(row),
	);
	rows.push(el("div", "menu-sep"));
	menuItem(rows, "复制名称", () => copyText(row.title, "已复制会话名称"));
	const file = row.sessionFile;
	if (file) menuItem(rows, "复制会话文件路径", () => copyText(file, "已复制文件路径"));
	// dev-plan §1.3: a streaming turn is real work; killing it needs one confirmation.
	const busy = row.status === "busy";
	rows.push(el("div", "menu-sep"));
	menuItem(rows, busy ? "关闭会话（运行中，先确认）" : "关闭会话（结束进程）", () =>
		busy ? confirmCloseSession(row.key) : send({ type: "tab/close", id: row.key }),
	);
	return rows;
}

/** A file row has no instance to rename or close, so its menu is the shorter one. */
function fileRowMenu(row: HistoryRow): HTMLElement[] {
	const rows: HTMLElement[] = [];
	menuItem(rows, "恢复会话（新实例）", () => enterHistory(row.file));
	menuItem(rows, row.pinned ? "取消置顶" : "置顶", () => togglePin(row.sessionKey));
	menuItem(rows, row.archived ? "取消归档" : "标记完成（归档）", () => setArchived(row.sessionKey, !row.archived));
	rows.push(el("div", "menu-sep"));
	menuItem(rows, "复制名称", () => copyText(row.title, "已复制会话名称"));
	menuItem(rows, "复制会话文件路径", () => copyText(row.file, "已复制文件路径"));
	return rows;
}

/** Copying goes through the host: VS Code's clipboard, not the webview's restricted one. */
function copyText(text: string, done: string): void {
	send({ type: "clipboard/write", text });
	toast(done, "info");
}

/** Confirm before killing an instance mid-turn: the running turn cannot be replayed. */
function confirmCloseSession(id: string): void {
	openOverlay("session", [
		el("div", "panel-title", "会话正在运行"),
		el("div", "muted", "现在关闭会中止这一轮，未完成的工作会丢失。"),
		button("关闭会话", "panel-row danger", () => {
			send({ type: "tab/close", id });
			closeOverlay();
		}),
		button("取消", "chip", closeOverlay),
	]);
}

/** `Plan · 运行中`: the instance reports both, so the row never has to guess. */
function sessionMeta(row: SessionRow): string {
	const parts = row.mode ? [MODE_LABELS[row.mode] ?? row.mode] : [];
	parts.push(STATUS_LABELS[row.status]);
	return parts.join(" · ");
}

/** The dot color classes: asking blue, done green, failure red; busy/retrying spin. */
function dotClass(status: SessionStatus): string {
	switch (status) {
		case "asking":
			return "asking";
		case "busy":
			return "spin";
		case "retrying":
			return "spin error";
		case "running":
			return "ok";
		default:
			return "error";
	}
}

/**
 * Clear the selection: the chat area goes back to blank, the panel keeps showing every
 * session. The instance keeps running - only what the chat area shows changes.
 */
function openSessionsPage(): void {
	view.page = "sessions";
	enteringSession = false;
	// Attachments are composer-scoped: the ones typed for a session do not follow the user
	// back to the blank page. The text does, so the popup is recomputed from that page's
	// `/` list instead of being dropped.
	view.attachments = [];
	renderCommandHint();
	send({ type: "history/refresh" });
	renderBody();
}

/** The chat area: blank page, chat, a read-only stacked layer, or the failure panel. */
function renderBody(): void {
	if (view.page === "sessions") {
		renderOverview();
		return;
	}
	const state = view.state;
	if (view.id === undefined || state === undefined) {
		// Defensive: a detail page without an instance behind it is the blank page.
		view.page = "sessions";
		renderOverview();
		return;
	}
	renderDetailHeader(state);
	if (state.state === "failed" || state.state === "gone") {
		// A dead process cannot accept a prompt: the composer must not pretend otherwise.
		// A question it was waiting on died with it - the dock must not survive a restart.
		if (overlayKind === "ui") closeOverlay();
		composer.classList.add("hidden");
		renderFailure(state);
		return;
	}
	composer.classList.remove("hidden");
	renderComposerChrome();
	const top = view.stack[view.stack.length - 1];
	if (view.stack.length === 1 || !top) {
		streamColumn.replaceChildren();
		itemElements.clear();
		renderSignatures.clear();
		// Snapshot (re)paint: open a long transcript with tail-only materialization.
		// The observer belongs to this repaint's placeholders; stale ones must not
		// survive a swap that already detached their nodes.
		resetLazyRender();
		renderItems(view.items, true);
		return;
	}
	// Locked product decision: a stacked view replaces the chat inside the same instance.
	const body = el("div", "item view-body");
	body.append(top.body?.trim() ? markdownEl(top.body) : el("div", "muted", "（空）"));
	streamColumn.replaceChildren(body);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function isRunActive(): boolean {
	// The sessions page composer has no instance behind it: nothing can be running there.
	if (view.page === "sessions") return false;
	const state = view.state;
	return !!state && (state.streaming || state.compacting || state.queued > 0 || state.state === "streaming");
}

function abortPrompt(): void {
	if (!isRunActive()) return;
	send({ type: "prompt/abort" });
}

function submitPrompt(): void {
	const text = promptInput.value.trim();
	if (!text && view.attachments.length === 0) return;
	const attachments = view.attachments.splice(0);
	promptInput.value = "";
	renderAttachments();
	renderCommandHint();
	if (view.page === "sessions") {
		// Send is the whole point of the list composer: create the instance and hand it this
		// prompt in one step, started with whatever the pills showed (dev-plan §1.3). Mode is
		// only ever set when omp's RPC can switch modes; today the pill is read-only (U2).
		enteringSession = true;
		send({
			type: "session/create-and-send",
			text,
			...(attachments.length > 0 ? { attachments } : {}),
			...(view.draft.mode ? { mode: view.draft.mode } : {}),
			...(view.draft.model ? { model: { provider: view.draft.model.provider, id: view.draft.model.id } } : {}),
			...(view.draft.thinking ? { thinking: view.draft.thinking } : {}),
		});
		view.draft = {};
		renderComposerBar();
		return;
	}
	send({ type: "prompt/send", text, ...(attachments.length > 0 ? { attachments } : {}) });
}

// ---------------------------------------------------------------------------
// Composer menus (popup, anchored above the bar)
// ---------------------------------------------------------------------------

/** A lightweight popup: click-away and Escape close it, the caller positions it. */
function openPopup(kind: OverlayKind, rows: HTMLElement[], className?: string): HTMLElement {
	// One popup at a time: a hot re-render (model catalog landing) replaces, never stacks.
	closeOverlay();
	overlayKind = kind;
	const menu = el("div", className ? `menu ${className}` : "menu");
	menu.append(...rows);
	document.body.append(menu);
	const dismiss = (event: MouseEvent) => {
		if (event.target instanceof Node && menu.contains(event.target)) return;
		closeOverlay();
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key === "Escape") closeOverlay();
	};
	setTimeout(() => {
		document.addEventListener("mousedown", dismiss);
		document.addEventListener("keydown", escape);
	}, 0);
	menuDisarm = () => {
		document.removeEventListener("mousedown", dismiss);
		document.removeEventListener("keydown", escape);
	};
	return menu;
}

/** A composer popup sits over its pill, on the composer bar's floor. */
function openMenu(kind: OverlayKind, anchor: HTMLElement, rows: HTMLElement[], className?: string): void {
	const menu = openPopup(kind, rows, className);
	const barRect = composerBar.getBoundingClientRect();
	const anchorRect = anchor.getBoundingClientRect();
	menu.style.left = `${anchorRect.left}px`;
	menu.style.bottom = `${window.innerHeight - barRect.top + 4}px`;
}

let menuDisarm: (() => void) | undefined;

function openModeMenu(): void {
	const onSessionsPage = view.page === "sessions";
	// The host owns the menu: which modes work on this surface, what each one does, and why
	// a row cannot be picked (docs/upstream-issues.md U2). The webview only draws it.
	const choices = view.state?.modes ?? (onSessionsPage ? view.newSession?.modes : undefined) ?? [];
	const modeNote = view.state?.modeNote ?? (onSessionsPage ? view.newSession?.modeNote : undefined);
	const current = onSessionsPage ? view.draft.mode ?? "none" : view.state?.mode;
	const rows: HTMLElement[] = [];
	if (choices.length === 0) rows.push(el("div", "menu-note", "宿主没有报告模式选项"));
	for (const choice of choices) {
		const row = button(choice.label, "menu-row", () => {
			if (current === choice.mode) {
				closeOverlay();
				return;
			}
			if (onSessionsPage) {
				view.draft.mode = choice.mode;
				renderComposerBar();
			} else send({ type: "mode/set", mode: choice.mode });
			closeOverlay();
		});
		row.disabled = !choice.enabled;
		if (choice.enabled) row.title = choice.hint;
		if (current === choice.mode) row.classList.add("active");
		rows.push(row);
		// A disabled row explains itself underneath: a tooltip is too little when the reason
		// is the whole point of showing the row greyed out.
		if (!choice.enabled) rows.push(el("div", "menu-note", choice.hint));
	}
	if (modeNote) rows.push(el("div", "menu-note", modeNote));
	openMenu("mode", modeButton, rows);
}

function openThinkingMenu(): void {
	const onSessionsPage = view.page === "sessions";
	const current = onSessionsPage ? view.draft.thinking ?? view.newSession?.thinking : view.state?.thinkingLevel;
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const rows = levels.map((level) => {
		const row = button(level, "menu-row", () => {
			if (onSessionsPage) {
				view.draft.thinking = level;
				renderComposerBar();
			} else send({ type: "thinking/set", level });
			closeOverlay();
		});
		if (current === level) row.classList.add("active");
		return row;
	});
	openMenu("thinking", thinkingButton, rows);
}

/**
 * Model picker: the same anchored popup as mode/thinking, not a sheet overlay.
 * Rows hot-swap in place when the catalog lands (`applyModels`, or `new-session` for the
 * list composer, whose catalog comes from the CLI instead of a running instance).
 */
function openModelMenu(requestRefresh = true): void {
	const onSessionsPage = view.page === "sessions";
	const models = onSessionsPage ? view.newSession?.models ?? [] : view.models;
	const loading = !onSessionsPage && view.state?.modelsLoading === true;
	const note = onSessionsPage ? view.newSession?.error : view.state?.modelsError;
	if (requestRefresh && models.length === 0 && !loading && (onSessionsPage || view.id)) {
		send(onSessionsPage ? { type: "new-session/refresh" } : { type: "models/refresh" });
	}
	const rows: HTMLElement[] = [];
	if (loading) rows.push(el("div", "menu-note", "正在从 omp 拉取模型列表（后台发现可能还没结束）"));
	else if (models.length === 0) {
		rows.push(
			el(
				"div",
				"menu-note",
				note ?? (onSessionsPage ? "omp models ls 没有报告任何可用模型" : "omp 未报告任何已配置凭证的模型"),
			),
		);
		rows.push(
			button("重新拉取", "menu-row", () => send(onSessionsPage ? { type: "new-session/refresh" } : { type: "models/refresh" })),
		);
	}
	for (const model of models) {
		const row = button("", "menu-row model", () => {
			if (onSessionsPage) {
				view.draft.model = model;
				renderComposerBar();
			} else send({ type: "model/set", provider: model.provider, id: model.id });
			closeOverlay();
		});
		row.append(el("span", "", model.label));
		row.append(el("span", "muted small", `${model.provider}/${model.id}`));
		const picked = onSessionsPage ? view.draft.model : undefined;
		const active = picked
			? picked.provider === model.provider && picked.id === model.id
			: !onSessionsPage && view.state?.model === `${model.provider}/${model.id}`;
		if (active) row.classList.add("active");
		rows.push(row);
	}
	openMenu("model", modelButton, rows, "model-menu");
}

// ---------------------------------------------------------------------------
// Session controls menu — every remaining RPC capability gets an entry here
// ---------------------------------------------------------------------------

function openSessionMenu(): void {
	if (!view.id) {
		toast("没有活动的会话：新建一个实例后再操作会话", "warn");
		return;
	}
	// Captured by value: the menu's actions run after this render, and the row actions
	// rename an instance by id, so this one must not follow the active instance later.
	const id = view.id;
	const state = view.state;
	const rows: HTMLElement[] = [];
	const row = (label: string, onClick: () => void, title?: string) => {
		const node = button(label, "panel-row", () => {
			closeOverlay();
			onClick();
		});
		if (title) node.title = title;
		rows.push(node);
		return node;
	};

	row("重命名会话…", () => promptRenameSession(id, state?.sessionName ?? ""), "set_session_name");
	row("新建会话（同进程）", () => send({ type: "session/new" }), "new_session：当前 Tab 换一份新 jsonl");
	row("切换到历史会话…", openSwitchSessionPicker, "switch_session：当前进程指向另一份 jsonl");
	row("从分支点分叉…", openBranchPicker, "branch：从某条历史条目分叉出新会话");
	row("统计…", openStatsPanel, "get_session_stats");
	row("导出 HTML", () => send({ type: "session/export-html" }), "export_html");
	row("Handoff（总结并压缩）", () => send({ type: "session/handoff" }), "handoff：生成摘要并就地压缩");
	row("复制最后回复", () => send({ type: "session/last-text" }), "get_last_assistant_text");
	row("手动压缩…", promptCompact, "compact");

	rows.push(el("div", "menu-sep"));
	row(
		`Fast mode：${state?.fastModeEnabled ? "开" : "关"}`,
		() => send({ type: "session/fast-mode", enabled: !state?.fastModeEnabled }),
	);
	row(`自动压缩：${state?.autoCompactionEnabled ? "开" : "关"}`, () =>
		send({ type: "session/auto-compaction", enabled: !state?.autoCompactionEnabled }),
	);
	row(`自动重试：${state?.autoRetryEnabled ? "开" : "关"}`, () =>
		send({ type: "session/auto-retry", enabled: !state?.autoRetryEnabled }),
	);
	row("中止重试", () => send({ type: "session/abort-retry" }), "abort_retry");
	rows.push(el("div", "menu-sep"));
	row(
		`Steering：${state?.steeringMode ?? "?"}`,
		() =>
			send({
				type: "session/queue-mode",
				kind: "steering",
				mode: state?.steeringMode === "all" ? "one-at-a-time" : "all",
			}),
		"运行中插话的排队方式",
	);
	row(
		`Follow-up：${state?.followUpMode ?? "?"}`,
		() =>
			send({
				type: "session/queue-mode",
				kind: "followUp",
				mode: state?.followUpMode === "all" ? "one-at-a-time" : "all",
			}),
	);
	row(
		`Interrupt：${state?.interruptMode ?? "?"}`,
		() =>
			send({
				type: "session/queue-mode",
				kind: "interrupt",
				mode: state?.interruptMode === "immediate" ? "wait" : "immediate",
			}),
	);
	rows.push(el("div", "menu-sep"));
	row("在终端跑命令…", promptBash, "RPC bash：omp 进程内执行");
	row("登录状态…", openLoginPanel, "get_login_providers / login");
	openOverlay("session", [el("div", "panel-title", "会话控制"), ...rows]);
}

/** Rename one instance by id: a list row renames without having to select that session. */
function promptRenameSession(id: string, current: string): void {
	const input = el("input", "panel-input") as HTMLInputElement;
	input.placeholder = current || "会话名称";
	const children: HTMLElement[] = [
		el("div", "panel-title", "重命名会话"),
		input,
		button("保存", "panel-row primary", () => {
			const name = input.value.trim();
			if (name) send({ type: "session/rename", id, name });
			closeOverlay();
		}),
		button("关闭", "chip", closeOverlay),
	];
	openOverlay("session", children);
	input.focus();
}

function promptCompact(): void {
	const input = el("input", "panel-input") as HTMLInputElement;
	input.placeholder = "压缩指令（可留空）";
	const children: HTMLElement[] = [
		el("div", "panel-title", "手动压缩上下文"),
		input,
		button("压缩", "panel-row primary", () => {
			send({ type: "session/compact", instructions: input.value.trim() || undefined });
			closeOverlay();
		}),
		button("关闭", "chip", closeOverlay),
	];
	openOverlay("session", children);
	input.focus();
}

function promptBash(): void {
	const input = el("input", "panel-input") as HTMLInputElement;
	input.placeholder = "要在 omp 会话里执行的命令";
	const children: HTMLElement[] = [
		el("div", "panel-title", "RPC bash"),
		el("div", "muted small", "在 omp 进程内执行（工作目录 = 会话 cwd），完成后结果走通知。"),
		input,
		button("执行", "panel-row primary", () => {
			const command = input.value.trim();
			if (command) send({ type: "session/bash", command });
			closeOverlay();
		}),
		button("关闭", "chip", closeOverlay),
	];
	openOverlay("session", children);
	input.focus();
}

function openSwitchSessionPicker(): void {
	send({ type: "history/refresh" });
	pendingPanel = "switch";
	// The `history` reply opens the right panel (`pendingPanel` decides which one).
}

function openBranchPicker(): void {
	if (!view.id) return;
	pendingPanel = "branch";
	send({ type: "session/branch-points" });
}

function openStatsPanel(): void {
	if (!view.id) return;
	pendingPanel = "stats";
	send({ type: "session/stats" });
}

function openLoginPanel(): void {
	pendingPanel = "login";
	send({ type: "login/refresh" });
}

/** Which panel the next async host reply should render. */
let pendingPanel: "switch" | "branch" | "stats" | "login" | undefined;

function renderStatsPanel(stats: SessionStatsView | null): void {
	const children: HTMLElement[] = [el("div", "panel-title", "会话统计")];
	if (!stats) {
		children.push(el("div", "muted", "还没有统计数据（发一轮消息后再试）"));
	} else {
		const grid = el("div", "stats-grid");
		const stat = (label: string, value?: number | string) => {
			if (value === undefined) return;
			grid.append(el("div", "stat", `${label}`), el("div", "stat-value", String(value)));
		};
		stat("用户消息", stats.userMessages);
		stat("助手消息", stats.assistantMessages);
		stat("工具调用", stats.toolCalls);
		stat("总消息", stats.totalMessages);
		stat("tokens（输入）", stats.tokens?.input);
		stat("tokens（输出）", stats.tokens?.output);
		stat("tokens（缓存读）", stats.tokens?.cacheRead);
		stat("tokens（总计）", stats.tokens?.total);
		stat("费用", stats.cost !== undefined ? `$${stats.cost.toFixed(4)}` : undefined);
		stat("上下文 %", stats.contextUsage?.percent !== undefined ? `${Math.round(stats.contextUsage.percent)}%` : undefined);
		children.push(grid);
	}
	children.push(button("刷新", "chip", () => send({ type: "session/stats" })));
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("stats", children);
}

function renderBranchPoints(points: BranchPointView[]): void {
	const children: HTMLElement[] = [el("div", "panel-title", "从分支点分叉新会话")];
	if (points.length === 0) children.push(el("div", "muted", "当前会话没有可分叉的历史条目"));
	for (const point of points) {
		const entryId = point.entryId;
		if (!entryId) continue;
		const preview = (point.text ?? "").slice(0, 80).replace(/\s+/g, " ");
		const row = button(preview || entryId, "panel-row", () => {
			send({ type: "session/branch", entryId });
			closeOverlay();
		});
		row.title = entryId;
		children.push(row);
	}
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("branch", children);
}

function renderLoginPanel(providers: LoginProviderView[]): void {
	const children: HTMLElement[] = [el("div", "panel-title", "登录状态")];
	if (providers.length === 0) children.push(el("div", "muted", "omp 没有报告任何登录提供方"));
	for (const provider of providers) {
		const row = el("div", "panel-row login-row");
		row.append(
			el("span", "login-name", provider.name ?? provider.id),
			el("span", provider.authenticated ? "ok-dot" : "muted small", provider.authenticated ? "已登录" : "未登录"),
		);
		if (!provider.authenticated) {
			const login = button("登录", "chip", () => send({ type: "login/start", providerId: provider.id }));
			login.disabled = provider.available === false;
			row.append(el("span", "spacer"), login);
		}
		children.push(row);
	}
	children.push(button("刷新", "chip", () => send({ type: "login/refresh" })));
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("login", children);
}

function renderHostToolCall(request: HostToolCallView): void {
	const children: HTMLElement[] = [
		el("div", "panel-title", `宿主工具调用：${request.toolName}`),
		el("pre", "summary", JSON.stringify(request.arguments, null, 2)),
	];
	const text = el("input", "panel-input") as HTMLInputElement;
	text.placeholder = "返回给 agent 的文本结果";
	children.push(
		text,
		button("返回结果", "panel-row primary", () => {
			send({
				type: "host/tool-respond",
				id: request.id,
				result: { content: [{ type: "text", text: text.value }] },
			});
			closeOverlay();
		}),
		button("返回错误", "panel-row", () => {
			send({
				type: "host/tool-respond",
				id: request.id,
				result: { content: [{ type: "text", text: text.value || "宿主工具执行失败" }], isError: true },
			});
			closeOverlay();
		}),
	);
	openOverlay("ui", children);
}

function renderHostUriRequest(id: string, operation: "read" | "write", url: string, content?: string): void {
	if (operation === "read") {
		// Built-in scheme: editor files. Anything else needs an explicit answer.
		const children: HTMLElement[] = [
			el("div", "panel-title", `宿主 URI 读取：${url}`),
			el("div", "muted small", "允许 omp 读取这个 URI 吗？内容会原样返回。"),
		];
		const area = el("textarea", "panel-input") as HTMLTextAreaElement;
		area.rows = 6;
		area.placeholder = "留空 = 拒绝（返回错误）";
		children.push(
			area,
			button("允许并返回内容", "panel-row primary", () => {
				send({ type: "host/uri-respond", id, result: { content: area.value, contentType: "text/plain" } });
				closeOverlay();
			}),
			button("拒绝", "panel-row", () => {
				send({ type: "host/uri-respond", id, result: { isError: true, error: "用户拒绝了宿主 URI 读取" } });
				closeOverlay();
			}),
		);
		openOverlay("ui", children);
		return;
	}
	const area = el("textarea", "panel-input") as HTMLTextAreaElement;
	area.rows = 6;
	area.value = content ?? "";
	const children: HTMLElement[] = [
		el("div", "panel-title", `宿主 URI 写入：${url}`),
		area,
		button("允许写入", "panel-row primary", () => {
			send({ type: "host/uri-respond", id, result: {} });
			closeOverlay();
		}),
		button("拒绝", "panel-row", () => {
			send({ type: "host/uri-respond", id, result: { isError: true, error: "用户拒绝了宿主 URI 写入" } });
			closeOverlay();
		}),
	];
	openOverlay("ui", children);
}

// ---------------------------------------------------------------------------
// Dictation (speech -> text) via the Web Speech API when the webview offers it
// ---------------------------------------------------------------------------

type SpeechRecognitionLike = {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	start(): void;
	stop(): void;
	onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
	onend: (() => void) | null;
	onerror: (() => void) | null;
};

let recognition: SpeechRecognitionLike | undefined;
let dictating = false;

function speechCtor(): (new () => SpeechRecognitionLike) | undefined {
	const scope = window as unknown as Record<string, unknown>;
	return (scope.SpeechRecognition ?? scope.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}

function toggleDictation(): void {
	const ctor = speechCtor();
	if (!ctor) {
		toast("此 webview 不支持语音识别（Speech API 不可用）", "warn");
		return;
	}
	if (dictating) {
		recognition?.stop();
		return;
	}
	recognition = new ctor();
	recognition.lang = navigator.language || "zh-CN";
	recognition.continuous = true;
	recognition.interimResults = false;
	recognition.onresult = (event) => {
		let text = "";
		for (let index = 0; index < event.results.length; index += 1) {
			const alternative = event.results[index]?.[0];
			if (alternative) text += alternative.transcript;
		}
		if (text.trim()) promptInput.value = text;
	};
	recognition.onend = () => {
		dictating = false;
		renderComposerBar();
	};
	recognition.onerror = recognition.onend;
	dictating = true;
	recognition.start();
	renderComposerBar();
}

/**
 * Slash-command and @file completion popup above the composer. `@path` inserts
 * text only — the agent reads the file itself.
 *
 * `/` has two real-omp sources: a live session reports its own list over the handshake,
 * while the blank page has no instance to ask, so the host probes one for the list a *new*
 * session would start with. `@` files are the workspace's — the same set on either composer.
 */
function renderCommandHint(): void {
	const commands = view.page === "sessions" ? view.newSession?.commands ?? [] : view.commands;
	view.completions = computeCompletions(promptInput.value, commands, view.workspaceFiles);
	paintCompletions();
}

/**
 * Paint the option list the popup already holds. Moving the selection must not
 * recompute it: `computeCompletions` starts every list at index 0, so recomputing
 * on arrow keys snapped the highlight back to the first row.
 */
function paintCompletions(): void {
	const completions = view.completions;
	commandHint.replaceChildren();
	commandHint.classList.toggle("hidden", !completions);
	if (!completions) return;
	completions.options.forEach((option, index) => {
		const row = button(option.label, "command-row", () => {
			acceptCompletion(option);
		});
		if (option.description) row.append(el("span", "muted small", option.description));
		if (index === completions.active) row.classList.add("active");
		commandHint.append(row);
	});
	// The list scrolls (`max-height`); an off-screen selection would be invisible.
	commandHint.children[completions.active]?.scrollIntoView({ block: "nearest" });
}

function acceptCompletion(option: { value: string }): void {
	promptInput.value = option.value;
	promptInput.focus();
	renderCommandHint();
}

function moveCompletionActive(offset: number): boolean {
	const completions = view.completions;
	if (!completions || commandHint.classList.contains("hidden")) return false;
	completions.active = cycleActive(completions.active, completions.options.length, offset);
	paintCompletions();
	return true;
}

function acceptActiveCompletion(): boolean {
	const completions = view.completions;
	if (!completions || commandHint.classList.contains("hidden")) return false;
	acceptCompletion(completions.options[completions.active] ?? completions.options[0]);
	return true;
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
	if (POPUP_KINDS[overlayKind]) {
		// Popups live on document.body, not in the overlay sheet.
		menuDisarm?.();
		menuDisarm = undefined;
		document.querySelectorAll(".menu").forEach((node) => node.remove());
	} else if (overlayKind === "ui") {
		// The docked question panel: hand the composer back exactly as it was left -
		// the textarea keeps its draft, attachments and queue cards come back untouched.
		uiDock.classList.add("hidden");
		uiDock.replaceChildren();
		composerInner.classList.remove("hidden");
	} else {
		overlay.classList.add("hidden");
		overlay.replaceChildren();
	}
	overlayKind = "none";
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
	if (overlayKind === "model") openModelMenu(false);
}

/**
 * switch_session picker: same history list, but the rows point the current
 * instance's process at that jsonl instead of opening a new instance.
 */
function openSwitchPanel(): void {
	const children: HTMLElement[] = [el("div", "panel-title", "切换到历史会话（当前 Tab）")];
	if (view.history.length === 0) children.push(el("div", "muted", "没有找到会话文件"));
	for (const entry of view.history) {
		const isCurrent = view.state?.sessionFile === entry.file;
		const row = button(entry.title + (isCurrent ? "（当前）" : ""), "panel-row", () => {
			if (isCurrent) return;
			send({ type: "session/switch", sessionPath: entry.file });
			closeOverlay();
		});
		row.disabled = isCurrent;
		row.title = entry.file;
		row.append(el("span", "muted small", historyMeta(entry)));
		children.push(row);
	}
	children.push(button("关闭", "chip", closeOverlay));
	openOverlay("switch", children);
}

/** `Plan · 09-21 20:11`: enough to tell two session files apart in a picker or a row. */
function historyMeta(entry: { mode: string; updatedAt: number }): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const date = new Date(entry.updatedAt);
	const when = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const mode = entry.mode ? MODE_LABELS[entry.mode] ?? entry.mode : "";
	return mode ? `${mode} · ${when}` : when;
}

/**
 * omp's own label for a row, where reading it verbatim would be worse than useless.
 * These are display text only: what goes back on the wire is always `option.value`.
 */
const CHOICE_ROLE_LABELS: Partial<Record<ChoiceOptionView["role"], string>> = {
	other: "自己输入…",
	done: "完成选择",
};

/**
 * omp's interactive request as a panel (dev-plan §2.5). The rows *are* the protocol:
 * an answer is the row's own value, echoed verbatim, and the panel is redrawn from
 * whatever omp asks next - one round per pick while the model collects a multi-select,
 * then an `editor` for the free-form escape hatch. Nothing is inferred locally, so the
 * panel cannot disagree with the terminal omp is drawing in parallel.
 *
 * A `select` has two shapes and each is drawn the way its answer works: a single
 * question answers on the first pick (radio), while a multi-select keeps collecting
 * toggles (checkbox) until its commit row - which the panel lifts out of the list into
 * a primary button, because a "done" buried among the options is exactly what a user
 * misses when a question looks stuck.
 *
 * Not a modal: the panel docks where the composer was, `composerInner` hides behind it
 * while it is up. The transcript above stays scrollable, and whatever the user had typed
 * stays in the textarea - hiding the composer never touches its content.
 */
function openApproval(request: UIRequestView): void {
	// Anything already up (a model menu, the previous round's panel) gives way; a `ui`
	// close also restores the composer, which the dock below hides again.
	closeOverlay();
	answeredRequestId = undefined;
	const children: HTMLElement[] = [];
	const head = el("div", "panel-head");
	head.append(el("span", "panel-title", request.method === "confirm" ? "omp 请求审批" : "omp 提问"));
	if (request.progress) {
		head.append(el("span", "ui-progress", `第 ${request.progress.index}/${request.progress.total} 题`));
	}
	children.push(head);
	if (request.title) children.push(el("div", "ui-question", request.title));
	if (request.message) children.push(el("div", "panel-message", request.message));

	// One answer per round: a second response for the same request id makes omp clear
	// the multi-select it was collecting and ask the same question again (dev-plan §2.5).
	const waiting = el("div", "ui-waiting hidden", "已提交，等待 omp 的下一步…");
	const answer = (response: ExtensionUIResponse) => {
		if (answeredRequestId === request.id) return;
		answeredRequestId = request.id;
		send({ type: "ui/respond", response });
		// Deliberately still open: omp re-asks within milliseconds while one question is
		// being collected, and the host closes the panel when the exchange is over.
		uiDock.classList.add("submitted");
		waiting.classList.remove("hidden");
	};
	const cancel = () => answer({ type: "extension_ui_response", id: request.id, cancelled: true });
	/** A single question is answered: freeze the list so what is on screen is what was sent. */
	const lockChoices = (chosen: string) => {
		for (const row of uiDock.querySelectorAll<HTMLButtonElement>(".choice")) {
			row.disabled = true;
			if (row.dataset.value === chosen) row.classList.add("chosen");
		}
	};

	if (request.method === "select") {
		const options = request.options ?? [];
		const selected = request.selected ?? [];
		// The commit row is what tells a multi-select from a single question; omp adds it
		// from the first pick onwards, so a multi-select's opening round looks like any
		// other list and its first pick is answered the way a single question's is.
		const commit = options.find((option) => option.role === "done");
		const multi = commit !== undefined;
		const pick = (option: ChoiceOptionView) => {
			answer({ type: "extension_ui_response", id: request.id, value: option.value });
			if (!multi) lockChoices(option.value);
		};
		if (multi) {
			children.push(
				el(
					"div",
					"ui-hint",
					selected.length > 0 ? `已选 ${selected.length} 项，可继续勾选，或直接提交` : "可多选：勾选想要的项，再点「完成选择」",
				),
			);
		}
		const list = el("div", "choice-list");
		for (const option of options) {
			// The commit row is a footer button, never a row among the answers.
			if (option.role === "done") continue;
			const checked = selected.includes(option.value);
			const row = button("", `choice choice-${option.role}`, () => pick(option));
			row.dataset.value = option.value;
			if (checked) row.classList.add("checked");
			if (multi) {
				row.setAttribute("role", "checkbox");
				row.setAttribute("aria-checked", String(checked));
				row.append(el("span", "choice-mark", checked ? "✓" : ""));
			} else {
				row.setAttribute("role", "radio");
				row.append(el("span", "choice-mark choice-dot"));
			}
			const body = el("span", "choice-body");
			body.append(el("span", "choice-label", CHOICE_ROLE_LABELS[option.role] ?? option.label));
			if (option.description) body.append(el("span", "choice-desc", option.description));
			row.append(body);
			if (option.recommended) row.append(el("span", "choice-tag", "推荐"));
			// The translated rows still have to be recognisable against the terminal.
			if (CHOICE_ROLE_LABELS[option.role]) row.title = option.value;
			list.append(row);
		}
		children.push(list);
		if (commit) {
			children.push(
				button(
					selected.length > 0 ? `完成选择（已选 ${selected.length} 项）` : "完成选择",
					"panel-row primary choice-commit",
					() => pick(commit),
				),
			);
		}
	} else if (request.method === "confirm") {
		children.push(
			button("允许", "panel-row primary", () =>
				answer({ type: "extension_ui_response", id: request.id, confirmed: true }),
			),
			button("拒绝", "panel-row", () =>
				answer({ type: "extension_ui_response", id: request.id, confirmed: false }),
			),
		);
	} else if (request.method === "input") {
		const input = el("input", "panel-input");
		input.placeholder = request.placeholder ?? "";
		const submit = () => answer({ type: "extension_ui_response", id: request.id, value: input.value });
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !isComposing(event)) submit();
		});
		children.push(input, button("提交", "panel-row primary", submit));
	} else {
		const area = el("textarea", "panel-input");
		area.rows = request.message ? 6 : 10;
		area.value = request.prefill ?? "";
		children.push(
			area,
			button("提交", "panel-row primary", () =>
				answer({ type: "extension_ui_response", id: request.id, value: area.value }),
			),
		);
	}

	if (request.timeoutMs) {
		children.push(el("div", "muted small", `omp 超时 ${Math.round(request.timeoutMs / 1000)}s 后会自行按默认处理`));
	}
	children.push(waiting, button("取消", "chip", cancel));
	// Dock, not modal: hide the whole input area (queued cards, attachments, textarea, bar,
	// footer) and draw the panel in its place. The transcript above keeps scrolling.
	composerInner.classList.add("hidden");
	uiDock.classList.remove("hidden");
	const panel = el("div", "panel ui-panel");
	panel.append(...children);
	uiDock.replaceChildren(panel);
	overlayKind = "ui";
	// A re-ask for the same exchange is a redraw, not a fresh mount: the submitted dim
	// must not carry over, and a hidden re-ask must not re-hide the composer.
	uiDock.classList.remove("submitted");
	bindChoiceKeys(request, cancel);
}

/**
 * Arrow keys walk the rows, digits pick one, Escape cancels. The rows are real buttons,
 * so Tab and Enter work on their own; this adds only what a keyboard user expects here.
 */
function bindChoiceKeys(request: UIRequestView, cancel: () => void): void {
	const panel = uiDock.querySelector<HTMLElement>(".panel");
	if (!panel) return;
	panel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			cancel();
			return;
		}
		// Digits are content in a text field; arrows still move the caret there.
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		const rows = [...panel.querySelectorAll<HTMLElement>(".choice")];
		if (rows.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			const current = rows.indexOf(document.activeElement as HTMLElement);
			const next = current < 0 ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
			rows[next]?.focus();
			return;
		}
		const digit = Number(event.key);
		if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(9, rows.length)) {
			event.preventDefault();
			rows[digit - 1]?.click();
		}
	});
	// A question that needs typing starts in its field; row lists stay unfocused so a
	// stray Enter cannot answer an approval nobody read.
	if (request.method === "input" || request.method === "editor") {
		panel.querySelector<HTMLElement>(".panel-input")?.focus();
	}
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

function renderFailure(state: InstanceState): void {
	composer.classList.add("hidden");
	streamColumn.replaceChildren();
	const panel = el("div", "hero failure");
	panel.append(el("h2", undefined, "这个会话的 omp 已停止"));
	panel.append(el("pre", "summary", state.failure ?? "进程已退出"));
	panel.append(el("p", "muted", `工作区：${state.cwd}`));
	panel.append(button("关闭会话", "chip", () => send({ type: "tab/close", id: view.id ?? "" })));
	panel.append(button("回到空白页", "primary", () => openSessionsPage()));
	streamColumn.append(panel);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case "list/prefs": {
			applyPrefs(message.prefs);
			renderSessionList();
			return;
		}
		case "session": {
			const empty = message.id === undefined;
			const previousId = view.id;
			const idChanged = applySession(view, message);
			if (empty) {
				// No instance left: the blank chat area is the only honest page, and it must
				// not repaint the closed transcript.
				view.page = "sessions";
				enteringSession = false;
				clearSessionElements();
			} else if (enteringSession) {
				enteringSession = false;
				view.page = "session";
			} else if (view.page === "session" && idChanged && previousId !== undefined) {
				// The instance being read is gone (closed / replaced). Never swap another
				// conversation underneath the user: go back to the list.
				view.page = "sessions";
				clearSessionElements();
			}
			// Which row is the chat's: the panel draws that from `view.id`, so the list is
			// rebuilt whenever the selection moves.
			if (idChanged) renderSessionList();
			if (idChanged || empty) {
				// Attachments are composer-scoped; they must not leak across sessions. The
				// typed text stays, so the popup is recomputed from this page's `/` source.
				view.attachments = [];
				renderCommandHint();
				renderAttachments();
			}
			if (empty) {
				renderBody();
				return;
			}
			if (overlayKind === "model") {
				if (idChanged) closeOverlay();
				else openModelMenu(false);
			}
			renderBody();
			return;
		}
		case "tabs":
			applyTabs(view, message);
			if (message.activeId === undefined) {
				// Defensive: the last instance closing must reach the blank page even if the
				// empty `session` snapshot was lost.
				view.page = "sessions";
				enteringSession = false;
				clearSessionElements();
				// The `/` list belonged to the instance that just closed; the blank page has its own.
				renderCommandHint();
				renderBody();
			}
			// The panel shows this message's rows whatever the chat area is showing, so the
			// list is rebuilt here rather than from `renderBody`.
			renderSessionList();
			// The chat area only reads the row title from `tabs`: a full renderBody here
			// rebuilt the whole transcript on every state tick (host emits `tabs` alongside
			// each `state`), which was the freeze when a queued send landed mid-stream.
			if (view.page === "session" && view.state) renderDetailHeader(view.state);
			return;
		case "items":
			// A transcript only paints the chat; the panel and a stacked layer own their areas.
			if (applyItems(view, message) && view.page === "session" && view.stack.length <= 1) {
				// Only the changed rows: a streaming tick upserts one item, so rebuilding the
				// whole column (and re-running markdown over every old row) was the lag.
				renderItems(message.items);
			}
			return;
		case "itemsRemoved":
			if (applyItemsRemoved(view, message)) removeItems(message.keys);
			return;
		case "state": {
			if (message.id !== view.id) return;
			const previous = view.state;
			view.state = message.state;
			// `state` rides every streaming tick; a full renderBody here would rebuild the
			// whole transcript each time (the old lag). Only state-driven chrome needs a pass:
			// phase flips and failure swap the body, everything else is composer chrome.
			if (!previous || previous.state !== message.state.state || previous.failure !== message.state.failure) {
				renderBody();
			} else if (view.page === "session") {
				renderComposerChrome();
			}
			return;
		}
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
		case "new-session":
			// The blank composer's defaults + catalog + `/` list. A refresh must not close a menu
			// the user still has open, so the picker re-renders in place with the new rows.
			view.newSession = message.view;
			renderComposerBar();
			// A `/` typed before the probe answered must light up now, like a live list does.
			renderCommandHint();
			if (overlayKind === "model" && view.page === "sessions") openModelMenu(false);
			return;
		case "attachments/added":
			// Picked for whichever composer is showing: on the list page they ride the next
			// session, and the host only knows which tab is active (there may be none).
			if (view.page === "session" && message.id !== view.id) return;
			view.attachments = view.attachments.concat(message.attachments);
			renderAttachments();
			return;
		case "workspace/files":
			view.workspaceFiles = message.files;
			renderCommandHint();
			return;
		case "history":
			view.history = message.entries;
			if (pendingPanel === "switch") {
				pendingPanel = undefined;
				openSwitchPanel();
				return;
			}
			renderSessionList();
			renderBody();
			return;
		case "sessions/enter":
			// Titlebar 新建会话: the host just created a blank instance and selected it.
			// Enter its detail page so the next send rides `prompt/send` on THAT instance
			// instead of `session/create-and-send` spawning a second one.
			setPanelOpen(true);
			if (view.id !== undefined) {
				view.page = "session";
				renderSessionList();
				renderBody();
			} else {
				openSessionsPage();
			}
			return;
		case "history/open":
			openSessionsPage();
			focusSearch();
			return;
		case "session-menu/open":
			openSessionMenu();
			return;
		case "session/stats":
			if (message.id !== view.id) return;
			if (pendingPanel === "stats") pendingPanel = undefined;
			renderStatsPanel(message.stats);
			return;
		case "session/branch-points":
			if (message.id !== view.id) return;
			if (pendingPanel === "branch") pendingPanel = undefined;
			renderBranchPoints(message.points);
			return;
		case "login/providers":
			if (pendingPanel === "login") pendingPanel = undefined;
			renderLoginPanel(message.providers);
			return;
		case "host/tool-call":
			if (message.id !== view.id) return;
			renderHostToolCall(message.request);
			return;
		case "host/uri-request":
			if (message.id !== view.id) return;
			renderHostUriRequest(message.id, message.operation, message.url, message.content);
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

/**
 * Cmd/Ctrl+V with an image on the clipboard attaches it. Images win over the
 * clipboard's text, which is how omp's own paste behaves; anything that is not an
 * accepted image format falls through to the browser's ordinary paste.
 */
promptInput.addEventListener("paste", (event) => {
	const files = clipboardImages(event.clipboardData);
	if (files.length === 0) return;
	event.preventDefault();
	void addPastedImages(files);
});

promptInput.addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		if (moveCompletionActive(event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
		return;
	}
	if (event.key === "Tab") {
		if (acceptActiveCompletion()) event.preventDefault();
		return;
	}
	if (event.key === "Enter" && !event.shiftKey && !isComposing(event)) {
		event.preventDefault();
		// A visible popup means Enter confirms the highlighted row, not a send: the
		// accepted value ends the token (trailing space), so the next Enter sends.
		if (acceptActiveCompletion()) return;
		submitPrompt();
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		if (view.completions) {
			view.completions = undefined;
			paintCompletions();
			return;
		}
		if (overlayKind !== "none") closeOverlay();
		else if (dictating) recognition?.stop();
		else abortPrompt();
	}
});
promptInput.focus();

// Panel chrome first: the two switches decide how much width the chat area gets, and the list
// is the only thing to show before the host answers `ready`. Then the chat area (blank page,
// or a surviving failure panel).
setPanelOpen(panelOpen);
setSearchOpen(false, false);
renderSessionList();
renderBody();
send({ type: "ready" });
