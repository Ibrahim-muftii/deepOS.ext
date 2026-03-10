/**
 * DeepWork OS — Content Script
 *
 * Responsibilities:
 *  - Self-check on inject and show block overlay if out-of-scope (document_start fallback)
 *  - Track mouse clicks and key presses on in-scope tabs, flush on override/memo
 *  - Listen for UNBLOCK_PAGE, MEMO_WARN, MEMO_PROMPT messages from background
 *  - Show memo warning toast and memo prompt overlay
 *
 * Events sent to background (which forwards to backend):
 *  - OVERRIDE — user overrides a blocked site (with reason)
 *  - MEMO     — periodic check-in submitted by user
 *  NO other events are sent from content script.
 */

// ─── State ─────────────────────────────────────────────────────────────────
let isBlocked = false;
let sessionData = null;
let inScopeTab = false;

let clickCount = 0;
let keyPressCount = 0;

// ─── Core Logic (Runs on inject and tab switches) ────────────────────────
function checkBlockState() {
	chrome.storage.local.get(["dwos_session", "dwos_overrides"], (res) => {
		const session = res.dwos_session;
		if (!session) {
			// If no session exists, remove overlays and stop tracking
			if (isBlocked) unblockPage();
			sessionData = null;
			inScopeTab = false;
			return;
		}

		sessionData = session;
		const url = new URL(window.location.href);
		if (url.protocol.startsWith("chrome") || url.protocol.startsWith("about")) return;

		const overrides = res.dwos_overrides || {};
		const isOverridden = overrides[session.id]?.includes(url.hostname);
		const inScope = session.inScopeUrls?.some((s) => url.hostname.includes(s) || s.includes(url.hostname));

		inScopeTab = !!inScope;

		if (!inScope && !isOverridden) {
			if (!isBlocked) {
				isBlocked = true;
				waitForBody(() => showBlockOverlay(session));
			}
		} else {
			if (isBlocked) {
				unblockPage();
			}
			startTracking();
		}
	});
}

// Immediate self-check
checkBlockState();

function waitForBody(fn) {
	if (document.body || document.documentElement) {
		fn();
	} else {
		requestAnimationFrame(() => waitForBody(fn));
	}
}

// ─── Interaction tracking ────────────────────────────────────────────────────
let isTracking = false;
function startTracking() {
	if (isTracking) return;
	isTracking = true;

	window.addEventListener(
		"click",
		() => {
			if (!isBlocked) clickCount++;
		},
		{ passive: true },
	);
	window.addEventListener(
		"keydown",
		() => {
			if (!isBlocked) keyPressCount++;
		},
		{ passive: true },
	);
}

// ─── Message listener from background ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
	if (msg.type === "RE_EVALUATE") {
		checkBlockState();
	}

	if (msg.type === "UNBLOCK_PAGE") {
		unblockPage();
	}

	if (msg.type === "MEMO_WARN") {
		showMemoWarning();
	}

	if (msg.type === "MEMO_PROMPT") {
		showMemoPrompt(msg.session || sessionData);
	}
});

// ─── Overlays & Unblocking ───────────────────────────────────────────────────
function unblockPage() {
	const overlay = document.getElementById("dwos-block-overlay");
	if (overlay) overlay.remove();
	if (document.body) document.body.style.overflow = "";
	isBlocked = false;
	window.__dwosBlocked = false;
}

function showBlockOverlay(session) {
	if (document.getElementById("dwos-block-overlay")) return;

	const elapsed = Math.floor((Date.now() - new Date(session.startedAt || Date.now())) / 60000);

	const overlay = document.createElement("div");
	overlay.id = "dwos-block-overlay";
	overlay.style.cssText =
		"position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;" +
		"background:rgba(9,9,11,0.92);backdrop-filter:blur(20px);display:flex;" +
		"justify-content:center;align-items:center;font-family:system-ui,sans-serif;";

	overlay.innerHTML = `
		<div style="background:#fff;padding:40px 36px;border-radius:16px;max-width:420px;width:90%;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);">
			<p style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;margin-bottom:16px;font-weight:600;">DeepWork OS · Focus Protocol</p>
			<h1 style="font-size:26px;font-weight:700;color:#18181b;margin:0 0 10px;">You are off-task</h1>
			<p style="font-size:15px;color:#52525b;margin:0 0 6px;">Active session: <strong style="color:#18181b;">${session.taskName}</strong></p>
			<p style="font-size:13px;color:#a1a1aa;margin:0 0 28px;">${elapsed} min elapsed</p>
			<button id="dwos-back" style="display:block;width:100%;padding:13px;background:#18181b;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:12px;">← Go Back</button>
			<input type="text" id="dwos-reason" placeholder="Why do you need this? (required)" maxlength="100" style="width:100%;padding:11px 14px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;margin-bottom:10px;"/>
			<button id="dwos-override" style="display:block;width:100%;padding:11px;background:transparent;color:#71717a;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;">Override — I need this site</button>
		</div>
	`;

	(document.documentElement || document.body).appendChild(overlay);
	if (document.body) document.body.style.overflow = "hidden";

	overlay.querySelector("#dwos-back").onclick = () => window.history.back();

	overlay.querySelector("#dwos-override").onclick = () => {
		const reason = overlay.querySelector("#dwos-reason").value.trim();
		if (!reason) {
			overlay.querySelector("#dwos-reason").style.border = "1.5px solid #ef4444";
			overlay.querySelector("#dwos-reason").placeholder = "Reason is required to override!";
			return;
		}

		// Send OVERRIDE event to background — the ONLY override event we fire
		chrome.runtime
			.sendMessage({
				type: "OVERRIDE",
				sessionId: session.id,
				hostname: location.hostname,
				reason,
				mouseClicks: clickCount,
				keyPresses: keyPressCount,
			})
			.catch(() => {});

		clickCount = 0;
		keyPressCount = 0;

		unblockPage();
		inScopeTab = true;
		startTracking(); // resume tracking on overridden site
	};
}

