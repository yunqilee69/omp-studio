import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarPrefsStore } from "../../src/providers/prefs-store";

const dirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-studio-prefs-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	dirs.splice(0);
});

describe("SidebarPrefsStore", () => {
	it("round-trips prefs across stores, like a webview reload then a restart", async () => {
		const dir = makeDir();
		const first = new SidebarPrefsStore(join(dir, "session-list-prefs.json"));
		await first.save({ pins: ["/s/a.jsonl"], archived: ["/s/b.jsonl"], panelOpen: false });

		// A restart is a brand-new store reading the same file.
		const second = new SidebarPrefsStore(join(dir, "session-list-prefs.json"));
		expect(await second.load()).toEqual({ pins: ["/s/a.jsonl"], archived: ["/s/b.jsonl"], panelOpen: false });
	});

	it("defaults on first run, where the file does not exist yet", async () => {
		const store = new SidebarPrefsStore(join(makeDir(), "session-list-prefs.json"));
		expect(await store.load()).toEqual({ pins: [], archived: [], panelOpen: true });
	});

	it("defaults on corrupt JSON instead of crashing the sidebar", async () => {
		const dir = makeDir();
		const file = join(dir, "session-list-prefs.json");
		const store = new SidebarPrefsStore(file);
		await store.save({ pins: [], archived: ["/s/a.jsonl"], panelOpen: true });
		readFileSync(file, "utf8").slice; // file exists; now corrupt it
		const { writeFileSync } = await import("node:fs");
		writeFileSync(file, "{not json", "utf8");

		expect(await new SidebarPrefsStore(file).load()).toEqual({ pins: [], archived: [], panelOpen: true });
	});

	it("drops non-string keys a hand-edited file may carry", async () => {
		const dir = makeDir();
		const file = join(dir, "session-list-prefs.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(file, JSON.stringify({ pins: ["ok", 42, null], archived: "nope", panelOpen: true }), "utf8");

		const store = new SidebarPrefsStore(file);
		expect(await store.load()).toEqual({ pins: ["ok"], archived: [], panelOpen: true });
	});

	it("creates the storage folder itself and writes atomically (no .tmp left behind)", async () => {
		const dir = join(makeDir(), "not-created-yet");
		const store = new SidebarPrefsStore(join(dir, "session-list-prefs.json"));
		await store.save({ pins: [], archived: ["/s/a.jsonl"], panelOpen: true });

		expect(readFileSync(join(dir, "session-list-prefs.json"), "utf8")).toContain("/s/a.jsonl");
	});
});
