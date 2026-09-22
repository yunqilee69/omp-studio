// Minimal VS Code API surface, aliased in for the UI verification recorder so the
// real SidebarProvider / SettingsPanel can run outside VS Code. Almost every function
// here is a no-op or a plain value. The two exceptions are the pieces a scenario has to
// change and then assert on: `workspace.getConfiguration` (a Map in place of
// settings.json) and the webview/command registries below. Nothing about the
// extension's own behaviour is emulated.

export const Uri = {
	file: (path) => ({ fsPath: path, scheme: "file" }),
	parse: (value) => ({ fsPath: value, scheme: value.split(":")[0] ?? "file" }),
	joinPath: (base, ...parts) => ({ fsPath: [base.fsPath.replace(/\/$/, ""), ...parts].join("/"), scheme: base.scheme }),
};

/** Stands in for `vscode.RelativePattern`: a value the watcher stub only carries. */
export class RelativePattern {
	constructor(base, pattern) {
		this.base = base;
		this.pattern = pattern;
	}
}

export const env = {
	openExternal: async (uri) => {
		process.stdout.write(`[stub] openExternal ${uri.fsPath}\n`);
		return true;
	},
	clipboard: { writeText: async () => {} },
};

/** Stands in for settings.json, keyed `<section>.<key>`. */
export const configurationStore = new Map();
/** Every `update`, in order, for a scenario to assert on. */
export const configurationWrites = [];

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1 };

const disposable = () => ({ dispose: () => {} });

export const workspace = {
	openTextDocument: async (uri) => ({ uri }),
	workspaceFolders: [{ uri: Uri.file(process.cwd()) }],
	getConfiguration: (section = "") => ({
		get: (key, fallback) => configurationStore.get(`${section}.${key}`) ?? fallback,
		update: async (key, value, target) => {
			configurationWrites.push({ section, key, value, target });
			configurationStore.set(`${section}.${key}`, value);
		},
	}),
	onDidChangeWorkspaceFolders: () => disposable(),
	createFileSystemWatcher: () => ({
		onDidCreate: () => disposable(),
		onDidDelete: () => disposable(),
		onDidChange: () => disposable(),
		dispose: () => {},
	}),
	findFiles: async () => [],
	getWorkspaceFolder: () => ({ uri: Uri.file(process.cwd()) }),
	asRelativePath: (uri, _includeWorkspaceFolder) => uri.fsPath,
	fs: { readFile: async () => new Uint8Array() },
};

export const window = {
	showTextDocument: async () => {},
	createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
	registerWebviewViewProvider: () => disposable(),
	createWebviewPanel: (_viewType, _title, _column, _options) => {
		const panel = new FakePanel();
		webviewPanels.push(panel);
		return panel;
	},
	createTerminal: () => ({ show: () => {}, sendText: () => {}, dispose: () => {} }),
};

export const commands = {
	executeCommand: async () => {},
	/** Kept, unlike `registerCommand` in production: a scenario invokes it like the palette does. */
	registerCommand: (id, callback) => {
		registeredCommands.set(id, callback);
		return { dispose: () => registeredCommands.delete(id) };
	},
};

export const registeredCommands = new Map();
export const webviewPanels = [];

/** An editor-area panel holding a `FakeWebview`, the settings page's whole surface. */
class FakePanel {
	webview = new FakeWebview();
	disposed = false;
	visible = true;
	onDidDispose(handler) {
		this.onDispose = handler;
		return disposable();
	}
	onDidChangeViewState(handler) {
		this.onViewState = handler;
		return disposable();
	}
	reveal() {
		this.revealed = true;
	}
	dispose() {
		this.disposed = true;
		this.onDispose?.();
	}
}

/** Records what the host posts and lets a scenario send webview messages back. */
export class FakeWebview {
	options = {};
	messages = [];

	onDidReceiveMessage(handler) {
		this.handler = handler;
		return disposable();
	}
	asWebviewUri(uri) {
		return uri;
	}
	postMessage(message) {
		this.messages.push(message);
	}
	async send(message) {
		await this.handler?.(message);
	}
	/** Message of the given type, newest first: the page's answers arrive in order. */
	last(type) {
		return this.messages.filter((message) => message.type === type).at(-1);
	}
}
