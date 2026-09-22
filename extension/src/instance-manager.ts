import type { HostEnv } from "./config";
import { Emitter } from "./emitter";
import { Instance } from "./instance";
import { readMcp, type McpSnapshot } from "./mcp";
import { readNewSession } from "./new-session";
import { listHistoryEntries } from "./session-picker";
import type { ExtensionUIResponse } from "./rpc/types";
import type { HistoryEntryView, HostToolCallView, Item, NewSessionView, NoticeLevel, UIRequestView, ViewLayer } from "./shared/protocol";

export interface ManagerEvents {
	tabs: void;
	active: void;
	items: { id: string; items: Item[] };
	itemsRemoved: { id: string; keys: string[] };
	reset: { id: string };
	state: { id: string };
	models: { id: string };
	commands: { id: string };
	viewStack: { id: string };
	ui: { id: string; request: UIRequestView | null };
	notice: { text: string; level: NoticeLevel; url?: string };
	hostTool: { id: string; request: HostToolCallView };
	hostUri: { id: string; request: { operation: "read" | "write"; url: string; content?: string } };
}

/**
 * Tab id -> Instance, plus the two invariants the product depends on:
 * one jsonl is open in at most one tab, and closing a tab never touches the others.
 */
export class InstanceManager {
	readonly events = new Emitter<ManagerEvents>();

	private readonly instances = new Map<string, Instance>();
	private readonly owners = new Map<string, string>();
	private readonly unread = new Set<string>();
	private activeId: string | undefined;
	private counter = 0;
	private disposed = false;

	constructor(private readonly env: HostEnv) {
	}

	get active(): Instance | undefined {
		return this.activeId ? this.instances.get(this.activeId) : undefined;
	}

	get activeTabId(): string | undefined {
		return this.activeId;
	}

	has(id: string): boolean {
		return this.instances.has(id);
	}

	get(id: string): Instance | undefined {
		return this.instances.get(id);
	}

	get all(): Instance[] {
		return [...this.instances.values()];
	}

	get runningCount(): number {
		return this.all.filter((instance) => instance.phase !== "failed" && instance.phase !== "gone").length;
	}

	/** Start a tab. Returns undefined only when the requested session is already open. */
	async create(options: { resumeFile?: string } = {}): Promise<Instance | undefined> {
		if (this.disposed) return undefined;
		const owner = options.resumeFile ? this.owners.get(options.resumeFile) : undefined;
		if (owner) {
			// AGENTS.md: two tabs must never write one jsonl. Never spawn a second
			// process for a file another tab already owns - just surface that tab.
			this.events.emit("notice", {
				text: `该会话已在 Tab「${this.instances.get(owner)?.title ?? owner}」打开，禁止同一 jsonl 双开`,
				level: "warn",
			});
			this.select(owner);
			return undefined;
		}
		if (this.runningCount >= this.env.maxInstances) {
			this.events.emit("notice", {
				text: `已有 ${this.runningCount} 个运行中的实例（软上限 ${this.env.maxInstances}，可在设置页「扩展」里改）。继续会增加 CPU 与费用。`,
				level: "warn",
			});
		}

		const id = `tab-${++this.counter}`;
		const instance = new Instance(this.env, { id, cwd: this.env.workspaceRoot, resumeFile: options.resumeFile });
		this.instances.set(id, instance);
		if (options.resumeFile) this.owners.set(options.resumeFile, id);

		instance.events.on("items", (items) => this.events.emit("items", { id, items }));
		instance.events.on("itemsRemoved", (keys) => this.events.emit("itemsRemoved", { id, keys }));
		instance.events.on("transcriptReplaced", () => this.events.emit("reset", { id }));
		instance.events.on("state", () => {
			this.registerOwnership(instance);
			this.events.emit("state", { id });
			this.events.emit("tabs");
		});
		instance.events.on("models", () => this.events.emit("models", { id }));
		instance.events.on("commands", () => this.events.emit("commands", { id }));
		instance.events.on("viewStack", () => this.events.emit("viewStack", { id }));
		instance.events.on("tabs", () => this.events.emit("tabs"));
		instance.events.on("ui", (request) => this.events.emit("ui", { id, request }));
		instance.events.on("hostTool", (request) => this.events.emit("hostTool", { id, request }));
		instance.events.on("hostUri", (request) => this.events.emit("hostUri", { id, request }));		instance.events.on("notice", (notice) => this.events.emit("notice", notice));
		instance.events.on("runFinished", () => {
			if (this.activeId !== id) this.unread.add(id);
			this.events.emit("tabs");
		});
		instance.events.on("exited", () => {
			this.events.emit("tabs");
			this.events.emit("state", { id });
		});

		this.select(id);
		await instance.start();
		this.registerOwnership(instance);
		this.events.emit("tabs");
		return instance;
	}

