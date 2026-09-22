import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEnv, HostSettingsWriter } from "./config";
import {
	deleteModel as deleteModelInFile,
	deleteProvider as deleteProviderInFile,
	readModelsFile,
	readProviders,
	restoreBackup,
	upsertModel,
	upsertProvider,
	writeModelsFileAtomic,
} from "./models-file";
import {
	readModelCatalog,
	readModelRoles,
	readSettings,
	readVersion,
	validateModelsFile,
	writeModelRoles,
	writeSetting,
	type OmpInvocation,
} from "./omp-config";
import { agentDir } from "./session-file";
import {
	MODEL_ROLES,
	DEFAULT_THINKING_LEVELS,
	resolveSelector,
	thinkingLevelsFor,
	validateModelDraft,
	validateProviderDraft,
	type ModelCatalogEntry,
	type ModelDraft,
	type ProviderDraft,
} from "./shared/model-drafts";
import type {
	HostSettingView,
	NoticeLevel,
	RoleAssignmentView,
	SettingView,
	SettingsPathsView,
	SettingsSnapshot,
} from "./shared/protocol";

/**
 * Reads and writes the settings page's three sources (dev-plan §2.7).
 *
 * Deliberately asymmetric writers:
 *
 * - `config.yml` belongs to omp. Role assignments and scalars go through
 *   `omp config set`, which keeps omp's own lock and node-level edits, so this
 *   extension never has to be trusted with that file's format.
 * - `models.yml` has no CLI writer at all, so it is the one file written here.
 *   Every write is validated by a real omp in a throwaway agent dir first, and
 *   the live file is backed up and re-verified after (see `commitModelsFile`).
 * - `ompStudio.*` is neither of those: it is this extension's own VS Code
 *   configuration, so it goes through the injected `HostSettingsWriter`.
 */

/** Where the service reports back to. Implemented by the panel; kept tiny so it is trivial to fake in tests. */
export interface SettingsSink {
	snapshot(snapshot: SettingsSnapshot): void;
	notice(text: string, level: NoticeLevel, url?: string): void;
	/** `ok` is only meaningful when the operation finished (`busy === false`). */
	busy(busy: boolean, what?: string, ok?: boolean): void;
}

/** Settings the page can write. Anything not listed here is never sent to `config set`. */
const SCALAR_SETTINGS: Record<string, { label: string; description: string; choices: readonly string[] }> = {
	defaultThinkingLevel: {
		label: "默认思考等级",
		description: "新会话的默认 thinking 等级。会话内的思考按钮仍可临时覆盖它。",
		choices: DEFAULT_THINKING_LEVELS,
	},
};

/**
 * The extension's own settings the page exposes, keyed by their name inside the
 * `ompStudio` section. Bounds mirror the JSON schema in `extension/package.json`, which
 * VS Code validates settings.json against; this copy is what the in-page control and
 * the write path use.
 */
interface HostSettingSpec {
	label: string;
	description: string;
	minimum: number;
	maximum: number;
	/** Where the value in force comes from. `HostEnv` is the one reader of VS Code config. */
	read: (env: HostEnv) => number;
}

const HOST_SETTINGS: Record<string, HostSettingSpec> = {
	maxInstances: {
		label: "并发实例上限",
		description: "同时运行的实例软上限。达到后新建会话只提示 CPU 与费用，不阻止。",
		minimum: 1,
		maximum: 16,
		read: (env) => env.maxInstances,
	},
};

export class SettingsService {
	/** mtime of `models.yml` as of the last read, so an outside edit is noticed before we clobber it. */
	private modelsMtime: number | undefined;

	constructor(
		private readonly env: HostEnv,
		private readonly sink: SettingsSink,
		private readonly hostSettings: HostSettingsWriter,
	) {}

	paths(): SettingsPathsView {
		const agent = agentDir(this.env.homeDir);
		return {
			agentDir: agent,
			configFile: join(agent, "config.yml"),
			modelsFile: join(agent, "models.yml"),
			projectConfigFile: join(this.env.workspaceRoot, ".omp", "config.yml"),
		};
	}

