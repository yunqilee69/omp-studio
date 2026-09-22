// Bundles test/ui/record-settings-snapshot.mjs and runs it. Kept separate from
// esbuild.mjs for the same reason record-ui-log.mjs is: it is a verification tool,
// not a build product - nothing here ships in the .vsix.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// CJS on purpose: `yaml` is a CJS package whose `require("process")` cannot survive
// an ESM bundle, and this chain pulls it in through models-file.ts.
const outfile = join(root, "test", "ui", ".build", "record-settings-snapshot.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
	entryPoints: [join(root, "test", "ui", "record-settings-snapshot.mjs")],
	outfile,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	logLevel: "warning",
});

process.env.OMP_STUDIO_UI_LOG_DIR ??= join(root, "test", "ui");
await import(pathToFileURL(outfile).href);
