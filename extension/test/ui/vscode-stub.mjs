// Minimal VS Code API surface, aliased in for the UI verification recorder so the
// real SidebarProvider can run outside VS Code. Every function here is either a
// no-op or a plain value: nothing about the extension's behaviour is emulated.
export const Uri = {
	file: (path) => ({ fsPath: path, scheme: "file" }),
	parse: (value) => ({ fsPath: value, scheme: value.split(":")[0] ?? "file" }),
	joinPath: (base, ...parts) => ({ fsPath: [base.fsPath.replace(/\/$/, ""), ...parts].join("/"), scheme: base.scheme }),
};

export const env = {
	openExternal: async (uri) => {
		process.stdout.write(`[stub] openExternal ${uri.fsPath}\n`);
		return true;
	},
};

export const workspace = {
	openTextDocument: async (uri) => ({ uri }),
	workspaceFolders: [{ uri: Uri.file(process.cwd()) }],
	getConfiguration: () => ({ get: (_key, fallback) => fallback }),
};

export const window = {
	showTextDocument: async () => {},
	createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
	registerWebviewViewProvider: () => ({ dispose: () => {} }),
};

export const commands = {
	executeCommand: async () => {},
	registerCommand: () => ({ dispose: () => {} }),
};
