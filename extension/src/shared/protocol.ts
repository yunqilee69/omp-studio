/**
 * The single host <-> webview protocol.
 *
 * Both sides import these types; no `any` crosses the boundary. Item shapes are
 * also the transcript model the host keeps, so a webview re-render is just the
 * host's current `Item[]`.
 */
import type { ExtensionUIResponse, ThinkingLevel } from "../rpc/types";

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
	/** Plan reference recorded by the last `mode_change` entry, when there is one. */
	planFile?: string;
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

export type NoticeLevel = "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Host -> webview
// ---------------------------------------------------------------------------

export type HostMessage =
	/** Full state for one tab: sent on activation and after a transcript rebuild. */
	| { type: "session"; id: string; state: InstanceState; stack: ViewLayer[]; items: Item[]; models?: ModelChoice[]; commands?: SlashCommandView[] }
	/** No tab exists (last one closed): the webview must show the hero, not a stale transcript. */
	| { type: "session"; id?: undefined }
	| { type: "tabs"; tabs: TabSummary[]; activeId?: string }
	| { type: "items"; id: string; items: Item[] }
	| { type: "state"; id: string; state: InstanceState }
	| { type: "pending"; id: string; pending: PendingPrompt[] }
	| { type: "stack"; id: string; stack: ViewLayer[] }
	| { type: "models"; id: string; models: ModelChoice[]; loading?: boolean; error?: string }
	| { type: "commands"; id: string; commands: SlashCommandView[] }
	| { type: "mcp"; servers: McpServerView[]; note?: string }
	| { type: "ui"; id: string; request: UIRequestView | null }
	| { type: "history"; entries: HistoryEntryView[] }
	| { type: "notice"; text: string; level: NoticeLevel; url?: string };

// ---------------------------------------------------------------------------
// Webview -> host
// ---------------------------------------------------------------------------

export type PromptBehavior = "steer" | "followUp";

export interface PendingPrompt {
	id: string;
	text: string;
}

export type WebviewMessage =
	| { type: "ready" }
	| { type: "tab/new" }
	| { type: "tab/select"; id: string }
	| { type: "tab/close"; id: string }
	| { type: "tab/open-history"; file: string }
	| { type: "history/refresh" }
	| { type: "prompt/send"; text: string; behavior?: PromptBehavior }
	| { type: "prompt/update"; id: string; text: string }
	| { type: "prompt/cancel"; id: string }
	| { type: "prompt/send-now"; id: string }
	| { type: "prompt/abort" }
	| { type: "model/set"; provider: string; id: string }
	| { type: "models/refresh" }
	| { type: "thinking/cycle" }
	| { type: "view/open-subagent"; id: string }
	| { type: "view/open-plan" }
	| { type: "view/back" }
	| { type: "ui/respond"; response: ExtensionUIResponse }
	| { type: "mcp/refresh" }
	| { type: "mcp/toggle"; name: string; enabled: boolean }
	| { type: "mcp/open-file"; path: string }
	| { type: "file/open"; path: string }
	| { type: "link/open"; url: string };

export function isWebviewMessage(value: unknown): value is WebviewMessage {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { type?: unknown };
	return typeof record.type === "string";
}
