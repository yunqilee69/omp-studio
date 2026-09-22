/**
 * The single host <-> webview protocol.
 *
 * Both sides import these types; no `any` crosses the boundary. Item shapes are
 * also the transcript model the host keeps, so a webview re-render is just the
 * host's current `Item[]`.
 */
import type { ExtensionUIResponse, ThinkingLevel, SteeringMode, InterruptMode, TodoPhaseInput } from "../rpc/types";
import type { ModelCatalogEntry, ModelDraft, ProviderDraft } from "./model-drafts";

export type ItemKind = "user" | "assistant" | "tool" | "notice" | "command";

export interface UserItem {
	kind: "user";
	key: string;
	text: string;
}

export interface AssistantItem {
	kind: "assistant";
	key: string;
	text: string;
	thinking: string;
	streaming: boolean;
	model?: string;
	error?: string;
	/**
	 * Wall-clock milliseconds this turn spent thinking, timed by the host from the
	 * previous message settling to the end of the thinking stream (omp emits the
	 * assistant frame at the first token, so the wait before it counts). Absent for
	 * a turn read back from history: only a live stream can time it, and a made-up
	 * number would be a lie.
	 */
	thinkingMs?: number;
}

export type ToolStatus = "running" | "ok" | "error" | "unknown";

export interface ToolItem {
	kind: "tool";
	key: string;
	toolCallId: string;
	name: string;
	intent?: string;
	status: ToolStatus;
	/** Short result preview. */
	summary?: string;
	/** Latest streaming progress line. */
	progress?: string;
	/** Paths the tool reported (edit/write/read) for "open in editor". */
	files: string[];
	/** Subagent id when this tool call spawned one. */
	subagentId?: string;
	/** The one file the row names (read/write/edit/grep/glob). */
	path?: string;
	/** Lines added: from omp's `details.diff` for edit, from the written content for write. */
	added?: number;
	/** Lines removed, from `details.diff`. */
	removed?: number;
	/** bash command line, exactly as omp received it. */
	command?: string;
	/** First line of a failed call's output, for the row's red suffix. */
	errorText?: string;
	/** Runtime omp reported for the call (`details.wallTimeMs`). */
	durationMs?: number;
}

export interface NoticeItem {
	kind: "notice";
	key: string;
	text: string;
	level: "info" | "warn" | "error";
}

export interface CommandItem {
	kind: "command";
	key: string;
	text: string;
}

export type Item = UserItem | AssistantItem | ToolItem | NoticeItem | CommandItem;

export interface TabSummary {
	id: string;
	title: string;
	running: boolean;
	busy: boolean;
	failed: boolean;
	unread: boolean;
	mode: string;
	sessionFile?: string;
}

export interface InstanceState {
	/** Actual mode reported by omp or by the session file (`mode_change` entry). */
	mode: string;
	/** Why the mode cannot be changed here, when that applies (see docs/upstream-issues.md U2). */
	modeNote?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: ThinkingLevel;
	contextPercent?: number;
	contextWindow?: number;
	streaming: boolean;
	compacting: boolean;
	/** Local prompts waiting to be sent to omp (not omp's queuedMessageCount). */
	queued: number;
	pending: PendingPrompt[];
	state: "spawning" | "ready" | "idle" | "streaming" | "failed" | "disposing" | "gone";
	failure?: string;
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	/** Plan reference recorded by the last `mode_change` entry, when there is one. */
	planFile?: string;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
	steeringMode?: SteeringMode;
	followUpMode?: SteeringMode;
	interruptMode?: InterruptMode;
	autoCompactionEnabled?: boolean;
	autoRetryEnabled?: boolean;
	todoPhases: TodoPhaseInput[];
	goal?: string;
	protocol: { version: number; negotiated: boolean; serverVersion: number };
	/** True until the first `get_available_models` settles (omp may still be discovering). */
	modelsLoading?: boolean;
	/** Last `get_available_models` failure, if the list is still empty. */
	modelsError?: string;
}

export type ViewKind = "chat" | "subagent" | "plan" | "goal";

export interface ViewLayer {
	kind: ViewKind;
	title: string;
	/** Markdown for read-only layers. */
	body?: string;
	/** Small status line shown above the body. */
	status?: string;
	/** File the body came from. */
	source?: string;
	id?: string;
}

