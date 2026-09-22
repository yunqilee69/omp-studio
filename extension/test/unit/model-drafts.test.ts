import { describe, expect, it } from "vitest";
import {
	API_TYPES,
	DEFAULT_THINKING_LEVELS,
	MODEL_ROLES,
	MODEL_THINKING_LEVELS,
	formatSelector,
	formatTokens,
	matchesQuery,
	resolveSelector,
	thinkingLevelsFor,
	validateModelDraft,
	validateModelId,
	validateProviderDraft,
	validateProviderId,
	type ModelCatalogEntry,
} from "../../src/shared/model-drafts";

function entry(overrides: Partial<ModelCatalogEntry> & { selector: string }): ModelCatalogEntry {
	return { provider: overrides.selector.split("/")[0], id: overrides.selector.split("/").slice(1).join("/"), ...overrides };
}

/** The real catalog shape: a provider whose model ids contain slashes, like OpenRouter. */
const catalog: ModelCatalogEntry[] = [
	entry({ selector: "OmniGate/glm-5", provider: "OmniGate", id: "glm-5", name: "GLM-5", thinking: ["low", "high", "xhigh"] }),
	entry({ selector: "OpenRouter/anthropic/claude-3.5", provider: "OpenRouter", id: "anthropic/claude-3.5" }),
	entry({ selector: "OmniGate/deepseek", provider: "OmniGate", id: "deepseek", thinking: null }),
];

