import {
	matchesQuery,
	type ModelCatalogEntry,
	type ModelDraft,
	type ProviderDraft,
} from "../src/shared/model-drafts";
import type {
	NoticeLevel,
	ProviderModelView,
	ProviderView,
	RoleAssignmentView,
	SettingsSnapshot,
} from "../src/shared/protocol";

/**
 * The settings page's decisions, with no DOM and no `postMessage` in sight.
 *
 * `settings.ts` owns the elements; everything that can be reasoned about
 * off-screen lives here so it is unit-testable without a webview - the same
 * split `session-view.ts` uses for the sidebar.
 */

export interface SelectOption {
	value: string;
	label: string;
	group?: string;
}

export interface RoleRow {
	role: string;
	description: string;
	selector?: string;
	thinking: string;
	thinkingChoices: string[];
	/** A stored selector that is no longer in the catalog: shown as a warning, never silently dropped. */
	unresolved: boolean;
	options: SelectOption[];
}

/**
 * Model choices for a role dropdown, grouped by provider.
 *
 * When the stored selector is not in the catalog it is kept as a marked first
 * option. Without this a `<select>` would render some *other* model as if it
 * were the saved value - a lie the moment the catalog shifts.
 */
export function roleOptions(catalog: ModelCatalogEntry[], current?: string): SelectOption[] {
	const options: SelectOption[] = catalog.map((entry) => ({
		value: entry.selector,
		label: entry.name && entry.name !== entry.id ? `${entry.name} · ${entry.id}` : entry.id,
		group: entry.provider,
	}));
	if (current && !options.some((option) => option.value === current)) {
		options.unshift({ value: current, label: `${current}（不在模型目录中）`, group: "当前值" });
	}
	return options;
}

export function roleRows(snapshot: SettingsSnapshot): RoleRow[] {
	return snapshot.roles.map((assignment: RoleAssignmentView) => ({
		role: assignment.role,
		description: assignment.description,
		selector: assignment.selector,
		thinking: assignment.thinking ?? "",
		thinkingChoices: assignment.thinkingLevels,
		unresolved: !assignment.resolved,
		options: roleOptions(snapshot.catalog, assignment.selector),
	}));
}

/** Join the model dropdown and the level dropdown back into the stored `Provider/model:level` form. */
export function composeSelector(model: string, thinking: string): string {
	if (!model) return "";
	return thinking ? `${model}:${thinking}` : model;
}

/** A blank draft for a new provider; `apiKey` stays undefined so the host keeps whatever is on disk. */
export function providerDraft(provider?: ProviderView): ProviderDraft {
	return {
		id: provider?.id ?? "",
		baseUrl: provider?.baseUrl ?? "",
		api: provider?.api ?? "openai-completions",
		apiKey: undefined,
		headers: provider?.headers,
	};
}

export function modelDraft(model?: ProviderModelView): ModelDraft {
	return {
		id: model?.id ?? "",
		name: model?.name ?? "",
		contextWindow: model?.contextWindow,
		maxTokens: model?.maxTokens,
		reasoning: model?.reasoning,
		thinking: model?.thinking,
		input: model?.input,
	};
}

// ---------------------------------------------------------------------------
// Search: a query filters rows, not the page (VS Code settings behaviour)
// ---------------------------------------------------------------------------

export interface SearchMatches {
	roles: string[];
	providers: { id: string; models: string[] | "all" }[];
	settings: string[];
	/** The extension's own `ompStudio.*` numbers, whose home is VS Code configuration. */
	host: string[];
}

