import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FrameDecoder } from "../../src/rpc/frame";
import type { AgentMessage, RpcFrame, ToolExecutionStartFrame } from "../../src/rpc/types";
import { isPlanHandoff } from "../../src/mode";
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

/** A real `get_messages_page` payload: the shape a resumed session rebuilds from. */
function history(name: string): AgentMessage[] {
	const raw = readFileSync(join(import.meta.dirname, "../../../docs/rpc-samples", `${name}.history.json`), "utf8");
	return JSON.parse(raw) as AgentMessage[];
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

	it("shows omp's plan hand-off, the one frame that ends Plan on screen", () => {
		const transcript = replay("plan-yolo");
		const handoff = byKind(transcript.items, "notice").find((item) => item.text.includes("plan approved"));

		// omp reports the hand-off at info level: without the explicit exception in the
		// notice case it would be dropped as runtime chatter and the pill would stay on
		// Plan for the rest of the session. The matcher is also run against the recorded
		// frame, so omp's own wording — not a hand-written one — keeps it honest.
		expect(handoff?.level).toBe("info");
		expect(record("plan-yolo").filter((frame) => isPlanHandoff(frame)).map((frame) => frame.type)).toEqual([
			"notice",
		]);
	});

	it("plans read-only: the draft's only writes are its plan file and the proposal", () => {
		const frames = record("plan-yolo");
		const handoff = frames.findIndex((frame) => isPlanHandoff(frame));
		expect(handoff).toBeGreaterThan(0);
		const draft = frames
			.slice(0, handoff)
			.filter((frame): frame is ToolExecutionStartFrame => frame.type === "tool_execution_start")
			.filter((frame) => frame.toolName !== "read" && frame.toolName !== "glob");

		expect(draft.map((frame) => frame.toolName)).toEqual(["write", "write"]);
		expect(draft.map((frame) => frame.args?.path)).toEqual([
			"local://probe-notes-beta-uppercase-plan.md",
			"xd://propose",
		]);
	});

	it("implements the approved plan in the same turn, as the tool rows show", () => {
		const transcript = replay("plan-yolo");
		const edit = byKind(transcript.items, "tool").find((item) => item.name === "edit");

		expect(edit?.status).toBe("ok");
		expect(edit?.path).toBe("probe-notes.txt");
		expect(edit?.added).toBe(1);
		expect(edit?.removed).toBe(1);
	});

	it("is idempotent when the same history is loaded twice", () => {
		const transcript = new Transcript();
		const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "问题" }] }];
		transcript.replaceFromMessages(messages);
		transcript.replaceFromMessages(messages);
		expect(transcript.items).toHaveLength(1);
	});

	it("collapses repeated auto-retry frames into one in-place line with the latest attempt", () => {
		const transcript = new Transcript();
		const first = transcript.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, errorMessage: "429" });
		expect(first).toHaveLength(1);
		const second = transcript.apply({ type: "auto_retry_start", attempt: 2, maxAttempts: 10, errorMessage: "429" });
		const third = transcript.apply({ type: "auto_retry_start", attempt: 3, maxAttempts: 10, errorMessage: "500" });

		const notices = byKind(transcript.items, "notice");
		expect(notices).toHaveLength(1);
		expect(notices[0].key).toBe("retry:current");
		expect(notices[0].text).toContain("3/10");
		expect(notices[0].text).toContain("500");
		// Every frame re-emitted the SAME item key: the webview replaces in place.
		expect(second[0].key).toBe(first[0].key);
		expect(third[0].key).toBe(first[0].key);
		expect(transcript.takeRemovedKeys()).toEqual([]);
	});

	it("removes the retry line when the run recovers, keeping it on terminal failure", () => {
		const transcript = new Transcript();
		transcript.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, errorMessage: "429" });
		transcript.apply({ type: "auto_retry_end", success: true });
		expect(byKind(transcript.items, "notice")).toHaveLength(0);
		expect(transcript.takeRemovedKeys()).toEqual(["retry:current"]);

		const fatal = new Transcript();
		fatal.apply({ type: "auto_retry_start", attempt: 10, maxAttempts: 10, errorMessage: "429" });
		const ended = fatal.apply({ type: "auto_retry_end", success: false, attempt: 10, finalError: "budget exhausted" });
		const notices = byKind(fatal.items, "notice");
		expect(notices).toHaveLength(1);
		expect(notices[0].level).toBe("error");
		expect(notices[0].text).toContain("budget exhausted");
		expect(ended[0].key).toBe("retry:current");
		expect(fatal.takeRemovedKeys()).toEqual([]);
	});

	it("drops a stale warn retry line when the run settles, but keeps the failure record", () => {
		const transcript = new Transcript();
		transcript.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, errorMessage: "429" });
		const changed = transcript.settleStreaming();
		expect(byKind(transcript.items, "notice")).toHaveLength(0);
		expect(changed.some((item) => item.key === "retry:current")).toBe(true);

		const fatal = new Transcript();
		fatal.apply({ type: "auto_retry_end", success: false, attempt: 10, finalError: "gone" });
		fatal.settleStreaming();
		expect(byKind(fatal.items, "notice")).toHaveLength(1);
	});

	it("exposes a typed user item for the first question", () => {
		const user = byKind(replay("chat").items, "user")[0] as UserItem;
		expect(typeof user.text).toBe("string");
	});
});