describe("vocabulary", () => {
	it("lists the six roles omp resolves from modelRoles", () => {
		expect(MODEL_ROLES.map((definition) => definition.role)).toEqual([
			"default",
			"smol",
			"slow",
			"plan",
			"vision",
			"advisor",
		]);
	});

	it("lists a model's own levels, without off or auto", () => {
		// omp's models.yml schema declares exactly this union for a model's `thinking:`.
		expect(MODEL_THINKING_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("adds auto for defaultThinkingLevel, and still without off", () => {
		// `omp config set defaultThinkingLevel off` fails: "Valid values: minimal,
		// low, medium, high, xhigh, max, auto".
		expect(DEFAULT_THINKING_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
		expect(DEFAULT_THINKING_LEVELS).not.toContain("off");
	});

	it("includes the transports this machine's models.yml actually uses", () => {
		expect(API_TYPES).toContain("openai-completions");
		expect(API_TYPES).toContain("anthropic-messages");
	});
});

describe("validateProviderId", () => {
	it("accepts plain scalars", () => {
		expect(validateProviderId("OmniGate")).toBeUndefined();
		expect(validateProviderId("llm-proxy_2.local")).toBeUndefined();
	});

	it("rejects what would break the providers map key", () => {
		expect(validateProviderId("")).toMatch(/不能为空/);
		expect(validateProviderId("   ")).toMatch(/不能为空/);
		expect(validateProviderId("has space")).toMatch(/只能/);
		expect(validateProviderId("slash/id")).toMatch(/只能/);
		expect(validateProviderId("a".repeat(65))).toMatch(/太长/);
	});
});

describe("validateModelId", () => {
	it("allows slashes, because upstream model ids contain them", () => {
		expect(validateModelId("anthropic/claude-3.5")).toBeUndefined();
	});

	it("rejects empties and whitespace", () => {
		expect(validateModelId("  ")).toMatch(/不能为空/);
		expect(validateModelId("has space")).toMatch(/空白/);
	});
});

describe("validateProviderDraft", () => {
	const valid = { id: "P", baseUrl: "http://127.0.0.1:17777/v1", api: "openai-completions" };

	it("accepts the fixture provider", () => {
		expect(validateProviderDraft(valid)).toEqual([]);
	});

	it("requires an absolute http(s) baseUrl", () => {
		expect(validateProviderDraft({ ...valid, baseUrl: "" })).toContain("baseUrl 不能为空");
		expect(validateProviderDraft({ ...valid, baseUrl: "127.0.0.1:17777" })).toContain(
			"baseUrl 必须以 http:// 或 https:// 开头",
		);
	});

	it("requires an api transport", () => {
		expect(validateProviderDraft({ ...valid, api: "  " })).toContain("api 不能为空");
	});

	it("rejects an empty header name or a non-string header value", () => {
		const errors = validateProviderDraft({ ...valid, headers: { "": "x", Authorization: 7 as unknown as string } });
		expect(errors).toContain("headers 里有空的名字");
		expect(errors).toContain("headers.Authorization 的值必须是字符串");
	});

	it("does not require an apiKey: an edit that leaves it blank keeps the stored one", () => {
		expect(validateProviderDraft({ ...valid, apiKey: undefined })).toEqual([]);
	});
});

describe("validateModelDraft", () => {
	it("accepts a minimal draft", () => {
		expect(validateModelDraft({ id: "glm-5" })).toEqual([]);
	});

	it("requires positive integers for the token counts", () => {
		expect(validateModelDraft({ id: "m", contextWindow: 0 })).toContain("contextWindow 必须是正整数");
		expect(validateModelDraft({ id: "m", maxTokens: -1 })).toContain("maxTokens 必须是正整数");
		expect(validateModelDraft({ id: "m", maxTokens: 1.5 })).toContain("maxTokens 必须是正整数");
	});

	it("rejects a thinking level omp does not know", () => {
		expect(validateModelDraft({ id: "m", thinking: ["low", "turbo"] })).toContain("thinking 里有未知等级：turbo");
	});

	it("rejects off and auto for a model, which models.yml does not allow there", () => {
		// Both belong to other vocabularies: `off` to the session picker, `auto` to
		// the defaultThinkingLevel config enum.
		expect(validateModelDraft({ id: "m", thinking: ["off"] })).toContain("thinking 里有未知等级：off");
		expect(validateModelDraft({ id: "m", thinking: ["auto"] })).toContain("thinking 里有未知等级：auto");
	});
});

describe("formatSelector", () => {
	it("builds the stored form, with the level only when there is one", () => {
		expect(formatSelector("OmniGate", "glm-5")).toBe("OmniGate/glm-5");
		expect(formatSelector("OmniGate", "glm-5", "xhigh")).toBe("OmniGate/glm-5:xhigh");
	});
});

describe("resolveSelector", () => {
	it("matches the catalog's own selector strings", () => {
		expect(resolveSelector("OmniGate/glm-5", catalog)?.entry.id).toBe("glm-5");
		expect(resolveSelector("OmniGate/glm-5:xhigh", catalog)).toEqual({
			entry: catalog[0],
			thinking: "xhigh",
		});
	});

	// A naive `split("/")` would read provider `OpenRouter` and id `anthropic`, and
	// resolve the wrong model - or nothing at all.
	it("resolves a model id containing a slash", () => {
		expect(resolveSelector("OpenRouter/anthropic/claude-3.5", catalog)?.entry.id).toBe("anthropic/claude-3.5");
	});

	it("returns undefined for a selector that is not in the catalog", () => {
		expect(resolveSelector("Gone/model", catalog)).toBeUndefined();
		expect(resolveSelector("", catalog)).toBeUndefined();
	});

	it("resolves a real model with an unknown level suffix, without inventing a level", () => {
		expect(resolveSelector("OmniGate/glm-5:turbo", catalog)).toEqual({ entry: catalog[0] });
	});

	it("keeps the level when the model's own id ends in a colon-ish string", () => {
		const exotic = [entry({ selector: "P/a:b", provider: "P", id: "a:b" })];
		expect(resolveSelector("P/a:b", exotic)).toEqual({ entry: exotic[0] });
		expect(resolveSelector("P/a:b:low", exotic)).toEqual({ entry: exotic[0], thinking: "low" });
	});
});

describe("thinkingLevelsFor", () => {
	it("orders the model's levels by the canonical list", () => {
		expect(thinkingLevelsFor(catalog[0])).toEqual(["low", "high", "xhigh"]);
	});

	it("returns an empty list for a model with no thinking, or no entry at all", () => {
		expect(thinkingLevelsFor(catalog[2])).toEqual([]);
		expect(thinkingLevelsFor(undefined)).toEqual([]);
	});
});

describe("matchesQuery", () => {
	it("matches everything for a blank query", () => {
		expect(matchesQuery("", "anything")).toBe(true);
		expect(matchesQuery("   ", undefined)).toBe(true);
	});

	it("is case-insensitive and matches any of the haystacks", () => {
		expect(matchesQuery("GLM", "OmniGate", "glm-5", "GLM-5")).toBe(true);
		expect(matchesQuery("omnigate", "OmniGate", "glm-5")).toBe(true);
		expect(matchesQuery("nope", "OmniGate", "glm-5")).toBe(false);
	});

	it("ignores undefined haystacks", () => {
		expect(matchesQuery("x", undefined, "x")).toBe(true);
	});
});

describe("formatTokens", () => {
	it("compacts thousands and keeps small numbers as-is", () => {
		expect(formatTokens(230000)).toBe("230k");
		expect(formatTokens(270000)).toBe("270k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(undefined)).toBeUndefined();
	});
});
