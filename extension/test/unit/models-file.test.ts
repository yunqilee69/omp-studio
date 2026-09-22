import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EMPTY_MODELS_FILE,
	ModelsFileError,
	deleteModel,
	deleteProvider,
	hasProvider,
	readProviders,
	upsertModel,
	upsertProvider,
} from "../../src/models-file";
import type { ProviderDraft } from "../../src/shared/model-drafts";

/**
 * The fixture is this machine's real `~/.omp/agent/models.yml` with the two API
 * key *values* replaced by placeholders. Everything else - the Chinese comments,
 * the blank lines, the key order, the inline `# 使用 OmniGate 识别的实际 ID` - is
 * verbatim, because preserving exactly that is the point of these tests.
 */
const fixture = readFileSync(join(import.meta.dirname, "../fixtures/models.yml"), "utf8");

/** Comments are the thing we must not lose; compare them as text, ignoring the gap before `#`. */
function commentsIn(raw: string): string[] {
	return raw
		.split("\n")
		.map((line) => line.match(/#.*$/)?.[0])
		.filter((comment): comment is string => comment !== undefined);
}

function normalise(raw: string): string {
	return raw
		.split("\n")
		// Collapse the gap before an *inline* comment only; a comment's own indentation
		// is part of the file and must survive untouched.
		.map((line) => line.replace(/(\S)[ \t]+#/g, "$1 #"))
		.join("\n")
		.trimEnd();
}

const draft: ProviderDraft = {
	id: "NewGate",
	baseUrl: "http://127.0.0.1:9999/v1",
	api: "openai-completions",
	apiKey: "sk-test-new",
};

describe("readProviders", () => {
	it("reads this machine's real models.yml", () => {
		const { providers, error } = readProviders(fixture);
		expect(error).toBeUndefined();
		expect(providers.map((provider) => provider.id)).toEqual(["OmniGate", "LLMProxy", "OmniGate2"]);
		expect(providers[0].models.map((model) => model.id)).toEqual(["glm-5", "deepseek"]);
		expect(providers[0].models[0].contextWindow).toBe(230000);
		expect(providers[0].api).toBe("openai-completions");
		expect(providers[0].hasApiKey).toBe(true);
		expect(providers[2].models[0].id).toBe("claude");
	});

	it("never exposes the key value itself", () => {
		expect(JSON.stringify(readProviders(fixture))).not.toContain("sk-test");
	});

	it("reports a broken file as an error instead of throwing", () => {
		const { providers, error } = readProviders("providers:\n  x: [unclosed\n");
		expect(error).toBeTruthy();
		expect(providers).toEqual([]);
	});

	it("treats the empty template and a missing providers key as no providers", () => {
		expect(readProviders(EMPTY_MODELS_FILE).providers).toEqual([]);
		expect(readProviders("symbolPreset: nerd\n").providers).toEqual([]);
	});

	it("knows whether a provider key exists, for the apiKey-required rule", () => {
		expect(hasProvider(fixture, "OmniGate")).toBe(true);
		expect(hasProvider(fixture, "Nope")).toBe(false);
	});
});

describe("upsertProvider", () => {
	it("appends a new provider and keeps every comment and blank line", () => {
		const next = upsertProvider(fixture, draft);
		const { providers } = readProviders(next);
		expect(providers.map((provider) => provider.id)).toEqual(["OmniGate", "LLMProxy", "OmniGate2", "NewGate"]);
		expect(providers[3].baseUrl).toBe("http://127.0.0.1:9999/v1");
		expect(commentsIn(next)).toEqual([...commentsIn(fixture), ...commentsIn(next).slice(commentsIn(fixture).length)]);
		// The append touches nothing above it: the original content is still a prefix
		// (normalised, for the one cosmetic inline-comment rewrite).
		expect(next.startsWith(normalise(fixture).trimEnd())).toBe(true);
	});

	it("keeps the stored apiKey when the form sends none", () => {
		const next = upsertProvider(fixture, { id: "OmniGate", baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses" });
		expect(next).toContain("apiKey: sk-test-omnigate");
		const provider = readProviders(next).providers[0];
		expect(provider.baseUrl).toBe("http://127.0.0.1:1/v1");
		expect(provider.api).toBe("openai-responses");
	});

	it("replaces the apiKey only when one is given", () => {
		const next = upsertProvider(fixture, { id: "OmniGate", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "sk-test-rotated" });
		expect(next).toContain("apiKey: sk-test-rotated");
		// The fixture reuses one placeholder for two providers, so only OmniGate's copy may change.
		const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
		expect(count(next, "sk-test-omnigate")).toBe(count(fixture, "sk-test-omnigate") - 1);
		// The provider block's own comments survive an edit in place.
		expect(next).toContain("# API的基础地址");
		expect(next).toContain("# 接口类型，可选: openai-completions, anthropic-messages等");
	});

	it("refuses to create a provider without an apiKey", () => {
		expect(() => upsertProvider(fixture, { ...draft, apiKey: undefined })).toThrow(ModelsFileError);
	});

	it("refuses to rename: the id is the key comments hang off", () => {
		expect(() => upsertProvider(fixture, draft, "OmniGate")).toThrow(/不可改名/);
	});

	it("writes a new provider into the empty template", () => {
		const next = upsertProvider(EMPTY_MODELS_FILE, draft);
		expect(readProviders(next).providers.map((provider) => provider.id)).toEqual(["NewGate"]);
		expect(next).toContain("# 自定义提供商与模型");
	});
});

describe("deleteProvider", () => {
	it("removes only the named provider", () => {
		const next = deleteProvider(fixture, "LLMProxy");
		const ids = readProviders(next).providers.map((provider) => provider.id);
		expect(ids).toEqual(["OmniGate", "OmniGate2"]);
		expect(next).not.toContain("LLMProxy");
		expect(next).toContain("http://127.0.0.1:17777/v1");
	});

	it("refuses a provider that is not there, so a stale page cannot look successful", () => {
		expect(() => deleteProvider(fixture, "Ghost")).toThrow(/没有提供商 Ghost/);
	});
});

describe("upsertModel", () => {
	it("appends a model without eating the sequence comment", () => {
		const next = upsertModel(fixture, "OmniGate", { id: "grok-5", name: "Grok 5", contextWindow: 1000, maxTokens: 500 });
		expect(next).toContain("# 模型列表");
		expect(readProviders(next).providers[0].models.map((model) => model.id)).toEqual(["glm-5", "deepseek", "grok-5"]);
	});

	it("edits an existing model in place and touches one line", () => {
		const next = upsertModel(fixture, "OmniGate", { id: "glm-5", name: "GLM-5", contextWindow: 230000, maxTokens: 999999 });
		expect(next).toContain("# 模型列表");
		// Compared after normalising, so the one known cosmetic rewrite (the gap before
		// an inline comment, see the round-trip test) does not mask a real change.
		const before = normalise(fixture).split("\n");
		const after = normalise(next).split("\n");
		const changed = before.map((line, index) => (line !== after[index] ? index + 1 : 0)).filter(Boolean);
		expect(changed).toEqual([15]);
		expect(readProviders(next).providers[0].models[0].maxTokens).toBe(999999);
	});

	it("unsets a field that the form cleared", () => {
		const next = upsertModel(fixture, "OmniGate", { id: "glm-5", contextWindow: 230000, maxTokens: 270000 });
		const next2 = upsertModel(next, "OmniGate", { id: "glm-5", contextWindow: 230000, maxTokens: 270000, name: "GLM-5" });
		expect(readProviders(next2).providers[0].models[0].name).toBe("GLM-5");
		expect(readProviders(next).providers[0].models[0].name).toBeUndefined();
	});

	it("creates the models list for a provider that has none", () => {
		const bare = upsertProvider(EMPTY_MODELS_FILE, draft);
		const next = upsertModel(bare, "NewGate", { id: "first", name: "First" });
		expect(readProviders(next).providers[0].models.map((model) => model.id)).toEqual(["first"]);
	});

	it("refuses a provider that is not there", () => {
		expect(() => upsertModel(fixture, "Ghost", { id: "x" })).toThrow(/没有提供商 Ghost/);
	});

	it("refuses a rename", () => {
		expect(() => upsertModel(fixture, "OmniGate", { id: "other" }, "glm-5")).toThrow(/不可改名/);
	});
});

describe("deleteModel", () => {
	it("removes one model and keeps the rest", () => {
		const next = deleteModel(fixture, "OmniGate", "glm-5");
		expect(readProviders(next).providers[0].models.map((model) => model.id)).toEqual(["deepseek"]);
		expect(next).toContain("# 模型列表");
	});

	it("refuses a model that is not there", () => {
		expect(() => deleteModel(fixture, "OmniGate", "ghost")).toThrow(/没有模型 ghost/);
	});
});

describe("round-trip safety", () => {
	/**
	 * The hard gate for using a YAML library on a hand-written file: re-saving the
	 * unchanged content must not rewrite it. The only tolerated differences are the
	 * gap before an inline comment (`claude   # x` -> `claude # x`) and the trailing
	 * newline the file does not have.
	 */
	it("re-saving unchanged content is identical apart from inline-comment spacing", () => {
		const next = upsertModel(
			fixture,
			"OmniGate2",
			readProviders(fixture).providers[2].models[0],
			"claude",
		);
		expect(normalise(next)).toBe(normalise(fixture));
	});

	it("keeps every comment through a chain of edits", () => {
		let raw = upsertProvider(fixture, draft);
		raw = upsertModel(raw, "NewGate", { id: "m1", name: "M1" });
		raw = deleteModel(raw, "OmniGate", "deepseek");
		raw = upsertProvider(raw, { id: "OmniGate2", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages" });
		const expected = commentsIn(fixture).filter((comment) => !comment.includes("使用 OmniGate 识别的实际 ID"));
		for (const comment of expected) expect(commentsIn(raw)).toContain(comment);
	});

	it("reports YAML syntax errors as ModelsFileError rather than a raw parser error", () => {
		expect(() => deleteProvider("providers:\n\tbad: [", "x")).toThrow(ModelsFileError);
	});
});
