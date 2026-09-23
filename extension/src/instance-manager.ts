import type { HostEnv } from "./config";
import { Emitter } from "./emitter";
import { Instance } from "./instance";
import { readMcp, type McpSnapshot } from "./mcp";
import { readNewSession } from "./new-session";
import { listHistoryEntries } from "./session-picker";
import { modeRefusal } from "./mode";
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
	async create(options: { resumeFile?: string; planYolo?: { into?: string } } = {}): Promise<Instance | undefined> {
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
		const instance = new Instance(this.env, {
			id,
			cwd: this.env.workspaceRoot,
			resumeFile: options.resumeFile,
			planYolo: options.planYolo,
		});
		this.instances.set(id, instance);
		if (options.resumeFile) this.owners.set(options.resumeFile, id);

		this.wire(instance);

		this.select(id);
		await instance.start();
		this.registerOwnership(instance);
		this.events.emit("tabs");
		return instance;
	}

	/**
	 * Forward one tab's instance events. `live()` is what keeps a replaced process from
	 * speaking for its tab while it shuts down (`restartAs` swaps the object under the same
	 * id) and keeps a closed tab from repainting a ghost transcript.
	 */
	private wire(instance: Instance): void {
		const id = instance.id;
		const live = () => this.instances.get(id) === instance;
		instance.events.on("items", (items) => {
			if (live()) this.events.emit("items", { id, items });
		});
		instance.events.on("itemsRemoved", (keys) => {
			if (live()) this.events.emit("itemsRemoved", { id, keys });
		});
		instance.events.on("transcriptReplaced", () => {
			if (live()) this.events.emit("reset", { id });
		});
		instance.events.on("state", () => {
			if (!live()) return;
			this.registerOwnership(instance);
			this.events.emit("state", { id });
			this.events.emit("tabs");
		});
		instance.events.on("models", () => {
			if (live()) this.events.emit("models", { id });
		});
		instance.events.on("commands", () => {
			if (live()) this.events.emit("commands", { id });
		});
		instance.events.on("viewStack", () => {
			if (live()) this.events.emit("viewStack", { id });
		});
		instance.events.on("tabs", () => {
			if (live()) this.events.emit("tabs");
		});
		instance.events.on("ui", (request) => {
			// The tab badge says "waiting for you"; it is a property of the tab, so the
			// row has to be repainted whenever a question appears or is answered.
			if (!live()) return;
			this.events.emit("ui", { id, request });
			this.events.emit("tabs");
		});
		instance.events.on("hostTool", (request) => {
			if (live()) this.events.emit("hostTool", { id, request });
		});
		instance.events.on("hostUri", (request) => {
			if (live()) this.events.emit("hostUri", { id, request });
		});
		instance.events.on("notice", (notice) => {
			if (live()) this.events.emit("notice", notice);
		});
		instance.events.on("runFinished", () => {
			if (!live()) return;
			if (this.activeId !== id) this.unread.add(id);
			this.events.emit("tabs");
		});
		instance.events.on("exited", () => {
			if (!live()) return;
			this.events.emit("tabs");
			this.events.emit("state", { id });
		});
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

	/**
	 * Switch the active tab's mode, the honest way only: in place when omp's RPC carries
	 * modes (docs/upstream-issues.md U2), by restarting the tab's process on the same
	 * session file when the target is a mode omp has a headless entry point for (Plan,
	 * `--plan-yolo`, and the way back to Agent), and otherwise by saying exactly why
	 * nothing happened.
	 */
	async setMode(mode: string): Promise<void> {
		const instance = this.active;
		if (!instance) {
			this.events.emit("notice", { text: "没有可用的 Tab，先新建一个实例", level: "warn" });
			return;
		}
		if (await instance.setMode(mode)) return;
		const wantsPlan = mode === "plan" && !instance.modeSurface.planYolo;
		// Agent is the spawn default, so it is only worth a restart for a tab whose process
		// was launched with `--plan-yolo` and is still in that phase.
		const leavesPlan = mode === "none" && instance.modeSurface.planYolo;
		if (leavesPlan && instance.canRestartProcess() === false && instance.canLeavePlan()) {
			// A plan-yolo auto-approve turn can run for minutes; leaving Plan may not wait
			// for it. Abort the turn (finished steps stay in the jsonl), then swap.
			await instance.abort();
			await this.restartAs(instance.id, false);
			return;
		}
		if ((wantsPlan || leavesPlan) && instance.canRestartProcess()) {
			await this.restartAs(instance.id, wantsPlan);
			return;
		}
		this.events.emit("notice", { text: modeRefusal(instance.modeSurface, mode), level: "warn" });
	}

	/**
	 * Real mode change for an omp whose RPC has no mode (U2): swap the process behind the tab
	 * and resume the same jsonl, with `--plan-yolo` for Plan (omp's own headless plan flow,
	 * which approves and implements the plan itself) and without it to leave Plan again.
	 *
	 * The tab keeps its id. A tab is the conversation the user is reading; the process is an
	 * implementation detail. A fresh id would look like another tab and make the webview
	 * swap conversations out from under the user (dev-plan §2.2).
	 */
	private async restartAs(id: string, plan: boolean): Promise<void> {
		const current = this.instances.get(id);
		const file = current?.sessionFile;
		if (!current || !file) return;
		if (!current.canRestartProcess()) {
			this.events.emit("notice", { text: modeRefusal(current.modeSurface, plan ? "plan" : "none"), level: "warn" });
			return;
		}
		const into = plan ? current.modelSelector : undefined;
		const next = new Instance(this.env, {
			id,
			cwd: this.env.workspaceRoot,
			resumeFile: file,
			planYolo: plan ? { into } : undefined,
		});
		// The tab claims the new process before the old one is torn down: the dead process's
		// last frames must not reach the sidebar as the new tab's, and the jsonl stays owned
		// by this tab throughout, with no window where another tab could resume it.
		this.instances.set(id, next);
		this.owners.set(file, id);
		this.wire(next);
		await current.dispose();
		await next.start();
		this.registerOwnership(next);
		this.events.emit("tabs");
		this.events.emit("state", { id });
		if (next.phase === "failed") return;
		this.events.emit("notice", {
			text: plan
				? `已把会话重启为 Plan（omp --plan-yolo）：下一轮先只读起草计划，计划就绪后 omp 自动批准并用 ${into ?? "默认模型"} 继续实施。`
				: "已把会话重启为 Agent（撤掉 --plan-yolo）：同一份 jsonl 照常继续，计划草稿还在原会话里。",
			level: "info",
		});
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
