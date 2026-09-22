// Records what the real SidebarProvider posts to a webview while driving real
// `omp --mode rpc` instances, so the built webview bundle can be replayed against
// exactly those messages in a real browser.
//
//   node scripts/record-ui-log.mjs          (bundles this file with the vscode stub)
//
// Writes test/ui/host-log.json and test/ui/host-log-failure.json. Only VS Code
// itself is stubbed (test/ui/vscode-stub.mjs); every recorded message comes from
// Instance / InstanceManager / SidebarProvider code paths identical to production.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// Reads a file first, so the recording contains a real tool card (start -> end) and
// not just text: the tool card is the surface most likely to break visually.
const PROMPT = "先读 README.md，然后用一句话说明这个仓库是做什么的。";

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

async function waitFor(check, label, timeoutMs = 150_000) {
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
	const env = makeEnv(mkdtempSync(join(tmpdir(), "omp-studio-ui-")));
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
		await run(manager, webview);
	} finally {
		// Snapshot before teardown: dispose messages describe a shut-down panel, not
		// the state a user sees, and would blank the tab strip in the replay.
		snapshot = webview.log.slice();
		await manager.disposeAll();
	}
	writeFileSync(join(here, logFile), `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
	process.stderr.write(`[record] ${snapshot.length} 条消息 → ${join(here, logFile)}\n`);
}

const only = process.env.OMP_STUDIO_UI_SCENARIO;

if (!only || only === "main") await scenario("host-log.json", async (manager, webview) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "tab/new" });
	const first = manager.active;
	if (!first) throw new Error("第一个 Tab 没有创建");
	await waitFor(() => first.phase === "idle", "第一个 Tab idle");

	await webview.send({ type: "prompt/send", text: PROMPT });
	await waitFor(
		() => first.transcript.items.some((item) => item.kind === "assistant" && !item.streaming),
		"首轮回答完成",
	);
	await waitFor(() => first.phase === "idle", "首轮结束后回到 idle");

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

	await webview.send({ type: "tab/new" });
	const second = manager.active;
	if (!second || second.id === first.id) throw new Error("第二个 Tab 没有创建");
	await waitFor(() => second.phase === "idle", "第二个 Tab idle");
	await webview.send({ type: "tab/select", id: first.id });
	await settle(300);
	await webview.send({ type: "thinking/cycle" });
	await settle(500);
});

if (!only || only === "plan") await scenario("host-log-plan.json", async (manager, webview) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "tab/new" });
	const instance = manager.active;
	if (!instance) throw new Error("Tab 没有创建");
	await waitFor(() => instance.phase === "idle", "Tab idle");
	await webview.send({ type: "prompt/send", text: "只回复 OK，不要调用工具。" });
	await waitFor(() => instance.transcript.items.some((item) => item.kind === "assistant" && !item.streaming), "首轮完成");
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
	await webview.send({ type: "view/back" });
	await waitFor(() => resumed.viewStack.length === 1, "已返回对话");
});

if (!only || only === "failure") await scenario("host-log-failure.json", async (manager, webview) => {
	await webview.send({ type: "ready" });
	await webview.send({ type: "tab/new" });
	const instance = manager.active;
	if (!instance) throw new Error("Tab 没有创建");
	await waitFor(() => instance.phase === "idle", "Tab idle");
	instance.kill();
	await waitFor(() => instance.phase === "failed" || instance.phase === "gone", "进程死亡可见");
	await settle(300);
});
