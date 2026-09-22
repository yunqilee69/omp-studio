import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogChoices } from "../../src/shared/models";
import type { ModelInfo } from "../../src/rpc/types";

function recordedModels(): ModelInfo[] {
	const raw = readFileSync(join(import.meta.dirname, "../../../docs/rpc-samples/basic.jsonl"), "utf8");
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const frame = JSON.parse(line) as { command?: string; data?: { models?: ModelInfo[] } };
		if (frame.command === "get_available_models" && Array.isArray(frame.data?.models)) return frame.data.models;
	}
	throw new Error("docs/rpc-samples/basic.jsonl has no get_available_models payload");
}

describe("catalogChoices", () => {
	it("keeps the current model selectable when omp has not listed it yet", () => {
		const current = { provider: "OmniGate", id: "grok-4.6", name: "Grok-4.6", contextWindow: 270000 };
		expect(catalogChoices([], current)).toEqual([
			{ provider: "OmniGate", id: "grok-4.6", label: "Grok-4.6", contextWindow: 270000 },
		]);
	});

	it("maps a recorded get_available_models payload and does not duplicate the current model", () => {
		const models = recordedModels();
		expect(models.length).toBeGreaterThan(1);
		const current = models.find((model) => model.id === "grok-4.6");
		expect(current).toBeDefined();
		const choices = catalogChoices(models, current);
		expect(choices.map((model) => model.id)).toEqual(models.map((model) => model.id));
		expect(choices.find((model) => model.id === "glm-5.3")?.label).toBe("GLM-5.3");
	});

	it("prepends the current model when it is missing from the catalog", () => {
		const catalog = [{ provider: "OmniGate", id: "glm-5.3", name: "GLM-5.3" }];
		const current = { provider: "OmniGate", id: "grok-4.6", name: "Grok-4.6" };
		expect(catalogChoices(catalog, current).map((model) => model.id)).toEqual(["grok-4.6", "glm-5.3"]);
	});
});
