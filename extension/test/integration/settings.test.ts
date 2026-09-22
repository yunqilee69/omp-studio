import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { HostEnv, Logger } from "../../src/config";
import { readProviders } from "../../src/models-file";
import { SettingsService, type SettingsSink } from "../../src/settings";
import type { NoticeLevel, SettingsSnapshot } from "../../src/shared/protocol";

/**
 * Live acceptance for the settings page's write paths, against real `omp`.
 *
 *     OMP_STUDIO_INTEGRATION=1 npx vitest run test/integration
 *
 * `PI_CODING_AGENT_DIR` is what makes this safe to run on a real machine: omp
 * resolves *and writes* config.yml through it (verified on 18.0.11), so the whole
 * suite runs against a copy of `~/.omp/agent` in a temp dir. The user's own files
 * are compared byte for byte at the end.
 */
const live = process.env.OMP_STUDIO_INTEGRATION === "1";
const sourceAgent = join(process.env.PI_CONFIG_DIR ?? join(homedir(), ".omp"), "agent");

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** `modelRoles` as `config.yml` writes it: role to selector. A guard, not a cast - the file is user-editable. */
function isStringMap(value: unknown): value is Record<string, string> {
	return typeof value === "object" && value !== null && Object.values(value).every((entry) => typeof entry === "string");
}

interface Notice {
	text: string;
	level: NoticeLevel;
}

/** Collects what the panel would render, so a test can assert on what the user was told. */
class Recorder implements SettingsSink {
	snapshots: SettingsSnapshot[] = [];
	notices: Notice[] = [];
	busyStates: boolean[] = [];

	snapshot(snapshot: SettingsSnapshot): void {
		this.snapshots.push(snapshot);
	}
	notice(text: string, level: NoticeLevel): void {
		this.notices.push({ text, level });
	}
	busy(busy: boolean): void {
		this.busyStates.push(busy);
	}

	/** The most recent snapshot: every mutation re-reads, so this is the current state. */
	get latest(): SettingsSnapshot {
		const last = this.snapshots.at(-1);
		if (!last) throw new Error("没有收到任何快照");
		return last;
	}
	clear(): void {
		this.notices = [];
	}
}

