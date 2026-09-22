/**
 * Frozen subset of the omp RPC wire contract.
 *
 * Aligned to: omp 18.1.2 (`omp --mode rpc`)
 * Canonical source: `omp://rpc.md` (docs/rpc.md in the oh-my-pi repo).
 * Evidence for this snapshot: docs/rpc-samples/*.jsonl, captured by
 * `node scripts/probe-rpc.mjs` against omp 18.1.2.
 *
 * When omp changes the wire format, this file is the ONLY place to touch:
 * re-run the probe, diff docs/rpc-samples/, update the types and the version
 * string below. The rest of the extension consumes these types, never raw JSON.
 */
export const RPC_ALIGNMENT = "omp 18.1.2";

/** Protocol version negotiated at startup. v2 = lossless chunked frames. */
export const PROTOCOL_VERSION = 2;

export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type StreamingBehavior = "steer" | "followUp";

export type SteeringMode = "all" | "one-at-a-time";

export type InterruptMode = "immediate" | "wait";

export interface JsonObject {
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface TextPart {
	type: "text";
	text: string;
}

export interface ThinkingPart {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

export interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	partialArgs?: string;
	streamIndex?: number;
	intent?: string;
}

/** One image on a message or a prompt; base64 payload without the `data:` prefix. */
export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export interface UnknownContentPart {
	type: string;
	[key: string]: unknown;
}

export type ContentPart = TextPart | ThinkingPart | ToolCallPart | ImagePart | UnknownContentPart;

export interface UserMessage {
	role: "user";
	content: ContentPart[];
	attribution?: string;
	timestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: ContentPart[];
	api?: string;
	provider?: string;
	model?: string;
	responseId?: string;
	stopReason?: string;
	usage?: JsonObject;
	errorMessage?: string;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName?: string;
	content: ContentPart[];
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
}

export interface OtherMessage {
	role: string;
	content?: ContentPart[];
	[key: string]: unknown;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | OtherMessage;

export function isTextPart(part: ContentPart): part is TextPart {
	return part.type === "text" && typeof (part as TextPart).text === "string";
}

export function isThinkingPart(part: ContentPart): part is ThinkingPart {
	return part.type === "thinking" && typeof (part as ThinkingPart).thinking === "string";
}

export function isToolCallPart(part: ContentPart): part is ToolCallPart {
	const candidate = part as ToolCallPart;
	return part.type === "toolCall" && typeof candidate.name === "string" && typeof candidate.id === "string";
}

/** OtherMessage also carries `role`, so the id has to be checked to narrow. */
export function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult" && typeof (message as ToolResultMessage).toolCallId === "string" && Array.isArray(message.content);
}

/** Concatenated text of a message's text parts. */
export function messageText(message: AgentMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(isTextPart).map((p) => p.text).join("");
}

/** Concatenated thinking of a message's thinking parts. */
export function messageThinking(message: AgentMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(isThinkingPart).map((p) => p.thinking).join("");
}

export function messageToolCalls(message: AgentMessage): ToolCallPart[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter(isToolCallPart);
}

export function isImagePart(part: ContentPart): part is ImagePart {
	return part.type === "image" && typeof (part as ImagePart).data === "string";
}

/** Images a message carries, in the order they were attached (a turn can hold several). */
export function messageImages(message: AgentMessage): ImagePart[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter(isImagePart);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelThinkingInfo {
	mode?: string;
	efforts?: string[];
}

export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinking?: ModelThinkingInfo;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Commands (webview host -> omp)
// ---------------------------------------------------------------------------

/** Commands this extension sends. Mirrors the public RPC reference (omp.sh/docs/rpc). */
export type RpcCommand =
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "set_subagent_subscription"; level: SubagentSubscriptionLevel }
	| {
			id?: string;
			type: "prompt";
			message: string;
			/** Image parts verified against omp 18: stored in the session and sent to the model. */
			images?: ImagePart[];
			streamingBehavior?: StreamingBehavior;
	  }
	| { id?: string; type: "steer"; message: string; images?: ImagePart[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImagePart[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImagePart[] }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	/** Upstream gap U2: omp 18 rejects this with "Unknown command"; kept so the
	 * extension probes once and degrades with a notice instead of faking a switch. */
	| { id?: string; type: "set_mode"; mode: string }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "set_steering_mode"; mode: SteeringMode }
	| { id?: string; type: "set_follow_up_mode"; mode: SteeringMode }
	| { id?: string; type: "set_interrupt_mode"; mode: InterruptMode }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_todos"; phases: TodoPhaseInput[] }
	| { id?: string; type: "set_host_tools"; tools: HostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: HostUriSchemeDefinition[] }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "handoff"; customInstructions?: string }
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" };

export type SubagentSubscriptionLevel = "off" | "progress" | "events";

// ---------------------------------------------------------------------------
// Shared input / result objects (RPC reference)
// ---------------------------------------------------------------------------

export interface TodoItemInput {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
	blocker?: string;
}

export interface TodoPhaseInput {
	name: string;
	tasks: TodoItemInput[];
}

/** A host-owned tool the agent can call; args arrive as `host_tool_call`. */
export interface HostToolDefinition {
	name: string;
	label?: string;
	description: string;
	/** JSON Schema object describing the arguments. */
	parameters: JsonObject;
	hidden?: boolean;
	loadMode?: "essential" | "discoverable";
}

export interface HostUriSchemeDefinition {
	scheme: string;
	description?: string;
	writable?: boolean;
	immutable?: boolean;
}

export interface HostToolResultPayload {
	content: Array<TextPart | ImagePart>;
	details?: unknown;
	isError?: boolean;
}

export interface BashResultData {
	output?: string;
	exitCode?: number | undefined;
	cancelled?: boolean;
	timedOut?: boolean;
	truncated?: boolean;
	totalLines?: number;
	totalBytes?: number;
	workingDir?: string;
}

export interface SessionStatsData {
	sessionFile?: string;
	sessionId?: string;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	toolResults?: number;
	totalMessages?: number;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	premiumRequests?: number;
	cost?: number;
	contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
}

export interface LoginProvidersData {
	providers?: Array<{ id: string; name?: string; available?: boolean; authenticated?: boolean }>;
}

export interface BranchMessagesData {
	messages?: Array<{ entryId?: string; text?: string }>;
}

export interface SubagentMessagesData {
	sessionFile?: string;
	fromByte?: number;
	nextByte?: number;
	reset?: boolean;
	entries?: unknown[];
	messages?: AgentMessage[];
}

export interface FastModeData {
	enabled?: boolean;
	active?: boolean;
}

export interface CycleModelData {
	model?: ModelInfo;
	thinkingLevel?: ThinkingLevel;
	isScoped?: boolean;
}

export interface ExportHtmlData {
	path?: string;
}

export interface HandoffData {
	savedPath?: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface RpcSuccess<T = unknown> {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data?: T;
}

export interface RpcFailure {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
	code?: string;
}

export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcFailure;

export interface ReadyFrame {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions: number[];
	maxFrameBytes: number;
	maxReassembledFrameBytes?: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface GetStateData {
	model?: ModelInfo;
	thinkingLevel?: ThinkingLevel;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	queuedMessageCount?: number;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
	steeringMode?: string;
	followUpMode?: string;
	interruptMode?: string;
	autoCompactionEnabled?: boolean;
	tokensPerSecond?: number | null;
	contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
	todoPhases?: { id?: string; name?: string; tasks?: { id?: string; content?: string; status?: string }[] }[];
	/** Present only when the runtime reports a mode (omp 18.1.2 does not). */
	mode?: string;
}

export interface GetMessagesPageData {
	messages?: AgentMessage[];
	totalMessages?: number;
	nextCursor?: string;
}

export interface GetAvailableModelsData {
	models: ModelInfo[];
}

export interface AvailableCommand {
	name: string;
	description?: string;
	source?: string;
	aliases?: string[];
	input?: { hint?: string };
	subcommands?: { name: string; description?: string; usage?: string }[];
}

export interface GetAvailableCommandsData {
	commands: AvailableCommand[];
}

export interface SubagentLifecyclePayload {
	id: string;
	agent?: string;
	agentSource?: string;
	parentToolCallId?: string;
	detached?: boolean;
	status?: string;
	sessionFile?: string;
	index?: number;
}

export interface SubagentProgressPayload {
	index?: number;
	agent?: string;
	agentSource?: string;
	parentToolCallId?: string;
	detached?: boolean;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	/** Nested snapshot; carries id + status the flat fields omit. */
	progress?: {
		id?: string;
		status?: string;
		agent?: string;
		task?: string;
		sessionFile?: string;
		lastIntent?: string;
		toolCount?: number;
		tokens?: number;
		contextTokens?: number;
		contextWindow?: number;
		durationMs?: number;
		cost?: number;
		resolvedModel?: string;
		recentTools?: string[];
	};
}

export interface GetSubagentsData {
	subagents?: SubagentLifecyclePayload[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AssistantMessageEventType =
	| "text_start"
	| "text_delta"
	| "text_end"
	| "thinking_start"
	| "thinking_delta"
	| "thinking_end"
	| "toolcall_start"
	| "toolcall_delta"
	| "toolcall_end";

export interface AssistantMessageEvent {
	type: AssistantMessageEventType | string;
	contentIndex?: number;
	delta?: string;
	content?: string;
	partial?: AgentMessage;
	toolCall?: ToolCallPart;
}

export interface MessageStartFrame {
	type: "message_start";
	message: AgentMessage;
}

export interface MessageUpdateFrame {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent?: AssistantMessageEvent;
}

export interface MessageEndFrame {
	type: "message_end";
	message: AgentMessage;
}

export interface TurnEndFrame {
	type: "turn_end";
	message: AgentMessage;
}

export interface AgentStartFrame {
	type: "agent_start";
	message?: AgentMessage;
}

export interface TurnStartFrame {
	type: "turn_start";
	message?: AgentMessage;
}

/** Cost telemetry omp emits per turn; this extension does not surface costs (yet). */
export interface AdvisorCostChangedFrame {
	type: "advisor_cost_changed";
	[key: string]: unknown;
}

export interface AgentEndFrame {
	type: "agent_end";
	messages?: AgentMessage[];
	/** false means maintenance/async work scheduled more turns; only !== false is terminal. */
	isTerminal?: boolean;
}

export interface ToolExecutionStartFrame {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args?: JsonObject;
	intent?: string;
}

export interface ToolExecutionUpdateFrame {
	type: "tool_execution_update";
	toolCallId: string;
	toolName?: string;
	partialResult?: { content?: ContentPart[] } | string;
}

export interface ToolExecutionEndFrame {
	type: "tool_execution_end";
	toolCallId: string;
	toolName?: string;
	result?: { content?: ContentPart[]; details?: unknown } | null;
	isError?: boolean;
}

export interface CommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface PromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked?: boolean;
}

export interface SessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId?: string;
}

export interface ConfigUpdateFrame {
	type: "config_update";
	model?: ModelInfo;
	thinkingLevel?: ThinkingLevel;
}

export interface AvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: AvailableCommand[];
}

export interface ExtensionErrorFrame {
	type: "extension_error";
	extensionPath?: string;
	event?: string;
	error?: string;
}

export interface NoticeFrame {
	type: "notice";
	text?: string;
	message?: string;
	level?: string;
	/** Emitter, when omp names one; `plan-yolo` marks its plan hand-off (docs/rpc-samples/plan-yolo.jsonl). */
	source?: string;
}

export type SubagentPayload = SubagentLifecyclePayload | SubagentProgressPayload;

export type SubagentFrame =
	| { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
	| { type: "subagent_progress"; payload: SubagentProgressPayload }
	/** Per-frame subagent events; `id` is flat here (verified in docs/rpc-samples/subagent.jsonl). */
	| { type: "subagent_event"; payload: { id?: string; event?: JsonObject } };

export interface ModelChangedFrame {
	type: "model_changed";
	model?: ModelInfo;
}

export interface ThinkingLevelChangedFrame {
	type: "thinking_level_changed";
	level?: ThinkingLevel;
}

export interface GoalUpdatedFrame {
	type: "goal_updated";
	goal?: string;
	state?: JsonObject;
}

// ---------------------------------------------------------------------------
// Session / retry / todo event frames (RPC reference: session events)
// ---------------------------------------------------------------------------

export interface AutoCompactionStartFrame {
	type: "auto_compaction_start";
	reason?: "threshold" | "overflow" | "idle" | "incomplete" | string;
	action?: "context-full" | "remote" | "handoff" | "shake" | "snapcompact" | string;
}

export interface AutoCompactionEndFrame {
	type: "auto_compaction_end";
	action?: string;
	result?: { summary?: string; shortSummary?: string; tokensBefore?: number } | null;
	aborted?: boolean;
	willRetry?: boolean;
	errorMessage?: string;
	skipped?: boolean;
}

export interface AutoRetryStartFrame {
	type: "auto_retry_start";
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	errorId?: string;
}

export interface AutoRetryEndFrame {
	type: "auto_retry_end";
	success?: boolean;
	attempt?: number;
	finalError?: string;
	retryErrors?: string[];
}

export interface RetryFallbackFrame {
	type: "retry_fallback_applied" | "retry_fallback_succeeded";
	from?: { model?: string; role?: string };
	to?: { model?: string; role?: string };
	model?: string;
}

export interface TodoReminderFrame {
	type: "todo_reminder";
	todos?: TodoItemInput[];
	attempt?: number;
	maxAttempts?: number;
}

export interface TodoAutoClearFrame {
	type: "todo_auto_clear";
}

export interface TtsrTriggeredFrame {
	type: "ttsr_triggered";
	rules?: Array<{ name?: string; scope?: string[] | string }>;
}

export interface IrcMessageFrame {
	type: "irc_message";
	message?: { customType?: string; content?: unknown; display?: string };
}

// ---------------------------------------------------------------------------
// Host tool / host URI sub-protocol (requests from omp, answered by the host)
// ---------------------------------------------------------------------------

export interface HostToolCallFrame {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments?: JsonObject;
}

export interface HostToolCancelFrame {
	type: "host_tool_cancel";
	id?: string;
	targetId?: string;
}

export interface HostUriRequestFrame {
	type: "host_uri_request";
	id: string;
	operation: "read" | "write";
	url: string;
	content?: string;
}

export interface HostUriCancelFrame {
	type: "host_uri_cancel";
	id?: string;
	targetId?: string;
}

/** A frame this extension does not model. Reported, never rendered. */
export interface UnknownFrame {
	type: string;
	[key: string]: unknown;
}

/**
 * Frame types this extension models.
 *
 * The decoder separates these from `UnknownFrame` so every consumer switch narrows
 * cleanly; unmodelled frames are reported through a callback instead of widening
 * `RpcFrame` into `{ type: string }`, which would defeat narrowing everywhere.
 */
export const KNOWN_FRAME_TYPES: Record<string, true> = {
	ready: true,
	rpc_chunk: true,
	response: true,
	extension_ui_request: true,
	message_start: true,
	message_update: true,
	message_end: true,
	agent_start: true,
	turn_start: true,
	turn_end: true,
	agent_end: true,
	advisor_cost_changed: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	command_output: true,
	prompt_result: true,
	session_info_update: true,
	config_update: true,
	available_commands_update: true,
	extension_error: true,
	notice: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	subagent_event: true,
	model_changed: true,
	thinking_level_changed: true,
	goal_updated: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	todo_reminder: true,
	todo_auto_clear: true,
	ttsr_triggered: true,
	irc_message: true,
	host_tool_call: true,
	host_tool_cancel: true,
	host_tool_update: true,
	host_tool_result: true,
	host_uri_request: true,
	host_uri_cancel: true,
	host_uri_result: true,
};

/** Frames the extension models and acts on. */
export type KnownFrame =
	| ReadyFrame
	| RpcChunkFrame
	| RpcResponse
	| MessageStartFrame
	| MessageUpdateFrame
	| MessageEndFrame
	| AgentStartFrame
	| TurnStartFrame
	| TurnEndFrame
	| AgentEndFrame
	| AdvisorCostChangedFrame
	| ToolExecutionStartFrame
	| ToolExecutionUpdateFrame
	| ToolExecutionEndFrame
	| CommandOutputFrame
	| PromptResultFrame
	| SessionInfoUpdateFrame
	| ConfigUpdateFrame
	| AvailableCommandsUpdateFrame
	| ExtensionErrorFrame
	| NoticeFrame
	| SubagentFrame
	| ModelChangedFrame
	| ThinkingLevelChangedFrame
	| GoalUpdatedFrame
	| AutoCompactionStartFrame
	| AutoCompactionEndFrame
	| AutoRetryStartFrame
	| AutoRetryEndFrame
	| RetryFallbackFrame
	| TodoReminderFrame
	| TodoAutoClearFrame
	| TtsrTriggeredFrame
	| IrcMessageFrame
	| HostToolCallFrame
	| HostToolCancelFrame
	| HostUriRequestFrame
	| HostUriCancelFrame;

/** Everything the transport can deliver, including the extension UI channel. */
export type RpcFrame = KnownFrame | ExtensionUIRequest;

// ---------------------------------------------------------------------------
// Extension UI sub-protocol
// ---------------------------------------------------------------------------

/**
 * Extension UI sub-protocol, read out of omp 18.1.2's own `ExtensionUI` adapter:
 * select answers with `value`, confirm with `confirmed`, input/editor with `value`,
 * and a timed-out request resolves inside omp (the host must not answer twice).
 * `editor` carries `prefill`, not `content`.
 */
export type ExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title?: string; message?: string; options: string[]; optionDetails?: { description?: string }[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title?: string; message?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title?: string; message?: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title?: string; prefill?: string; promptStyle?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message?: string; notifyType?: string }
	| { type: "extension_ui_request"; id: string; method: "open_url"; url?: string; launchUrl?: boolean; instructions?: string }
	/** omp tells the host to drop an outstanding modal (aborted request). */
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId?: string }
	| { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown };

export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

/** Methods that block a session until the host answers. */
export const INTERACTIVE_UI_METHODS = ["select", "confirm", "input", "editor"] as const;

export type InteractiveUIMethod = (typeof INTERACTIVE_UI_METHODS)[number];

export function isExtensionUIRequest(frame: RpcFrame): frame is ExtensionUIRequest {
	return frame.type === "extension_ui_request" && typeof (frame as { id?: unknown }).id === "string";
}

export function isInteractiveUIRequest(
	frame: ExtensionUIRequest,
): frame is Extract<ExtensionUIRequest, { method: InteractiveUIMethod }> {
	return (INTERACTIVE_UI_METHODS as readonly string[]).includes(frame.method);
}

export function isFailure(response: RpcResponse): response is RpcFailure {
	return response.success === false;
}

export function isSuccess<T>(response: RpcResponse<T>): response is RpcSuccess<T> {
	return response.success === true;
}

/** Terminal agent_end only: `isTerminal === false` means more work is scheduled. */
export function isTerminalAgentEnd(frame: RpcFrame): frame is AgentEndFrame {
	return frame.type === "agent_end" && (frame as AgentEndFrame).isTerminal !== false;
}
