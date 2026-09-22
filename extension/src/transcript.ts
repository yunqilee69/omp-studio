import {
	isTerminalAgentEnd,
	isTextPart,
	isToolResultMessage,
	messageText,
	messageThinking,
	messageToolCalls,
	type AgentMessage,
	type AssistantMessageEvent,
	type MessageUpdateFrame,
	type RpcFrame,
	type SubagentPayload,
	type ToolResultMessage,
} from "./rpc/types";
import type { AssistantItem, Item, NoticeItem, ToolItem, ToolStatus, UserItem } from "./shared/protocol";

const SUMMARY_LIMIT = 800;
const PROGRESS_LIMIT = 240;
/** One row, one line: a failure reason longer than this belongs in the expanded body. */
const ERROR_LIMIT = 120;
/** Single in-place retry line per run; cleared when the run recovers. */
const RETRY_KEY = "retry:current";

/** Paths that name no file (`read .`): not worth a row's subject. */
const TRIVIAL_PATHS = new Set([".", "..", "./", ""]);

export interface TranscriptOptions {
	/**
	 * Clock for the thinking row. Injectable because a test replays recorded
	 * frames in the same millisecond, and a real stream needs wall time.
	 */
	now?: () => number;
}

export interface SubagentRecord {
	id: string;
	agent?: string;
	status: string;
	parentToolCallId?: string;
	task?: string;
	sessionFile?: string;
	index?: number;
}

export interface TranscriptEvent {
	/** Items to upsert in the webview, in render order. */
	items: Item[];
}

/**
 * Frame -> renderable items.
 *
 * Pure bookkeeping: no process, no VS Code, no I/O. Every frame type the RPC
 * contract defines is either mapped to an item or explicitly ignored, so an
 * unknown frame can never crash a session.
 */
export class Transcript {
	private readonly itemList: Item[] = [];
	private readonly positions = new Map<string, number>();
	private counter = 0;
	private streamingAssistantKey: string | undefined;
	private readonly subagentsById = new Map<string, SubagentRecord>();
	private readonly subagentByToolCall = new Map<string, string>();
	private readonly pendingSubagentByToolCall = new Map<string, SubagentRecord>();
	/** Texts dispatched locally that omp will echo back as user messages. */
	private readonly echoedUserTexts: string[] = [];
	/** Keys removed since the last takeRemovedKeys (recovered retry line). */
	private removedKeysList: string[] = [];
	/** When the current assistant request left, and when its thinking began. */
	private assistantStartedAt: number | undefined;
	private thinkingStartedAt: number | undefined;
	/** Wait before the assistant frame (omp emits it at the first token, not at dispatch). */
	private preResponseMs = 0;
	/** When any message last settled: the start of the next request's wait. */
	private lastMessageEndAt: number | undefined;
	private readonly now: () => number;

