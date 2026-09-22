import type { HostEnv, Logger } from "./config";
import { approvalArgs } from "./config";
import { Emitter } from "./emitter";
import { RpcClient } from "./rpc/client";
import { RpcProcess } from "./rpc/process";
import {
	PROTOCOL_VERSION,
	isFailure,
	type RpcCommand,
	type RpcResponse,
	isInteractiveUIRequest,
	isSuccess,
	isTerminalAgentEnd,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	type AvailableCommand,
	type GetAvailableCommandsData,
	type GetAvailableModelsData,
	type GetMessagesPageData,
	type GetStateData,
	type ModelInfo,
	type RpcFrame,
	type JsonObject,
	type SubagentSubscriptionLevel,
	type StreamingBehavior,
	type ThinkingLevel,
	type SteeringMode,
	type InterruptMode,
	type TodoPhaseInput,
	type SessionStatsData,
	type BashResultData,
	type FastModeData,
	type ExportHtmlData,
	type HandoffData,
	type LoginProvidersData,
	type BranchMessagesData,
	type SubagentMessagesData,
	type HostToolResultPayload,
	type HostToolDefinition,
	type HostUriSchemeDefinition,
	type HostToolCallFrame,
} from "./rpc/types";
import { readSubagentOutput, readPlanFile } from "./artifacts";
import { artifactsDir, modeLabel, readSessionMessages, readSessionSummary, titleFromText } from "./session-file";
import type { AgentMessage } from "./rpc/types";
import {
	MODE_NOTE,
	type AttachmentView,
	type InstanceState,
	type Item,
	type ModelChoice,
	type NoticeLevel,
	type SlashCommandView,
	type TabSummary,
	type UIRequestView,
	type ViewLayer,
} from "./shared/protocol";
import { catalogChoices } from "./shared/models";
import { PendingPrompts } from "./pending-prompts";
import { Transcript } from "./transcript";

export type InstancePhase = "spawning" | "ready" | "idle" | "streaming" | "failed" | "disposing" | "gone";

export interface InstanceOptions {
	id: string;
	cwd: string;
	/** Absolute jsonl path; only then does omp open an existing session. */
	resumeFile?: string;
}

export interface InstanceEvents {
	/** Items to upsert in the webview. */
	items: Item[];
	/** Keys of items removed from the transcript (recovered retry line). */
	itemsRemoved: string[];
	/** Whole transcript replaced (history load, view change). */
	transcriptReplaced: void;
	state: void;
	models: void;
	/** The slash command list (handshake RPC, or an `available_commands_update` push). */
	commands: void;
	viewStack: void;
	tabs: void;
	ui: UIRequestView | null;
	notice: { text: string; level: NoticeLevel; url?: string };
	/** The agent invoked a host-registered tool; the owner answers via respondHostTool. */
	hostTool: { id: string; toolCallId: string; toolName: string; arguments: JsonObject; known: boolean };
	/** The agent asked to read/write a host URI scheme. */
	hostUri: { id: string; operation: "read" | "write"; url: string; content?: string };
	/** A run reached a terminal agent_end. */
	runFinished: void;
	exited: { code: number | null };
}

/** Node tags ENOENT on the error object; the session file legitimately does not exist yet. */
function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const READY_TIMEOUT_MS = 30_000;
const NON_BLOCKING_UI_METHODS = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"];

/**
 * One side-panel tab: one `omp --mode rpc` process, one session jsonl, one view stack.
 *
 * State machine: spawning -> ready -> idle <-> streaming, with failed/disposing/gone
 * terminal branches. A dead process is always visible as `failed`; the tab never
 * pretends the conversation is still alive (AGENTS.md).
 */
export class Instance {
	readonly events = new Emitter<InstanceEvents>();

	readonly transcript = new Transcript();
	readonly viewStack: ViewLayer[] = [{ kind: "chat", title: "对话" }];

