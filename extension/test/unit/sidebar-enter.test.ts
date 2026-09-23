import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type { HostEnv, Logger } from "../../src/config";
import { Emitter } from "../../src/emitter";
import type { Instance } from "../../src/instance";
import type { ManagerEvents } from "../../src/instance-manager";
import { SidebarProvider } from "../../src/providers/sidebar";
import type { HostMessage } from "../../src/shared/protocol";

/**
 * The titlebar「新建会话」command must land the user in the new session's detail page so
 * the next send rides `prompt/send` on it. `sessions/enter` is a one-shot post, and VS Code
 * drops anything sent to a webview that has not finished loading - the exact state of the
 * sidebar right after `reveal()`. These tests drive the real provider against a recording
 * webview, so the drop is modelled by what the ready handshake does (and does not) re-send.
 */

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Records every host->webview message; `send` runs the host's real message handler. */
class FakeWebview {
	options = {};
	html = "";
	cspSource = "vscode-webview://stub";
	readonly outbound: HostMessage[] = [];
	private handler?: (message: unknown) => unknown;

	onDidReceiveMessage(handler: (message: unknown) => unknown) {
		this.handler = handler;
		return { dispose: () => {} };
	}

	asWebviewUri(uri: { fsPath: string }) {
		return uri;
	}

	postMessage(message: HostMessage) {
		this.outbound.push(message);
		return Promise.resolve(true);
	}

	async send(message: unknown) {
		await this.handler?.(message);
	}
}

/** The manager surface the provider touches, with the real event contract kept. */
function fakeManager() {
	const instance = {
		id: "tab-1",
		state: () => ({ mode: "none", state: "spawning", pending: [], modelsLoading: false, modelsError: undefined }),
		viewStack: [],
		transcript: { items: [] },
		models: [],
		commands: [],
		currentUI: null,
	} as unknown as Instance;
	const events = new Emitter<ManagerEvents>();
	return {
		events,
		activeTabId: "tab-1",
		active: instance,
		all: [instance],
		has: (id: string) => id === "tab-1",
		getTabs: () => [{ summary: { id: "tab-1", title: "tab-1", status: "spawning" } }],
		viewStack: () => [],
		mcp: async () => ({ servers: [], sources: [] }),
		history: async () => [],
		newSession: async () => ({ models: [], modes: [], commands: [] }),
		// `select` emits `active`, which is what pushes the fresh session snapshot.
		create: async () => {
			events.emit("active");
			events.emit("tabs");
			return instance;
		},
	} as never;
}

function makeProvider(): { provider: SidebarProvider; webview: FakeWebview } {
	const root = mkdtempSync(join(tmpdir(), "omp-studio-sidebar-"));
	const env: HostEnv = {
		ompPath: "omp",
		workspaceRoot: root,
		maxInstances: 4,
		approvalMode: "inherit",
		homeDir: process.env.HOME ?? tmpdir(),
		logger: quiet,
	};
	// The stubbed `vscode.Uri` only ever reads `fsPath`, which is all the provider asks of it.
	const folder = { fsPath: root, scheme: "file" } as unknown as vscode.Uri;
	const storage = { fsPath: join(root, "storage"), scheme: "file" } as unknown as vscode.Uri;
	const provider = new SidebarProvider(folder, fakeManager(), env, storage);
	const webview = new FakeWebview();
	provider.resolveWebviewView({ webview, onDidDispose: () => ({ dispose: () => {} }) } as unknown as vscode.WebviewView);
	return { provider, webview };
}

beforeEach(() => {
	// The stub's `workspace.findFiles` walks this root; a temp dir keeps the ready
	// handshake's file scan off the repository.
	process.env.OMP_STUDIO_UI_WORKSPACE = mkdtempSync(join(tmpdir(), "omp-studio-sidebar-files-"));
});

afterEach(() => {
	delete process.env.OMP_STUDIO_UI_WORKSPACE;
});

describe("SidebarProvider.newInstance", () => {
	it("re-delivers sessions/enter on ready when the webview was still loading", async () => {
		const { provider, webview } = makeProvider();

		// Click + before the webview booted: the post below is what VS Code drops.
		await provider.newInstance();
		webview.outbound.length = 0;

		await webview.send({ type: "ready" });
		const types = webview.outbound.map((message) => message.type);
		const snapshot = types.indexOf("session");
		const enter = types.indexOf("sessions/enter");

		expect(snapshot).toBeGreaterThanOrEqual(0);
		expect(enter).toBeGreaterThan(snapshot);
	});

	it("does not replay the enter on a later reload when the webview was already up", async () => {
		const { provider, webview } = makeProvider();
		await webview.send({ type: "ready" });

		webview.outbound.length = 0;
		await provider.newInstance();
		expect(webview.outbound.map((message) => message.type)).toContain("sessions/enter");

		// A reload must not yank the user back into the session they left.
		webview.outbound.length = 0;
		await webview.send({ type: "ready" });
		expect(webview.outbound.map((message) => message.type)).not.toContain("sessions/enter");
	});
});
