import { API_TYPES, formatTokens, type ModelDraft, type ProviderDraft } from "../src/shared/model-drafts";
import type {
	HostSettingView,
	ProviderModelView,
	ProviderView,
	SettingsHostMessage,
	SettingsSnapshot,
} from "../src/shared/protocol";
import { button, el, svgIcon } from "./dom";
import {
	applyBusy,
	applyNotice,
	applySnapshot,
	closeForm,
	composeSelector,
	createPageState,
	deleteKeyModel,
	deleteKeyProvider,
	dismissNotice,
	hasAnyMatch,
	markFormSubmitted,
	openModelForm,
	openNewProviderForm,
	openProviderForm,
	pageCount,
	pageDef,
	pagesWithMatches,
	providerTally,
	requestDelete,
	roleRows,
	searchSnapshot,
	selectPage,
	SETTINGS_PAGES,
	toggleProviderOpen,
	type FormTarget,
	type RoleRow,
	type SearchMatches,
	type SettingsPageDef,
	type SettingsPageId,
} from "./settings-view";

/**
 * The settings page: a category rail on the left, the selected category's form on
 * the right - VS Code's own settings tab, scaled to the five things this page owns.
 *
 * Every host message re-renders the whole page from `SettingsPageState`. The one
 * wrinkle that forces care: a save produces `notice` + `snapshot` + `busy(false)`
 * in a row, so a rebuild can land while the user is mid-typing. `captureForm()` /
 * `restoreFocus()` around each render make that rebuild lossless instead of
 * dropping the caret and the typed text.
 */

interface HostApi {
	postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): HostApi;

const api = acquireVsCodeApi();
const root = document.getElementById("settings") ?? document.body;
const state = createPageState();

api.postMessage({ type: "ready" });

window.addEventListener("message", (event: MessageEvent<SettingsHostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case "snapshot":
			applySnapshot(state, message.snapshot);
			break;
		case "busy":
			applyBusy(state, message.busy, message.what, message.ok);
			break;
		case "notice":
			applyNotice(state, message.text, message.level);
			break;
		default:
			return;
	}
	render();
});

function send(message: Record<string, unknown>): void {
	api.postMessage(message);
}

/** The settings page's own view actions always end in a repaint. */
function act(run: () => void): void {
	run();
	render();
}

// ---------------------------------------------------------------------------
// Form capture / focus restore
// ---------------------------------------------------------------------------

function control(field: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined {
	return root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${field}"]`) ?? undefined;
}

/** Read every `[data-field]` control back into the open form, so a rebuild cannot lose typed input. */
function captureForm(): void {
	const form = state.form;
	if (!form) return;
	const text = (field: string) => control(field)?.value;
	const number = (field: string): number | undefined => {
		const raw = text(field)?.trim();
		if (!raw) return undefined;
		const value = Number(raw);
		return Number.isFinite(value) ? value : undefined;
	};
	const checked = (field: string): boolean | undefined => {
		const node = control(field);
		return node instanceof HTMLInputElement ? node.checked : undefined;
	};

	if (form.kind === "provider") {
		const apiKey = text("apiKey");
		form.draft = {
			id: text("id") ?? form.draft.id,
			baseUrl: text("baseUrl") ?? form.draft.baseUrl,
			api: text("api") ?? form.draft.api,
			// An empty box means "keep the key on disk", never "erase it".
			apiKey: apiKey ? apiKey : form.draft.apiKey,
			headers: form.draft.headers,
		};
		// Kept raw: submit parses it, so malformed JSON is reported instead of silently ignored.
		form.headersRaw = text("headers") ?? form.headersRaw;
		form.firstModel = {
			id: text("model.id") ?? form.firstModel.id,
			name: text("model.name") ?? form.firstModel.name,
			contextWindow: number("model.contextWindow") ?? form.firstModel.contextWindow,
			maxTokens: number("model.maxTokens") ?? form.firstModel.maxTokens,
		};
		return;
	}
	form.draft = {
		id: text("id") ?? form.draft.id,
		name: text("name") ?? form.draft.name,
		contextWindow: number("contextWindow") ?? form.draft.contextWindow,
		maxTokens: number("maxTokens") ?? form.draft.maxTokens,
		reasoning: checked("reasoning") ?? form.draft.reasoning,
		thinking: splitList(text("thinking")) ?? form.draft.thinking,
		input: form.draft.input,
	};
}

function splitList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

let focusedField: string | undefined;
let focusedNav: string | undefined;
let focusedCaret: number | undefined;

function rememberFocus(): void {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return;
	focusedField = active.dataset.field;
	// Rail items and overview cards both mark themselves with `data-nav`, so a click
	// that rebuilds the page lands back on the control the user just pressed.
	focusedNav = active.dataset.nav;
	if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
		focusedCaret = active.selectionStart ?? undefined;
	}
}

