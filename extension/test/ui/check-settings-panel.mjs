// Drives the real activation path with only VS Code stubbed, to cover the one seam the
// browser replay cannot reach: the panel's message handler -> SettingsService ->
// HostSettingsWriter -> `workspace.getConfiguration("ompStudio").update`.
//
//   node scripts/check-settings-panel.mjs
//
// The snapshot's omp-side rows come from the real `omp` CLI (read-only); the assertions
// are about the extension's own setting, `ompStudio.maxInstances`, which is the one the
// sidebar's soft-cap warning reads.
import { activate, deactivate } from "../../src/extension.ts";
import { Uri, configurationWrites, registeredCommands, webviewPanels } from "./vscode-stub.mjs";

let failed = false;

function check(label, ok, detail) {
	const suffix = detail === undefined ? "" : ` — ${detail}`;
	process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${suffix}\n`);
	if (!ok) failed = true;
}

function settle(ms) {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor(ready, label, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(`超时等待：${label}`);
		await settle(100);
	}
}

async function main() {
	activate({ subscriptions: [], extensionUri: Uri.file(process.cwd()) });

	check("激活后注册了 ompStudio.settings", registeredCommands.has("ompStudio.settings"));
	await registeredCommands.get("ompStudio.settings")();
	const panel = webviewPanels.at(-1);
	check("命令打开了设置页 panel", panel !== undefined);
	if (!panel) return;
	const webview = panel.webview;

	await webview.send({ type: "ready" });
	await waitFor(() => webview.last("snapshot") !== undefined, "设置页快照");
	const row = webview.last("snapshot").snapshot.hostSettings.find((setting) => setting.key === "maxInstances");
	check(
		"快照带本扩展设置：ompStudio.maxInstances = 4，范围 1–16",
		row?.value === 4 && row?.minimum === 1 && row?.maximum === 16,
		JSON.stringify(row),
	);

	await webview.send({ type: "host-setting/set", key: "maxInstances", value: 8 });
	await waitFor(() => configurationWrites.length > 0, "写 VS Code 配置");
	const write = configurationWrites.at(-1);
	check(
		"写的是 ompStudio.maxInstances = 8，用户级（Global）",
		write.section === "ompStudio" && write.key === "maxInstances" && write.value === 8 && write.target === 1,
		JSON.stringify(write),
	);
	await waitFor(() => webview.last("snapshot")?.snapshot.hostSettings[0]?.value === 8, "重读后的快照");
	check("重读后页面显示 8：宿主 getter 与实例软上限读的是同一份配置", true);
	check(
		"写入没有伴随错误提示",
		!webview.messages.some((message) => message.type === "notice" && message.level === "error"),
	);

	await webview.send({ type: "host-setting/set", key: "maxInstances", value: 99 });
	await settle(500);
	const notice = webview.messages.filter((message) => message.type === "notice").at(-1);
	check(
		"越界的 99 被拒，且没有再写配置",
		configurationWrites.length === 1 && notice?.level === "error" && notice.text.includes("1–16"),
		notice?.text,
	);

	await webview.send({ type: "host-setting/set", key: "notOurs", value: 3 });
	await settle(500);
	const unknown = webview.messages.filter((message) => message.type === "notice").at(-1);
	check(
		"别人家的键被拒，且没有再写配置",
		configurationWrites.length === 1 && unknown?.level === "error" && unknown.text.includes("notOurs"),
		unknown?.text,
	);

	panel.dispose();
	deactivate();
}

// No top-level `await`: this has to bundle as CJS (see scripts/check-settings-panel.mjs).
main()
	.catch((error) => {
		check("检查本身跑完", false, error instanceof Error ? error.message : String(error));
	})
	.finally(() => {
		process.stdout.write(`[check] ${failed ? "有失败项" : "全部通过"}：设置页并发上限写入链路\n`);
		process.exitCode = failed ? 1 : 0;
	});
