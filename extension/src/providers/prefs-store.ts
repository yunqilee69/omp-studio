import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ListPrefs } from "../shared/protocol";

/**
 * Owns the sessions list's view-preferences file. Not a `Memento` — this VS Code build never
 * flushes extension mementos to disk, so anything handed to `workspaceState` evaporates on
 * restart, which is exactly what happened to the archive marks. One small JSON file the
 * extension reads and writes itself: load once per webview session, atomic write (tmp +
 * rename) so a crash mid-write cannot leave half a file behind.
 */
export class SidebarPrefsStore {
	constructor(private readonly file: string) {}

	/** The stored prefs, or the first-run defaults when missing/unreadable. */
	async load(): Promise<ListPrefs> {
		try {
			const raw = await readFile(this.file, "utf8");
			const parsed = JSON.parse(raw) as Partial<ListPrefs>;
			return {
				pins: Array.isArray(parsed.pins) ? parsed.pins.filter((k): k is string => typeof k === "string") : [],
				archived: Array.isArray(parsed.archived)
					? parsed.archived.filter((k): k is string => typeof k === "string")
					: [],
				panelOpen: parsed.panelOpen !== false,
			};
		} catch {
			// Missing (first run) or corrupt: the defaults are the answer either way.
			return { pins: [], archived: [], panelOpen: true };
		}
	}

	/** Writes atomically; creates the storage folder on the way - first run may not have one. */
	async save(prefs: ListPrefs): Promise<void> {
		const tmp = `${this.file}.tmp`;
		await mkdir(dirname(this.file), { recursive: true });
		await writeFile(tmp, JSON.stringify(prefs), "utf8");
		await rename(tmp, this.file);
	}
}
