// Bundles test/ui/record-host-log.mjs with the `vscode` stub aliased in, then runs
// it. Kept separate from esbuild.mjs because it is a verification tool, not a build
// product: nothing here ships in the .vsix.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "test", "ui", ".build", "record-host-log.mjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
	entryPoints: [join(root, "test", "ui", "record-host-log.mjs")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { vscode: join(root, "test", "ui", "vscode-stub.mjs") },
	logLevel: "warning",
});

process.env.OMP_STUDIO_UI_LOG_DIR ??= join(root, "test", "ui");
await import(pathToFileURL(outfile).href);
