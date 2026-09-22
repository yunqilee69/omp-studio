import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../src/shared/model-drafts";
import type { ProviderView, RoleAssignmentView, SettingsSnapshot } from "../../src/shared/protocol";
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
	providerDraft,
	providerTally,
	requestDelete,
	roleOptions,
	roleRows,
	searchSnapshot,
	selectPage,
	SETTINGS_PAGES,
	toggleProviderOpen,
} from "../../webview/settings-view";

function catalogEntry(selector: string, name?: string): ModelCatalogEntry {
	const [provider, ...rest] = selector.split("/");
	return { provider, id: rest.join("/"), selector, name };
}

const catalog: ModelCatalogEntry[] = [
	catalogEntry("OmniGate/glm-5", "GLM-5"),
	catalogEntry("OmniGate/deepseek", "DeepSeek"),
	catalogEntry("OmniGate2/claude", "Claude Opus 4.8"),
];

function role(overrides: Partial<RoleAssignmentView> & { role: string }): RoleAssignmentView {
	return {
		description: `${overrides.role} 的说明`,
		resolved: true,
		thinkingLevels: ["low", "high", "xhigh"],
		// The host derives this from the selector; the fixture spells it out because
		// the page reads both fields independently.
		thinking: overrides.selector?.includes(":") ? overrides.selector.split(":").pop() : undefined,
		...overrides,
	};
}

const providers: ProviderView[] = [
	{
		id: "OmniGate",
		baseUrl: "http://127.0.0.1:17777/v1",
		api: "openai-completions",
		hasApiKey: true,
		models: [{ id: "glm-5", name: "GLM-5", contextWindow: 230000, maxTokens: 270000 }],
	},
	{ id: "OmniGate2", api: "anthropic-messages", hasApiKey: false, models: [{ id: "claude", name: "Claude Opus 4.8" }] },
];

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
	return {
		roles: [role({ role: "default", selector: "OmniGate/glm-5:xhigh" }), role({ role: "smol" })],
		catalog,
		providers,
		settings: [
			{
				key: "defaultThinkingLevel",
				label: "默认思考等级",
				description: "Reasoning depth for thinking-capable models",
				kind: "enum",
				value: "high",
				choices: ["off", "high"],
				editable: true,
			},
			{
				key: "modelRoleStorage",
				label: "角色保存位置",
				description: "Where model selector role assignments are saved",
				kind: "enum",
				value: "global",
				editable: false,
				note: "omp config set 只能写全局",
			},
		],
		hostSettings: [
			{
				key: "maxInstances",
				label: "并发实例上限",
				description: "同时运行的实例软上限。达到后新建会话只提示 CPU 与费用，不阻止。",
				value: 4,
				minimum: 1,
				maximum: 16,
			},
		],
		paths: {
			agentDir: "/home/u/.omp/agent",
			configFile: "/home/u/.omp/agent/config.yml",
			modelsFile: "/home/u/.omp/agent/models.yml",
			projectConfigFile: "/repo/.omp/config.yml",
		},
		...overrides,
	};
}

describe("roleOptions", () => {
	it("groups every catalog model by provider and labels it with its display name", () => {
		const options = roleOptions(catalog);
		expect(options.map((option) => option.value)).toEqual([
			"OmniGate/glm-5",
			"OmniGate/deepseek",
			"OmniGate2/claude",
		]);
		expect(options[0]).toMatchObject({ label: "GLM-5 · glm-5", group: "OmniGate" });
		expect(options[2]?.group).toBe("OmniGate2");
	});

	it("does not repeat the id when the model has no distinct display name", () => {
		expect(roleOptions([catalogEntry("P/m")])[0]?.label).toBe("m");
	});

	// The lie this guards against: a <select> whose stored value is absent renders
	// its first option as selected, so an unsaved model would appear to be the role.
	it("keeps an unresolvable stored selector as a marked first option", () => {
		const options = roleOptions(catalog, "Gone/old-model:xhigh");
		expect(options[0]).toEqual({
			value: "Gone/old-model:xhigh",
			label: "Gone/old-model:xhigh（不在模型目录中）",
			group: "当前值",
		});
		expect(options).toHaveLength(catalog.length + 1);
	});

	it("does not duplicate a selector that is already in the catalog", () => {
		expect(roleOptions(catalog, "OmniGate/glm-5").map((option) => option.value)).toEqual(
			catalog.map((entry) => entry.selector),
		);
	});
});