describe("Tool rows over a real capture", () => {
	const tool = (transcript: Transcript, name: string) => byKind(transcript.items, "tool").find((item) => item.name === name);

	it("gives every row its file, and edit its real diff counts", () => {
		const transcript = replay("edit");

		const edit = tool(transcript, "edit");
		expect(edit?.status).toBe("ok");
		expect(edit?.path).toBe("probe-notes.txt");
		expect(edit?.added).toBe(1);
		expect(edit?.removed).toBe(1);

		const read = tool(transcript, "read");
		expect(read?.path).toBe("probe-notes.txt");
		expect(read?.added).toBeUndefined();

		// omp's write result carries no diff: the row's `+N` is the written content.
		const write = tool(transcript, "write");
		expect(write?.path).toBe("probe-extra.txt");
		expect(write?.added).toBe(3);
		expect(write?.removed).toBeUndefined();
	});

	it("names an edit from its patch header before the diff lands", () => {
		const transcript = new Transcript();
		for (const frame of record("edit")) {
			transcript.apply(frame);
			if (frame.type === "tool_execution_start" && frame.toolName === "edit") break;
		}
		const edit = tool(transcript, "edit");
		expect(edit?.status).toBe("running");
		expect(edit?.path).toBe("probe-notes.txt");
		expect(edit?.added).toBeUndefined();
	});

	it("keeps the rows intact when the same turn is replayed from history", () => {
		const transcript = new Transcript();
		transcript.replaceFromMessages(history("edit"));

		// A resumed session must not lose the numbers: the tool results' `details`
		// survive the round trip through get_messages_page.
		expect(tool(transcript, "edit")?.added).toBe(1);
		expect(tool(transcript, "edit")?.removed).toBe(1);
		expect(tool(transcript, "write")?.added).toBe(3);
		expect(tool(transcript, "read")?.path).toBe("probe-notes.txt");
	});

	it("times a thinking row across the wait and the thinking stream", () => {
		// One second per frame makes the expectations arithmetic instead of a range.
		let clock = 0;
		let lastEnd = 0;
		let streamStart = 0;
		let expected: number | undefined;
		let streamOnly: number | undefined;
		const transcript = new Transcript({ now: () => clock });
		record("edit").forEach((frame, index) => {
			clock = index * 1000;
			if (frame.type === "message_end") lastEnd = index;
			if (frame.type === "message_start" && frame.message.role === "assistant") streamStart = index;
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "thinking_end") {
				expected = (index - lastEnd) * 1000;
				streamOnly = (index - streamStart) * 1000;
			}
			transcript.apply(frame);
		});

		const timed = byKind(transcript.items, "assistant").filter((item) => item.thinkingMs !== undefined);
		expect(timed).toHaveLength(1);
		expect(timed[0].thinkingMs).toBe(expected);
		// omp emits the assistant `message_start` at the first token, so the wait before
		// it belongs to the number: a stream-only reading would undersell the row.
		expect(timed[0].thinkingMs).toBeGreaterThan(streamOnly ?? Number.POSITIVE_INFINITY);
	});

	it("never invents a thinking duration for a turn read back from history", () => {
		const transcript = new Transcript({ now: () => 600_000 });
		transcript.replaceFromMessages(history("edit"));
		const thinking = byKind(transcript.items, "assistant").filter((item) => item.thinking.trim().length > 0);
		expect(thinking.length).toBeGreaterThan(0);
		expect(thinking.every((item) => item.thinkingMs === undefined)).toBe(true);
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

describe("Transcript images on a user turn", () => {
	const IMAGE = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

	it("rebuilds the images a resumed session's user turn carries", () => {
		const transcript = new Transcript();
		transcript.replaceFromMessages([
			{ role: "user", content: [{ type: "text", text: "看这张图" }, IMAGE] },
		]);
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(1);
		expect(users[0].images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
	});

	it("keeps an image-only turn, which omp stores as a text part of its own", () => {
		const transcript = new Transcript();
		transcript.replaceFromMessages([{ role: "user", content: [IMAGE] }]);
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(1);
		expect(users[0].text).toBe("");
		expect(users[0].images).toHaveLength(1);
	});

	it("carries the dispatched image bytes on the echoed bubble, without duplicating it", () => {
		const transcript = new Transcript();
		// The picked file's name is composer chrome: the host only ever sees bytes and type.
		transcript.echoUser("看这张图", [{ data: "aGVsbG8=", mimeType: "image/png" }]);
		transcript.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "看这张图" }, IMAGE] } });
		transcript.apply({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "看这张图" }, IMAGE] } });
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(1);
		expect(users[0].images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
	});

	it("echoes a turn that is images alone", () => {
		const transcript = new Transcript();
		expect(transcript.echoUser("   ")).toEqual([]);
		expect(transcript.echoUser("", [{ data: "aGVsbG8=", mimeType: "image/png" }])).toHaveLength(1);
		expect(byKind(transcript.items, "user")[0].images).toHaveLength(1);
	});

	it("merges omp's own frame for an image-only turn instead of announcing it twice", () => {
		const transcript = new Transcript();
		const frame = { role: "user" as const, content: [{ type: "text" as const, text: "" }, IMAGE] };
		transcript.echoUser("", [{ data: "aGVsbG8=", mimeType: "image/png" }]);
		// Both frames must render nothing new: a returned item is an item the webview appends
		// to the list it already holds, so re-returning the bubble draws it twice.
		expect(transcript.apply({ type: "message_start", message: frame })).toEqual([]);
		expect(transcript.apply({ type: "message_end", message: frame })).toEqual([]);
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(1);
		expect(users[0].text).toBe("");
		expect(users[0].images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
	});

	it("still renders a user frame omp sends on its own with no text queued", () => {
		const transcript = new Transcript();
		transcript.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "" }] } });
		const users = byKind(transcript.items, "user");
		expect(users).toHaveLength(1);
		expect(users[0].images).toBeUndefined();
	});
});
