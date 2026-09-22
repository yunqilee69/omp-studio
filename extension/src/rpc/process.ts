import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Emitter } from "../emitter";
import type { Logger } from "../config";

export interface RpcProcessEvents {
	stderr: string;
	exit: { code: number | null; signal: NodeJS.Signals | null };
	spawnError: Error;
}

export interface RpcProcessOptions {
	ompPath: string;
	cwd: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
	logger: Logger;
	/** Grace period before SIGKILL when terminating the tree. */
	killGraceMs?: number;
}

const STDERR_TAIL_LIMIT = 8_192;

/**
 * One `omp --mode rpc` child process.
 *
 * Lifecycle contract (AGENTS.md): closing stdin makes omp drain and exit 0; a
 * closed tab kills the whole process tree so no `omp` outlives its tab. The child
 * inherits the VS Code environment so provider credentials behave as in a terminal.
 */
export class RpcProcess {
	readonly events = new Emitter<RpcProcessEvents>();

	readonly pid: number | undefined;
	readonly stdin: ChildProcessWithoutNullStreams["stdin"];
	readonly stdout: ChildProcessWithoutNullStreams["stdout"];

	private stderrBuffer = "";
	private exited = false;
	private terminating = false;

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly options: RpcProcessOptions,
	) {
		this.pid = child.pid;
		this.stdin = child.stdin;
		this.stdout = child.stdout;

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrBuffer = (this.stderrBuffer + chunk).slice(-STDERR_TAIL_LIMIT);
			this.events.emit("stderr", chunk);
		});
		child.on("error", (error) => this.events.emit("spawnError", error));
		child.on("exit", (code, signal) => {
			this.exited = true;
			this.events.emit("exit", { code, signal });
		});
	}

	static spawn(options: RpcProcessOptions): RpcProcess {
		const args = ["--mode", "rpc", "--cwd", options.cwd, ...(options.args ?? [])];
		options.logger.info(`spawn: ${options.ompPath} ${args.join(" ")}`);
		const child = spawn(options.ompPath, args, {
			cwd: options.cwd,
			// Inherit the host environment so provider keys match a terminal run.
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group so the tab can kill the whole subtree (POSIX).
			detached: process.platform !== "win32",
		});
		return new RpcProcess(child, options);
	}

	get isExited(): boolean {
		return this.exited;
	}

	get stderrTail(): string {
		return this.stderrBuffer.trim();
	}

	/**
	 * Ask omp to finish (stdin close is its documented exit path), then make sure
	 * the process group is gone.
	 */
	async terminate(): Promise<void> {
		if (this.terminating) return;
		this.terminating = true;
		const exited = new Promise<void>((resolve) => {
			if (this.exited) return resolve();
			this.child.once("exit", () => resolve());
		});

		try {
			this.stdin.end();
		} catch {
			// stdin already closed; the exit handler still fires.
		}

		const grace = this.options.killGraceMs ?? 3_000;
		const race = await Promise.race([
			exited.then(() => "exited" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), grace)),
		]);
		if (race === "exited") return;

		this.killTree("SIGTERM");
		const afterTerm = await Promise.race([
			exited.then(() => "exited" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), grace)),
		]);
		if (afterTerm === "exited") return;

		this.options.logger.warn(`omp ${this.pid} ignored SIGTERM; sending SIGKILL`);
		this.killTree("SIGKILL");
		await Promise.race([
			exited,
			new Promise<void>((resolve) => setTimeout(resolve, grace).unref()),
		]);
	}

	/** Kill synchronously (used from deactivate, where awaiting is not possible). */
	killTree(signal: NodeJS.Signals = "SIGTERM"): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
			return;
		}
		try {
			// Negative pid targets the detached process group.
			process.kill(-pid, signal);
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				// already gone
			}
		}
	}
}
