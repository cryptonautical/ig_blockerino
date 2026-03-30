/* Blockerino – Popup script */

const port = chrome.runtime.connect({ name: "blockerino" });

// ── DOM refs ────────────────────────────────────────────────────────
const badge      = document.getElementById("badge");
const userInfo   = document.getElementById("user-info");
const loginView  = document.getElementById("login-view");
const loginForm  = document.getElementById("login-form");
const igUser     = document.getElementById("ig-user");
const igPass     = document.getElementById("ig-pass");
const btnLogin   = document.getElementById("btn-login");
const loginError = document.getElementById("login-error");
const btnLogout  = document.getElementById("btn-logout");
const main       = document.getElementById("main");
const addForm    = document.getElementById("add-form");
const targetIn   = document.getElementById("target-input");
const queueList  = document.getElementById("queue-list");
const progWrap   = document.getElementById("prog-wrap");
const progBar    = document.getElementById("prog-bar");
const pCount     = document.getElementById("p-count");
const pOk        = document.getElementById("p-ok");
const pFail      = document.getElementById("p-fail");
const logBox     = document.getElementById("log-box");
const histList   = document.getElementById("history-list");
const clearHist  = document.getElementById("clear-hist");
const toastEl    = document.getElementById("toast");
const btnStop    = document.getElementById("btn-stop");
const stopRow    = document.getElementById("stop-row");
const sessBanner = document.getElementById("session-banner");
const challengeView  = document.getElementById("challenge-view");
const challengeForm  = document.getElementById("challenge-form");
const challengeCode  = document.getElementById("challenge-code");
const challengeInfo  = document.getElementById("challenge-info");
const btnVerify      = document.getElementById("btn-verify");
const btnResend      = document.getElementById("btn-resend");
const challengeError = document.getElementById("challenge-error");

let currentState = null;

// ── Messaging ───────────────────────────────────────────────────────

port.onMessage.addListener((msg) => {
  if (msg.type === "state") {
    currentState = msg.state;
    render();
  } else if (msg.type === "log") {
    appendLog(msg.ts, msg.msg);
  } else if (msg.type === "error") {
    toast(msg.message);
  } else if (msg.type === "login_result") {
    btnLogin.disabled = false;
    btnLogin.textContent = "Log in";
    if (msg.ok) {
      loginError.style.display = "none";
      challengeView.style.display = "none";
    } else {
      loginError.textContent = msg.message || "Login failed.";
      loginError.style.display = "block";
    }
  } else if (msg.type === "challenge_required") {
    btnLogin.disabled = false;
    btnLogin.textContent = "Log in";
    loginView.style.display = "none";
    challengeView.style.display = "block";
    challengeError.style.display = "none";
    if (msg.contactPoint) {
      challengeInfo.textContent = "Enter the code sent to " + msg.contactPoint;
    } else {
      challengeInfo.textContent = "Enter the code sent to your email or phone.";
    }
    challengeCode.value = "";
    challengeCode.focus();
  } else if (msg.type === "challenge_error") {
    btnVerify.disabled = false;
    btnVerify.textContent = "Verify";
    challengeError.textContent = msg.message || "Invalid code.";
    challengeError.style.display = "block";
  } else if (msg.type === "challenge_resent") {
    btnResend.textContent = "Code resent!";
    setTimeout(() => { btnResend.textContent = "Resend code"; }, 2000);
  } else if (msg.type === "session_expired") {
    sessBanner.style.display = "block";
  }
});

// Ask background for current state on open
port.postMessage({ action: "get_state" });

// ── Actions ─────────────────────────────────────────────────────────

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const username = igUser.value.trim();
  const password = igPass.value;
  if (!username || !password) return;
  btnLogin.disabled = true;
  btnLogin.textContent = "Logging in…";
  loginError.style.display = "none";
  port.postMessage({ action: "login", username, password });
});

challengeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = challengeCode.value.trim();
  if (!code) return;
  btnVerify.disabled = true;
  btnVerify.textContent = "Verifying…";
  challengeError.style.display = "none";
  port.postMessage({ action: "challenge_submit", code });
});

btnResend.addEventListener("click", (e) => {
  e.preventDefault();
  port.postMessage({ action: "challenge_resend" });
});

btnLogout.addEventListener("click", () => {
  port.postMessage({ action: "logout" });
});

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = targetIn.value.trim().replace(/^@/, "");
  if (!v) return;
  port.postMessage({ action: "add_target", username: v });
  targetIn.value = "";
});

clearHist.addEventListener("click", () => {
  port.postMessage({ action: "clear_history" });
});

btnStop.addEventListener("click", () => {
  btnStop.disabled = true;
  btnStop.textContent = "Stopping…";
  port.postMessage({ action: "stop" });
});

