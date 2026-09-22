import * as vscode from "vscode";
import type { HostEnv } from "../config";
import type { Instance } from "../instance";
import { InstanceManager } from "../instance-manager";
import { isWebviewMessage, type HostMessage, type WebviewMessage } from "../shared/protocol";

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

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly manager: InstanceManager,
		private readonly env: HostEnv,
	) {
		manager.events.on("tabs", () => this.post({ type: "tabs", tabs: this.tabs(), activeId: manager.activeTabId }));
		manager.events.on("active", () => this.pushSession());
		manager.events.on("items", ({ id, items }) => this.post({ type: "items", id, items }));
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
		manager.events.on("viewStack", ({ id }) => {
			if (id === manager.activeTabId) this.post({ type: "stack", id, stack: [...this.manager.viewStack(id)] });
		});
		manager.events.on("ui", ({ id, request }) => this.post({ type: "ui", id, request }));
		manager.events.on("notice", ({ text, level, url }) =>
			this.post(url === undefined ? { type: "notice", text, level } : { type: "notice", text, level, url }),
		);
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

	/** Entry point for the `ompStudio.openSession` command. */
	async showHistory(): Promise<void> {
		this.reveal();
		await this.pushHistory();
	}

	private tabs() {
		return this.manager.getTabs().map((entry) => entry.summary);
	}

	private post(message: HostMessage): void {
		void this.view?.webview.postMessage(message);
	}

	/** Everything the webview needs to render one tab from scratch. */
	private pushSession(): void {
		const instance = this.manager.active;
		if (!instance) {
			this.post({ type: "tabs", tabs: this.tabs(), activeId: undefined });
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
			case "ready":
				this.post({ type: "tabs", tabs: this.tabs(), activeId: this.manager.activeTabId });
				this.pushSession();
				await this.pushMcp();
				await this.pushHistory();
				return;
			case "tab/new": {
				const instance = await this.manager.create();
				if (!instance) return;
				this.pushSession();
				return;
			}
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
				await active?.sendPrompt(message.text, message.behavior);
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
			case "file/open":
				await this.openFile(message.path);
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

	private html(webview: vscode.Webview): string {
		const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", name));
		const nonce = createNonce();
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

function createNonce(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let nonce = "";
	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return nonce;
}
