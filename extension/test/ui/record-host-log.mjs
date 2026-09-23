// Records what the real SidebarProvider posts to a webview while driving real
// `omp --mode rpc` instances, so the built webview bundle can be replayed against
// exactly those messages in a real browser.
//
//   node scripts/record-ui-log.mjs          (bundles this file with the vscode stub)
//
// Writes test/ui/host-log.json, host-log-plan.json, host-log-failure.json and
// host-log-history.json (the search view). Only VS Code itself is stubbed
// (test/ui/vscode-stub.mjs); every recorded message comes from
// Instance / InstanceManager / SidebarProvider code paths identical to production.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceManager } from "../../src/instance-manager.ts";
import { SidebarProvider } from "../../src/providers/sidebar.ts";
import { Uri } from "./vscode-stub.mjs";

const here = process.env.OMP_STUDIO_UI_LOG_DIR ?? dirname(fileURLToPath(import.meta.url));

// Reads a file that is not there first, so the recording carries a FAILED tool row,
// then writes and edits one: the tool row is the surface most likely to break
// visually, and its `+N -M` only exists once a real diff comes back.
const PROMPT =
	"先读 README.md（这个文件不存在，如实报告即可），再新建 notes.txt 写入三行 alpha/beta/gamma，然后把 notes.txt 的第 2 行改成 BETA，最后用一句话总结你做了什么。";

/**
 * Workspace for one recording, under `/tmp` with `TMPDIR` pointed at it.
 *
 * omp names a session bucket after the cwd and the extension derives that same bucket
 * from the cwd, but omp resolves a cwd under the host temp dir specially: measure with
 * `omp --mode rpc --cwd /tmp/x` and the bucket is `--private-tmp-x--`
 * (realpath'd) unless `TMPDIR=/tmp`, which yields the `-tmp-x` the extension computes.
 * Without this the recorded `history` would come back empty and the list would look
 * like it only ever shows live instances.
 */
function tempWorkspaceRoot() {
	if (!existsSync("/tmp")) return mkdtempSync(join(tmpdir(), "omp-studio-ui-"));
	process.env.TMPDIR = "/tmp";
	return mkdtempSync(join("/tmp", "omp-studio-ui-"));
}

class FakeWebview {
	options = {};
	html = "";
	handler = undefined;
	log = [];
	started = Date.now();

	onDidReceiveMessage(handler) {
		this.handler = handler;
		return { dispose: () => {} };
	}

	asWebviewUri(uri) {
		return uri;
	}

	postMessage(message) {
		this.log.push({ direction: "toWebview", message, at: Date.now() - this.started });
	}

	/** Simulates the webview sending a message to the host. */
	async send(message) {
		this.log.push({ direction: "fromWebview", message, at: Date.now() - this.started });
		await this.handler?.(message);
	}
}

function settle(ms) {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor(check, label, timeoutMs = 600_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`超时等待：${label}`);
		await settle(100);
	}
}

