import type { ModelInfo } from "../rpc/types";
import type { ModelChoice } from "./protocol";

type CatalogModel = Pick<ModelInfo, "provider" | "id" | "name" | "contextWindow"> & { label?: string };

/**
 * Picker list: omp's catalog, plus the currently selected model if discovery
 * has not listed it yet. An empty catalog still yields the current model so
 * the popup is never "no models" after `get_state`.
 */
export function catalogChoices(models: readonly CatalogModel[], current?: CatalogModel): ModelChoice[] {
	const choices = models.map((model) => ({
		provider: model.provider,
		id: model.id,
		label: model.label || model.name || model.id,
		contextWindow: model.contextWindow,
	}));
	if (!current) return choices;
	if (choices.some((model) => model.provider === current.provider && model.id === current.id)) return choices;
	return [
		{
			provider: current.provider,
			id: current.id,
			label: current.label || current.name || current.id,
			contextWindow: current.contextWindow,
		},
		...choices,
	];
}