	private registerOwnership(instance: Instance): void {
		// A closed instance keeps emitting `state` while it disposes, and that must not
		// re-claim its file: a stale owner makes the history picker show a dead session as
		// 运行中 and refuse to resume it (`create` sees an owner, `select` finds no instance).
		if (!this.instances.has(instance.id)) return;
		const file = instance.sessionFile;
		if (!file || this.owners.get(file) === instance.id) return;
		const previous = this.owners.get(file);
		if (previous && previous !== instance.id) {
			this.events.emit("notice", { text: `${file} 已被 Tab ${previous} 占用`, level: "warn" });
			return;
		}
		this.owners.set(file, instance.id);
	}

	select(id: string): void {
		if (!this.instances.has(id)) return;
		this.activeId = id;
		this.unread.delete(id);
		this.events.emit("active");
		this.events.emit("tabs");
	}

	/** AGENTS.md lock: can `selfId` point its process at `path` without double-owning a jsonl? */
	canOpenSessionFile(path: string, selfId: string): boolean {
		const owner = this.owners.get(path);
		return owner === undefined || owner === selfId;
	}

	/** Re-claim ownership after a switch_session/new_session swapped the tab's jsonl. */
	reclaimOwnership(instance: Instance, previousFile: string | undefined): void {
		if (previousFile && this.owners.get(previousFile) === instance.id) this.owners.delete(previousFile);
		this.registerOwnership(instance);
	}

	async close(id: string): Promise<void> {
		const instance = this.instances.get(id);
		if (!instance) return;
		this.instances.delete(id);
		this.unread.delete(id);
		for (const [file, owner] of this.owners) if (owner === id) this.owners.delete(file);

		const remaining = [...this.instances.keys()];
		if (this.activeId === id) {
			this.activeId = remaining[remaining.length - 1];
			this.events.emit("active");
		}
		this.events.emit("tabs");
		await instance.dispose();
	}

	/** Tab ids that may be shown as occupied in the history picker. */
	ownerOf(file: string): string | undefined {
		return this.owners.get(file);
	}

	async history(): Promise<HistoryEntryView[]> {
		return listHistoryEntries(this.env.workspaceRoot, this.env.homeDir, (file) => this.ownerOf(file));
	}

	/** Defaults + catalog for the sessions-list composer, which has no instance to ask. */
	async newSession(): Promise<NewSessionView> {
		return readNewSession(this.env);
	}

	async mcp(): Promise<McpSnapshot> {
		return readMcp(this.env.workspaceRoot, this.env.homeDir);
	}

	/**
	 * Enable/disable through omp's own `/mcp` slash command, which rewrites the
	 * owning mcp.json (omp remains the only writer). The running process already
	 * loaded its servers, so the change lands on the next tab.
	 */
	async toggleMcp(name: string, enabled: boolean): Promise<void> {
		const instance = this.active;
		if (!instance) {
			this.events.emit("notice", { text: "没有可用的 Tab，先新建一个实例", level: "warn" });
			return;
		}
		await instance.sendPrompt(`/mcp ${enabled ? "enable" : "disable"} ${name}`);
		this.events.emit("notice", {
			text: `${name} 已${enabled ? "启用" : "禁用"}；当前实例仍用启动时加载的 MCP，重开 Tab 后生效`,
			level: "info",
		});
	}

	async loadSubagentView(id: string, subagentId: string): Promise<void> {
		const instance = this.instances.get(id);
		if (!instance) return;
		await instance.openSubagent(subagentId);
	}

	async loadPlanView(id: string): Promise<void> {
		const instance = this.instances.get(id);
		if (!instance) return;
		await instance.openPlan();
	}

	respondUI(id: string, response: ExtensionUIResponse): void {
		this.instances.get(id)?.respondUI(response);
	}

	viewStack(id: string): ViewLayer[] {
		return this.instances.get(id)?.viewStack ?? [];
	}

	getTabs(): { id: string; summary: ReturnType<Instance["tabSummary"]> }[] {
		return this.all.map((instance) => ({ id: instance.id, summary: instance.tabSummary(this.unread.has(instance.id)) }));
	}

	/** Graceful teardown: every process gets to drain and exit. */
	async disposeAll(): Promise<void> {
		this.disposed = true;
		const instances = this.all;
		this.instances.clear();
		this.owners.clear();
		this.unread.clear();
		this.activeId = undefined;
		await Promise.all(instances.map((instance) => instance.dispose()));
		this.events.emit("tabs");
		this.events.emit("active");
	}

	/** Synchronous teardown for `deactivate`, where nothing can be awaited. */
	killAll(): void {
		this.disposed = true;
		for (const instance of this.all) instance.kill();
		this.instances.clear();
		this.owners.clear();
	}
}
