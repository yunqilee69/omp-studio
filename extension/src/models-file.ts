import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import type { ProviderView } from "./shared/protocol";
import type { ModelDraft, ProviderDraft } from "./shared/model-drafts";

/**
 * Read and edit `models.yml` without destroying the file's hand-written shape.
 *
 * omp has no CLI command that writes this file (`omp models` only does
 * ls/find/refresh), so the settings page is its only programmatic writer. Two
 * rules keep that safe:
 *
 * 1. Edits go through the `yaml` Document API, which only touches the targeted
 *    nodes. Comments, blank lines and key order survive - verified against this
 *    machine's real `models.yml`, whose Chinese comments must not be lost.
 *    (`js-yaml` round-trips through plain objects and would erase all of it.)
 * 2. Every transform here is a pure string -> string function, so the whole
 *    edit surface is unit-tested without touching a disk.
 *
 * Callers must still validate the result with a real omp before writing it; see
 * `validateModelsFile` in `omp-config.ts` and `SettingsService.saveProvider`.
 */
export class ModelsFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelsFileError";
	}
}

export interface ProvidersRead {
	providers: ProviderView[];
	/** Set when the file exists but does not parse; the page shows it instead of a provider list. */
	error?: string;
}

/** Written when the file does not exist yet. */
export const EMPTY_MODELS_FILE = "# 自定义提供商与模型。由 OMP Studio 设置页写入，也可以直接手改。\nproviders: {}\n";

const PROVIDERS = "providers";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string");
	return items.length > 0 ? items : undefined;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read the provider list. Tolerant on purpose: a broken file is shown as an error, not thrown at the panel. */
