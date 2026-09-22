import { describe, expect, it } from "vitest";
import { commandViews, readCommandList } from "../../src/command-list";
import type { HostEnv } from "../../src/config";

/**
 * The one mapping both `/` lists go through: a live instance's handshake and the entry
 * page's probe. Kept pure so the shape is pinned without spawning omp (the probe's own
 * read is covered by test/integration/live.test.ts).
 */
describe("commandViews", () => {
	it("keeps the name and description the popup renders, with omp's source as the group", () => {
		const views = commandViews([
			{ name: "compact", description: "Compact the session", source: "builtin" },
			{ name: "skill:find-skills", description: "Discover skills", source: "skill" },
		]);

		expect(views).toEqual([
			{ name: "compact", description: "Compact the session", group: "builtin" },
			{ name: "skill:find-skills", description: "Discover skills", group: "skill" },
		]);
	});

	it("leaves a command without a description or source as the bare row the popup expects", () => {
		expect(commandViews([{ name: "model" }])).toEqual([{ name: "model", description: undefined, group: undefined }]);
	});

	it("maps nothing to nothing, so an empty answer is an empty popup", () => {
		expect(commandViews([])).toEqual([]);
	});
});

/**
 * The probe outlives nothing: it must hand back an empty list (and a warning) rather than
 * hang or throw when `omp` is not there at all - the composer of the entry page waits on
 * this read. No real omp involved, so it runs anywhere.
 */
describe("readCommandList", () => {
	it("gives up on a missing omp within the leash instead of hanging or throwing", async () => {
		const warnings: string[] = [];
		const env = {
			ompPath: "/nonexistent/omp-not-installed",
			workspaceRoot: process.cwd(),
			logger: { info: () => {}, warn: (message: string) => warnings.push(message), error: () => {} },
		} as unknown as HostEnv;

		const started = Date.now();
		await expect(readCommandList(env)).resolves.toEqual([]);

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(warnings.join("\n")).toContain("探测失败");
	}, 20_000);
});