describe("roleRows", () => {
	it("splits a stored selector into the model dropdown and the level dropdown", () => {
		const rows = roleRows(snapshot());
		expect(rows[0]).toMatchObject({ role: "default", selector: "OmniGate/glm-5:xhigh", thinking: "xhigh", unresolved: false });
	});

	it("leaves the level empty for an unset role and marks nothing unresolved", () => {
		expect(roleRows(snapshot())[1]).toMatchObject({ role: "smol", selector: undefined, thinking: "", unresolved: false });
	});

	it("flags a stored-but-missing model while still offering it in the dropdown", () => {
		const rows = roleRows(snapshot({ roles: [role({ role: "vision", selector: "Gone/x", resolved: false })] }));
		expect(rows[0]?.unresolved).toBe(true);
		expect(rows[0]?.options[0]?.value).toBe("Gone/x");
	});
});

describe("composeSelector", () => {
	it("joins the two dropdowns back into the stored form", () => {
		expect(composeSelector("OmniGate/glm-5", "xhigh")).toBe("OmniGate/glm-5:xhigh");
		expect(composeSelector("OmniGate/glm-5", "")).toBe("OmniGate/glm-5");
	});

	it("yields an empty string for 'no model', which the host reads as clearing the role", () => {
		expect(composeSelector("", "xhigh")).toBe("");
	});
});

describe("providerDraft", () => {
	it("never carries an apiKey value, even for a provider that has one", () => {
		const draft = providerDraft(providers[0]);
		expect(draft.apiKey).toBeUndefined();
		// `apiKey: undefined` is what the message bridge drops, so the host's only
		// signal stays "no key submitted - keep the one on disk".
		expect(JSON.parse(JSON.stringify(draft))).not.toHaveProperty("apiKey");
	});

	it("carries the existing baseUrl, api and headers so an edit does not blank them", () => {
		expect(providerDraft(providers[0])).toEqual({
			id: "OmniGate",
			baseUrl: "http://127.0.0.1:17777/v1",
			api: "openai-completions",
			apiKey: undefined,
			headers: undefined,
		});
	});

	it("defaults a new provider to the transport this machine's models.yml uses", () => {
		expect(providerDraft().api).toBe("openai-completions");
	});
});

describe("searchSnapshot", () => {
	const page = snapshot();

	it("returns everything for a blank query", () => {
		const matches = searchSnapshot(page, "");
		expect(matches.roles).toEqual(["default", "smol"]);
		expect(matches.providers).toEqual([
			{ id: "OmniGate", models: "all" },
			{ id: "OmniGate2", models: "all" },
		]);
		expect(matches.settings).toEqual(["defaultThinkingLevel", "modelRoleStorage"]);
		expect(matches.host).toEqual(["maxInstances"]);
		expect(hasAnyMatch(matches)).toBe(true);
	});

	it("matches a role by its description and by its stored selector", () => {
		expect(searchSnapshot(page, "smol").roles).toEqual(["smol"]);
		expect(searchSnapshot(page, "xhigh").roles).toEqual(["default"]);
	});

	it("keeps the whole provider when the provider itself matches", () => {
		expect(searchSnapshot(page, "17777").providers).toEqual([{ id: "OmniGate", models: "all" }]);
	});

	// A provider whose own text misses but whose model hits stays visible, listing
	// only the matching models - so the page narrows instead of hiding the row.
	it("keeps only the matching models when just a model matches", () => {
		expect(searchSnapshot(page, "claude").providers).toEqual([{ id: "OmniGate2", models: ["claude"] }]);
	});

	it("matches a setting by key, label and omp's own description", () => {
		expect(searchSnapshot(page, "thinking").settings).toEqual(["defaultThinkingLevel"]);
		expect(searchSnapshot(page, "Reasoning depth").settings).toEqual(["defaultThinkingLevel"]);
		expect(searchSnapshot(page, "保存位置").settings).toEqual(["modelRoleStorage"]);
	});

	it("matches the extension's own settings by key, label and description", () => {
		expect(searchSnapshot(page, "并发").host).toEqual(["maxInstances"]);
		expect(searchSnapshot(page, "实例软上限").host).toEqual(["maxInstances"]);
		expect(searchSnapshot(page, "maxInstances").host).toEqual(["maxInstances"]);
		expect(searchSnapshot(page, "maxInstances").settings).toEqual([]);
	});

	it("reports no match so the page can say so instead of looking empty", () => {
		expect(hasAnyMatch(searchSnapshot(page, "zzz-nothing"))).toBe(false);
	});
});

