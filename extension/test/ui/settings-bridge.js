// Harness host bridge for the settings page. Supplies `acquireVsCodeApi()` and replays
// test/ui/settings-snapshot.json - recorded from the real SettingsService by
// scripts/record-settings-snapshot.mjs - into the shipped webview bundle, so the page
// renders the same snapshot the panel would post. Nothing is invented here: the host
// only ever sends `snapshot` / `busy` / `notice`.
//
// URL parameters:
//   page=roles       click that rail item after the snapshot lands
//   query=claude     type into the search box through a real `input` event
//   auto=0           do not replay on load (lets a test drive the page itself)
(() => {
	const params = new URLSearchParams(location.search);
	const snapshotPath = params.get("snapshot") ?? "./settings-snapshot.json";
	const outbound = [];
	window.__harnessLog = outbound;

	window.acquireVsCodeApi = () => ({
		postMessage: (message) => {
			outbound.push(message);
			document.body.dataset.lastOutbound = JSON.stringify(message).slice(0, 400);
			document.body.dataset.outboundCount = String(outbound.length);
			// `ready` (boot) and `refresh` (the header button) are the two messages whose
			// host answer is "here is the current snapshot"; no write is simulated.
			if (message.type === "ready" || message.type === "refresh") void replay();
		},
		state: undefined,
		setState: () => {},
	});

	async function replay() {
		const response = await fetch(snapshotPath);
		const snapshot = await response.json();
		window.postMessage({ type: "snapshot", snapshot }, "*");
		// `postMessage` lands as a task, so give the bundle's listener its turn before
		// anything drives the freshly rendered page.
		await new Promise((resolve) => setTimeout(resolve, 0));
		document.body.dataset.replayed = snapshotPath;
	}

	async function drive() {
		const page = params.get("page");
		if (page) {
			const item = document.querySelector(`.settings-nav-item[data-nav="${page}"]`);
			if (!(item instanceof HTMLElement)) throw new Error(`没有这个分类：${page}`);
			item.click();
		}
		const query = params.get("query");
		if (query) {
			const box = document.querySelector(".settings-search");
			if (!(box instanceof HTMLInputElement)) throw new Error("没有搜索框");
			box.focus();
			box.value = query;
			box.dispatchEvent(new Event("input"));
		}
	}

	// The bundle runs synchronously after this script and posts `ready` itself.
	if (params.get("auto") !== "0") {
		window.addEventListener("load", () => {
			// `ready` fires before `load`, so the replay is already in flight; chaining
			// onto a fresh one keeps the driving ordered after a rendered page.
			void replay()
				.then(drive)
				.then(() => {
					document.body.dataset.ready = "1";
				})
				.catch((error) => {
					document.body.dataset.error = String(error);
					console.error(error);
				});
		});
	}
})();
