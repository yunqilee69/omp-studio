import { execFile } from "node:child_process";
import type { ModelCatalogEntry } from "./shared/model-drafts";

/**
 * The `omp config` / `omp models` CLI surface the settings page reads and writes.
 *
 * This is the *only* way the extension changes `config.yml`: `omp config set`
 * owns that file's lock and does node-level edits, so omp stays its single
 * writer. `models.yml` has no CLI writer at all (`omp models` is read-only), so
 * that file is handled by `models-file.ts` instead.
 *
 * The parse functions are exported separately from the spawn wrappers so tests
 * can feed them recorded CLI output without launching omp.
 */
export interface OmpInvocation {
	/** Executable on PATH or an absolute path. */
	ompPath: string;
	/** Working directory for the child. `config set` writes the profile config regardless of cwd. */
	cwd: string;
	/** Overrides `process.env` when set (used to point omp at a throwaway agent dir). */
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

/** A CLI failure carrying omp's own stderr, which is the part worth showing a user. */
export class OmpCliError extends Error {
	constructor(
		message: string,
		/** omp's stderr, verbatim. */
		readonly detail: string,
		readonly exitCode?: number,
	) {
		super(detail ? `${message}：${detail}` : message);
		this.name = "OmpCliError";
	}
}

/** One `omp config list --json` entry. Credential keys report `redacted` and carry no value. */
export interface SettingsEntry {
	value?: unknown;
	type: string;
	description: string;
	redacted?: boolean;
}

export type SettingsRecord = Record<string, SettingsEntry>;

const CONFIG_TIMEOUT_MS = 15_000;
// `models ls` may fall back to the catalog DB, so it gets a longer leash than config reads.
const MODELS_TIMEOUT_MS = 30_000;

interface CliOutput {
	stdout: string;
	stderr: string;
}

async function runOmp(inv: OmpInvocation, args: string[]): Promise<CliOutput> {
	return new Promise<CliOutput>((resolve, reject) => {
		execFile(
			inv.ompPath,
			args,
			{
				cwd: inv.cwd,
				env: inv.env ?? process.env,
				timeout: inv.timeoutMs ?? CONFIG_TIMEOUT_MS,
				maxBuffer: 32 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const code = typeof error.code === "number" ? error.code : undefined;
					reject(new OmpCliError(`omp ${args.join(" ")} 失败`, stderr.trim() || error.message, code));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** `omp config list --json`: a flat map of already-dotted key -> `{ value, type, description }`. */
export function parseSettings(raw: string): SettingsRecord {
	const parsed = asRecord(JSON.parse(raw));
	if (!parsed) throw new Error("omp config list --json 不是对象");
	const settings: SettingsRecord = {};
	for (const [key, entry] of Object.entries(parsed)) {
		const record = asRecord(entry);
		if (!record) continue;
		settings[key] = {
			value: record.value,
			type: typeof record.type === "string" ? record.type : "string",
			description: typeof record.description === "string" ? record.description : "",
			redacted: record.redacted === true,
		};
	}
	return settings;
}

/**
 * `omp models ls --json` -> `{ models: [...] }`, sorted by provider then id.
 *
 * This is the settings page's catalog rather than RPC `get_available_models`
 * because it also lists custom `models.yml` providers and reports each model's
 * allowed `thinking` levels, which is what a role assignment needs.
 */
export function parseModelCatalog(raw: string): ModelCatalogEntry[] {
	const root = asRecord(JSON.parse(raw));
	const models = root?.models;
	if (!Array.isArray(models)) throw new Error("omp models ls --json 里没有 models 数组");
	const catalog: ModelCatalogEntry[] = [];
	for (const item of models) {
		const record = asRecord(item);
		if (!record) continue;
		const provider = typeof record.provider === "string" ? record.provider : undefined;
		const id = typeof record.id === "string" ? record.id : undefined;
		if (!provider || !id) continue;
		catalog.push({
			provider,
			id,
			selector: typeof record.selector === "string" && record.selector ? record.selector : `${provider}/${id}`,
			name: typeof record.name === "string" ? record.name : undefined,
			contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : undefined,
			maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : undefined,
			reasoning: typeof record.reasoning === "boolean" ? record.reasoning : undefined,
			thinking: Array.isArray(record.thinking) ? record.thinking.filter((v): v is string => typeof v === "string") : null,
			input: Array.isArray(record.input) ? record.input.filter((v): v is string => typeof v === "string") : null,
		});
	}
	return catalog;
}

export function parseVersion(raw: string): string | undefined {
	const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
	return line || undefined;
}

export async function readSettings(inv: OmpInvocation): Promise<SettingsRecord> {
	return parseSettings((await runOmp(inv, ["config", "list", "--json"])).stdout);
}

/**
 * The `modelRoles` record (`{ default: "Provider/model:level" }`).
 *
 * Read as a whole: `modelRoles.smol` is not a registered setting key, so
 * `omp config get modelRoles.smol` fails with "Unknown setting" and the only
 * write form is the entire record.
 */
export function readModelRoles(settings: SettingsRecord): Record<string, string> {
	const value = asRecord(settings.modelRoles?.value);
	if (!value) return {};
	const roles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(value)) {
		if (typeof selector === "string" && selector.trim()) roles[role] = selector;
	}
	return roles;
}

export async function writeModelRoles(inv: OmpInvocation, roles: Record<string, string>): Promise<void> {
	await runOmp(inv, ["config", "set", "modelRoles", JSON.stringify(roles)]);
}

/** Write one scalar/array/record setting. omp validates the declared type and exits non-zero on a mismatch. */
export async function writeSetting(inv: OmpInvocation, key: string, value: string | number | boolean | string[]): Promise<void> {
	const encoded = typeof value === "string" ? value : JSON.stringify(value);
	await runOmp(inv, ["config", "set", key, encoded]);
}

export async function readModelCatalog(inv: OmpInvocation): Promise<ModelCatalogEntry[]> {
	return parseModelCatalog((await runOmp({ ...inv, timeoutMs: MODELS_TIMEOUT_MS }, ["models", "ls", "--json"])).stdout);
}

export async function readVersion(inv: OmpInvocation): Promise<string | undefined> {
	return parseVersion((await runOmp(inv, ["--version"])).stdout);
}

/**
 * The result of asking a real omp to load a candidate `models.yml`.
 *
 * `kind` matters: an empty agent dir has no catalog DB, so `omp models ls` can
 * fail for reasons that say nothing about our file. Those must not block a
 * legitimate save, so callers treat `cli` as inconclusive and only act on
 * `unresolved`, which means omp read the file and the provider was not in it
 * (`models.yml` validation failure makes omp disable *all* custom providers).
 */
export type ModelsValidation =
	| { ok: true }
	| { ok: false; kind: "cli"; reason: string }
	| { ok: false; kind: "unresolved"; reason: string };

/**
 * Validate a candidate `models.yml` against the real omp, in a throwaway agent
 * dir, before it is allowed anywhere near the user's file.
 *
 * `PI_CODING_AGENT_DIR` is the same override `session-file.ts` already resolves,
 * so pointing it at a temp dir makes omp read exactly one file: the candidate.
 */
export async function validateModelsFile(
	inv: OmpInvocation,
	agentDir: string,
	expected: { provider: string; modelIds: string[] },
): Promise<ModelsValidation> {
	const sandbox: OmpInvocation = {
		...inv,
		env: { ...(inv.env ?? process.env), PI_CODING_AGENT_DIR: agentDir },
		timeoutMs: MODELS_TIMEOUT_MS,
	};
	let catalog: ModelCatalogEntry[];
	let stderr: string;
	try {
		const output = await runOmp(sandbox, ["models", "ls", "--json"]);
		stderr = output.stderr;
		catalog = parseModelCatalog(output.stdout);
	} catch (error) {
		return { ok: false, kind: "cli", reason: error instanceof Error ? error.message : String(error) };
	}
	if (/models\.yml validation failed/i.test(stderr)) {
		return { ok: false, kind: "unresolved", reason: stderr.trim() };
	}
	// A provider with no models produces no catalog rows, so "omp parsed the file
	// without a validation failure" is all that can be asserted for it.
	if (expected.modelIds.length === 0) return { ok: true };
	const provider = catalog.filter((entry) => entry.provider === expected.provider);
	if (provider.length === 0) {
		return {
			ok: false,
			kind: "unresolved",
			reason: `omp 没有解析出提供商 ${expected.provider}`,
		};
	}
	const missing = expected.modelIds.filter((id) => !provider.some((entry) => entry.id === id));
	if (missing.length > 0) {
		return { ok: false, kind: "unresolved", reason: `omp 没有解析出模型 ${missing.join("、")}` };
	}
	return { ok: true };
}