export interface ModelChoice {
	provider: string;
	id: string;
	label: string;
	contextWindow?: number;
}

export interface McpServerView {
	name: string;
	scope: "user" | "project";
	transport: string;
	enabled: boolean;
	detail: string;
	configPath: string;
}

export interface SlashCommandView {
	name: string;
	description?: string;
	group?: string;
}

export interface HistoryEntryView {
	file: string;
	title: string;
	updatedAt: number;
	mode: string;
	openTabId?: string;
}

/**
 * Why the composer's mode pill is read-only: omp 18's RPC has no `set_mode` and the
 * plan/goal/vibe switches are TUI-only (docs/upstream-issues.md U2). One string, because
 * a live tab and the new-session composer are blocked by the same gap.
 */
export const MODE_NOTE =
	"omp 18.1.2 的 RPC 没有 set_mode：模式只能在 omp 终端里切换（见 docs/upstream-issues.md U2）。";

/**
 * What the sessions-list composer offers before any instance exists: the model and
 * thinking level a new session would start with, plus the catalog to pick another
 * (dev-plan §1.3).
 */
export interface NewSessionView {
	/** `config.yml` `modelRoles.default`, i.e. what omp picks without an explicit choice. */
	model?: ModelChoice;
	/** That selector's `:thinkingLevel` suffix, else `defaultThinkingLevel`. */
	thinking?: string;
	/** Same upstream gap as a live tab; the pill is disabled while this is set. */
	modeNote: string;
	/** `omp models ls --json`: the models this machine can run. */
	models: ModelChoice[];
	/** Why the read failed, when it did. */
	error?: string;
}

export interface UIRequestView {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	options?: string[];
	optionDescriptions?: string[];
	placeholder?: string;
	/** `editor` requests carry their initial text as `prefill`. */
	prefill?: string;
	timeoutMs?: number;
}

export interface LoginProviderView {
	id: string;
	name?: string;
	available?: boolean;
	authenticated?: boolean;
}

export interface SessionStatsView {
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	toolResults?: number;
	totalMessages?: number;
	tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	premiumRequests?: number;
	cost?: number;
	contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
}

