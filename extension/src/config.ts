export type ApprovalMode = "inherit" | "always-ask" | "write" | "yolo";

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** Everything the host-side core needs from VS Code, injected so it stays testable. */
export interface HostEnv {
	/** Executable name on PATH or an absolute path. */
	readonly ompPath: string;
	readonly workspaceRoot: string;
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