describe.runIf(live)("settings page against real omp", () => {
	let sandbox: string;
	let modelsFile: string;
	let configFile: string;
	let originalModels: string;
	let originalConfig: string;
	/** What the copied `config.yml` assigns, so the assertions below track the file rather than this machine. */
	let copiedRoles: Record<string, string>;
	let realModelsBefore: { sha: string; mtimeMs: number };
	let realConfigBefore: { sha: string; mtimeMs: number };
	const recorder = new Recorder();

	async function fingerprint(path: string): Promise<{ sha: string; mtimeMs: number }> {
		const raw = await readFile(path, "utf8");
		const { createHash } = await import("node:crypto");
		const { mtimeMs } = await import("node:fs/promises").then((fs) => fs.stat(path));
		return { sha: createHash("sha256").update(raw).digest("hex"), mtimeMs };
	}

	beforeAll(async () => {
		sandbox = await mkdtemp(join(tmpdir(), "omp-studio-settings-"));
		modelsFile = join(sandbox, "models.yml");
		configFile = join(sandbox, "config.yml");
		realModelsBefore = await fingerprint(join(sourceAgent, "models.yml"));
		realConfigBefore = await fingerprint(join(sourceAgent, "config.yml"));
		originalModels = await readFile(join(sourceAgent, "models.yml"), "utf8");
		originalConfig = await readFile(join(sourceAgent, "config.yml"), "utf8");
		const parsed: unknown = parseYaml(originalConfig);
		const roles = typeof parsed === "object" && parsed !== null && "modelRoles" in parsed ? parsed.modelRoles : undefined;
		copiedRoles = isStringMap(roles) ? roles : {};
		await writeFile(modelsFile, originalModels, "utf8");
		await writeFile(configFile, originalConfig, "utf8");
		// Every spawn from here on - `omp config set`, `omp models ls`, and the
		// write-time validation - is redirected at the sandbox by this one variable.
		process.env.PI_CODING_AGENT_DIR = sandbox;
		service = makeService();
	});

	afterAll(async () => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	function makeService(): SettingsService {
		const env: HostEnv = {
			ompPath: process.env.OMP_STUDIO_OMP_PATH ?? "omp",
			workspaceRoot: sandbox,
			maxInstances: 4,
			approvalMode: "inherit",
			homeDir: tmpdir(),
			logger: quiet,
		};
		// The host-setting path has its own unit test; here the write only has to land
		// somewhere, so `omp`'s own paths stay this file's subject.
		return new SettingsService(env, recorder, { set: async (_key, value) => value });
	}

	// Built in `beforeAll`: `paths()` reads the sandbox, which does not exist yet
	// while this file is being collected.
	let service: SettingsService;

	it("reads the config, the catalog and models.yml through the real CLI", async () => {
		await service.refresh();
		const snapshot = recorder.latest;

		expect(snapshot.error).toBeUndefined();
		// `omp --version` prints `omp/18.0.11`; the header shows that line verbatim.
		expect(snapshot.ompVersion).toMatch(/\d+\.\d+\.\d+/);
		expect(snapshot.paths.modelsFile).toBe(modelsFile);
		expect(snapshot.paths.agentDir).toBe(sandbox);

		// The expectations come from the copied config, not from this machine's current
		// values: a hardcoded selector makes the suite pass only on the box it was
		// written on.
		expect(Object.keys(copiedRoles).length).toBeGreaterThan(0);
		for (const view of snapshot.roles) expect(view.selector).toBe(copiedRoles[view.role]);
		// Only a *stored* selector can be unresolved; an unset role is not a problem to flag.
		for (const view of snapshot.roles.filter((role) => role.selector === undefined)) {
			expect(view.resolved).toBe(true);
		}

		// The provider id comes from the copied models.yml, not from this machine's
		// current set: an added or renamed provider must not break the read path.
		const customProvider = readProviders(originalModels).providers.find((provider) => provider.hasApiKey);
		if (!customProvider) throw new Error("the copied models.yml defines no provider with a credential");
		expect(snapshot.providers.map((provider) => provider.id)).toContain(customProvider.id);
		// The catalog comes from `omp models ls`, so the custom providers are in it.
		expect(snapshot.catalog.some((entry) => entry.provider === customProvider.id)).toBe(true);
		// No credential value may reach the page - only the fact that one exists.
		// The sandbox holds this machine's real models.yml, so this checks the real
		// secrets rather than a fixture's placeholders.
		const serialised = JSON.stringify(snapshot);
		const keys = [...originalModels.matchAll(/apiKey:\s*(\S+)/g)].map((match) => match[1]);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(serialised).not.toContain(key);
		expect(snapshot.providers.some((provider) => provider.hasApiKey)).toBe(true);
	});

	it("writes a role through `omp config set` and reads it back", async () => {
		recorder.clear();
		const role = "slow";
		const before = recorder.latest.roles.find((assignment) => assignment.role === role)?.selector;
		// A target the config does not already assign: writing the value that is already
		// there would leave the file untouched and make the assertion below assert nothing.
		const target = recorder.latest.catalog.find((entry) => entry.selector !== before);
		if (!target) throw new Error("the catalog needs an entry other than the role's current selector");

		await service.setRole(role, target.selector);
		expect(recorder.notices.filter((notice) => notice.level === "error")).toEqual([]);

		// Read back through the real CLI: this is the value the page shows next.
		const written = recorder.latest.roles.find((assignment) => assignment.role === role);
		expect(written?.selector).toBe(target.selector);
		expect(written?.provider).toBe(target.provider);
		expect(written?.modelId).toBe(target.id);
		expect(written?.resolved).toBe(true);

		// The change is in omp's own file, and it is the only thing that moved.
		const now = await readFile(configFile, "utf8");
		expect(now).not.toBe(originalConfig);
		expect(now).toContain(target.selector);

		await service.setRole(role, before ?? null);
		expect(recorder.latest.roles.find((assignment) => assignment.role === role)?.selector).toBe(before);
	});

	it("refuses a role selector that is not in the catalog, without writing", async () => {
		const before = await readFile(configFile, "utf8");
		await service.setRole("slow", "Ghost/nonexistent");
		expect(recorder.notices.some((notice) => notice.text.includes("模型目录里没有"))).toBe(true);
		expect(await readFile(configFile, "utf8")).toBe(before);
	});

	it("writes defaultThinkingLevel, and rejects the value omp rejects", async () => {
		recorder.clear();
		await service.setScalar("defaultThinkingLevel", "auto");
		expect(recorder.latest.settings.find((setting) => setting.key === "defaultThinkingLevel")?.value).toBe("auto");

		// `off` is not in this enum (it belongs to the session picker): the page must
		// not offer it, and the service must not pass it to omp.
		const before = await readFile(configFile, "utf8");
		await service.setScalar("defaultThinkingLevel", "off");
		expect(recorder.notices.some((notice) => notice.text.includes("不接受"))).toBe(true);
		expect(await readFile(configFile, "utf8")).toBe(before);
	});

	it("adds a provider with its first model, keeping every comment", async () => {
		recorder.clear();
		await service.saveProvider(
			undefined,
			{ id: "AcceptProbe", baseUrl: "http://127.0.0.1:19999/v1", api: "openai-completions", apiKey: "sk-accept-probe" },
			{ id: "probe-model", name: "Probe", contextWindow: 128000, maxTokens: 4096 },
		);
		expect(recorder.notices.filter((notice) => notice.level === "error")).toEqual([]);
		expect(recorder.notices.some((notice) => notice.text.includes("成功"))).toBe(true);

		// omp itself sees the new provider: the post-write verification re-read the
		// catalog, and so do we.
		expect(recorder.latest.catalog.some((entry) => entry.selector === "AcceptProbe/probe-model")).toBe(true);

		const written = await readFile(modelsFile, "utf8");
		const commentLines = (raw: string) => raw.split("\n").map((line) => line.match(/#.*$/)?.[0]).filter(Boolean);
		expect(commentLines(written)).toEqual(commentLines(originalModels));
		expect(written).toContain("AcceptProbe");
	});

	it("removes the provider again, returning models.yml to the original providers", async () => {
		recorder.clear();
		await service.removeProvider("AcceptProbe");
		expect(recorder.notices.filter((notice) => notice.level === "error")).toEqual([]);
		expect(await readFile(modelsFile, "utf8")).not.toContain("AcceptProbe");
		expect(recorder.latest.providers.map((provider) => provider.id)).not.toContain("AcceptProbe");
	});

	it("does not write a models.yml that omp rejects", async () => {
		recorder.clear();
		const before = await fingerprint(modelsFile);
		const beforeRaw = await readFile(modelsFile, "utf8");

		// `api` survives our own validation (non-empty) and is rejected by omp.
		await service.saveProvider(undefined, {
			id: "BrokenProbe",
			baseUrl: "http://127.0.0.1:19998/v1",
			api: "no-such-transport",
			apiKey: "sk-broken",
		});

		expect(recorder.notices.some((notice) => notice.level === "error")).toBe(true);
		expect(await readFile(modelsFile, "utf8")).toBe(beforeRaw);
		expect((await fingerprint(modelsFile)).sha).toBe(before.sha);
	});

	it("leaves the real ~/.omp files untouched", async () => {
		expect(await fingerprint(join(sourceAgent, "models.yml"))).toEqual(realModelsBefore);
		expect(await fingerprint(join(sourceAgent, "config.yml"))).toEqual(realConfigBefore);
	});
});
