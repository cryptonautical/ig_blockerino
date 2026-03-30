/* Blockerino – Chrome Extension Service Worker (Manifest V3)
   Uses Instagram's private/mobile API (i.instagram.com) — same protocol
   as instagrapi / blockerino.py.  No external server needed.            */

const IG_BASE     = "https://i.instagram.com";
const IG_APP_ID   = "567067343352427";            // Android app ID
const DELAY_MIN   = 3000;                         // instagrapi delay_range[0]
const DELAY_MAX   = 6000;                         // instagrapi delay_range[1]
const PER_MIN_LIMIT = 6;
const ALARM_NAME  = "blockerino-tick";

// ── Persistent device IDs (like instagrapi's uuid / phone_id / android_device_id) ──

let deviceUuid = null;   // UUID v4
let phoneId    = null;   // UUID v4
let androidId  = null;   // "android-" + 16 hex chars

async function initDeviceIds() {
  const data = await chrome.storage.local.get("blockerino_device");
  if (data.blockerino_device) {
    deviceUuid = data.blockerino_device.uuid;
    phoneId    = data.blockerino_device.phoneId;
    androidId  = data.blockerino_device.androidId;
  } else {
    deviceUuid = crypto.randomUUID();
    phoneId    = crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    androidId = "android-" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ blockerino_device: { uuid: deviceUuid, phoneId, androidId } });
  }
}

// ── State ───────────────────────────────────────────────────────────

let state = {
  loggedIn: false,
  username: null,
  userId: null,
  queue: [],
  processing: false,
  stopRequested: false,
  paused: false,
  logs: [],
};

let storedCreds = null; // { username, password } for auto re-login
let pendingChallenge = null; // { apiPath, username, password, ... }
let authorizationToken = ""; // "Bearer IGT:2:..." from ig-set-authorization
let midToken = ""; // X-MID from ig-set-x-mid

async function saveState() {
  await chrome.storage.local.set({ blockerino: { queue: state.queue } });
}
async function loadState() {
  const data = await chrome.storage.local.get("blockerino");
  if (data.blockerino?.queue) state.queue = data.blockerino.queue;
}

// ── Instagram private-API helpers (mirrors instagrapi) ──────────────

async function getCsrfToken() {
  const c = await chrome.cookies.get({ url: "https://i.instagram.com", name: "csrftoken" });
  return c?.value || "";
}

const IG_APP_VERSION = "385.0.0.47.74";
const IG_VERSION_CODE = "378906843";
const IG_BLOKS_VERSION = "a8973d49a9cc6a6f65a4997c10216ce2a06f65a517010e64885e92029bb19221";

