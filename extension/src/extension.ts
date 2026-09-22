import { homedir } from "node:os";
import * as vscode from "vscode";
import type { ApprovalMode, HostEnv, Logger } from "./config";
import { diagnose } from "./diagnose";
import { InstanceManager } from "./instance-manager";
import { SidebarProvider } from "./providers/sidebar";

let manager: InstanceManager | undefined;
let output: vscode.OutputChannel | undefined;

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
		maxInstances: readSetting("maxInstances", 4),
		approvalMode: readSetting<ApprovalMode>("approvalMode", "inherit"),
		homeDir: homedir(),
		logger,
	};

	const instanceManager = new InstanceManager(env);
	manager = instanceManager;
	const provider = new SidebarProvider(context.extensionUri, instanceManager, env);

	context.subscriptions.push(
		output,
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("ompStudio.newInstance", async () => {
			provider.reveal();
			await instanceManager.create();
		}),
		vscode.commands.registerCommand("ompStudio.openSession", async () => {
			await provider.showHistory();
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
	const value = vscode.workspace.getConfiguration("ompStudio").get<T>(key);
	return value === undefined ? fallback : value;
}