describe("categories", () => {
	it("lists the overview first and gives every category a label and an intro", () => {
		expect(SETTINGS_PAGES[0]?.id).toBe("overview");
		for (const page of SETTINGS_PAGES) {
			expect(page.label).not.toBe("");
			expect(page.description).not.toBe("");
		}
	});

	it("resolves an id to its definition and falls back to the overview", () => {
		expect(pageDef("models").label).toBe("自定义模型");
	});

	// The rail's badges and the pages must read the same numbers, so both come from here.
	it("counts what each category would show, and gives the overview no count at all", () => {
		const matches = searchSnapshot(snapshot(), "");
		expect(pageCount(matches, "overview")).toBeUndefined();
		expect(pageCount(matches, "roles")).toBe(2);
		expect(pageCount(matches, "models")).toBe(2);
		expect(pageCount(matches, "other")).toBe(2);
		expect(pageCount(matches, "host")).toBe(1);
	});

	it("narrows the counts with the query", () => {
		const matches = searchSnapshot(snapshot(), "claude");
		expect(pageCount(matches, "roles")).toBe(0);
		expect(pageCount(matches, "models")).toBe(1);
		expect(pagesWithMatches(matches)).toEqual(["models"]);
	});

	it("reports every category as a hit for a blank query", () => {
		expect(pagesWithMatches(searchSnapshot(snapshot(), ""))).toEqual(["roles", "models", "other", "host"]);
	});

	it("counts the models a provider narrowed to, not the ones it hides", () => {
		const everything = providerTally(snapshot(), searchSnapshot(snapshot(), "").providers);
		expect(everything).toBe("2 个提供商 · 2 个模型");
		const narrowed = providerTally(snapshot(), searchSnapshot(snapshot(), "claude").providers);
		expect(narrowed).toBe("1 个提供商 · 1 个模型");
	});
});

describe("page state", () => {
	it("opens on the overview with an empty query, no expanded rows and no form", () => {
		expect(createPageState()).toEqual({ page: "overview", query: "", open: [] });
	});

	it("switching category keeps the query, the expanded rows and the open form", () => {
		const state = createPageState();
		state.query = "glm";
		toggleProviderOpen(state, "OmniGate");
		openNewProviderForm(state);
		selectPage(state, "models");
		expect(state.page).toBe("models");
		expect(state.query).toBe("glm");
		expect(state.open).toEqual(["OmniGate"]);
		expect(state.form?.kind).toBe("provider");
	});

	it("a fresh snapshot does not disturb the query, the open rows or a typed form", () => {
		const state = createPageState();
		applySnapshot(state, snapshot());
		state.query = "glm";
		toggleProviderOpen(state, "OmniGate");
		openNewProviderForm(state);
		applySnapshot(state, snapshot({ ompVersion: "18.0.11" }));
		expect(state.query).toBe("glm");
		expect(state.open).toEqual(["OmniGate"]);
		expect(state.form?.kind).toBe("provider");
	});
});

