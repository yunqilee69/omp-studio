import { describe, expect, it } from "vitest";
import type { HostMessage, InstanceState } from "../../src/shared/protocol";
import type { TabsView } from "../../webview/session-view";
import { applyItems, applyItemsRemoved, applySession, applyTabs, clearActiveSession, type ActiveSessionView } from "../../webview/session-view";

type SessionWithId = Extract<HostMessage, { type: "session"; id: string }>;

function populatedView(id = "tab-1"): ActiveSessionView & TabsView {
	return {
		id,
		activeId: id,
		tabs: [],
		state: {
			modes: [],
			mode: "plan",
			streaming: true,
			compacting: false,
			queued: 0,
			pending: [],
			todoPhases: [],
			state: "streaming",
			cwd: "/tmp",
			protocol: { version: 2, negotiated: true, serverVersion: 2 },
		} satisfies InstanceState,
		stack: [{ kind: "chat", title: "对话" }],
		items: [{ kind: "user", key: "u1", text: "你好" }],
		models: [{ provider: "p", id: "m", label: "M" }],
		commands: [{ name: "help" }],
	};
}

function sessionMessage(id: string | undefined): Extract<HostMessage, { type: "session" }> {
	if (id === undefined) return { type: "session" };
	const base = populatedView(id);
	return {
		type: "session",
		id,
		state: base.state!,
		stack: [{ kind: "chat", title: "对话" }],
		items: [{ kind: "user", key: "u1", text: "你好" }],
		models: [],
		commands: [],
	} satisfies SessionWithId;
}

describe("clearActiveSession", () => {
	it("resets id, state, stack, items, models and commands", () => {
		const view = populatedView();
		clearActiveSession(view);
		expect(view.id).toBeUndefined();
		expect(view.state).toBeUndefined();
		expect(view.stack).toEqual([]);
		expect(view.items).toEqual([]);
		expect(view.models).toEqual([]);
		expect(view.commands).toEqual([]);
	});
});

describe("applySession", () => {
	it("clears the view on the empty variant", () => {
		const view = populatedView();
		applySession(view, sessionMessage(undefined));
		expect(view.id).toBeUndefined();
		expect(view.items).toEqual([]);
		expect(view.models).toEqual([]);
	});

	it("keeps a populated tab untouched", () => {
		const view = populatedView();
		applySession(view, sessionMessage("tab-2"));
		expect(view.id).toBe("tab-2");
		expect(view.items).toHaveLength(1);
	});

	it("empty models do not wipe an existing list on the same tab", () => {
		const view = populatedView();
		applySession(view, { ...sessionMessage("tab-1") as SessionWithId, models: [] });
		expect(view.models).toHaveLength(1);
	});
});

describe("applyTabs", () => {
	it("clears the session when the last tab closed (activeId undefined)", () => {
		const view = populatedView();
		applyTabs(view, { type: "tabs", tabs: [], activeId: undefined });
		expect(view.activeId).toBeUndefined();
		expect(view.id).toBeUndefined();
		expect(view.items).toEqual([]);
	});

	it("does not clear when another tab stays active", () => {
		const view = populatedView();
		applyTabs(view, { type: "tabs", tabs: [], activeId: "tab-2" });
		expect(view.id).toBe("tab-1");
		expect(view.items).toHaveLength(1);
	});
});

describe("applyItems", () => {
	it("ignores items from a closed tab after clearing", () => {
		const view = populatedView();
		clearActiveSession(view);
		expect(applyItems(view, { type: "items", id: "tab-1", items: [{ kind: "user", key: "u2", text: "迟到" }] })).toBe(false);
		expect(view.items).toEqual([]);
	});

	it("appends items for the active tab", () => {
		const view = populatedView();
		expect(applyItems(view, { type: "items", id: "tab-1", items: [{ kind: "user", key: "u2", text: "第二条" }] })).toBe(true);
		expect(view.items).toHaveLength(2);
	});

	it("replaces a row the same key already has, in place", () => {
		const view = populatedView();
		applyItems(view, { type: "items", id: "tab-1", items: [{ kind: "user", key: "u2", text: "第二条" }] });
		applyItems(view, { type: "items", id: "tab-1", items: [{ kind: "user", key: "u1", text: "第一条改" }, { kind: "user", key: "u2", text: "第二条改" }] });
		expect(view.items.map((item) => (item.kind === "user" ? item.text : ""))).toEqual(["第一条改", "第二条改"]);
	});
});

describe("applyItemsRemoved", () => {
	it("drops only the removed keys for the active tab", () => {
		const view = populatedView();
		expect(applyItemsRemoved(view, { type: "itemsRemoved", id: "tab-1", keys: ["u1"] })).toBe(true);
		expect(view.items.map((item) => item.key)).not.toContain("u1");
	});

	it("ignores removals from an inactive tab", () => {
		const view = populatedView();
		expect(applyItemsRemoved(view, { type: "itemsRemoved", id: "tab-9", keys: ["u1"] })).toBe(false);
		expect(view.items).toHaveLength(1);
	});
});
