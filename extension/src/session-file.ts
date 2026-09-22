import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentMessage } from "./rpc/types";

/**
 * Mode strings omp persists in `mode_change` entries. Observed in real session
 * files (`plan`, `none`, `vibe`) plus the literals in omp 18.1.2's runtime
 * (`plan_paused`, `goal`).
 */
export const MODE_LABELS: Record<string, string> = {
	none: "Normal",
	plan: "Plan",
	plan_paused: "Plan (paused)",
	goal: "Goal",
	vibe: "Vibe",
};

/**
 * Never invent a mode: an unrecognized value is shown exactly as omp wrote it,
 * because omp may add modes and the panel must stay truthful.
 */
export function modeLabel(mode: string | undefined): string {
	return mode ? (MODE_LABELS[mode] ?? mode) : MODE_LABELS.none;
}

const HEAD_BYTES = 262_144;
const TAIL_BYTES = 131_072;

/**
 * omp's agent directory, resolved the way omp 18.1.2 resolves it (`To.agentDir`):
 * `$PI_CODING_AGENT_DIR`, else `<configRoot>/agent` where configRoot is
 * `$PI_CONFIG_DIR` (default `.omp`) plus the `$OMP_PROFILE`/`$PI_PROFILE` profile.
 * Sessions, config.yml and the user mcp.json all live here.
 */
export function agentDir(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	const configured = env.PI_CONFIG_DIR?.trim();
	const root = configured ? (isAbsolute(configured) ? configured : join(homeDir, configured)) : join(homeDir, ".omp");
	const profile = env.OMP_PROFILE?.trim() || env.PI_PROFILE?.trim();
	return profile ? join(root, "profiles", profile, "agent") : join(root, "agent");
}

export function sessionsRoot(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(homeDir, env), "sessions");
}

/**
 * omp's session bucket name for a cwd: the home prefix is stripped, then every `/`
 * becomes `-`. Verified against omp 18.1.2:
 *   /home/u/proj      (home=/home/u) -> "-proj"
 *   /tmp/a/b                         -> "-tmp-a-b"
 */
export function encodeCwdBucket(cwd: string, homeDir: string): string {
	const home = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
	const relative = cwd === home || cwd.startsWith(`${home}/`) ? cwd.slice(home.length) : cwd;
	return relative.replace(/\//g, "-");
}

export function bucketDir(cwd: string, homeDir: string): string {
	return join(sessionsRoot(homeDir), encodeCwdBucket(cwd, homeDir));
}

/** Artifacts (subagent output, bash logs) live next to the session file, minus `.jsonl`. */
export function artifactsDir(sessionFile: string): string {
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile;
}

export interface SessionSummary {
	file: string;
	title: string;
	mode: string;
	planFilePath?: string;
	updatedAt: number;
	bytes: number;
	firstUserText?: string;
}

async function readRange(file: string, start: number, length: number): Promise<string> {
	const { open } = await import("node:fs/promises");
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

interface EntryScan {
	title?: string;
	mode?: string;
	planFilePath?: string;
	firstUserText?: string;
}

function scanLines(text: string, state: EntryScan, skipFirstPartial: boolean): void {
	const lines = text.split("\n");
	if (skipFirstPartial && lines.length > 0) lines.shift();
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "title" && typeof entry.title === "string" && entry.title.trim().length > 0) {
			state.title = entry.title.trim();
		} else if (entry.type === "mode_change" && typeof entry.mode === "string") {
			state.mode = entry.mode;
			const data = entry.data as { planFilePath?: unknown } | undefined;
			const planPath = data?.planFilePath;
			state.planFilePath = typeof planPath === "string" && planPath.length > 0 ? planPath : undefined;
		} else if (entry.type === "message") {
			const message = entry.message as AgentMessage | undefined;
			if (!state.firstUserText && message?.role === "user") {
				const content = message.content;
				if (Array.isArray(content)) {
					const text = content
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => (part as { text: string }).text)
						.join(" ")
						.trim();
					if (text.length > 0) state.firstUserText = text;
				}
			}
		}
	}
}

/** Head/tail scan of a session jsonl: cheap enough to run per picker entry. */
export async function readSessionSummary(file: string): Promise<SessionSummary> {
	const info = await stat(file);
	const state: EntryScan = {};
	const head = await readRange(file, 0, Math.min(HEAD_BYTES, info.size));
	scanLines(head, state, false);
	if (info.size > HEAD_BYTES) {
		const tailStart = Math.max(0, info.size - TAIL_BYTES);
		const tail = await readRange(file, tailStart, info.size - tailStart);
		scanLines(tail, state, tailStart > 0);
	}
	const title = state.title ?? titleFromText(state.firstUserText);
	return {
		file,
		title,
		mode: state.mode ?? "none",
		planFilePath: state.planFilePath,
		updatedAt: info.mtimeMs,
		bytes: info.size,
		firstUserText: state.firstUserText,
	};
}

export function titleFromText(text: string | undefined): string {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/** Messages of a session/agent jsonl, oldest first. Used for read-only transcripts. */
export async function readSessionMessages(file: string, limit = 200): Promise<AgentMessage[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const messages: AgentMessage[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage | undefined;
		if (message && typeof message === "object" && Array.isArray(message.content)) messages.push(message);
	}
	return messages.slice(-limit);
}

/** Sessions in a cwd bucket, newest first. U1 gap fallback: direct directory scan. */
export async function listBucketSessions(cwd: string, homeDir: string, limit = 50): Promise<SessionSummary[]> {
	const dir = bucketDir(cwd, homeDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const files = names.filter((name) => name.endsWith(".jsonl"));
	const stats = await Promise.all(
		files.map(async (name) => {
			const file = join(dir, name);
			try {
				return { file, mtime: (await stat(file)).mtimeMs };
			} catch {
				return undefined;
			}
		}),
	);
	const ordered = stats
		.filter((entry): entry is { file: string; mtime: number } => entry !== undefined)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit);
	const summaries: SessionSummary[] = [];
	for (const entry of ordered) {
		try {
			summaries.push(await readSessionSummary(entry.file));
		} catch {
			// A session that vanished or is unreadable mid-scan is skipped, not fatal.
		}
	}
	return summaries;
}
