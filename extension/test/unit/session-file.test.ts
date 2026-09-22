import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMcp } from "../../src/mcp";
import {
	artifactsDir,
	bucketDir,
	encodeCwdBucket,
	MODE_LABELS,
	readSessionMessages,
	readSessionSummary,
	titleFromText,
} from "../../src/session-file";

describe("encodeCwdBucket", () => {
	// Values verified by dumping omp's own ~/.omp/agent/sessions directories.
	it("strips the home prefix and dashes the separators", () => {
		expect(encodeCwdBucket("/home/yunqi/cloudomni/omp-studio", "/home/yunqi")).toBe("-cloudomni-omp-studio");
		expect(encodeCwdBucket("/tmp/omp-probe/nested/dir", "/home/yunqi")).toBe("-tmp-omp-probe-nested-dir");
		expect(encodeCwdBucket("/tmp/omp probe/with.dot_and-under", "/home/yunqi")).toBe("-tmp-omp probe-with.dot_and-under");
	});

	it("keeps the folder name when the cwd is the home directory itself", () => {
		expect(encodeCwdBucket("/home/yunqi", "/home/yunqi")).toBe("");
		expect(bucketDir("/home/yunqi/proj", "/home/yunqi")).toBe(
			join("/home/yunqi/.omp/agent/sessions", "-proj"),
		);
	});

	it("derives the artifacts directory by dropping the .jsonl suffix", () => {
		expect(artifactsDir("/s/-proj/2026-01-01T00-00-00-000Z_abc.jsonl")).toBe("/s/-proj/2026-01-01T00-00-00-000Z_abc");
		expect(artifactsDir("/s/-proj/plain")).toBe("/s/-proj/plain");
	});
});

describe("titleFromText", () => {
	it("collapses whitespace and truncates without breaking the line", () => {
		expect(titleFromText("  hello \n world  ")).toBe("hello world");
		expect(titleFromText("x".repeat(200)).length).toBeLessThanOrEqual(60);
		expect(titleFromText(undefined)).toBe("");
	});
});

describe("readSessionSummary / readSessionMessages", () => {
	it("reads the last mode_change and the first user message from a session file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-studio-session-"));
		const file = join(dir, "2026-09-22T07-12-00-691Z_abc.jsonl");
		const entries = [
			{ type: "session", sessionId: "abc", title: "首个会话" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "统计 docs 文件名" }] } },
			{ type: "mode_change", mode: "plan", data: { planFilePath: join(dir, "plan.md") } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "已完成" }] } },
		];
		await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

		const summary = await readSessionSummary(file);
		expect(summary.mode).toBe("plan");
		expect(summary.planFilePath).toBe(join(dir, "plan.md"));
		expect(MODE_LABELS.vibe).toBe("Vibe");

		const messages = await readSessionMessages(file, 10);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("tolerates a partially written trailing line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-studio-session-"));
		const file = join(dir, "broken.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "mode_change", mode: "vibe" })}\n{"type":"message","message"`, "utf8");
		const summary = await readSessionSummary(file);
		expect(summary.mode).toBe("vibe");
		await expect(readSessionMessages(file)).resolves.toBeDefined();
	});
});

describe("readMcp", () => {
	/** `user` writes go to <home>/.omp/agent/mcp.json, the path omp 18.1.2 resolves. */
	const write = async (dir: string, data: unknown, scope: "user" | "project" = "project") => {
		const target = scope === "user" ? join(dir, ".omp", "agent") : join(dir, ".omp");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "mcp.json"), JSON.stringify(data), "utf8");
	};

	it("merges user and project files with project entries shadowing user entries", async () => {
		const home = await mkdtemp(join(tmpdir(), "omp-home-"));
		const cwd = await mkdtemp(join(tmpdir(), "omp-cwd-"));
		await write(
			home,
			{
				mcpServers: {
					shared: { type: "stdio", command: "user-cmd" },
					userOnly: { type: "http", url: "https://user.example/mcp" },
				},
			},
			"user",
		);
		await write(cwd, { mcpServers: { shared: { type: "stdio", command: "project-cmd" } } });

		const snapshot = await readMcp(cwd, home);
		expect(snapshot.servers.map((server) => server.name)).toEqual(["shared", "userOnly"]);
		const shared = snapshot.servers[0];
		expect(shared.scope).toBe("project");
		expect(shared.detail).toBe("project-cmd");
		expect(shared.enabled).toBe(true);
		expect(snapshot.servers[1].transport).toBe("http");
		expect(snapshot.servers[1].detail).toBe("https://user.example/mcp");
	});

	it("treats enabled:false and the user file's disabledServers as disabled", async () => {
		const home = await mkdtemp(join(tmpdir(), "omp-home-"));
		const cwd = await mkdtemp(join(tmpdir(), "omp-cwd-"));
		await write(
			home,
			{
				mcpServers: { off: { type: "stdio", command: "a" }, listed: { type: "stdio", command: "b" } },
				disabledServers: ["listed"],
			},
			"user",
		);
		await write(cwd, { mcpServers: { disabledHere: { type: "stdio", command: "c", enabled: false } } });

		const snapshot = await readMcp(cwd, home);
		const byName = Object.fromEntries(snapshot.servers.map((server) => [server.name, server.enabled]));
		expect(byName).toEqual({ off: true, listed: false, disabledHere: false });
	});

	it("reports missing files as empty instead of throwing, and survives invalid JSON", async () => {
		const home = await mkdtemp(join(tmpdir(), "omp-home-"));
		const cwd = await mkdtemp(join(tmpdir(), "omp-cwd-"));
		const empty = await readMcp(cwd, home);
		expect(empty.servers).toEqual([]);
		expect(empty.sources.map((source) => source.exists)).toEqual([false, false]);

		await mkdir(join(cwd, ".omp"), { recursive: true });
		await writeFile(join(cwd, ".omp", "mcp.json"), "{ not json", "utf8");
		const broken = await readMcp(cwd, home);
		expect(broken.sources[1].error).toBeTruthy();
		expect(broken.servers).toEqual([]);
	});
});
