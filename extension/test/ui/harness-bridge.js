// Harness host bridge. Provides `acquireVsCodeApi()` to the real webview bundle and
// replays a recorded host log into it, so the shipped webview code + CSS render the
// exact messages the real SidebarProvider produced (test/ui/host-log.json).
//
// URL parameters:
//   log=failure   replay host-log-failure.json instead of host-log.json
//   auto=0        do not replay on load
//
// Answers to interactions are taken from the recording: the recorder is a sequential
// transcript, so the messages between one webview message and the next are exactly
// what the host emitted for that action. Replaying one recorded burst per action keeps
// the harness honest - it never invents host behaviour.
(() => {
	const params = new URLSearchParams(location.search);
	const which = params.get("log") ?? "main";
	const logPath = which === "failure" ? "./host-log-failure.json" : which === "plan" ? "./host-log-plan.json" : which === "palette" ? "./host-log-history.json" : "./host-log.json";
	const outbound = [];
	let entries = [];
	const bursts = new Map();
	const sessions = new Map();

	// Persisted webview state (`api.state` / `setState`), kept per log: VS Code hands a
	// webview its previous state on boot, and the sidebar stores the session pins there.
	const stateKey = `omp-studio-harness-state-${which}`;
	const readState = () => {
		try {
			return JSON.parse(sessionStorage.getItem(stateKey) ?? "null") ?? undefined;
		} catch {
			return undefined;
		}
	};
	window.__harnessLog = outbound;
	window.acquireVsCodeApi = () => ({
		postMessage: handle,
		state: readState(),
		setState: (state) => {
			try {
				sessionStorage.setItem(stateKey, JSON.stringify(state));
			} catch {
				// Storage disabled: the pin simply does not survive a reload.
			}
		},
	});

	const deliver = (message) => window.postMessage(message, "*");

	function handle(message) {
		outbound.push(message);
		document.body.dataset.lastOutbound = JSON.stringify(message).slice(0, 400);
		document.body.dataset.outboundCount = String(outbound.length);
		// The webview asks for state on load; the replay below answers that.
		if (message.type === "ready") return;
		if (message.type === "tab/select") {
			const session = sessions.get(message.id);
			if (session) deliver(session);
			return;
		}
		for (const answer of bursts.get(message.type) ?? []) deliver(answer);
	}

	function index() {
		sessions.clear();
		bursts.clear();
		for (const entry of entries) {
			if (entry.direction === "toWebview" && entry.message.type === "session") {
				sessions.set(entry.message.id, entry.message);
			}
		}
		let action;
		let current = [];
		const flush = () => {
			// Last burst for an action wins: it reflects the recording's final state.
			if (action && current.length > 0) bursts.set(action, current);
			current = [];
		};
		for (const entry of entries) {
			if (entry.direction === "fromWebview") {
				flush();
				action = entry.message.type;
			} else if (action !== "ready") {
				current.push(entry.message);
			}
		}
		flush();
	}

	async function start() {
		entries = await (await fetch(logPath)).json();
		index();
		for (const entry of entries) {
			if (entry.direction !== "toWebview") continue;
			// `sessions/open` only asks for the page the webview already shows on boot;
			// everything after it (`history/open`, `history`) is content and is replayed.
			deliver(entry.message);
			// Plan scenario: stop on the stacked plan so the page shows that view,
			// not the subsequent `view/back` that returns to chat.
			if (
				which === "plan" &&
				entry.message.type === "stack" &&
				Array.isArray(entry.message.stack) &&
				entry.message.stack.some((layer) => layer.kind === "plan")
			) {
				break;
			}
		}
		document.body.dataset.replayed = String(entries.length);
		document.body.dataset.actions = [...bursts.keys()].join(",");
	}

	if (params.get("auto") !== "0") {
		// The webview bundle runs synchronously after this script; replay on load so
		// the webview has already sent its own `ready`.
		window.addEventListener("load", () => {
			void start();
		});
	}
})();
