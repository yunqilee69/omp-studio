import { access, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { artifactsDir } from "./session-file";
import { isTextPart, type AgentMessage } from "./rpc/types";

export interface SubagentOutput {
	/** Final markdown (`<id>.md`) when the subagent produced one. */
	markdown?: string;
	/** Rendered read-only transcript fallback when no markdown exists. */
	transcript?: string;
	/** Path of the file that was read, for display. */
	source?: string;
	exists: boolean;
}

export function subagentArtifacts(subagentSessionFile: string, id: string): { markdown: string; jsonl: string; dir: string } {
	const jsonl = subagentSessionFile;
	const dir = artifactsDir(subagentSessionFile);
	return { markdown: join(dir, `${id}.md`), jsonl, dir };
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read-only subagent output.
 *
 * omp 18.1.2 layout (verified with docs/rpc-samples/subagent.jsonl): a subagent's
 * `subagent_lifecycle.sessionFile` is `<parentSessionStem>/<id>.jsonl`; the final
 * answer is the sibling `<id>.md`. No RPC command reads either, so the host reads
 * the files directly instead of spending a model turn on `agent://`.
 */
export async function readSubagentOutput(subagentSessionFile: string, id: string): Promise<SubagentOutput> {
	const paths = subagentArtifacts(subagentSessionFile, id);
	if (await exists(paths.markdown)) {
		try {
			return { markdown: await readFile(paths.markdown, "utf8"), source: paths.markdown, exists: true };
		} catch {
			return { exists: false };
		}
	}
	if (await exists(paths.jsonl)) {
		try {
			const raw = await readFile(paths.jsonl, "utf8");
			return { transcript: renderTranscript(raw), source: paths.jsonl, exists: true };
		} catch {
			return { exists: false };
		}
	}
	return { exists: false };
}

/** Last assistant text inside a subagent transcript, as a last-resort body. */
function renderTranscript(raw: string): string {
	const messages: AgentMessage[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
			if (entry.type === "message" && entry.message?.content) messages.push(entry.message);
		} catch {
			// skip malformed lines: a partially written jsonl must not break the view
		}
	}
	const parts: string[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		const text = message.content.filter(isTextPart).map((part) => part.text).join("").trim();
		if (!text) continue;
		const label = message.role === "user" ? "▸ 任务" : message.role === "assistant" ? "▸ 回复" : "▸ 工具输出";
		parts.push(`**${label}**\n\n${text}`);
	}
	return parts.join("\n\n---\n\n");
}

/**
 * `local://<name>` is session scratch space: omp resolves it to
 * `<sessionStem>/local/<name>` (verified against omp 18.1.2: a bash command writing
 * `local://probe-plan.md` lands in
 * `~/.omp/agent/sessions/<bucket>/<stem>/local/probe-plan.md`), and plan mode tells
 * the model to write `local://<slug>-plan.md`. Traversal outside that root is refused
 * exactly as omp refuses it.
 */
export function resolveLocalUrl(sessionFile: string, url: string): string | undefined {
	const root = join(artifactsDir(sessionFile), "local");
	const relative = url.slice("local://".length).replace(/^\/+/, "");
	if (relative.length === 0) return undefined;
	const resolved = resolve(root, relative);
	if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return undefined;
	return resolved;
}

export type PlanRead =
	| { ok: true; markdown: string; source: string }
	| { ok: false; reason: string };

/** Plan body referenced by the last `mode_change` entry. */
export async function readPlanFile(planFilePath: string | undefined, sessionFile: string | undefined): Promise<PlanRead> {
	if (!planFilePath) return { ok: false, reason: "当前会话没有计划（mode_change 未记录 planFilePath）" };
	let resolved: string | undefined = planFilePath;
	if (planFilePath.startsWith("local://")) {
		if (!sessionFile) return { ok: false, reason: `计划路径 ${planFilePath} 需要会话路径才能解析` };
		resolved = resolveLocalUrl(sessionFile, planFilePath);
		if (!resolved) return { ok: false, reason: `计划路径越界，已拒绝：${planFilePath}` };
	}
	if (!resolved) return { ok: false, reason: `无法解析计划路径 ${planFilePath}` };
	if (!(await exists(resolved))) return { ok: false, reason: `计划文件不存在：${resolved}` };
	try {
		return { ok: true, markdown: await readFile(resolved, "utf8"), source: resolved };
	} catch (error) {
		return { ok: false, reason: `计划文件不可读：${error instanceof Error ? error.message : String(error)}` };
	}
}
