import { describe, expect, it } from "vitest";
import { FrameDecoder, type FrameDecodeError } from "../../src/rpc/frame";
import type { RpcFrame } from "../../src/rpc/types";

const decode = (chunks: (string | Uint8Array)[]) => {
	const errors: FrameDecodeError[] = [];
	const unknown: string[] = [];
	const decoder = new FrameDecoder(undefined, (error) => errors.push(error), (frame) => unknown.push(frame.type));
	const frames: RpcFrame[] = [];
	for (const chunk of chunks) frames.push(...decoder.push(chunk));
	return { frames, errors, unknown, decoder };
};

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** Split `payload` into `count` base64 chunk frames carrying the same total byteLength. */
const chunks = (chunkId: string, payload: string, count: number) => {
	const bytes = Buffer.from(payload, "utf8");
	const size = Math.ceil(bytes.length / count);
	return Array.from({ length: count }, (_, index) =>
		line({
			type: "rpc_chunk",
			chunkId,
			index,
			count,
			byteLength: bytes.length,
			data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
		}),
	);
};

describe("FrameDecoder", () => {
	it("splits newline-delimited JSON and keeps partial lines buffered", () => {
		const { frames, decoder } = decode(['{"type":"turn_start"}\n{"type":"adv', 'isor_cost_changed"}\n{"type":"turn_end"']);
		expect(frames.map((frame) => frame.type)).toEqual(["turn_start", "advisor_cost_changed"]);
		expect(decoder.buffered).toBe(Buffer.byteLength('{"type":"turn_end"'));
	});

	it("accepts multi-byte UTF-8 split across transport chunks", () => {
		const bytes = Buffer.from(`${JSON.stringify({ type: "notice", text: "计划完成" })}\n`, "utf8");
		const { frames, errors } = decode([bytes.subarray(0, bytes.length - 4), bytes.subarray(bytes.length - 4)]);
		expect(errors).toEqual([]);
		expect(frames).toHaveLength(1);
		expect((frames[0] as { text: string }).text).toBe("计划完成");
	});

	it("reports frames outside the modeled contract instead of emitting them", () => {
		const { frames, unknown } = decode([line({ type: "brand_new_frame", payload: 1 })]);
		expect(frames).toEqual([]);
		expect(unknown).toEqual(["brand_new_frame"]);
	});

	it("reassembles a chunked logical frame in index order", () => {
		const payload = JSON.stringify({ type: "notice", text: "x".repeat(2_000) });
		const { frames, errors } = decode(chunks("c1", payload, 3));
		expect(errors).toEqual([]);
		expect(frames).toHaveLength(1);
		expect(frames[0].type).toBe("notice");
		expect((frames[0] as { text: string }).text).toHaveLength(2_000);
	});

	it("rejects a run that starts mid-sequence, changes shape, or arrives out of order", () => {
		const start = chunks("c1", JSON.stringify({ type: "notice", text: "x" }), 2);
		expect(decode([start[1]]).errors[0].message).toContain("started at index 1");

		const [first] = chunks("c2", JSON.stringify({ type: "notice", text: "x".repeat(40) }), 2);
		const reshaped = `${first.slice(0, -2)},"byteLength":1}\n`;
		expect(decode([first, reshaped]).errors[0].message).toContain("changed count/byteLength");

		const [otherChunk] = chunks("other", JSON.stringify({ type: "notice", text: "x" }), 1);
		expect(decode([first, otherChunk]).errors[0].message).toContain("interleaved with c2");
	});

	it("rejects an interrupted chunk run", () => {
		const [first] = chunks("c1", JSON.stringify({ type: "notice", text: "x" }), 2);
		const { frames, errors } = decode([first, line({ type: "turn_start" })]);
		expect(frames.map((frame) => frame.type)).toEqual(["turn_start"]);
		expect(errors.map((error) => error.message)).toEqual([
			expect.stringContaining("interrupted by a turn_start frame"),
		]);
	});

	it("rejects a malformed chunk header, a bad payload and a bad frame body", () => {
		expect(
			decode([line({ type: "rpc_chunk", chunkId: "c", index: 0, count: 2, byteLength: 4, data: "!!!not base64" })])
				.errors[0].message,
		).toContain("malformed rpc_chunk");
		expect(
			decode(
				chunks("c4", JSON.stringify({ type: "notice", text: "中文" }), 2).map((entry) =>
					entry.replace(/"byteLength":\d+/, '"byteLength":999'),
				),
			).errors[0].message,
		).toContain("header said 999");

		const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
		expect(
			decode([
				line({
					type: "rpc_chunk",
					chunkId: "c5",
					index: 0,
					count: 1,
					byteLength: invalidUtf8.length,
					data: invalidUtf8.toString("base64"),
				}),
			]).errors[0].message,
		).toContain("valid UTF-8");
	});

	it("drops an oversized physical frame, complete or partial", () => {
		const limits = { maxFrameBytes: 64, maxReassembledFrameBytes: 128 };
		const errors: FrameDecodeError[] = [];
		const decoder = new FrameDecoder(limits, (error) => errors.push(error));
		decoder.push(line({ type: "notice", text: "y".repeat(200) }));
		decoder.push(`{"type":"notice","text":"${"y".repeat(200)}`);
		expect(errors.map((error) => error.message)).toEqual([
			expect.stringContaining("stdout frame exceeded"),
			expect.stringContaining("incomplete stdout frame exceeded"),
		]);
		expect(decoder.buffered).toBe(0);
	});

	it("rejects a reassembly that exceeds the v2 limit", () => {
		const errors: FrameDecodeError[] = [];
		const decoder = new FrameDecoder({ maxFrameBytes: 4_096, maxReassembledFrameBytes: 32 }, (error) => errors.push(error));
		for (const part of chunks("big", JSON.stringify({ type: "notice", text: "z".repeat(200) }), 2)) decoder.push(part);
		// The aborted run is dropped; the following chunk is a fresh start, not a continuation.
		expect(errors[0].message).toContain("exceeded the reassembly limit");
		expect(errors[1].message).toContain("started at index 1");
		expect(decoder.reassembling).toBe(false);
	});

	it("honours custom limits", () => {
		const errors: FrameDecodeError[] = [];
		const decoder = new FrameDecoder({ maxFrameBytes: 16, maxReassembledFrameBytes: 32 }, (error) => errors.push(error));
		decoder.push(line({ type: "notice", text: "abcdefghij" }));
		expect(errors.map((error) => error.message)).toEqual([expect.stringContaining("physical frame limit")]);
	});
});
