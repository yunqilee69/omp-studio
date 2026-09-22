// Phase 0 probe: drive a real `omp --mode rpc` and record every stdout frame.
//
//   node extension/scripts/probe-rpc.mjs <outDir> --steps <basic|chat|plan|vibe|subagent|abort|mcp|edit>
//        [--cwd <dir>] [--omp <path>]
//
// `edit` wants a scratch workspace: point `--cwd` at a temp dir. The step seeds
// `probe-notes.txt` itself and asks for one write plus one edit, so the capture
// carries the `result.details.diff` a transcript row reads its `+N -M` from.
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
const steps = opt("--steps", "basic");

mkdirSync(outDir, { recursive: true });

const child = spawn(ompPath, ["--mode", "rpc", "--cwd", cwd], {
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
async function runPrompt(message, extra = {}) {
	const from = frames.length;
	send({ id: nextId(), type: "prompt", message, ...extra });
	await waitFor(
		(f) =>
			(f.type === "agent_end" && f.isTerminal !== false) ||
			(f.type === "prompt_result" && f.agentInvoked === false),
		{ label: `completion of ${JSON.stringify(message)}` },
	);
	return frames.slice(from);
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
