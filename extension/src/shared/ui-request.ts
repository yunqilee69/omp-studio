import type { ChoiceOptionView } from "./protocol";

/**
 * omp's interactive requests, read into the shape the extension renders.
 *
 * omp drives a terminal UI and its RPC requests carry the strings it would have drawn:
 * a multi-select round prefixes the title with `(N selected) `, a question inside a
 * sequence suffixes it with ` (1/2)`, the free-form escape hatch is an option literally
 * named `Other (type your own)`, and the commit row is the theme's success glyph plus
 * `Done selecting` (docs/rpc-samples/ask.jsonl). This module is the only place that
 * knows those spellings: the extension host normalizes a frame once, and the webview
 * stays a renderer that never inspects label text.
 */

/** The free-form escape hatch omp appends to every `ask` option list. */
export const OTHER_OPTION = "Other (type your own)";

/** Suffix omp puts on an option the model marked recommended. */
export const RECOMMENDED_SUFFIX = " (Recommended)";

/**
 * Multi-select rounds count the picks in the title, which is how a question that
 * repeats with the same options is told apart from a new question.
 */
const SELECTED_TITLE = /^\((\d+) selected\)\s*/;

/** A question inside a sequence is suffixed with its position. */
const SEQUENCE_TITLE = /\s*\((\d+)\/(\d+)\)$/;

/**
 * Tail of the commit row. Its leading glyph is the theme's success symbol (`\uf00c` in
 * the default nerd-font preset), which moves with the user's `symbolPreset`, so only
 * this tail is stable across configurations.
 */
const DONE_SUFFIX = "Done selecting";

/** omp's own prompt line in an `editor` title; the panel draws its own input instead. */
const EDITOR_PROMPT = /^enter your response:?$/i;

/** One round of a `select` request. */
export interface SelectRound {
	/** The question itself, with omp's count and sequence markers removed. */
	question: string;
	options: ChoiceOptionView[];
	/** Picks omp reports for this question; `0` on the round that opens it. */
	selected: number;
	/** Position in a question sequence, absent for a single question. */
	progress?: { index: number; total: number };
}

/**
 * A `select` frame as a question plus rows. Descriptions come from omp's parallel
 * `optionDetails` array and are absent whenever the model wrote none.
 */
export function readSelect(
	title: string | undefined,
	options: readonly string[],
	descriptions: readonly (string | undefined)[] = [],
): SelectRound {
	let question = title ?? "";
	let selected = 0;
	const counted = SELECTED_TITLE.exec(question);
	if (counted) {
		selected = Number(counted[1]);
		question = question.slice(counted[0].length);
	}
	let progress: SelectRound["progress"];
	const sequenced = SEQUENCE_TITLE.exec(question);
	if (sequenced) {
		progress = { index: Number(sequenced[1]), total: Number(sequenced[2]) };
		question = question.slice(0, sequenced.index);
	}
	return {
		question: question.trim(),
		selected,
		progress,
		options: options.map((value, index) => optionOf(value, descriptions[index])),
	};
}

function optionOf(value: string, description: string | undefined): ChoiceOptionView {
	const role: ChoiceOptionView["role"] =
		value === OTHER_OPTION ? "other" : value.endsWith(DONE_SUFFIX) ? "done" : "option";
	const recommended = role === "option" && value.endsWith(RECOMMENDED_SUFFIX);
	return {
		value,
		label: recommended ? value.slice(0, -RECOMMENDED_SUFFIX.length) : value,
		description: description?.trim() || undefined,
		recommended,
		role,
	};
}

/**
 * `ask` serves `Other (type your own)` by opening an `editor` whose title is the
 * question, the option list it drew, and its own prompt line, separated by blank lines.
 * Split that back apart so the question stays the heading and the list becomes context
 * above the panel's textarea; without this the whole block would be one wrapped line.
 */
export function splitEditorTitle(title: string | undefined): { question?: string; context?: string } {
	const lines = (title ?? "").split("\n");
	const blank = lines.findIndex((line) => line.trim() === "");
	if (blank === -1) return { question: title?.trim() || undefined };
	const question = lines.slice(0, blank).join("\n").trim();
	const rest = lines.slice(blank + 1);
	while (rest.length > 0 && EDITOR_PROMPT.test(rest[rest.length - 1].trim())) rest.pop();
	const context = rest.join("\n").replace(/\s+$/, "").replace(/^\s+/, "");
	return { question: question || undefined, context: context || undefined };
}
