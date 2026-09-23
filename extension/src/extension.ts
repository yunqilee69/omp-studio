import { homedir } from "node:os";
import * as vscode from "vscode";
import type { ApprovalMode, HostEnv, HostSettingsWriter, Logger } from "./config";
import { diagnose } from "./diagnose";
import { InstanceManager } from "./instance-manager";
import { SidebarProvider } from "./providers/sidebar";
import { SettingsPanel } from "./providers/settings-panel";

let manager: InstanceManager | undefined;
let output: vscode.OutputChannel | undefined;

const SECTION = "ompStudio";
/** Mirrors the schema default in `contributes.configuration` (extension/package.json). */
const MAX_INSTANCES_FALLBACK = 4;

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel("OMP Studio");
	const logger: Logger = {
		info: (message) => output?.appendLine(message),
		warn: (message) => output?.appendLine(`[warn] ${message}`),
		error: (message) => output?.appendLine(`[error] ${message}`),
	};

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		logger.warn("没有打开工作区，OMP Studio 不会启动实例");
	}

	const env: HostEnv = {
		ompPath: readSetting("ompPath", "omp"),
		workspaceRoot: workspaceRoot ?? homedir(),
		// A getter over VS Code configuration, not a snapshot: the settings page can raise
		// this while instances are already running, and the soft-cap warning is checked
		// against the value in force at that moment.
		get maxInstances() {
			return readSetting("maxInstances", MAX_INSTANCES_FALLBACK);
		},
		approvalMode: readSetting<ApprovalMode>("approvalMode", "inherit"),
		homeDir: homedir(),
		logger,
	};

	const hostSettings: HostSettingsWriter = {
		async set(key, value) {
			await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
			// A workspace or folder override beats a global write, and `getConfiguration()`
			// hands back a snapshot taken before the write: re-read so the caller can report
			// what is actually in force.
			const effective = vscode.workspace.getConfiguration(SECTION).get<number>(key);
			return typeof effective === "number" ? effective : value;
		},
	};

	const instanceManager = new InstanceManager(env);
	manager = instanceManager;
	const provider = new SidebarProvider(context.extensionUri, instanceManager, env, context.workspaceState);
	const settingsPanel = new SettingsPanel(context.extensionUri, env, hostSettings);

	context.subscriptions.push(
		output,
		settingsPanel,
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("ompStudio.newInstance", async () => {
			await provider.newInstance();
		}),
		vscode.commands.registerCommand("ompStudio.openSession", async () => {
			await provider.showHistory();
		}),
		// Registered but deliberately not contributed: the sidebar title bar no longer shows a
		// button for this menu. The webview overlay and every RPC call behind it stay, so an
		// entry point can be put back (a menu item, a keybinding) without rebuilding the menu.
		vscode.commands.registerCommand("ompStudio.sessionMenu", () => {
			provider.showSessionMenu();
		}),
		vscode.commands.registerCommand("ompStudio.settings", () => {
			settingsPanel.open();
		}),
		vscode.commands.registerCommand("ompStudio.diagnose", async () => {
			output?.show(true);
			await diagnose(env, (line) => output?.appendLine(line));
		}),
		{ dispose: () => instanceManager.killAll() },
	);

	logger.info(`OMP Studio 已激活（omp: ${env.ompPath}, cwd: ${env.workspaceRoot}）`);
}

export function deactivate(): void {
	// AGENTS.md: closing VS Code must not leave `omp` behind. killTree is synchronous
	// on purpose - deactivate cannot await.
	manager?.killAll();
	manager = undefined;
}

function readSetting<T>(key: string, fallback: T): T {
	const value = vscode.workspace.getConfiguration(SECTION).get<T>(key);
	return value === undefined ? fallback : value;
}