function restoreFocus(): void {
	const field = focusedField;
	const nav = focusedNav;
	const caret = focusedCaret;
	focusedField = undefined;
	focusedNav = undefined;
	focusedCaret = undefined;
	const selector = field !== undefined ? `[data-field="${field}"]` : nav !== undefined ? `[data-nav="${nav}"]` : undefined;
	if (selector === undefined) return;
	const node = root.querySelector<HTMLElement>(selector);
	if (!node) return;
	node.focus();
	if (caret !== undefined && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
		node.setSelectionRange(caret, caret);
	}
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function render(): void {
	rememberFocus();
	captureForm();
	root.replaceChildren();
	const snapshot = state.snapshot;
	// A failed read has nothing to filter: the rail draws without badges and the body
	// explains itself, instead of every category claiming "no match".
	const matches = snapshot && !snapshot.error ? searchSnapshot(snapshot, state.query) : undefined;
	root.append(rail(matches), main(snapshot, matches));
	restoreFocus();
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/**
 * Rail icons, drawn inline: the webview's CSP allows no external font, and five
 * shapes are not worth bundling VS Code's codicon font for.
 */
const ICON_PATHS: Record<SettingsPageId, string[]> = {
	overview: ["M2 7 8 2l6 5v7H2z", "M6.4 14V9.8h3.2V14"],
	roles: ["M8 2.2 14 5.4 8 8.6 2 5.4z", "M2 8.8l6 3.2 6-3.2", "M2 11.8l6 3.2 6-3.2"],
	models: ["M8 2l6 3.4v6L8 14.6 2 11.4v-6z", "M2 5.4 8 8.6l6-3.2", "M8 8.6v6"],
	other: ["M2 5.6h6.2", "M11.4 5.6H14", "M8.4 3.9h2.6v3.4H8.4z", "M2 10.8h2.6", "M7.8 10.8H14", "M4.6 9.1h2.6v3.4H4.6z"],
	host: [
		"M4.8 4.8h6.4v6.4H4.8z",
		"M6.6 2.2v2.6",
		"M9.4 2.2v2.6",
		"M6.6 11.2v2.6",
		"M9.4 11.2v2.6",
		"M2.2 6.6h2.6",
		"M2.2 9.4h2.6",
		"M11.2 6.6h2.6",
		"M11.2 9.4h2.6",
	],
};

function pageIcon(id: SettingsPageId, className: string): SVGSVGElement {
	return svgIcon(ICON_PATHS[id], className);
}

/** The left rail: the panel's name, then one row per category with what it holds. */
function rail(matches: SearchMatches | undefined): HTMLElement {
	const nav = el("nav", "settings-nav");
	nav.append(el("div", "settings-nav-head", "OMP 设置"));
	for (const page of SETTINGS_PAGES) {
		const active = page.id === state.page;
		const item = el("button", `settings-nav-item${active ? " active" : ""}`);
		item.dataset.nav = page.id;
		if (active) item.setAttribute("aria-current", "page");
		item.append(pageIcon(page.id, "settings-nav-icon"), el("span", "settings-nav-label", page.label));
		const count = matches ? pageCount(matches, page.id) : undefined;
		if (count !== undefined) item.append(el("span", "settings-nav-count", String(count)));
		item.addEventListener("click", () => act(() => selectPage(state, page.id)));
		nav.append(item);
	}
	return nav;
}

function main(snapshot: SettingsSnapshot | undefined, matches: SearchMatches | undefined): HTMLElement {
	const pane = el("div", "settings-main");
	pane.append(header(snapshot));
	const body = el("div", "settings-body");
	body.append(pageShell(pageDef(state.page), pageContent(snapshot, matches)));
	pane.append(body);
	return pane;
}

/** The category's own intro line, then whatever that category has to show. */
function pageShell(page: SettingsPageDef, content: HTMLElement[]): HTMLElement {
	const wrap = el("div", "settings-page-body");
	wrap.append(el("div", "settings-page-intro muted small", page.description), ...content);
	return wrap;
}

function pageContent(snapshot: SettingsSnapshot | undefined, matches: SearchMatches | undefined): HTMLElement[] {
	if (snapshot === undefined) return [el("div", "settings-pad muted", "正在读取 omp 配置…")];
	if (matches === undefined) {
		return [
			el("div", "settings-pad settings-error", `读不到 omp 配置：${snapshot.error ?? "未知错误"}`),
			el("div", "settings-pad muted small", "确认 ompStudio.ompPath 指向可执行的 omp，然后点「重新读取」。"),
		];
	}
	switch (state.page) {
		case "overview":
			return overviewPage(snapshot, matches);
		case "roles":
			return rolesPage(snapshot, matches);
		case "models":
			return modelsPage(snapshot, matches);
		case "other":
			return otherPage(snapshot, matches);
		case "host":
			return hostPage(snapshot, matches);
	}
}

/**
 * The "nothing here" body. With a query it names the query and offers the categories
 * that do have hits; with no query it says why the category is bare, because "no
 * providers yet" must not read as a failed search.
 */
function emptyState(noneYet: string, matches: SearchMatches): HTMLElement {
	const wrap = el("div", "settings-empty");
	if (!state.query.trim()) {
		wrap.append(el("div", "muted", noneYet));
		return wrap;
	}
	wrap.append(el("div", undefined, `没有匹配「${state.query}」的设置`));
	const elsewhere = pagesWithMatches(matches).filter((id) => id !== state.page);
	if (elsewhere.length > 0) {
		const links = el("div", "settings-empty-links");
		links.append(el("span", "muted small", "其他分类有命中："));
		for (const id of elsewhere) links.append(button(pageDef(id).label, "chip", () => act(() => selectPage(state, id))));
		wrap.append(links);
	}
	return wrap;
}

function header(snapshot: SettingsSnapshot | undefined): HTMLElement {
	const wrap = el("div", "settings-head-wrap");
	const head = el("div", "settings-head");
	head.append(el("div", "settings-title", pageDef(state.page).label));
	const search = el("input", "settings-search") as HTMLInputElement;
	search.type = "search";
	search.placeholder = "搜索设置…";
	search.value = state.query;
	// Marked like a form field so the rebuild after each keystroke puts the caret back:
	// without this the box would swallow everything after the first character.
	search.dataset.field = "query";
	search.addEventListener("input", () => {
		state.query = search.value;
		render();
	});
	const refresh = button("重新读取", "chip", () => send({ type: "refresh" }));
	refresh.disabled = state.busy !== undefined;
	head.append(search, refresh);

	const meta = el("div", "settings-meta small muted");
	if (state.busy) {
		meta.append(el("span", "settings-busy", `${state.busy}…`));
	} else if (snapshot) {
		meta.append(el("span", undefined, `agent ${snapshot.paths.agentDir}`));
		if (snapshot.ompVersion) meta.append(el("span", undefined, ` · omp ${snapshot.ompVersion}`));
		meta.append(button("config.yml ↗", "footer-chip", () => send({ type: "file/open", path: snapshot.paths.configFile })));
		meta.append(button("models.yml ↗", "footer-chip", () => send({ type: "file/open", path: snapshot.paths.modelsFile })));
	}
	wrap.append(head, meta);

	if (state.notice) {
		const banner = el("div", `settings-notice ${state.notice.level}`, state.notice.text);
		banner.title = "点击关闭";
		banner.addEventListener("click", () => act(() => dismissNotice(state)));
		wrap.append(banner);
	}
	return wrap;
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

function overviewPage(snapshot: SettingsSnapshot, matches: SearchMatches): HTMLElement[] {
	const content: HTMLElement[] = [];
	if (state.query.trim() && !hasAnyMatch(matches)) content.push(emptyState("没有可显示的设置。", matches));
	content.push(categoryCards(snapshot, matches), writeDiscipline());
	return content;
}

/** What is behind each door, with the count the rail is showing - so the two never disagree. */
function categoryCards(snapshot: SettingsSnapshot, matches: SearchMatches): HTMLElement {
	const row = el("div", "settings-cards");
	const card = (id: SettingsPageId, meta: string): HTMLElement => {
		const page = pageDef(id);
		const node = el("button", "settings-card");
		node.dataset.nav = id;
		node.append(pageIcon(id, "settings-card-icon"));
		node.append(el("div", "settings-card-title", page.label), el("div", "settings-card-meta muted small", meta));
		node.append(el("div", "settings-card-desc muted small", page.description));
		node.addEventListener("click", () => act(() => selectPage(state, id)));
		return node;
	};
	row.append(
		card("roles", `${matches.roles.length} 个角色`),
		card("models", providerTally(snapshot, matches.providers)),
		card("other", `${matches.settings.length} 项设置`),
		card("host", `${matches.host.length} 项设置`),
	);
	return row;
}

/**
 * Who writes which file (dev-plan §2.7). Kept on the overview rather than repeated in
 * each category's help text: it is the same single-writer rule three times over.
 */
function writeDiscipline(): HTMLElement {
	const box = el("div", "settings-discipline");
	box.append(el("div", "panel-title", "写入纪律"));
	const rows: [string, string][] = [
		["config.yml", "角色与设置走 `omp config set`，由 omp 自己写：插件永不直接改这个文件。"],
		["models.yml", "omp 没有写它的命令，所以由本页直接写（唯一例外）：保注释编辑、写前沙箱校验、原子写 + .bak。"],
		["mcp.json", "只在侧栏列出、切换、跳文件；本页不写。"],
	];
	for (const [file, text] of rows) {
		const line = el("div", "settings-discipline-row");
		line.append(el("code", "settings-discipline-file", file), el("span", "muted small", text));
		box.append(line);
	}
	return box;
}

// ---------------------------------------------------------------------------
// 模型角色
// ---------------------------------------------------------------------------

function rolesPage(snapshot: SettingsSnapshot, matches: SearchMatches): HTMLElement[] {
	const content: HTMLElement[] = [
		el(
			"div",
			"settings-note muted small",
			"角色写进全局 config.yml（`omp config set` 只能写全局）。改动对新会话生效，已打开的会话需重开。",
		),
	];
	const rows = roleRows(snapshot).filter((row) => matches.roles.includes(row.role));
	if (rows.length === 0) content.push(emptyState("这个分类没有可显示的角色。", matches));
	else content.push(...rows.map(roleRow));

	if (snapshot.settings.some((setting) => setting.key === "modelRoleStorage" && setting.value === "project")) {
		content.push(
			el(
				"div",
				"settings-note warn small",
				"你的 modelRoleStorage 是 project：omp 自己的模型选择器会把角色写进项目 .omp/config.yml，而这里的编辑仍落全局。按项目的角色请在 omp 终端改，或直接编辑项目配置。",
			),
		);
		content.push(
			button("打开项目 config.yml ↗", "footer-chip", () => send({ type: "file/open", path: snapshot.paths.projectConfigFile })),
		);
	}
	return content;
}

function roleRow(row: RoleRow): HTMLElement {
	const wrap = el("div", "role-row");
	const label = el("div", "role-label");
	label.append(el("code", "role-name", row.role), el("span", "muted small", row.description));
	wrap.append(label);

	const controls = el("div", "role-controls");
	const model = el("select", "settings-select") as HTMLSelectElement;
	model.append(new Option("未设置", ""));
	// Group by provider, keeping the shared order; the "current value" group comes first
	// when the stored selector is not in the catalog.
	const groups = new Map<string, HTMLOptGroupElement>();
	for (const option of row.options) {
		const node: HTMLOptionElement = new Option(option.label, option.value);
		if (!option.group) {
			model.append(node);
			continue;
		}
		let group = groups.get(option.group);
		if (!group) {
			group = el("optgroup") as HTMLOptGroupElement;
			group.label = option.group;
			groups.set(option.group, group);
			model.append(group);
		}
		group.append(node);
	}
	model.value = row.selector ?? "";
	model.disabled = state.busy !== undefined;

	const level = el("select", "settings-select level") as HTMLSelectElement;
	const levelsAvailable = row.thinkingChoices.length > 0;
	level.disabled = !levelsAvailable || state.busy !== undefined;
	level.title = levelsAvailable ? "思考等级（可选）" : "这个模型没有声明可用的思考等级";
	level.append(new Option(levelsAvailable ? "默认" : "—", ""));
	for (const choice of row.thinkingChoices) level.append(new Option(choice, choice));
	level.value = row.thinking;

	const commit = () => {
		const selector = composeSelector(model.value, level.value);
		send({ type: "role/set", role: row.role, selector: selector || null });
	};
	model.addEventListener("change", commit);
	level.addEventListener("change", commit);

	controls.append(model, level);
	if (row.selector) {
		const clear = button("清除", "chip", () => send({ type: "role/set", role: row.role, selector: null }));
		clear.disabled = state.busy !== undefined;
		controls.append(clear);
	}
	if (row.unresolved && row.selector) controls.append(el("span", "chip warn", "目录里已没有这个模型"));
	wrap.append(controls);
	return wrap;
}

// ---------------------------------------------------------------------------
// 自定义模型
// ---------------------------------------------------------------------------

function modelsPage(snapshot: SettingsSnapshot, matches: SearchMatches): HTMLElement[] {
	const content: HTMLElement[] = [
		el(
			"div",
			"settings-note muted small",
			"写进 agent 目录的 models.yml。每次保存前先用真实 omp 校验一遍，校验不过就不落盘；每次写入都留 .bak 备份。",
		),
	];
	if (snapshot.modelsFileError) content.push(el("div", "settings-note settings-error", snapshot.modelsFileError));

	// A new provider has no row to sit under, so its form goes above the list - and it
	// keeps rendering even when the query hides every provider, so an open form is
	// never yanked out from under the caret.
	const form = state.form;
	const adding = form?.kind === "provider" && form.originalId === undefined ? form : undefined;
	if (adding) content.push(providerForm(adding, snapshot));

	const bar = el("div", "settings-toolbar");
	const add = button("+ 添加提供商", "chip", () => act(openNewProviderForm.bind(null, state)));
	add.disabled = state.busy !== undefined;
	bar.append(add, el("span", "spacer"));
	content.push(bar);

	let shown = 0;
	for (const match of matches.providers) {
		const provider = snapshot.providers.find((candidate) => candidate.id === match.id);
		if (!provider) continue;
		shown += 1;
		content.push(providerBlock(provider, snapshot, match.models));
		if (form?.kind === "model" && form.providerId === provider.id) content.push(modelForm(form, provider));
	}
	if (shown === 0) content.push(emptyState("models.yml 里还没有提供商。", matches));
	return content;
}

function providerBlock(provider: ProviderView, snapshot: SettingsSnapshot, visibleModels: string[] | "all"): HTMLElement {
	const wrap = el("div", "provider-block");
	const expanded = state.open.includes(provider.id);
	const head = el("div", "provider-row");
	const toggle = button(`${expanded ? "▾" : "▸"} ${provider.id}`, "provider-toggle", () =>
		act(() => toggleProviderOpen(state, provider.id)),
	);
	toggle.disabled = state.busy !== undefined;
	head.append(
		toggle,
		el("span", "muted small", `${provider.baseUrl ?? "(缺 baseUrl)"} · ${provider.api ?? "(缺 api)"}`),
		el("span", "muted small", `${provider.models.length} 个模型${provider.hasApiKey ? "" : " · 没设 apiKey"}`),
		el("span", "spacer"),
	);

	const edit = button("改", "chip", () => act(() => openProviderForm(state, provider)));
	edit.disabled = state.busy !== undefined;
	const key = deleteKeyProvider(provider.id);
	const remove = button(deleteArm(key) ? "确认删除" : "删", "chip", () =>
		act(() => {
			if (requestDelete(state, key)) send({ type: "provider/delete", id: provider.id });
		}),
	);
	remove.disabled = state.busy !== undefined;
	head.append(edit, remove);
	head.append(button("models.yml ↗", "footer-chip", () => send({ type: "file/open", path: snapshot.paths.modelsFile })));
	wrap.append(head);

	const form = state.form;
	if (form?.kind === "provider" && form.originalId === provider.id) {
		wrap.append(providerForm(form, snapshot));
		return wrap;
	}
	if (!expanded) return wrap;

	const list = el("div", "model-list");
	const models =
		visibleModels === "all" ? provider.models : provider.models.filter((model) => visibleModels.includes(model.id));
	if (models.length === 0) list.append(el("div", "muted small settings-note", "这个提供商还没有模型"));
	for (const model of models) list.append(modelRow(provider, model));
	const addModel = button("+ 添加模型", "chip", () => act(() => openModelForm(state, provider.id)));
	addModel.disabled = state.busy !== undefined;
	list.append(addModel);
	wrap.append(list);
	return wrap;
}

function modelRow(provider: ProviderView, model: ProviderModelView): HTMLElement {
	const row = el("div", "model-row");
	const detail = [
		model.contextWindow === undefined ? undefined : `ctx ${formatTokens(model.contextWindow)}`,
		model.maxTokens === undefined ? undefined : `max ${formatTokens(model.maxTokens)}`,
		model.thinking?.length ? `thinking ${model.thinking.join("/")}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	const main = el("div", "session-main");
	main.append(el("div", "model-id", model.name ?? model.id), el("div", "muted small", `${model.id}${detail ? ` · ${detail}` : ""}`));
	row.append(main);

	const edit = button("改", "chip", () => act(() => openModelForm(state, provider.id, model)));
	edit.disabled = state.busy !== undefined;
	const key = deleteKeyModel(provider.id, model.id);
	const remove = button(deleteArm(key) ? "确认删除" : "删", "chip", () =>
		act(() => {
			if (requestDelete(state, key)) send({ type: "model/delete", providerId: provider.id, id: model.id });
		}),
	);
	remove.disabled = state.busy !== undefined;
	row.append(edit, remove);
	return row;
}

function deleteArm(key: string): boolean {
	return state.confirmDelete === key;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function providerForm(form: Extract<FormTarget, { kind: "provider" }>, snapshot: SettingsSnapshot): HTMLElement {
	const box = el("div", "settings-form");
	box.append(el("div", "panel-title", form.originalId ? `编辑提供商 ${form.originalId}` : "新提供商"));

	const idInput = textField(
		"id",
		"提供商 ID",
		form.draft.id,
		form.originalId ? "ID 不可改名：要换名字请删除后新建" : "自定义名字，会成为 models.yml 里 providers 下的键",
		form.originalId !== undefined,
	);
	box.append(idInput, textField("baseUrl", "baseUrl", form.draft.baseUrl, "API 基础地址，例如 http://127.0.0.1:17777/v1"));
	box.append(selectField("api", "api", form.draft.api, API_TYPES, "接口类型。anthropic 兼容端点选 anthropic-messages。"));

	const keyField = el("label", "settings-field");
	keyField.append(el("span", "settings-field-label", "apiKey"));
	const key = el("input", "settings-input") as HTMLInputElement;
	key.type = "password";
	key.dataset.field = "apiKey";
	key.value = form.draft.apiKey ?? "";
	key.placeholder = form.hasKey ? "已设置，留空表示不改" : "必填";
	keyField.append(key, el("span", "settings-field-help", "只在保存时写进文件；已经存过的值不会回传到这个页面。"));
	box.append(keyField);

	const details = el("details", "settings-advanced") as HTMLDetailsElement;
	details.append(el("summary", undefined, "headers（可选，JSON）"));
	const headers = el("textarea", "settings-input") as HTMLTextAreaElement;
	headers.rows = 3;
	headers.dataset.field = "headers";
	headers.value = form.headersRaw ?? (form.draft.headers ? JSON.stringify(form.draft.headers, null, 2) : "");
	headers.placeholder = '{ "X-Api-Version": "1" }';
	details.append(headers);
	box.append(details);

	if (!form.originalId) {
		box.append(el("div", "panel-subtitle", "第一个模型"), modelFields(form.firstModel, "model."));
		box.append(el("div", "settings-field-help", "新提供商必须至少带一个模型，否则 omp 不会把它算进模型目录。"));
	}

	const actions = el("div", "settings-form-actions");
	const save = button(form.originalId ? "保存" : "创建", "chip primary", () => {
		captureForm();
		let headersValue: Record<string, string> | undefined;
		const raw = form.headersRaw?.trim();
		if (raw) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
				headersValue = parsed as Record<string, string>;
			} catch (error) {
				applyNotice(state, `headers 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, "error");
				render();
				return;
			}
		}
		markFormSubmitted(state, "provider");
		const provider: ProviderDraft = { ...form.draft, headers: headersValue };
		send({
			type: "provider/save",
			...(form.originalId ? { originalId: form.originalId } : {}),
			provider,
			...(form.originalId ? {} : { firstModel: form.firstModel as ModelDraft }),
		});
	});
	save.disabled = state.busy !== undefined;
	actions.append(save, button("取消", "chip", () => act(() => closeForm(state))), el("span", "spacer"));
	actions.append(button("models.yml ↗", "footer-chip", () => send({ type: "file/open", path: snapshot.paths.modelsFile })));
	box.append(actions);
	return box;
}