function igHeaders(csrf) {
  const h = {
    "X-CSRFToken": csrf || "",
    "X-IG-App-ID": IG_APP_ID,
    "X-IG-Device-ID": deviceUuid,
    "X-IG-Family-Device-ID": phoneId,
    "X-IG-Android-ID": androidId,
    "X-IG-Connection-Type": "WIFI",
    "X-IG-Capabilities": "3brTv10=",
    "X-IG-App-Locale": "en_US",
    "X-IG-Device-Locale": "en_US",
    "X-IG-App-Startup-Country": "US",
    "X-Bloks-Version-Id": IG_BLOKS_VERSION,
    "X-Bloks-Is-Layout-RTL": "false",
    "X-Bloks-Is-Panorama-Enabled": "true",
    "X-Requested-With": "com.instagram.android",
    "X-FB-HTTP-Engine": "Liger",
    "X-FB-Client-IP": "True",
    "X-FB-Server-Cluster": "True",
    "Accept-Language": "en-US",
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept": "*/*",
    "Host": "i.instagram.com",
    "Connection": "keep-alive",
  };
  if (authorizationToken) {
    h["Authorization"] = authorizationToken;
  }
  if (state.userId) {
    h["IG-U-DS-USER-ID"] = state.userId;
    h["IG-INTENDED-USER-ID"] = state.userId;
  }
  if (midToken) {
    h["X-MID"] = midToken;
  }
  return h;
}

// Random delay before every private-API call (instagrapi.delay_range = [3, 6])
function igDelay() {
  return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
}

// Generate jazoest token (same as instagrapi's generate_jazoest)
function generateJazoest(input) {
  let amount = 0;
  for (let i = 0; i < input.length; i++) amount += input.charCodeAt(i);
  return "2" + amount;
}

// Core fetch wrapper — retry-on-401 like instagrapi
async function igFetch(path, method = "GET", body = null) {
  await igDelay();
  const csrf = await getCsrfToken();
  const opts = {
    method,
    headers: igHeaders(csrf),
    credentials: "include",
  };
  if (body) {
    // Wrap POST data in signed_body format like instagrapi's generate_signature
    if (body instanceof URLSearchParams) {
      const jsonData = JSON.stringify(Object.fromEntries(body.entries()));
      opts.body = "signed_body=SIGNATURE." + encodeURIComponent(jsonData);
    } else {
      opts.body = body;
    }
  }
  if (method === "GET") {
    delete opts.headers["Content-Type"];
  }

  const resp = await fetch(IG_BASE + "/api/v1/" + path, opts);

  // Capture updated authorization / mid from any response (Instagram can refresh them)
  const newAuth = resp.headers.get("ig-set-authorization");
  if (newAuth) {
    authorizationToken = newAuth;
    chrome.storage.local.set({ blockerino_auth: authorizationToken });
  }
  const newMid = resp.headers.get("ig-set-x-mid");
  if (newMid) {
    midToken = newMid;
    chrome.storage.local.set({ blockerino_mid: midToken });
  }

  // Session expired
  if (resp.status === 401 || resp.status === 403) {
    const ok = await handleSessionLoss();
    if (!ok) throw new Error("Session expired — please log in again");
    return igFetch(path, method, body);
  }
  if (resp.status === 429) throw new Error("429 rate limited");

  const text = await resp.text();
  try {
    const data = JSON.parse(text);
    if (data.status === "fail" && data.message?.includes("login_required")) {
      const ok = await handleSessionLoss();
      if (!ok) throw new Error("Session expired — please log in again");
      return igFetch(path, method, body);
    }
    return data;
  } catch {
    // HTML / non-JSON — session dead
    const ok = await handleSessionLoss();
    if (!ok) throw new Error("Session expired — please log in again");
    return igFetch(path, method, body);
  }
}

// ── Login (replicates instagrapi login flow) ────────────────────────

async function igLogin(username, password) {
  // 1. Fetch headers to get a CSRF cookie (like instagrapi's pre_login_flow)
  const preHeaders = igHeaders("");
  delete preHeaders["Content-Type"];
  await fetch(IG_BASE + "/api/v1/si/fetch_headers/?challenge_type=signup&guid=" + deviceUuid, {
    headers: preHeaders,
    credentials: "include",
  });

  const csrf = await getCsrfToken();
  const ts = Math.floor(Date.now() / 1000);

  // 2. POST to login using signed_body format (same as instagrapi's generate_signature)
  const loginData = JSON.stringify({
    username,
    enc_password: `#PWD_INSTAGRAM:0:${ts}:${password}`,
    guid: deviceUuid,
    phone_id: phoneId,
    device_id: androidId,
    login_attempt_count: "0",
    jazoest: generateJazoest(phoneId),
  });
  const body = "signed_body=SIGNATURE." + encodeURIComponent(loginData);

  const resp = await fetch(IG_BASE + "/api/v1/accounts/login/", {
    method: "POST",
    headers: igHeaders(csrf),
    credentials: "include",
    body,
  });

  let data;
  try { data = await resp.json(); } catch {
    throw new Error("Unexpected response from Instagram.");
  }
  console.log("[Blockerino] Login response:", JSON.stringify(data));

  if (data.logged_in_user) {
    // Capture authorization token (critical — instagrapi does this)
    const authHeader = resp.headers.get("ig-set-authorization");
    if (authHeader) {
      authorizationToken = authHeader;
      await chrome.storage.local.set({ blockerino_auth: authorizationToken });
    }
    const mid = resp.headers.get("ig-set-x-mid");
    if (mid) {
      midToken = mid;
      await chrome.storage.local.set({ blockerino_mid: midToken });
    }
    storedCreds = { username, password };
    state.loggedIn = true;
    state.username = data.logged_in_user.username;
    state.userId = String(data.logged_in_user.pk);
    return { ok: true };
  }

  if (data.two_factor_required)
    throw new Error("Two-factor authentication required — disable it temporarily or use an app password.");

  // Challenge required — extract API path and return to popup for code input
  if (data.challenge || data.checkpoint_url) {
    const apiPath = data.challenge?.api_path || data.checkpoint_url;
    if (apiPath) {
      // Build challenge_context exactly like instagrapi does
      let challengeContext = data.challenge?.challenge_context || "";
      if (!challengeContext) {
        try {
          const parts = apiPath.split("/").filter(Boolean); // ["challenge", userId, nonceCode]
          const userId = parts[1];
          const nonceCode = parts[2];
          challengeContext = JSON.stringify({
            step_name: "",
            nonce_code: nonceCode,
            user_id: parseInt(userId),
            is_stateless: false,
          });
        } catch {}
      }

      pendingChallenge = { apiPath, username, password, contactPoint: "", challengeContext };

      try {
        // Step 1: GET the challenge URL with params (matches instagrapi's _send_private_request with params)
        const csrf2 = await getCsrfToken();
        const getHeaders = igHeaders(csrf2);
        delete getHeaders["Content-Type"];
        const params = new URLSearchParams({
          guid: deviceUuid,
          device_id: androidId,
          challenge_context: challengeContext,
        });
        const infoResp = await fetch(IG_BASE + apiPath + "?" + params.toString(), {
          headers: getHeaders,
          credentials: "include",
        });
        const info = await infoResp.json();
        console.log("[Blockerino] Challenge GET response:", JSON.stringify(info));

        const stepName = info.step_name || "";

        if (stepName === "select_verify_method") {
          // Check which methods are available (instagrapi checks step_data keys)
          const steps = info.step_data ? Object.keys(info.step_data) : [];
          const choice = steps.includes("email") ? "1" : "0"; // 1=email, 0=sms
          pendingChallenge.contactPoint = info.step_data?.contact_point || "";

          // Step 2: POST choice to trigger code send
          const csrf3 = await getCsrfToken();
          const selectResp = await fetch(IG_BASE + apiPath, {
            method: "POST",
            headers: igHeaders(csrf3),
            credentials: "include",
            body: "signed_body=SIGNATURE." + encodeURIComponent(JSON.stringify({ choice })),
          });
          const selectData = await selectResp.json();
          console.log("[Blockerino] Challenge choice POST response:", JSON.stringify(selectData));
          if (selectData.step_data?.contact_point) {
            pendingChallenge.contactPoint = selectData.step_data.contact_point;
          }
        } else if (stepName === "verify_email" || stepName === "verify_email_code" || stepName === "verify_code" || stepName === "submit_phone") {
          // Code was already sent
          pendingChallenge.contactPoint = info.step_data?.contact_point || "";
        } else if (stepName === "delta_login_review" || stepName === "scraping_warning") {
          // "Was this you?" — approve it (choice 0 = "It Was Me")
          const csrf3 = await getCsrfToken();
          await fetch(IG_BASE + apiPath, {
            method: "POST",
            headers: igHeaders(csrf3),
            credentials: "include",
            body: "signed_body=SIGNATURE." + encodeURIComponent(JSON.stringify({ choice: "0" })),
          });
          return igLogin(username, password);
        }
      } catch (e) {
        console.error("[Blockerino] Challenge flow error:", e);
      }

      return { ok: false, challenge: true, contactPoint: pendingChallenge.contactPoint || "" };
    }
  }

  throw new Error(data.message || "Invalid username or password.");
}

async function submitChallengeCode(code) {
  if (!pendingChallenge) throw new Error("No pending challenge.");
  const csrf = await getCsrfToken();
  const resp = await fetch(IG_BASE + pendingChallenge.apiPath, {
    method: "POST",
    headers: igHeaders(csrf),
    credentials: "include",
    body: "signed_body=SIGNATURE." + encodeURIComponent(JSON.stringify({ security_code: code })),
  });
  const data = await resp.json();

  if (data.logged_in_user) {
    storedCreds = { username: pendingChallenge.username, password: pendingChallenge.password };
    state.loggedIn = true;
    state.username = data.logged_in_user.username;
    state.userId = String(data.logged_in_user.pk);
    pendingChallenge = null;
    return { ok: true };
  }
  if (data.status === "ok" && data.action === "close") {
    // Challenge passed — finalize login
    storedCreds = { username: pendingChallenge.username, password: pendingChallenge.password };
    pendingChallenge = null;
    // Re-login now that the device is trusted
    return igLogin(storedCreds.username, storedCreds.password);
  }
  throw new Error(data.message || "Invalid verification code.");
}

async function resendChallengeCode() {
  if (!pendingChallenge) throw new Error("No pending challenge.");

  // Re-select method to retrigger code send (email=1, sms=0)
  const csrf = await getCsrfToken();
  const replayPath = pendingChallenge.apiPath.replace("/challenge/", "/challenge/replay/");
  await fetch(IG_BASE + replayPath, {
    method: "POST",
    headers: igHeaders(csrf),
    credentials: "include",
    body: "signed_body=SIGNATURE." + encodeURIComponent(JSON.stringify({ choice: "1" })),
  });
}

// ── Session recovery ────────────────────────────────────────────────

async function handleSessionLoss() {
  state.paused = true;
  broadcastState();
  log("Session lost — attempting re-login…");

  if (storedCreds) {
    try {
      await igLogin(storedCreds.username, storedCreds.password);
      state.paused = false;
      log("Re-login successful — resuming…");
      broadcastState();
      return true;
    } catch (e) {
      log("Auto re-login failed: " + e.message);
    }
  }

  broadcast({ type: "session_expired" });
  log("Please log in again from the popup.");

  for (let i = 0; i < 120; i++) {
    await sleep(15000);
    if (state.stopRequested) { state.paused = false; return false; }
    if (state.loggedIn) {
      state.paused = false;
      log("Session restored — resuming…");
      broadcastState();
      return true;
    }
  }
  state.paused = false;
  return false;
}

// ── Instagram operations ────────────────────────────────────────────

async function getUserInfo(username) {
  const data = await igFetch(`users/${encodeURIComponent(username)}/usernameinfo/`);
  if (!data.user) throw new Error(`User @${username} not found`);
  return { pk: String(data.user.pk), username: data.user.username };
}

async function getFollowing(userId, maxPages = 50) {
  const all = [];
  let maxId = null;
  for (let page = 0; page < maxPages; page++) {
    if (state.stopRequested) break;
    let path = `friendships/${userId}/following/?count=200`;
    if (maxId) path += `&max_id=${encodeURIComponent(maxId)}`;
    const data = await igFetch(path);
    const users = data.users || [];
    for (const u of users) all.push({ pk: String(u.pk), username: u.username });
    if (!data.next_max_id) break;
    maxId = data.next_max_id;
  }
  return all;
}

async function blockUser(userId) {
  return igFetch(`friendships/block/${userId}/`, "POST");
}

// Exponential-backoff retry matching blockerino.py's block_with_retry
async function blockUserWithRetry(userId, retries = 4, baseDelay = 60000) {
  let delay = baseDelay;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await blockUser(userId);
      return;
    } catch (e) {
      if (e.message.includes("429") && attempt < retries) {
        const jitter = Math.random() * 5000;
        log(`Rate limited; retrying in ${((delay + jitter) / 1000).toFixed(0)}s…`);
        await sleep(delay + jitter);
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
}

// ── Utilities ───────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  state.logs.push({ ts, msg });
  if (state.logs.length > 200) state.logs.shift();
  broadcast({ type: "log", ts, msg });
}

// ── Messaging ───────────────────────────────────────────────────────

const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "blockerino") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => handleMessage(msg, port));
  port.postMessage({ type: "state", state: getPublicState() });
});

function broadcast(msg) {
  for (const p of ports) { try { p.postMessage(msg); } catch {} }
}

function getPublicState() {
  return {
    loggedIn: state.loggedIn,
    username: state.username,
    queue: state.queue,
    processing: state.processing,
    stopRequested: state.stopRequested,
    paused: state.paused,
    logs: state.logs.slice(-50),
  };
}

function broadcastState() {
  broadcast({ type: "state", state: getPublicState() });
}

// ── Message handler ─────────────────────────────────────────────────

async function handleMessage(msg, port) {
  switch (msg.action) {
    case "get_state":
      port.postMessage({ type: "state", state: getPublicState() });
      break;

    case "login": {
      try {
        const result = await igLogin(msg.username, msg.password);
        if (result.challenge) {
          broadcast({ type: "challenge_required", contactPoint: result.contactPoint || "" });
        } else {
          broadcastState();
          broadcast({ type: "login_result", ok: true });
          startProcessing();
        }
      } catch (e) {
        broadcast({ type: "login_result", ok: false, message: e.message });
      }
      break;
    }

    case "challenge_submit": {
      try {
        const result = await submitChallengeCode(msg.code);
        if (result.challenge) {
          broadcast({ type: "challenge_required", contactPoint: result.contactPoint || "" });
        } else {
          broadcastState();
          broadcast({ type: "login_result", ok: true });
          startProcessing();
        }
      } catch (e) {
        broadcast({ type: "challenge_error", message: e.message });
      }
      break;
    }

    case "challenge_resend": {
      try {
        await resendChallengeCode();
        broadcast({ type: "challenge_resent" });
      } catch (e) {
        broadcast({ type: "challenge_error", message: e.message });
      }
      break;
    }

    case "logout": {
      storedCreds = null;
      authorizationToken = "";
      midToken = "";
      state.loggedIn = false;
      state.username = null;
      state.userId = null;
      if (state.processing) state.stopRequested = true;
      try {
        await chrome.storage.local.remove(["blockerino_auth", "blockerino_mid"]);
        for (const name of ["sessionid", "ds_user_id", "csrftoken", "mid", "ig_did", "rur"]) {
          await chrome.cookies.remove({ url: "https://i.instagram.com", name });
        }
      } catch {}
      broadcastState();
      break;
    }

    case "add_target": {
      const name = (msg.username || "").trim().replace(/^@/, "");
      if (!name || !/^[A-Za-z0-9._]{1,30}$/.test(name)) {
        port.postMessage({ type: "error", message: "Invalid username." });
        return;
      }
      if (state.queue.some(q => q.target === name && (q.status === "waiting" || q.status === "active"))) {
        port.postMessage({ type: "error", message: `@${name} is already in the queue.` });
        return;
      }
      state.queue.push({ target: name, status: "waiting", blocked: 0, failed: 0, total: 0, error: null });
      await saveState();
      broadcastState();
      startProcessing();
      break;
    }

    case "remove_target": {
      const name = (msg.username || "").trim().replace(/^@/, "");
      state.queue = state.queue.filter(q => !(q.target === name && q.status === "waiting"));
      await saveState();
      broadcastState();
      break;
    }

    case "stop": {
      if (state.processing) {
        state.stopRequested = true;
        log("Stop requested — finishing current action…");
        broadcastState();
      }
      break;
    }

    case "clear_history": {
      state.queue = state.queue.filter(q => q.status === "waiting" || q.status === "active");
      await saveState();
      broadcastState();
      break;
    }
  }
}

// ── Processing engine (mirrors blockerino.py main loop) ─────────────

function startProcessing() {
  if (state.processing || !state.loggedIn) return;
  processQueue();
}

async function processQueue() {
  if (state.processing) return;
  state.processing = true;
  state.stopRequested = false;
  broadcastState();

  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });

  while (true) {
    if (state.stopRequested) {
      for (const q of state.queue) if (q.status === "waiting") q.status = "stopped";
      log("Stopped.");
      break;
    }
    const next = state.queue.find(q => q.status === "waiting");
    if (!next) break;
    await processTarget(next);
  }

  state.processing = false;
  state.stopRequested = false;
  chrome.alarms.clear(ALARM_NAME);
  await saveState();
  broadcastState();
}

async function processTarget(entry) {
  entry.status = "active";
  broadcastState();
  log(`Starting @${entry.target}…`);

  try {
    const targetUser = await getUserInfo(entry.target);
    if (state.stopRequested) { entry.status = "stopped"; return; }

    log(`Fetching following list for @${entry.target}…`);
    const following = await getFollowing(targetUser.pk);
    if (state.stopRequested) { entry.status = "stopped"; return; }

    // Exclude accounts you follow (same as blockerino.py)
    let myPks = new Set();
    if (state.userId) {
      try {
        log("Fetching your following list to exclude…");
        const mine = await getFollowing(state.userId);
        myPks = new Set(mine.map(u => u.pk));
      } catch {}
    }
    if (state.stopRequested) { entry.status = "stopped"; return; }

    const toBlock = following.filter(u => !myPks.has(u.pk));
    entry.total = toBlock.length;
    log(`Blocking ${toBlock.length} accounts (skipped ${following.length - toBlock.length} you follow)…`);
    broadcastState();

    // Rate-limit window matching blockerino.py
    let actionsThisWindow = 0;
    let windowStart = Date.now();

    for (let i = 0; i < toBlock.length; i++) {
      if (state.stopRequested) {
        entry.status = "stopped";
        log(`Stopped @${entry.target} at ${entry.blocked}/${entry.total} blocked`);
        return;
      }

      // Enforce per-minute limit (matches enforce_rate_limit)
      const now = Date.now();
      if (now - windowStart >= 60000) {
        actionsThisWindow = 0;
        windowStart = now;
      }
      if (actionsThisWindow >= PER_MIN_LIMIT) {
        const waitMs = 60000 - (now - windowStart);
        if (waitMs > 0) {
          log(`Rate limit reached; pausing ${(waitMs / 1000).toFixed(0)}s…`);
          await sleep(waitMs);
        }
        actionsThisWindow = 0;
        windowStart = Date.now();
      }

      const u = toBlock[i];
      try {
        await blockUserWithRetry(u.pk);
        entry.blocked++;
        actionsThisWindow++;
      } catch (e) {
        if (e.message.includes("Session expired")) {
          const ok = await handleSessionLoss();
          if (!ok) { entry.status = "error"; entry.error = "Session lost"; return; }
          i--; continue; // retry
        }
        entry.failed++;
        log(`Failed @${u.username}: ${e.message}`);
      }

      broadcastState();
      // time.sleep(2.0 + random.uniform(0, 3)) from blockerino.py
      await sleep(2000 + Math.random() * 3000);
    }

    // Block the target profile itself (like blockerino.py)
    if (!state.stopRequested) {
      try {
        await blockUserWithRetry(targetUser.pk);
        log(`Blocked target @${entry.target}`);
      } catch {
        log(`Could not block @${entry.target} directly`);
      }
    }

    if (entry.status === "active") {
      entry.status = "done";
      log(`Done — @${entry.target}: ${entry.blocked} blocked, ${entry.failed} failed`);
    }
  } catch (e) {
    entry.status = "error";
    entry.error = e.message;
    log(`Error processing @${entry.target}: ${e.message}`);
  }

  await saveState();
  broadcastState();
}

// ── Keep service worker alive ───────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME && state.processing) { /* heartbeat */ }
});