export function searchSnapshot(snapshot: SettingsSnapshot, query: string): SearchMatches {
	if (!query.trim()) {
		return {
			roles: snapshot.roles.map((assignment) => assignment.role),
			providers: snapshot.providers.map((provider) => ({ id: provider.id, models: "all" as const })),
			settings: snapshot.settings.map((setting) => setting.key),
			host: snapshot.hostSettings.map((setting) => setting.key),
		};
	}
	const roles = snapshot.roles
		.filter((assignment) =>
			matchesQuery(query, assignment.role, assignment.description, assignment.selector, assignment.modelId),
		)
		.map((assignment) => assignment.role);

	const providers: SearchMatches["providers"] = [];
	for (const provider of snapshot.providers) {
		if (matchesQuery(query, provider.id, provider.baseUrl, provider.api)) {
			providers.push({ id: provider.id, models: "all" });
			continue;
		}
		const models = provider.models
			.filter((model) => matchesQuery(query, model.id, model.name))
			.map((model) => model.id);
		if (models.length > 0) providers.push({ id: provider.id, models });
	}

	const settings = snapshot.settings
		.filter((setting) => matchesQuery(query, setting.key, setting.label, setting.description))
		.map((setting) => setting.key);

	const host = snapshot.hostSettings
		.filter((setting) => matchesQuery(query, setting.key, setting.label, setting.description))
		.map((setting) => setting.key);

	return { roles, providers, settings, host };
}

/** True when a query matched nothing anywhere, so the page can say so instead of looking empty. */
export function hasAnyMatch(matches: SearchMatches): boolean {
	return (
		matches.roles.length > 0 || matches.providers.length > 0 || matches.settings.length > 0 || matches.host.length > 0
	);
}

// ---------------------------------------------------------------------------
// Categories: the left rail decides which slice of the snapshot gets drawn
// ---------------------------------------------------------------------------

/**
 * The rail's categories, in the order they are listed.
 *
 * Every category is declared here rather than in the renderer so the rail, the
 * empty states and the tests all read the same list - a page that exists in the
 * nav but not in the switch (or the reverse) cannot be expressed.
 */
export type SettingsPageId = "overview" | "roles" | "models" | "other" | "host";

export interface SettingsPageDef {
	id: SettingsPageId;
	label: string;
	/** The one-line intro under the page title, so a category explains itself without a scroll. */
	description: string;
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
	{ id: "overview", label: "概览", description: "omp 的模型配置在哪、由谁写。选一个分类继续。" },
	{ id: "roles", label: "模型角色", description: "六个角色各指向哪个模型，写进全局 config.yml。" },
	{ id: "models", label: "自定义模型", description: "增删改 models.yml 里的提供商与模型。" },
	{ id: "other", label: "其他", description: "omp config 里的零散设置。" },
	{ id: "host", label: "扩展", description: "本插件自己的设置（VS Code 的 ompStudio.*），与 omp 的 config.yml 无关。" },
];

export function pageDef(id: SettingsPageId): SettingsPageDef {
	return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0];
}

/**
 * Rows this category currently shows, for the rail's badges.
 *
 * `undefined` for the overview: it is not a list of rows, so a count there would
 * be a number with nothing behind it. A blank query counts everything, which is
 * what makes the badges work as a "what is in here" summary.
 */
export function pageCount(matches: SearchMatches, page: SettingsPageId): number | undefined {
	switch (page) {
		case "overview":
			return undefined;
		case "roles":
			return matches.roles.length;
		case "models":
			return matches.providers.length;
		case "other":
			return matches.settings.length;
		case "host":
			return matches.host.length;
	}
}

/**
 * Categories a query still matches, so a category page the query emptied can
 * point at one that has hits instead of leaving the user to click through the rail.
 */
export function pagesWithMatches(matches: SearchMatches): SettingsPageId[] {
	return SETTINGS_PAGES.map((page) => page.id).filter((id) => (pageCount(matches, id) ?? 0) > 0);
}

/**
 * "2 个提供商 · 5 个模型" for the custom-models card.
 *
 * Counted through the *match* list, not the raw snapshot: a provider the query
 * narrowed to one model must not advertise the models it is hiding.
 */
