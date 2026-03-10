const API_URL = "http://localhost:5400/api/v1";
const DASHBOARD_URL = "http://localhost:3000/today";
const LOGIN_URL = "http://localhost:3000/login";

// Elements
const loadingState = document.getElementById("loading-state");
const sessionInfoState = document.getElementById("session-info");
const noSessionState = document.getElementById("no-session");
const lockedState = document.getElementById("locked-state");

const taskNameEl = document.getElementById("task-name");
const elapsedTimeEl = document.getElementById("elapsed-time");
const endSessionBtn = document.getElementById("end-session");

const startSessionForm = document.getElementById("start-session-form");
const startSessionBtn = document.getElementById("start-session-btn");
const inputTask = document.getElementById("input-task");
const inputMinutes = document.getElementById("input-minutes");
const inputProject = document.getElementById("input-project");
const inputUrls = document.getElementById("input-urls");

const openDashboardBtn = document.getElementById("open-dashboard");
const openLoginBtn = document.getElementById("open-login-dashboard");
const connectionStatus = document.getElementById("connection-status");

let currentToken = null;
let currentSession = null;
let timerInterval = null;

function showState(stateEl) {
	[loadingState, sessionInfoState, noSessionState, lockedState].forEach((el) => {
		el.style.display = "none";
	});
	stateEl.style.display = "flex";
}

function updateTimer() {
	if (!currentSession) {
		if (timerInterval) clearInterval(timerInterval);
		return;
	}

	const startedAt = new Date(currentSession.startedAt).getTime();
	const now = Date.now();
	const diffTotal = Math.max(0, now - startedAt);

	const declaredMinutes = currentSession.declaredMinutes || 25;
	const declaredMs = declaredMinutes * 60000;

	// Check if we've passed the limit
	if (diffTotal >= declaredMs) {
		elapsedTimeEl.innerText = "Protocol Complete";
		elapsedTimeEl.style.color = "#10b981"; // Success color
		if (timerInterval) clearInterval(timerInterval);
		return;
	}

	const diff = Math.max(0, now - startedAt);
	const hours = Math.floor(diff / 3600000);
	const mins = Math.floor((diff % 3600000) / 60000);
	const secs = Math.floor((diff % 60000) / 1000);

	const display = [String(hours).padStart(2, "0"), String(mins).padStart(2, "0"), String(secs).padStart(2, "0")].join(":");
	elapsedTimeEl.innerText = display;
	elapsedTimeEl.style.color = ""; // Reset
}

async function fetchProjects() {
	if (!currentToken) return;
	try {
		const res = await fetch(`${API_URL}/projects`, {
			headers: { Authorization: `Bearer ${currentToken}` },
		});
		if (res.ok) {
			const json = await res.json();
			const projects = json.data || [];

			while (inputProject.options.length > 1) {
				inputProject.remove(1);
			}

			projects.forEach((p) => {
				const opt = document.createElement("option");
				opt.value = p.id;
				opt.innerText = p.name;
				inputProject.appendChild(opt);
			});
		}
	} catch (e) {
		console.error("Failed to fetch projects", e);
	}
}

function initializeApp() {
	chrome.storage.local.get(["dwos_session", "dwos_token"], async (res) => {
		currentToken = res.dwos_token;
		currentSession = res.dwos_session;

		console.log("[DWOS POPUP] Initializing state:", { hasToken: !!currentToken, hasSession: !!currentSession });

		if (!currentToken) {
			connectionStatus.className = "status-dot disconnected";
			showState(lockedState);
			return;
		}

		connectionStatus.className = "status-dot connected";

		if (currentSession) {
			taskNameEl.innerText = currentSession.taskName;
			showState(sessionInfoState);
			if (timerInterval) clearInterval(timerInterval);
			updateTimer();
			timerInterval = setInterval(updateTimer, 1000);
		} else {
			if (timerInterval) clearInterval(timerInterval);
			showState(noSessionState);
			await fetchProjects();
		}
	});
}

document.addEventListener("DOMContentLoaded", () => {
	initializeApp();
});

chrome.storage.onChanged.addListener((changes, namespace) => {
	if (namespace === "local" && (changes.dwos_session || changes.dwos_token)) {
		initializeApp();
	}
});

openDashboardBtn.addEventListener("click", () => chrome.tabs.create({ url: DASHBOARD_URL }));
openLoginBtn.addEventListener("click", () => chrome.tabs.create({ url: LOGIN_URL }));

startSessionForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!currentToken) return;

	startSessionBtn.disabled = true;
	startSessionBtn.innerText = "Initiating Protocol...";

	const payload = {
		taskName: inputTask.value.trim(),
		declaredMinutes: parseInt(inputMinutes.value, 10),
		inScopeUrls: inputUrls.value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	};

	if (inputProject.value !== "none") {
		payload.projectId = parseInt(inputProject.value, 10);
	}

	try {
		const res = await fetch(`${API_URL}/sessions/start`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${currentToken}`,
			},
			body: JSON.stringify(payload),
		});

		const json = await res.json();
		if (res.ok) {
			console.log("[DWOS POPUP] Session start successful:", json.data.id);
		} else {
			alert("Failed to start session: " + (json.message || json.error || "Unknown error"));
		}
	} catch (err) {
		alert("Network error starting session.");
	} finally {
		startSessionBtn.disabled = false;
		startSessionBtn.innerText = "Initiate Protocol";
	}
});

endSessionBtn.addEventListener("click", async () => {
	if (!currentToken || !currentSession) return;

	endSessionBtn.disabled = true;
	endSessionBtn.innerText = "Terminating...";

	try {
		const res = await fetch(`${API_URL}/sessions/${currentSession.id}/end`, {
			method: "POST",
			headers: { Authorization: `Bearer ${currentToken}` },
		});

		if (res.ok) {
			chrome.storage.local.remove("dwos_session");
		} else {
			const json = await res.json();
			alert("Failed to end session: " + (json.message || json.error || "Unknown error"));
			endSessionBtn.disabled = false;
			endSessionBtn.innerText = "Terminate Focus Protocol";
		}
	} catch (err) {
		alert("Network error ending session.");
		endSessionBtn.disabled = false;
		endSessionBtn.innerText = "Terminate Focus Protocol";
	}
});