	constructor(options: TranscriptOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	get items(): readonly Item[] {
		return this.itemList;
	}

	/** Keys dropped from the transcript since the previous call; host forwards them to the webview. */
	takeRemovedKeys(): string[] {
		const keys = this.removedKeysList;
		this.removedKeysList = [];
		return keys;
	}

	get subagents(): SubagentRecord[] {
		return [...this.subagentsById.values()];
	}

	subagentIdForToolCall(toolCallId: string): string | undefined {
		return this.subagentByToolCall.get(toolCallId);
	}

	subagent(id: string): SubagentRecord | undefined {
		return this.subagentsById.get(id);
	}

	clear(): void {
		this.itemList.length = 0;
		this.positions.clear();
		this.counter = 0;
		this.streamingAssistantKey = undefined;
		this.assistantStartedAt = undefined;
		this.thinkingStartedAt = undefined;
		this.preResponseMs = 0;
		this.lastMessageEndAt = undefined;
		this.subagentsById.clear();
		this.subagentByToolCall.clear();
		this.pendingSubagentByToolCall.clear();
		this.echoedUserTexts.length = 0;
	}

	/**
	 * Show the user turn as soon as we dispatch it to omp. The text is recorded so
	 * the later `message_start`/`message_end` echo for the SAME dispatch is merged,
	 * not duplicated. Queue-shaped: re-asking an identical earlier question must
	 * still render its own bubble.
	 */
	echoUser(text: string): Item[] {
		const trimmed = text.trim();
		if (!trimmed) return [];
		this.echoedUserTexts.push(trimmed);
		return [this.append({ kind: "user", key: `u${++this.counter}`, text: trimmed })];
	}

	/** Apply one frame; returns the items whose rendering changed. */
	apply(frame: RpcFrame): Item[] {
		switch (frame.type) {
			case "message_start":
				return this.onMessageStart(frame.message);
			case "message_update":
				return this.onMessageUpdate(frame);
			case "message_end":
				return this.onMessageEnd(frame.message);
			case "tool_execution_start": {
				const item = this.upsertTool(frame.toolCallId, {
					name: frame.toolName,
					intent: typeof frame.intent === "string" ? frame.intent : undefined,
					status: "running",
					files: extractFiles(frame.args),
					...startFacts(frame.toolName, frame.args),
				});
				return [item];
			}
			case "tool_execution_update": {
				const item = this.upsertTool(frame.toolCallId, {
					progress: preview(partText(frame.partialResult), PROGRESS_LIMIT),
				});
				return [item];
			}
			case "tool_execution_end": {
				const text = partText(frame.result);
				const item = this.upsertTool(frame.toolCallId, {
					status: frame.isError ? "error" : "ok",
					summary: preview(text, SUMMARY_LIMIT),
					progress: undefined,
					errorText: frame.isError ? firstLine(text, ERROR_LIMIT) : undefined,
					...endFacts(resultDetails(frame.result)),
				});
				return [item];
			}
			case "command_output": {
				return [this.append({ kind: "command", key: `c${++this.counter}`, text: frame.text })];
			}
			case "notice": {
				const text = frame.text ?? frame.message;
				if (!text) return [];
				// Info notices are runtime chatter (set_model mounts xd:// tools,
				// capability changes). They are not conversation turns.
				if (frame.level !== "error" && frame.level !== "warn") return [];
				return [this.append(this.notice(text, frame.level))];
			}
			case "extension_error": {
				const text = frame.error ?? "omp extension error";
				return [this.append(this.notice(text, "error"))];
			}
			case "auto_retry_start": {
				const attempt = typeof frame.attempt === "number" ? frame.attempt : undefined;
				const max = typeof frame.maxAttempts === "number" ? frame.maxAttempts : undefined;
				return [this.upsertRetry(attempt, max, frame.errorMessage)];
			}
			case "auto_retry_end": {
				if (frame.success) return this.clearRetry();
				const attempt = typeof frame.attempt === "number" ? frame.attempt : undefined;
				return [this.upsertRetry(attempt, undefined, frame.finalError, true)];
			}
			case "retry_fallback_applied":
			case "retry_fallback_succeeded": {
				const from = frame.from?.model ?? frame.model;
				const to = frame.to?.model;
				return from && to ? [this.upsertRetry(undefined, undefined, `模型降级：${from} → ${to}`)] : [];
			}
			case "subagent_lifecycle":
			case "subagent_progress": {
				return this.onSubagent(frame.payload);
			}
			// Per-frame subagent events would flood the transcript; the card's status
			// line and the artifact view carry everything the product asks for.
			case "subagent_event":
				return [];
			case "agent_end": {
				if (!isTerminalAgentEnd(frame)) return [];
				return this.settleStreaming();
			}
			default:
				return [];
		}
	}

	/** Rebuild from a history page (session resume) or an agent transcript. */
	replaceFromMessages(messages: AgentMessage[]): void {
		this.clear();
		for (const message of messages) this.itemsFromMessage(message);
		this.settleStreaming();
	}

	private itemsFromMessage(message: AgentMessage): Item[] {
		if (message.role === "user") {
			const text = messageText(message);
			if (!text) return [];
			return [this.append({ kind: "user", key: `u${++this.counter}`, text })];
		}
		if (message.role === "assistant") {
			const text = messageText(message);
			const thinking = messageThinking(message);
			const item: AssistantItem = {
				kind: "assistant",
				key: `a${++this.counter}`,
				text,
				thinking,
				streaming: false,
				model: typeof message.model === "string" ? message.model : undefined,
			};
			const created: Item[] = [this.append(item)];
			for (const call of messageToolCalls(message)) {
				created.push(
					this.upsertTool(call.id, {
						name: call.name,
						intent: typeof call.intent === "string" ? call.intent : undefined,
						status: "unknown",
						files: extractFiles(call.arguments),
						...startFacts(call.name, call.arguments),
					}),
				);
			}
			return created;
		}
		if (isToolResultMessage(message)) {
			const text = partText(message);
			return [
				this.upsertTool(message.toolCallId, {
					name: message.toolName ?? "tool",
					status: message.isError ? "error" : "ok",
					summary: preview(text, SUMMARY_LIMIT),
					errorText: message.isError ? firstLine(text, ERROR_LIMIT) : undefined,
					...endFacts(message.details),
				}),
			];
		}
		return [];
	}

	/** Freeze everything still running (process exit, tab close, lost frames). */
	settleStreaming(): Item[] {
		const changed: Item[] = [];
		this.streamingAssistantKey = undefined;
		this.assistantStartedAt = undefined;
		this.thinkingStartedAt = undefined;
		this.preResponseMs = 0;
		for (const item of this.itemList) {
			if (item.kind === "assistant" && item.streaming) {
				item.streaming = false;
				changed.push(item);
			} else if (item.kind === "tool" && item.status === "running") {
				item.status = "unknown";
				changed.push(item);
			}
		}
		// The run is over: a live retry line that never resolved is stale unless it
		// carries the final failure (error level stays so the user sees why).
		const retry = this.get(RETRY_KEY);
		if (retry && retry.kind === "notice" && retry.level === "warn") {
			const removed = this.clearRetry();
			changed.push(...removed);
		}
		return changed;
	}	private onMessageStart(message: AgentMessage): Item[] {
		if (message.role === "user") {
			const text = messageText(message);
			if (this.consumeEchoedUser(text)) return [];
			return [this.append({ kind: "user", key: `u${++this.counter}`, text })];
		}
		if (message.role === "assistant") {
			this.beginAssistantTurn();
			return [this.startAssistant(message)];
		}
		if (isToolResultMessage(message)) return this.onToolResult(message);
		return [];
	}

	/**
	 * Streaming updates carry the *cumulative* message, not just the new delta:
	 * omp 18.1.2's `message_update.message` already holds the first chunk when the
	 * first `*_delta` arrives, so appending deltas would duplicate the prefix
	 * (verified in docs/rpc-samples/plan.jsonl). Snapshot it instead - idempotent,
	 * and correct whether a frame repeats or a delta is lost.
	 */
	private onMessageUpdate(frame: MessageUpdateFrame): Item[] {
		const message = frame.message;
		if (message.role !== "assistant") return isToolResultMessage(message) ? this.onToolResult(message) : [];
		if (this.streamingAssistant() === undefined) this.beginAssistantTurn();
		const item = this.streamingAssistant() ?? this.startAssistant(message);
		item.text = messageText(message);
		item.thinking = messageThinking(message);
		item.streaming = true;
		if (typeof message.model === "string") item.model = message.model;
		this.noteThinking(item, frame.assistantMessageEvent);
		return [item];
	}

	private onMessageEnd(message: AgentMessage): Item[] {
		// Every settled message starts the next request's wait; the clock is read once
		// here so the roles below stay about rendering.
		this.lastMessageEndAt = this.now();
		if (message.role === "user") {
			const text = messageText(message);
			if (this.consumeEchoedUser(text)) return [];
			const existing = [...this.itemList].reverse().find((item): item is UserItem => item.kind === "user");
			if (existing && existing.text.length === 0) {
				existing.text = text;
				return [existing];
			}
			if (!existing) return [this.append({ kind: "user", key: `u${++this.counter}`, text })];
			return [];
		}
		if (message.role === "assistant") {
			const item = this.streamingAssistant() ?? this.appendAssistantFrom(message);
			// The completed message is authoritative for both text and thinking.
			const text = messageText(message);
			const thinking = messageThinking(message);
			if (text) item.text = text;
			if (thinking) item.thinking = thinking;
			item.streaming = false;
			if (typeof message.model === "string") item.model = message.model;
			if (typeof message.errorMessage === "string" && message.errorMessage) item.error = message.errorMessage;
			this.settleThinking(item);
			this.streamingAssistantKey = undefined;
			return [item];
		}
		if (isToolResultMessage(message)) return this.onToolResult(message);
		return [];
	}

	private onToolResult(message: ToolResultMessage): Item[] {
		const text = partText(message);
		return [
			this.upsertTool(message.toolCallId, {
				name: message.toolName ?? "tool",
				status: message.isError ? "error" : "ok",
				summary: preview(text, SUMMARY_LIMIT),
				errorText: message.isError ? firstLine(text, ERROR_LIMIT) : undefined,
				...endFacts(message.details),
			}),
		];
	}

	/** The request leaving is the start of the wait a thinking row reports. */
	private beginAssistantTurn(): void {
		const startedAt = this.now();
		this.assistantStartedAt = startedAt;
		this.thinkingStartedAt = undefined;
		// omp emits an assistant `message_start` when the first token arrives, not when
		// the request leaves (measured: a 2.5s wait with only 0.2s of thinking stream,
		// see docs/rpc-samples/edit.jsonl). Without the gap the row would call a long
		// wait "不到 1 秒", so it counts from the previous message settling.
		this.preResponseMs = this.lastMessageEndAt === undefined ? 0 : Math.max(0, startedAt - this.lastMessageEndAt);
	}

	/**
	 * omp streams `thinking_start`/`thinking_end` but never a duration, so the row's
	 * seconds are timed here: the wait before the first token plus the thinking
	 * stream. A turn replayed from history raises neither event and therefore shows
	 * no number at all.
	 */
	private noteThinking(item: AssistantItem, event?: AssistantMessageEvent): void {
		if (!event) return;
		if (event.type === "thinking_start") {
			this.thinkingStartedAt ??= this.assistantStartedAt ?? this.now();
			return;
		}
		if (event.type !== "thinking_end") return;
		const startedAt = this.thinkingStartedAt ?? this.assistantStartedAt;
		this.thinkingStartedAt = undefined;
		if (startedAt !== undefined) item.thinkingMs = this.preResponseMs + Math.max(0, this.now() - startedAt);
	}

	/** A stream cut mid-thought (abort, process death) still owes its row the number. */
	private settleThinking(item: AssistantItem): void {
		if (item.thinkingMs === undefined && this.thinkingStartedAt !== undefined) {
			item.thinkingMs = this.preResponseMs + Math.max(0, this.now() - this.thinkingStartedAt);
		}
		this.assistantStartedAt = undefined;
		this.thinkingStartedAt = undefined;
	}

	private onSubagent(payload: SubagentPayload): Item[] {
		const nested = "progress" in payload ? payload.progress : undefined;
		const id = ("id" in payload ? payload.id : undefined) ?? nested?.id;
		const parentToolCallId = payload.parentToolCallId;
		const status = nested?.status ?? ("status" in payload ? payload.status : undefined) ?? "running";
		const task =
			("task" in payload ? payload.task : undefined) ??
			("assignment" in payload ? payload.assignment : undefined) ??
			nested?.task;

		let record: SubagentRecord | undefined;
		if (id) record = this.subagentsById.get(id);
		if (!record && parentToolCallId) record = this.pendingSubagentByToolCall.get(parentToolCallId);
		if (!record) {
			record = { id: id ?? (parentToolCallId ? `tool:${parentToolCallId}` : `subagent:${this.counter + 1}`), status };
			if (id) this.subagentsById.set(record.id, record);
			else if (parentToolCallId) this.pendingSubagentByToolCall.set(parentToolCallId, record);
		}
		if (id && record.id !== id) {
			// Promote a placeholder keyed by tool call id to the real subagent id.
			this.subagentsById.delete(record.id);
			record.id = id;
			this.subagentsById.set(id, record);
			if (parentToolCallId) this.pendingSubagentByToolCall.delete(parentToolCallId);
		}
		if (typeof payload.agent === "string") record.agent = payload.agent;
		if (typeof payload.sessionFile === "string") record.sessionFile = payload.sessionFile;
		if (typeof status === "string") record.status = status;
		if (typeof payload.index === "number") record.index = payload.index;
		if (typeof task === "string" && task.length > 0) record.task = task;
		if (parentToolCallId) {
			record.parentToolCallId = parentToolCallId;
			this.subagentByToolCall.set(parentToolCallId, record.id);
		}

		// A tool card that spawned this subagent gains the "view output" affordance.
		if (!parentToolCallId) return [];
		const tool = this.get(`t:${parentToolCallId}`);
		if (!tool || tool.kind !== "tool" || tool.subagentId === record.id) return [];
		tool.subagentId = record.id;
		return [tool];
	}

	/** Open a new streaming assistant item and remember it for later frames. */
	private startAssistant(message: AgentMessage): AssistantItem {
		const item: AssistantItem = {
			kind: "assistant",
			key: `a${++this.counter}`,
			text: messageText(message),
			thinking: messageThinking(message),
			streaming: true,
			model: "model" in message && typeof message.model === "string" ? message.model : undefined,
		};
		this.streamingAssistantKey = item.key;
		return this.append(item);
	}

	private appendAssistantFrom(message: AgentMessage): AssistantItem {
		const item: AssistantItem = {
			kind: "assistant",
			key: `a${++this.counter}`,
			text: messageText(message),
			thinking: messageThinking(message),
			streaming: false,
		};
		return this.append(item) as AssistantItem;
	}

	private streamingAssistant(): AssistantItem | undefined {
		if (!this.streamingAssistantKey) return undefined;
		const item = this.get(this.streamingAssistantKey);
		return item && item.kind === "assistant" ? item : undefined;
	}

	private upsertTool(
		toolCallId: string,
		patch: Partial<Omit<ToolItem, "kind" | "key" | "toolCallId">> & { name?: string },
	): ToolItem {
		const key = `t:${toolCallId}`;
		const existing = this.get(key);
		if (existing && existing.kind === "tool") {
			if (patch.name) existing.name = patch.name;
			if (patch.intent) existing.intent = patch.intent;
			if (patch.status) existing.status = patch.status;
			if (patch.summary !== undefined) existing.summary = patch.summary;
			if (patch.progress !== undefined) existing.progress = patch.progress;
			if (patch.files && patch.files.length > 0) existing.files = [...new Set([...existing.files, ...patch.files])];
			// The name comes from the arguments first and from the result later; whichever
			// arrived first is the one the row already shows, so never swap it out.
			if (patch.path !== undefined && existing.path === undefined) existing.path = patch.path;
			if (patch.added !== undefined) existing.added = patch.added;
			if (patch.removed !== undefined) existing.removed = patch.removed;
			if (patch.command !== undefined) existing.command = patch.command;
			if (patch.errorText !== undefined) existing.errorText = patch.errorText;
			if (patch.durationMs !== undefined) existing.durationMs = patch.durationMs;
			return existing;
		}
		const item: ToolItem = {
			kind: "tool",
			key,
			toolCallId,
			name: patch.name ?? "tool",
			intent: patch.intent,
			status: (patch.status ?? "running") as ToolStatus,
			summary: patch.summary,
			progress: patch.progress,
			files: patch.files ?? [],
			path: patch.path,
			added: patch.added,
			removed: patch.removed,
			command: patch.command,
			errorText: patch.errorText,
			durationMs: patch.durationMs,
		};
		const subagentId = this.subagentByToolCall.get(toolCallId);
		if (subagentId) item.subagentId = subagentId;
		return this.append(item) as ToolItem;
	}

	private notice(text: string, level: NoticeItem["level"]): NoticeItem {
		return { kind: "notice", key: `n${++this.counter}`, text, level };
	}

	/**
	 * Retry progress is one transcript line per run, updated in place: attempt
	 * N+1 rewrites attempt N instead of stacking toasts. Lives from the first
	 * `auto_retry_start` until a terminal `agent_end`; `auto_retry_end` with
	 * success (or a fresh history rebuild) clears it.
	 */
	private upsertRetry(attempt: number | undefined, max: number | undefined, detail?: string, failed?: boolean): NoticeItem {
		const count = attempt !== undefined && max !== undefined ? `${attempt}/${max}` : attempt !== undefined ? String(attempt) : undefined;
		const text = failed === true
			? `自动重试失败${count ? `（第 ${count} 次）` : ""}${detail ? `：${detail}` : ""}`
			: `模型请求失败，自动重试${count ? ` ${count}` : ""}${detail ? `：${detail}` : ""}`;
		const existing = this.get(RETRY_KEY);
		if (existing && existing.kind === "notice") {
			existing.text = text;
			existing.level = failed ? "error" : "warn";
			return existing;
		}
		return this.append({ kind: "notice", key: RETRY_KEY, text, level: failed ? "error" : "warn" });
	}

	private clearRetry(): Item[] {
		const existing = this.get(RETRY_KEY);
		if (!existing || existing.kind !== "notice") return [];
		const index = this.positions.get(RETRY_KEY);
		if (index !== undefined) {
			this.itemList.splice(index, 1);
			for (let i = index; i < this.itemList.length; i++) this.positions.set(this.itemList[i].key, i);
			this.positions.delete(RETRY_KEY);
		}
		this.removedKeysList.push(RETRY_KEY);
		return [existing];
	}

	/** Match a queued echo exactly once; an unmatched text is a genuine omp user frame. */
	private consumeEchoedUser(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) return false;
		const index = this.echoedUserTexts.indexOf(trimmed);
		if (index < 0) return false;
		this.echoedUserTexts.splice(index, 1);
		return true;
	}

