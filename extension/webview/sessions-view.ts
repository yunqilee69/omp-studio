import type { HistoryEntryView, TabSummary } from "../src/shared/protocol";

/**
 * The sessions list is one list for the whole workspace: every live instance *and* every
 * session file it has on disk (dev-plan §1.2). This module is DOM-free so the merging,
 * ordering and filter rules stay unit-testable.
 */

/**
 * One row of the sessions list that is a live instance, so the page answers "what are my
 * concurrent sessions doing right now".
 */
export interface SessionRow {
	/** Instance id: how the host selects or closes this session. */
	key: string;
	title: string;
	/** Mode reported by the instance, `""` until omp answers. */
	mode: string;
	status: SessionStatus;
	unread: boolean;
	/** jsonl of this session, absent until omp writes the first entry. */
	sessionFile?: string;
	/** What a pin or an archive is remembered by: the jsonl when there is one, else the instance id. */
	sessionKey: string;
	pinned: boolean;
	/** 完成（归档）: the row leaves the list until the archived rows are asked for. */
	archived: boolean;
}

export type SessionStatus = "busy" | "running" | "failed" | "idle";

/** Row meta text: the tab strip's dot, spelled out. */
export const STATUS_LABELS: Record<SessionStatus, string> = {
	busy: "运行中",
	running: "空闲",
	failed: "已停止",
	idle: "已停止",
};

/**
 * The identity a pin or an archive is remembered by. The jsonl comes first, so a resumed
 * conversation keeps both flags; an instance too young to have written one is keyed by id,
 * which only matters for the seconds before omp reports its session file.
 */
export function sessionKeyOf(tab: { id: string; sessionFile?: string }): string {
	return tab.sessionFile ?? tab.id;
}

function statusOf(tab: TabSummary): SessionStatus {
	if (tab.failed) return "failed";
	if (tab.busy) return "busy";
	return tab.running ? "running" : "idle";
}

/**
 * One session file of this workspace: a click resumes it into a new instance. Files a live
 * instance already owns never become this row - the instance row stands for them, so the
 * same conversation is never listed twice.
 */
export interface HistoryRow {
	file: string;
	title: string;
	mode: string;
	updatedAt: number;
	/** A file row has no instance to fall back to, so the path is the key. */
	sessionKey: string;
	pinned: boolean;
	/** 完成（归档）: same flag as a live row's, kept by the same key. */
	archived: boolean;
}

/** A rendered list row: the two kinds differ in how they open, not in how they are flagged. */
export type ListRow = { kind: "live"; row: SessionRow } | { kind: "history"; row: HistoryRow };

/**
 * What the list is filtered and ordered by. Pins and archives are view preferences, so they
 * arrive as keys and the host stays authoritative for everything else.
 */
export interface ListView {
	/** Keys of the pinned sessions; absent means "none are". */
	pins?: ReadonlySet<string>;
	/** Keys of the finished (archived) sessions; absent likewise. */
	archived?: ReadonlySet<string>;
	/** Show the archived rows too (the list's 更多 section is open). */
	showArchived?: boolean;
	/**
	 * Title substring. It filters the same rows and never reveals what the archive flag
	 * hid: 归档 is a scope, and the 更多 line is what widens it.
	 */
	query?: string;
}

/** The rows to draw, plus how many the archive flag kept back. */
export interface SessionList {
	rows: ListRow[];
	/**
	 * Archived rows matching the current filter, shown or hidden - the count the 更多 line
	 * needs. Keys of sessions that are no longer in the list at all are not counted.
	 */
	archived: number;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The list's rows: live instances and this workspace's session files, deduplicated by
 * jsonl, filtered by title substring. Pinned rows come first, then live rows in the host's
 * creation order, then files in the host's newest-first order; archived rows follow all of
 * them and only when asked for.
 *
 * The search field filters on the title alone - the name is what a conversation is
 * recognised by, and a jsonl's path (a timestamp for most of them) is not something the
 * user reads off the row.
 */
export function buildSessionList(
	tabs: readonly TabSummary[],
	entries: readonly HistoryEntryView[],
	list: ListView,
): SessionList {
	const { pins = NO_KEYS, archived = NO_KEYS, showArchived = false, query = "" } = list;
	const needle = query.trim().toLowerCase();
	const matches = (title: string) => needle === "" || title.toLowerCase().includes(needle);
	// A resumed instance may not have registered as the file's owner yet; its own
	// `sessionFile` is the same fact, so both count as "already listed above".
	const owned = new Set<string>();
	for (const tab of tabs) if (tab.sessionFile) owned.add(tab.sessionFile);

	const live: ListRow[] = [];
	for (const tab of tabs) {
		if (!matches(tab.title)) continue;
		const sessionKey = sessionKeyOf(tab);
		const row: SessionRow = {
			key: tab.id,
			title: tab.title,
			mode: tab.mode,
			status: statusOf(tab),
			unread: tab.unread,
			sessionFile: tab.sessionFile,
			sessionKey,
			pinned: pins.has(sessionKey),
			archived: archived.has(sessionKey),
		};
		live.push({ kind: "live", row });
	}

	const history: ListRow[] = [];
	for (const entry of entries) {
		if (entry.openTabId !== undefined || owned.has(entry.file)) continue;
		if (!matches(entry.title)) continue;
		history.push({
			kind: "history",
			row: {
				file: entry.file,
				title: entry.title,
				mode: entry.mode,
				updatedAt: entry.updatedAt,
				sessionKey: entry.file,
				pinned: pins.has(entry.file),
				archived: archived.has(entry.file),
			},
		});
	}

	const open: ListRow[] = [];
	const finished: ListRow[] = [];
	for (const row of [...live, ...history]) (row.row.archived ? finished : open).push(row);
	// What is still open keeps the top of the page: finished rows only trail it, and only
	// when the 更多 section asked for them.
	return {
		rows: showArchived ? [...order(open), ...order(finished)] : order(open),
		archived: finished.length,
	};
}

/** Pinned rows first - instances, then files - and the rest after them. */
function order(rows: readonly ListRow[]): ListRow[] {
	const byKind = (kind: ListRow["kind"], pinned: boolean) =>
		rows.filter((row) => row.kind === kind && row.row.pinned === pinned);
	return [...byKind("live", true), ...byKind("history", true), ...byKind("live", false), ...byKind("history", false)];
}
