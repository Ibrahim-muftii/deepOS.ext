window.addEventListener("message", (event) => {
	if (event.source !== window || !event.data || !["DWOS_AUTH_SYNC", "DWOS_AUTH_LOGOUT"].includes(event.data.type)) {
		return;
	}
	const { type, token } = event.data;
	if (type === "DWOS_AUTH_SYNC" && token) {
		chrome.storage.local.set({ dwos_token: token }, () => {
			console.log("DWOS Extension: Token synchronized.");
		});
	} else if (type === "DWOS_AUTH_LOGOUT") {
		chrome.storage.local.clear(() => {
			console.log("DWOS Extension: Logged out and storage cleared.");
		});
	}
});