	private process: RpcProcess | undefined;
	private client: RpcClient | undefined;
	private phaseValue: InstancePhase = "spawning";
	private failure: string | undefined;
	private sessionFileValue: string | undefined;
	private sessionName: string | undefined;
	private modeValue = "none";
	private planFilePath: string | undefined;
	private modelValue: ModelInfo | undefined;
	private thinkingLevel: ThinkingLevel | undefined;
	private contextPercent: number | undefined;
	private contextWindow: number | undefined;
	private compacting = false;
	private streaming = false;
	private busy = false;
	private queued = 0;
	private fastModeEnabled = false;
	private fastModeActive = false;
	private steeringMode: SteeringMode | undefined;
	private followUpMode: SteeringMode | undefined;
	private interruptMode: InterruptMode | undefined;
	private autoCompactionEnabled: boolean | undefined;
	private autoRetryEnabled: boolean | undefined;
	private todoPhases: TodoPhaseInput[] = [];
	private goalText: string | undefined;
	private lastStats: SessionStatsData | undefined;
	/** Host-owned tools registered with this instance's agent. */
	private hostTools: HostToolDefinition[] = [];
	/** Host URI schemes registered with this instance's agent; kept for diagnostics. */
	protected hostUriSchemes: HostUriSchemeDefinition[] = [];
	/** Cancellation sources for in-flight host tool calls, by request id. */
	private readonly hostToolAbort = new Map<string, AbortController>();
	/** Prompts submitted while busy; dispatched to omp in order, editable until then. */
	private readonly pending = new PendingPrompts();
	private modelChoices: ModelChoice[] = [];
	/** New tabs have not asked omp yet; the picker must not claim "no models". */
	private modelsLoadingValue = true;
	private modelsErrorValue: string | undefined;
	private modelsRefresh: Promise<void> | undefined;
	private commandList: SlashCommandView[] = [];
	private readonly uiQueue: UIRequestView[] = [];
	private activeUI: UIRequestView | undefined;
	/** Rejects the startup handshake as soon as the process reports a fatal error. */
	private readyGuard: ((error: Error) => void) | undefined;
	private uiTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly env: HostEnv,
		private readonly options: InstanceOptions,
	) {
	}

	get id(): string {
		return this.options.id;
	}

	get cwd(): string {
		return this.options.cwd;
	}

	/** Child process id, for teardown assertions and diagnostics. Undefined before spawn. */
	get pid(): number | undefined {
		return this.process?.pid;
	}

	get phase(): InstancePhase {
		return this.phaseValue;
	}

	get logger(): Logger {
		return this.env.logger;
	}

	get models(): ModelChoice[] {
		return this.modelChoices;
	}

	get commands(): SlashCommandView[] {
		return this.commandList;
	}

	get currentUI(): UIRequestView | undefined {
		return this.activeUI;
	}

	get sessionFile(): string | undefined {
		return this.sessionFileValue;
	}

	get planFile(): string | undefined {
		return this.planFilePath;
	}

	/** Start the process and finish the handshake: ready -> negotiate v2 -> get_state. */
	async start(): Promise<void> {
		const args = [...approvalArgs(this.env.approvalMode)];
		if (this.options.resumeFile) args.push("--resume", this.options.resumeFile);

		let process: RpcProcess;
		try {
			process = RpcProcess.spawn({
				ompPath: this.env.ompPath,
				cwd: this.options.cwd,
				args,
				logger: this.env.logger,
			});
		} catch (error) {
			this.fail(`无法启动 omp：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.process = process;
		this.client = new RpcClient({ stdin: process.stdin, stdout: process.stdout });

		this.client.events.on("frame", (frame) => void this.onFrame(frame));
		this.client.events.on("ready", () => this.events.emit("state"));
		this.client.events.on("uiRequest", (request) => this.onUIRequest(request));
		this.client.events.on("lateResponse", (response) => {
			const message = isFailure(response) ? response.error : "unexpected extra response";
			this.notice(`omp 迟到的响应（${response.command}）：${message}`, "warn");
		});
		this.client.events.on("decodeError", (error) => this.notice(`协议解码失败：${error.message}`, "error"));
		this.client.events.on("error", (error) => this.notice(`stdio 错误：${error.message}`, "error"));
		this.client.events.on("fatal", (error) => {
			this.fail(`协议流不可恢复：${error.message}`);
			void this.terminateProcess();
		});
		process.events.on("stderr", (text) => {
			const line = text.trim();
			if (line) this.env.logger.info(`[omp ${this.options.id}] ${line}`);
		});
		process.events.on("spawnError", (error) => {
			this.fail(
				`找不到或无法执行 omp（${this.env.ompPath}）：${error.message}。安装 omp 或设置 ompStudio.ompPath。`,
			);
		});
		process.events.on("exit", ({ code }) => {
			if (this.disposed || this.phaseValue === "failed") {
				this.phaseValue = "gone";
				this.events.emit("exited", { code });
				return;
			}
			this.fail(`omp 进程退出，code=${code ?? "null"}${process.stderrTail ? `\n${process.stderrTail}` : ""}`);
			this.events.emit("exited", { code });
		});

		try {
			const state = await this.handshake();
			this.phaseValue = "ready";
			this.applyState(state);
			if (this.sessionFileValue) await this.readModeFromSession(this.sessionFileValue);
			if (this.options.resumeFile) await this.loadHistory(this.options.resumeFile);
			this.phaseValue = this.streaming ? "streaming" : "idle";
			this.ensureCurrentModelChoice();
			this.events.emit("state");
			this.events.emit("models");
			this.events.emit("tabs");
			// omp may still be discovering providers; seed the current model now
			// and let the picker hot-update when the catalog arrives.
			void this.refreshModels();
			void this.refreshCommands();
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	/** Negotiate protocol v2 (large frames must never be truncated) and read state. */
	private async handshake(): Promise<GetStateData> {
		const client = this.requireClient();
		await this.waitForReady();
		const negotiation = await client.request({ type: "negotiate_protocol", protocolVersion: PROTOCOL_VERSION });
		if (isFailure(negotiation)) {
			this.notice(`协议 v2 协商失败：${negotiation.error}（继续使用 v1 分帧）`, "warn");
		} else {
			client.markNegotiated();
		}
		const state = await client.request<GetStateData>({ type: "get_state" });
		if (isFailure(state)) throw new Error(`get_state 失败：${state.error}`);
		if (!state.data) throw new Error("get_state 没有返回数据");
		await client.request({ type: "set_subagent_subscription", level: "progress" as SubagentSubscriptionLevel });
		return state.data;
	}

	private waitForReady(): Promise<void> {
		const client = this.requireClient();
		if (client.capabilities.serverProtocolVersion > 0) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const cleanup = () => {
			clearTimeout(timer);
			subscription.dispose();
			this.readyGuard = undefined;
		};
		const subscription = client.events.on("ready", () => {
			cleanup();
			resolve();
		});
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`omp 在 ${READY_TIMEOUT_MS / 1000}s 内没有输出 ready 帧`));
		}, READY_TIMEOUT_MS);
		// A process that dies during startup must fail now, not after the watchdog.
		this.readyGuard = (error) => {
			cleanup();
			reject(error);
		};
		return promise;
	}

	// ---------------------------------------------------------------------
	// Transcript / frames
	// ---------------------------------------------------------------------

	private async onFrame(frame: RpcFrame): Promise<void> {
		const changed = this.transcript.apply(frame);
		if (changed.length > 0) this.events.emit("items", changed);
		const removed = this.transcript.takeRemovedKeys();
		if (removed.length > 0) this.events.emit("itemsRemoved", removed);

		switch (frame.type) {
			case "agent_start":
				this.streaming = true;
				this.busy = true;
				this.phaseValue = "streaming";
				this.events.emit("state");
				break;
			case "agent_end":
				// The turn just wrote the session file: mode/plan may be readable now.
				if (this.sessionFileValue) void this.readModeFromSession(this.sessionFileValue);
				if (isTerminalAgentEnd(frame)) {
					this.streaming = false;
					this.busy = false;
					this.queued = 0;
					this.phaseValue = this.phaseValue === "disposing" ? this.phaseValue : "idle";
					this.events.emit("state");
					this.events.emit("runFinished");
					// omp is authoritative for queue/context numbers after a turn.
					void this.refreshStateQuietly();
					this.drainPending();
				}
				break;
			case "prompt_result":
				this.busy = false;
				this.phaseValue = this.phaseValue === "disposing" ? this.phaseValue : "idle";
				this.events.emit("state");
				break;
			case "session_info_update":
				if (typeof frame.title === "string" && frame.title.trim()) this.sessionName = frame.title.trim();
				this.events.emit("tabs");
				break;
			case "config_update":
				if (frame.model) {
					this.modelValue = frame.model;
					this.ensureCurrentModelChoice();
				}
				if (frame.thinkingLevel) this.thinkingLevel = frame.thinkingLevel;
				this.events.emit("state");
				if (frame.model) this.events.emit("models");
				break;
			case "available_commands_update":
				// omp pushes the list itself when plugins/skills change it.
				if (Array.isArray(frame.commands)) this.setCommands(frame.commands);
				break;
			case "model_changed":
				if (frame.model) {
					this.modelValue = frame.model;
					this.ensureCurrentModelChoice();
					this.events.emit("models");
				}
				this.events.emit("state");
				break;
		case "thinking_level_changed":
			if (frame.level) this.thinkingLevel = frame.level;
			this.events.emit("state");
			break;
		case "auto_compaction_start":
			this.compacting = true;
			this.events.emit("state");
			break;
		case "auto_compaction_end":
			this.compacting = false;
			this.events.emit("state");
			if (frame.aborted || frame.errorMessage) {
				this.notice(`自动压缩未完成：${frame.errorMessage ?? "已中止"}`, "warn");
			}
			break;
		case "auto_retry_start":
		case "auto_retry_end":
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
			// Retry progress renders as one transcript line (deduped in Transcript);
			// no toast - a 10-attempt retry storm would otherwise flood popups.
			break;
		case "todo_reminder":
			if (Array.isArray(frame.todos)) this.todoPhases = [{ name: "TODO", tasks: frame.todos }];
			this.events.emit("state");
			break;
		case "todo_auto_clear":
			this.todoPhases = [];
			this.events.emit("state");
			break;
		case "ttsr_triggered":
		case "irc_message":
			// Diagnostic chatter; logged, not rendered.
			this.env.logger.info(`frame ${frame.type}: ${JSON.stringify(frame).slice(0, 300)}`);
			break;
		case "goal_updated":
			this.goalText = typeof frame.goal === "string" && frame.goal.trim() ? frame.goal.trim() : undefined;
			this.events.emit("state");
			break;
		case "host_tool_call":
			this.onHostToolCall(frame);
			break;
		case "host_tool_cancel": {
			const target = typeof frame.targetId === "string" ? frame.targetId : frame.id;
			if (target) {
				this.hostToolAbort.get(target)?.abort();
				this.hostToolAbort.delete(target);
			}
			break;
		}
		case "host_uri_request":
			this.events.emit("hostUri", {
				id: frame.id,
				operation: frame.operation,
				url: frame.url,
				content: frame.content,
			});
			break;
		case "host_uri_cancel": {
			// The host side reads this through the manager event; nothing to clean here.
			break;
		}
			default:
				break;
		}

		if (frame.type === "command_output") {
			// Slash commands answer without an agent turn; keep the toolbar honest.
			void this.refreshStateQuietly();
		}
	}

	private applyState(state: GetStateData): void {
		if (state.sessionFile) {
			this.sessionFileValue = state.sessionFile;
			void this.readModeFromSession(state.sessionFile);
		}
		if (state.sessionName) this.sessionName = state.sessionName;
		if (state.model) {
			this.modelValue = state.model;
			this.ensureCurrentModelChoice();
		}
		if (state.thinkingLevel) this.thinkingLevel = state.thinkingLevel;
		if (state.isStreaming !== undefined) this.streaming = state.isStreaming;
		if (state.isCompacting !== undefined) this.compacting = state.isCompacting;
		if (state.contextUsage?.percent !== undefined) this.contextPercent = state.contextUsage.percent;
		if (state.contextUsage?.contextWindow !== undefined) this.contextWindow = state.contextUsage.contextWindow;
		if (state.queuedMessageCount !== undefined) this.queued = state.queuedMessageCount;
		if (typeof state.mode === "string") this.modeValue = state.mode;
		if (state.fastModeEnabled !== undefined) this.fastModeEnabled = state.fastModeEnabled;
		if (state.fastModeActive !== undefined) this.fastModeActive = state.fastModeActive;
		if (typeof state.steeringMode === "string") this.steeringMode = state.steeringMode as SteeringMode;
		if (typeof state.followUpMode === "string") this.followUpMode = state.followUpMode as SteeringMode;
		if (typeof state.interruptMode === "string") this.interruptMode = state.interruptMode as InterruptMode;
		if (state.autoCompactionEnabled !== undefined) this.autoCompactionEnabled = state.autoCompactionEnabled;
		if (Array.isArray(state.todoPhases)) {
			this.todoPhases = state.todoPhases.map((phase) => ({
				name: phase.name ?? "",
				tasks: (phase.tasks ?? []).map((task) => ({
					content: task.content ?? "",
					status: (task.status ?? "pending") as TodoPhaseInput["tasks"][number]["status"],
				})),
			}));
		}
	}

	/**
	 * Mode is not part of the omp 18.1.2 RPC surface (docs/upstream-issues.md U2), so
	 * the only truthful source is what omp persisted in the session file.
	 */
	private async readModeFromSession(sessionFile: string): Promise<void> {
		try {
			const summary = await readSessionSummary(sessionFile);
			const changed = summary.mode !== this.modeValue || summary.planFilePath !== this.planFilePath;
			this.modeValue = summary.mode;
			this.planFilePath = summary.planFilePath;
			if (changed) this.events.emit("state");
		} catch (error) {
			// omp reports the session path before it writes the file; that is the
			// normal state of a brand-new tab, not a failure worth logging.
			if (isMissingFile(error)) return;
			this.env.logger.warn(`读取会话模式失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async loadHistory(sessionFile: string): Promise<void> {
		const client = this.requireClient();
		let messages: AgentMessage[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await client.request<GetMessagesPageData>({ type: "get_messages_page", cursor, limit: 256 });
			if (isFailure(page)) {
				this.notice(`读取历史失败：${page.error}，改为直接读会话文件`, "warn");
				messages = await readSessionMessages(sessionFile, 400);
				break;
			}
			const data = page.data ?? {};
			if (Array.isArray(data.messages)) messages.push(...data.messages);
			if (!data.nextCursor) {
				if (messages.length === 0) messages = await readSessionMessages(sessionFile, 400);
				break;
			}
			cursor = data.nextCursor;
		}
		this.transcript.replaceFromMessages(messages);
		if (!this.sessionName) {
			const firstUser = this.transcript.items.find((item) => item.kind === "user" && item.text.trim());
			if (firstUser && firstUser.kind === "user") this.sessionName = titleFromText(firstUser.text);
		}
		this.events.emit("transcriptReplaced");
	}

	// ---------------------------------------------------------------------
	// Conversation commands
	// ---------------------------------------------------------------------

	/** Prompt submitted while a turn runs: queued locally, still editable or cancellable. */
	enqueuePrompt(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.phaseValue === "failed" || this.phaseValue === "gone") return;
		if (!this.pending.enqueue(trimmed)) return;
		this.events.emit("state");
	}

	updatePendingPrompt(id: string, text: string): void {
		if (!this.pending.update(id, text)) return;
		this.events.emit("state");
	}

	cancelPendingPrompt(id: string): void {
		if (!this.pending.remove(id)) return;
		this.events.emit("state");
	}

	/**
	 * Send a queued prompt immediately instead of waiting for the turn to end.
	 * During streaming this rides the steer path (omp injects between tool calls,
	 * possibly interrupting the rest of the turn); once sent it is no longer editable.
	 */
	async sendPendingNow(id: string): Promise<void> {
		const entry = this.pending.items.find((candidate) => candidate.id === id);
		if (!entry) return;
		// Pull it out first: after dispatch the entry can no longer be edited or cancelled.
		this.pending.remove(id);
		this.events.emit("state");
		await this.dispatchPrompt(entry.text, "steer");
		this.drainPending();
	}

	/** Send one prompt to omp now. Returns false when the send failed or omp rejected it. */
	private async dispatchPrompt(text: string, behavior?: StreamingBehavior, images?: AttachmentView[]): Promise<boolean> {
		const trimmed = text.trim();
		if (!trimmed || !this.client || this.phaseValue === "failed" || this.phaseValue === "gone") return false;
		const effective = this.streaming || this.busy ? (behavior ?? "followUp") : undefined;
		const previousPhase = this.phaseValue;
		const wasBusy = this.busy;
		if (effective === undefined && this.phaseValue !== "disposing") {
			this.busy = true;
			this.phaseValue = "streaming";
			this.events.emit("state");
			this.events.emit("tabs");
		}
		const payload: RpcCommand = effective === undefined
			? { type: "prompt", message: trimmed }
			: { type: "prompt", message: trimmed, streamingBehavior: effective };
		if (images && images.length > 0) {
			// omp's rpc `prompt` accepts the same image parts the session model uses.
			payload.images = images.map((attachment) => ({
				type: "image" as const,
				data: attachment.data,
				mimeType: attachment.mimeType,
			}));
		}
		const response = await this.client.request(payload);
		if (isFailure(response)) {
			this.busy = wasBusy;
			this.phaseValue = previousPhase === "disposing" ? previousPhase : this.streaming ? "streaming" : "idle";
			this.notice(`发送失败：${response.error}`, "error");
			this.events.emit("state");
			this.events.emit("tabs");
			return false;
		}
		const data = isSuccess(response) ? response.data : undefined;
		const agentInvoked =
			data && typeof data === "object" && "agentInvoked" in data && typeof data.agentInvoked === "boolean"
				? data.agentInvoked
				: undefined;
		if (agentInvoked === false) {
			this.busy = false;
			this.phaseValue = this.phaseValue === "disposing" ? this.phaseValue : "idle";
		} else {
			this.busy = true;
			this.phaseValue = this.phaseValue === "disposing" ? this.phaseValue : "streaming";
			if (effective) this.queued += 1;
		}
		if (agentInvoked !== false) {
			this.sessionName ??= titleFromText(trimmed);
			// The bubble appears when the text actually left for omp, never earlier.
			const changed = this.transcript.echoUser(trimmed);
			if (changed.length > 0) this.events.emit("items", changed);
		}
		this.events.emit("state");
		this.events.emit("tabs");
		return true;
	}

	/** Idle callers dispatch now and keep draining; busy callers join the local queue. */
	async sendPrompt(text: string, _behavior?: StreamingBehavior, images?: AttachmentView[]): Promise<void> {
		if (this.streaming || this.busy) {
			this.enqueuePrompt(text);
			return;
		}
		if (await this.dispatchPrompt(text, undefined, images)) this.drainPending();
	}

	/** Send queued prompts while idle; stops when a dispatch re-opens a turn. */
	private drainPending(): void {
		while (this.pending.length > 0 && !this.streaming && !this.busy) {
			const next = this.pending.items[0];
			void this.dispatchPrompt(next.text).then((sent) => {
				if (sent) this.pending.shiftIf(next.id);
				this.drainPending();
			});
			return;
		}
	}

	async abort(): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "abort" });
		if (isFailure(response)) this.notice(`中止失败：${response.error}`, "warn");
	}

	async setModel(provider: string, id: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<ModelInfo>({ type: "set_model", provider, modelId: id });
		if (isFailure(response)) {
			this.notice(`切换模型失败：${response.error}`, "error");
			return;
		}
		if (response.data) this.modelValue = response.data;
		this.events.emit("state");
	}

	async cycleThinking(): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<{ level?: ThinkingLevel }>({ type: "cycle_thinking_level" });
		if (isFailure(response)) {
			this.notice(`切换 thinking 失败：${response.error}`, "error");
			return;
		}
		this.thinkingLevel = response.data?.level ?? this.thinkingLevel;
		this.events.emit("state");
	}

	async setThinking(level: ThinkingLevel): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_thinking_level", level });
		if (isFailure(response)) {
			this.notice(`设置 thinking 失败：${response.error}`, "error");
			return;
		}
		this.thinkingLevel = level;
		this.events.emit("state");
	}

	/**
	 * Mode switching is an upstream gap (docs/upstream-issues.md U2): omp 18's RPC
	 * has no `set_mode` and the plan/vibe/goal slash commands are TUI-only. We try
	 * `set_mode` once so a future omp works with no change here, then keep the
	 * honest readonly note instead of faking a switch.
	 */
	async setMode(mode: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_mode", mode });
		if (isFailure(response)) {
			this.notice(`omp RPC 尚不支持切换模式（${response.error}）；请在 omp 终端里用 /plan 等命令切换。`, "warn");
			return;
		}
		this.modeValue = mode;
		this.events.emit("state");
	}

	// -------------------------------------------------------------------
	// Session controls (RPC reference coverage)
	// -------------------------------------------------------------------

	async setFastMode(enabled: boolean): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<FastModeData>({ type: "set_fast_mode", enabled });
		if (isFailure(response)) {
			this.notice(`切换 fast mode 失败：${response.error}`, "error");
			return;
		}
		this.fastModeEnabled = response.data?.enabled ?? enabled;
		this.fastModeActive = response.data?.active ?? false;
		this.notice(`fast mode ${this.fastModeEnabled ? "已开启" : "已关闭"}`, "info");
		this.events.emit("state");
	}

	async setSteeringMode(mode: SteeringMode): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_steering_mode", mode });
		if (isFailure(response)) {
			this.notice(`设置 steering mode 失败：${response.error}`, "error");
			return;
		}
		this.steeringMode = mode;
		this.events.emit("state");
	}

	async setFollowUpMode(mode: SteeringMode): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_follow_up_mode", mode });
		if (isFailure(response)) {
			this.notice(`设置 follow-up mode 失败：${response.error}`, "error");
			return;
		}
		this.followUpMode = mode;
		this.events.emit("state");
	}

	async setInterruptMode(mode: InterruptMode): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_interrupt_mode", mode });
		if (isFailure(response)) {
			this.notice(`设置 interrupt mode 失败：${response.error}`, "error");
			return;
		}
		this.interruptMode = mode;
		this.events.emit("state");
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_auto_compaction", enabled });
		if (isFailure(response)) {
			this.notice(`设置自动压缩失败：${response.error}`, "error");
			return;
		}
		this.autoCompactionEnabled = enabled;
		this.notice(`自动压缩${enabled ? "已开启" : "已关闭"}`, "info");
		this.events.emit("state");
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_auto_retry", enabled });
		if (isFailure(response)) {
			this.notice(`设置自动重试失败：${response.error}`, "error");
			return;
		}
		this.autoRetryEnabled = enabled;
		this.notice(`自动重试${enabled ? "已开启" : "已关闭"}`, "info");
		this.events.emit("state");
	}

	async abortRetry(): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "abort_retry" });
		if (isFailure(response)) this.notice(`中止重试失败：${response.error}`, "warn");
	}

	async compact(customInstructions?: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<{ summary?: string; tokensBefore?: number }>({
			type: "compact",
			customInstructions,
		});
		if (isFailure(response)) {
			this.notice(`压缩失败：${response.error}`, "error");
			return;
		}
		this.notice(
			`压缩完成${response.data?.tokensBefore !== undefined ? `（原 ${response.data.tokensBefore} tokens）` : ""}`,
			"info",
		);
		void this.refreshStateQuietly();
	}

	async setTodos(phases: TodoPhaseInput[]): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_todos", phases });
		if (isFailure(response)) {
			this.notice(`写入 todos 失败：${response.error}`, "error");
			return;
		}
		this.todoPhases = phases;
		this.events.emit("state");
	}

	async renameSession(name: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "set_session_name", name });
		if (isFailure(response)) {
			this.notice(`重命名失败：${response.error}`, "error");
			return;
		}
		this.sessionName = name;
		this.events.emit("tabs");
	}

	/** Reset this tab's process to a brand-new session jsonl, keeping the process alive. */
	async newSession(): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<{ cancelled?: boolean }>({ type: "new_session" });
		if (isFailure(response)) {
			this.notice(`新建会话失败：${response.error}`, "error");
			return;
		}
		await this.afterSessionSwap("新会话已开始");
	}

	/**
	 * Point this tab's process at another session jsonl. The jsonl lock is checked
	 * before the switch so two tabs can never own the same file.
	 * Returns false when the switch was refused (lock or omp failure).
	 */
	async switchSession(sessionPath: string, lockCheck?: (path: string, selfId: string) => boolean): Promise<boolean> {
		if (!this.client) return false;
		if (lockCheck && !lockCheck(sessionPath, this.id)) {
			this.notice(`该会话已在其他 Tab 打开：${sessionPath.split("/").pop()}`, "error");
			return false;
		}
		const response = await this.client.request<{ cancelled?: boolean }>({ type: "switch_session", sessionPath });
		if (isFailure(response)) {
			this.notice(`切换会话失败：${response.error}`, "error");
			return false;
		}
		await this.afterSessionSwap(`已切换到 ${sessionPath.split("/").pop()}`);
		return true;
	}

	/** Shared tail of new_session / switch_session / handoff: reload state + history. */
	private async afterSessionSwap(noticeText: string): Promise<void> {
		this.transcript.replaceFromMessages([]);
		this.events.emit("transcriptReplaced");
		const state = await this.requestQuietly<GetStateData>({ type: "get_state" });
		if (state && isSuccess(state) && state.data) this.applyState(state.data);
		this.modeValue = "none";
		this.planFilePath = undefined;
		if (this.sessionFileValue) await this.loadHistory(this.sessionFileValue);
		this.notice(noticeText, "info");
		this.events.emit("state");
		this.events.emit("tabs");
	}

	/** Fork the session at a past entry; the transcript becomes the branched copy. */
	async branchSession(entryId: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<{ text?: string; cancelled?: boolean }>({ type: "branch", entryId });
		if (isFailure(response)) {
			this.notice(`分叉失败：${response.error}`, "error");
			return;
		}
		const state = await this.requestQuietly<GetStateData>({ type: "get_state" });
		if (state && isSuccess(state) && state.data) this.applyState(state.data);
		if (this.sessionFileValue) await this.loadHistory(this.sessionFileValue);
		this.notice(`已从 ${entryId} 分叉出新会话`, "info");
		this.events.emit("state");
		this.events.emit("tabs");
	}

	async getBranchMessages(): Promise<Array<{ entryId?: string; text?: string }>> {
		if (!this.client) return [];
		const response = await this.client.request<BranchMessagesData>({ type: "get_branch_messages" });
		if (isFailure(response)) {
			this.notice(`读取分支点失败：${response.error}`, "error");
			return [];
		}
		return response.data?.messages ?? [];
	}

	async getLastAssistantText(): Promise<string | undefined> {
		if (!this.client) return undefined;
		const response = await this.client.request<{ text?: string | null }>({ type: "get_last_assistant_text" });
		if (isFailure(response)) return undefined;
		return response.data?.text ?? undefined;
	}

	get stats(): SessionStatsData | undefined {
		return this.lastStats;
	}

	async refreshStats(): Promise<SessionStatsData | undefined> {
		if (!this.client) return undefined;
		const response = await this.client.request<SessionStatsData>({ type: "get_session_stats" });
		if (isFailure(response)) {
			this.notice(`读取统计失败：${response.error}`, "error");
			return undefined;
		}
		this.lastStats = response.data ?? undefined;
		this.events.emit("state");
		return this.lastStats;
	}

	async exportHtml(): Promise<string | undefined> {
		if (!this.client) return undefined;
		const response = await this.client.request<ExportHtmlData>({ type: "export_html" });
		if (isFailure(response)) {
			this.notice(`导出 HTML 失败：${response.error}`, "error");
			return undefined;
		}
		const path = response.data?.path;
		this.notice(`已导出：${path ?? "?"}`, "info");
		return path;
	}

	async handoff(customInstructions?: string): Promise<string | undefined> {
		if (!this.client) return undefined;
		const response = await this.client.request<HandoffData>({ type: "handoff", customInstructions });
		if (isFailure(response)) {
			this.notice(`handoff 失败：${response.error}`, "error");
			return undefined;
		}
		await this.afterSessionSwap(`handoff 完成${response.data?.savedPath ? `，摘要存于 ${response.data.savedPath}` : ""}`);
		return response.data?.savedPath;
	}

	/** Abort whatever is running and immediately start a new turn. */
	async abortAndPrompt(message: string, images?: AttachmentView[]): Promise<void> {
		if (!this.client) return;
		const payload: RpcCommand = { type: "abort_and_prompt", message };
		if (images && images.length > 0) {
			payload.images = images.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mimeType }));
		}
		const response = await this.client.request(payload);
		if (isFailure(response)) {
			this.notice(`中止并发送失败：${response.error}`, "error");
			return;
		}
		this.busy = true;
		this.phaseValue = "streaming";
		const changed = this.transcript.echoUser(message);
		if (changed.length > 0) this.events.emit("items", changed);
		this.events.emit("state");
		this.events.emit("tabs");
	}

	async runBash(command: string): Promise<BashResultData | undefined> {
		if (!this.client) return undefined;
		const response = await this.client.request<BashResultData>({ type: "bash", command });
		if (isFailure(response)) {
			this.notice(`bash 失败：${response.error}`, "error");
			return undefined;
		}
		return response.data ?? undefined;
	}

	async abortBash(): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "abort_bash" });
		if (isFailure(response)) this.notice(`中止 bash 失败：${response.error}`, "warn");
	}

	async getLoginProviders(): Promise<LoginProvidersData["providers"]> {
		if (!this.client) return [];
		const response = await this.client.request<LoginProvidersData>({ type: "get_login_providers" });
		if (isFailure(response)) {
			this.notice(`读取登录提供方失败：${response.error}`, "error");
			return [];
		}
		return response.data?.providers ?? [];
	}

	async login(providerId: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "login", providerId });
		if (isFailure(response)) {
			this.notice(`登录失败：${response.error}`, "error");
			return;
		}
		this.notice(`已发起 ${providerId} 登录，按提示在浏览器完成授权`, "info");
	}

	async getSubagentMessages(subagentId?: string, fromByte?: number): Promise<SubagentMessagesData | undefined> {
		if (!this.client) return undefined;
		const response = await this.client.request<SubagentMessagesData>({ type: "get_subagent_messages", subagentId, fromByte });
		if (isFailure(response)) {
			this.notice(`读取子智能体消息失败：${response.error}`, "error");
			return undefined;
		}
		return response.data ?? undefined;
	}

	// -------------------------------------------------------------------
	// Host tools / host URI schemes (host-owned capabilities)
	// -------------------------------------------------------------------

	/** Register host-owned tools with the agent; calls arrive as host_tool_call frames. */
	async setHostTools(tools: HostToolDefinition[]): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<{ toolNames?: string[] }>({ type: "set_host_tools", tools });
		if (isFailure(response)) {
			this.notice(`注册 host 工具失败：${response.error}`, "error");
			return;
		}
		this.hostTools = tools;
	}

	/** Register custom URI schemes; reads/writes arrive as host_uri_request frames. */
	async setHostUriSchemes(schemes: HostUriSchemeDefinition[]): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<{ schemes?: string[] }>({ type: "set_host_uri_schemes", schemes });
		if (isFailure(response)) {
			this.notice(`注册 URI scheme 失败：${response.error}`, "error");
			return;
		}
		this.hostUriSchemes = schemes;
	}

	respondHostTool(id: string, result: HostToolResultPayload): void {
		this.client?.send({ type: "host_tool_result", id, result } as unknown as RpcCommand);
	}

	respondHostToolUpdate(id: string, partialResult: { content: HostToolResultPayload["content"] }): void {
		this.client?.send({ type: "host_tool_update", id, partialResult } as unknown as RpcCommand);
	}

	respondHostUri(id: string, result: { content?: string; contentType?: string; isError?: boolean; error?: string }): void {
		this.client?.send({ type: "host_uri_result", id, ...result } as unknown as RpcCommand);
	}

	/**
	 * Background refresh. A tab can be closed or killed while one of these is in
	 * flight, so an unanswered request must not escape as an unhandled rejection.
	 */
	private async requestQuietly<T>(command: RpcCommand): Promise<RpcResponse<T> | undefined> {
		const client = this.client;
		if (!client) return undefined;
		try {
			return await client.request<T>(command);
		} catch (error) {
			if (!this.disposed) {
				this.notice(`后台请求失败（${command.type}）：${error instanceof Error ? error.message : String(error)}`, "warn");
			}
			return undefined;
		}
	}

	async refreshModels(): Promise<void> {
		if (this.modelsRefresh) return this.modelsRefresh;
		this.modelsLoadingValue = true;
		this.modelsErrorValue = undefined;
		this.events.emit("state");
		this.events.emit("models");
		this.modelsRefresh = this.loadModels().finally(() => {
			this.modelsRefresh = undefined;
			this.modelsLoadingValue = false;
			this.events.emit("state");
			this.events.emit("models");
		});
		return this.modelsRefresh;
	}

	private async loadModels(): Promise<void> {
		const response = await this.requestQuietly<GetAvailableModelsData>({ type: "get_available_models" });
		if (!response) {
			this.modelsErrorValue = this.modelChoices.length === 0 ? "拉取模型列表中断" : undefined;
			return;
		}
		if (isFailure(response)) {
			this.modelsErrorValue = response.error;
			this.notice(`拉取模型列表失败：${response.error}`, "warn");
			return;
		}
		this.modelChoices = catalogChoices(response.data?.models ?? [], this.modelValue);
		this.modelsErrorValue = this.modelChoices.length === 0 ? "omp 未返回任何已配置凭证的模型" : undefined;
	}

	/** Keep the active model selectable even before catalog discovery finishes. */
	private ensureCurrentModelChoice(): void {
		this.modelChoices = catalogChoices(this.modelChoices, this.modelValue);
	}

	async refreshCommands(): Promise<void> {
		const response = await this.requestQuietly<GetAvailableCommandsData>({ type: "get_available_commands" });
		if (!response || isFailure(response)) return;
		this.setCommands(response.data?.commands ?? []);
	}

	/**
	 * The list lands after `start()` has already returned, so the announcement is
	 * the only way the sidebar learns `/compact` and friends exist: without it the
	 * composer's completion popup stays empty until an unrelated tab switch.
	 */
	private setCommands(commands: AvailableCommand[]): void {
		this.commandList = commands.map((command) => ({
			name: command.name,
			description: command.description,
			group: command.source,
		}));
		this.events.emit("commands");
	}

	private async refreshStateQuietly(): Promise<void> {
		const response = await this.requestQuietly<GetStateData>({ type: "get_state" });
		if (!response || isFailure(response)) return;
		if (response.data) {
			this.applyState(response.data);
			this.events.emit("state");
		}
	}

	// ---------------------------------------------------------------------
	// Read-only view stack (subagent / plan)
	// ---------------------------------------------------------------------

	pushView(layer: ViewLayer): void {
		this.viewStack.push(layer);
		this.events.emit("viewStack");
	}

	popView(): void {
		if (this.viewStack.length > 1) this.viewStack.pop();
		this.events.emit("viewStack");
	}

	/** Subagent final output, read from omp's artifacts directory. */
	async openSubagent(id: string): Promise<void> {
		const record = this.transcript.subagent(id);
		const sessionFile = record?.sessionFile;
		if (!sessionFile) {
			this.notice(`找不到子智能体 ${id} 的产物路径`, "warn");
			return;
		}
		const output = await readSubagentOutput(sessionFile, record?.id ?? id);
		if (!output.exists) {
			this.notice(`子智能体 ${id} 的输出不可读（${artifactsDir(sessionFile)}）`, "warn");
			return;
		}
		this.pushView({
			kind: "subagent",
			title: `子智能体 · ${record?.id ?? id}`,
			status: [record?.agent, record?.status, output.source].filter(Boolean).join(" · "),
			body: output.markdown ?? output.transcript ?? "",
			source: output.source,
			id: record?.id ?? id,
		});
	}

	/** Plan body, read from the plan file recorded in the session's mode_change entry. */
	async openPlan(): Promise<void> {
		const plan = await readPlanFile(this.planFilePath, this.sessionFileValue);
		if (!plan.ok) {
			this.notice(plan.reason, "warn");
			return;
		}
		this.pushView({ kind: "plan", title: "计划", status: plan.source, body: plan.markdown, source: plan.source });
	}

	// ---------------------------------------------------------------------
	// Extension UI (approval) channel
	// ---------------------------------------------------------------------

	private onUIRequest(request: ExtensionUIRequest): void {
		if (isInteractiveUIRequest(request)) {
			const view: UIRequestView = {
				id: request.id,
				method: request.method,
				title: request.title,
				message: "message" in request ? request.message : undefined,
				options: "options" in request ? request.options : undefined,
				optionDescriptions:
					"optionDetails" in request ? request.optionDetails?.map((detail) => detail?.description ?? "") : undefined,
				placeholder: "placeholder" in request ? request.placeholder : undefined,
				prefill: "prefill" in request ? request.prefill : undefined,
				timeoutMs: "timeout" in request && typeof request.timeout === "number" ? request.timeout : undefined,
			};
			if (this.activeUI) this.uiQueue.push(view);
			else this.showUI(view);
			return;
		}
		if (request.method === "cancel") {
			// omp aborted the request it was waiting on; drop the modal, no answer.
			const rawTarget: unknown = "targetId" in request ? request.targetId : undefined;
			const target = typeof rawTarget === "string" ? rawTarget : undefined;
			const queued = this.uiQueue.findIndex((entry) => entry.id === target);
			if (queued >= 0) this.uiQueue.splice(queued, 1);
			else if (target && this.activeUI?.id === target) this.dismissUI(target);
			else if (!target && this.activeUI) this.dismissUI(this.activeUI.id);
			return;
		}
		if (request.method === "open_url") {
			const rawUrl: unknown = "url" in request ? request.url : undefined;
			const rawInstructions: unknown = "instructions" in request ? request.instructions : undefined;
			const url = typeof rawUrl === "string" ? rawUrl : undefined;
			const instructions = typeof rawInstructions === "string" ? rawInstructions : undefined;
			this.notice(instructions || url || "omp 请求打开链接", "info", url);
			return;
		}
		if (NON_BLOCKING_UI_METHODS.includes(request.method)) {
			// notify is the only non-blocking method with user-visible content; the rest
			// (setStatus/setWidget/setTitle/set_editor_text) drive the TUI chrome we do
			// not render, so they are logged and dropped.
			if (request.method === "notify") {
				const message = typeof request.message === "string" ? request.message : "";
				const level = request.notifyType === "error" ? "error" : request.notifyType === "warn" ? "warn" : "info";
				if (message) this.notice(message, level);
			}
			this.env.logger.info(`ui ${request.method}: ${JSON.stringify(request).slice(0, 400)}`);
			return;
		}
		// Unknown blocking method: cancel immediately so the session can never hang.
		this.client?.respondUI({ type: "extension_ui_response", id: request.id, cancelled: true });
		this.notice(`不支持的 omp UI 请求 ${request.method}，已取消`, "warn");
	}

	private showUI(view: UIRequestView): void {
		this.activeUI = view;
		if (view.timeoutMs && view.timeoutMs > 0) {
			// omp resolves its own default when the timeout fires; drop the modal
			// rather than answering twice.
			this.uiTimer = setTimeout(() => {
				this.notice(`omp 的 ${view.method} 请求已按默认超时处理`, "info");
				this.dismissUI(view.id);
			}, view.timeoutMs);
		}
		this.events.emit("ui", view);
	}

	respondUI(response: ExtensionUIResponse): void {
		this.client?.respondUI(response);
		this.dismissUI(response.id);
	}

	private dismissUI(id: string): void {
		if (this.uiTimer) {
			clearTimeout(this.uiTimer);
			this.uiTimer = undefined;
		}
		if (this.activeUI?.id === id) {
			this.activeUI = undefined;
			this.events.emit("ui", null);
			const next = this.uiQueue.shift();
			if (next) this.showUI(next);
		}
	}

	// ---------------------------------------------------------------------
	// Tab surface
	// ---------------------------------------------------------------------

	get title(): string {
		if (this.sessionName) return this.sessionName;
		const firstUser = this.transcript.items.find((item) => item.kind === "user" && item.text.trim());
		if (firstUser && firstUser.kind === "user") return titleFromText(firstUser.text);
		return "新实例";
	}

	tabSummary(unread: boolean): TabSummary {
		return {
			id: this.id,
			title: this.title,
			running: this.phaseValue !== "failed" && this.phaseValue !== "gone",
			busy: this.busy || this.streaming,
			failed: this.phaseValue === "failed",
			unread,
			mode: this.modeName(),
			sessionFile: this.sessionFileValue,
		};
	}

	state(): InstanceState {
		return {
			mode: this.modeName(),
			modeNote: MODE_NOTE,
			model: this.modelValue ? this.modelLabel() : undefined,
			provider: this.modelValue?.provider,
			modelsLoading: this.modelsLoadingValue,
			modelsError: this.modelsErrorValue,
			thinkingLevel: this.thinkingLevel,
			contextPercent: this.contextPercent,
			contextWindow: this.contextWindow,
			streaming: this.streaming,
			compacting: this.compacting,
			queued: this.queued,
			pending: [...this.pending.items],
			state: this.phaseValue,
			failure: this.failure,
			cwd: this.options.cwd,
			sessionFile: this.sessionFileValue,
			planFile: this.planFilePath,
			fastModeEnabled: this.fastModeEnabled,
			fastModeActive: this.fastModeActive,
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			interruptMode: this.interruptMode,
			autoCompactionEnabled: this.autoCompactionEnabled,
			autoRetryEnabled: this.autoRetryEnabled,
			todoPhases: [...this.todoPhases],
			goal: this.goalText,
			sessionName: this.sessionName,
			protocol: {
				version: this.client?.capabilities.protocolVersion ?? PROTOCOL_VERSION,
				negotiated: this.client?.capabilities.negotiated ?? false,
				serverVersion: this.client?.capabilities.serverProtocolVersion ?? 0,
			},
		};
	}

	private modelLabel(): string {
		if (!this.modelValue) return "未知模型";
		return `${this.modelValue.provider}/${this.modelValue.id}`;
	}

	private modeName(): string {
		return modeLabel(this.modeValue);
	}

	// ---------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------

	private notice(text: string, level: NoticeLevel, url?: string): void {
		this.events.emit("notice", url === undefined ? { text, level } : { text, level, url });
	}

	/**
	 * A host-owned tool the agent invoked. The tool layer (webview picker or
	 * extension default) answers via `respondHostTool`; a registration without an
	 * implementation answers an immediate error so the session never hangs.
	 */
	private onHostToolCall(frame: HostToolCallFrame): void {
		const controller = new AbortController();
		this.hostToolAbort.set(frame.id, controller);
		const tool = this.hostTools.find((candidate) => candidate.name === frame.toolName);
		this.events.emit("hostTool", {
			id: frame.id,
			toolCallId: frame.toolCallId,
			toolName: frame.toolName,
			arguments: frame.arguments ?? {},
			known: !!tool,
		});
		if (!tool) {
			this.respondHostTool(frame.id, {
				content: [{ type: "text", text: `工具 ${frame.toolName} 未在宿主注册实现` }],
				isError: true,
			});
			this.hostToolAbort.delete(frame.id);
		}
	}

	/**
	 * First failure wins. A dead-on-arrival process reports its real cause (ENOENT,
	 * exit code) long before the handshake watchdog expires; overwriting the message
	 * would replace the root cause with a timeout.
	 */
	private fail(message: string): void {
		if (this.phaseValue === "failed") return;
		this.failure = message;
		this.phaseValue = "failed";
		this.readyGuard?.(new Error(message));
		this.streaming = false;
		this.busy = false;
		this.events.emit("state");
		this.events.emit("tabs");
	}

	private requireClient(): RpcClient {
		if (!this.client) throw new Error("omp 进程尚未启动");
		return this.client;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.phaseValue = "disposing";
		if (this.uiTimer) clearTimeout(this.uiTimer);
		if (this.activeUI) {
			this.client?.respondUI({ type: "extension_ui_response", id: this.activeUI.id, cancelled: true });
			this.activeUI = undefined;
		}
		for (const queued of this.uiQueue.splice(0)) {
			this.client?.respondUI({ type: "extension_ui_response", id: queued.id, cancelled: true });
		}
		const changed = this.transcript.settleStreaming();
		if (changed.length > 0) this.events.emit("items", changed);
		this.client?.dispose();
		await this.terminateProcess();
		this.phaseValue = "gone";
	}

	/** Kill synchronously (deactivate path). */
	kill(): void {
		this.disposed = true;
		this.client?.dispose();
		this.process?.killTree("SIGTERM");
	}

	private async terminateProcess(): Promise<void> {
		const process = this.process;
		if (!process) return;
		await process.terminate();
	}
}
