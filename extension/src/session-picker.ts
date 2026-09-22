import { listBucketSessions } from "./session-file";
import type { HistoryEntryView } from "./shared/protocol";

/**
 * History picker data source.
 *
 * U1 gap (docs/upstream-issues.md): omp has no `list_sessions` RPC, so sessions
 * are discovered by scanning `~/.omp/agent/sessions/<encoded-cwd>/`. The bucket
 * encoding is verified against omp 18.1.2 in session-file.ts.
 */
export async function listHistoryEntries(
	cwd: string,
	homeDir: string,
	ownerOf: (file: string) => string | undefined,
	limit = 50,
): Promise<HistoryEntryView[]> {
	const summaries = await listBucketSessions(cwd, homeDir, limit);
	return summaries.map((summary) => ({
		file: summary.file,
		title: summary.title || "(未命名会话)",
		updatedAt: summary.updatedAt,
		mode: summary.mode,
		openTabId: ownerOf(summary.file),
	}));
}
