import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostEnv, Logger } from "../../src/config";
import { Instance } from "../../src/instance";
import { InstanceManager } from "../../src/instance-manager";
import { readSessionMessages } from "../../src/session-file";
import type { Item } from "../../src/shared/protocol";

/**
 * Live acceptance against real `omp --mode rpc` processes. Opt in:
 *
 *     OMP_STUDIO_INTEGRATION=1 npx vitest run test/integration
 *
 * Each test spawns real instances in a throwaway workspace; the probe prompt tells
 * omp not to call tools, so a run costs one short model round trip.
 */
const live = process.env.OMP_STUDIO_INTEGRATION === "1";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const managers: InstanceManager[] = [];

/** Doesn't call tools, so no approval can block the run. */
const PING = "不要调用任何工具，直接回复两个字母：OK";

function makeEnv(overrides: Partial<HostEnv> = {}): HostEnv {
	return {
		ompPath: process.env.OMP_STUDIO_OMP_PATH ?? "omp",
		workspaceRoot: mkdtempSync(join(tmpdir(), "omp-studio-live-")),
		maxInstances: 4,
		approvalMode: "inherit",
		homeDir: process.env.HOME ?? tmpdir(),
		logger: quiet,
		...overrides,
	};
}

function makeManager(env: HostEnv): InstanceManager {
	const manager = new InstanceManager(env);
	managers.push(manager);
	return manager;
}

type Probe<T> = () => T | undefined | Promise<T | undefined>;

/**
 * Polls the *real* child process, so wall-clock time is unavoidable here: the
 * observable is a separate OS process, there is no fake clock to advance.
 */
async function waitUntil<T>(label: string, check: Probe<T>, timeoutMs = 150_000, intervalMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`超时等待：${label}`);
		await sleep(intervalMs);
	}
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Guards a real omp turn: the process may hang, so a watchdog is required. */
function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 150_000): Promise<T> {
	const { promise: guarded, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`超时等待：${label}`)), timeoutMs);
	promise.then(
		(value) => {
			clearTimeout(timer);
			resolve(value);
		},
		(error: unknown) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		},
	);
	return guarded;
}

function onceRunFinished(instance: Instance, timeoutMs = 150_000): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	instance.events.on("runFinished", () => resolve());
	return withTimeout(promise, "terminal agent_end", timeoutMs);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const assistantText = (items: readonly Item[]): string =>
	items
		.flatMap((item) => (item.kind === "assistant" ? [item.text] : []))
		.join("");

const idle = (instance: Instance) => () => (instance.phase === "idle" ? true : undefined);

describe.skipIf(!live)("live omp --mode rpc", () => {
	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.disposeAll();
	});

	it("spawns, handshakes and reaches idle with models and a session file", async () => {
		const env = makeEnv();
		const instance = new Instance(env, { id: "tab-1", cwd: env.workspaceRoot });
		await instance.start();
		await waitUntil("phase idle", idle(instance));

		expect(instance.pid).toBeGreaterThan(0);
		expect(instance.sessionFile).toMatch(/\.jsonl$/);
		const models = await waitUntil("models", () => (instance.models.length > 0 ? instance.models : undefined));
		expect(models.every((model) => model.provider && model.id)).toBe(true);
		expect(instance.state().model).toBeTruthy();
		expect(instance.state().provider).toBeTruthy();
		expect(instance.state().protocol.negotiated).toBe(true);

		const pid = instance.pid ?? 0;
		await instance.dispose();
		await waitUntil("child exit", () => (alive(pid) ? undefined : true));
	});

	it("answers a prompt, streams it into the transcript and persists it", async () => {
		const env = makeEnv();
		const instance = new Instance(env, { id: "tab-1", cwd: env.workspaceRoot });
		await instance.start();
		await waitUntil("phase idle", idle(instance));

		const streamed: Item[] = [];
		instance.events.on("items", (items) => streamed.push(...items));
		const finished = onceRunFinished(instance);
		await instance.sendPrompt(PING);
		await finished;

		expect(assistantText(instance.transcript.items)).toMatch(/ok/i);
		expect(assistantText(streamed)).toMatch(/ok/i);
		expect(instance.transcript.items.filter((item) => item.kind === "assistant").every((item) => !item.streaming)).toBe(true);
		expect(instance.phase).toBe("idle");

		const file = instance.sessionFile ?? "";
		const persisted = await waitUntil("session jsonl persisted", async () => {
			const entries = await readSessionMessages(file);
			return entries.length >= 2 ? entries : undefined;
		});
		expect(persisted.some((entry) => entry.role === "user")).toBe(true);
		expect(persisted.some((entry) => entry.role === "assistant")).toBe(true);
	});

	it("keeps a background tab running while another tab is selected", async () => {
		const env = makeEnv();
		const manager = makeManager(env);
		const first = await manager.create();
		const second = await manager.create();
		expect(first && second).toBeTruthy();
		if (!first || !second) return;
		await waitUntil("both idle", () => (first.phase === "idle" && second.phase === "idle" ? true : undefined));

		const secondDone = onceRunFinished(second);
		await second.sendPrompt(PING);
		manager.select(first.id); // user switches away mid-run
		await secondDone;

		expect(first.phase).toBe("idle");
		expect(second.phase).toBe("idle");
		expect(assistantText(second.transcript.items)).toMatch(/ok/i);
		expect(manager.getTabs().find((tab) => tab.id === second.id)?.summary.unread).toBe(true);
	});

	it("refuses to open one session jsonl in two tabs", async () => {
		const env = makeEnv();
		const manager = makeManager(env);
		const first = await manager.create();
		if (!first) throw new Error("没有创建 Tab");
		await waitUntil("session file", () => first.sessionFile);

		const duplicate = await manager.create({ resumeFile: first.sessionFile ?? "" });
		expect(duplicate).toBeUndefined();
		expect(manager.all).toHaveLength(1);
		expect(manager.activeTabId).toBe(first.id);
	});

	it("reaps every child process on teardown", async () => {
		const env = makeEnv();
		const manager = makeManager(env);
		const first = await manager.create();
		const second = await manager.create();
		const pids = [first?.pid, second?.pid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
		expect(pids).toHaveLength(2);

		await manager.disposeAll();
		await waitUntil("children gone", () => (pids.every((pid) => !alive(pid)) ? true : undefined));
		expect(manager.all).toHaveLength(0);
	});

	it("renders a killed process as a non-running tab", async () => {
		const env = makeEnv();
		const instance = new Instance(env, { id: "tab-1", cwd: env.workspaceRoot });
		await instance.start();
		await waitUntil("phase idle", idle(instance));

		instance.kill(); // the process dies under the tab
		await waitUntil("failed", () =>
			instance.phase === "failed" || instance.phase === "gone" ? true : undefined,
		);
		expect(instance.tabSummary(false).running).toBe(false);
		expect(instance.state().failure || instance.phase !== "idle").toBeTruthy();
	});

	it("fails loudly when omp is missing", async () => {
		const env = makeEnv({ ompPath: join(mkdtempSync(join(tmpdir(), "omp-studio-missing-")), "definitely-not-omp") });
		const instance = new Instance(env, { id: "tab-1", cwd: env.workspaceRoot });
		await instance.start();
		await waitUntil("failed", () => (instance.phase === "failed" ? true : undefined));
		expect(instance.state().failure).toContain(env.ompPath);
	});
});
