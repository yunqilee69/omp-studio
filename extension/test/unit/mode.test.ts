import { describe, expect, it } from "vitest";
import { isPlanHandoff, modeChoices, modeNote, modeRefusal, MODE_ORDER, type ModeSurface } from "../../src/mode";

/**
 * The mode menu is a claim about what omp can actually do (docs/upstream-issues.md U2):
 * omp 18's RPC has no mode at all, so `--plan-yolo` is the only live path into Plan — and
 * the way back out is the same restart without the flag. Goal/Vibe have no headless entry
 * point. These cases pin the claim, not the wording.
 */
const liveTab = (over: Partial<Extract<ModeSurface, { kind: "tab" }>> = {}): ModeSurface => ({
	kind: "tab",
	rpc: false,
	planYolo: false,
	canRestart: true,
	busy: false,
	...over,
});

function choice(surface: ModeSurface, mode: string) {
	const found = modeChoices(surface).find((entry) => entry.mode === mode);
	if (!found) throw new Error(`no row for ${mode}`);
	return found;
}

describe("modeChoices", () => {
	it("lists every mode once, in MODE_ORDER, on every surface", () => {
		for (const surface of [{ kind: "fresh" } as ModeSurface, liveTab(), liveTab({ rpc: true })]) {
			expect(modeChoices(surface).map((entry) => entry.mode)).toEqual([...MODE_ORDER]);
		}
	});

	it("labels the rows with the names the transcript uses", () => {
		expect(choice({ kind: "fresh" }, "none").label).toBe("Agent");
		expect(choice({ kind: "fresh" }, "plan").label).toBe("Plan");
	});

	it("offers Plan on the next session, launched with omp's own --plan-yolo", () => {
		expect(choice({ kind: "fresh" }, "plan").enabled).toBe(true);
		expect(choice({ kind: "fresh" }, "plan").hint).toContain("--plan-yolo");
	});

	it("refuses Goal and Vibe, which nothing can start: the list and a plain omp 18 Tab", () => {
		for (const surface of [{ kind: "fresh" } as ModeSurface, liveTab()]) {
			expect(choice(surface, "goal").enabled).toBe(false);
			expect(choice(surface, "vibe").enabled).toBe(false);
			expect(choice(surface, "goal").hint).toContain("U2");
		}
	});

	it("offers Plan on a live Tab exactly when the process can be restarted onto the session file", () => {
		expect(choice(liveTab(), "plan").enabled).toBe(true);
		expect(choice(liveTab({ canRestart: false }), "plan").enabled).toBe(false);
		expect(choice(liveTab({ busy: true }), "plan").enabled).toBe(false);
	});

	it("explains the Plan row's refusal in each of the three states", () => {
		expect(choice(liveTab({ busy: true }), "plan").hint).toContain("运行中");
		expect(choice(liveTab({ canRestart: false }), "plan").hint).toContain("没有会话文件");
		expect(choice(liveTab({ planYolo: true }), "plan").hint).toContain("已在 Plan");
	});

	it("offers Agent back to a Tab whose process is still planning", () => {
		const agent = choice(liveTab({ planYolo: true }), "none");

		expect(agent.enabled).toBe(true);
		expect(agent.hint).toContain("撤掉 --plan-yolo");
	});

	it("offers Agent on a plain Tab as the current mode; leaving Plan works even mid-turn", () => {
		// A plain Tab is already Agent: the row is clickable (the menu closes on current),
		// not a restart offer.
		const plain = choice(liveTab(), "none");
		expect(plain.enabled).toBe(true);
		expect(plain.hint).toContain("已是 Agent");

		// A plan-yolo turn can run for minutes; the abort-then-restart path keeps Agent
		// reachable instead of trapping the user until the auto-approve finishes.
		const busy = choice(liveTab({ planYolo: true, busy: true }), "none");
		expect(busy.enabled).toBe(true);
		expect(busy.hint).toContain("中止");

		const noFile = choice(liveTab({ planYolo: true, canRestart: false }), "none");
		expect(noFile.enabled).toBe(false);
		expect(noFile.hint).toContain("没有会话文件");
	});

	it("enables every mode once the RPC carries modes, and drops the note", () => {
		const surface = liveTab({ rpc: true });

		expect(modeChoices(surface).every((entry) => entry.enabled)).toBe(true);
		expect(modeNote(surface)).toBeUndefined();
	});

	it("keeps the note while the RPC has no mode, on both surfaces", () => {
		expect(modeNote({ kind: "fresh" })).toContain("U2");
		expect(modeNote(liveTab())).toContain("U2");
	});
});

describe("modeRefusal", () => {
	it("repeats the row's own reason for a mode that was refused", () => {
		expect(modeRefusal(liveTab(), "goal")).toBe(choice(liveTab(), "goal").hint);
	});

	it("falls back to the surface note for a mode omp never offered", () => {
		expect(modeRefusal(liveTab(), "yolo")).toBe(modeNote(liveTab()));
	});
});

describe("isPlanHandoff", () => {
	const notice = {
		type: "notice",
		source: "plan-yolo",
		message: "Plan-yolo: plan approved, switched to OmniGate/deepseek (thinking: high)",
	};

	it("recognises omp's plan hand-off, which is the only proof the plan phase ended", () => {
		expect(isPlanHandoff(notice)).toBe(true);
	});

	it("ignores the same words from another source, and other notices from plan-yolo", () => {
		expect(isPlanHandoff({ ...notice, source: "set_model" })).toBe(false);
		expect(isPlanHandoff({ ...notice, message: "Plan-yolo: drafting the plan" })).toBe(false);
		expect(isPlanHandoff({ ...notice, type: "message_end" })).toBe(false);
		expect(isPlanHandoff({})).toBe(false);
	});
});
