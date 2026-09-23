import { describe, expect, it } from "vitest";
import { computeCompletions, cycleActive } from "../../webview/completions";

const commands = [
	{ name: "help", description: "show help" },
	{ name: "model" },
	{ name: "mode" },
];

const files = ["src/main.ts", "src/lib/util.ts", "README.md", "docs/dev-plan.md"];

describe("computeCompletions — slash commands", () => {
	it("lists every command for a bare slash", () => {
		const result = computeCompletions("/", commands, files);
		expect(result?.kind).toBe("command");
		expect(result?.options.map((option) => option.label)).toEqual(["/help", "/model", "/mode"]);
	});

	it("filters by prefix case-insensitively", () => {
		const result = computeCompletions("/MO", commands, files);
		expect(result?.options.map((option) => option.label)).toEqual(["/model", "/mode"]);
	});

	it("fills the input value with a trailing space", () => {
		const result = computeCompletions("/he", commands, files);
		expect(result?.options[0]).toMatchObject({ value: "/help " });
		expect(result?.options[0].description).toBe("show help");
	});

	it("hides once the slash token contains a space", () => {
		expect(computeCompletions("/help now", commands, files)).toBeUndefined();
	});

	it("hides on a prefix with no match", () => {
		expect(computeCompletions("/zzz", commands, files)).toBeUndefined();
	});

	it("matches namespaced commands by their tail after the colon", () => {
		const skills = [
			{ name: "skill:find-skills", description: "discover skills" },
			{ name: "skill:sinicube-code-plan", description: "dev plan" },
			{ name: "model" },
		];
		const result = computeCompletions("/find", skills, files);
		expect(result?.options.map((option) => option.label)).toEqual(["/skill:find-skills"]);
		expect(result?.options[0]).toMatchObject({ value: "/skill:find-skills ", description: "discover skills" });
	});

	it("still matches namespaced commands by full-name prefix", () => {
		const skills = [{ name: "skill:find-skills" }];
		expect(computeCompletions("/skill:find", skills, files)?.options[0]?.label).toBe("/skill:find-skills");
	});

	it("ranks full-name prefixes ahead of tail matches", () => {
		const mixed = [
			{ name: "skill:help" },
			{ name: "help" },
		];
		const result = computeCompletions("/help", mixed, files);
		expect(result?.options.map((option) => option.label)).toEqual(["/help", "/skill:help"]);
	});

	it("does not let a bare command's whole name re-match as a tail", () => {
		const plain = [{ name: "model" }];
		expect(computeCompletions("/zzz", plain, files)).toBeUndefined();
	});
});

describe("computeCompletions — @files", () => {
	it("lists all files for a bare at", () => {
		const result = computeCompletions("@", commands, files);
		expect(result?.kind).toBe("file");
		expect(result?.options).toHaveLength(4);
	});

	it("matches basename prefixes first", () => {
		const result = computeCompletions("@dev", commands, files);
		expect(result?.options.map((option) => option.label)).toEqual(["docs/dev-plan.md"]);
	});

	it("falls back to path substring matches", () => {
		const result = computeCompletions("@util", commands, files);
		expect(result?.options.map((option) => option.label)).toEqual(["src/lib/util.ts"]);
	});

	it("preserves the text before the token and appends a trailing space", () => {
		const result = computeCompletions("look at @read", commands, files);
		expect(result?.options[0]).toMatchObject({ value: "look at @README.md " });
	});

	it("requires whitespace or input start before the at", () => {
		expect(computeCompletions("email@example.com", commands, files)).toBeUndefined();
		expect(computeCompletions("a@read", commands, files)).toBeUndefined();
	});

	it("hides once the token contains a space or another at", () => {
		expect(computeCompletions("@src/main.ts done", commands, files)).toBeUndefined();
		expect(computeCompletions("@a@b", commands, files)).toBeUndefined();
	});
});

describe("cycleActive", () => {
	it("steps down and up inside the list", () => {
		expect(cycleActive(0, 3, 1)).toBe(1);
		expect(cycleActive(1, 3, -1)).toBe(0);
	});

	it("wraps at both ends", () => {
		expect(cycleActive(2, 3, 1)).toBe(0);
		expect(cycleActive(0, 3, -1)).toBe(2);
	});

	it("stays at 0 for an empty list, which has nothing to select", () => {
		expect(cycleActive(0, 0, 1)).toBe(0);
	});
});
