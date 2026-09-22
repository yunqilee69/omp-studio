// Records the settings page's host data from the real SettingsService, so the built
// webview bundle + CSS can be rendered in a browser against exactly what the page
// receives on this machine.
//
//   node scripts/record-settings-snapshot.mjs
//
// Writes test/ui/settings-snapshot.json - the one SettingsSnapshot that
// `SettingsService.refresh()` (the same call the panel makes on `ready`) produces.
//
// omp is pointed at a throwaway agent dir holding a *copy* of the real config.yml /
// models.yml / models.db, which is what `PI_CODING_AGENT_DIR` is for: the recorded
// values are this machine's real config, but the paths inside the snapshot are temp
// ones, so the fixture is not machine-specific and `omp models ls` cannot touch the
// real models.db while recording.
import { copyFileSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../src/settings.ts";

const here = process.env.OMP_STUDIO_UI_LOG_DIR;
if (!here) throw new Error("OMP_STUDIO_UI_LOG_DIR 未设置：请用 node scripts/record-settings-snapshot.mjs 运行");

const realAgent = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? tmpdir(), ".omp", "agent");
// realpath because both sides resolve the temp dir: macOS hands omp /private/var/...
// and this process /var/..., and the snapshot would then carry both spellings.
const tempRoot = realpathSync(tmpdir());
const agentDir = realpathSync(mkdtempSync(join(tempRoot, "omp-studio-agent-")));
for (const file of ["config.yml", "models.yml", "models.db"]) {
	const source = join(realAgent, file);
	if (existsSync(source)) copyFileSync(source, join(agentDir, file));
}
process.env.PI_CODING_AGENT_DIR = agentDir;

const env = {
	ompPath: process.env.OMP_STUDIO_OMP_PATH ?? "omp",
	// A throwaway workspace: the page shows the project config path but must not need one.
	workspaceRoot: realpathSync(mkdtempSync(join(tempRoot, "omp-studio-workspace-"))),
	maxInstances: 4,
	approvalMode: "inherit",
	homeDir: process.env.HOME ?? tmpdir(),
	logger: {
		info: (message) => process.stderr.write(`[host] ${message}\n`),
		warn: (message) => process.stderr.write(`[host:warn] ${message}\n`),
		error: (message) => process.stderr.write(`[host:error] ${message}\n`),
	},
};

async function main() {
	let snapshot;
	const service = new SettingsService(
		env,
		{
			snapshot: (value) => {
				snapshot = value;
			},
			notice: (text, level) => process.stderr.write(`[notice:${level}] ${text}\n`),
			busy: () => {},
		},
		// The recorded page must show the same rows the extension renders, so the fake
		// answers with what it was handed - `ompStudio.maxInstances` is not written here.
		{ set: async (_key, value) => value },
	);

	await service.refresh();
	if (!snapshot) throw new Error("没有拿到设置快照");

	const file = join(here, "settings-snapshot.json");
	writeFileSync(file, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
	process.stderr.write(
		`[record] ${snapshot.roles.length} 个角色、${snapshot.catalog.length} 个目录模型、` +
			`${snapshot.providers.length} 个提供商、${snapshot.settings.length} 项 omp 设置、` +
			`${snapshot.hostSettings.length} 项本扩展设置 → ${file}\n`,
	);
	if (snapshot.error) process.stderr.write(`[record:warn] 快照带 error：${snapshot.error}\n`);
}

void main();
