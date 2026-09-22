import { KNOWN_FRAME_TYPES, type RpcChunkFrame, type RpcFrame, type UnknownFrame } from "./types";

export interface DecoderLimits {
	/** Max bytes of a single physical (v1) stdout frame. */
	maxFrameBytes: number;
	/** Max bytes of a reassembled v2 logical frame. */
	maxReassembledFrameBytes: number;
}

export const DEFAULT_LIMITS: DecoderLimits = {
	maxFrameBytes: 1_048_576,
	maxReassembledFrameBytes: 67_108_864,
};

const NEWLINE = 0x0a;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class FrameDecodeError extends Error {
	constructor(
		message: string,
		readonly context?: { chunkId?: string; index?: number },
	) {
		super(message);
		this.name = "FrameDecodeError";
	}
}

interface PendingChunk {
	chunkId: string;
	nextIndex: number;
	count: number;
	byteLength: number;
	parts: Uint8Array[];
	bytes: number;
}

/**
 * Newline-delimited JSON frame decoder with protocol v2 chunk reassembly.
 *
 * Lossless transport rules (omp://rpc.md): an oversized logical frame arrives as
 * an uninterrupted run of `rpc_chunk` frames whose base64 segments must be
 * validated (chunkId/index/count/byteLength), assorted in index order, decoded as
 * strict UTF-8 and parsed as one JSON object. Interleaved or interrupted
 * sequences are rejected.
 */
