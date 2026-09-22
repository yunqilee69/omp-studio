import type { HostEnv } from "./config";
import { readModelCatalog, readModelRoles, readSettings, type SettingsRecord } from "./omp-config";
import { resolveSelector, type ModelCatalogEntry } from "./shared/model-drafts";
import { MODE_NOTE, type ModelChoice, type NewSessionView } from "./shared/protocol";

/**
 * What the sessions-list composer shows before any instance exists (dev-plan §1.3).
 *
 * Read through the CLI, not a session's RPC: there is no process to ask yet, and
 * `omp models ls` is the list `omp` itself resolves providers and credentials from, so
 * the picker offers exactly the models a first prompt could run on.
 */
export async function readNewSession(env: HostEnv): Promise<NewSessionView> {
	const inv = { ompPath: env.ompPath, cwd: env.workspaceRoot };
	const failures: string[] = [];
	let settings: SettingsRecord | undefined;
	let catalog: ModelCatalogEntry[] = [];
	try {
		settings = await readSettings(inv);
	} catch (error) {
		failures.push(detail(error));
	}
	try {
		catalog = await readModelCatalog(inv);
	} catch (error) {
		failures.push(detail(error));
	}
	return newSessionView(settings, catalog, failures);
}

/** The pure half, so the defaults are testable from recorded CLI output without launching omp. */
export function newSessionView(
	settings: SettingsRecord | undefined,
	catalog: ModelCatalogEntry[],
	failures: readonly string[] = [],
): NewSessionView {
	const roles = settings ? readModelRoles(settings) : {};
	const resolved = roles.default ? resolveSelector(roles.default, catalog) : undefined;
	const setting = settings?.defaultThinkingLevel?.value;
	return {
		modeNote: MODE_NOTE,
		model: resolved ? choiceOf(resolved.entry) : undefined,
		// The role selector's own `:level` is what omp starts a session with; the config
		// scalar only applies when the role carries no suffix.
		thinking: resolved?.thinking ?? (typeof setting === "string" && setting.trim() ? setting : undefined),
		models: catalog.map(choiceOf),
		error: failures.length > 0 ? failures.join("；") : undefined,
	};
}

function choiceOf(entry: ModelCatalogEntry): ModelChoice {
	return {
		provider: entry.provider,
		id: entry.id,
		label: entry.name || entry.id,
		contextWindow: entry.contextWindow,
	};
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
