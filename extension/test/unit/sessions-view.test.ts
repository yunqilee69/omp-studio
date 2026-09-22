import { describe, expect, it } from "vitest";
import type { HistoryEntryView, TabSummary } from "../../src/shared/protocol";
import { buildSessionList, sessionKeyOf, STATUS_LABELS, type ListRow, type ListView } from "../../webview/sessions-view";

function tab(overrides: Partial<TabSummary> = {}): TabSummary {
	return {
		id: "tab-1",
		title: "修登录",
		running: true,
		busy: false,
		failed: false,
		awaiting: false,
		unread: false,
		mode: "none",
		sessionFile: "/sessions/a.jsonl",
		...overrides,
	};
}

function entry(overrides: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return {
		file: "/sessions/a.jsonl",
		title: "修登录",
		updatedAt: 1,
		mode: "none",
		...overrides,
	};
}

const rows = (tabs: readonly TabSummary[], entries: readonly HistoryEntryView[], view: ListView = {}) =>
	buildSessionList(tabs, entries, view).rows;
const live = (list: ListRow[]) => list.flatMap((row) => (row.kind === "live" ? [row.row] : []));
const files = (list: ListRow[]) => list.flatMap((row) => (row.kind === "history" ? [row.row] : []));
const titles = (list: ListRow[]) => list.map((row) => row.row.title);
const kinds = (list: ListRow[]) => list.map((row) => row.kind);

describe("buildSessionList", () => {
	it("lists a live instance and every other session file of the workspace in one list", () => {
		const list = rows([tab()], [entry(), entry({ file: "/sessions/b.jsonl", title: "重构鉴权", mode: "plan" })]);

		expect(live(list).map((row) => row.title)).toEqual(["修登录"]);
		expect(files(list).map((row) => row.title)).toEqual(["重构鉴权"]);
	});

	it("never lists one jsonl twice: a file a live instance owns is the instance row", () => {
		const list = rows([tab()], [entry({ openTabId: "tab-1" }), entry({ file: "/sessions/b.jsonl" })]);

		expect(kinds(list)).toEqual(["live", "history"]);
		expect(files(list).map((row) => row.file)).toEqual(["/sessions/b.jsonl"]);
	});

	it("treats a file an instance reports as its own as owned too, before ownership registers", () => {
		expect(files(rows([tab()], [entry({ openTabId: undefined })]))).toEqual([]);
	});

	it("keeps the host's order: instances in creation order, then files newest-first", () => {
		const list = rows(
			[tab(), tab({ id: "tab-2", title: "重构鉴权", sessionFile: "/sessions/b.jsonl" })],
			[entry({ file: "/sessions/c.jsonl", title: "新的一轮" }), entry({ file: "/sessions/d.jsonl", title: "更早的一轮" })],
		);

		expect(titles(list)).toEqual(["修登录", "重构鉴权", "新的一轮", "更早的一轮"]);
	});

	it("has no rows when the workspace has neither instances nor session files", () => {
		expect(buildSessionList([], [], {})).toEqual({ rows: [], archived: 0 });
	});

	it("keeps an instance whose jsonl has not landed yet", () => {
		const [row] = live(rows([tab({ sessionFile: undefined })], []));

		expect(row).toMatchObject({ sessionFile: undefined, pinned: false });
		expect(row.sessionKey).toBe("tab-1");
	});

	it("maps instance state for the row dot and the status text", () => {
		const list = rows(
			[tab({ id: "tab-1", busy: true, unread: true }), tab({ id: "tab-2", failed: true }), tab({ id: "tab-3", running: false })],
			[],
		);
		const instances = live(list);

		expect(instances.map((row) => row.status)).toEqual(["busy", "failed", "idle"]);
		expect(instances.map((row) => STATUS_LABELS[row.status])).toEqual(["运行中", "已停止", "已停止"]);
		expect(instances[0].unread).toBe(true);
	});

	it("carries the instance mode through, empty while omp has not answered", () => {
		const list = rows([tab({ mode: "goal" }), tab({ id: "tab-2", mode: "" })], []);

		expect(live(list).map((row) => row.mode)).toEqual(["goal", ""]);
	});
});

