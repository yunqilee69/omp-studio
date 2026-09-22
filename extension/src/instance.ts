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
	type GetAvailableCommandsData,
	type GetAvailableModelsData,
	type GetMessagesPageData,
	type GetStateData,
	type ModelInfo,
	type RpcFrame,
	type SubagentSubscriptionLevel,
	type StreamingBehavior,
	type ThinkingLevel,
} from "./rpc/types";
import { readSubagentOutput, readPlanFile } from "./artifacts";
import { artifactsDir, modeLabel, readSessionMessages, readSessionSummary, titleFromText } from "./session-file";
import type { AgentMessage } from "./rpc/types";
import type {
	InstanceState,
	Item,
	ModelChoice,
	NoticeLevel,
	SlashCommandView,
	TabSummary,
	UIRequestView,
	ViewLayer,
} from "./shared/protocol";
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
	/** Whole transcript replaced (history load, view change). */
	transcriptReplaced: void;
	state: void;
	models: void;
	viewStack: void;
	tabs: void;
	ui: UIRequestView | null;
	notice: { text: string; level: NoticeLevel; url?: string };
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
	private modelChoices: ModelChoice[] = [];
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
			void this.refreshModels();
			void this.refreshCommands();
			this.events.emit("state");
			this.events.emit("tabs");
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
				if (frame.model) this.modelValue = frame.model;
				if (frame.thinkingLevel) this.thinkingLevel = frame.thinkingLevel;
				this.events.emit("state");
				break;
			case "model_changed":
				if (frame.model) this.modelValue = frame.model;
				this.events.emit("state");
				break;
			case "thinking_level_changed":
				if (frame.level) this.thinkingLevel = frame.level;
				this.events.emit("state");
				break;
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
		if (state.model) this.modelValue = state.model;
		if (state.thinkingLevel) this.thinkingLevel = state.thinkingLevel;
		if (state.isStreaming !== undefined) this.streaming = state.isStreaming;
		if (state.isCompacting !== undefined) this.compacting = state.isCompacting;
		if (state.contextUsage?.percent !== undefined) this.contextPercent = state.contextUsage.percent;
		if (state.contextUsage?.contextWindow !== undefined) this.contextWindow = state.contextUsage.contextWindow;
		if (state.queuedMessageCount !== undefined) this.queued = state.queuedMessageCount;
		if (typeof state.mode === "string") this.modeValue = state.mode;
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

	async sendPrompt(text: string, behavior?: StreamingBehavior): Promise<void> {
		if (!this.client || this.phaseValue === "failed" || this.phaseValue === "gone") {
			this.notice("当前 Tab 的 omp 进程不可用", "error");
			return;
		}
		const trimmed = text.trim();
		if (!trimmed) return;
		const effective = this.streaming || this.busy ? (behavior ?? "followUp") : undefined;
		const response = await this.client.request(
			effective === undefined
				? { type: "prompt", message: trimmed }
				: { type: "prompt", message: trimmed, streamingBehavior: effective },
		);
		if (isFailure(response)) {
			this.busy = false;
			this.notice(`发送失败：${response.error}`, "error");
			this.events.emit("state");
			return;
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
		if (agentInvoked !== false) this.sessionName ??= titleFromText(trimmed);
		this.events.emit("state");
		this.events.emit("tabs");
	}

	async abort(): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request({ type: "abort" });
		if (isFailure(response)) this.notice(`中止失败：${response.error}`, "warn");
	}

	async steer(text: string): Promise<void> {
		if (!this.client || !text.trim()) return;
		const response = await this.client.request({ type: "steer", message: text.trim() });
		if (isFailure(response)) this.notice(`steer 失败：${response.error}`, "warn");
		else this.queued += 1;
		this.events.emit("state");
	}

	async setModel(provider: string, id: string): Promise<void> {
		if (!this.client) return;
		const response = await this.client.request<ModelInfo>({ type: "set_model", provider, modelId: id });
		if (isFailure(response)) {
			this.notice(`切换模型失败：${response.error}`, "error");
			return;
		}
		if (response.data) this.modelValue = response.data;
		this.notice(`模型已切换：${this.modelLabel()}`, "info");
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
		const response = await this.requestQuietly<GetAvailableModelsData>({ type: "get_available_models" });
		if (!response || isFailure(response)) return;
		this.modelChoices = (response.data?.models ?? []).map((model) => ({
			provider: model.provider,
			id: model.id,
			label: model.name || model.id,
			contextWindow: model.contextWindow,
		}));
		this.events.emit("models");
	}

	async refreshCommands(): Promise<void> {
		const response = await this.requestQuietly<GetAvailableCommandsData>({ type: "get_available_commands" });
		if (!response || isFailure(response)) return;
		this.commandList = (response.data?.commands ?? []).map((command) => ({
			name: command.name,
			description: command.description,
			group: command.source,
		}));
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
			modeNote:
				"omp 18.1.2 的 RPC 没有 set_mode：模式只能在 omp 终端里切换（见 docs/upstream-issues.md U2）。",
			model: this.modelValue ? this.modelLabel() : undefined,
			provider: this.modelValue?.provider,
			thinkingLevel: this.thinkingLevel,
			contextPercent: this.contextPercent,
			contextWindow: this.contextWindow,
			streaming: this.streaming,
			compacting: this.compacting,
			queued: this.queued,
			state: this.phaseValue,
			failure: this.failure,
			cwd: this.options.cwd,
			sessionFile: this.sessionFileValue,
			planFile: this.planFilePath,
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
