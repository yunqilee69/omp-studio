import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostEnv, HostSettingsWriter, Logger } from "../../src/config";
import { SettingsService, type SettingsSink } from "../../src/settings";
import type { NoticeLevel, SettingsSnapshot } from "../../src/shared/protocol";

/**
 * The extension's own settings: the one path on the settings page that touches no omp.
 *
 * `ompPath` deliberately points at a binary that does not exist - `refresh()` reports a
 * failed read in `snapshot.error` instead of throwing, and the page's own numbers must
 * come back from `HostEnv` regardless, which is what lets this run without omp.
 */
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Notice {
	text: string;
	level: NoticeLevel;
}

class Recorder implements SettingsSink {
	snapshots: SettingsSnapshot[] = [];
	notices: Notice[] = [];
	busyStates: boolean[] = [];

	snapshot(snapshot: SettingsSnapshot): void {
		this.snapshots.push(snapshot);
	}
	notice(text: string, level: NoticeLevel): void {
		this.notices.push({ text, level });
	}
	busy(busy: boolean): void {
		this.busyStates.push(busy);
	}

	get latest(): SettingsSnapshot {
		const last = this.snapshots.at(-1);
		if (!last) throw new Error("没有收到任何快照");
		return last;
	}
}

/**
 * VS Code's own configuration, faked: one object backs both the read and the write, like
 * `workspace.getConfiguration("ompStudio")` does.
 */
class FakeConfiguration implements HostSettingsWriter {
	readonly writes: { key: string; value: number }[] = [];
	private effective = 4;
	/** Set to simulate a workspace or folder override, which outranks a global write. */
	override: number | undefined;

	get maxInstances(): number {
		return this.override ?? this.effective;
	}

	async set(key: string, value: number): Promise<number> {
		this.writes.push({ key, value });
		if (key === "maxInstances" && this.override === undefined) this.effective = value;
		return this.maxInstances;
	}
}

function makeService() {
	const recorder = new Recorder();
	const config = new FakeConfiguration();
	const env: HostEnv = {
		ompPath: join(tmpdir(), "omp-studio-no-such-omp"),
		workspaceRoot: tmpdir(),
		// A getter, like `extension.ts` exposes it: the page must see the value in force now.
		get maxInstances() {
			return config.maxInstances;
		},
		approvalMode: "inherit",
		homeDir: tmpdir(),
		logger: quiet,
	};
	return { service: new SettingsService(env, recorder, config), recorder, config };
}

describe("host settings", () => {
	it("shows the cap in force with the bounds the schema declares", async () => {
		const { service, recorder, config } = makeService();
		await service.refresh();
		expect(recorder.latest.hostSettings).toMatchObject([
			{ key: "maxInstances", value: 4, minimum: 1, maximum: 16 },
		]);

		// Edited from VS Code's native settings page instead: the in-page row must follow.
		config.override = 9;
		await service.refresh();
		expect(recorder.latest.hostSettings[0]?.value).toBe(9);
	});

	it("writes through VS Code configuration and re-reads it", async () => {
		const { service, recorder, config } = makeService();
		await service.setHostSetting("maxInstances", 6);
		expect(config.writes).toEqual([{ key: "maxInstances", value: 6 }]);
		expect(recorder.latest.hostSettings[0]?.value).toBe(6);
		expect(recorder.notices).toEqual([]);
		expect(recorder.busyStates).toEqual([true, false]);
	});

	it("refuses a value the schema would reject, without writing anything", async () => {
		const { service, recorder, config } = makeService();
		for (const value of [0, 17, 2.5]) {
			await service.setHostSetting("maxInstances", value);
		}
		expect(config.writes).toEqual([]);
		expect(recorder.notices.map((notice) => notice.level)).toEqual(["error", "error", "error"]);
		expect(recorder.notices[0]?.text).toContain("1–16");
		expect(recorder.snapshots).toEqual([]);
	});

	it("refuses a key that is not one of its own", async () => {
		const { service, recorder, config } = makeService();
		await service.setHostSetting("defaultThinkingLevel", 3);
		expect(config.writes).toEqual([]);
		expect(recorder.notices[0]).toEqual({ text: "这个设置项不可编辑：defaultThinkingLevel", level: "error" });
	});

	// The lie this guards against: the write succeeds, a workspace override still wins,
	// and the page would otherwise look like it saved a value that is not in force.
	it("says so when a workspace override outranks the write", async () => {
		const { service, recorder, config } = makeService();
		config.override = 4;
		await service.setHostSetting("maxInstances", 8);
		expect(config.writes).toEqual([{ key: "maxInstances", value: 8 }]);
		expect(recorder.notices).toHaveLength(1);
		expect(recorder.notices[0]?.level).toBe("warn");
		expect(recorder.notices[0]?.text).toContain("仍是 4");
		expect(recorder.latest.hostSettings[0]?.value).toBe(4);
	});
});