describe("pins", () => {
	it("puts pinned rows first - instances first, then files - and the rest after them", () => {
		const tabs = [
			tab(),
			tab({ id: "tab-2", title: "重构鉴权", sessionFile: "/sessions/b.jsonl" }),
			tab({ id: "tab-3", sessionFile: "/sessions/c.jsonl" }),
		];
		const list = rows(tabs, [entry({ file: "/sessions/d.jsonl", title: "旧会话" })], {
			pins: new Set(["/sessions/c.jsonl", "/sessions/d.jsonl"]),
		});

		expect(titles(list)).toEqual(["修登录", "旧会话", "修登录", "重构鉴权"]);
		expect(list.map((row) => row.row.pinned)).toEqual([true, true, false, false]);
	});

	it("identifies an instance by its jsonl, so a resumed session keeps its pin", () => {
		const list = rows([tab()], [], { pins: new Set(["/sessions/a.jsonl"]) });

		expect(sessionKeyOf(tab())).toBe("/sessions/a.jsonl");
		expect(live(list)[0].pinned).toBe(true);
	});

	it("falls back to the instance id while a session has no jsonl yet", () => {
		const list = rows([tab({ id: "tab-7", sessionFile: undefined })], [], { pins: new Set(["tab-7"]) });

		expect(live(list)[0]).toMatchObject({ pinned: true, sessionKey: "tab-7" });
	});
});

describe("archive (完成)", () => {
	const tabs = [
		tab(),
		tab({ id: "tab-2", title: "重构鉴权", sessionFile: "/sessions/b.jsonl" }),
	];
	const entries = [entry({ file: "/sessions/c.jsonl", title: "旧登录修复" })];

	it("hides an archived session and counts what it kept back", () => {
		const list = buildSessionList(tabs, entries, { archived: new Set(["/sessions/b.jsonl"]) });

		expect(titles(list.rows)).toEqual(["修登录", "旧登录修复"]);
		expect(list.archived).toBe(1);
	});

	it("shows the archived rows after the open ones, pinned ones first inside each group", () => {
		const list = rows(tabs, entries, {
			pins: new Set(["/sessions/c.jsonl"]),
			archived: new Set(["/sessions/b.jsonl", "/sessions/c.jsonl"]),
			showArchived: true,
		});

		expect(titles(list)).toEqual(["修登录", "旧登录修复", "重构鉴权"]);
		expect(list.map((row) => row.row.archived)).toEqual([false, true, true]);
	});

	it("keys an archive the same way as a pin: by jsonl, else by instance id", () => {
		const list = rows([tab({ id: "tab-7", sessionFile: undefined })], [], {
			archived: new Set(["tab-7"]),
			showArchived: true,
		});

		expect(live(list)[0].archived).toBe(true);
	});

	it("archives a file row by its path, the only key it has", () => {
		const list = buildSessionList([], entries, { archived: new Set(["/sessions/c.jsonl"]) });

		expect(list.rows).toEqual([]);
		expect(list.archived).toBe(1);
	});
});

describe("filter", () => {
	const tabs = [tab(), tab({ id: "tab-2", title: "重构鉴权", sessionFile: "/sessions/b.jsonl" })];
	const entries = [
		entry({ file: "/sessions/c.jsonl", title: "旧登录修复" }),
		entry({ file: "/sessions/2026-09-18T09-02-00.jsonl", title: "上一轮任务" }),
	];

	it("matches titles case-insensitively, and trims the query", () => {
		expect(titles(rows(tabs, entries, { query: "  鉴权 " }))).toEqual(["重构鉴权"]);
	});

	it("matches both kinds of row: the filter is over the one list", () => {
		expect(kinds(rows(tabs, entries, { query: "登录" }))).toEqual(["live", "history"]);
	});

	it("does not match the file name: only the title is what a row is recognised by", () => {
		expect(rows(tabs, entries, { query: "2026-09-18" })).toEqual([]);
	});

	it("returns nothing when no session matches", () => {
		expect(rows(tabs, entries, { query: "不存在的会话" })).toEqual([]);
	});

	it("counts only the archived rows the filter matched, since that is what the toggle offers", () => {
		const list = buildSessionList(tabs, entries, { archived: new Set(["/sessions/c.jsonl"]), query: "重构" });

		expect(titles(list.rows)).toEqual(["重构鉴权"]);
		expect(list.archived).toBe(0);
	});
});
