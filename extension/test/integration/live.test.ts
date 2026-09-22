import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCommandList } from "../../src/command-list";
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

/** A 1x1 red PNG: enough for omp to store a real image part without a big prompt. */
const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

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
		await instance.refreshModels();
		const models = instance.models;
		expect(models.length).toBeGreaterThan(0);
		expect(instance.state().modelsLoading).toBe(false);
		expect(models.every((model) => model.provider && model.id)).toBe(true);
		expect(instance.state().model).toBeTruthy();
		expect(instance.state().provider).toBeTruthy();
		expect(instance.state().protocol.negotiated).toBe(true);

		const pid = instance.pid ?? 0;
		await instance.dispose();
		await waitUntil("child exit", () => (alive(pid) ? undefined : true));
	});

	it("announces the slash command list once the handshake answers", async () => {
		const env = makeEnv();
		const manager = makeManager(env);
		const published: string[][] = [];
		manager.events.on("commands", ({ id }) =>
			published.push((manager.get(id)?.commands ?? []).map((command) => command.name)),
		);

		await manager.create();
		// `refreshCommands` is not awaited by `start()`: the list only reaches the
		// sidebar through the announcement this test pins down.
		const names = await waitUntil("commands announced", () => (published.length > 0 ? published.at(-1) : undefined));
		expect(names).toContain("compact");
		expect(names).toContain("skill:find-skills");
	});

	it("probes the slash command list for the entry page, with no session to ask", async () => {
		const env = makeEnv();
		// Same list the handshake above returns, read before any instance exists: the
		// entry page's `/` popup is only as honest as this probe.
		const commands = await readCommandList(env);
		const names = commands.map((command) => command.name);

		expect(names).toContain("compact");
		expect(names).toContain("skill:find-skills");
		expect(commands.every((command) => command.name.trim().length > 0)).toBe(true);
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

	/**
	 * `prompt.images` is the composer's other half: the bytes have to reach omp, land in the
	 * session file, and come back on the user bubble. The turn carries no text at all, which is
	 * the case the echo merge gets wrong if an image-only turn is not queued like a text one.
	 */
	it("sends an image-only turn to omp and shows it once on the user bubble", async () => {
		const env = makeEnv();
		const instance = new Instance(env, { id: "tab-1", cwd: env.workspaceRoot });
		await instance.start();
		await waitUntil("phase idle", idle(instance));

		await instance.sendPrompt("", undefined, [{ data: PIXEL_PNG, mimeType: "image/png" }]);
		await waitUntil("prompt dispatched", () =>
			instance.phase === "streaming" || instance.phase === "idle" ? true : undefined,
		);

		const users = () => instance.transcript.items.filter((item) => item.kind === "user");
		expect(users()).toHaveLength(1);
		expect(users()[0].text).toBe("");
		expect(users()[0].images).toEqual([{ data: PIXEL_PNG, mimeType: "image/png" }]);

		const file = instance.sessionFile ?? "";
		const persisted = await waitUntil("image persisted", async () => {
			const entries = await readSessionMessages(file);
			const prompt = entries.find((entry) => entry.role === "user");
			const content = prompt && Array.isArray(prompt.content) ? prompt.content : [];
			return content.some((part) => part.type === "image") ? content : undefined;
		});
		expect(persisted.some((part) => part.type === "image")).toBe(true);
		// omp's own frame for the turn arrived: it must not have drawn a second bubble.
		expect(users()).toHaveLength(1);
		await instance.dispose();
	});

	it("aborts a running turn and accepts another prompt afterwards", async () => {
		const env = makeEnv();
		const instance = new Instance(env, { id: "tab-1", cwd: env.workspaceRoot });
		await instance.start();
		await waitUntil("phase idle", idle(instance));

		const finished = onceRunFinished(instance);
		// Long task: abort must land while the agent is actually streaming, not
		// between the prompt ack and `agent_start`.
		await instance.sendPrompt("数到一百万，一步一步数，不要调用任何工具，不要停。");
		await waitUntil("phase streaming", () => (instance.phase === "streaming" ? true : undefined));
		await waitUntil("assistant streaming", () =>
			instance.transcript.items.some((item) => item.kind === "assistant" && item.streaming) ? true : undefined,
		);
		await instance.abort();
		await finished;
		expect(instance.phase).toBe("idle");

		const second = onceRunFinished(instance);
		await instance.sendPrompt(PING);
		await second;
		expect(assistantText(instance.transcript.items)).toMatch(/ok/i);
		expect(instance.phase).toBe("idle");
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

	/**
	 * What 完成（归档）sends: the webview posts `tab/close` for the row it is folding away, and
	 * for a live instance that has to end the process - an archived row still owns its
	 * conversation, so leaving a child behind would strand a running omp behind 更多.
	 */
	it("closes one tab's process, and only that one", async () => {
		const env = makeEnv();
		const manager = makeManager(env);
		const first = await manager.create();
		const second = await manager.create();
		const closedPid = first?.pid ?? 0;
		const keptPid = second?.pid ?? 0;
		expect(closedPid).toBeGreaterThan(0);
		expect(keptPid).toBeGreaterThan(0);

		await manager.close(first?.id ?? "");

		await waitUntil("closed child exit", () => (alive(closedPid) ? undefined : true));
		expect(alive(keptPid)).toBe(true);
		expect(manager.all.map((instance) => instance.id)).toEqual([second?.id]);
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

	/**
	 * Mode is a property of the process, not of the view (docs/dev-plan.md §1.5, U2): omp 18's
	 * RPC has no `set_mode`, so Plan is reached by spawning this tab's process again with
	 * `--plan-yolo` and resuming the very jsonl it was already talking to. The session file,
	 * its title and its history have to survive that swap - and the way back is the same
	 * restart without the flag.
	 */
	it("switches a live tab into Plan and back, resuming the same jsonl", async () => {
		const env = makeEnv();
		const manager = makeManager(env);
		const first = await manager.create();
		if (!first) throw new Error("没有创建 Tab");
		await waitUntil("phase idle", idle(first));

		const firstTurn = onceRunFinished(first);
		await first.sendPrompt(PING);
		await firstTurn;
		const file = first.sessionFile ?? "";
		const pid = first.pid ?? 0;
		expect(file).toMatch(/\.jsonl$/);
		expect(assistantText(first.transcript.items)).toMatch(/ok/i);

		await manager.setMode("plan");
		// The tab keeps its id - the user is reading one conversation - but the process
		// behind it is new (dev-plan §2.2). The history rides the jsonl.
		const plan = manager.active;
		expect(plan?.id).toBe(first.id);
		expect(plan).not.toBe(first);
		expect(plan?.sessionFile).toBe(file);
		expect(plan?.state().mode).toBe("plan");
		// The menu on that tab says the same thing the process does.
		const rows = plan?.state().modes ?? [];
		expect(rows.find((row) => row.mode === "plan")?.enabled).toBe(false);
		expect(rows.find((row) => row.mode === "none")?.enabled).toBe(true);
		await waitUntil("旧进程退出", () => (alive(pid) ? undefined : true));
		await waitUntil("Plan 进程 idle", () => (plan?.phase === "idle" ? true : undefined));
		expect(plan?.pid).not.toBe(pid);
		expect(assistantText(plan?.transcript.items ?? [])).toMatch(/ok/i);

		await manager.setMode("none");
		const back = manager.active;
		expect(back?.sessionFile).toBe(file);
		expect(back?.state().mode).toBe("none");
		expect(assistantText(back?.transcript.items ?? [])).toMatch(/ok/i);
		// One tab, one process, one jsonl: the restarts must not leave a second owner behind.
		expect(manager.all).toHaveLength(1);
	}, 300_000);

	/**
	 * The whole point of Plan in this plugin: it is omp's own headless plan flow, so the
	 * read-only draft and the approval are real. `--plan-yolo` writes no `mode_change` entry,
	 * so the pill may only leave Plan on omp's hand-off notice, and the plan body is whatever
	 * file omp's own plan write named (docs/rpc-samples/plan-yolo.jsonl).
	 */
	it("drafts the plan, hands off, then implements it in the same turn", async () => {
		const env = makeEnv();
		const target = join(env.workspaceRoot, "plan-target.txt");
		writeFileSync(target, "alpha\n", "utf8");
		const manager = makeManager(env);
		const fresh = await manager.create();
		if (!fresh) throw new Error("没有创建 Tab");
		await waitUntil("phase idle", idle(fresh));
		await manager.setMode("plan");
		const plan = manager.active;
		expect(plan?.id).toBe(fresh.id);
		if (!plan || plan === fresh) throw new Error("Plan Tab 没有重启出来");
		await waitUntil("Plan 进程 idle", () => (plan.phase === "idle" ? true : undefined));

		const finished = onceRunFinished(plan);
		await plan.sendPrompt("把 plan-target.txt 的第 1 行 alpha 改成 BETA：先给计划，再照计划执行。");
		const planFile = await waitUntil("计划文件路径", () => plan.planFile);
		expect(planFile).toMatch(/-plan\.md$/);

		await waitUntil("Plan 阶段结束（omp 自己批准）", () =>
			plan.state().mode === "none" ? true : undefined,
		);
		await finished;
		await waitUntil("实施落地", () => (readFileSync(target, "utf8").trim() === "BETA" ? true : undefined));

		// Tool rows in frame order: the draft's write of its plan file comes before the edit of
		// the workspace file. That ordering is the read-only guarantee, on a real process.
		const items = plan.transcript.items;
		const planWrite = items.findIndex(
			(item) => item.kind === "tool" && item.name === "write" && (item.path ?? "").endsWith("-plan.md"),
		);
		const touched = items.findIndex(
			(item) =>
				item.kind === "tool" &&
				item.name !== "read" &&
				item.name !== "glob" &&
				(item.path ?? "").endsWith("plan-target.txt"),
		);
		expect(planWrite).toBeGreaterThanOrEqual(0);
		expect(touched).toBeGreaterThan(planWrite);

		// The plan is readable: `local://<slug>-plan.md` resolves inside the session directory.
		await plan.openPlan();
		const layer = plan.viewStack.find((entry) => entry.kind === "plan");
		expect(layer?.body).toContain("plan-target");
	}, 300_000);
});
