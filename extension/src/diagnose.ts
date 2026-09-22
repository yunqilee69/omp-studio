import { execFile } from "node:child_process";
import type { HostEnv } from "./config";
import { Instance } from "./instance";

/**
 * `ompStudio.diagnose`: exercise the real host path (spawn -> ready -> v2 -> get_state)
 * and print what came back. This is the supported way to check a broken setup,
 * because it fails exactly where a tab would fail.
 */
export async function diagnose(env: HostEnv, output: (line: string) => void): Promise<void> {
	output(`omp 可执行文件: ${env.ompPath}`);
	output(`工作区: ${env.workspaceRoot}`);
	output(`审批模式: ${env.approvalMode}`);
	output(`HOME: ${env.homeDir}`);
	output(`omp --version: ${await ompVersion(env.ompPath)}`);

	const instance = new Instance(env, { id: "diagnose", cwd: env.workspaceRoot });
	const notices: string[] = [];
	instance.events.on("notice", (notice) => notices.push(`[${notice.level}] ${notice.text}`));
	try {
		await instance.start();
		await instance.refreshModels();
	} finally {
		output(`阶段: ${instance.phase}`);
		output(`实例状态: ${JSON.stringify(instance.state(), null, 2)}`);
		output(`可用模型: ${instance.models.length}${instance.models.length ? ` (${instance.models.map((model) => `${model.provider}/${model.id}`).join(", ")})` : ""}`);
		output(`可用命令: ${instance.commands.length}`);
		output(`会话文件: ${instance.sessionFile ?? "(无)"}`);
		output(`计划文件: ${instance.planFile ?? "(无)"}`);
		for (const line of notices) output(line);
		await instance.dispose();
		output(`已关闭诊断进程（会话文件保留在 ~/.omp/agent/sessions）`);
	}
}

function ompVersion(ompPath: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(ompPath, ["--version"], { timeout: 10_000 }, (error, stdout) => {
			if (error) resolve(`不可用（${error.message}）`);
			else resolve(stdout.trim());
		});
	});
}
