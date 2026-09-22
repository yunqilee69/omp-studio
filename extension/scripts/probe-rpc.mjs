// Phase 0 probe: drive a real `omp --mode rpc` and record every stdout frame.
//
//   node extension/scripts/probe-rpc.mjs <outDir>
//        --steps <basic|chat|plan|plan-yolo|vibe|subagent|abort|mcp|edit|ask|approval>
//        [--cwd <dir>] [--omp <path>] [--into <model|@role>] [--mode <rpc|rpc-ui>]
//        [--approval <mode>]
//
// `edit` wants a scratch workspace: point `--cwd` at a temp dir. The step seeds
// `probe-notes.txt` itself and asks for one write plus one edit, so the capture
// carries the `result.details.diff` a transcript row reads its `+N -M` from.
//
// `plan-yolo` also wants a scratch `--cwd`, and launches the child with
// `--plan-yolo --plan-yolo-into <into>` (`--into` defaults to `@smol`, omp's own
// default): the first prompt drafts read-only and writes its plan, then omp approves
// it itself and implements it with the model the flag pins. This is the only headless
// route into plan mode (docs/upstream-issues.md U2), and the capture carries the
// `source: "plan-yolo"` notice that proves the hand-off.
//
// `ask` runs on `--mode rpc-ui` by default: omp only registers its `ask` tool when it
// believes a UI is attached, and `--mode rpc` leaves `hasUI` false (docs/upstream-issues.md
// U4). It drives one question of each shape omp can produce - a single choice with
// descriptions and a recommendation, a multi-select, a two-question sequence, and the
// free-form `Other` route - answering every request as the terminal would (the answers
// land in `<steps>.stdin.jsonl`). `approval` does the same for a tool approval with
// `--approval <mode>` (e.g. `always-ask`).
//
// Writes <outDir>/<steps>.jsonl (stdout frames), <steps>.stdin.jsonl (commands
// sent) and <steps>.stderr.txt. No dependencies, no VS Code.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const outDir = resolve(argv.shift() ?? "docs/rpc-samples");
const opt = (name, dflt) => {
	const i = argv.indexOf(name);
	return i === -1 ? dflt : argv.splice(i, 2)[1];
};
const cwd = resolve(opt("--cwd", process.cwd()));
const ompPath = opt("--omp", process.env.OMP_PATH ?? "omp");
const into = opt("--into", "@smol");
const steps = opt("--steps", "basic");
const approval = opt("--approval", "");
// The question tool only exists when omp believes a UI is attached (U4).
const mode = opt("--mode", steps === "ask" || steps === "approval" ? "rpc-ui" : "rpc");

mkdirSync(outDir, { recursive: true });

// The plugin starts a Plan tab exactly this way (src/instance.ts): `--plan-yolo` arms
// plan mode for the first prompt, `--plan-yolo-into` pins the implementing model.
const args = ["--mode", mode, "--cwd", cwd];
if (approval) args.push("--approval-mode", approval);
if (steps === "plan-yolo") args.push("--plan-yolo", "--plan-yolo-into", into);

const child = spawn(ompPath, args, {
	stdio: ["pipe", "pipe", "pipe"],
	env: process.env,
});

const frames = [];
const sent = [];
let stderr = "";
let buf = "";
const waiters = new Set();

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
	stderr += d;
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			frame = { __unparsed: line };
		}
		frames.push(frame);
		for (const w of [...waiters]) w(frame, frames.length - 1);
	}
});

function send(obj) {
	sent.push(obj);
	child.stdin.write(`${JSON.stringify(obj)}\n`);
}

let seq = 0;
const nextId = () => `probe_${++seq}`;

function waitFor(pred, { timeout = 180_000, label = "frame" } = {}) {
	return new Promise((res, rej) => {
		for (let i = 0; i < frames.length; i++) if (pred(frames[i], i)) return res(frames[i]);
		const w = (f, i) => {
			if (!pred(f, i)) return;
			clearTimeout(timer);
			waiters.delete(w);
			res(f);
		};
		const timer = setTimeout(() => {
			waiters.delete(w);
			rej(new Error(`timeout waiting for ${label}`));
		}, timeout);
		waiters.add(w);
	});
}