	private invocation(): OmpInvocation {
		return { ompPath: this.env.ompPath, cwd: this.env.workspaceRoot };
	}

	/** Read everything the page renders. Never throws: failures land in `snapshot.error`. */
	async refresh(): Promise<void> {
		const paths = this.paths();
		const inv = this.invocation();
		const failures: string[] = [];

		let settings: Record<string, { value?: unknown; type: string; description: string }> = {};
		let catalog: ModelCatalogEntry[] = [];
		try {
			settings = await readSettings(inv);
		} catch (error) {
			failures.push(message(error));
		}
		try {
			catalog = await readModelCatalog(inv);
		} catch (error) {
			failures.push(message(error));
		}
		const version = await readVersion(inv).catch(() => undefined);

		const loaded = await readModelsFile(paths.modelsFile);
		this.modelsMtime = loaded.exists ? loaded.mtimeMs : undefined;
		const modelsRead = readProviders(loaded.raw);

		this.sink.snapshot({
			roles: this.roleViews(readModelRoles(settings), catalog),
			catalog,
			providers: modelsRead.providers,
			settings: this.settingViews(settings),
			hostSettings: this.hostSettingViews(),
			paths,
			modelsFileError: modelsRead.error,
			ompVersion: version,
			error: failures.length > 0 ? failures.join("；") : undefined,
		});
	}

	private roleViews(roles: Record<string, string>, catalog: ModelCatalogEntry[]): RoleAssignmentView[] {
		return MODEL_ROLES.map(({ role, description }) => {
			const selector = roles[role];
			const resolved = selector ? resolveSelector(selector, catalog) : undefined;
			return {
				role,
				description,
				selector,
				provider: resolved?.entry.provider,
				modelId: resolved?.entry.id,
				thinking: resolved?.thinking,
				// Only a *stored* selector can be unresolved; an unset role is not a problem to flag.
				resolved: selector === undefined || resolved !== undefined,
				thinkingLevels: thinkingLevelsFor(resolved?.entry),
			};
		});
	}

	private settingViews(settings: Record<string, { value?: unknown; type: string; description: string }>): SettingView[] {
		const views: SettingView[] = [];
		for (const [key, spec] of Object.entries(SCALAR_SETTINGS)) {
			views.push({
				key,
				label: spec.label,
				description: spec.description,
				kind: "enum",
				value: settings[key]?.value,
				choices: [...spec.choices],
				editable: true,
			});
		}
		const storage = settings.modelRoleStorage;
		views.push({
			key: "modelRoleStorage",
			label: "角色保存位置",
			description: "omp 自己决定把角色写到全局还是项目配置。",
			kind: "enum",
			value: storage?.value,
			choices: ["global", "project"],
			editable: false,
			note: "`omp config set` 只能写全局 profile，所以这里的角色编辑一律落全局。按项目的角色请在 omp 终端改，或直接编辑项目 .omp/config.yml。",
		});
		return views;
	}

	/** The extension's own settings: read straight from the live `HostEnv`, not from omp. */
	private hostSettingViews(): HostSettingView[] {
		return Object.entries(HOST_SETTINGS).map(([key, spec]) => ({
			key,
			label: spec.label,
			description: spec.description,
			value: spec.read(this.env),
			minimum: spec.minimum,
			maximum: spec.maximum,
		}));
	}

	/**
	 * Assign (or clear) one role.
	 *
	 * The whole record is re-read immediately before writing because
	 * `modelRoles.smol` is not a settable key: the only write form is the entire
	 * record, so a stale copy would silently revert someone else's role.
	 */
	async setRole(role: string, selector: string | null): Promise<void> {
		if (!MODEL_ROLES.some((definition) => definition.role === role)) {
			this.sink.notice(`未知的模型角色：${role}`, "error");
			return;
		}
		if (selector) {
			// The picker only offers catalog entries, so an unknown selector means a
			// stale page. An empty catalog means omp failed - do not block on that.
			const catalog = await this.catalog();
			if (catalog.length > 0 && !resolveSelector(selector, catalog)) {
				this.sink.notice(`模型目录里没有 ${selector}，未写入`, "warn");
				return;
			}
		}
		await this.mutate("保存模型角色", async () => {
			const inv = this.invocation();
			const roles = readModelRoles(await readSettings(inv));
			if (selector === null || selector === "") delete roles[role];
			else roles[role] = selector;
			await writeModelRoles(inv, roles);
		});
	}

