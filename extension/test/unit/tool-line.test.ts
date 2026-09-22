import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol";
import { humanDuration, splitPath, thinkingLabel, toolLine } from "../../webview/tool-line";

const tool = (patch: Partial<ToolItem>): ToolItem => ({
	kind: "tool",
	key: "t:1",
	toolCallId: "1",
	name: "read",
	status: "ok",
	files: [],
	...patch,
});

describe("tool rows", () => {
	it("names the file and splits off its directory", () => {
		const line = toolLine(tool({ name: "edit", path: "extension/webview/main.ts" }));
		expect(line.glyph).toBe("✎");
		expect(line.verb).toBe("编辑");
		expect(line.subject).toBe("main.ts");
		expect(line.directory).toBe("extension/webview/");
		expect(line.mono).toBe(true);
	});

	it("shows a bash call as its command, on one line", () => {
		const line = toolLine(tool({ name: "bash", command: "git diff --stat\n&& echo done" }));
		expect(line.glyph).toBe(">_");
		expect(line.verb).toBe("终端");
		expect(line.subject).toBe("git diff --stat && echo done");
		expect(line.directory).toBeUndefined();
	});

	it("keeps an unknown tool's own name instead of inventing a verb", () => {
		const line = toolLine(tool({ name: "quantum_run", path: "a/b.ts" }));
		expect(line.glyph).toBe("•");
		expect(line.verb).toBe("quantum_run");
		expect(line.subject).toBe("b.ts");
	});

	it("falls back to the stated intent when there is nothing to name", () => {
		const line = toolLine(tool({ name: "todo", intent: "Init plan workflow" }));
		expect(line.verb).toBe("待办");
		expect(line.subject).toBe("Init plan workflow");
		expect(line.mono).toBe(false);
	});

	it("marks a failed call and keeps the reason in the hover text", () => {
		const line = toolLine(
			tool({ name: "read", path: "README.md", status: "error", errorText: "Path 'README.md' not found", intent: "Reading README" }),
		);
		expect(line.failed).toBe(true);
		expect(line.title).toContain("README.md");
		expect(line.title).toContain("Path 'README.md' not found");
	});

	it("prefers the tool's own path over the first reported file", () => {
		const line = toolLine(tool({ name: "write", path: "notes.txt", files: ["/abs/other.txt"] }));
		expect(line.subject).toBe("notes.txt");
	});
});

describe("path and duration text", () => {
	it("splits paths with or without directories, and windows separators", () => {
		expect(splitPath("main.ts")).toEqual({ name: "main.ts" });
		expect(splitPath("a/b/")).toEqual({ name: "b", directory: "a/" });
		expect(splitPath("C:\\src\\a.ts")).toEqual({ name: "a.ts", directory: "C:/src/" });
	});

	it("never reports a duration of zero seconds as if it were measured", () => {
		expect(thinkingLabel()).toBe("思考");
		expect(thinkingLabel(400)).toBe("思考 · 持续了 不到 1 秒");
		expect(thinkingLabel(4200)).toBe("思考 · 持续了 4 秒");
		expect(thinkingLabel(187_000)).toBe("思考 · 持续了 3 分 7 秒");
		expect(humanDuration(120_000)).toBe("2 分钟");
	});
});
