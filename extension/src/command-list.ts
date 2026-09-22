import type { HostEnv } from "./config";
import type { Disposable } from "./emitter";
import { RpcClient } from "./rpc/client";
import { RpcProcess } from "./rpc/process";
import {
	PROTOCOL_VERSION,
	isFailure,
	type AvailableCommand,
	type GetAvailableCommandsData,
} from "./rpc/types";
import type { SlashCommandView } from "./shared/protocol";

/**
 * The `/` command list, for both composers.
 *
 * A live instance has it from its own handshake; the entry page has no instance, so the
 * probe below asks a throwaway `omp` before anything is running. One mapping for both, so
 * the popup cannot show one list per page.
 */
export function commandViews(commands: readonly AvailableCommand[]): SlashCommandView[] {
	return commands.map((command) => ({
		name: command.name,
		description: command.description,
		group: command.source,
	}));
}

/** A probe answers in under a second on this machine; the leash is for a stuck omp, not slowness. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The slash commands a *new* session would offer.
 *
 * Only RPC publishes this list (`get_available_commands`; no CLI subcommand prints it), so
 * the entry page needs one real `omp` to ask. The probe is disposable and `--no-session`
 * keeps it out of the session list: it is a read, not a session (verified against omp
 * 18.1.2: it writes no jsonl). A failure is logged and yields no commands, which is the
 * same empty `/` list a live instance reports when it has none.
 */
export async function readCommandList(env: HostEnv): Promise<SlashCommandView[]> {
	let process: RpcProcess;
	try {
		process = RpcProcess.spawn({
			ompPath: env.ompPath,
			cwd: env.workspaceRoot,
			args: ["--no-session"],
			logger: env.logger,
		});
	} catch (error) {
		env.logger.warn(`slash 命令列表探测失败：${detail(error)}`);
		return [];
	}

	const client = new RpcClient(
		{ stdin: process.stdin, stdout: process.stdout },
		{ requestTimeoutMs: PROBE_TIMEOUT_MS },
	);
	try {
		await waitForReady(client, process);
		const negotiation = await client.request({ type: "negotiate_protocol", protocolVersion: PROTOCOL_VERSION });
		if (!isFailure(negotiation)) client.markNegotiated();
		const response = await client.request<GetAvailableCommandsData>({ type: "get_available_commands" });
		if (isFailure(response)) {
			env.logger.warn(`get_available_commands 失败：${response.error}`);
			return [];
		}
		return commandViews(response.data?.commands ?? []);
	} catch (error) {
		env.logger.warn(`slash 命令列表探测失败：${detail(error)}`);
		return [];
	} finally {
		client.dispose();
		// Closing stdin is omp's documented exit path; `terminate` escalates if it hangs.
		await process.terminate();
	}
}

/** omp prints `ready` before it accepts anything; the probe must not race that. */
function waitForReady(client: RpcClient, process: RpcProcess): Promise<void> {
	if (client.capabilities.serverProtocolVersion > 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const subscriptions: Disposable[] = [];
	const cleanup = () => {
		clearTimeout(timer);
		for (const subscription of subscriptions) subscription.dispose();
	};
	subscriptions.push(
		client.events.on("ready", () => {
			cleanup();
			resolve();
		}),
		// A probe that dies or never spawns (omp missing, wrong `ompPath`) must fail now: the
		// composer waits on this read before its `/` list is complete, so the leash is a last
		// resort, not the ordinary path out of a dead process.
		process.events.on("exit", () => {
			cleanup();
			reject(new Error("omp 在就绪前退出"));
		}),
		process.events.on("spawnError", (error) => {
			cleanup();
			reject(new Error(`omp 起不来：${detail(error)}`));
		}),
	);
	const timer = setTimeout(() => {
		cleanup();
		reject(new Error(`omp ${PROBE_TIMEOUT_MS}ms 内没有输出 ready 帧`));
	}, PROBE_TIMEOUT_MS);
	return promise;
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