	async setScalar(key: string, value: string | number | boolean): Promise<void> {
		const spec = SCALAR_SETTINGS[key];
		if (!spec) {
			this.sink.notice(`这个设置项不可编辑：${key}`, "error");
			return;
		}
		if (!spec.choices.includes(String(value))) {
			this.sink.notice(`${key} 不接受 ${String(value)}`, "error");
			return;
		}
		await this.mutate("保存设置", () => writeSetting(this.invocation(), key, String(value)));
	}

	/**
	 * Write one of the extension's own settings.
	 *
	 * Separate from `setScalar`: that one runs `omp config set` against `config.yml`,
	 * this one writes `ompStudio.<key>` through VS Code's own configuration. A value that
	 * does not take effect - a workspace or folder override outranks the global write - is
	 * reported rather than leaving the page looking like it saved nothing.
	 */
	async setHostSetting(key: string, value: number): Promise<void> {
		const spec = HOST_SETTINGS[key];
		if (!spec) {
			this.sink.notice(`这个设置项不可编辑：${key}`, "error");
			return;
		}
		if (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum) {
			this.sink.notice(`${spec.label}需要 ${spec.minimum}–${spec.maximum} 之间的整数`, "error");
			return;
		}
		await this.mutate(`保存${spec.label}`, async () => {
			const effective = await this.hostSettings.set(key, value);
			if (effective !== value) {
				this.sink.notice(
					`已写入用户设置，但当前生效值仍是 ${effective}：工作区或文件夹设置里的 ompStudio.${key} 覆盖了它`,
					"warn",
				);
			}
		});
	}

	async saveProvider(originalId: string | undefined, draft: ProviderDraft, firstModel?: ModelDraft): Promise<void> {
		const problems = validateProviderDraft(draft);
		if (problems.length > 0) {
			this.sink.notice(problems.join("；"), "error");
			return;
		}
		const modelProblems = firstModel ? validateModelDraft(firstModel) : [];
		if (modelProblems.length > 0) {
			this.sink.notice(modelProblems.join("；"), "error");
			return;
		}
		await this.editModelsFile("保存提供商", async (raw) => {
			const created = upsertProvider(raw, draft, originalId);
			// One write for a new provider and its first model: one sandbox run, one backup.
			const next = firstModel ? upsertModel(created, draft.id, firstModel) : created;
			return { next, expected: providerExpectation(next, draft.id) };
		});
	}

	async removeProvider(id: string): Promise<void> {
		await this.editModelsFile("删除提供商", async (raw) => {
			const next = deleteProviderInFile(raw, id);
			return { next, expected: undefined };
		});
	}

	async saveModel(providerId: string, originalId: string | undefined, draft: ModelDraft): Promise<void> {
		const problems = validateModelDraft(draft);
		if (problems.length > 0) {
			this.sink.notice(problems.join("；"), "error");
			return;
		}
		await this.editModelsFile("保存模型", async (raw) => {
			const next = upsertModel(raw, providerId, draft, originalId);
			return { next, expected: providerExpectation(next, providerId) };
		});
	}

	async removeModel(providerId: string, id: string): Promise<void> {
		await this.editModelsFile("删除模型", async (raw) => {
			const next = deleteModelInFile(raw, providerId, id);
			return { next, expected: providerExpectation(next, providerId) };
		});
	}

	private async catalog(): Promise<ModelCatalogEntry[]> {
		return readModelCatalog(this.invocation()).catch(() => []);
	}

