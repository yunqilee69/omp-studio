/**
 * Composer completion logic for `/commands` and `@files`, DOM-free so the
 * matching rules are unit-testable without a webview.
 *
 * `/` mode: the whole input is the token, matched against slash command names.
 * `@` mode: the token is the trailing `@word` after whitespace (or input start);
 * matched against workspace-relative file paths. The agent reads the file
 * itself — we only insert the path text.
 */

export interface CompletionCommand {
	name: string;
	description?: string;
}

export interface CompletionOption {
	label: string;
	description?: string;
	/** Full input value after accepting this option. */
	value: string;
}

export interface Completions {
	kind: "command" | "file";
	options: CompletionOption[];
	active: number;
}

const MAX_OPTIONS = 12;

/**
 * Full-name prefix hits first (`/mod` → `model`), then tail matches on the
 * segment after the last namespace colon (`/find-skills` →
 * `skill:find-skills`), so skills can be typed without their `skill:`
 * prefix. Inserted text keeps the full name.
 */
function rankCommands(commands: CompletionCommand[], query: string): CompletionCommand[] {
	if (!query) return commands;
	const full: CompletionCommand[] = [];
	const tail: CompletionCommand[] = [];
	for (const command of commands) {
		const lower = command.name.toLowerCase();
		if (lower.startsWith(query)) full.push(command);
		else {
			const suffix = lower.slice(lower.lastIndexOf(":") + 1);
			if (suffix !== lower && suffix.startsWith(query)) tail.push(command);
		}
	}
	return [...full, ...tail];
}

export function computeCompletions(
	input: string,
	commands: CompletionCommand[],
	files: string[],
): Completions | undefined {
	if (input.startsWith("/") && !input.includes(" ")) {
		const query = input.slice(1).toLowerCase();
		const options = rankCommands(commands, query)
			.slice(0, MAX_OPTIONS)
			.map((command) => ({
				label: `/${command.name}`,
				description: command.description,
				value: `/${command.name} `,
			}));
		if (options.length === 0) return undefined;
		return { kind: "command", options, active: 0 };
	}

	const atIndex = input.lastIndexOf("@");
	if (atIndex === -1) return undefined;
	const before = atIndex === 0 ? "" : input[atIndex - 1];
	if (before !== "" && !/\s/.test(before)) return undefined;
	const query = input.slice(atIndex + 1);
	if (/[\s@]/.test(query)) return undefined;
	const options = rankFiles(files, query.toLowerCase())
		.slice(0, MAX_OPTIONS)
		.map((file) => ({
			label: file,
			value: `${input.slice(0, atIndex)}@${file} `,
		}));
	if (options.length === 0) return undefined;
	return { kind: "file", options, active: 0 };
}

/** Next/previous option, wrapping. Kept pure so the popup's keys are unit-testable. */
export function cycleActive(active: number, count: number, offset: number): number {
	if (count <= 0) return 0;
	return ((active + offset) % count + count) % count;
}

/** Basename prefix hits first, then any path substring hit, each in list order. */
function rankFiles(files: string[], query: string): string[] {
	if (!query) return files;
	const basenameHits: string[] = [];
	const substringHits: string[] = [];
	for (const file of files) {
		const lower = file.toLowerCase();
		const base = lower.slice(lower.lastIndexOf("/") + 1);
		if (base.startsWith(query)) basenameHits.push(file);
		else if (lower.includes(query)) substringHits.push(file);
	}
	return [...basenameHits, ...substringHits];
}
