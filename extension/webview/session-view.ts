import type {
	HostMessage,
	InstanceState,
	Item,
	ModelChoice,
	SlashCommandView,
	TabSummary,
	ViewLayer,
} from "../src/shared/protocol";

type SessionMessage = Extract<HostMessage, { type: "session" }>;
type TabsMessage = Extract<HostMessage, { type: "tabs" }>;
type ItemsMessage = Extract<HostMessage, { type: "items" }>;

/**
 * The slice of webview state keyed to the active tab. Kept DOM-free so the
 * empty-state rules are unit-testable without a webview.
 */
export interface ActiveSessionView {
	id?: string;
	state?: InstanceState;
	stack: ViewLayer[];
	items: Item[];
	models: ModelChoice[];
	commands: SlashCommandView[];
}

export interface TabsView {
	tabs: TabSummary[];
	activeId?: string;
}

/**
 * No active tab is a full empty state, not just an empty tab strip: the body
 * must fall through to the hero instead of painting the closed tab.
 */
export function clearActiveSession(view: ActiveSessionView): void {
	view.id = undefined;
	view.state = undefined;
	view.stack = [];
	view.items = [];
	view.models = [];
	view.commands = [];
}

/** Returns whether the tab changed (used by the model popup). */
export function applySession(view: ActiveSessionView, message: SessionMessage): boolean {
	if (message.id === undefined) {
		clearActiveSession(view);
		return true;
	}
	const tabChanged = view.id !== message.id;
	view.id = message.id;
	view.state = message.state;
	view.stack = message.stack;
	view.items = message.items;
	if (message.models) {
		// A later empty snapshot (handshake `pushSession` before catalog) must not
		// wipe a list we already have. Tab switches go through `session`.
		if (tabChanged || message.models.length > 0 || view.models.length === 0) view.models = message.models;
	} else if (tabChanged) {
		view.models = [];
	}
	if (message.commands) view.commands = message.commands;
	else if (tabChanged) view.commands = [];
	return tabChanged;
}

/**
 * Tabs only move the list — except an undefined `activeId`, which is the
 * last-instance-closed signal and must also clear the session snapshot.
 */
export function applyTabs(view: ActiveSessionView & TabsView, message: TabsMessage): void {
	view.tabs = message.tabs;
	view.activeId = message.activeId;
	if (message.activeId === undefined) clearActiveSession(view);
}

/**
 * Returns false when the message belongs to a closed or inactive tab.
 *
 * `items` is an upsert stream, not an append log: a streaming turn re-sends the same row
 * with more text dozens of times. Appending would leave one copy per frame - the list
 * grows without bound, and a repaint of it draws every copy (the duplicates a full
 * render showed). Keyed replacement keeps one row per key, in first-seen order.
 */
export function applyItems(view: ActiveSessionView, message: ItemsMessage): boolean {
	if (message.id !== view.id) return false;
	view.items = mergeItems(view.items, message.items);
	return true;
}

function mergeItems(current: readonly Item[], incoming: readonly Item[]): Item[] {
	const next = current.slice();
	const at = new Map<string, number>();
	for (const [index, item] of next.entries()) at.set(item.key, index);
	for (const item of incoming) {
		const index = at.get(item.key);
		if (index === undefined) {
			at.set(item.key, next.length);
			next.push(item);
		} else next[index] = item;
	}
	return next;
}

/** Drops removed keys from the active tab's items; returns false for a stale tab. */
export function applyItemsRemoved(
	view: ActiveSessionView,
	message: Extract<HostMessage, { type: "itemsRemoved" }>,
): boolean {
	if (message.id !== view.id) return false;
	const removed = new Set(message.keys);
	view.items = view.items.filter((item) => !removed.has(item.key));
	return true;
}
