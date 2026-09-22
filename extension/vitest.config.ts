import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Integration suites spawn real `omp` processes and share the machine with the unit run.
		fileParallelism: false,
	},
});
