import {
	isTerminalAgentEnd,
	isTextPart,
	isToolResultMessage,
	messageText,
	messageThinking,
	messageToolCalls,
	type AgentMessage,
	type RpcFrame,
	type SubagentPayload,
	type ToolResultMessage,
} from "./rpc/types";
import type { AssistantItem, Item, NoticeItem, ToolItem, ToolStatus, UserItem } from "./shared/protocol";

const SUMMARY_LIMIT = 800;
const PROGRESS_LIMIT = 240;

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

	get items(): readonly Item[] {
		return this.itemList;
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
		this.subagentsById.clear();
		this.subagentByToolCall.clear();
		this.pendingSubagentByToolCall.clear();
	}

	/** Apply one frame; returns the items whose rendering changed. */
	apply(frame: RpcFrame): Item[] {
		switch (frame.type) {
			case "message_start":
				return this.onMessageStart(frame.message);
			case "message_update":
				return this.onMessageUpdate(frame.message);
			case "message_end":
				return this.onMessageEnd(frame.message);
			case "tool_execution_start": {
				const item = this.upsertTool(frame.toolCallId, {
					name: frame.toolName,
					intent: typeof frame.intent === "string" ? frame.intent : undefined,
					status: "running",
					files: extractFiles(frame.args),
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
				const item = this.upsertTool(frame.toolCallId, {
					status: frame.isError ? "error" : "ok",
					summary: preview(partText(frame.result), SUMMARY_LIMIT),
					progress: undefined,
				});
				return [item];
			}
			case "command_output": {
				return [this.append({ kind: "command", key: `c${++this.counter}`, text: frame.text })];
			}
			case "notice": {
				const text = frame.text ?? frame.message;
				if (!text) return [];
				const level = frame.level === "error" || frame.level === "warn" ? frame.level : "info";
				return [this.append(this.notice(text, level))];
			}
			case "extension_error": {
				const text = frame.error ?? "omp extension error";
				return [this.append(this.notice(text, "error"))];
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
					}),
				);
			}
			return created;
		}
		if (isToolResultMessage(message)) {
			return [
				this.upsertTool(message.toolCallId, {
					name: message.toolName ?? "tool",
					status: message.isError ? "error" : "ok",
					summary: preview(partText(message), SUMMARY_LIMIT),
				}),
			];
		}
		return [];
	}

	/** Freeze everything still running (process exit, tab close, lost frames). */
	settleStreaming(): Item[] {
		const changed: Item[] = [];
		this.streamingAssistantKey = undefined;
		for (const item of this.itemList) {
			if (item.kind === "assistant" && item.streaming) {
				item.streaming = false;
				changed.push(item);
			} else if (item.kind === "tool" && item.status === "running") {
				item.status = "unknown";
				changed.push(item);
			}
		}
		return changed;
	}

	private onMessageStart(message: AgentMessage): Item[] {
		if (message.role === "user") {
			const text = messageText(message);
			return [this.append({ kind: "user", key: `u${++this.counter}`, text })];
		}
		if (message.role === "assistant") return [this.startAssistant(message)];
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
	private onMessageUpdate(message: AgentMessage): Item[] {
		if (message.role !== "assistant") return isToolResultMessage(message) ? this.onToolResult(message) : [];
		const item = this.streamingAssistant() ?? this.startAssistant(message);
		item.text = messageText(message);
		item.thinking = messageThinking(message);
		item.streaming = true;
		if (typeof message.model === "string") item.model = message.model;
		return [item];
	}

	private onMessageEnd(message: AgentMessage): Item[] {
		if (message.role === "user") {
			const text = messageText(message);
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
			this.streamingAssistantKey = undefined;
			return [item];
		}
		if (isToolResultMessage(message)) return this.onToolResult(message);
		return [];
	}

	private onToolResult(message: ToolResultMessage): Item[] {
		return [
			this.upsertTool(message.toolCallId, {
				name: message.toolName ?? "tool",
				status: message.isError ? "error" : "ok",
				summary: preview(partText(message), SUMMARY_LIMIT),
			}),
		];
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
		};
		const subagentId = this.subagentByToolCall.get(toolCallId);
		if (subagentId) item.subagentId = subagentId;
		return this.append(item) as ToolItem;
	}

	private notice(text: string, level: NoticeItem["level"]): NoticeItem {
		return { kind: "notice", key: `n${++this.counter}`, text, level };
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
