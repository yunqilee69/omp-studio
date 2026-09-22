import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./session-file";
import type { McpServerView } from "./shared/protocol";

interface McpFileShape {
	mcpServers?: Record<string, Record<string, unknown>>;
	disabledServers?: unknown;
}

export interface McpSnapshot {
	servers: McpServerView[];
	sources: { label: string; path: string; exists: boolean; error?: string }[];
}

async function readMcpFile(path: string): Promise<{ data: McpFileShape; exists: boolean; error?: string }> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return { data: JSON.parse(raw) as McpFileShape, exists: true };
		} catch (error) {
			return { data: {}, exists: true, error: error instanceof Error ? error.message : String(error) };
		}
	} catch {
		return { data: {}, exists: false };
	}
}

/**
 * MCP inventory, read from the same two files omp reads (`Dr` in omp 18.1.2):
 * user `$PI_CODING_AGENT_DIR/mcp.json` (default `~/.omp/agent/mcp.json`) and project
 * `<cwd>/.omp/mcp.json`.
 *
 * Precedence follows the runtime loader (`zfn`): a project entry shadows the user
 * entry with the same name, and a server is disabled when its entry sets
 * `enabled: false` or the *user* file lists it in `disabledServers`. Disabled
 * servers are still listed, because the panel exists to turn them back on.
 *
 * Mutations deliberately do NOT write these files: `/mcp enable|disable <name>` is
 * RPC-reachable and rewrites the owning file itself, so omp stays the only writer.
 */
export async function readMcp(cwd: string, homeDir: string): Promise<McpSnapshot> {
	const userPath = join(agentDir(homeDir), "mcp.json");
	const projectPath = join(cwd, ".omp", "mcp.json");
	const [user, project] = await Promise.all([readMcpFile(userPath), readMcpFile(projectPath)]);
	const disabled = new Set(
		Array.isArray(user.data.disabledServers)
			? user.data.disabledServers.filter((name): name is string => typeof name === "string")
			: [],
	);

	const servers = new Map<string, McpServerView>();
	const collect = (data: McpFileShape, scope: "user" | "project", configPath: string, shadowedByProject: boolean) => {
		for (const [name, config] of Object.entries(data.mcpServers ?? {})) {
			if (!config || typeof config !== "object") continue;
			if (shadowedByProject && servers.has(name)) continue;
			const transport = typeof config.type === "string" ? config.type : "stdio";
			const detail = transport === "stdio" ? stdioDetail(config) : urlDetail(config);
			servers.set(name, {
				name,
				scope,
				transport,
				detail,
				enabled: config.enabled !== false && !disabled.has(name),
				configPath,
			});
		}
	};
	collect(project.data, "project", projectPath, false);
	collect(user.data, "user", userPath, true);

	const sources: McpSnapshot["sources"] = [
		{ label: "user", path: userPath, exists: user.exists, error: user.error },
		{ label: "project", path: projectPath, exists: project.exists, error: project.error },
	];
	return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), sources };
}

function stdioDetail(config: Record<string, unknown>): string {
	const command = typeof config.command === "string" ? config.command : "";
	const args = Array.isArray(config.args) ? config.args.filter((value): value is string => typeof value === "string") : [];
	return [command, ...args].join(" ").trim() || "(no command)";
}

function urlDetail(config: Record<string, unknown>): string {
	return typeof config.url === "string" && config.url ? config.url : "(no url)";
}
