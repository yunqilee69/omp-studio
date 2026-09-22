import * as vscode from "vscode";

/**
 * Shared webview shell pieces.
 *
 * Both webviews (the sidebar and the settings page) are sandboxed the same way,
 * so the CSP string and its nonce live here rather than being copy-pasted: a
 * policy that drifts from the nonce it was built with silently kills the script.
 */
export function createNonce(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let nonce = "";
	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return nonce;
}

export function contentSecurityPolicy(webview: vscode.Webview, nonce: string): string {
	return `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
}