// ─── Memo warning toast ──────────────────────────────────────────────────────
function showMemoWarning() {
	if (document.getElementById("dwos-memo-warn")) return;

	const toast = document.createElement("div");
	toast.id = "dwos-memo-warn";
	toast.style.cssText =
		"position:fixed;top:20px;right:20px;z-index:2147483647;background:#18181b;color:#fafafa;" +
		"padding:14px 20px;border-radius:10px;font-family:system-ui,sans-serif;font-size:14px;" +
		"box-shadow:0 10px 25px rgba(0,0,0,0.4);border:1px solid #3f3f46;max-width:300px;" +
		"animation:dwos-slide-in 0.3s ease;";
	toast.innerHTML =
		"<strong style='display:block;margin-bottom:4px;'>⏱ Check-in incoming</strong>" +
		"<span style='color:#a1a1aa;font-size:13px;'>You'll be asked what you're working on in ~1 minute.</span>";

	document.body?.appendChild(toast);
	setTimeout(() => {
		toast.style.opacity = "0";
		toast.style.transition = "opacity 0.4s";
		setTimeout(() => toast.remove(), 400);
	}, 8000);
}

// ─── Memo prompt overlay ────────────────────────────────────────────────────
function showMemoPrompt(session) {
	if (!session) return;
	if (document.getElementById("dwos-memo-overlay")) return;

	const overlay = document.createElement("div");
	overlay.id = "dwos-memo-overlay";
	overlay.style.cssText =
		"position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483648;" +
		"background:rgba(9,9,11,0.85);backdrop-filter:blur(20px);display:flex;" +
		"justify-content:center;align-items:center;font-family:system-ui,sans-serif;";

	overlay.innerHTML = `
		<div style="background:#fff;padding:40px 36px;border-radius:16px;max-width:440px;width:90%;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);">
			<p style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;margin-bottom:16px;font-weight:600;">DeepWork OS · Periodic Check-in</p>
			<h1 style="font-size:24px;font-weight:700;color:#18181b;margin:0 0 8px;">What are you working on?</h1>
			<p style="font-size:14px;color:#71717a;margin:0 0 28px;">Session: <strong style="color:#18181b;">${session.taskName}</strong></p>
			<textarea id="dwos-memo-input" placeholder="Describe what you're working on right now..." maxlength="200" style="width:100%;padding:12px 14px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;resize:none;height:90px;margin-bottom:14px;font-family:inherit;"></textarea>
			<button id="dwos-memo-save" style="display:block;width:100%;padding:13px;background:#18181b;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">Save & Continue</button>
		</div>
	`;

	document.documentElement.appendChild(overlay);
	if (document.body) document.body.style.overflow = "hidden";
	setTimeout(() => overlay.querySelector("#dwos-memo-input")?.focus(), 100);

	overlay.querySelector("#dwos-memo-save").onclick = () => {
		const memo = overlay.querySelector("#dwos-memo-input").value.trim();
		if (!memo) {
			overlay.querySelector("#dwos-memo-input").style.border = "1.5px solid #ef4444";
			overlay.querySelector("#dwos-memo-input").placeholder = "Please enter what you are working on!";
			return;
		}

		// Send MEMO event to background — the ONLY memo event we fire
		chrome.runtime
			.sendMessage({
				type: "MEMO",
				url: window.location.href,
				memo,
				mouseClicks: clickCount,
				keyPresses: keyPressCount,
			})
			.catch(() => {});
		clickCount = 0;
		keyPressCount = 0;

		overlay.remove();
		if (document.body) document.body.style.overflow = "";
	};
}
