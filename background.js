/**
 * DeepWork OS — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  1. Maintain WebSocket connection to backend for session sync
 *  2. Listen for tab switches/URL changes and forcibly inject block screen
 *  3. Propagate Overrides and Memos directly to the backend
 *  4. Handle global alarms (Memo interval checking)
 */

let ws = null;
let reconnectAttempts = 0;
let currentToken = null;

// ─── Boot: restore state ──────────────────────────────────────────────────────
chrome.storage.local.get(["dwos_token"], (res) => {
	if (res.dwos_token) {
		currentToken = res.dwos_token;
		connectWebSocket();
	}
});

// ─── React to storage changes (new token or session cleared) ─────────────────
chrome.storage.onChanged.addListener((changes, namespace) => {
	if (namespace !== "local") return;

	if (changes.dwos_token) {
		currentToken = changes.dwos_token.newValue ?? null;
		if (currentToken) {
			reconnectAttempts = 0;
			connectWebSocket();
		} else {
			ws?.close();
		}
	}
});

// ─── WebSocket helpers ────────────────────────────────────────────────────────
function connectWebSocket() {
	if (ws && ws.readyState !== WebSocket.CLOSED) return;
	if (!currentToken) return;

	ws = new WebSocket("ws://localhost:5400?token=" + currentToken);

	ws.onopen = () => {
		console.log("[DWOS WS] Connected");
		reconnectAttempts = 0;
	};

	ws.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			if (data.type === "SESSION_SYNC") {
				chrome.storage.local.get(["dwos_session"], (existing) => {
					if (!existing.dwos_session || existing.dwos_session.id !== data.session.id) {
						chrome.storage.local.set({
							dwos_session: data.session,
							dwos_memo_time: Date.now(),
							dwos_memo_notified: false,
						});
					} else {
						chrome.storage.local.set({ dwos_session: data.session });
					}
				});
			} else if (data.type === "SESSION_END") {
				chrome.storage.local.remove(["dwos_session", "dwos_overrides", "dwos_memo_time", "dwos_memo_notified"]);
			}
		} catch (_) {}
	};

	ws.onclose = (event) => {
		ws = null;
		if (event.code === 1008) {
			// A 1008 means the JWT Expired.
			// Do NOT instantly clear the token or log out the user!
			// Wait for the Dashboard to transparently refresh its cookie + push a new dwos_token!
			console.warn("[DWOS WS] Auth failed. Waiting for dashboard sync...");
			currentToken = null;
			return;
		}
		const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
		reconnectAttempts++;
		setTimeout(connectWebSocket, delay);
	};

	ws.onerror = () => {}; // onclose handles everything
}

/**
 * Send a single event directly to the backend over WebSocket.
 * Only fires if a session is active and WS is open.
 */
function sendEvent(eventPayload) {
	chrome.storage.local.get(["dwos_session"], (res) => {
		if (!res.dwos_session) return;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "ACTIVITY_BATCH", events: [eventPayload] }));
		}
	});
}

// ─── Tab Activity Triggers (Hard Blocking) ───────────────────────────────────

function enforceBlockOnTab(tabId, tabUrl) {
	console.log(`[DWOS] Checking block state for tab ${tabId} : ${tabUrl}`);

	if (!tabUrl || tabUrl.startsWith("chrome") || tabUrl.startsWith("about")) {
		console.log("[DWOS] System URL ignored.");
		return;
	}

	chrome.storage.local.get(["dwos_session", "dwos_overrides"], (res) => {
		const session = res.dwos_session;
		if (!session) {
			console.log("[DWOS] No active session.");
			return;
		}

		console.log(`[DWOS] Active session found: ${session.taskName}`);

		const overrides = res.dwos_overrides || {};
		const url = new URL(tabUrl);
		const isOverridden = overrides[session.id]?.includes(url.hostname);
		const inScope = session.inScopeUrls?.some((s) => url.hostname.includes(s) || s.includes(url.hostname));

		console.log(`[DWOS] inScope: ${inScope} | isOverridden: ${isOverridden}`);

		if (!inScope && !isOverridden) {
			console.log("[DWOS] Executing script to inject block screen natively...");
			chrome.scripting
				.executeScript({
					target: { tabId },
					func: (sessionData) => {
						// This runs directly inside the actual webpage!
						console.log("DWOS INJECTION SCRIPT EXECUTING ON PAGE");

						if (window.__dwosBlocked) return;
						window.__dwosBlocked = true;

						const existing = document.getElementById("dwos-block-overlay");
						if (existing) return;

						document.body?.style && (document.body.style.overflow = "hidden");

						const overlay = document.createElement("div");
						overlay.id = "dwos-block-overlay";
						overlay.style.cssText =
							"position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;" +
							"background:rgba(9,9,11,0.92);backdrop-filter:blur(20px);display:flex;" +
							"justify-content:center;align-items:center;flex-direction:column;font-family:system-ui,sans-serif;";

						const elapsed = Math.floor((Date.now() - new Date(sessionData.startedAt || Date.now())) / 60000);
						overlay.innerHTML = `
						<div style="background:#fff;padding:40px 36px;border-radius:16px;max-width:420px;width:90%;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);">
							<p style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;margin-bottom:16px;font-weight:600;">DeepWork OS · Focus Protocol</p>
							<h1 style="font-size:26px;font-weight:700;color:#18181b;margin:0 0 10px;">You are off-task</h1>
							<p style="font-size:15px;color:#52525b;margin:0 0 6px;">Active session: <strong style="color:#18181b;">${sessionData.taskName}</strong></p>
							<p style="font-size:13px;color:#a1a1aa;margin:0 0 28px;">${elapsed} min elapsed</p>
							<button id="dwos-back" style="display:block;width:100%;padding:13px;background:#18181b;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:12px;">← Go Back</button>
							<input type="text" id="dwos-reason" placeholder="Why do you need this? (required)" maxlength="100" style="width:100%;padding:11px 14px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;margin-bottom:10px;"/>
							<button id="dwos-override" style="display:block;width:100%;padding:11px;background:transparent;color:#71717a;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;">Override — I need this site</button>
						</div>
					`;

						(document.documentElement || document.body).appendChild(overlay);

						overlay.querySelector("#dwos-back").onclick = () => window.history.back();
						overlay.querySelector("#dwos-override").onclick = () => {
							const reason = overlay.querySelector("#dwos-reason").value.trim();
							if (!reason) {
								overlay.querySelector("#dwos-reason").style.border = "1.5px solid #ef4444";
								overlay.querySelector("#dwos-reason").placeholder = "Reason is required!";
								return;
							}
							chrome.runtime.sendMessage({ type: "OVERRIDE", sessionId: sessionData.id, hostname: location.hostname, reason });
							overlay.remove();
							document.body.style.overflow = "";
							window.__dwosBlocked = false;
						};
					},
					args: [session],
				})
				.then(() => console.log("[DWOS] Injection successful!"))
				.catch((e) => console.log("[DWOS] Injection failed (content.js might handle it):", e.message));
		} else {
			// Tab is allowed, force unblock if it was blocked previously
			chrome.tabs.sendMessage(tabId, { type: "UNBLOCK_PAGE" }).catch(() => {});
		}
	});
}

