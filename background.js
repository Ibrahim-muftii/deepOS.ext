/**
 * DeepWork OS — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  1. Maintain WebSocket connection to backend for session sync
 *  2. Listen for tab switches/URL changes and forcibly inject block screen
 *  3. Handle global alarms (Memo interval checking)
 *  4. Heartbeat every 60s to maintain session persistence
 */

let ws = null;
let reconnectAttempts = 0;
let currentToken = null;
let lastActionWasOverride = false;

console.log("[DWOS BG] Background script loaded");

// ─── Boot: restore state ──────────────────────────────────────────────────────
chrome.storage.local.get(["dwos_token", "dwos_session"], (res) => {
	console.log("[DWOS BG] Initializing with storage:", { hasToken: !!res.dwos_token, hasSession: !!res.dwos_session });
	if (res.dwos_token) {
		currentToken = res.dwos_token;
		connectWebSocket();
	}
});

// ─── React to storage changes (new token or session cleared) ─────────────────
chrome.storage.onChanged.addListener((changes, namespace) => {
	if (namespace !== "local") return;

	if (changes.dwos_token) {
		const oldToken = changes.dwos_token.oldValue;
		const newToken = changes.dwos_token.newValue ?? null;

		console.log("[DWOS BG] Token storage changed", { changed: oldToken !== newToken });

		if (newToken && oldToken !== newToken) {
			console.log("[DWOS BG] New token received, reconnecting WebSocket...");
			currentToken = newToken;
			reconnectAttempts = 0;
			if (ws) {
				ws.close();
			}
			connectWebSocket();
		} else if (!newToken) {
			console.log("[DWOS BG] Token cleared, closing WebSocket.");
			currentToken = null;
			ws?.close();
		}
	}
});

// ─── WebSocket helpers ────────────────────────────────────────────────────────
function connectWebSocket() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	if (!currentToken) return;

	console.log("[DWOS WS] Connecting to ws://localhost:5400...");
	ws = new WebSocket("ws://localhost:5400?token=" + currentToken);

	ws.onopen = () => {
		console.log("[DWOS WS] Connected successfully");
		reconnectAttempts = 0;
	};

	ws.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			console.log("[DWOS WS] Message received:", data.type);

			if (data.type === "SESSION_SYNC") {
				if (data.session) {
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
				} else {
					console.log("[DWOS WS] Handshake received null session. Cleaning up.");
					chrome.storage.local.remove(["dwos_session", "dwos_overrides", "dwos_memo_time", "dwos_memo_notified"]);
				}
			} else if (data.type === "SESSION_END") {
				console.log("[DWOS WS] Server signaled session end.");
				chrome.storage.local.remove(["dwos_session", "dwos_overrides", "dwos_memo_time", "dwos_memo_notified"]);
			}
		} catch (err) {
			console.error("[DWOS WS] Sync error:", err);
		}
	};

	ws.onclose = (event) => {
		console.log(`[DWOS WS] Connection closed (code: ${event.code})`);
		ws = null;

		if (event.code === 1008) {
			console.warn("[DWOS WS] Auth failed. Check token secret.");
			return;
		}

		if (currentToken) {
			const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
			reconnectAttempts++;
			setTimeout(connectWebSocket, delay);
		}
	};
}