describe("applyBusy", () => {
	it("labels the operation in flight and defaults the label", () => {
		const state = createPageState();
		applyBusy(state, true, "保存提供商");
		expect(state.busy).toBe("保存提供商");
		applyBusy(state, true);
		expect(state.busy).toBe("处理中");
	});

	it("closes the submitted form only on a confirmed success", () => {
		const state = createPageState();
		openNewProviderForm(state);
		markFormSubmitted(state, "provider");
		applyBusy(state, false, undefined, false);
		expect(state.busy).toBeUndefined();
		// A rejected write must not throw away what the user typed.
		expect(state.form).toBeDefined();

		markFormSubmitted(state, "provider");
		applyBusy(state, false, undefined, true);
		expect(state.form).toBeUndefined();
		expect(state.pendingForm).toBeUndefined();
	});

	it("does not close a form that was opened after submitting something else", () => {
		const state = createPageState();
		openModelForm(state, "OmniGate");
		markFormSubmitted(state, "provider");
		applyBusy(state, false, undefined, true);
		expect(state.form?.kind).toBe("model");
	});

	it("keeps the form when a failure arrives without a verdict", () => {
		const state = createPageState();
		openProviderForm(state, providers[0]);
		markFormSubmitted(state, "provider");
		applyBusy(state, false);
		expect(state.form).toBeDefined();
		expect(state.pendingForm).toBeUndefined();
	});
});

describe("notices", () => {
	it("stores the latest notice and can dismiss it", () => {
		const state = createPageState();
		applyNotice(state, "已保存", "info");
		expect(state.notice).toEqual({ text: "已保存", level: "info" });
		dismissNotice(state);
		expect(state.notice).toBeUndefined();
	});
});

describe("forms", () => {
	it("a new provider form carries a blank draft, a blank first model and no stored key", () => {
		const state = createPageState();
		openNewProviderForm(state);
		expect(state.form?.kind).toBe("provider");
		if (state.form?.kind !== "provider") return;
		// No originalId at all: the host reads its absence as "this is a create".
		expect(state.form.originalId).toBeUndefined();
		expect(state.form.hasKey).toBe(false);
		expect(state.form.draft.id).toBe("");
		expect(state.form.firstModel.id).toBe("");
	});

	it("an edit form records the original id, because provider ids are never renamed in place", () => {
		const state = createPageState();
		openProviderForm(state, providers[0]);
		expect(state.form).toMatchObject({ kind: "provider", originalId: "OmniGate", hasKey: true });
		if (state.form?.kind === "provider") expect(state.form.draft.id).toBe("OmniGate");
	});

	it("a model form knows its provider and, when editing, the id it replaces", () => {
		const state = createPageState();
		openModelForm(state, "OmniGate", providers[0]?.models[0]);
		expect(state.form).toMatchObject({ kind: "model", providerId: "OmniGate", originalId: "glm-5" });
		openModelForm(state, "OmniGate");
		expect(state.form).toMatchObject({ kind: "model", originalId: undefined });
	});

	it("closing a form clears the pending verdict too", () => {
		const state = createPageState();
		openNewProviderForm(state);
		markFormSubmitted(state, "provider");
		closeForm(state);
		expect(state.form).toBeUndefined();
		expect(state.pendingForm).toBeUndefined();
	});

	it("expands and collapses a provider row", () => {
		const state = createPageState();
		toggleProviderOpen(state, "OmniGate");
		expect(state.open).toEqual(["OmniGate"]);
		toggleProviderOpen(state, "OmniGate2");
		expect(state.open).toEqual(["OmniGate", "OmniGate2"]);
		toggleProviderOpen(state, "OmniGate");
		expect(state.open).toEqual(["OmniGate2"]);
	});
});

describe("requestDelete", () => {
	it("arms on the first click and confirms on the second", () => {
		const state = createPageState();
		const key = deleteKeyProvider("OmniGate");
		expect(requestDelete(state, key)).toBe(false);
		expect(state.confirmDelete).toBe(key);
		expect(requestDelete(state, key)).toBe(true);
		expect(state.confirmDelete).toBeUndefined();
	});

	it("moves the armed key when a different row is clicked", () => {
		const state = createPageState();
		requestDelete(state, deleteKeyProvider("OmniGate"));
		expect(requestDelete(state, deleteKeyProvider("OmniGate2"))).toBe(false);
		expect(state.confirmDelete).toBe("provider:OmniGate2");
	});

	it("keeps provider and model keys distinct, even for the same id", () => {
		const state = createPageState();
		requestDelete(state, deleteKeyProvider("glm-5"));
		expect(requestDelete(state, deleteKeyModel("OmniGate", "glm-5"))).toBe(false);
		expect(state.confirmDelete).toBe("model:OmniGate/glm-5");
	});
});
