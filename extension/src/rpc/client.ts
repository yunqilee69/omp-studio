import type { Readable, Writable } from "node:stream";
import { Emitter } from "../emitter";
import { DEFAULT_LIMITS, FrameDecoder, type DecoderLimits, type FrameDecodeError } from "./frame";
import {
	PROTOCOL_VERSION,
	isExtensionUIRequest,
	isFailure,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	type ReadyFrame,
	type RpcCommand,
	type RpcFrame,
	type RpcResponse,
	type UnknownFrame,
} from "./types";

export interface RpcClientEvents {
	frame: RpcFrame;
	ready: ReadyFrame;
	/** A blocking extension UI request (select/confirm/input/editor). */
	uiRequest: ExtensionUIRequest;
	/** Response whose id was already settled (e.g. a late prompt scheduling failure). */
	lateResponse: RpcResponse;
	/** A frame type this extension does not model. */
	unknownFrame: UnknownFrame;
	decodeError: FrameDecodeError;
	error: Error;
	fatal: Error;
}

export interface RpcClientOptions {
	limits?: DecoderLimits;
	requestTimeoutMs?: number;
}

interface Pending {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * JSONL client for `omp --mode rpc`.
 *
 * Owns protocol framing, request/response correlation by `id`, and the
 * extension UI channel. It never interprets agent semantics — that is Instance's
 * job — and it never spawns processes: RpcProcess owns the child.
 */
export class RpcClient {
	readonly events = new Emitter<RpcClientEvents>();
	readonly capabilities = {
		alignment: "omp",
		protocolVersion: PROTOCOL_VERSION,
		serverProtocolVersion: 0,
		maxFrameBytes: DEFAULT_LIMITS.maxFrameBytes,
		maxReassembledFrameBytes: DEFAULT_LIMITS.maxReassembledFrameBytes,
		negotiated: false,
	};

	private readonly decoder: FrameDecoder;
	private readonly pending = new Map<string, Pending>();
	private readonly settled = new Set<string>();
	private sequence = 0;
	private disposed = false;

	constructor(
		private readonly streams: { stdin: Writable; stdout: Readable },
		private readonly options: RpcClientOptions = {},
	) {
		this.decoder = new FrameDecoder(
			options.limits ?? DEFAULT_LIMITS,
			(error) => this.events.emit("decodeError", error),
			(frame) => this.events.emit("unknownFrame", frame),
		);
		streams.stdout.on("data", this.onData);
		streams.stdout.on("error", this.onStreamError);
		streams.stdin.on("error", this.onStreamError);
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	/** Send a command and wait for its correlated response. */
	async request<T = unknown>(command: RpcCommand): Promise<RpcResponse<T>> {
		if (this.disposed) throw new Error("RpcClient is disposed");
		const id = command.id ?? this.nextId();
		const payload = { ...command, id };
		const response = await new Promise<RpcResponse>((resolve, reject) => {
			const timer = this.options.requestTimeoutMs === undefined || this.options.requestTimeoutMs > 0
				? setTimeout(() => {
						this.pending.delete(id);
						this.settled.add(id);
						reject(new Error(`omp did not answer ${command.type} within ${this.timeoutMs}ms`));
					}, this.timeoutMs)
				: undefined;
			this.pending.set(id, { command: command.type, resolve, reject, timer });
			this.write(payload);
		});
		return response as RpcResponse<T>;
	}

	/** Send a command without waiting (acks are still surfaced through `lateResponse`). */
	send(command: RpcCommand): void {
		if (this.disposed) return;
		this.write({ ...command, id: command.id ?? this.nextId() });
	}

	/** Answer a blocking extension UI request. */
	respondUI(response: ExtensionUIResponse): void {
		if (this.disposed) return;
		this.writeRaw(response);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.streams.stdout.off("data", this.onData);
		this.streams.stdout.off("error", this.onStreamError);
		this.streams.stdin.off("error", this.onStreamError);
		for (const [id, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(new Error(`RpcClient disposed while awaiting ${entry.command}`));
			this.pending.delete(id);
		}
		this.events.clear();
	}

	private get timeoutMs(): number {
		const configured = this.options.requestTimeoutMs;
		return configured === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : configured;
	}

	private nextId(): string {
		this.sequence += 1;
		return `ostudio_${this.sequence}`;
	}

	private write(command: object): void {
		this.streams.stdin.write(`${JSON.stringify(command)}\n`);
	}

	private writeRaw(frame: object): void {
		this.streams.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	private readonly onStreamError = (error: Error): void => {
		this.events.emit("error", error);
	};

	private readonly onData = (chunk: Buffer | string): void => {
		let frames: RpcFrame[];
		try {
			frames = this.decoder.push(chunk);
		} catch (error) {
			this.events.emit("fatal", error instanceof Error ? error : new Error(String(error)));
			return;
		}
		for (const frame of frames) this.dispatch(frame);
	};

	private dispatch(frame: RpcFrame): void {
		if (frame.type === "ready") {
			const ready = frame as ReadyFrame;
			this.capabilities.serverProtocolVersion = ready.protocolVersion;
			this.capabilities.negotiated = false;
			if (typeof ready.maxFrameBytes === "number") this.capabilities.maxFrameBytes = ready.maxFrameBytes;
			if (typeof ready.maxReassembledFrameBytes === "number") {
				this.capabilities.maxReassembledFrameBytes = ready.maxReassembledFrameBytes;
			}
			this.events.emit("ready", ready);
		} else if (frame.type === "response") {
			this.settle(frame as RpcResponse);
		}

		if (isExtensionUIRequest(frame)) this.events.emit("uiRequest", frame);

		this.events.emit("frame", frame);
	}

	private settle(response: RpcResponse): void {
		const id = response.id;
		if (typeof id === "string") {
			const entry = this.pending.get(id);
			if (entry) {
				this.pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				this.settled.add(id);
				if (this.settled.size > 512) {
					const oldest = this.settled.values().next();
					if (!oldest.done) this.settled.delete(oldest.value);
				}
				entry.resolve(response);
				// A settled prompt can still fail later with the same id; that response
				// arrives as a second frame and is surfaced as lateResponse.
				return;
			}
			if (this.settled.has(id)) {
				this.events.emit("lateResponse", response);
				return;
			}
		}
		if (isFailure(response)) {
			this.events.emit("lateResponse", response);
		}
	}

	/** Mark protocol v2 negotiated after a successful handshake. */
	markNegotiated(): void {
		this.capabilities.negotiated = true;
		this.capabilities.protocolVersion = PROTOCOL_VERSION;
	}
}