function modelForm(form: Extract<FormTarget, { kind: "model" }>, provider: ProviderView): HTMLElement {
	const box = el("div", "settings-form");
	box.append(el("div", "panel-title", `${provider.id} · ${form.originalId ? `编辑模型 ${form.originalId}` : "新模型"}`));
	box.append(modelFields(form.draft, ""));
	box.append(textField("thinking", "thinking 等级", (form.draft.thinking ?? []).join(", "), "逗号分隔，例如 minimal, low, high。留空表示由 omp 决定。"));
	if (form.originalId) box.append(el("div", "settings-field-help", "模型 ID 不可改名：需要换 ID 请删除后新建。"));

	const actions = el("div", "settings-form-actions");
	const save = button("保存", "chip primary", () => {
		captureForm();
		markFormSubmitted(state, "model");
		send({
			type: "model/save",
			providerId: form.providerId,
			...(form.originalId ? { originalId: form.originalId } : {}),
			model: form.draft,
		});
	});
	save.disabled = state.busy !== undefined;
	actions.append(save, button("取消", "chip", () => act(() => closeForm(state))));
	box.append(actions);
	return box;
}

/** The four fields every model has, wherever it is edited. `prefix` keeps the two forms' fields distinct. */
function modelFields(draft: ModelDraft, prefix: string): HTMLElement {
	const grid = el("div", "settings-field-grid");
	grid.append(
		textField(`${prefix}id`, "模型 ID", draft.id ?? "", "provider 侧的模型标识，例如 glm-5"),
		textField(`${prefix}name`, "显示名", draft.name ?? "", "留空则显示 ID"),
		textField(`${prefix}contextWindow`, "contextWindow", draft.contextWindow?.toString() ?? "", "上下文窗口 token 数"),
		textField(`${prefix}maxTokens`, "maxTokens", draft.maxTokens?.toString() ?? "", "单次最大输出 token 数"),
	);
	return grid;
}

