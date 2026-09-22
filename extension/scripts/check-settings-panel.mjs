// Bundles test/ui/check-settings-panel.mjs with the `vscode` stub aliased in, then runs
// it. Kept separate from esbuild.mjs for the same reason the recorders are: it is a
// verification tool, not a build product - nothing here ships in the .vsix.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// CJS on purpose, like the settings-snapshot recorder: the chain reaches `yaml` through
// models-file.ts, and that package's `require("process")` cannot survive an ESM bundle.
const outfile = join(root, "test", "ui", ".build", "check-settings-panel.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
	entryPoints: [join(root, "test", "ui", "check-settings-panel.mjs")],
	outfile,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	alias: { vscode: join(root, "test", "ui", "vscode-stub.mjs") },
	logLevel: "warning",
});

await import(pathToFileURL(outfile).href);