function makeEnv(workspaceRoot) {
	// The stub's `workspace.findFiles` walks this root, so the recorded `@` file list - the
	// composer's only source - carries the paths VS Code would really hand it.
	process.env.OMP_STUDIO_UI_WORKSPACE = workspaceRoot;
	return {
		ompPath: process.env.OMP_STUDIO_OMP_PATH ?? "omp",
		workspaceRoot,
		maxInstances: 4,
		approvalMode: "inherit",
		homeDir: process.env.HOME ?? tmpdir(),
		logger: {
			info: (message) => process.stderr.write(`[host] ${message}\n`),
			warn: (message) => process.stderr.write(`[host:warn] ${message}\n`),
			error: (message) => process.stderr.write(`[host:error] ${message}\n`),
		},
	};
}
async function scenario(logFile, run) {
	const env = makeEnv(tempWorkspaceRoot());
	// A project MCP file, so the recorded MCP panel has real entries to render.
	mkdirSync(join(env.workspaceRoot, ".omp"), { recursive: true });
	writeFileSync(
		join(env.workspaceRoot, ".omp", "mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					filesystem: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
					"docs-search": { type: "http", url: "https://mcp.example.com/docs" },
					"legacy-off": { type: "stdio", command: "echo", enabled: false },
				},
			},
			null,
			"\t",
		),
		"utf8",
	);
	const manager = new InstanceManager(env);
	const webview = new FakeWebview();
	const provider = new SidebarProvider(Uri.file(process.cwd()), manager, env);
	provider.resolveWebviewView({ webview, onDidDispose: () => ({ dispose: () => {} }) });
	let snapshot;
	try {
		await run(manager, webview, provider);
	} finally {
		// Snapshot before teardown: dispose messages describe a shut-down panel, not
		// the state a user sees, and would blank the sessions list in the replay.
		snapshot = webview.log.slice();
		await manager.disposeAll();
	}
	writeFileSync(join(here, logFile), `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
	process.stderr.write(`[record] ${snapshot.length} 条消息 → ${join(here, logFile)}\n`);
}

const only = process.env.OMP_STUDIO_UI_SCENARIO;

if (!only || only === "main") await scenario("host-log.json", async (manager, webview, provider) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "session/create-and-send", text: PROMPT });
	const first = manager.active;
	if (!first) throw new Error("第一个实例没有创建");
	await waitFor(() => first.phase === "idle", "第一个实例 idle");
	await waitFor(
		() => first.transcript.items.some((item) => item.kind === "assistant" && !item.streaming),
		"首轮回答完成",
	);
	// One action at a time: the recording then attributes each host answer to the
	// action that caused it, which is what the replay harness relies on.
	for (const action of [
		{ type: "history/refresh" },
		{ type: "mcp/refresh" },
		{ type: "view/open-plan" },
		{ type: "view/back" },
	]) {
		await webview.send(action);
		await settle(600);
	}

	// A real question from a real omp: the model asks, the webview-side flow answers
	// through `ui/respond`, so the replay carries the full multi-select exchange.
	const asker = first;
	const askFrom = asker.transcript.items.length;
	void asker.sendPrompt(
		"必须只用 ask 工具：问我「要启用哪些检查项」（multi: true），options 用 lint、typecheck、format。等我回答后只回复「收到」。",
	);
	// Rounds of one question: pick lint, then typecheck, then commit with omp's Done row.
	// The host holds the panel for 400ms after an answer (the next round may already be
	// in flight), so each round waits for a request id this loop has not answered yet.
	let answered = new Set();
	for (const pick of ["lint", "typecheck", "done"]) {
		await waitFor(() => {
			const view = asker.currentUI;
			return view?.method === "select" && !answered.has(view.id) ? view : undefined;
		}, `ask 的 select 轮（准备选 ${pick}）`);
		const view = asker.currentUI;
		answered.add(view.id);
		const option =
			pick === "done"
				? view.options?.find((row) => row.role === "done")
				: view.options?.find((row) => row.role === "option" && !view.selected?.includes(row.value));
		if (!option) throw new Error(`找不到要选的行（${pick}）`);
		await webview.send({ type: "ui/respond", response: { type: "extension_ui_response", id: view.id, value: option.value } });
	}
	await waitFor(
		() => !asker.currentUI && asker.transcript.items.slice(askFrom).some((item) => item.kind === "assistant" && !item.streaming),
		"ask 交换完成",
	);
	await settle(400);


	// A blank instance, the way the view-titlebar「新建会话」command makes one: the host
	// answers `sessions/enter`, so the chat area goes straight into this instance.
	await provider.newInstance();
	const second = manager.active;
	if (!second || second.id === first.id) throw new Error("第二个实例没有创建");
	await webview.send({ type: "tab/select", id: first.id });
	await settle(300);
	await webview.send({ type: "thinking/cycle" });
	await settle(500);
});

// Plan mode is a real omp flow (`--plan-yolo`, docs/upstream-issues.md U2), so this
// scenario drives it end to end instead of staging it: the pill's Plan row restarts the
// tab's process, the model drafts read-only, omp approves and implements, and the plan
// body in the replay is the file omp itself wrote.
if (!only || only === "plan") await scenario("host-log-plan.json", async (manager, webview) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "session/create-and-send", text: "只回复 OK，不要调用工具。" });
	const first = manager.active;
	if (!first) throw new Error("实例没有创建");
	await waitFor(() => first.phase === "idle", "首轮完成");
	await waitFor(() => first.transcript.items.some((item) => item.kind === "assistant" && !item.streaming), "首轮回答完成");
	const sessionFile = first.sessionFile;
	if (!sessionFile) throw new Error("没有会话文件");
	await settle(500);

	// What the Plan row sends: same jsonl, new process with --plan-yolo.
	await webview.send({ type: "mode/set", mode: "plan" });
	const plan = manager.active;
	if (!plan || plan === first) throw new Error("Plan Tab 没有重启出来");
	await waitFor(() => plan.phase === "idle" && plan.state().mode === "plan", "Plan 进程就绪");
	await settle(600);

	await webview.send({
		type: "prompt/send",
		text: "新建 ui-plan-ok.txt 写入一行 PLAN-OK：先给计划，再照计划执行。",
	});
	await waitFor(() => plan.planFile, "omp 写出了计划文件");
	await waitFor(() => plan.state().mode === "none", "omp 已批准计划（pill 回到 Agent）");
	await waitFor(() => plan.phase === "idle", "实施完成");
	await settle(600);

	await webview.send({ type: "view/open-plan" });
	await waitFor(() => plan.viewStack.some((layer) => layer.kind === "plan"), "计划层已压栈");
	// Recorded so the replay's 返回 button works as well; the harness itself stops on the
	// stacked plan view above.
	await webview.send({ type: "view/back" });
	await settle(400);
});

if (!only || only === "failure") await scenario("host-log-failure.json", async (manager, webview) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "session/create-and-send", text: "只回复 OK，不要调用工具。" });
	const instance = manager.active;
	if (!instance) throw new Error("实例没有创建");
	// The turn cannot finish here (this scenario needs no credentials): give the prompt
	// time to echo into the transcript, then take the process down.
	await settle(2500);
	instance.kill();
	await waitFor(() => instance.phase === "failed" || instance.phase === "gone", "进程死亡可见");
	await settle(300);
});

// The view-titlebar「打开历史会话」command. The instance is closed before the list page
// reopens, so the replay covers both the live list and its rows of session files.
if (!only || only === "palette") await scenario("host-log-history.json", async (manager, webview, provider) => {
	await webview.send({ type: "ready" });
	const instance = await manager.create();
	await waitFor(() => instance.phase === "idle", "实例就绪");
	const sessionFile = instance.sessionFile;
	if (!sessionFile) throw new Error("没有会话文件");
	// The host side is real; only the jsonl content is written by hand (same trick as the
	// plan scenario), because a finished turn needs a model this recording must not require.
	mkdirSync(dirname(sessionFile), { recursive: true });
	appendFileSync(sessionFile, `${JSON.stringify({ type: "title", title: "上一轮任务" })}\n`, "utf8");
	// A second session file: filtering by name needs more than one row to be worth
	// watching. Its mtime is pinned, so "newest first" is the recorded order either way.
	const older = join(dirname(sessionFile), "2026-09-18T09-02-00-000Z_manual.jsonl");
	writeFileSync(
		older,
		`${JSON.stringify({ type: "title", title: "重构鉴权" })}\n${JSON.stringify({ type: "mode_change", mode: "plan" })}\n`,
		"utf8",
	);
	const stamp = new Date("2026-09-18T09:02:00Z");
	utimesSync(older, stamp, stamp);
	await manager.close(instance.id);
	await provider.showHistory();
	await settle(800);
});
