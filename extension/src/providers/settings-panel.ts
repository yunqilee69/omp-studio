import * as vscode from "vscode";
import type { HostEnv, HostSettingsWriter } from "../config";
import { SettingsService, type SettingsSink } from "../settings";
import {
	isSettingsWebviewMessage,
	type NoticeLevel,
	type SettingsHostMessage,
	type SettingsSnapshot,
	type SettingsWebviewMessage,
} from "../shared/protocol";
import { contentSecurityPolicy, createNonce } from "./webview-html";

/**
 * The settings page: one editor-area panel, modelled on VS Code's own settings
 * tab, for omp's model configuration.
 *
 * It lives in the editor area rather than the sidebar because the custom-model
 * form has far more fields than a 300-400px column can hold, and because it is
 * not a conversation - it touches no transcript and owns no Instance. The
 * sidebar keeps a single entry point to it (`ompStudio.settings`).
 */
export class SettingsPanel implements SettingsSink, vscode.Disposable {
	static readonly viewType = "ompStudio.settings";

	private panel: vscode.WebviewPanel | undefined;
	private readonly service: SettingsService;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly env: HostEnv,
		hostSettings: HostSettingsWriter,
	) {
		this.service = new SettingsService(env, this, hostSettings);
	}

	/** Single instance: a second invocation reveals the open page instead of opening another. */
	open(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel(SettingsPanel.viewType, "OMP 设置", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
		});
		this.panel = panel;
		panel.webview.html = this.html(panel.webview);
		panel.webview.onDidReceiveMessage((raw: unknown) => {
			if (!isSettingsWebviewMessage(raw)) {
				this.env.logger.warn(`丢弃未知的设置页消息：${JSON.stringify(raw)?.slice(0, 200)}`);
				return;
			}
			return this.handle(raw).catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.env.logger.error(`处理 ${raw.type} 失败：${detail}`);
				this.notice(`操作失败（${raw.type}）：${detail}`, "error");
			});
		});
		// Coming back to a hidden tab should show what is on disk now, not a stale read.
		panel.onDidChangeViewState(() => {
			if (panel.visible) void this.service.refresh();
		});
		panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	// --- SettingsSink ------------------------------------------------------

	snapshot(snapshot: SettingsSnapshot): void {
		this.post({ type: "snapshot", snapshot });
	}

	notice(text: string, level: NoticeLevel, url?: string): void {
		this.post(url === undefined ? { type: "notice", text, level } : { type: "notice", text, level, url });
	}

	busy(busy: boolean, what?: string, ok?: boolean): void {
		this.post({ type: "busy", busy, ...(what === undefined ? {} : { what }), ...(ok === undefined ? {} : { ok }) });
	}

	// --- internals ---------------------------------------------------------

	private post(message: SettingsHostMessage): void {
		void this.panel?.webview.postMessage(message);
	}

	private async handle(message: SettingsWebviewMessage): Promise<void> {
		switch (message.type) {
			case "ready":
			case "refresh":
				await this.service.refresh();
				return;
			case "role/set":
				await this.service.setRole(message.role, message.selector);
				return;
			case "scalar/set":
				await this.service.setScalar(message.key, message.value);
				return;
			case "host-setting/set":
				await this.service.setHostSetting(message.key, message.value);
				return;
			case "provider/save":
				await this.service.saveProvider(message.originalId, message.provider, message.firstModel);
				return;
			case "provider/delete":
				await this.service.removeProvider(message.id);
				return;
			case "model/save":
				await this.service.saveModel(message.providerId, message.originalId, message.model);
				return;
			case "model/delete":
				await this.service.removeModel(message.providerId, message.id);
				return;
			case "file/open":
				await this.openFile(message.path);
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
			this.notice(`打不开 ${path}`, "warn");
		}
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
<title>OMP 设置</title>
</head>
<body class="settings-page">
<div id="settings"></div>
<script nonce="${nonce}" src="${uri("settings.js")}"></script>
</body>
</html>`;
	}
}