	private append<T extends Item>(item: T): T {
		this.positions.set(item.key, this.itemList.length);
		this.itemList.push(item);
		return item;
	}

	private get(key: string): Item | undefined {
		const position = this.positions.get(key);
		return position === undefined ? undefined : this.itemList[position];
	}
}

/** Paths a tool reported, for the card's "open in editor". */
function extractFiles(args: unknown): string[] {
	if (!args || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const files: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.length > 0 && value.length < 1024) files.push(value);
	};
	for (const key of ["path", "file", "filePath", "target", "uri"]) push(record[key]);
	if (Array.isArray(record.files)) for (const value of record.files) push(value);
	if (Array.isArray(record.paths)) for (const value of record.paths) push(value);
	return files;
}

/**
 * What a call says about itself before it runs. Verified against a real capture
 * (docs/rpc-samples/edit.jsonl): `read` names `args.path`, `bash` names
 * `args.command`, `write` carries the whole content so its line count is known
 * here, and `edit` announces its target only in the patch header
 * (`[probe-notes.txt#B6C1]`) - `details.path` follows once it lands.
 */
function startFacts(toolName: string, args: unknown): Partial<ToolItem> {
	if (!isRecord(args)) return {};
	const facts: Partial<ToolItem> = {};
	const path = firstPath(args.path, args.file, args.filePath, args.target, args.uri);
	if (path) facts.path = path;
	const command = firstString(args.command, args.cmd);
	if (command) facts.command = command;
	if (toolName === "edit") {
		const fromPatch = patchHeaderPath(args.input);
		if (fromPatch) facts.path = fromPatch;
	}
	if (toolName === "write") {
		const lines = writtenLines(args.content);
		if (lines !== undefined) facts.added = lines;
	}
	return facts;
}