// When user switches tabs natively
chrome.tabs.onActivated.addListener((activeInfo) => {
	console.log("[DWOS] TAB CHANGED (onActivated)");
	chrome.tabs.get(activeInfo.tabId, (tab) => {
		if (chrome.runtime.lastError || !tab) return;
		enforceBlockOnTab(tab.id, tab.url || tab.pendingUrl);
	});
});

// For Single Page Applications (React, Next.js, Twitter, YouTube):
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.url || changeInfo.status === "complete") {
		console.log("[DWOS] TAB UPDATED (onUpdated)");
		enforceBlockOnTab(tabId, tab.url || tab.pendingUrl);
	}
});

// ─── Listen for events forwarded from content scripts ────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg.type === "OVERRIDE") {
		// Save override to bypass map
		chrome.storage.local.get(["dwos_overrides"], (res) => {
			const overrides = res.dwos_overrides || {};
			if (!overrides[msg.sessionId]) overrides[msg.sessionId] = [];
			if (!overrides[msg.sessionId].includes(msg.hostname)) {
				overrides[msg.sessionId].push(msg.hostname);
			}
			chrome.storage.local.set({ dwos_overrides: overrides });
		});

		sendEvent({
			url: `https://${msg.hostname}`,
			state: "override",
			reason: msg.reason,
			mouseClicks: msg.mouseClicks ?? 0,
			keyPresses: msg.keyPresses ?? 0,
			timestamp: new Date().toISOString(),
		});
	}

	if (msg.type === "MEMO") {
		sendEvent({
			url: msg.url,
			state: "memo",
			reason: msg.memo,
			mouseClicks: msg.mouseClicks ?? 0,
			keyPresses: msg.keyPresses ?? 0,
			timestamp: new Date().toISOString(),
		});
	}
});

// ─── Memo check-in alarm (every 1 minute, real decision inside) ──────────────
chrome.alarms.clearAll(() => {
	chrome.alarms.create("memoCheck", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== "memoCheck") return;

	chrome.storage.local.get(["dwos_session", "dwos_memo_time", "dwos_memo_notified"], (res) => {
		if (!res.dwos_session) return;

		const now = Date.now();
		const lastMemo = res.dwos_memo_time ?? now;
		const minutesSince = (now - lastMemo) / 60000;

		// Warn at 7 min, prompt at 8-13 min window
		if (minutesSince >= 7 && minutesSince < 8 && !res.dwos_memo_notified) {
			chrome.storage.local.set({ dwos_memo_notified: true });
			// Notify the visible tab
			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "MEMO_WARN" }).catch(() => {});
			});
		}

		if (minutesSince >= 8) {
			// Reset timer immediately so we don't keep firing
			chrome.storage.local.set({ dwos_memo_time: now, dwos_memo_notified: false });
			// Prompt the visible tab
			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				if (tabs[0]) {
					chrome.storage.local.get(["dwos_overrides"], (overrideRes) => {
						const overrides = overrideRes.dwos_overrides || {};
						const session = res.dwos_session;
						chrome.tabs.get(tabs[0].id, (tab) => {
							if (chrome.runtime.lastError || !tab?.url) return;
							const url = new URL(tab.url);
							const inScope = session.inScopeUrls?.some((s) => url.hostname.includes(s) || s.includes(url.hostname));
							const isOverridden = overrides[session.id]?.includes(url.hostname);

							if (inScope || isOverridden) {
								chrome.tabs.sendMessage(tabs[0].id, { type: "MEMO_PROMPT", session }).catch(() => {});
							}
						});
					});
				}
			});
		}
	});
});