export interface HostToolCallView {
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface BranchPointView {
	entryId?: string;
	text?: string;
}

export type NoticeLevel = "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Host -> webview
// ---------------------------------------------------------------------------

export type HostMessage =
	/** Full state for one tab: sent on activation and after a transcript rebuild. */
	| { type: "session"; id: string; state: InstanceState; stack: ViewLayer[]; items: Item[]; models?: ModelChoice[]; commands?: SlashCommandView[] }
	/** No instance exists (last one closed): the webview must show the sessions list. */
	| { type: "session"; id?: undefined }
	| { type: "tabs"; tabs: TabSummary[]; activeId?: string }
	| { type: "items"; id: string; items: Item[] }
	/** Keys of items to drop from the transcript (recovered retry line). */
	| { type: "itemsRemoved"; id: string; keys: string[] }
	| { type: "state"; id: string; state: InstanceState }
	| { type: "pending"; id: string; pending: PendingPrompt[] }
	| { type: "stack"; id: string; stack: ViewLayer[] }
	| { type: "models"; id: string; models: ModelChoice[]; loading?: boolean; error?: string }
	| { type: "commands"; id: string; commands: SlashCommandView[] }
	| { type: "mcp"; servers: McpServerView[]; note?: string }
	/** Images the host picked on the webview's behalf (+ button); webview owns the list. */
	| { type: "attachments/added"; id?: string; attachments: AttachmentView[] }
	/** Login provider snapshot for the login panel. */
	| { type: "login/providers"; providers: LoginProviderView[] }
	/** Session stats for the stats panel. */
	| { type: "session/stats"; id: string; stats: SessionStatsView | null }
	/** Workspace file list for `@` completion in the composer. */
	| { type: "workspace/files"; files: string[] }
	/** Branch points of the current session (for the branch picker). */
	| { type: "session/branch-points"; id: string; points: BranchPointView[] }
	/** The agent invoked a host-registered tool; routed to the webview picker when no local handler claims it. */
	| { type: "host/tool-call"; id: string; request: HostToolCallView }
	/** The agent asked to read/write a host URI scheme. */
	| { type: "host/uri-request"; id: string; operation: "read" | "write"; url: string; content?: string }
	| { type: "ui"; id: string; request: UIRequestView | null }
	| { type: "history"; entries: HistoryEntryView[] }
	/** New-session defaults + catalog for the list composer (answer to `new-session/refresh`). */
	| { type: "new-session"; view: NewSessionView }
	/** Show the sessions list: the entry page, and where the view-titlebar commands land. */
	| { type: "sessions/open" }
	/** Show the sessions list with the history picker already open (palette's 打开历史会话). */
	| { type: "history/open" }
	/** View-titlebar gear pressed: the webview opens its session controls menu. */
	| { type: "session-menu/open" }
	| { type: "notice"; text: string; level: NoticeLevel; url?: string };

// ---------------------------------------------------------------------------
// Webview -> host
// ---------------------------------------------------------------------------

export type PromptBehavior = "steer" | "followUp";

/** An image the user attached in the composer, base64 over the webview bridge. */
export interface AttachmentView {
	name: string;
	/** Base64 payload without the `data:` prefix; sent to omp as-is. */
	data: string;
	mimeType: string;
}

export interface PendingPrompt {
	id: string;
	text: string;
}

export type WebviewMessage =
	| { type: "ready" }
	| { type: "tab/select"; id: string }
	| { type: "tab/close"; id: string }
	| { type: "tab/open-history"; file: string }
	| { type: "history/refresh" }
	/** The sessions-list composer's send: new instance, then this prompt (dev-plan §1.3). */
	| {
			type: "session/create-and-send";
			text: string;
			attachments?: AttachmentView[];
			/** Starting state of the new instance, set before the first prompt. */
			mode?: string;
			model?: { provider: string; id: string };
			thinking?: ThinkingLevel;
	  }
	/** Re-read `new-session` defaults (the list composer's pills have no instance to ask). */
	| { type: "new-session/refresh" }
	| { type: "prompt/send"; text: string; behavior?: PromptBehavior; attachments?: AttachmentView[] }
	| { type: "prompt/update"; id: string; text: string }
	| { type: "prompt/cancel"; id: string }
	| { type: "prompt/send-now"; id: string }
	| { type: "prompt/abort" }
	| { type: "model/set"; provider: string; id: string }
	| { type: "models/refresh" }
	| { type: "thinking/cycle" }
	| { type: "thinking/set"; level: ThinkingLevel }
	| { type: "mode/set"; mode: string }
	| { type: "attachments/pick" }
	| { type: "session/fast-mode"; enabled: boolean }
	| { type: "session/queue-mode"; kind: "steering" | "followUp" | "interrupt"; mode: string }
	| { type: "session/auto-compaction"; enabled: boolean }
	| { type: "session/auto-retry"; enabled: boolean }
	| { type: "session/abort-retry" }
	| { type: "session/compact"; instructions?: string }
	/** Renames any instance by id, not just the active one (a list row renames without switching). */
	| { type: "session/rename"; id: string; name: string }
	| { type: "session/new" }
	| { type: "session/switch"; sessionPath: string }
	| { type: "session/branch"; entryId: string }
	| { type: "session/branch-points" }
	| { type: "session/export-html" }
	| { type: "session/handoff"; instructions?: string }
	| { type: "session/stats" }
	| { type: "session/last-text" }
	| { type: "session/bash"; command: string }
	| { type: "login/refresh" }
	| { type: "login/start"; providerId: string }
	| { type: "todos/set"; phases: TodoPhaseInput[] }
	| {
			type: "host/tool-respond";
			id: string;
			result: {
				content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
				isError?: boolean;
			};
	  }
	| { type: "host/uri-respond"; id: string; result: { content?: string; contentType?: string; isError?: boolean; error?: string } }
	| { type: "view/open-subagent"; id: string }
	| { type: "view/open-plan" }
	| { type: "view/back" }
	| { type: "ui/respond"; response: ExtensionUIResponse }
	| { type: "mcp/refresh" }
	| { type: "mcp/toggle"; name: string; enabled: boolean }
	| { type: "mcp/open-file"; path: string }
	| { type: "workspace/files/refresh" }
	| { type: "file/open"; path: string }
	/** Copying goes through the host: the webview's own clipboard access is restricted. */
	| { type: "clipboard/write"; text: string }
	| { type: "link/open"; url: string };

export function isWebviewMessage(value: unknown): value is WebviewMessage {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { type?: unknown };
	return typeof record.type === "string";
}

// ---------------------------------------------------------------------------
// Settings page
//
// The settings page is a separate editor-area WebviewPanel, so it gets its own
// pair of unions instead of widening `HostMessage` with kinds the sidebar would
// have to ignore. Still one file: `protocol.ts` stays the only contract source.
// ---------------------------------------------------------------------------

export interface RoleAssignmentView {
	role: string;
	description: string;
	/** Raw stored selector, e.g. `OmniGate/glm-5:xhigh`. */
	selector?: string;
	provider?: string;
	modelId?: string;
	thinking?: string;
	/**
	 * False only when a *stored* selector is no longer in the catalog (model
	 * removed, credential gone). An unset role counts as resolved, so the page
	 * can flag `selector && !resolved` without special-casing empty roles.
	 */
	resolved: boolean;
	/** Thinking levels the resolved model accepts, for the level dropdown. */
	thinkingLevels: string[];
}

export interface ProviderModelView {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinking?: string[];
	input?: string[];
}

export interface ProviderView {
	id: string;
	baseUrl?: string;
	api?: string;
	/** The key value never crosses to the webview; the form only learns whether one exists. */
	hasApiKey: boolean;
	headers?: Record<string, string>;
	models: ProviderModelView[];
}

export interface SettingView {
	key: string;
	label: string;
	description: string;
	kind: "enum" | "boolean" | "string" | "array" | "record";
	value?: unknown;
	/**
	 * Allowed values for an enum. Maintained here because `omp config list --json`
	 * reports the type but not the `values` list.
	 */
	choices?: string[];
	editable: boolean;
	/** Why it is read-only, shown beside the control instead of a disabled mystery. */
	note?: string;
}

/**
 * One VS Code setting the page edits, as opposed to one of omp's (`SettingView`).
 *
 * Separate list because the writer is different: this one is `ompStudio.<key>` in VS
 * Code's own configuration, never `omp config set` (§2.7). Numbers only, because the
 * only setting here is a count.
 */
export interface HostSettingView {
	/** Key inside the `ompStudio` section, e.g. `maxInstances`. */
	key: string;
	label: string;
	description: string;
	value: number;
	minimum: number;
	maximum: number;
}

export interface SettingsPathsView {
	agentDir: string;
	configFile: string;
	modelsFile: string;
	projectConfigFile: string;
}

export interface SettingsSnapshot {
	roles: RoleAssignmentView[];
	catalog: ModelCatalogEntry[];
	providers: ProviderView[];
	settings: SettingView[];
	hostSettings: HostSettingView[];
	paths: SettingsPathsView;
	/** Set when `models.yml` exists but does not parse. */
	modelsFileError?: string;
	ompVersion?: string;
	/** Set when omp itself could not be read (missing binary, CLI error). */
	error?: string;
}

export type SettingsHostMessage =
	| { type: "snapshot"; snapshot: SettingsSnapshot }
	/** `ok` is only set when `busy` turns false: the page needs it to decide whether to close an open form or keep the typed input. */
	| { type: "busy"; busy: boolean; what?: string; ok?: boolean }
	| { type: "notice"; text: string; level: NoticeLevel; url?: string };

export type SettingsWebviewMessage =
	| { type: "ready" }
	| { type: "refresh" }
	| { type: "role/set"; role: string; selector: string | null }
	| { type: "scalar/set"; key: string; value: string | number | boolean }
	/** One of the extension's own `ompStudio.*` numbers, not one of omp's (see `scalar/set`). */
	| { type: "host-setting/set"; key: string; value: number }
	/** Creating a provider carries its first model, so one write covers both. */
	| { type: "provider/save"; originalId?: string; provider: ProviderDraft; firstModel?: ModelDraft }
	| { type: "provider/delete"; id: string }
	| { type: "model/save"; providerId: string; originalId?: string; model: ModelDraft }
	| { type: "model/delete"; providerId: string; id: string }
	| { type: "file/open"; path: string };

export function isSettingsWebviewMessage(value: unknown): value is SettingsWebviewMessage {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { type?: unknown };
	return typeof record.type === "string";
}
