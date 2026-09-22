import type { ToolItem } from "../src/shared/protocol";

/**
 * One transcript row per tool call, in the style of the terminal agent UIs: a
 * glyph, a verb, the thing it touched, and the numbers omp reported. The DOM
 * layer stays dumb; everything wordy lives here, where it is testable.
 *
 * An unmapped tool keeps its own name as the verb. Translating a tool this build
 * has never seen would mean guessing what it did.
 */
const TOOLS: Record<string, { glyph: string; verb: string }> = {
	read: { glyph: "🔍", verb: "读取" },
	edit: { glyph: "✎", verb: "编辑" },
	write: { glyph: "✎", verb: "写入" },
	// `>_`: the webview loads no icon font, and the single-glyph stand-ins for a shell
	// (▢, ❯) read as a checkbox or a chevron instead of a terminal.
	bash: { glyph: ">_", verb: "终端" },
	grep: { glyph: "🔍", verb: "搜索" },
	glob: { glyph: "🔍", verb: "查找" },
	task: { glyph: "👥", verb: "子智能体" },
	hub: { glyph: "👥", verb: "子智能体" },
	todo: { glyph: "☑", verb: "待办" },
	browser: { glyph: "🌐", verb: "浏览器" },
	web_search: { glyph: "🌐", verb: "联网搜索" },
	eval: { glyph: "ƒ", verb: "求值" },
	yield: { glyph: "↩", verb: "交付" },
	ask: { glyph: "?", verb: "提问" },
	inspect_image: { glyph: "🖼", verb: "看图" },
};

export interface ToolLine {
	glyph: string;
	verb: string;
	/** What the row names: the file, the command line, or what the agent said it was doing. */
	subject?: string;
	/** True when the subject is a path or a command and belongs in the monospace face. */
	mono: boolean;
	/** Muted parent directory, only for a subject that is a file. */
	directory?: string;
	/** Hover text: the full subject, the stated intent and, when it failed, why. */
	title?: string;
	/** The call failed: the row carries a red "执行失败". */
	failed: boolean;
}

export function toolLine(tool: ToolItem): ToolLine {
	const known = TOOLS[tool.name];
	const line: ToolLine = {
		glyph: known?.glyph ?? "•",
		verb: known?.verb ?? tool.name,
		mono: false,
		failed: tool.status === "error",
	};

	const command = tool.command ? oneLine(tool.command) : undefined;
	const path = tool.path ?? tool.files[0];
	if (command) {
		line.subject = command;
		line.mono = true;
	} else if (path) {
		const split = splitPath(path);
		line.subject = split.name;
		line.directory = split.directory;
		line.mono = true;
	} else if (tool.intent) {
		// Nothing to name (a todo update, a plan step): the stated intent reads
		// better than an empty row, and better than a fabricated file name.
		line.subject = tool.intent;
	}

	line.title = [command ?? path, tool.intent, tool.errorText].filter((part): part is string => !!part).join("\n");
	return line;
}

/** `extension/webview/main.ts` → `{ name: "main.ts", directory: "extension/webview/" }`. */
export function splitPath(path: string): { name: string; directory?: string } {
	const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const cut = clean.lastIndexOf("/");
	if (cut < 0) return { name: clean };
	const name = clean.slice(cut + 1);
	return name ? { name, directory: clean.slice(0, cut + 1) } : { name: clean };
}

/** A bash command is one row: newlines would turn it back into a block. */
function oneLine(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

/** `思考 · 持续了 4 秒`; a turn replayed from history has no number to show. */
export function thinkingLabel(thinkingMs?: number): string {
	return thinkingMs === undefined ? "思考" : `思考 · 持续了 ${humanDuration(thinkingMs)}`;
}

export function humanDuration(ms: number): string {
	if (ms < 1000) return "不到 1 秒";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}