/**
 * Send a single event directly to the backend over WebSocket.
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
	if (!tabUrl || tabUrl.startsWith("chrome") || tabUrl.startsWith("about")) return;

	chrome.storage.local.get(["dwos_session", "dwos_overrides"], (res) => {
		const session = res.dwos_session;
		if (!session) return;

		// ── CHECK FOR LOCAL EXPIRATION ────────────────────────────────────
		const now = new Date();
		const start = new Date(session.startedAt);
		const elapsedMinutes = Math.floor((now - start) / 60000);

		if (elapsedMinutes >= session.declaredMinutes) {
			console.log(`[DWOS BG] Session limit reached (${elapsedMinutes}m). Releasing block.`);
			chrome.tabs.sendMessage(tabId, { type: "UNBLOCK_PAGE" }).catch(() => {});
			return;
		}

		const overrides = res.dwos_overrides || {};
		const url = new URL(tabUrl);
		const isOverridden = overrides[session.id]?.includes(url.hostname);
		const inScope = session.inScopeUrls?.some((s) => url.hostname.includes(s) || s.includes(url.hostname));

		if (!inScope && !isOverridden) {
			chrome.scripting
				.executeScript({
					target: { tabId },
					func: (sessionData) => {
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
				.catch(() => {});
		} else {
			chrome.tabs.sendMessage(tabId, { type: "UNBLOCK_PAGE" }).catch(() => {});
		}
	});
}

// ─── Tab Event Listeners ─────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener((activeInfo) => {
	chrome.tabs.get(activeInfo.tabId, (tab) => {
		if (chrome.runtime.lastError || !tab) return;
		const tabUrl = tab.url || tab.pendingUrl;
		enforceBlockOnTab(tab.id, tabUrl);

		if (!tabUrl || tabUrl.startsWith("chrome") || tabUrl.startsWith("about")) return;

		chrome.storage.local.get(["dwos_session", "dwos_overrides"], (res) => {
			const session = res.dwos_session;
			if (!session) return;

			const url = new URL(tabUrl);
			const overrides = res.dwos_overrides || {};
			const isOverridden = overrides[session.id]?.includes(url.hostname);
			const inScope = session.inScopeUrls?.some((s) => url.hostname.includes(s) || s.includes(url.hostname));

			if (inScope || isOverridden) {
				if (lastActionWasOverride) {
					lastActionWasOverride = false;
					return;
				}
				sendEvent({
					url: tabUrl,
					state: "tab_changed",
					reason: null,
					mouseClicks: 0,
					keyPresses: 0,
					timestamp: new Date().toISOString(),
				});
			}
		});
	});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.url || changeInfo.status === "complete") {
		enforceBlockOnTab(tabId, tab.url || tab.pendingUrl);
	}
});

// ─── Message listener ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg.type === "OVERRIDE") {
		lastActionWasOverride = true;
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
			mouseClicks: 0,
			keyPresses: 0,
			timestamp: new Date().toISOString(),
		});
	}

	if (msg.type === "MEMO") {
		chrome.storage.local.set({ dwos_memo_time: Date.now(), dwos_memo_notified: false });
		sendEvent({
			url: msg.url,
			state: "memo",
			reason: msg.memo,
			mouseClicks: 0,
			keyPresses: 0,
			timestamp: new Date().toISOString(),
		});
	}
});

// ─── Alarms ──────────────────────────────────────────────────────────────────
chrome.alarms.clearAll(() => {
	chrome.alarms.create("heartbeatAndMemo", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== "heartbeatAndMemo") return;

	// 1. WebSocket Heartbeat
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "HEARTBEAT" }));
	}

	chrome.storage.local.get(["dwos_session", "dwos_memo_time", "dwos_memo_notified"], (res) => {
		const session = res.dwos_session;
		if (!session) return;

		const now = Date.now();

		// 2. Auto-termination check (Release blocks automatically)
		const startedAt = new Date(session.startedAt);
		const elapsedMinutes = (now - startedAt) / 60000;
		if (elapsedMinutes >= session.declaredMinutes) {
			console.log("[DWOS BG] Alarm: Session limit reached. Broadcasting UNBLOCK.");
			chrome.tabs.query({}, (tabs) => {
				tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: "UNBLOCK_PAGE" }).catch(() => {}));
			});
			// We don't remove the session locally here yet; let the server SESSION_END signal do it or user manual end.
			return;
		}

		// 3. Memo Logic
		const lastMemo = res.dwos_memo_time ?? now;
		const minutesSince = (now - lastMemo) / 60000;

		// Warning at 7 minutes
		if (minutesSince >= 7 && minutesSince < 8 && !res.dwos_memo_notified) {
			chrome.storage.local.set({ dwos_memo_notified: true });
			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "MEMO_WARN" }).catch(() => {});
			});
		}

		// Prompt at 8 minutes
		if (minutesSince >= 8) {
			// CRITICAL: We DON'T reset dwos_memo_time here anymore.
			// We only reset it once the user actually clicks SAVE in the content script and sends the MEMO message back.
			// This ensures the prompt keeps appearing (via the alarm firing every minute while > 8) if ignored.

			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				if (tabs[0]) {
					chrome.storage.local.get(["dwos_overrides"], (overrideRes) => {
						const overrides = overrideRes.dwos_overrides || {};
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
