import { MODE_LABELS } from "./session-file";
import type { ModeChoice } from "./shared/protocol";

/**
 * Where the mode pill can send a session, given what the process in front of it can
 * actually do. Modes are omp's own (`none | plan | goal | vibe`, docs/dev-plan.md §1.5);
 * omp 18's RPC carries no mode at all (docs/upstream-issues.md U2), so two real paths
 * exist today and one of them is not the protocol:
 *
 *   - `get_state.mode` present (a future omp) -> the RPC owns modes, `set_mode` switches
 *     the live process in place.
 *   - otherwise -> Plan is still reachable through omp's own headless plan flow,
 *     `--plan-yolo` (verified end to end: docs/rpc-samples/plan-yolo.jsonl), and the way
 *     back to Agent is the same restart without the flag. It cannot be turned on or off
 *     inside a running process, so the tab swaps its process on the same session jsonl.
 *     Goal/Vibe have no headless entry point at all.
 *
 * Everything here is pure so the menu is testable without starting omp.
 */
export const MODE_ORDER = ["none", "plan", "goal", "vibe"] as const;

export type ModeSurface =
	/** The list composer: no process yet, so the choice rides on this tab's spawn args. */
	| { kind: "fresh" }
	/** A live tab. */
	| {
			kind: "tab";
			/** `get_state.mode` is present: modes belong to the RPC and switch in place. */
			rpc: boolean;
			/** Started with `--plan-yolo`; omp ends the plan phase itself at approval. */
			planYolo: boolean;
			/** Alive, with a session file to resume: the process can be restarted as Plan. */
			canRestart: boolean;
			/** A turn is in flight. */
			busy: boolean;
	  };

const U2 = "omp 18 的 RPC 没有 set_mode/get_state.mode（docs/upstream-issues.md U2）";
const TUI_ONLY = "没有 headless 入口，只能在 omp 终端里切";
const PLAN_LAUNCH =
	"用 omp 的 --plan-yolo 启动：先只读起草计划，计划就绪后 omp 自动批准并用同一模型继续实施";
const PLAN_RESTART =
	"重启本会话为 Plan（omp --plan-yolo）：先只读起草计划，计划就绪后 omp 自动批准并用当前模型继续实施";
const PLAIN_RESTART =
	"重启本会话回到 Agent（撤掉 --plan-yolo，--resume 同一份 jsonl）：计划草稿与历史都留在原会话里";

const BUSY = "本轮运行中：等这轮结束再切，切模式会重启本 Tab 的进程";
const BUSY_LEAVE =
	"本轮运行中：切回 Agent 会先中止这一轮（已完成的步骤保留在会话里），再撤掉 --plan-yolo 重启";

/** The mode menu for one surface: one row per mode, in `MODE_ORDER`. */
export function modeChoices(surface: ModeSurface): ModeChoice[] {
	if (surface.kind === "fresh") {
		return [
			row("none", true, "默认：不加限制，直接执行"),
			row("plan", true, PLAN_LAUNCH),
			row("goal", false, `${U2}；Goal ${TUI_ONLY}`),
			row("vibe", false, `${U2}；Vibe ${TUI_ONLY}`),
		];
	}
	if (surface.rpc) {
		return MODE_ORDER.map((mode) => row(mode, true, `切换到 ${MODE_LABELS[mode] ?? mode}`));
	}
	// Leaving Plan is allowed even mid-turn: the manager aborts the run and swaps the
	// process, so a plan-yolo auto-approve turn never traps the user (bug: Plan→Agent).
	const restartable = surface.canRestart && !surface.busy;
	return [
		row("none", surface.canRestart, plainHint(surface)),
		row("plan", restartable && !surface.planYolo, planHint(surface)),
		row("goal", false, `${U2}；Goal ${TUI_ONLY}`),
		row("vibe", false, `${U2}；Vibe ${TUI_ONLY}`),
	];
}

function planHint(surface: Extract<ModeSurface, { kind: "tab" }>): string {
	if (surface.planYolo) return "已在 Plan：计划提交后由 omp 自动批准并结束 Plan";
	if (surface.busy) return BUSY;
	if (!surface.canRestart) return "本 Tab 还没有会话文件，无法重启为 Plan";
	return PLAN_RESTART;
}

/** Why the Agent row is (or was) offered on a live Tab. */
function plainHint(surface: Extract<ModeSurface, { kind: "tab" }>): string {
	if (!surface.canRestart) return "本 Tab 还没有会话文件，无法重启回 Agent";
	if (surface.planYolo && surface.busy) return BUSY_LEAVE;
	if (surface.planYolo) return PLAIN_RESTART;
	return "已是 Agent：本会话直接执行，不加只读限制";
}

/** The one line under the menu rows; undefined when every mode works. */
export function modeNote(surface: ModeSurface): string | undefined {
	if (surface.kind === "fresh") {
		return "Plan 走 omp 的 headless 规划流程（--plan-yolo）：只读起草 → 自动批准 → 继续实施；Goal/Vibe 只能在 omp 终端里用（U2）。";
	}
	if (surface.rpc) return undefined;
	return "omp 18 的 RPC 没有 set_mode/get_state.mode（docs/upstream-issues.md U2）：Plan 用 --plan-yolo 重启本会话，Goal/Vibe 只能在 omp 终端里切。";
}

/** Why nothing happened when a mode row that the menu disabled arrives anyway. */
export function modeRefusal(surface: ModeSurface, mode: string): string {
	const choice = modeChoices(surface).find((entry) => entry.mode === mode);
	return choice?.hint ?? modeNote(surface) ?? `omp 没有接受模式 ${mode}`;
}

/**
 * omp's own `--plan-yolo` hand-off notice: it approved the plan (after the model wrote
 * `xd://propose`) and is now implementing with the target model. It is the only frame
 * that proves the plan phase ended — `--plan-yolo` writes no `mode_change` entry — so it
 * is what moves the pill from Plan back to Agent. `message` is `unknown` because the
 * matcher is also run over the whole recorded frame union, whose other members carry a
 * `message` object.
 */
export function isPlanHandoff(frame: { type?: string; source?: string; message?: unknown }): boolean {
	return (
		frame.type === "notice" &&
		frame.source === "plan-yolo" &&
		typeof frame.message === "string" &&
		/plan approved/i.test(frame.message)
	);
}

function row(mode: string, enabled: boolean, hint: string): ModeChoice {
	return { mode, label: MODE_LABELS[mode] ?? mode, enabled, hint };
}