async function command(type, payload = {}) {
	const id = nextId();
	const from = frames.length;
	send({ id, type, ...payload });
	const res = await waitFor((f, i) => f.type === "response" && f.id === id && i >= from - 1, {
		label: `${type} response`,
	});
	if (!res.success) throw new Error(`${type} failed: ${res.error}`);
	return res.data;
}

// A prompt is complete when the agent goes terminal, or when the host reports
// the prompt resolved locally (slash command without an agent turn).
async function runPrompt(message, { timeout = 180_000, ...extra } = {}) {
	const from = frames.length;
	send({ id: nextId(), type: "prompt", message, ...extra });
	await waitFor(
		(f) =>
			(f.type === "agent_end" && f.isTerminal !== false) ||
			(f.type === "prompt_result" && f.agentInvoked === false),
		{ timeout, label: `completion of ${JSON.stringify(message)}` },
	);
	return frames.slice(from);
}

/** Methods that block omp until the host answers; the rest are TUI chrome. */
const ASKING = new Set(["select", "confirm", "input", "editor"]);

/** omp's own labels inside a `select`: the question itself, the commit row, the escape hatch. */
const questionOf = (title) => (title ?? "").replace(/^\(\d+ selected\)\s*/, "").replace(/\s*\(\d+\/\d+\)$/, "");
const isDone = (option) => option.endsWith("Done selecting");
const isOther = (option) => option === "Other (type your own)";
const isRecommended = (option) => option.endsWith(" (Recommended)");

/**
 * One prompt that is expected to ask something, driven to completion: the terminal is
 * not attached here, so every request has to be answered or the turn never ends.
 * `answer(request, round)` returns the response payload; `round` counts the questions
 * already answered for that same question text, which is what a multi-select is.
 */
async function runAskingPrompt(message, answer, { timeout = 900_000 } = {}) {
	const turn = runPrompt(message, { timeout });
	const rounds = new Map();
	let cursor = frames.length;
	for (;;) {
		const next = await waitFor(
			(f, i) =>
				i >= cursor &&
				(f.type === "extension_ui_request" ||
					(f.type === "agent_end" && f.isTerminal !== false) ||
					(f.type === "prompt_result" && f.agentInvoked === false)),
			{ timeout, label: `question during ${JSON.stringify(message)}` },
		);
		cursor = frames.indexOf(next) + 1;
		if (next.type !== "extension_ui_request") break;
		if (!ASKING.has(next.method)) continue;
		const key = questionOf(next.title);
		const round = rounds.get(key) ?? 0;
		rounds.set(key, round + 1);
		send({ type: "extension_ui_response", id: next.id, ...answer(next, round) });
		log(`answered ${next.method} "${key}" round ${round}`);
	}
	return turn;
}

const log = (m) => process.stderr.write(`[probe] ${m}\n`);

