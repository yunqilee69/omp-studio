/**
 * The model-role and custom-model vocabulary the settings page edits.
 *
 * Shared by the extension host (validation before writing `models.yml`) and the
 * settings webview (form validation, dropdowns). Pure data and pure functions -
 * no VS Code, no DOM, no I/O - so both sides and the unit tests read one source.
 *
 * Verified against omp 18.0.11 / 18.1.2: role names, `api` transport values and
 * thinking levels come from the binary's own schema strings and `--help` output.
 */

/** Roles omp resolves from `modelRoles` in config.yml. */
export interface RoleDefinition {
	role: string;
	description: string;
}

export const MODEL_ROLES: RoleDefinition[] = [
	{ role: "default", description: "新会话默认模型（`omp --model` 可覆盖）" },
	{ role: "smol", description: "快 / 轻任务（`omp --smol`；prewalk 等流程默认走它）" },
	{ role: "slow", description: "慢而强的推理模型（`omp --slow`）" },
	{ role: "plan", description: "规划模式用的模型（`omp --plan`）" },
	{ role: "vision", description: "图像理解用的模型" },
	{ role: "advisor", description: "被动审阅每一轮的第二模型，需同时打开 advisor.enabled" },
];

/**
 * Reasoning levels a *model* can be pinned to: the `thinking:` list in
 * `models.yml`, and therefore the only valid `:level` suffix on a role selector.
 *
 * `off` and `auto` are deliberately absent. Verified against omp 18.0.11: the
 * models.yml schema declares this union verbatim (no `off`, no `auto`), and the
 * binary's own reasoning-level array is these six.
 */
export const MODEL_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Values `omp config set defaultThinkingLevel` accepts, i.e. the config enum
 * `[...MODEL_THINKING_LEVELS, "auto"]`. Not the same list as a model's own
 * levels: `auto` (classify per turn) is only meaningful as a default, and `off`
 * is rejected here - `omp` answers `Invalid value: off. Valid values: minimal,
 * low, medium, high, xhigh, max, auto`. The session picker offers `off` and
 * `inherit` because that is a third, RPC-level vocabulary (`rpc/types.ts`).
 */
export const DEFAULT_THINKING_LEVELS = [...MODEL_THINKING_LEVELS, "auto"] as const;

/** `api` transports omp recognises (`models.yml` provider field). */
export const API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"ollama-chat",
	"cursor-agent",
	"devin-agent",
	"gitlab-duo-agent",
	"openai-codex-responses",
];

export type ApiType = (typeof API_TYPES)[number];

/** A provider as the settings form submits it. `apiKey: undefined` means "keep what is on disk". */
export interface ProviderDraft {
	id: string;
	baseUrl: string;
	api: string;
	/** Never read back from disk: the host sends only `hasApiKey`, the form sends a value only when the user types one. */
	apiKey?: string;
	headers?: Record<string, string>;
}

/** One entry of a provider's `models:` list. */
export interface ModelDraft {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	/** Levels this model accepts; omitted means "let omp decide". */
	thinking?: string[];
	input?: string[];
}

/** A catalog row from `omp models ls --json`. */
export interface ModelCatalogEntry {
	provider: string;
	id: string;
	selector: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinking?: string[] | null;
	input?: string[] | null;
}

/**
 * Provider ids become the `providers:` map key in models.yml, so they must stay
 * plain scalars. They are never renamed in place: the settings page deletes and
 * recreates instead, because the key is what comments hang off.
 */
export function validateProviderId(id: string): string | undefined {
	const trimmed = id.trim();
	if (!trimmed) return "提供商 ID 不能为空";
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return "提供商 ID 只能用字母、数字、点、下划线、连字符";
	if (trimmed.length > 64) return "提供商 ID 太长（上限 64）";
	return undefined;
}

/** Model ids are free-form upstream (they may contain `/`), so only emptiness and whitespace are rejected. */
export function validateModelId(id: string): string | undefined {
	const trimmed = id.trim();
	if (!trimmed) return "模型 ID 不能为空";
	if (/\s/.test(trimmed)) return "模型 ID 不能含空白字符";
	return undefined;
}

export function validateProviderDraft(draft: ProviderDraft): string[] {
	const errors: string[] = [];
	const idError = validateProviderId(draft.id);
	if (idError) errors.push(idError);
	const baseUrl = draft.baseUrl.trim();
	if (!baseUrl) errors.push("baseUrl 不能为空");
	else if (!/^https?:\/\//i.test(baseUrl)) errors.push("baseUrl 必须以 http:// 或 https:// 开头");
	if (!draft.api.trim()) errors.push("api 不能为空");
	if (draft.headers) {
		for (const [key, value] of Object.entries(draft.headers)) {
			if (!key.trim()) errors.push("headers 里有空的名字");
			else if (typeof value !== "string") errors.push(`headers.${key} 的值必须是字符串`);
		}
	}
	return errors;
}

export function validateModelDraft(draft: ModelDraft): string[] {
	const errors: string[] = [];
	const idError = validateModelId(draft.id);
	if (idError) errors.push(idError);
	for (const field of ["contextWindow", "maxTokens"] as const) {
		const value = draft[field];
		if (value === undefined) continue;
		if (!Number.isInteger(value) || value <= 0) errors.push(`${field} 必须是正整数`);
	}
	for (const level of draft.thinking ?? []) {
		if (!(MODEL_THINKING_LEVELS as readonly string[]).includes(level)) errors.push(`thinking 里有未知等级：${level}`);
	}
	return errors;
}

/**
 * `selector` is what omp stores in `modelRoles`: `Provider/modelId`, optionally
 * suffixed with `:thinkingLevel` (the real config here reads `OmniGate/glm-5:xhigh`).
 */
export function formatSelector(provider: string, id: string, thinking?: string): string {
	const base = `${provider}/${id}`;
	return thinking ? `${base}:${thinking}` : base;
}

export interface ResolvedSelector {
	entry: ModelCatalogEntry;
	thinking?: string;
}

/**
 * Resolve a stored selector against the catalog.
 *
 * Deliberately NOT a `split("/")`: model ids can contain slashes (OpenRouter
 * style), so the only reliable parse is to match the catalog's own `selector`
 * strings. A thinking suffix is only split off after that exact match fails.
 */
export function resolveSelector(selector: string, catalog: ModelCatalogEntry[]): ResolvedSelector | undefined {
	const exact = catalog.find((entry) => entry.selector === selector);
	if (exact) return { entry: exact };
	const cut = selector.lastIndexOf(":");
	if (cut <= 0) return undefined;
	const base = selector.slice(0, cut);
	const suffix = selector.slice(cut + 1);
	const entry = catalog.find((candidate) => candidate.selector === base);
	if (!entry) return undefined;
	if (!(MODEL_THINKING_LEVELS as readonly string[]).includes(suffix)) return { entry };
	return { entry, thinking: suffix };
}

/** Thinking levels that make sense for a catalog entry; `[]` means the model reports none. */
export function thinkingLevelsFor(entry: ModelCatalogEntry | undefined): string[] {
	if (!entry?.thinking || entry.thinking.length === 0) return [];
	return MODEL_THINKING_LEVELS.filter((level) => entry.thinking?.includes(level));
}

/** Case-insensitive substring match over a row's searchable text, for the page's search box. */
export function matchesQuery(query: string, ...haystacks: (string | undefined)[]): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return haystacks.some((haystack) => haystack?.toLowerCase().includes(needle));
}

/** Compact token count for the model list (`230000` -> `230k`). */
export function formatTokens(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value < 1000) return String(value);
	const thousands = value / 1000;
	return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}