export class FrameDecoder {
	private buffer = new Uint8Array(0);
	private pending: PendingChunk | null = null;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });
	private readonly encoder = new TextEncoder();

	constructor(
		private readonly limits: DecoderLimits = DEFAULT_LIMITS,
		private readonly onError: (error: FrameDecodeError) => void = () => {},
		/** Frames outside `KNOWN_FRAME_TYPES`: kept visible, never rendered. */
		private readonly onUnknown: (frame: UnknownFrame) => void = () => {},
	) {}

	/** Feed transport bytes; returns every complete logical frame. */
	push(chunk: Uint8Array | string): RpcFrame[] {
		const bytes = typeof chunk === "string" ? this.encoder.encode(chunk) : chunk;
		if (bytes.length > 0) this.buffer = concat(this.buffer, bytes);

		const frames: RpcFrame[] = [];
		for (;;) {
			const newline = this.buffer.indexOf(NEWLINE);
			if (newline === -1) break;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.handleLine(line, frames);
		}
		if (this.buffer.length > this.limits.maxFrameBytes) {
			this.buffer = new Uint8Array(0);
			this.fail("incomplete stdout frame exceeded the advertised physical frame limit");
		}
		return frames;
	}

	/** Bytes retained for an incomplete frame. */
	get buffered(): number {
		return this.buffer.length;
	}

	/** True while a chunked sequence is being reassembled. */
	get reassembling(): boolean {
		return this.pending !== null;
	}

	private handleLine(line: Uint8Array, out: RpcFrame[]): void {
		if (line.length === 0) return;
		if (line.length > this.limits.maxFrameBytes) {
			// v2 chunks anything larger, so an oversized physical line is a protocol fault.
			this.fail("stdout frame exceeded the advertised physical frame limit");
			return;
		}
		let text: string;
		try {
			text = this.decoder.decode(line);
		} catch {
			this.fail("stdout frame was not valid UTF-8");
			return;
		}
		if (text.trim().length === 0) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.fail("stdout frame was not JSON");
			return;
		}
		const frame = asFrame(parsed);
		if (!frame) {
			this.fail("stdout frame was not a JSON object with a string type");
			return;
		}
		if (frame.type === "rpc_chunk") {
			this.handleChunk(frame as RpcChunkFrame, out);
			return;
		}
		this.acceptParsed(parsed, out, "stdout frame");
	}

	private handleChunk(chunk: RpcChunkFrame, out: RpcFrame[]): void {
		const { chunkId, index, count, byteLength, data } = chunk;
		if (
			typeof chunkId !== "string" ||
			!Number.isInteger(index) ||
			!Number.isInteger(count) ||
			!Number.isInteger(byteLength) ||
			count < 1 ||
			index < 0 ||
			index >= count ||
			byteLength < 0 ||
			typeof data !== "string" ||
			!BASE64.test(data)
		) {
			this.fail("malformed rpc_chunk frame");
			return;
		}

		let segment: Uint8Array;
		try {
			segment = Uint8Array.from(Buffer.from(data, "base64"));
		} catch {
			this.fail("rpc_chunk payload was not valid base64", { chunkId, index });
			return;
		}

		if (!this.pending) {
			if (index !== 0) {
				this.fail(`rpc_chunk ${chunkId} started at index ${index}`, { chunkId, index });
				return;
			}
			this.pending = { chunkId, nextIndex: 0, count, byteLength, parts: [], bytes: 0 };
		} else {
			if (this.pending.chunkId !== chunkId) {
				this.fail(`rpc_chunk ${chunkId} interleaved with ${this.pending.chunkId}`, { chunkId, index });
				this.pending = null;
				return;
			}
			if (this.pending.count !== count || this.pending.byteLength !== byteLength) {
				this.fail(`rpc_chunk ${chunkId} changed count/byteLength mid-sequence`, { chunkId, index });
				this.pending = null;
				return;
			}
			if (index !== this.pending.nextIndex) {
				this.fail(`rpc_chunk ${chunkId} arrived out of order at index ${index}`, { chunkId, index });
				this.pending = null;
				return;
			}
		}

		const pending = this.pending;
		pending.parts.push(segment);
		pending.bytes += segment.length;
		pending.nextIndex = index + 1;

		if (pending.bytes > this.limits.maxReassembledFrameBytes) {
			this.pending = null;
			this.fail(`reassembled frame ${chunkId} exceeded the reassembly limit`, { chunkId, index });
			return;
		}
		if (pending.nextIndex < pending.count) return;

		this.pending = null;
		if (pending.bytes !== pending.byteLength) {
			this.fail(`reassembled frame ${chunkId} was ${pending.bytes} bytes, header said ${pending.byteLength}`, {
				chunkId,
			});
			return;
		}
		let text: string;
		try {
			text = this.decoder.decode(concatAll(pending.parts, pending.bytes));
		} catch {
			this.fail(`reassembled frame ${chunkId} was not valid UTF-8`, { chunkId });
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.fail(`reassembled frame ${chunkId} was not JSON`, { chunkId });
			return;
		}
		this.acceptParsed(parsed, out, `reassembled frame ${chunkId}`);
	}

	/** Shared tail of both transport paths: validate, split known from unknown, emit. */
	private acceptParsed(parsed: unknown, out: RpcFrame[], label: string): void {
		const frame = asFrame(parsed);
		if (!frame) {
			this.fail(`${label} was not a JSON object with a string type`);
			return;
		}
		if (frame.type !== "rpc_chunk" && !(frame.type in KNOWN_FRAME_TYPES)) {
			this.onUnknown(frame as UnknownFrame);
			return;
		}
		if (this.pending && frame.type !== "rpc_chunk") {
			this.fail(`chunked frame ${this.pending.chunkId} was interrupted by a ${frame.type} frame`, {
				chunkId: this.pending.chunkId,
				index: this.pending.nextIndex,
			});
			this.pending = null;
		}
		out.push(frame as RpcFrame);
	}

	private fail(message: string, context?: FrameDecodeError["context"]): void {
		this.onError(new FrameDecodeError(message, context));
	}
}

/** Boundary guard for `JSON.parse` output: only a string `type` is checked, then dispatch. */
function asFrame(value: unknown): RpcFrame | UnknownFrame | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.type !== "string") return null;
	return record as unknown as RpcFrame;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function concatAll(parts: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