// ── Init ────────────────────────────────────────────────────────────

initDeviceIds().then(() => loadState()).then(async () => {
  // Restore saved authorization token and mid
  const saved = await chrome.storage.local.get(["blockerino_auth", "blockerino_mid"]);
  if (saved.blockerino_auth) authorizationToken = saved.blockerino_auth;
  if (saved.blockerino_mid) midToken = saved.blockerino_mid;

  for (const q of state.queue) if (q.status === "active") q.status = "waiting";
  // Check if there's an existing session
  try {
    const csrf = await getCsrfToken();
    if (csrf) {
      const getHeaders = igHeaders(csrf);
      delete getHeaders["Content-Type"];
      const resp = await fetch(IG_BASE + "/api/v1/accounts/current_user/?edit=true", {
        headers: getHeaders,
        credentials: "include",
      });
      // Capture refreshed tokens
      const newAuth = resp.headers.get("ig-set-authorization");
      if (newAuth) {
        authorizationToken = newAuth;
        chrome.storage.local.set({ blockerino_auth: authorizationToken });
      }
      const newMid = resp.headers.get("ig-set-x-mid");
      if (newMid) {
        midToken = newMid;
        chrome.storage.local.set({ blockerino_mid: midToken });
      }
      const data = await resp.json();
      if (data.user) {
        state.loggedIn = true;
        state.username = data.user.username;
        state.userId = String(data.user.pk);
        if (state.queue.some(q => q.status === "waiting")) startProcessing();
      }
    }
  } catch {}
});
