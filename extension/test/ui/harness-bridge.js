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
//
// The recording is a timeline of one tab, but the sidebar boots on the sessions page and
// only enters a chat when the user clicks its row. So the replay ends with the click a
// user would make (`enterReplayedSession`), and the host answer it gets is the recording
// folded up to its own end (`index`), not a snapshot from the middle of it.
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
		// The last `session` message of a tab is only that tab's state at that instant; the
		// messages after it are what refined it. Fold them in, so answering a row click hands
		// over the session the replay already painted instead of an older one.
		const snapshots = new Map();
		for (const [at, entry] of entries.entries()) {
			if (entry.direction === "toWebview" && entry.message.type === "session" && entry.message.id !== undefined) {
				snapshots.set(entry.message.id, at);
			}
		}
		for (const [id, at] of snapshots) {
			const folded = structuredClone(entries[at].message);
			for (const entry of entries.slice(at + 1)) {
				const message = entry.message;
				if (entry.direction !== "toWebview" || message.id !== id) continue;
				if (message.type === "items") folded.items = folded.items.concat(message.items);
				else if (message.type === "itemsRemoved") {
					const removed = new Set(message.keys);
					folded.items = folded.items.filter((item) => !removed.has(item.key));
				} else if (message.type === "state") folded.state = message.state;
				else if (message.type === "stack") folded.stack = message.stack;
				else if (message.type === "models") folded.models = message.models;
				else if (message.type === "commands") folded.commands = message.commands;
			}
			sessions.set(id, folded);
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

	/**
	 * The chat area is not the landing page: it takes the same click on the active row a user
	 * makes. Without it every scenario would render as a session list, because the replay only
	 * ever delivers host messages and entering a chat is a webview-side decision.
	 */
	function enterReplayedSession() {
		const row = document.querySelector(".session-row.active");
		if (row instanceof HTMLElement) row.click();
	}

	async function start() {
		entries = await (await fetch(logPath)).json();
		index();
		for (const entry of entries) {
			if (entry.direction !== "toWebview") continue;
			// `sessions/open` only asks for the page the webview already shows on boot;
			// everything after it (`history/open`, `history`) is content and is replayed.
			deliver(entry.message);
		}
		document.body.dataset.replayed = String(entries.length);
		document.body.dataset.actions = [...bursts.keys()].join(",");
		// After the replayed messages, not in the middle of them: the click's answer is the
		// folded session above.
		setTimeout(enterReplayedSession, 0);
	}

	if (params.get("auto") !== "0") {
		// The webview bundle runs synchronously after this script; replay on load so
		// the webview has already sent its own `ready`.
		window.addEventListener("load", () => {
			void start();
		});
	}
})();