try {
	await waitFor((f) => f.type === "ready", { label: "ready" });
	log(`ready: ${JSON.stringify(frames[0])}`);
	await command("negotiate_protocol", { protocolVersion: 2 });

	const state = await command("get_state");
	log(`sessionFile=${state.sessionFile}`);
	log(`model=${JSON.stringify(state.model)} streaming=${state.isStreaming} thinking=${state.thinkingLevel}`);
	log(`keys=${Object.keys(state).join(",")}`);

	if (steps === "basic") {
		const models = await command("get_available_models");
		log(`models=${models.models.length}`);
		const commands = await command("get_available_commands");
		log(`commands=${commands.commands.length}`);
		const subagents = await command("get_subagents");
		log(`subagents(registry)=${subagents.subagents?.length}`);
		await command("set_subagent_subscription", { level: "events" });
		const page = await command("get_messages_page", { limit: 20 });
		log(`history messages=${page.messages?.length} total=${page.totalMessages}`);
	} else if (steps === "chat") {
		await runPrompt("列出当前目录的文件，只列文件名，不要读文件内容。");
		log("chat turn done");
	} else if (steps === "plan") {
		const commands = await command("get_available_commands");
		writeFileSync(resolve(outDir, "commands.json"), `${JSON.stringify(commands, null, 2)}\n`);
		const turn = await runPrompt("/plan");
		writeFileSync(resolve(outDir, "plan.turn.jsonl"), `${turn.map((f) => JSON.stringify(f)).join("\n")}\n`);
		log(`after /plan: state=${JSON.stringify(await command("get_state"))}`);
	} else if (steps === "vibe") {
		const turn = await runPrompt("/vibe");
		writeFileSync(resolve(outDir, "vibe.turn.jsonl"), `${turn.map((f) => JSON.stringify(f)).join("\n")}\n`);
		log("after /vibe");
	} else if (steps === "subagent") {
		await command("set_subagent_subscription", { level: "events" });
		await runPrompt(
			"用一个 task 子智能体（agent 参数 scout）统计 docs/ 目录里的文件名，然后把它返回的内容原样贴出来。",
		);
		const subs = await command("get_subagents");
		writeFileSync(resolve(outDir, "subagents.json"), `${JSON.stringify(subs, null, 2)}\n`);
		log(`subagents=${subs.subagents?.length}`);
	} else if (steps === "mcp") {
		// `/mcp list` answers with command_output + a prompt response carrying
		// agentInvoked:false, so it is a plain command, not an agent turn.
		const from = frames.length;
		await command("prompt", { message: "/mcp list" });
		await command("prompt", { message: "/mcp" });
		const outputs = frames
			.slice(from)
			.filter((f) => f.type === "command_output" && typeof f.text === "string")
			.map((f) => f.text);
		writeFileSync(resolve(outDir, "mcp.txt"), `${outputs.join("\n\n")}\n`);
		log(`mcp command_output lines=${outputs.length}`);
	} else if (steps === "abort") {
		send({ id: nextId(), type: "prompt", message: "数到一百万，一步一步数，不要停。" });
		await new Promise((r) => setTimeout(r, 4000));
		await command("abort");
		await waitFor((f) => f.type === "agent_end", { label: "agent_end after abort" });
		log("abort ok");
	} else if (steps === "edit") {
		writeFileSync(resolve(cwd, "probe-notes.txt"), "alpha\nbeta\ngamma\n");
		await runPrompt(
			[
				"两件事，做完就用一句话总结，不要做别的：",
				"1. 把 probe-notes.txt 的第 2 行 beta 改成 BETA。",
				"2. 新建 probe-extra.txt，写入三行：one / two / three。",
			].join("\n"),
		);
		// The same turn as a history page: this is what a resumed session replays,
		// and it must carry the tool results' `details` for the rows to keep their
		// `+N -M` after a restart. Written next to the frames for the unit tests.
		const page = await command("get_messages_page", { limit: 256 });
		writeFileSync(resolve(outDir, "edit.history.json"), `${JSON.stringify(page.messages ?? [], null, 1)}\n`);
		log(`edit turn done, history messages=${page.messages?.length}`);
	} else if (steps === "plan-yolo") {
		// One prompt, two phases: the plan phase drafts read-only, writes its plan file
		// and calls `xd://propose`; omp then approves it itself (the `plan-yolo` notice),
		// switches to the `--into` model, and implements the plan in the same turn.
		writeFileSync(resolve(cwd, "probe-notes.txt"), "alpha\nbeta\n");
		await runPrompt("把 probe-notes.txt 里的 beta 改成 BETA。", { timeout: 900_000 });
		// The plan file path the flow reported, so a sample reader does not have to
		// guess the slug, plus the turn as a history page (what a restart replays).
		const after = await command("get_state");
		log(`after plan-yolo: mode=${JSON.stringify(after.mode)} planFilePath=${after.planFilePath}`);
		const page = await command("get_messages_page", { limit: 256 });
		writeFileSync(resolve(outDir, "plan-yolo.history.json"), `${JSON.stringify(page.messages ?? [], null, 1)}\n`);
		log(`plan-yolo turn done, history messages=${page.messages?.length}`);
	} else if (steps === "ask") {
		// The four shapes one `ask` call can take. Each prompt is written so the model has
		// nothing to decide: it asks, this script answers, and the turn ends.
		const first = (request) => request.options.find((option) => !isOther(option) && !isDone(option));
		await runAskingPrompt(
			[
				"只做一件事：用 ask 工具问我「用哪种存储后端」，三个选项 SQLite、PostgreSQL、DuckDB，",
				"描述分别是「单文件，零运维」「需要服务端」「分析型」，其中 PostgreSQL 标记为推荐（recommended: true）。",
				"不要自己做任何决定，问完把选到的结果念一遍即可。",
			].join("\n"),
			(request) => ({ value: request.options.find(isRecommended) ?? first(request) }),
		);
		await runAskingPrompt(
			[
				"只做一件事：用 ask 工具问我「要启用哪些检查项」，multi: true，三个选项 lint、typecheck、format，",
				"描述分别是「静态代码检查」「类型检查」「格式化」。问完把选中的几项列出来即可。",
			].join("\n"),
			// Rounds of one question: two toggles, then the commit row omp adds.
			(request, round) =>
				round === 2 ? { value: request.options.find(isDone) } : { value: request.options.filter((o) => !isOther(o) && !isDone(o))[round] },
		);
		await runAskingPrompt(
			[
				"只做一件事：用 ask 工具一次问我两个问题：",
				"1) 用哪种语言，选项 Go（描述「简洁、并发友好」）、Rust（描述「内存安全、零成本抽象」）；",
				"2) 要不要写测试，选项 要（描述「同时编写测试」）、不要（描述「暂不编写测试」）。",
				"问完把两个答案念一遍即可。",
			].join("\n"),
			(request) => ({ value: first(request) }),
		);
		await runAskingPrompt(
			[
				"只做一件事：用 ask 工具问我「用哪种存储后端」，选项只要 SQLite 和 PostgreSQL 两个，不要加推荐。",
				"问完把我自己输入的答案念一遍即可。",
			].join("\n"),
			(request) =>
				request.method === "editor"
					? { value: "LevelDB：本地嵌入式 KV，先按它写" }
					: { value: request.options.find(isOther) },
		);
		// What the model did with the answers: the tool results carry `User selected: …`,
		// `User answers: …` and `User provided custom input: …`.
		for (const frame of frames) {
			if (frame.type === "tool_execution_end" && frame.toolName === "ask") {
				log(`ask result: ${JSON.stringify(frame.result?.content?.[0]?.text ?? "").slice(0, 400)}`);
			}
		}
	} else if (steps === "approval") {
		// A tool approval is a `select` whose title is the tool call itself, several lines
		// long: the panel has to wrap it, not flatten it.
		await runAskingPrompt(
			"只做一件事：新建 probe-approval.txt，写入一行 hello，然后一句话说明结果。",
			(request) => {
				log(`approval request: ${JSON.stringify(request).slice(0, 600)}`);
				return { value: request.options.find((option) => !isOther(option) && !isDone(option)) };
			},
		);
	}
} catch (err) {
	log(`ERROR ${err.message}`);
	process.exitCode = 1;
} finally {
	const write = (name, body) => writeFileSync(resolve(outDir, name), body);
	write(`${steps}.jsonl`, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
	write(`${steps}.stdin.jsonl`, `${sent.map((f) => JSON.stringify(f)).join("\n")}\n`);
	if (stderr) write(`${steps}.stderr.txt`, stderr);
	log(`frames=${frames.length} → ${resolve(outDir, `${steps}.jsonl`)}`);
	child.stdin.end();
	const code = await new Promise((r) => child.once("exit", (c) => r(c)));
	log(`exit=${code} pid=${child.pid}`);
}