function textField(field: string, label: string, value: string, help?: string, disabled = false): HTMLElement {
	const wrap = el("label", "settings-field");
	wrap.append(el("span", "settings-field-label", label));
	const input = el("input", "settings-input") as HTMLInputElement;
	input.dataset.field = field;
	input.value = value;
	input.disabled = disabled;
	wrap.append(input);
	if (help) wrap.append(el("span", "settings-field-help", help));
	return wrap;
}

function selectField(field: string, label: string, value: string, choices: string[], help?: string): HTMLElement {
	const wrap = el("label", "settings-field");
	wrap.append(el("span", "settings-field-label", label));
	const select = el("select", "settings-select") as HTMLSelectElement;
	select.dataset.field = field;
	for (const choice of value && !choices.includes(value) ? [value, ...choices] : choices) {
		select.append(new Option(choice, choice));
	}
	select.value = value;
	wrap.append(select);
	if (help) wrap.append(el("span", "settings-field-help", help));
	return wrap;
}

// ---------------------------------------------------------------------------
// 其他
// ---------------------------------------------------------------------------

function otherPage(snapshot: SettingsSnapshot, matches: SearchMatches): HTMLElement[] {
	const rows = snapshot.settings.filter((setting) => matches.settings.includes(setting.key));
	if (rows.length === 0) return [emptyState("omp config 里没有可显示的设置。", matches)];
	return rows.map((setting) => {
		const row = el("div", "settings-setting");
		const control = el("div", "settings-setting-control");
		if (setting.kind === "enum" && setting.editable && setting.choices) {
			const select = el("select", "settings-select") as HTMLSelectElement;
			for (const choice of setting.choices) select.append(new Option(choice, choice));
			select.value = String(setting.value ?? "");
			select.disabled = state.busy !== undefined;
			select.addEventListener("change", () => send({ type: "scalar/set", key: setting.key, value: select.value }));
			control.append(select);
		} else {
			control.append(el("code", "settings-readonly", String(setting.value ?? "未设置")));
			if (!setting.editable) control.append(el("span", "chip readonly", "只读"));
		}
		row.append(el("div", "settings-field-label", setting.label), control, el("div", "settings-field-help", setting.description));
		if (setting.note) row.append(el("div", "settings-field-help warn", setting.note));
		return row;
	});
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

/** Said once, under the rows: the same keys are editable from VS Code's own settings page. */
const HOST_NOTE =
	"这些键也能在 VS Code 原生设置页（搜索 ompStudio）里改：两处写的是同一份值。改完立刻生效，已在跑的实例不受影响。";

/**
 * The extension's own numbers. Kept out of `otherPage` because nothing here comes from
 * omp: these rows write VS Code configuration (`ompStudio.*`), which is also why the
 * native settings page can edit the very same keys.
 */
function hostPage(snapshot: SettingsSnapshot, matches: SearchMatches): HTMLElement[] {
	const rows = snapshot.hostSettings.filter((setting) => matches.host.includes(setting.key));
	if (rows.length === 0) return [emptyState("本插件没有可显示的设置。", matches)];
	return [...rows.map(hostSettingRow), el("div", "settings-note muted small", HOST_NOTE)];
}

function hostSettingRow(setting: HostSettingView): HTMLElement {
	const row = el("div", "settings-setting");
	const control = el("div", "settings-setting-control");
	const input = el("input", "settings-input") as HTMLInputElement;
	input.type = "number";
	input.dataset.field = `host.${setting.key}`;
	input.min = String(setting.minimum);
	input.max = String(setting.maximum);
	input.step = "1";
	input.value = String(setting.value);
	input.disabled = state.busy !== undefined;
	// `change`, not `input`: a half-typed number must not be written on every keystroke.
	input.addEventListener("change", () => send({ type: "host-setting/set", key: setting.key, value: Number(input.value) }));
	control.append(input, el("span", "muted small", `${setting.minimum}–${setting.maximum} · 键 ompStudio.${setting.key}`));
	row.append(el("div", "settings-field-label", setting.label), control, el("div", "settings-field-help", setting.description));
	return row;
}

render();
