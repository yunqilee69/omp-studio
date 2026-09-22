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
const PLAN_BODY = [
	"# UI 验证计划",
	"",
	"## 目标",
	"",
	"- 打开计划视图时整页替换对话",
	"- 顶部保留返回入口，不新开 Tab",
	"",
	"## 步骤",
	"",
	"1. 准备一个处于 plan 模式的真实会话",
	"2. 点击「计划」，断言正文来自 local://ui-plan.md",
	"",
].join("\n");

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

	// A blank instance, the way the view-titlebar「新建实例」command makes one.
	await provider.newInstance();
	const second = manager.active;
	if (!second || second.id === first.id) throw new Error("第二个实例没有创建");
	await webview.send({ type: "tab/select", id: first.id });
	await settle(300);
	await webview.send({ type: "thinking/cycle" });
	await settle(500);
});

if (!only || only === "plan") await scenario("host-log-plan.json", async (manager, webview) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "session/create-and-send", text: "只回复 OK，不要调用工具。" });
	const instance = manager.active;
	if (!instance) throw new Error("实例没有创建");
	await waitFor(() => instance.phase === "idle", "首轮完成");
	await waitFor(() => instance.transcript.items.some((item) => item.kind === "assistant" && !item.streaming), "首轮回答完成");
	const sessionFile = instance.sessionFile;
	if (!sessionFile) throw new Error("没有会话文件");
	await settle(500);

	// omp records plan mode in the session jsonl (`mode_change`, see
	// docs/upstream-issues.md U2) and tells the model to write `local://<slug>-plan.md`.
	// Build exactly that state on top of a real session, then let the extension resume it.
	const stem = sessionFile.slice(0, -".jsonl".length);
	mkdirSync(join(stem, "local"), { recursive: true });
	writeFileSync(join(stem, "local", "ui-plan.md"), PLAN_BODY, "utf8");
	appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "mode_change",
			id: "recorded-plan",
			timestamp: new Date().toISOString(),
			mode: "plan",
			data: { planFilePath: "local://ui-plan.md" },
		})}\n`,
		"utf8",
	);

	await manager.close(instance.id);
	await webview.send({ type: "tab/open-history", file: sessionFile });
	const resumed = manager.active;
	if (!resumed) throw new Error("恢复会话失败");
	await waitFor(() => resumed.phase === "idle", "恢复后的 Tab idle");
	await waitFor(() => resumed.state().planFile === "local://ui-plan.md", "计划路径已读出");
	await resumed.openPlan();
	await waitFor(() => resumed.viewStack.some((layer) => layer.kind === "plan"), "计划层已压栈");
	// The page entry is the list, so the replay reaches the layer through a row click:
	// select the resumed session once while the layer is up, once more after going back.
	await webview.send({ type: "tab/select", id: resumed.id });
	await settle(400);
	await webview.send({ type: "view/back" });
	await waitFor(() => resumed.viewStack.length === 1, "已返回对话");
	await webview.send({ type: "view/open-plan" });
	await waitFor(() => resumed.viewStack.some((layer) => layer.kind === "plan"), "计划层再次压栈");
	await webview.send({ type: "tab/select", id: resumed.id });
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
