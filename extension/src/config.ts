export type ApprovalMode = "inherit" | "always-ask" | "write" | "yolo";

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/**
 * The extension's own settings, written to VS Code's configuration.
 *
 * omp's `config.yml` never travels through here (dev-plan §2.7): this door is only for
 * the `ompStudio.*` keys this extension owns. `set` resolves with the value VS Code
 * will actually hand out afterwards, which differs from `value` when the user has a
 * workspace or folder override - the settings page has to be able to say so.
 */
export interface HostSettingsWriter {
	/** Writes `ompStudio.<key>` at user scope; resolves with the effective value. */
	set(key: string, value: number): Promise<number>;
}

/** Everything the host-side core needs from VS Code, injected so it stays testable. */
export interface HostEnv {
	/** Executable name on PATH or an absolute path. */
	readonly ompPath: string;
	readonly workspaceRoot: string;
	/**
	 * Soft cap on concurrently running instances. Re-read on use, never cached: the
	 * settings page can change it while instances run, so `extension.ts` exposes it as a
	 * getter over VS Code configuration.
	 */
	readonly maxInstances: number;
	readonly approvalMode: ApprovalMode;
	readonly homeDir: string;
	readonly logger: Logger;
}

/**
 * Extra CLI args implied by settings.
 *
 * `inherit` passes nothing: omp's own `tools.approvalMode` (default yolo) stays the
 * single source of truth, and this extension never keeps a second copy of it.
 */
export function approvalArgs(mode: ApprovalMode): string[] {
	return mode === "inherit" ? [] : ["--approval-mode", mode];
}
