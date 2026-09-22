import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModelCatalog, parseSettings } from "../../src/omp-config";
import { newSessionView } from "../../src/new-session";
import { MODE_NOTE } from "../../src/shared/protocol";

/**
 * The list composer's defaults. Both halves of the read are recorded CLI output (see
 * test/fixtures), so this file never launches omp - `readNewSession` is just the two
 * parsers plus one call each.
 */
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
}

const settings = parseSettings(fixture("config-list.json"));
const catalog = parseModelCatalog(fixture("models-ls.json"));

/** The whole `modelRoles` record, the way `omp config list --json` reports it. */
function roleRecord(selector: string) {
	return { value: { default: selector }, type: "record", description: "" };
}

describe("newSessionView", () => {
	it("offers the role's model as the default, with the level its selector pins", () => {
		const view = newSessionView(settings, catalog);

		expect(view.model).toEqual({ provider: "OmniGate", id: "glm-5", label: "GLM-5", contextWindow: 230000 });
		expect(view.thinking).toBe("xhigh");
	});

	it("lists the whole catalog for the picker", () => {
		const view = newSessionView(settings, catalog);

		expect(view.models.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"LLMProxy/glm-5",
			"OmniGate/deepseek",
			"OmniGate/glm-5",
			"OmniGate2/claude",
		]);
	});

	it("falls back to defaultThinkingLevel when the role selector carries no level", () => {
		const view = newSessionView({ ...settings, modelRoles: roleRecord("OmniGate/glm-5") }, catalog);

		expect(view.model?.provider).toBe("OmniGate");
		expect(view.thinking).toBe("high");
	});

	it("still lists the catalog when the default role points at a model that is gone", () => {
		const view = newSessionView({ ...settings, modelRoles: roleRecord("Nope/gone:max") }, catalog);

		expect(view.model).toBeUndefined();
		expect(view.thinking).toBe("high");
		expect(view.models).toHaveLength(4);
	});

	it("carries the upstream mode gap, so the pill has one explanation on both pages", () => {
		expect(newSessionView(settings, catalog).modeNote).toBe(MODE_NOTE);
	});

	it("reports failed reads instead of pretending the catalog is empty on purpose", () => {
		const view = newSessionView(undefined, [], ["omp models ls 失败：boom"]);

		expect(view.error).toBe("omp models ls 失败：boom");
		expect(view.models).toEqual([]);
		expect(view.model).toBeUndefined();
	});
});