export function providerTally(snapshot: SettingsSnapshot, visible: SearchMatches["providers"]): string {
	let models = 0;
	for (const match of visible) {
		const provider = snapshot.providers.find((candidate) => candidate.id === match.id);
		if (!provider) continue;
		models += match.models === "all" ? provider.models.length : match.models.length;
	}
	return `${visible.length} 个提供商 · ${models} 个模型`;
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

export type FormTarget =
	| {
			kind: "provider";
			originalId?: string;
			draft: ProviderDraft;
			/**
			 * The headers textarea's raw text, kept unparsed so malformed JSON is
			 * reported at submit instead of silently keeping the previous value.
			 */
			headersRaw?: string;
			firstModel: ModelDraft;
			hasKey: boolean;
	  }
	| { kind: "model"; providerId: string; originalId?: string; draft: ModelDraft };

export interface SettingsPageState {
	snapshot?: SettingsSnapshot;
	/** The category the rail is on. */
	page: SettingsPageId;
	query: string;
	/** Label of the operation in flight, shown in the header. */
	busy?: string;
	notice?: { text: string; level: NoticeLevel };
	/** Expanded provider rows. */
	open: string[];
	form?: FormTarget;
	/** What the open form submitted, so a successful `busy(false, _, true)` can close exactly that form. */
	pendingForm?: "provider" | "model";
	/** Delete key awaiting its second click: `provider:<id>` or `model:<provider>/<id>`. */
	confirmDelete?: string;
}

export function createPageState(): SettingsPageState {
	return { page: "overview", query: "", open: [] };
}

/** Switching category keeps the query, the expanded rows and any open form: nothing here is a page's private state. */
export function selectPage(state: SettingsPageState, page: SettingsPageId): void {
	state.page = page;
}

/** A fresh snapshot never touches the query, the open rows, or an in-progress form. */
export function applySnapshot(state: SettingsPageState, snapshot: SettingsSnapshot): void {
	state.snapshot = snapshot;
}

export function applyBusy(state: SettingsPageState, busy: boolean, what?: string, ok?: boolean): void {
	if (busy) {
		state.busy = what ?? "处理中";
		return;
	}
	state.busy = undefined;
	const pending = state.pendingForm;
	state.pendingForm = undefined;
	// Only a *successful* save of the form that is still open closes it: a rejected
	// write must not throw away what the user typed (the host has already explained
	// why in a notice), and a form opened since then is not the one that was saved.
	if (ok === true && pending && state.form?.kind === pending) state.form = undefined;
}

export function applyNotice(state: SettingsPageState, text: string, level: NoticeLevel): void {
	state.notice = { text, level };
}

export function dismissNotice(state: SettingsPageState): void {
	state.notice = undefined;
}

export function toggleProviderOpen(state: SettingsPageState, id: string): void {
	state.open = state.open.includes(id) ? state.open.filter((entry) => entry !== id) : [...state.open, id];
}

export function openNewProviderForm(state: SettingsPageState): void {
	state.form = { kind: "provider", draft: providerDraft(), firstModel: modelDraft(), hasKey: false };
}

export function openProviderForm(state: SettingsPageState, provider: ProviderView): void {
	state.form = {
		kind: "provider",
		originalId: provider.id,
		draft: providerDraft(provider),
		firstModel: modelDraft(),
		hasKey: provider.hasApiKey,
	};
}

export function openModelForm(state: SettingsPageState, providerId: string, model?: ProviderModelView): void {
	state.form = { kind: "model", providerId, originalId: model?.id, draft: modelDraft(model) };
}

export function closeForm(state: SettingsPageState): void {
	state.form = undefined;
	state.pendingForm = undefined;
}

export function markFormSubmitted(state: SettingsPageState, kind: "provider" | "model"): void {
	state.pendingForm = kind;
}

export function deleteKeyProvider(id: string): string {
	return `provider:${id}`;
}

export function deleteKeyModel(providerId: string, id: string): string {
	return `model:${providerId}/${id}`;
}

/** First click arms the key, the second click confirms; anything else disarms. */
export function requestDelete(state: SettingsPageState, key: string): boolean {
	if (state.confirmDelete === key) {
		state.confirmDelete = undefined;
		return true;
	}
	state.confirmDelete = key;
	return false;
}
