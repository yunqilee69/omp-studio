import { describe, expect, it } from "vitest";
import { OTHER_OPTION, readSelect, splitEditorTitle } from "../../src/shared/ui-request";

/** Frames copied from docs/rpc-samples/ask.jsonl (real `omp --mode rpc-ui` capture). */
describe("readSelect", () => {
	it("reads a plain question: descriptions join options, no flags invented", () => {
		const round = readSelect("用哪种存储后端", ["SQLite", "PostgreSQL", OTHER_OPTION], ["单文件，零运维", "需要服务端", ""]);
		expect(round.question).toBe("用哪种存储后端");
		expect(round.selected).toBe(0);
		expect(round.progress).toBeUndefined();
		expect(round.options).toEqual([
			{ value: "SQLite", label: "SQLite", description: "单文件，零运维", recommended: false, role: "option" },
			{ value: "PostgreSQL", label: "PostgreSQL", description: "需要服务端", recommended: false, role: "option" },
			{ value: OTHER_OPTION, label: OTHER_OPTION, description: undefined, recommended: false, role: "other" },
		]);
	});

	it("strips the picked-count prefix of a multi-select round and reports the count", () => {
		const round = readSelect("(1 selected) 要启用哪些检查项", ["lint", " Done selecting", OTHER_OPTION]);
		expect(round.question).toBe("要启用哪些检查项");
		expect(round.selected).toBe(1);
		expect(round.options.map((option) => option.role)).toEqual(["option", "done", "other"]);
	});

	it("matches the commit row by its suffix only: the glyph moves with the theme", () => {
		for (const glyph of ["", "\uf00c", "\ueab3", "✓"]) {
			const round = readSelect("t", [`${glyph} Done selecting`]);
			expect(round.options[0].role).toBe("done");
		}
	});

	it("strips the sequence suffix into progress", () => {
		const round = readSelect("用哪种语言 (1/2)", ["Go", "Rust"]);
		expect(round.question).toBe("用哪种语言");
		expect(round.progress).toEqual({ index: 1, total: 2 });
	});

	it("strips both markers of a picked round inside a sequence", () => {
		const round = readSelect("(2 selected) 要启用哪些检查项 (1/2)", ["a"]);
		expect(round.question).toBe("要启用哪些检查项");
		expect(round.selected).toBe(2);
		expect(round.progress).toEqual({ index: 1, total: 2 });
	});

	it("marks the recommended option and reads its label without the suffix", () => {
		const round = readSelect("t", ["PostgreSQL (Recommended)", "SQLite"]);
		expect(round.options[0]).toMatchObject({ label: "PostgreSQL", recommended: true, role: "option" });
		expect(round.options[1].recommended).toBe(false);
	});

	it("keeps the wire value verbatim: the label is display text, not the answer", () => {
		const round = readSelect("t", ["PostgreSQL (Recommended)"]);
		expect(round.options[0].value).toBe("PostgreSQL (Recommended)");
	});

	it("tolerates a missing descriptions row", () => {
		const round = readSelect("t", ["a", "b"], [undefined]);
		expect(round.options[0].description).toBeUndefined();
		expect(round.options[1].description).toBeUndefined();
	});
});

describe("splitEditorTitle", () => {
	it("splits the question from the drawn option list and drops omp's prompt line", () => {
		const split = splitEditorTitle("用哪种存储后端\n\n  SQLite\n  PostgreSQL\n  Other (type your own)\n\nEnter your response:");
		expect(split.question).toBe("用哪种存储后端");
		expect(split.context).toBe("SQLite\n  PostgreSQL\n  Other (type your own)");
	});

	it("keeps a single-line title intact", () => {
		expect(splitEditorTitle("写什么")).toEqual({ question: "写什么", context: undefined });
	});

	it("tolerates a missing prompt line and trailing blanks", () => {
		const split = splitEditorTitle("问题\n\n内容\n\n");
		expect(split).toEqual({ question: "问题", context: "内容" });
	});

	it("tolerates a missing title", () => {
		expect(splitEditorTitle(undefined)).toEqual({ question: undefined, context: undefined });
	});
});