	/** Run a mutation, then re-read so the page can never show a value that is not on disk. */
	private async mutate(what: string, run: () => Promise<void>): Promise<void> {
		this.sink.busy(true, what);
		let ok = false;
		try {
			await run();
			ok = true;
		} catch (error) {
			this.sink.notice(`${what}失败：${message(error)}`, "error");
		} finally {
			try {
				await this.refresh();
			} catch (error) {
				this.sink.notice(`重新读取失败：${message(error)}`, "error");
			}
			this.sink.busy(false, undefined, ok);
		}
	}

	private async editModelsFile(
		what: string,
		build: (raw: string) => Promise<{ next: string; expected: ProviderExpectation | undefined }>,
	): Promise<void> {
		this.sink.busy(true, what);
		let ok = false;
		try {
			const paths = this.paths();
			const loaded = await readModelsFile(paths.modelsFile);
			if (loaded.exists && this.modelsMtime !== undefined && loaded.mtimeMs !== this.modelsMtime) {
				throw new Error("models.yml 已被外部修改，请先「重新读取」再保存（没有覆盖任何内容）");
			}
			const { next, expected } = await build(loaded.raw);
			await this.commitModelsFile(paths.modelsFile, next, expected);
			ok = true;
			this.sink.notice(`${what}成功`, "info");
		} catch (error) {
			this.sink.notice(`${what}失败：${message(error)}`, "error");
		} finally {
			try {
				await this.refresh();
			} catch (error) {
				this.sink.notice(`重新读取失败：${message(error)}`, "error");
			}
			this.sink.busy(false, undefined, ok);
		}
	}

	/**
	 * The three protection layers around a `models.yml` write, in order:
	 *
	 * 1. the caller already produced `next` through a comment-preserving edit;
	 * 2. a real omp loads it in a throwaway agent dir - nothing is written unless
	 *    omp resolves the provider/models out of it;
	 * 3. the live file is backed up, written atomically, then re-verified, and
	 *    rolled back if omp cannot see the change.
	 *
	 * A "cli" verdict means omp itself could not run (an empty agent dir has no
	 * catalog DB), which says nothing about our file, so it only warns.
	 */
	private async commitModelsFile(
		modelsFile: string,
		next: string,
		expected: ProviderExpectation | undefined,
	): Promise<void> {
		if (expected && expected.modelIds.length > 0) {
			const sandboxDir = await mkdtemp(join(tmpdir(), "omp-studio-models-"));
			try {
				await writeFile(join(sandboxDir, "models.yml"), next, "utf8");
				const verdict = await validateModelsFile(this.invocation(), sandboxDir, expected);
				if (!verdict.ok && verdict.kind === "unresolved") {
					throw new Error(`omp 没有接受这份配置（未写入任何内容）：${verdict.reason}`);
				}
				if (!verdict.ok) {
					this.sink.notice(`写前校验无法完成（${verdict.reason}），改为写入后校验`, "warn");
				}
			} finally {
				await rm(sandboxDir, { recursive: true, force: true });
			}
		}

		const { backup } = await writeModelsFileAtomic(modelsFile, next);
		if (!expected) return;

		const verdict = await validateModelsFile(this.invocation(), agentDir(this.env.homeDir), expected);
		if (!verdict.ok && verdict.kind === "unresolved") {
			if (backup) await restoreBackup(backup, modelsFile);
			this.modelsMtime = (await readModelsFile(modelsFile)).mtimeMs;
			throw new Error(`写入后 omp 看不到这次改动${backup ? "，已回滚" : ""}：${verdict.reason}`);
		}
		this.modelsMtime = (await readModelsFile(modelsFile)).mtimeMs;
	}
}

interface ProviderExpectation {
	provider: string;
	modelIds: string[];
}

/** What omp should be able to see once `raw` is in place. */
function providerExpectation(raw: string, providerId: string): ProviderExpectation | undefined {
	const found = readProviders(raw).providers.find((provider) => provider.id === providerId);
	if (!found) return undefined;
	return { provider: providerId, modelIds: found.models.map((model) => model.id) };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
