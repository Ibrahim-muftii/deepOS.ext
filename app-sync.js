window.addEventListener("message", (event) => {
	// Only accept messages from the same window
	if (event.source !== window) return;

	// Check if this is a DWOS authentication message
	if (!event.data || !["DWOS_AUTH_SYNC", "DWOS_AUTH_LOGOUT"].includes(event.data.type)) {
		return;
	}

	const { type, token } = event.data;

	if (type === "DWOS_AUTH_SYNC" && token) {
		console.log("DWOS Extension Sync: Sync message received.");
		chrome.storage.local.set({ dwos_token: token }, () => {
			if (chrome.runtime.lastError) {
				console.error("DWOS Extension Sync: Failed to save token", chrome.runtime.lastError);
			} else {
				console.log("DWOS Extension Sync: Token saved successfully.");
			}
		});
	} else if (type === "DWOS_AUTH_LOGOUT") {
		console.log("DWOS Extension Sync: Logout message received.");
		chrome.storage.local.clear(() => {
			console.log("DWOS Extension Sync: Storage cleared.");
		});
	}
});

console.log("DWOS Extension Sync: Script initialized and listening for messages.");
