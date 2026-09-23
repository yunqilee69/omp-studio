import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Host-side units (`SidebarProvider`, `SettingsPanel`) import `vscode`; the same stub the
	// UI recorder bundles in stands in, so those modules run outside VS Code.
	resolve: {
		alias: { vscode: fileURLToPath(new URL("./test/ui/vscode-stub.mjs", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Integration suites spawn real `omp` processes and share the machine with the unit run.
		fileParallelism: false,
	},
});
