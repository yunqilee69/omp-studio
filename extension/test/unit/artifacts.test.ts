import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPlanFile, resolveLocalUrl, subagentArtifacts } from "../../src/artifacts";

const sessionIn = async (bucket = "session"): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "omp-studio-artifacts-"));
	const file = join(dir, bucket, "2026-09-22T07-12-00-691Z_abc.jsonl");
	await mkdir(join(file.slice(0, -".jsonl".length), "local"), { recursive: true });
	return file;
};

describe("resolveLocalUrl", () => {
	it("resolves local:// into the session's local scratch directory", async () => {
		const session = await sessionIn();
		expect(resolveLocalUrl(session, "local://PLAN.md")).toBe(
			join(session.slice(0, -".jsonl".length), "local", "PLAN.md"),
		);
		expect(resolveLocalUrl(session, "local:///nested/PLAN.md")).toBe(
			join(session.slice(0, -".jsonl".length), "local", "nested", "PLAN.md"),
		);
	});

	it("refuses to escape the local root", async () => {
		const session = await sessionIn();
		expect(resolveLocalUrl(session, "local://../outside.md")).toBeUndefined();
		expect(resolveLocalUrl(session, "local://../../etc/passwd")).toBeUndefined();
		expect(resolveLocalUrl(session, "local://")).toBeUndefined();
	});

	it("keeps subagent artifacts next to the session", async () => {
		const session = await sessionIn();
		const paths = subagentArtifacts(session, "sub-1");
		expect(paths.dir).toBe(session.slice(0, -".jsonl".length));
		expect(paths.markdown).toBe(join(paths.dir, "sub-1.md"));
	});
});

describe("readPlanFile", () => {
	it("reads a local:// plan written the way omp writes it", async () => {
		const session = await sessionIn();
		const plan = resolveLocalUrl(session, "local://PLAN.md") ?? "";
		await writeFile(plan, "# 计划\n\n第一步\n", "utf8");

		const result = await readPlanFile("local://PLAN.md", session);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.markdown).toContain("第一步");
		expect(result.source).toBe(plan);
	});

	it("reads a plain filesystem path", async () => {
		const session = await sessionIn();
		const file = join(session, "..", "direct-plan.md");
		await writeFile(file, "direct", "utf8");
		const result = await readPlanFile(file, session);
		expect(result.ok && result.markdown).toBe("direct");
	});

	it("explains each way it cannot produce a plan", async () => {
		const session = await sessionIn();
		const none = await readPlanFile(undefined, session);
		expect(none.ok).toBe(false);
		expect(none.ok ? "" : none.reason).toContain("没有计划");

		const missing = await readPlanFile("local://absent-plan.md", session);
		expect(missing.ok).toBe(false);
		expect(missing.ok ? "" : missing.reason).toContain("不存在");

		const escaping = await readPlanFile("local://../../etc/passwd", session);
		expect(escaping.ok).toBe(false);
		expect(escaping.ok ? "" : escaping.reason).toContain("越界");

		const noSession = await readPlanFile("local://PLAN.md", undefined);
		expect(noSession.ok).toBe(false);
		expect(noSession.ok ? "" : noSession.reason).toContain("需要会话路径");
	});
});
