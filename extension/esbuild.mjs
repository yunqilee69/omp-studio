// Build: extension host bundle (CJS, node) + webview bundle (IIFE, browser) + webview CSS copy.
import { context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import("esbuild").BuildOptions} */
const common = {
	bundle: true,
	sourcemap: !production,
	minify: production,
	logLevel: "info",
	legalComments: "none",
};

const targets = [
	{
		...common,
		entryPoints: ["src/extension.ts"],
		outfile: "dist/extension.js",
		platform: "node",
		format: "cjs",
		target: "node20",
		external: ["vscode"],
	},
	{
		...common,
		entryPoints: ["webview/main.ts"],
		outfile: "dist/webview.js",
		platform: "browser",
		format: "iife",
		target: "es2022",
	},
];

async function copyAssets() {
	await mkdir("dist", { recursive: true });
	await copyFile("webview/styles.css", "dist/webview.css");
}

if (watch) {
	const contexts = await Promise.all(targets.map((t) => context(t)));
	for (const ctx of contexts) await ctx.watch();
	await copyAssets();
	console.log("watching dist/");
} else {
	for (const t of targets) {
		const ctx = await context(t);
		await ctx.rebuild();
		await ctx.dispose();
	}
	await copyAssets();
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
