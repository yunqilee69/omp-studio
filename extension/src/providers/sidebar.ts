import * as vscode from "vscode";
import type { HostEnv } from "../config";
import type { Instance } from "../instance";
import { InstanceManager } from "../instance-manager";
import { isWebviewMessage, type HostMessage, type ListPrefs, type NewSessionView, type WebviewMessage } from "../shared/protocol";
import type { SteeringMode, InterruptMode } from "../rpc/types";
import { contentSecurityPolicy, createNonce } from "./webview-html";
import { SidebarPrefsStore } from "./prefs-store";

/**
 * Sidebar webview host.
 *
 * The provider owns no agent state; it routes `WebviewMessage` into the manager
 * and re-emits manager events as `HostMessage`. Anything the webview shows for the
 * active tab is pushed as a full `session` message, so the two sides can never
 * disagree about a tab's transcript.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "ompStudio.sidebar";

	private view: vscode.WebviewView | undefined;
	private workspaceFilesWatchers: vscode.FileSystemWatcher[] = [];
	private workspaceFilesTimer: NodeJS.Timeout | undefined;
	/** One `omp models ls` in flight at a time: the model pill's retry must not stack reads. */
	private newSessionRead: Promise<NewSessionView> | undefined;
	/** Last composer defaults: whatever the entry page showed is what `--plan-yolo` pins. */
	private newSessionView: NewSessionView | undefined;
	/**
	 * Where the sessions list's view preferences live across restarts: our own JSON file
	 * under the workspace's storage folder. Not `workspaceState` - this VS Code build never
	 * flushes extension mementos to disk, so anything handed to it evaporates on restart,
	 * which is exactly what happened to archives. See `SidebarPrefsStore`.
	 */
	private readonly prefsStore: SidebarPrefsStore;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly manager: InstanceManager,
		private readonly env: HostEnv,
		storageUri: vscode.Uri,
	) {
		this.prefsStore = new SidebarPrefsStore(vscode.Uri.joinPath(storageUri, "session-list-prefs.json").fsPath);
		manager.events.on("tabs", () => this.post({ type: "tabs", tabs: this.tabs(), activeId: manager.activeTabId }));
		manager.events.on("active", () => this.pushSession());
		manager.events.on("items", ({ id, items }) => {
			// `close` removes the instance from the map before `dispose` settles;
			// its trailing `items` would otherwise repaint the ghost transcript.
			if (!this.manager.has(id)) return;
			this.post({ type: "items", id, items });
		});
		manager.events.on("itemsRemoved", ({ id, keys }) => {
			if (!this.manager.has(id)) return;
			this.post({ type: "itemsRemoved", id, keys });
		});
		manager.events.on("reset", ({ id }) => {
			if (id === manager.activeTabId) this.pushSession();
		});
		manager.events.on("state", ({ id }) => {
			const instance = manager.all.find((candidate) => candidate.id === id);
			if (instance) this.post({ type: "state", id, state: instance.state() });
		});
		manager.events.on("models", ({ id }) => {
			const instance = manager.all.find((candidate) => candidate.id === id);
			if (instance) this.postModels(instance);
		});
		manager.events.on("commands", ({ id }) => {
			const instance = manager.all.find((candidate) => candidate.id === id);
			if (instance) this.post({ type: "commands", id, commands: instance.commands });
		});
		manager.events.on("viewStack", ({ id }) => {
			if (id === manager.activeTabId) this.post({ type: "stack", id, stack: [...this.manager.viewStack(id)] });
		});
		manager.events.on("ui", ({ id, request }) => {
			if (!this.manager.has(id)) return;
			// A question omp is blocked on belongs to its own tab. When it arrives in a
			// background tab there is nothing to draw yet, so say it out loud: the tab
			// badge alone is easy to miss, and omp waits indefinitely (ask.timeout 0).
			if (request && id !== this.manager.activeTabId) {
				const title = this.manager.getTabs().find((entry) => entry.summary.id === id)?.summary.title;
				this.post({ type: "notice", text: `「${title ?? id}」在等你的回答`, level: "warn" });
			}
			this.post({ type: "ui", id, request });
		});
		manager.events.on("notice", ({ text, level, url }) =>
			this.post(url === undefined ? { type: "notice", text, level } : { type: "notice", text, level, url }),
		);
		// Workspace folders change via multi-root workspaces and .code-workspace files.
		vscode.workspace.onDidChangeWorkspaceFolders(() => void this.pushWorkspaceFiles());
		this.workspaceFilesWatchers = vscode.workspace.workspaceFolders?.map((folder) =>
			vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder, "**"),
				false,
				true,
				false,
			),
		) ?? [];
		for (const watcher of this.workspaceFilesWatchers) {
			watcher.onDidCreate(() => void this.pushWorkspaceFiles());
			watcher.onDidDelete(() => void this.pushWorkspaceFiles());
		}
		manager.events.on("hostTool", ({ id, request }) => {
			if (!this.manager.has(id)) return;
			this.post({ type: "host/tool-call", id, request });
		});
		manager.events.on("hostUri", ({ id, request }) => {
			if (!this.manager.has(id)) return;
			this.post({ type: "host/uri-request", id, operation: request.operation, url: request.url, content: request.content });
		});
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((raw: unknown) => {
			if (!isWebviewMessage(raw)) {
				this.env.logger.warn(`丢弃未知的 webview 消息：${JSON.stringify(raw)?.slice(0, 200)}`);
				return;
			}
			return this.handle(raw).catch((error: unknown) => {
				// A tab can be disposed mid-request; never let that become an
				// unhandled rejection - surface it and keep the panel alive.
				const detail = error instanceof Error ? error.message : String(error);
				this.env.logger.error(`处理 ${raw.type} 失败：${detail}`);
				this.post({ type: "notice", text: `操作失败（${raw.type}）：${detail}`, level: "error" });
			});
		});
		view.onDidDispose(() => {
			this.view = undefined;
		});
	}

	reveal(): void {
		void vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
	}

	/** Entry point for the `ompStudio.openSession` command: the list, filter field focused. */
	async showHistory(): Promise<void> {
		this.reveal();
		this.post({ type: "sessions/open" });
		this.post({ type: "history/open" });
		await this.pushHistory();
	}

	/** Entry point for the `ompStudio.newInstance` command: a blank instance, visible in the list. */
	async newInstance(): Promise<void> {
		this.reveal();
		await this.manager.create();
		this.post({ type: "sessions/open" });
	}

	/**
	 * Entry point for the `ompStudio.sessionMenu` command. The command is registered but not
	 * contributed, so nothing in the UI calls this today - it is kept so the session menu
	 * overlay stays reachable whenever an entry point is added back.
	 */
	showSessionMenu(): void {
		this.reveal();
		this.post({ type: "session-menu/open" });
	}

	private tabs() {
		return this.manager.getTabs().map((entry) => entry.summary);
	}

	/** The stored preferences, with defaults for the first run ever. */
	private listPrefs(): Promise<ListPrefs> {
		return this.prefsStore.load();
	}

	private post(message: HostMessage): void {
		void this.view?.webview.postMessage(message);
	}

	/** Everything the webview needs to render one tab from scratch. */
	private pushSession(): void {
		const instance = this.manager.active;
		if (!instance) {
			// Empty tabs alone would leave the webview painting the closed tab's
			// transcript: the body must also receive the empty session snapshot.
			this.post({ type: "tabs", tabs: this.tabs(), activeId: undefined });
			this.post({ type: "session" });
			return;
		}
		this.post({
			type: "session",
			id: instance.id,
			state: instance.state(),
			stack: instance.viewStack.map((layer) => ({ ...layer })),
			items: [...instance.transcript.items],
			models: instance.models,
			commands: instance.commands,
		});
		this.postModels(instance);
		this.post({ type: "commands", id: instance.id, commands: instance.commands });
		// A tab can be selected while its omp is still waiting on a question: the panel
		// is part of the session, so it comes back with it (null clears the stale one).
		this.post({ type: "ui", id: instance.id, request: instance.currentUI ?? null });
	}

	private postModels(instance: Instance): void {
		const state = instance.state();
		this.post({
			type: "models",
			id: instance.id,
			models: instance.models,
			loading: state.modelsLoading,
			error: state.modelsError,
		});
	}

	private async pushHistory(): Promise<void> {
		this.post({ type: "history", entries: await this.manager.history() });
	}

	/**
	 * Defaults + model catalog for the sessions-list composer. The webview asks for this
	 * once on ready and again only when the user retries an empty picker.
	 */
	private async pushNewSession(): Promise<void> {
		const read = (this.newSessionRead ??= this.manager.newSession());
		try {
			const view = await read;
			this.newSessionView = view;
			this.post({ type: "new-session", view });
		} finally {
			if (this.newSessionRead === read) this.newSessionRead = undefined;
		}
	}

	private async pushLoginProviders(): Promise<void> {
		const active = this.manager.active;
		const providers = (await active?.getLoginProviders()) ?? [];
		this.post({ type: "login/providers", providers });
	}

	/** RPC `bash` runs inside the omp process; surface the output in the editor terminal. */
	private async runBashInTerminal(command: string): Promise<void> {
		const active = this.manager.active;
		if (!active) return;
		const result = await active.runBash(command);
		if (!result) return;
		const terminal = vscode.window.createTerminal({ name: `omp: ${command.slice(0, 40)}`, cwd: active.cwd });
		terminal.show();
		terminal.sendText(command);
		const status = result.exitCode === undefined ? "" : `（exit ${result.exitCode}）`;
		this.post({
			type: "notice",
			text: `已在新终端执行：${command}${status}${result.output ? `\n${result.output.slice(0, 800)}` : ""}`,
			level: result.exitCode === 0 || result.exitCode === undefined ? "info" : "warn",
		});
	}

	private async pushMcp(): Promise<void> {
		const snapshot = await this.manager.mcp();
		const missing = snapshot.sources.filter((source) => !source.exists).map((source) => source.path);
		this.post({
			type: "mcp",
			servers: snapshot.servers,
			note: snapshot.servers.length === 0 ? `没有配置 MCP（未找到 ${missing.join("、")}）` : undefined,
		});
	}

	private async handle(message: WebviewMessage): Promise<void> {
		const active = this.manager.active;
		switch (message.type) {
			case "list/prefs":
				await this.prefsStore.save(message.prefs);
				return;
			case "ready": {
				// Preferences first: postMessage preserves order, so the webview's first
				// paint of the list already carries pins/archives/panel state.
				this.post({ type: "list/prefs", prefs: await this.listPrefs() });
				this.post({ type: "tabs", tabs: this.tabs(), activeId: this.manager.activeTabId });
				this.pushSession();
				await this.pushMcp();
				await this.pushHistory();
				await this.pushNewSession();
				await this.pushWorkspaceFiles();
				return;
			}
			case "session/create-and-send": {
				// The list composer's send: one step, new instance + this prompt, started with
				// whatever the pills showed (dev-plan §1.3). Plan cannot be switched on inside a
				// running omp, so it rides on this spawn (`--plan-yolo`, U2) and pins the model
				// the composer displayed. Agent is the spawn default, so it needs nothing;
				// Goal/Vibe go through the manager, which refuses them out loud.
				const model = message.model ?? this.newSessionView?.model;
				const into = model ? `${model.provider}/${model.id}` : undefined;
				const instance = await this.manager.create({
					planYolo: message.mode === "plan" ? { into } : undefined,
				});
				if (!instance) return;
				if (message.mode && message.mode !== "plan" && message.mode !== "none") await this.manager.setMode(message.mode);
				if (message.model) await instance.setModel(message.model.provider, message.model.id);
				if (message.thinking) await instance.setThinking(message.thinking);
				await instance.sendPrompt(message.text, undefined, message.attachments);
				return;
			}
			case "new-session/refresh":
				await this.pushNewSession();
				return;
			case "tab/select":
				this.manager.select(message.id);
				this.pushSession();
				return;
			case "tab/close":
				await this.manager.close(message.id);
				this.pushSession();
				return;
			case "tab/open-history":
				await this.manager.create({ resumeFile: message.file });
				this.pushSession();
				return;
			case "history/refresh":
				await this.pushHistory();
				return;
			case "prompt/send":
				await active?.sendPrompt(message.text, message.behavior, message.attachments);
				return;
			case "prompt/update":
				active?.updatePendingPrompt(message.id, message.text);
				return;
			case "prompt/cancel":
				active?.cancelPendingPrompt(message.id);
				return;
			case "prompt/send-now":
				await active?.sendPendingNow(message.id);
				return;
			case "prompt/abort":
				await active?.abort();
				return;
			case "model/set":
				await active?.setModel(message.provider, message.id);
				if (active) this.postModels(active);
				return;
			case "models/refresh":
				await active?.refreshModels();
				if (active) this.postModels(active);
				return;
			case "thinking/cycle":
				await active?.cycleThinking();
				return;
			case "thinking/set":
				await active?.setThinking(message.level);
				return;
			case "mode/set":
				// The manager owns the decision: switch in place, restart as Plan, or refuse out loud.
				await this.manager.setMode(message.mode);
				return;
			case "attachments/pick":
				await this.pickImages();
				return;
			case "session/fast-mode":
				await active?.setFastMode(message.enabled);
				return;
			case "session/queue-mode":
				if (message.kind === "steering") await active?.setSteeringMode(message.mode as SteeringMode);
				else if (message.kind === "followUp") await active?.setFollowUpMode(message.mode as SteeringMode);
				else await active?.setInterruptMode(message.mode as InterruptMode);
				return;
			case "session/auto-compaction":
				await active?.setAutoCompaction(message.enabled);
				return;
			case "session/auto-retry":
				await active?.setAutoRetry(message.enabled);
				return;
			case "session/abort-retry":
				await active?.abortRetry();
				return;
			case "session/compact":
				await active?.compact(message.instructions);
				return;
			case "session/rename":
				await this.manager.get(message.id)?.renameSession(message.name);
				return;
			case "session/new":
				if (active) {
					const previousFile = active.sessionFile;
					await active.newSession();
					this.manager.reclaimOwnership(active, previousFile);
				}
				return;
			case "session/switch":
				if (active) {
					const previousFile = active.sessionFile;
					const switched = await active.switchSession(message.sessionPath, (path, selfId) =>
						this.manager.canOpenSessionFile(path, selfId),
					);
					if (switched) this.manager.reclaimOwnership(active, previousFile);
				}
				return;
			case "session/branch":
				if (active) {
					const previousFile = active.sessionFile;
					await active.branchSession(message.entryId);
					this.manager.reclaimOwnership(active, previousFile);
				}
				return;
			case "session/branch-points":
				if (active) {
					const points = await active.getBranchMessages();
					this.post({ type: "session/branch-points", id: active.id, points });
				}
				return;
			case "session/export-html":
				if (active) {
					const path = await active.exportHtml();
					if (path) await this.openFile(path);
				}
				return;
			case "session/handoff":
				await active?.handoff(message.instructions);
				return;
			case "session/stats":
				if (active) {
					const stats = await active.refreshStats();
					this.post({ type: "session/stats", id: active.id, stats: stats ?? null });
				}
				return;
			case "session/last-text":
				if (active) {
					const text = await active.getLastAssistantText();
					if (text) await vscode.env.clipboard.writeText(text);
					this.post({ type: "notice", text: text ? "已复制最后回复" : "还没有助手回复", level: "info" });
				}
				return;
			case "session/bash":
				await this.runBashInTerminal(message.command);
				return;
			case "login/refresh":
				await this.pushLoginProviders();
				return;
			case "login/start":
				await active?.login(message.providerId);
				await this.pushLoginProviders();
				return;
			case "todos/set":
				await active?.setTodos(message.phases);
				return;
			case "host/tool-respond":
				if (active) {
					active.respondHostTool(message.id, {
						content: message.result.content.map((part) =>
							part.type === "text"
								? { type: "text" as const, text: part.text }
								: { type: "image" as const, data: part.data, mimeType: part.mimeType },
						),
						isError: message.result.isError,
					});
				}
				return;
			case "host/uri-respond":
				active?.respondHostUri(message.id, message.result);
				return;
			case "view/open-subagent":
				if (active) await this.manager.loadSubagentView(active.id, message.id);
				return;
			case "view/open-plan":
				if (active) await this.manager.loadPlanView(active.id);
				return;
			case "view/back":
				active?.popView();
				return;
			case "ui/respond":
				if (active) this.manager.respondUI(active.id, message.response);
				return;
			case "mcp/refresh":
				await this.pushMcp();
				return;
			case "mcp/toggle":
				await this.manager.toggleMcp(message.name, message.enabled);
				await this.pushMcp();
				return;
			case "mcp/open-file":
				await this.openFile(message.path);
				return;
			case "workspace/files/refresh":
				await this.pushWorkspaceFiles();
				return;
			case "file/open":
				await this.openFile(message.path);
				return;
			case "clipboard/write":
				await vscode.env.clipboard.writeText(message.text);
				return;
			case "link/open":
				await vscode.env.openExternal(vscode.Uri.parse(message.url));
				return;
			default:
				return;
		}
	}

	private async openFile(path: string): Promise<void> {
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
			await vscode.window.showTextDocument(document, { preview: true });
		} catch (error) {
			this.env.logger.warn(`打开文件失败 ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** File picker for image attachments; results go back as base64 attachments. */
	private async pickImages(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			filters: { 图片: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
			openLabel: "添加图片",
		});
		if (!uris || uris.length === 0 || !this.view) return;
		const attachments = [];
		for (const uri of uris) {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				attachments.push({
					name: uri.path.split("/").pop() ?? uri.path,
					data: Buffer.from(bytes).toString("base64"),
					mimeType: imageMime(uri.path),
				});
			} catch (error) {
				this.env.logger.warn(
					`读取附件失败 ${uri.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		// `id` stays undefined when nothing is active: those images belong to the
		// sessions-list composer, which the webview knows it is showing.
		this.post({ type: "attachments/added", id: this.manager.activeTabId, attachments });
	}

	/** Relative paths of workspace files, for the webview's `@` completion. */
	private async pushWorkspaceFiles(): Promise<void> {
		// Create/delete storms (git checkout, builds) must collapse into one scan.
		clearTimeout(this.workspaceFilesTimer);
		await new Promise<void>((resolve) => {
			this.workspaceFilesTimer = setTimeout(resolve, 500);
		});
		const excludes = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**}";
		const uris = await vscode.workspace.findFiles("**/*", excludes, 2000);
		const files = uris
			.map((uri) => {
				const folder = vscode.workspace.getWorkspaceFolder(uri);
				return folder ? vscode.workspace.asRelativePath(uri, false) : undefined;
			})
			.filter((path): path is string => path !== undefined)
			.sort();
		this.post({ type: "workspace/files", files });
	}

	private html(webview: vscode.Webview): string {
		const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", name));
		const nonce = createNonce();
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri("webview.css")}">
<title>OMP Studio</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri("webview.js")}"></script>
</body>
</html>`;
	}
}

function imageMime(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	switch (extension) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "bmp":
			return "image/bmp";
		default:
			return "image/png";
	}
}