/**
 * What omp only reports once a call lands. `edit` is the only tool that hands
 * back a diff, and it is the reason a row can show `+N -M` at all.
 */
function endFacts(details: unknown): Partial<ToolItem> {
	if (!isRecord(details)) return {};
	const facts: Partial<ToolItem> = {};
	const path = detailPath(details);
	if (path) facts.path = path;
	if (typeof details.wallTimeMs === "number") facts.durationMs = Math.round(details.wallTimeMs);
	const diff = firstString(details.diff);
	if (diff) {
		const counts = countDiff(diff);
		facts.added = counts.added;
		facts.removed = counts.removed;
	}
	return facts;
}

function resultDetails(result: unknown): unknown {
	return isRecord(result) ? result.details : undefined;
}

/** omp hides a read's resolved location under `details.meta.source.value`. */
function detailPath(details: Record<string, unknown>): string | undefined {
	const meta = isRecord(details.meta) ? details.meta : undefined;
	const source = meta && isRecord(meta.source) ? meta.source : undefined;
	return firstPath(details.path, details.resolvedPath, source?.value);
}

/** `+N -M` from omp's diff, whose lines are prefixed with `+`, `-` or a space. */
function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

/** omp's edit input opens with a patch header naming its target: `[notes.txt#B6C1]`. */
function patchHeaderPath(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const match = /^\[([^\]\n]+?)(?:#[0-9A-Fa-f]+)?\]/.exec(input);
	return match?.[1];
}

/** Lines a write's content holds; a single trailing newline is not a line of its own. */
function writtenLines(content: unknown): number | undefined {
	if (typeof content !== "string") return undefined;
	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/** First line of a failed call, capped: one row gets one line, not a stack trace. */
function firstLine(text: string, limit: number): string | undefined {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
	if (!line) return undefined;
	const trimmed = line.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return undefined;
}

/** Like `firstString`, but a path naming nothing (`read .`) is not a subject. */
function firstPath(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0 && !TRIVIAL_PATHS.has(trimmed)) return trimmed;
	}
	return undefined;
}

function partText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object" || !("content" in value)) return "";
	const content = value.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(isTextPart)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function preview(text: string, limit: number): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const single = trimmed.replace(/\r/g, "");
	return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}
