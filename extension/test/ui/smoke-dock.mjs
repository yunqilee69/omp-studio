// Browser smoke test for the docked ask/approval panel (webview/main.ts openApproval).
// No automation framework in this repo, so Chrome's devtools protocol over Node 24's
// native WebSocket drives the real bundle. Prerequisites:
//   1. npm run build                       (dist/webview.js + webview.css)
//   2. python3 -m http.server 18099        (from extension/, serves the harness)
//   3. google-chrome --headless=new --remote-debugging-port=19222 --user-data-dir=/tmp/x
//   node test/ui/smoke-dock.mjs
// Verifies: a recorded `select` docks into the composer area (input hidden, no modal
// overlay), the transcript stays visible, a round answer redraws in place, ui:null and
// cancel restore the composer, and the draft typed before the question never clears.
// Node 24 ships a native WebSocket client; no dependency needed.

const CDP = "http://127.0.0.1:19222";

async function main() {
	const target = await (await fetch(`${CDP}/json/new?url=about:blank`, { method: "PUT" })).json();
	const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
	let id = 0;
	const pending = new Map();
	const events = [];
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		else if (msg.method) events.push(msg);
	});
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const mid = ++id;
			pending.set(mid, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
			ws.send(JSON.stringify({ id: mid, method, params }));
			setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`timeout ${method}`)); } }, 15000);
		});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page error");
		return r.result.value;
	};

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url: "http://127.0.0.1:18099/test/ui/smoke.html?log=ask-multi" });
	await new Promise((r) => setTimeout(r, 1500));

	const results = [];
	const check = (name, ok) => { results.push([ok, name,]); console.log(ok ? "PASS" : "FAIL", name); };

	// Enter the session like a user click.
	const clicked = await evaluate(`(async () => {
		const row = document.querySelector(".session-row");
		if (!row) return false;
		row.click();
		await new Promise(r => setTimeout(r, 400));
		return !!document.querySelector(".composer:not(.hidden)");
	})()`);
	check("session entered with composer", clicked);

	// Type a draft, then note stream geometry.
	const setup = await evaluate(`(() => {
		const input = document.querySelector(".prompt");
		input.value = "未发送的草稿文本";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const stream = document.querySelector(".stream");
		return { streamVisible: stream.offsetParent !== null, streamH: stream.clientHeight };
	})()`);
	check("stream visible before dock", setup.streamVisible);

	// The recording ends with omp waiting on the multi-select; it should already be docked.
	const docked = await evaluate(`(() => {
		const dock = document.querySelector(".ui-dock");
		return {
			dockVisible: dock && !dock.classList.contains("hidden"),
			composerInnerHidden: document.querySelector(".composer-inner").classList.contains("hidden"),
			inputShellVisible: !!document.querySelector(".input-shell") && document.querySelector(".input-shell").offsetParent !== null,
			question: dock?.querySelector(".ui-question")?.textContent ?? null,
			overlayHidden: document.querySelector(".overlay").classList.contains("hidden"),
			streamVisible: document.querySelector(".stream").offsetParent !== null,
		};
	})()`);
	console.log("docked:", JSON.stringify(docked, null, 1));
	check("question docked (not modal)", docked.dockVisible && docked.overlayHidden && docked.composerInnerHidden);
	check("input shell hidden while docked", !docked.inputShellVisible);
	check("question text present", docked.question === "要启用哪些检查项？");
	check("stream stays visible while docked", docked.streamVisible);

	// Answer one option: host re-asks the same question; panel redraws in the dock.
	const dockY1 = await evaluate("document.querySelector('.ui-dock').getBoundingClientRect().top");
	const answered = await evaluate(`(async () => {
		const row = document.querySelector(".choice");
		row.click();
		await new Promise(r => setTimeout(r, 500));
		return {
			stillDocked: !document.querySelector(".ui-dock").classList.contains("hidden"),
			composerStillHidden: document.querySelector(".composer-inner").classList.contains("hidden"),
			marked: document.querySelectorAll(".choice.checked").length,
		};
	})()`);
	const dockY2 = await evaluate("document.querySelector('.ui-dock').getBoundingClientRect().top");
	check("panel redraws in place after answer", answered.stillDocked && answered.composerStillHidden);
	check("answered option marked", answered.marked > 0);
	check("dock does not jump between rounds", Math.abs(dockY1 - dockY2) < 4);

	// Ending the exchange: ui:null closes and restores the composer with the draft.
	const closed = await evaluate(`(async () => {
		window.postMessage({ type: "ui", id: "tab-1", request: null }, "*");
		await new Promise(r => setTimeout(r, 300));
		return {
			dockClosed: document.querySelector(".ui-dock").classList.contains("hidden"),
			composerRestored: !document.querySelector(".composer-inner").classList.contains("hidden"),
			draft: document.querySelector(".prompt").value,
		};
	})()`);
	check("close restores composer", closed.dockClosed && closed.composerRestored);
	check("draft text survives", closed.draft === "未发送的草稿文本");

	// A confirm (tool approval) docks the same way.
	const confirm = await evaluate(`(async () => {
		window.postMessage({
			type: "ui", id: "tab-1",
			request: { id: "smoke-1", method: "confirm", title: "允许写入 /tmp/x", message: "Allow tool: write", options: [], selected: [] },
		}, "*");
		await new Promise(r => setTimeout(r, 300));
		return {
			docked: !document.querySelector(".ui-dock").classList.contains("hidden"),
			title: document.querySelector(".ui-panel .panel-title")?.textContent,
			composerHidden: document.querySelector(".composer-inner").classList.contains("hidden"),
		};
	})()`);
	check("confirm docks too", confirm.docked && confirm.composerHidden);
	check("confirm title drawn", confirm.title === "omp 请求审批");

	// Cancel sends `cancelled`, the panel dims (submitted), and the host closes the
	// exchange when no re-ask follows - replay that close the way the real host does.
	const cancel = await evaluate(`(async () => {
		document.querySelector(".ui-panel .chip").click();
		await new Promise(r => setTimeout(r, 200));
		const cancelledSent = document.body.dataset.lastOutbound?.includes('"cancelled":true');
		window.postMessage({ type: "ui", id: "tab-1", request: null }, "*");
		await new Promise(r => setTimeout(r, 300));
		return {
			cancelledSent,
			dockClosed: document.querySelector(".ui-dock").classList.contains("hidden"),
			composerRestored: !document.querySelector(".composer-inner").classList.contains("hidden"),
			draft: document.querySelector(".prompt").value,
		};
	})()`);
	check("cancel sends cancelled", cancel.cancelledSent);
	check("cancel restores composer and sends cancelled", cancel.dockClosed && cancel.composerRestored && cancel.cancelledSent);
	check("draft still intact after cancel", cancel.draft === "未发送的草稿文本");

	// A question sequence (omp's ask with two questions) and a multi-select round, on the
	// ask-single recording: its `ui/respond` burst is empty, so the synthetic requests below
	// are the only thing driving the panel - the replay cannot overwrite them.
	await send("Page.navigate", { url: "http://127.0.0.1:18099/test/ui/smoke.html?log=ask-single" });
	await new Promise((r) => setTimeout(r, 1500));
	const entered = await evaluate(`(async () => {
		const row = document.querySelector(".session-row");
		if (!row) return false;
		row.click();
		await new Promise(r => setTimeout(r, 400));
		return true;
	})()`);
	check("sequence page entered", entered);

	const q1 = await evaluate(`(async () => {
		window.postMessage({ type: "ui", id: "tab-1", request: {
			id: "seq-1", method: "select", title: "用哪种语言？",
			options: [
				{ value: "Go", label: "Go", description: "简洁、并发友好", recommended: false, role: "option" },
				{ value: "Rust", label: "Rust", description: "内存安全、零成本抽象", recommended: false, role: "option" },
				{ value: "Other (type your own)", label: "Other (type your own)", recommended: false, role: "other" },
			],
			selected: [], progress: { index: 1, total: 2 },
		} }, "*");
		await new Promise(r => setTimeout(r, 250));
		const dock = document.querySelector(".ui-dock");
		return {
			docked: !dock.classList.contains("hidden"),
			progress: dock.querySelector(".ui-progress")?.textContent ?? null,
			question: dock.querySelector(".ui-question")?.textContent ?? null,
			rows: dock.querySelectorAll(".choice").length,
			radios: dock.querySelectorAll('.choice[role="radio"]').length,
			commits: dock.querySelectorAll(".choice-commit").length,
			waitingHidden: dock.querySelector(".ui-waiting").classList.contains("hidden"),
		};
	})()`);
	check("first question of a sequence docks", q1.docked && q1.question === "用哪种语言？");
	check("sequence progress reads 第 1/2 题", q1.progress === "第 1/2 题");
	check("single question draws radio rows, no commit button", q1.rows === 3 && q1.radios === 3 && q1.commits === 0);
	check("no waiting line before an answer", q1.waitingHidden);

	// Answering a single question: rows lock, the pick is marked, the waiting line shows.
	const firstAnswer = await evaluate(`(async () => {
		document.querySelector(".choice").click();
		await new Promise(r => setTimeout(r, 250));
		const dock = document.querySelector(".ui-dock");
		const rows = [...dock.querySelectorAll(".choice")];
		return {
			sent: document.body.dataset.lastOutbound?.includes('"value":"Go"') ?? false,
			locked: rows.every((row) => row.disabled),
			chosen: dock.querySelectorAll(".choice.chosen").length,
			waitingVisible: !dock.querySelector(".ui-waiting").classList.contains("hidden"),
		};
	})()`);
	check("single answer sends the row's value", firstAnswer.sent);
	check("answered question locks its rows and marks the pick", firstAnswer.locked && firstAnswer.chosen === 1);
	check("waiting line shows after an answer", firstAnswer.waitingVisible);

	// The second question replaces the first in place: new title, new progress, fresh rows.
	const q2 = await evaluate(`(async () => {
		window.postMessage({ type: "ui", id: "tab-1", request: {
			id: "seq-2", method: "select", title: "要不要写测试？",
			options: [
				{ value: "要", label: "要", description: "同时编写测试", recommended: false, role: "option" },
				{ value: "不要", label: "不要", description: "暂不编写测试", recommended: false, role: "option" },
				{ value: "Other (type your own)", label: "Other (type your own)", recommended: false, role: "other" },
			],
			selected: [], progress: { index: 2, total: 2 },
		} }, "*");
		await new Promise(r => setTimeout(r, 250));
		const dock = document.querySelector(".ui-dock");
		const rows = [...dock.querySelectorAll(".choice")];
		return {
			question: dock.querySelector(".ui-question")?.textContent ?? null,
			progress: dock.querySelector(".ui-progress")?.textContent ?? null,
			enabled: rows.every((row) => !row.disabled),
			chosen: dock.querySelectorAll(".choice.chosen").length,
			waitingHidden: dock.querySelector(".ui-waiting").classList.contains("hidden"),
			docked: !dock.classList.contains("hidden"),
		};
	})()`);
	check("second question replaces the first", q2.docked && q2.question === "要不要写测试？");
	check("sequence progress advances to 第 2/2 题", q2.progress === "第 2/2 题");
	check("second question's rows are fresh and interactive", q2.enabled && q2.chosen === 0 && q2.waitingHidden);

	// A multi-select round: checkbox rows, the hint line, and the commit row lifted out
	// of the list into the primary button.
	const multi = await evaluate(`(async () => {
		window.postMessage({ type: "ui", id: "tab-1", request: {
			id: "multi-1", method: "select", title: "要启用哪些检查项？",
			options: [
				{ value: "lint", label: "lint", recommended: false, role: "option" },
				{ value: "typecheck", label: "typecheck", recommended: false, role: "option" },
				{ value: " Done selecting", label: " Done selecting", recommended: false, role: "done" },
				{ value: "Other (type your own)", label: "Other (type your own)", recommended: false, role: "other" },
			],
			selected: ["lint"],
		} }, "*");
		await new Promise(r => setTimeout(r, 250));
		const dock = document.querySelector(".ui-dock");
		return {
			hint: dock.querySelector(".ui-hint")?.textContent ?? null,
			checkboxes: dock.querySelectorAll('.choice[role="checkbox"]').length,
			checked: dock.querySelectorAll(".choice.checked").length,
			commit: dock.querySelector(".choice-commit")?.textContent ?? null,
			rows: dock.querySelectorAll(".choice").length,
		};
	})()`);
	check("multi round draws checkbox rows", multi.checkboxes === 3 && multi.checked === 1);
	check("multi round lifts the commit row out of the list", multi.rows === 3 && multi.commit === "完成选择（已选 1 项）");
	check("multi round states what to do", multi.hint === "已选 1 项，可继续勾选，或直接提交");

	const commitSent = await evaluate(`(async () => {
		document.querySelector(".choice-commit").click();
		await new Promise(r => setTimeout(r, 200));
		return document.body.dataset.lastOutbound?.includes('"value":" Done selecting"') ?? false;
	})()`);
	check("commit sends the commit row's own value", commitSent);

	const shot = await send("Page.captureScreenshot", { format: "png" });
	const fs = await import("fs");
	fs.writeFileSync("test/ui/smoke-dock.png", Buffer.from(shot.data, "base64"));

	// The model-switch divider is its own transcript row: a label between two rules. The
	// host only emits it on a real switch (unit-tested), so this checks the drawing.
	const divider = await evaluate(`(async () => {
		window.postMessage({ type: "ui", id: "tab-1", request: null }, "*");
		window.postMessage({ type: "items", id: "tab-1", items: [
			{ kind: "divider", key: "d1", text: "模型已切换为 OmniGate/gpt-5.5" },
		] }, "*");
		await new Promise(r => setTimeout(r, 250));
		const row = document.querySelector(".item.divider");
		return {
			present: row !== null,
			label: row?.querySelector(".divider-label")?.textContent ?? null,
			lines: row?.querySelectorAll(".divider-line").length ?? 0,
			visible: row ? row.getBoundingClientRect().height > 0 : false,
		};
	})()`);
	check("model switch divider renders as a row", divider.present && divider.visible);
	check("divider names the model omp confirmed", divider.label === "模型已切换为 OmniGate/gpt-5.5");
	check("divider rules flank the label", divider.lines === 2);

	const failures = results.filter(([ok]) => !ok);
	console.log(failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.length}`);
	ws.close();
	process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