// ── Render ──────────────────────────────────────────────────────────

function render() {
  const s = currentState;
  if (!s) return;

  if (s.loggedIn) {
    badge.textContent = "@" + s.username;
    userInfo.style.display = "flex";
    loginView.style.display = "none";
    challengeView.style.display = "none";
    main.style.display = "block";
  } else if (challengeView.style.display === "block") {
    // Stay on challenge view, don't flip back to login
    return;
  } else {
    badge.textContent = "";
    userInfo.style.display = "none";
    loginView.style.display = "block";
    challengeView.style.display = "none";
    main.style.display = "none";
    return;
  }

  // Stop button visibility
  if (s.processing && !s.stopRequested) {
    stopRow.style.display = "block";
    btnStop.disabled = false;
    btnStop.textContent = "Stop Blocking";
  } else if (s.stopRequested) {
    stopRow.style.display = "block";
    btnStop.disabled = true;
    btnStop.textContent = "Stopping…";
  } else {
    stopRow.style.display = "none";
  }

  // Session banner
  sessBanner.style.display = s.paused ? "block" : "none";

  // Queue
  const active  = s.queue.filter(q => q.status === "active");
  const waiting = s.queue.filter(q => q.status === "waiting");
  const items   = [...active, ...waiting];

  queueList.innerHTML = "";
  if (!items.length) {
    queueList.innerHTML = '<div class="empty">Queue is empty.</div>';
    progWrap.style.display = "none";
  } else {
    for (const q of items) {
      const row = document.createElement("div");
      row.className = "queue-item";

      const left = document.createElement("div");
      left.className = "qi-left";

      const dot = document.createElement("span");
      dot.className = "qi-dot " + (q.status === "active" ? "active" : "waiting");

      const name = document.createElement("span");
      name.className = "qi-name";
      name.textContent = "@" + q.target;

      const stat = document.createElement("span");
      stat.className = "qi-stat";
      if (q.status === "active" && q.total > 0) {
        stat.textContent = `${q.blocked + q.failed}/${q.total}`;
      } else if (q.status === "active") {
        stat.textContent = "loading…";
      } else {
        stat.textContent = "waiting";
      }

      left.append(dot, name, stat);
      row.appendChild(left);

      if (q.status === "waiting") {
        const btn = document.createElement("button");
        btn.className = "qi-remove";
        btn.textContent = "✕";
        btn.addEventListener("click", () => {
          port.postMessage({ action: "remove_target", username: q.target });
        });
        row.appendChild(btn);
      }
      queueList.appendChild(row);
    }

    // Progress bar for active target
    if (active.length && active[0].total > 0) {
      const a = active[0];
      const done = a.blocked + a.failed;
      const pct = Math.round((done / a.total) * 100);
      progWrap.style.display = "block";
      progBar.style.width = pct + "%";
      pCount.textContent = done + " / " + a.total;
      pOk.textContent = a.blocked + " blocked";
      pFail.textContent = a.failed + " failed";
    } else {
      progWrap.style.display = "none";
    }
  }

  // Logs (initial render from state)
  if (logBox.children.length === 0 && s.logs.length) {
    for (const l of s.logs) appendLog(l.ts, l.msg);
  }

  // History
  const finished = s.queue.filter(q => q.status === "done" || q.status === "error" || q.status === "stopped");
  histList.innerHTML = "";
  if (!finished.length) {
    histList.innerHTML = '<div class="empty">No completed targets yet.</div>';
  } else {
    for (const h of finished.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "hist-item";

      const icon = document.createElement("span");
      icon.className = "hi-icon";
      icon.textContent = h.status === "done" ? "✓" : h.status === "stopped" ? "■" : "✗";
      icon.style.color = h.status === "done" ? "var(--green)" : h.status === "stopped" ? "var(--yellow)" : "var(--red)";

      const name = document.createElement("span");
      name.textContent = "@" + h.target;
      name.style.fontWeight = "500";

      const stats = document.createElement("span");
      stats.className = "hi-stats";
      if (h.status === "stopped") {
        stats.textContent = `${h.blocked} blocked (stopped)`;
      } else if (h.status === "done") {
        stats.textContent = `${h.blocked} blocked, ${h.failed} failed`;
      } else {
        stats.textContent = h.error || "Error";
      }

      row.append(icon, name, stats);
      histList.appendChild(row);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function appendLog(ts, msg) {
  const d = document.createElement("div");
  const t = document.createElement("span");
  t.className = "log-ts";
  t.textContent = ts;
  d.appendChild(t);
  d.appendChild(document.createTextNode(msg));
  logBox.appendChild(d);
  logBox.scrollTop = logBox.scrollHeight;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3000);
}
