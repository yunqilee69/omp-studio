import type { HostEnv } from "./config";
import { readCommandList } from "./command-list";
import { readModelCatalog, readModelRoles, readSettings, type SettingsRecord } from "./omp-config";
import { resolveSelector, type ModelCatalogEntry } from "./shared/model-drafts";
import { modeChoices, modeNote } from "./mode";
import type { ModelChoice, NewSessionView, SlashCommandView } from "./shared/protocol";

/**
 * What the composer of a session that does not exist yet shows (dev-plan §1.3).
 *
 * Read outside any session: there is no process to ask, and `omp models ls` is the list
 * `omp` itself resolves providers and credentials from, so the picker offers exactly the
 * models a first prompt could run on. The slash commands have no CLI reader, so they come
 * from a throwaway RPC probe (`readCommandList`) - the same source a live instance uses,
 * which is what keeps `/` behaving the same on both composers.
 */
export async function readNewSession(env: HostEnv): Promise<NewSessionView> {
	const inv = { ompPath: env.ompPath, cwd: env.workspaceRoot };
	// Independent reads, run together: the composer waits on all three before its pills and
	// its `/` list are complete. `allSettled` keeps a failure local to its own field.
	const [settingsRead, catalogRead, commandRead] = await Promise.allSettled([
		readSettings(inv),
		readModelCatalog(inv),
		readCommandList(env),
	]);
	const failures: string[] = [];
	const settings = settledValue(settingsRead, failures);
	const catalog = settledValue(catalogRead, failures) ?? [];
	// The probe reports its own failure and never rejects; its rows simply stay empty.
	return newSessionView(settings, catalog, failures, commandRead.status === "fulfilled" ? commandRead.value : []);
}

/** Unwraps one read, recording why it failed - in the order the reads are listed. */
function settledValue<T>(result: PromiseSettledResult<T>, failures: string[]): T | undefined {
	if (result.status === "fulfilled") return result.value;
	failures.push(detail(result.reason));
	return undefined;
}

/** The pure half, so the defaults are testable from recorded output without launching omp. */
export function newSessionView(
	settings: SettingsRecord | undefined,
	catalog: ModelCatalogEntry[],
	failures: readonly string[] = [],
	commands: SlashCommandView[] = [],
): NewSessionView {
	const roles = settings ? readModelRoles(settings) : {};
	const resolved = roles.default ? resolveSelector(roles.default, catalog) : undefined;
	const setting = settings?.defaultThinkingLevel?.value;
	return {
		model: resolved ? choiceOf(resolved.entry) : undefined,
		modes: modeChoices({ kind: "fresh" }),
		modeNote: modeNote({ kind: "fresh" }),
		// The role selector's own `:level` is what omp starts a session with; the config
		// scalar only applies when the role carries no suffix.
		thinking: resolved?.thinking ?? (typeof setting === "string" && setting.trim() ? setting : undefined),
		models: catalog.map(choiceOf),
		commands,
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
