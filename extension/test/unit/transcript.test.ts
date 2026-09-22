import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FrameDecoder } from "../../src/rpc/frame";
import type { RpcFrame } from "../../src/rpc/types";
import { messageText, messageThinking } from "../../src/rpc/types";
import { Transcript } from "../../src/transcript";
import type { AssistantItem, Item, ToolItem, UserItem } from "../../src/shared/protocol";

/**
 * Replays recorded `omp --mode rpc` stdout through the same decoder the host uses.
 * The fixtures are real captures (docs/rpc-samples), not hand-written frames.
 */
function record(name: string): RpcFrame[] {
	const raw = readFileSync(join(import.meta.dirname, "../../../docs/rpc-samples", `${name}.jsonl`), "utf8");
	const decoder = new FrameDecoder();
	return decoder.push(raw);
}

const replay = (name: string) => {
	const transcript = new Transcript();
	for (const frame of record(name)) transcript.apply(frame);
	return transcript;
};

const byKind = <T extends Item["kind"]>(items: readonly Item[], kind: T) =>
	items.filter((item): item is Extract<Item, { kind: T }> => item.kind === kind);

describe("Transcript over recorded omp frames", () => {
	it("turns a real chat capture into user, assistant and tool items", () => {
		const transcript = replay("chat");
		const users = byKind(transcript.items, "user");
		const assistants = byKind(transcript.items, "assistant");
		const tools = byKind(transcript.items, "tool");

		expect(users.length).toBeGreaterThan(0);
		expect(users[0].text.trim().length).toBeGreaterThan(0);
		expect(assistants.length).toBeGreaterThan(0);
		expect(assistants.every((item) => item.streaming === false)).toBe(true);
		expect(assistants.at(-1)?.text.trim().length).toBeGreaterThan(0);
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.every((item) => item.status !== "running")).toBe(true);
	});

	it("streams an assistant item in place instead of appending per delta", () => {
		const transcript = new Transcript();
		const frames = record("plan");
		const events: Item[][] = [];
		for (const frame of frames) {
			const changed = transcript.apply(frame);
			if (changed.length > 0) events.push(changed);
		}
		const assistantKeys = new Set(byKind(transcript.items, "assistant").map((item) => item.key));
		const streamedKeys = new Set(
			events.flat().filter((item): item is AssistantItem => item.kind === "assistant").map((item) => item.key),
		);
		// Every delta updated an existing item: one key per assistant turn, never one per token.
		expect(streamedKeys.size).toBeLessThanOrEqual(assistantKeys.size);
		expect(events.flat().length).toBeGreaterThan(200);
	});

	it("links a subagent to the tool call that spawned it", () => {
		const transcript = replay("subagent");
		const withSubagent = byKind(transcript.items, "tool").filter((tool) => tool.subagentId);
		expect(withSubagent).toHaveLength(1);
		const record_ = transcript.subagent(withSubagent[0].subagentId ?? "");
		expect(record_).toBeDefined();
		expect(record_?.agent).toBe("scout");
		expect(record_?.status).toBe("completed");
		expect(record_?.parentToolCallId).toBe(withSubagent[0].toolCallId);
		expect(record_?.sessionFile).toContain("DocsFilenames.jsonl");
		expect(transcript.subagentIdForToolCall(withSubagent[0].toolCallId)).toBe(record_?.id);
	});

	it("keeps tool cards free of subagent links in a capture without subagents", () => {
		const transcript = replay("chat");
		expect(byKind(transcript.items, "tool").every((tool) => tool.subagentId === undefined)).toBe(true);
	});

	it("renders the cumulative message, never the sum of deltas", () => {
		// omp's streaming frames repeat the text so far; the plan capture was cut
		// mid-turn, so streamed lengths must equal each message's own final length.
		const finished: number[] = [];
		for (const frame of record("plan")) {
			if (frame.type !== "message_end" || frame.message.role !== "assistant") continue;
			finished.push(messageText(frame.message).length + messageThinking(frame.message).length);
		}

		const transcript = replay("plan");
		const rendered = byKind(transcript.items, "assistant").map((item) => item.text.length + item.thinking.length);
		expect(finished.length).toBeGreaterThan(0);
		expect(rendered.slice(0, -1)).toEqual(finished);
		expect(rendered.at(-1)).toBeGreaterThan(0);

		// The last turn never finished: still streaming, and not double-counted.
		expect(byKind(transcript.items, "assistant").at(-1)?.streaming).toBe(true);
		expect(transcript.settleStreaming().map((item) => item.kind)).toEqual(["assistant"]);
		expect(transcript.settleStreaming()).toEqual([]);
	});

	it("never leaves a streaming assistant or running tool behind when a capture ends after a terminal agent_end", () => {
		const transcript = replay("chat");
		expect(byKind(transcript.items, "assistant").every((item) => !item.streaming)).toBe(true);
		expect(transcript.settleStreaming()).toEqual([]);
	});

	it("rebuilds from history messages with stable keys and no duplicates", () => {
		const transcript = new Transcript();
		transcript.replaceFromMessages([
			{ role: "user", content: [{ type: "text", text: "第一问" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "想一想" },
					{ type: "text", text: "第一答" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false },
			{ role: "user", content: [{ type: "text", text: "第二问" }] },
		]);

		expect(transcript.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "user"]);
		const assistant = byKind(transcript.items, "assistant")[0];
		expect(assistant.text).toBe("第一答");
		expect(assistant.thinking).toBe("想一想");
		expect(assistant.streaming).toBe(false);
		const tool = byKind(transcript.items, "tool")[0] as ToolItem;
		expect(tool.status).toBe("ok");
		expect(tool.files).toEqual(["/tmp/a.ts"]);
		expect(new Set(transcript.items.map((item) => item.key)).size).toBe(transcript.items.length);
	});

	it("settles a streaming assistant when the process dies mid-turn", () => {
		const transcript = new Transcript();
		transcript.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "半句" }] } });
		transcript.apply({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "半句继续" }] },
			assistantMessageEvent: { type: "text_delta", delta: "继续" },
		});
		transcript.apply({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: {} });

		const changed = transcript.settleStreaming();
		expect(changed.map((item) => item.kind).sort()).toEqual(["assistant", "tool"]);
		const assistant = byKind(transcript.items, "assistant")[0];
		expect(assistant.text).toBe("半句继续");
		expect(assistant.streaming).toBe(false);
		expect(byKind(transcript.items, "tool")[0].status).toBe("unknown");
	});

	it("keeps notices, command output and user echo in order", () => {
		const transcript = new Transcript();
		transcript.apply({ type: "notice", text: "omp 提示", level: "warn" });
		transcript.apply({ type: "command_output", text: "/mcp list 输出" });
		transcript.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "你好" }] } });
		transcript.apply({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "你好" }] } });

		expect(transcript.items.map((item) => item.kind)).toEqual(["notice", "command", "user"]);
		expect(byKind(transcript.items, "user")).toHaveLength(1);
		expect((transcript.items[0] as { level: string }).level).toBe("warn");
	});

	it("does not turn set_model capability notices into chat items", () => {
		const transcript = new Transcript();
		transcript.apply({ type: "model_changed" });
		transcript.apply({
			type: "notice",
			message: "xd://: mounted inspect_image",
			level: "info",
		});
		transcript.apply({
			type: "notice",
			message: "inspect_image is now available: OmniGate/glm-5.3 has no native image input.",
			level: "info",
		});
		transcript.apply({ type: "thinking_level_changed" });
		expect(transcript.items).toEqual([]);
	});

	it("is idempotent when the same history is loaded twice", () => {
		const transcript = new Transcript();
		const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "问题" }] }];
		transcript.replaceFromMessages(messages);
		transcript.replaceFromMessages(messages);
		expect(transcript.items).toHaveLength(1);
	});

	it("exposes a typed user item for the first question", () => {
		const user = byKind(replay("chat").items, "user")[0] as UserItem;
		expect(typeof user.text).toBe("string");
	});
});

describe("Transcript local echo", () => {
	const userEcho = { role: "user" as const, content: [{ type: "text" as const, text: "排队的问题" }] };

	it("does not duplicate the bubble when omp echoes the dispatched text back", () => {
		const transcript = new Transcript();
		transcript.echoUser("排队的问题");
		transcript.apply({ type: "message_start", message: userEcho });
		transcript.apply({ type: "message_end", message: userEcho });
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(1);
		expect(users[0].text).toBe("排队的问题");
	});

	it("still renders a genuinely repeated identical question after the echo was consumed", () => {
		const transcript = new Transcript();
		const repeat = { role: "user" as const, content: [{ type: "text" as const, text: "同一个问题" }] };
		transcript.echoUser("同一个问题");
		transcript.apply({ type: "message_start", message: repeat });
		transcript.apply({ type: "message_end", message: repeat });
		transcript.apply({ type: "message_start", message: repeat });
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(2);
	});

	it("clears the echo queue on history rebuild", () => {
		const transcript = new Transcript();
		transcript.echoUser("排队的问题");
		transcript.replaceFromMessages([]);
		transcript.apply({ type: "message_start", message: userEcho });
		expect(byKind(transcript.items, "user")).toHaveLength(1);
	});
});