export function readProviders(raw: string): ProvidersRead {
	const doc = parseDocument(raw);
	if (doc.errors.length > 0) return { providers: [], error: `models.yml 无法解析：${doc.errors[0].message}` };
	const root = asRecord(doc.toJS());
	const providers = asRecord(root?.[PROVIDERS]);
	if (!providers) return { providers: [] };
	const list: ProviderView[] = [];
	for (const [id, value] of Object.entries(providers)) {
		const entry = asRecord(value);
		if (!entry) continue;
		const models: ProviderView["models"] = [];
		if (Array.isArray(entry.models)) {
			for (const model of entry.models) {
				const record = asRecord(model);
				if (!record || typeof record.id !== "string") continue;
				models.push({
					id: record.id,
					name: typeof record.name === "string" ? record.name : undefined,
					contextWindow: numberOr(record.contextWindow),
					maxTokens: numberOr(record.maxTokens),
					reasoning: typeof record.reasoning === "boolean" ? record.reasoning : undefined,
					thinking: stringArray(record.thinking),
					input: stringArray(record.input),
				});
			}
		}
		const headers = asRecord(entry.headers);
		list.push({
			id,
			baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : undefined,
			api: typeof entry.api === "string" ? entry.api : undefined,
			hasApiKey: typeof entry.apiKey === "string" && entry.apiKey.length > 0,
			headers: headers
				? Object.fromEntries(Object.entries(headers).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
				: undefined,
			models,
		});
	}
	return { providers: list };
}

/** True when the file already defines this provider's key (used to decide whether apiKey is mandatory). */
export function hasProvider(raw: string, id: string): boolean {
	return readProviders(raw).providers.some((provider) => provider.id === id);
}

function parseOrThrow(raw: string): Document {
	const doc = parseDocument(raw);
	// `Document.toString()` throws outright on a parse error, so this must come first.
	if (doc.errors.length > 0) throw new ModelsFileError(`models.yml 无法解析：${doc.errors[0].message}`);
	return doc;
}

function stringify(doc: Document): string {
	// lineWidth 0 = never fold long scalars; the file's own line breaks stay put.
	return doc.toString({ lineWidth: 0 });
}

function ensureProvidersMap(doc: Document): void {
	const existing = doc.get(PROVIDERS, true);
	if (existing === undefined || existing === null) doc.set(PROVIDERS, doc.createNode({}));
}

/**
 * Create or update a provider, field by field.
 *
 * Field-level writes (rather than replacing the provider node) are what keep
 * comments written *inside* a provider block attached to it. Renaming is
 * refused: the id is the map key that comments hang off, so a rename would
 * orphan them - the page deletes and recreates instead.
 */
export function upsertProvider(raw: string, draft: ProviderDraft, originalId?: string): string {
	if (originalId !== undefined && originalId !== draft.id) {
		throw new ModelsFileError("提供商 ID 不可改名：请删除后新建");
	}
	const id = draft.id.trim();
	const doc = parseOrThrow(raw);
	ensureProvidersMap(doc);
	const path = [PROVIDERS, id];
	const isNew = !doc.hasIn(path);
	if (isNew) doc.setIn(path, doc.createNode({}));

	doc.setIn([...path, "baseUrl"], draft.baseUrl.trim());
	doc.setIn([...path, "api"], draft.api.trim());
	if (draft.apiKey !== undefined && draft.apiKey !== "") doc.setIn([...path, "apiKey"], draft.apiKey);
	else if (isNew) throw new ModelsFileError("新提供商必须填 apiKey");

	if (draft.headers !== undefined) {
		const headers = Object.fromEntries(Object.entries(draft.headers).filter(([key]) => key.trim() !== ""));
		if (Object.keys(headers).length > 0) doc.setIn([...path, "headers"], doc.createNode(headers));
		else doc.deleteIn([...path, "headers"]);
	}
	return stringify(doc);
}

export function deleteProvider(raw: string, id: string): string {
	const doc = parseOrThrow(raw);
	if (!doc.hasIn([PROVIDERS, id])) throw new ModelsFileError(`models.yml 里没有提供商 ${id}（可能已被外部修改，请重新读取）`);
	doc.deleteIn([PROVIDERS, id]);
	return stringify(doc);
}

function modelNode(draft: ModelDraft): Record<string, unknown> {
	const node: Record<string, unknown> = { id: draft.id.trim() };
	if (draft.name) node.name = draft.name;
	if (draft.contextWindow !== undefined) node.contextWindow = draft.contextWindow;
	if (draft.maxTokens !== undefined) node.maxTokens = draft.maxTokens;
	if (draft.reasoning !== undefined) node.reasoning = draft.reasoning;
	if (draft.thinking && draft.thinking.length > 0) node.thinking = draft.thinking;
	if (draft.input && draft.input.length > 0) node.input = draft.input;
	return node;
}

const MODEL_FIELDS = ["name", "contextWindow", "maxTokens", "reasoning", "thinking", "input"] as const;

/**
 * Index of a model inside a provider's sequence, by the node API.
 *
 * `doc.getIn(path)` hands back the YAML node rather than a plain array, so the
 * lookup has to walk `seq.items` itself; going through `toJS()` would work too
 * but would not tell us which node to edit.
 */
function findModelIndex(doc: Document, providerId: string, modelId: string): number {
	const seq = doc.getIn([PROVIDERS, providerId, "models"], true);
	if (!isSeq(seq)) return -1;
	return seq.items.findIndex((item) => (isMap(item) ? item.get("id") : undefined) === modelId);
}

/**
 * Create or update one entry of a provider's `models:` list.
 *
 * Updating writes the changed fields in place so a `# 模型列表` comment sitting
 * above the sequence survives; only a brand-new model is appended.
 */
export function upsertModel(raw: string, providerId: string, draft: ModelDraft, originalId?: string): string {
	if (originalId !== undefined && originalId !== draft.id) {
		throw new ModelsFileError("模型 ID 不可改名：请删除后新建");
	}
	const doc = parseOrThrow(raw);
	if (!doc.hasIn([PROVIDERS, providerId])) throw new ModelsFileError(`models.yml 里没有提供商 ${providerId}`);
	const modelsPath = [PROVIDERS, providerId, "models"];
	if (!doc.hasIn(modelsPath)) doc.setIn(modelsPath, doc.createNode([]));

	const index = findModelIndex(doc, providerId, draft.id);
	const node = modelNode(draft);

	if (index < 0) {
		doc.addIn(modelsPath, doc.createNode(node));
		return stringify(doc);
	}
	for (const field of MODEL_FIELDS) {
		const value = node[field];
		if (value === undefined) doc.deleteIn([...modelsPath, index, field]);
		else doc.setIn([...modelsPath, index, field], doc.createNode(value));
	}
	return stringify(doc);
}

export function deleteModel(raw: string, providerId: string, modelId: string): string {
	const doc = parseOrThrow(raw);
	const modelsPath = [PROVIDERS, providerId, "models"];
	const index = findModelIndex(doc, providerId, modelId);
	if (index < 0) throw new ModelsFileError(`${providerId} 里没有模型 ${modelId}（可能已被外部修改，请重新读取）`);
	doc.deleteIn([...modelsPath, index]);
	return stringify(doc);
}

export interface LoadedModelsFile {
	raw: string;
	/** 0 when the file does not exist yet. */
	mtimeMs: number;
	exists: boolean;
}

export async function readModelsFile(path: string): Promise<LoadedModelsFile> {
	try {
		const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		return { raw, mtimeMs: info.mtimeMs, exists: true };
	} catch {
		return { raw: EMPTY_MODELS_FILE, mtimeMs: 0, exists: false };
	}
}

export interface WriteResult {
	/** Absent when there was no previous file to back up. */
	backup?: string;
}

/** Back up the previous file, then write through a temp file + rename so a crash cannot truncate it. */
export async function writeModelsFileAtomic(path: string, raw: string): Promise<WriteResult> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	let backup: string | undefined;
	try {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		backup = `${path}.bak-${stamp}`;
		await copyFile(path, backup);
	} catch {
		backup = undefined;
	}
	const tmp = join(dir, `.models.yml.${process.pid}.tmp`);
	await writeFile(tmp, raw, "utf8");
	await rename(tmp, path);
	return { backup };
}

/** Put a backup back, for when post-write verification fails. */
export async function restoreBackup(backup: string, path: string): Promise<void> {
	await copyFile(backup, path);
}
