import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModelCatalog, parseSettings, parseVersion, readModelRoles } from "../../src/omp-config";

/**
 * Outputs recorded from omp 18.0.11 on this machine. The parsers are the only
 * part of `omp-config.ts` that can be tested without spawning a real process, so
 * they are exported separately for exactly this file.
 */
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
}

const configList = fixture("config-list.json");
const modelsLs = fixture("models-ls.json");

describe("parseSettings", () => {
	it("keeps the value, type and description of every key", () => {
		const settings = parseSettings(configList);
		expect(Object.keys(settings)).toEqual(["modelRoles", "modelRoleStorage", "defaultThinkingLevel"]);
		expect(settings.defaultThinkingLevel).toEqual({
			value: "high",
			type: "enum",
			description: "Reasoning depth for thinking-capable models",
			redacted: false,
		});
	});

	it("defaults a missing type to string and a missing description to empty", () => {
		const settings = parseSettings(JSON.stringify({ modelRoles: { value: { default: "a/b" } } }));
		expect(settings.modelRoles).toEqual({ value: { default: "a/b" }, type: "string", description: "", redacted: false });
	});

	it("marks redacted entries, which is how credential keys arrive", () => {
		const settings = parseSettings(JSON.stringify({ "providers.x.apiKey": { redacted: true, type: "string" } }));
		expect(settings["providers.x.apiKey"].redacted).toBe(true);
		expect(settings["providers.x.apiKey"].value).toBeUndefined();
	});

	it("skips entries that are not objects instead of throwing on them", () => {
		const settings = parseSettings(JSON.stringify({ good: { value: 1, type: "number" }, bad: "nonsense" }));
		expect(Object.keys(settings)).toEqual(["good"]);
	});

	it("rejects a payload that is not an object", () => {
		expect(() => parseSettings("[]")).toThrow(/不是对象/);
		expect(() => parseSettings("not json")).toThrow();
	});
});

describe("readModelRoles", () => {
	it("reads the record as a whole", () => {
		expect(readModelRoles(parseSettings(configList))).toEqual({ default: "OmniGate/glm-5:xhigh" });
	});

	it("returns an empty record when the key is missing or is not a record", () => {
		expect(readModelRoles({})).toEqual({});
		expect(readModelRoles({ modelRoles: { value: "OmniGate/glm-5", type: "string", description: "" } })).toEqual({});
	});

	it("drops blank and non-string selectors rather than surfacing them as roles", () => {
		const settings = parseSettings(
			JSON.stringify({ modelRoles: { value: { default: "a/b", smol: "   ", slow: 7 }, type: "record" } }),
		);
		expect(readModelRoles(settings)).toEqual({ default: "a/b" });
	});
});

describe("parseModelCatalog", () => {
	it("keeps provider, id and selector for every model", () => {
		const catalog = parseModelCatalog(modelsLs);
		expect(catalog.map((entry) => entry.selector)).toEqual([
			"LLMProxy/glm-5",
			"OmniGate/deepseek",
			"OmniGate/glm-5",
			"OmniGate2/claude",
		]);
		expect(catalog[0]).toMatchObject({
			provider: "LLMProxy",
			id: "glm-5",
			name: "GLM-5",
			contextWindow: 230000,
			maxTokens: 270000,
			reasoning: true,
		});
	});

	it("keeps thinking null for a model that reports none, distinct from an empty list", () => {
		const catalog = parseModelCatalog(modelsLs);
		// omp sends `thinking: null` for deepseek/claude; null means "model does not think".
		expect(catalog.find((entry) => entry.id === "deepseek")?.thinking).toBeNull();
		expect(catalog.find((entry) => entry.id === "glm-5")?.thinking).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	it("does not carry cost, which the settings page never shows", () => {
		expect(parseModelCatalog(modelsLs)[0]).not.toHaveProperty("cost");
	});

	it("falls back to Provider/id when selector is missing or empty", () => {
		const catalog = parseModelCatalog(JSON.stringify({ models: [{ provider: "P", id: "m" }, { provider: "P", id: "n", selector: "" }] }));
		expect(catalog.map((entry) => entry.selector)).toEqual(["P/m", "P/n"]);
	});

	it("skips rows without a provider or an id", () => {
		const catalog = parseModelCatalog(JSON.stringify({ models: [{ provider: "P" }, { id: "m" }, null, "x"] }));
		expect(catalog).toEqual([]);
	});

	it("throws when there is no models array", () => {
		expect(() => parseModelCatalog("{}")).toThrow(/没有 models 数组/);
		expect(() => parseModelCatalog(JSON.stringify({ models: {} }))).toThrow(/没有 models 数组/);
	});
});

describe("parseVersion", () => {
	it("takes the first non-blank line", () => {
		expect(parseVersion("\n  18.0.11  \n")).toBe("18.0.11");
		expect(parseVersion("omp 18.1.2 (bun 1.2)\n")).toBe("omp 18.1.2 (bun 1.2)");
	});

	it("returns undefined for empty output rather than an empty string", () => {
		expect(parseVersion("   \n\n")).toBeUndefined();
	});
});
