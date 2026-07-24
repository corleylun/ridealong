/* Ridealong — background (WebSocket client + broker + tab/DOM executor).
 *
 * Connects OUT to the local bridge (ws://127.0.0.1:PORT), authenticates with the
 * shared token, then executes commands the bridge (or a driver .mjs) relays from
 * the AI agent. All page work is done with browser.tabs.* + tabs.executeScript in
 * the REAL browser — no CDP, real session/cookies/fingerprint.
 *
 * ── Governance layer (PLAN.md, Tier 1) ─────────────────────────────────────
 * `dispatch()` below is the SINGLE chokepoint for every tool call, from either MCP
 * mode (via bridge.js) or driver mode (a standalone .mjs that IS the WS server and
 * talks straight to this file, bypassing bridge.js entirely). Because driver mode
 * bypasses bridge.js, the broker MUST live here — bridge.js can gate too (defense
 * in depth) but this file is the authoritative boundary. See PLAN.md §3.
 *
 * Order of checks per call (every non-allow branch is a DENY — fail closed):
 *   1. resolve target tab (§4)              5. epoch re-check before dispatch (§7)
 *   2. mode gate (§2)                       6. execute
 *   3. input validation                     7. audit-emit, fail-closed on write failure (§6)
 *   4. approval in trusted chrome (§5)
 */

const DEFAULTS = { port: 8765, token: "" };
let ws = null;
let reconnectTimer = null;
let desired = false; // whether the user wants us connected

const state = { status: "disconnected", detail: "" };

function setStatus(status, detail = "") {
  state.status = status;
  state.detail = detail;
  browser.runtime.sendMessage({ type: "status", status, detail }).catch(() => {});
}

async function getConfig() {
  const c = await browser.storage.local.get(["port", "token"]);
  return { port: c.port || DEFAULTS.port, token: c.token || DEFAULTS.token };
}

// Silently drop the current socket: detach ALL its handlers (esp. onclose) so its
// close never triggers a reconnect, then close it. This is the fix for the
// connect/disconnect loop — see connect().
function teardownSocket() {
  if (!ws) return;
  const old = ws;
  ws = null;
  try { old.onopen = old.onmessage = old.onerror = old.onclose = null; old.close(); } catch {}
}

async function connect() {
  desired = true;
  clearTimeout(reconnectTimer);
  // Idempotent: if we already hold an OPEN socket, a redundant connect() (e.g. the
  // popup dialing on open) is a no-op — don't churn a working connection.
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const { port, token } = await getConfig();
  if (!token) { setStatus("error", "no token set"); return; }
  // Never keep two live sockets. Tear the old one down SILENTLY first — otherwise
  // opening a second socket makes the bridge evict the first ("newest wins"), whose
  // onclose would fire scheduleReconnect → connect → a new socket → eviction → an
  // endless connect/disconnect loop.
  teardownSocket();
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    setStatus("error", String(e));
    scheduleReconnect();
    return;
  }
  ws = sock;
  setStatus("connecting", `port ${port}`);
  sock.onopen = () => sock.send(JSON.stringify({ type: "hello", token }));
  sock.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "welcome") {
      setStatus("connected", `port ${port}`);
      // Bridge mode: resume the hash chain forward from the authoritative file
      // tail so a background-script restart doesn't re-open the chain at GENESIS.
      // (Driver mode sends no audit tail; IndexedDB rehydration covers that.)
      if (msg.audit) resumeChainFrom(msg.audit.seq, msg.audit.hash);
      return;
    }
    if (msg.type === "audit_ack") {
      const p = auditPending.get(msg.auditId);
      if (p) {
        auditPending.delete(msg.auditId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(); else p.reject(new Error(msg.error || "bridge audit write failed"));
      }
      return;
    }
    if (msg.id != null && msg.tool) {
      try {
        const output = await dispatch(msg.tool, msg.params || {});
        sock.send(JSON.stringify({ id: msg.id, ok: true, output }));
      } catch (e) {
        sock.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) }));
      }
    }
  };
  // Only the CURRENT socket's close should drive a reconnect. A superseded socket
  // (replaced by a newer connect, or evicted by the bridge) has ws !== sock → ignored.
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    setStatus("disconnected");
    if (desired) scheduleReconnect();
  };
  sock.onerror = () => { if (ws === sock) setStatus("error", "connection error"); };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (desired) connect(); }, 3000);
}

function disconnect() {
  // desired=false is load-bearing: a plain ws.close() is useless against a rogue
  // driver, because scheduleReconnect() would just re-attach to whatever holds the
  // port within 3s. This is the actual "disconnect agent" lever (PLAN.md §7).
  desired = false;
  clearTimeout(reconnectTimer);
  teardownSocket();
  setStatus("disconnected");
}

// ── settings (agentTabControl toggle + approval timeout) ───────────────────
const settingsCache = { agentTabControl: false, approvalTimeoutMs: 120000 };

async function loadSettings() {
  const c = await browser.storage.local.get(["agentTabControl", "approvalTimeoutMs"]);
  settingsCache.agentTabControl = !!c.agentTabControl;
  settingsCache.approvalTimeoutMs =
    typeof c.approvalTimeoutMs === "number" && c.approvalTimeoutMs > 0 ? c.approvalTimeoutMs : 120000;
}
function getSettings() { return settingsCache; }
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("agentTabControl" in changes) settingsCache.agentTabControl = !!changes.agentTabControl.newValue;
  if ("approvalTimeoutMs" in changes) {
    settingsCache.approvalTimeoutMs = changes.approvalTimeoutMs.newValue > 0 ? changes.approvalTimeoutMs.newValue : 120000;
  }
});
loadSettings();

// ── permission ladder (PLAN.md §2) ─────────────────────────────────────────
const MODE = { Off: 0, Read: 1, Browse: 2, Assist: 3, Developer: 4 };
const MODE_NAMES = ["Off", "Read", "Browse", "Assist", "Developer"];
function rank(modeName) { return MODE[modeName] ?? 0; }

const TOOL_TIER = {
  list_tabs: MODE.Read,
  read_page: MODE.Read,
  find: MODE.Read,
  wait_for: MODE.Read,
  navigate: MODE.Browse,
  click: MODE.Assist,
  fill: MODE.Assist,
  run_js: MODE.Developer,
};
// get_mode is deliberately NOT in TOOL_TIER — it is off-the-ladder, read-only,
// and handled specially in dispatch(). Mode is never settable over the wire.
const APPROVAL_REQUIRED = new Set(["click", "fill", "run_js"]);
const EFFECTFUL_OR_NAV = new Set(["click", "fill", "run_js", "navigate"]);

// ── per-tab mode map + epoch (PLAN.md §4, §7) ──────────────────────────────
// Map<tabId, { mode, autoApprove, epoch }>. Every tab defaults to Off. `epoch` is
// stamped from a shared monotonic counter on every mode change for THAT tab (this
// mirrors JoinTab session.ts: the counter is global, but the epoch VALUE lives on
// the per-tab record, so one tab's mode change never spuriously invalidates an
// in-flight call on a different tab — only Stop AI touches every tab at once).
let epochCounter = 0;
const tabState = new Map();

function getTabState(tabId) {
  return tabState.get(tabId) || { mode: "Off", autoApprove: false, epoch: 0 };
}

/** Bumps the epoch on EVERY call — even Off→Off — per PLAN.md §7 (no-op still revokes). */
function setTabMode(tabId, mode) {
  if (!(mode in MODE)) mode = "Off";
  const next = { mode, autoApprove: false, epoch: ++epochCounter };
  tabState.set(tabId, next);
  return next;
}

function setAutoApprove(tabId, value) {
  const st = getTabState(tabId);
  // Auto-approve is a user "don't ask" toggle, not a mode transition — it does not
  // itself bump the epoch. It DOES get reset to false by any setTabMode() call.
  tabState.set(tabId, { mode: st.mode, autoApprove: !!value, epoch: st.epoch });
}

/** Stop AI: every tab → Off, epoch bumped everywhere, autoApprove reset, pending approvals killed. */
function stopAI() {
  for (const tabId of tabState.keys()) {
    tabState.set(tabId, { mode: "Off", autoApprove: false, epoch: ++epochCounter });
  }
  denyAllPendingApprovals("stop_ai");
}

browser.tabs.onRemoved.addListener((tabId) => { tabState.delete(tabId); });
browser.tabs.onCreated.addListener((tab) => { tabState.delete(tab.id); }); // clear any stale reused id

// ── targeting (PLAN.md §4) ──────────────────────────────────────────────────
function denyErr(reason, message) {
  const e = new Error(message);
  e.__deny = true;
  e.reason = reason;
  e.message = message;
  return e;
}
function describeErr(e) { return String((e && e.message) || e || "error"); }

async function getForegroundTabId() {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!t) throw denyErr("no_foreground_tab", "no active/foreground tab");
  return t.id;
}

async function tabExists(tabId) {
  try { await browser.tabs.get(tabId); return true; } catch { return false; }
}

/**
 * Resolves the tab a call may act on (PLAN.md §4). The explicit-tabId requirement
 * for effectful tools holds in BOTH agentTabControl configs — it is a property of
 * the tool, not of the toggle:
 *   - Effectful tools (click/fill/run_js) and navigate ALWAYS require an explicit
 *     p.tabId; a missing id is rejected outright (no active-tab fallback), whether
 *     agentTabControl is ON or OFF.
 *   - Read-only tools (and get_mode) may fall back to the foreground tab when
 *     tabId is omitted.
 *   - agentTabControl OFF confines everything to the foreground tab: any explicit
 *     tabId that isn't the foreground tab is rejected (background tabs unreachable).
 *   - agentTabControl ON allows background-tab targeting; an explicit tabId that
 *     doesn't resolve to a real tab is rejected WITHOUT revealing whether the id
 *     exists (the deny message is identical for "no such tab" — no oracle).
 * Note the ordering: the OFF-config foreground check runs BEFORE tabExists(), so a
 * non-foreground id is denied with "tab_control_off" regardless of whether it
 * happens to exist — that also avoids leaking existence when the toggle is off.
 */
async function resolveTarget(tool, p) {
  const settings = getSettings();
  const fg = await getForegroundTabId();

  if (EFFECTFUL_OR_NAV.has(tool)) {
    // Explicit tabId required in BOTH configs (the half-wired-invariant fix).
    if (p.tabId == null) {
      throw denyErr("explicit_tabid_required", tool + " requires an explicit tabId. → Call list_tabs first to get a tabId, then pass it as the tabId argument.");
    }
    if (!settings.agentTabControl && p.tabId !== fg) {
      throw denyErr("tab_control_off", "agentTabControl is OFF, so only the foreground (active) tab is reachable. → Ask the user to switch to the tab they want you to use, or to enable multi-tab access in the Ridealong popup settings.");
    }
    if (!(await tabExists(p.tabId))) {
      throw denyErr("tab_unavailable", "that tabId is not an open tab. → Call list_tabs to get a current tabId.");
    }
    return p.tabId;
  }

  // Read-only tools (+ get_mode): active-tab fallback permitted.
  if (!settings.agentTabControl) {
    if (p.tabId != null && p.tabId !== fg) {
      throw denyErr("tab_control_off", "agentTabControl is OFF, so only the foreground (active) tab is reachable. → Ask the user to switch to the tab they want you to use, or to enable multi-tab access in the Ridealong popup settings.");
    }
    return fg;
  }
  if (p.tabId != null) {
    if (!(await tabExists(p.tabId))) {
      throw denyErr("tab_unavailable", "that tabId is not an open tab. → Call list_tabs to get a current tabId.");
    }
    return p.tabId;
  }
  return fg;
}

// ── input validation (fail closed on anything malformed) ───────────────────
function validateInput(tool, p) {
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isStr = (v) => typeof v === "string";
  if (p == null || typeof p !== "object") throw denyErr("invalid_input", "params must be an object");
  if (p.tabId != null && !isNum(p.tabId)) throw denyErr("invalid_input", "tabId must be a number");

  switch (tool) {
    case "list_tabs":
      return;
    case "navigate":
      if (!isStr(p.url) || !/^https?:\/\//i.test(p.url)) {
        throw denyErr("invalid_input", "url must be an http(s) string");
      }
      return;
    case "read_page":
      return;
    case "find":
      if (!isStr(p.selector) || !p.selector.trim()) throw denyErr("invalid_input", "selector must be a non-empty string");
      if (p.attr != null && !isStr(p.attr)) throw denyErr("invalid_input", "attr must be a string");
      if (p.all != null && typeof p.all !== "boolean") throw denyErr("invalid_input", "all must be a boolean");
      return;
    case "click":
      if (!isStr(p.selector) || !p.selector.trim()) throw denyErr("invalid_input", "selector must be a non-empty string");
      return;
    case "fill":
      if (!isStr(p.selector) || !p.selector.trim()) throw denyErr("invalid_input", "selector must be a non-empty string");
      if (!isStr(p.value)) throw denyErr("invalid_input", "value must be a string");
      return;
    case "wait_for":
      if (!isStr(p.selector) || !p.selector.trim()) throw denyErr("invalid_input", "selector must be a non-empty string");
      if (p.timeoutMs != null && (!isNum(p.timeoutMs) || p.timeoutMs < 0 || p.timeoutMs > 120000)) {
        throw denyErr("invalid_input", "timeoutMs out of range (0..120000)");
      }
      return;
    case "run_js":
      if (!isStr(p.code) || !p.code.trim()) throw denyErr("invalid_input", "code must be a non-empty string");
      if (p.code.length > 20000) throw denyErr("invalid_input", "code too long (20000 char max)");
      return;
    default:
      throw denyErr("invalid_input", "unrecognized tool params");
  }
}

// ── approval (trusted extension chrome — PLAN.md §5, D0) ──────────────────
// NEVER an in-page overlay: the page is hostile and could self-approve its own
// effectful call (synthetic click, or clickjack a real one). We open a real
// extension page (`approval.html`) in its own popup window via windows.create,
// which page script cannot reach (no externally_connectable, no page messaging).
const pendingApprovals = new Map(); // callId -> { resolve, timer, tabId, tool, detail, tabTitle }
let approvalQueue = [];
let approvalWindowId = null;
// Synchronous guard (FIX 3): set BEFORE the async windows.create so two approval
// requests arriving within its latency can't both see approvalWindowId==null and
// each open a window (one would be orphaned). Only ever one window is created.
let approvalWindowOpening = false;

function newCallId() {
  return (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).slice(2)));
}

async function getTabTitleSafe(tabId) {
  try { const t = await browser.tabs.get(tabId); return t.title || ("tab " + tabId); }
  catch { return "tab " + tabId; }
}

function requestApproval({ tabId, tool, detail, tabTitle }) {
  return new Promise((resolve) => {
    const callId = newCallId();
    const timeoutMs = settingsCache.approvalTimeoutMs || 120000;
    // Timeout → Deny, fail closed (PLAN.md §5).
    const timer = setTimeout(() => settleApproval(callId, false, "timeout"), timeoutMs);
    pendingApprovals.set(callId, { resolve, timer, tabId, tool, detail, tabTitle });
    approvalQueue.push(callId);
    presentNextApproval();
  });
}

// Ensures EXACTLY ONE approval window exists and the queue head is shown in it.
// Serializes pipelined effectful calls into a single reused popup rather than a
// stack the user might mis-approve.
function presentNextApproval() {
  if (approvalQueue.length === 0) return;
  const head = approvalQueue[0];
  if (approvalWindowId != null) {
    browser.runtime.sendMessage({ type: "approval_show", callId: head }).catch(() => {});
  } else if (!approvalWindowOpening) {
    openApprovalWindow(head);
  }
  // else: a window is mid-creation; openApprovalWindow re-syncs to the head when done.
}

async function openApprovalWindow(callId) {
  approvalWindowOpening = true; // set BEFORE the await — this is the race guard.
  try {
    const url = browser.runtime.getURL("approval.html") + "?callId=" + encodeURIComponent(callId);
    const win = await browser.windows.create({ type: "popup", url, width: 440, height: 380 });
    approvalWindowId = win.id;
    approvalWindowOpening = false;
    // Re-sync in case the queue moved while the window was opening: the call we
    // opened for may have settled (timeout/Stop AI), or newer calls may have
    // queued. The page pulls its initial callId from the URL; if the head has
    // since changed, push it. If nothing is left, close the now-empty window.
    if (approvalQueue.length === 0) {
      const wid = approvalWindowId;
      approvalWindowId = null;
      browser.windows.remove(wid).catch(() => {});
    } else if (approvalQueue[0] !== callId) {
      browser.runtime.sendMessage({ type: "approval_show", callId: approvalQueue[0] }).catch(() => {});
    }
  } catch (e) {
    // Could not open the trusted approval surface at all — fail closed, never fall
    // back to an in-page prompt.
    approvalWindowOpening = false;
    settleApproval(callId, false, "approval_ui_unavailable");
  }
}

function settleApproval(callId, approved, reason) {
  const p = pendingApprovals.get(callId);
  if (!p) return;
  pendingApprovals.delete(callId);
  clearTimeout(p.timer);
  approvalQueue = approvalQueue.filter((id) => id !== callId);
  p.resolve({ approved, reason });
  if (approvalQueue.length > 0) {
    presentNextApproval();
  } else if (approvalWindowId != null) {
    const wid = approvalWindowId;
    approvalWindowId = null;
    browser.windows.remove(wid).catch(() => {});
  }
  // If the queue is empty but a window is still mid-creation (approvalWindowOpening),
  // openApprovalWindow's own post-await check closes the empty window — no action here.
}

function denyAllPendingApprovals(reason) {
  for (const callId of [...pendingApprovals.keys()]) settleApproval(callId, false, reason);
}

// Window dismissal (OS chrome close, not the Deny button) = Deny for whatever was
// pending — the queue is orphaned once its trusted surface is gone.
browser.windows.onRemoved.addListener((windowId) => {
  if (windowId === approvalWindowId) {
    approvalWindowId = null;
    denyAllPendingApprovals("window_closed");
  }
});

function redactValue(v) {
  if (typeof v !== "string") return String(v);
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 2) + "*".repeat(Math.max(1, v.length - 4)) + v.slice(-2);
}

/** What the approval card shows. run_js shows the REAL source (the human must review it). */
function describeEffect(tool, p) {
  if (tool === "click") return "click " + String(p.selector);
  if (tool === "fill") return "fill " + String(p.selector) + " = " + redactValue(p.value);
  if (tool === "run_js") return String(p.code || "");
  return tool;
}

// ── audit log (hash-chained; bridge file authoritative, IndexedDB fallback) ─
// PLAN.md §6: authoritative sink is the bridge file (~/.firefox-mcp/audit-log.jsonl,
// 0600) when connected via bridge/driver; IndexedDB is the driver-mode fallback
// when the peer doesn't ack (e.g. an older driver .mjs that predates this
// protocol). Chain state (seq/prevHash) is only committed once a write actually
// lands somewhere — an audit failure must fail closed and never desync silently
// (mirrors JoinTab file-sink.ts:76-86).
let auditSeq = 0;
let auditPrevHash = "GENESIS";
let auditAckCounter = 0;
const auditPending = new Map(); // auditId -> { resolve, reject, timer }
const AUDIT_ACK_TIMEOUT_MS = 1500;

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sealRecord(partial) {
  const seq = auditSeq + 1;
  const prevHash = auditPrevHash;
  const base = { seq, ts: Date.now(), prevHash, ...partial };
  const hash = await sha256Hex(seq + "\n" + prevHash + "\n" + JSON.stringify(base));
  return { ...base, hash };
}

function commitChain(sealed) {
  auditSeq = sealed.seq;
  auditPrevHash = sealed.hash;
}

// ── chain resume (PLAN.md §6) ──────────────────────────────────────────────
// auditSeq/auditPrevHash live only in this (persistent, but restartable) page.
// After a background restart they'd reset to 0/GENESIS while the durable sinks
// already hold higher seqs — the next sealed record would then re-open the chain
// at GENESIS mid-stream and fail verification. We resume forward-only from the
// highest tail we can find: the bridge's authoritative file (via the welcome
// message, bridge mode) and/or the IndexedDB fallback store (driver mode). Only
// ever advances — never rewinds a chain that's already ahead in memory.
function resumeChainFrom(seq, hash) {
  if (typeof seq === "number" && Number.isFinite(seq) && seq > auditSeq
      && typeof hash === "string" && hash) {
    auditSeq = seq;
    auditPrevHash = hash;
  }
}

async function rehydrateChainFromIndexedDb() {
  try {
    const db = await openAuditDb();
    const rec = await new Promise((resolve, reject) => {
      // keyPath is "seq" (numeric) — a reverse cursor's first hit is the max seq.
      const req = db.transaction(AUDIT_STORE, "readonly").objectStore(AUDIT_STORE)
        .openCursor(null, "prev");
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
    if (rec) resumeChainFrom(rec.seq, rec.hash);
  } catch (e) {
    console.error("[ridealong] chain rehydrate from IndexedDB failed:", e);
  }
}

function sendAuditToBridge(sealed) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("no bridge connection")); return; }
    const auditId = ++auditAckCounter;
    const timer = setTimeout(() => {
      auditPending.delete(auditId);
      reject(new Error("audit ack timeout (peer may not support the audit channel)"));
    }, AUDIT_ACK_TIMEOUT_MS);
    auditPending.set(auditId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: "audit", auditId, record: sealed }));
    } catch (e) {
      clearTimeout(timer);
      auditPending.delete(auditId);
      reject(e);
    }
  });
}

// IndexedDB fallback sink — driver mode (or an unresponsive bridge) has no durable
// file, so we keep a bounded, rotating local log instead (unlimitedStorage in the
// manifest; capped so it can't grow forever).
const AUDIT_DB_NAME = "fxmcp_audit";
const AUDIT_STORE = "records";
const AUDIT_MAX_RECORDS = 5000;
let auditDbPromise = null;

function openAuditDb() {
  if (auditDbPromise) return auditDbPromise;
  auditDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIT_STORE)) db.createObjectStore(AUDIT_STORE, { keyPath: "seq" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return auditDbPromise;
}

async function auditIndexedDbWrite(record) {
  const db = await openAuditDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIT_STORE, "readwrite");
    tx.objectStore(AUDIT_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await auditRotateIfNeeded(db);
}

async function auditRotateIfNeeded(db) {
  const count = await new Promise((resolve, reject) => {
    const req = db.transaction(AUDIT_STORE, "readonly").objectStore(AUDIT_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count <= AUDIT_MAX_RECORDS) return;
  const toDelete = count - AUDIT_MAX_RECORDS;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIT_STORE, "readwrite");
    const store = tx.objectStore(AUDIT_STORE);
    let deleted = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (cursor && deleted < toDelete) { cursor.delete(); deleted++; cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Kick off local-store rehydration once, now that the IndexedDB helpers above are
// initialized. The first seal awaits this so no record is minted at a stale seq
// (0/GENESIS) before the fallback store has been consulted (driver mode). Bridge
// mode additionally resumes from the welcome message's authoritative file tail.
const chainReady = rehydrateChainFromIndexedDb();

async function auditLog(partial) {
  await chainReady;
  const sealed = await sealRecord(partial);
  try {
    await sendAuditToBridge(sealed);
    commitChain(sealed);
    return;
  } catch (bridgeErr) {
    // KNOWN LIMITATION (documented, not silently surprising): sendAuditToBridge
    // only waits AUDIT_ACK_TIMEOUT_MS for the ack. If the bridge is merely SLOW
    // (>1.5s) rather than absent, it may still have appended this record to its
    // file — and we then also persist the SAME record (same seq/prevHash/hash) to
    // IndexedDB. That's a benign double-persist of an identical, hash-chained
    // record, not a chain desync (the seq/hash match), and dedup is trivial on
    // read. We accept it to keep the failure path fail-closed rather than risk
    // dropping the record while waiting indefinitely on a wedged peer.
    try {
      await auditIndexedDbWrite(sealed);
      commitChain(sealed);
      return;
    } catch (idbErr) {
      console.error("[ridealong] AUDIT WRITE FAILED (bridge + IndexedDB):", bridgeErr, idbErr);
      throw new Error("audit_write_failed");
    }
  }
}

/** Fail-closed wrapper: an audit write failure must surface loudly, never be swallowed. */
async function safeAudit(rec) {
  try {
    await auditLog(rec);
  } catch (auditErr) {
    console.error("[ridealong] AUDIT WRITE FAILED for", rec.tool, auditErr);
    throw denyErr("audit_failure", "audit_write_failed: could not persist decision for " + rec.tool);
  }
}

function redactParams(tool, p) {
  const out = {};
  for (const k in p) {
    if (tool === "fill" && k === "value") { out[k] = "[REDACTED]"; continue; }
    if (tool === "run_js" && k === "code") {
      const s = String(p[k] || "");
      out[k] = s.length > 2000 ? s.slice(0, 2000) + "…(truncated)" : s;
      continue;
    }
    const v = p[k];
    if (typeof v === "string" && v.length > 500) { out[k] = v.slice(0, 500) + "…(truncated)"; continue; }
    out[k] = v;
  }
  return out;
}

// ── the broker chokepoint ───────────────────────────────────────────────────
async function dispatch(tool, p) {
  const record = { tool, params: redactParams(tool, p), requestedTabId: (p && p.tabId != null) ? p.tabId : null };
  let targetTabId = null;
  try {
    // Fail closed on unknown tools before doing any tab work.
    if (tool !== "get_mode" && !(tool in TOOL_TIER)) {
      throw denyErr("unknown_tool", "unknown tool: " + tool);
    }

    // 1. Resolve target tab.
    targetTabId = await resolveTarget(tool, p);
    record.tabId = targetTabId;

    // get_mode: off-ladder, read-only. No mode gate, no approval, always answerable
    // (an agent may read the mode of a tab it can target, but never set it here).
    if (tool === "get_mode") {
      const st = getTabState(targetTabId);
      const output = { tabId: targetTabId, mode: st.mode };
      await safeAudit({ ...record, decision: "allow", reason: "off_ladder" });
      return output;
    }

    // 2. Mode gate.
    const st = getTabState(targetTabId);
    const required = TOOL_TIER[tool];
    if (rank(st.mode) < required) {
      throw denyErr("insufficient_mode", tool + " needs the '" + MODE_NAMES[required] + "' permission tier or higher, but this tab is currently '" + st.mode + "'. → Ask the user to open the Ridealong popup and set THIS tab to '" + MODE_NAMES[required] + "' (or higher), then retry this exact call. You cannot change the mode yourself.");
    }

    // 3. Input validation.
    validateInput(tool, p);

    // 4. Approval (bound to this epoch). run_js ALWAYS prompts, even with auto-approve on.
    const epochAtCapture = st.epoch;
    const needsApproval = tool === "run_js" ? true : (APPROVAL_REQUIRED.has(tool) && !st.autoApprove);
    if (needsApproval) {
      const detail = describeEffect(tool, p);
      const tabTitle = await getTabTitleSafe(targetTabId);
      const decision = await requestApproval({ tabId: targetTabId, tool, detail, tabTitle });
      if (getTabState(targetTabId).epoch !== epochAtCapture) {
        throw denyErr("revoked", "session changed during approval");
      }
      if (!decision.approved) {
        throw denyErr("approval_denied", decision.reason || "denied by user");
      }
    }

    // 5. Epoch re-check immediately before dispatching the irreversible step.
    if (getTabState(targetTabId).epoch !== epochAtCapture) {
      throw denyErr("revoked", "session changed before dispatch");
    }

    // 6. Execute — audit-BEFORE-execute for effectful tools so "fail-closed on audit
    //    failure" is real: a side effect must never happen unless its audit record
    //    durably landed first (PLAN.md §6). Read-only tools have no side effect to
    //    prevent, so they audit AFTER execution (cheaper, and can annotate output).
    if (EFFECTFUL_OR_NAV.has(tool)) {
      // Persist the allow decision (intent to act) and AWAIT durability. If the
      // write fails, safeAudit throws → we DENY here and execTool is never reached.
      await safeAudit({ ...record, decision: "allow", reason: "intent" });
      // A revoke that landed DURING the (async) audit write must still stop the
      // action — re-check the epoch after the write and immediately before dispatch.
      if (getTabState(targetTabId).epoch !== epochAtCapture) {
        throw denyErr("revoked", "session changed after audit, before dispatch");
      }
      const output = await execTool(tool, targetTabId, p);
      // Honest TOCTOU limit (PLAN.md §7): executeScript injects-and-acts in one
      // opaque call, so this post-check cannot straddle the actual click/fill — the
      // action may already have run. It still surfaces a revoke that raced the
      // dispatch. The intent record above already guarantees the decision is logged.
      if (getTabState(targetTabId).epoch !== epochAtCapture) {
        throw denyErr("revoked", "session revoked during/after execution (action may already have run — see PLAN.md §7 TOCTOU note)");
      }
      return output;
    }

    const output = await execTool(tool, targetTabId, p);
    if (getTabState(targetTabId).epoch !== epochAtCapture) {
      throw denyErr("revoked", "session revoked during/after execution (result discarded)");
    }
    // 7. Audit-emit (allow). Fail closed if the write itself fails.
    await safeAudit({ ...record, decision: "allow", reason: null });
    return output;
  } catch (err) {
    const info = err && err.__deny ? err : { reason: "error", message: describeErr(err) };
    await safeAudit({
      ...record,
      tabId: targetTabId,
      decision: info.reason === "error" ? "error" : "deny",
      reason: info.reason,
      message: info.message,
    });
    throw new Error(info.message);
  }
}

// ── tool execution (unprivileged; only reached after the gate above) ──────
async function exec(tabId, code) {
  let results;
  try {
    results = await browser.tabs.executeScript(tabId, { code });
  } catch (e) {
    // Privileged pages (about:, view-source:, addon/PDF viewer, moz-extension://)
    // make executeScript throw. Fail closed with a clear reason instead of a raw
    // throw (PLAN.md §3).
    throw denyErr("unsupported_page", "could not run on this tab (privileged/internal page, or no access): " + describeErr(e));
  }
  return results && results[0];
}

async function execFile(tabId, file) {
  try {
    await browser.tabs.executeScript(tabId, { file });
  } catch (e) {
    throw denyErr("unsupported_page", "could not inject " + file + " on this tab (privileged/internal page?): " + describeErr(e));
  }
}

async function execTool(tool, tabId, p) {
  switch (tool) {
    case "list_tabs": {
      // list_tabs is Read-tier, gated above on the FOREGROUND tab's mode (tabId
      // here IS the foreground tab per resolveTarget). Scope + fields depend on
      // agentTabControl (PLAN.md §2/§4): OFF -> foreground tab only; ON -> all
      // tabs, but url is only included for tabs individually at >= Read.
      const settings = getSettings();
      if (!settings.agentTabControl) {
        const t = await browser.tabs.get(tabId);
        const st = getTabState(tabId);
        const entry = { id: t.id, title: t.title, active: true };
        if (rank(st.mode) >= MODE.Read) entry.url = t.url;
        return { tabs: [entry] };
      }
      const tabs = await browser.tabs.query({});
      return {
        tabs: tabs.map((t) => {
          const st = getTabState(t.id);
          const entry = { id: t.id, title: t.title, active: !!t.active };
          if (rank(st.mode) >= MODE.Read) entry.url = t.url;
          return entry;
        }),
      };
    }
    case "navigate": {
      await browser.tabs.update(tabId, { url: p.url });
      await waitForComplete(tabId, 40000);
      const info = await browser.tabs.get(tabId);
      return { url: info.url, title: info.title };
    }
    case "read_page": {
      // Best-effort secret redaction (PLAN.md §9): redact.js is injected ON DEMAND
      // here, only for a granted read_page call — NOT a declared <all_urls>
      // always-on content script — and it has no page-message relay of its own.
      await execFile(tabId, "redact.js");
      return await exec(tabId, `(function(){
        var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'), 0, 120)
          .map(function(a){ return { text: (a.innerText||'').trim().slice(0,80), href: a.href }; });
        var raw = document.body ? document.body.innerText : '';
        var text = (typeof fxmcpRedact === 'function') ? fxmcpRedact(raw) : raw;
        return { url: location.href, title: document.title, text: text.slice(0, 8000), links: links };
      })();`);
    }
    case "find": {
      const sel = JSON.stringify(p.selector);
      const attr = JSON.stringify(p.attr || null);
      const all = p.all ? "true" : "false";
      // FIX 4: best-effort redact find's returned text/attr too (parity with
      // read_page) — inject redact.js on-demand and pass values through it.
      await execFile(tabId, "redact.js");
      return await exec(tabId, `(function(){
        var sel = ${sel}, attr = ${attr}, all = ${all};
        var rd = (typeof fxmcpRedact === 'function') ? fxmcpRedact : function(x){ return x; };
        var els = Array.prototype.slice.call(document.querySelectorAll(sel));
        function pick(el){ var o = { text: rd((el.innerText||'').trim().slice(0,300)) };
          if (attr) { var a = el.getAttribute(attr); o[attr] = (a == null ? a : rd(a)); } return o; }
        if (all) return { matches: els.slice(0,60).map(pick), count: els.length };
        return els[0] ? pick(els[0]) : null;
      })();`);
    }
    case "click": {
      const sel = JSON.stringify(p.selector);
      return await exec(tabId, `(function(){
        var el = document.querySelector(${sel}); if(!el) return { clicked:false };
        el.scrollIntoView({block:'center'}); el.click(); return { clicked:true };
      })();`);
    }
    case "fill": {
      const sel = JSON.stringify(p.selector), val = JSON.stringify(p.value);
      return await exec(tabId, `(function(){
        var el = document.querySelector(${sel}); if(!el) return { filled:false };
        el.focus(); el.value = ${val};
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return { filled: el.value === ${val} };
      })();`);
    }
    case "wait_for": {
      const sel = JSON.stringify(p.selector);
      const deadline = Date.now() + (p.timeoutMs || 10000);
      while (Date.now() < deadline) {
        const found = await exec(tabId, `!!document.querySelector(${sel})`).catch(() => false);
        if (found) return { found: true };
        await new Promise((r) => setTimeout(r, 400));
      }
      return { found: false };
    }
    case "run_js": {
      // Developer tier, always approved above (with the real source shown). The
      // code runs as a content-script-world expression; no top-level `return` —
      // wrap in an IIFE so `return` inside the user's code works as expected.
      const result = await exec(tabId, `(function(){ ${p.code}\n})();`);
      return { result };
    }
    default:
      throw denyErr("unknown_tool", "unknown tool: " + tool);
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; browser.tabs.onUpdated.removeListener(onUpd); resolve(); } };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    browser.tabs.onUpdated.addListener(onUpd);
    // also resolve if already complete
    browser.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }).catch(() => {});
    setTimeout(finish, timeoutMs);
  });
}

// ── token rotation (PLAN.md §7) ────────────────────────────────────────────
async function regenerateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const newToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await browser.storage.local.set({ token: newToken });
  // NOTE: this only rotates the EXTENSION's copy of the token. The bridge's own
  // ~/.firefox-mcp/token.txt is a separate store this extension cannot reach —
  // regenerating that file (and restarting the bridge so it re-reads it) is a
  // manual step on that side. Setting a token here the current bridge/driver
  // doesn't know immediately breaks auth on the NEXT reconnect attempt, which is
  // the actual revocation effect against an honest/stale peer (PLAN.md §7).
  disconnect();
  return { ok: true, token: newToken };
}

// ── popup / approval-page messaging ─────────────────────────────────────────
function isApprovalSender(sender) {
  // Trust the approval page by its URL. (The old `!sender.tab` check wrongly
  // rejected it: a windows.create popup DOES contain a tab on some Firefox builds,
  // so sender.tab is set — which left approval_get_detail returning null and the
  // Approve/Deny buttons permanently disabled, i.e. run_js could never be approved.)
  return typeof sender.url === "string" && sender.url.split("?")[0].endsWith("/approval.html");
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.cmd === "connect") { connect(); return; }
  if (msg.cmd === "disconnect" || msg.cmd === "disconnect_agent") { disconnect(); return; }
  if (msg.cmd === "status") { sendResponse(state); return true; }

  // Everything below is a control-plane action. It must originate from trusted
  // extension chrome (popup.html / approval.html), never a content script — a
  // hostile page could otherwise use redact.js's extension-code privileges to
  // relay a fake approval/mode message (PLAN.md §5). Distinguish by the sender's
  // URL ORIGIN, not the presence of sender.tab: a windows.create approval popup
  // carries a sender.tab on some Firefox builds, so the old `if (sender.tab) return;`
  // silently dropped every approval_get_detail/approval_decision message here —
  // before the switch — leaving the Approve/Deny buttons dead ("(expired)"). A
  // content script's sender.url is always the http(s) page; our own chrome is
  // moz-extension://<this-extension>/… and (no web_accessible_resources) is
  // unreachable/unspoofable from a web page.
  const fromExtensionChrome =
    typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(""));
  if (!fromExtensionChrome) return;

  switch (msg.cmd) {
    case "get_tab_states": {
      getForegroundTabId()
        .then((fg) => browser.tabs.query({}).then((tabs) => {
          sendResponse({
            foregroundTabId: fg,
            agentTabControl: settingsCache.agentTabControl,
            tabs: tabs.map((t) => {
              const st = getTabState(t.id);
              return { id: t.id, title: t.title, active: t.id === fg, mode: st.mode, autoApprove: st.autoApprove };
            }),
          });
        }))
        .catch(() => sendResponse({ tabs: [], agentTabControl: settingsCache.agentTabControl }));
      return true;
    }
    case "set_mode": {
      setTabMode(msg.tabId, msg.mode);
      sendResponse({ ok: true });
      return true;
    }
    case "set_auto_approve": {
      setAutoApprove(msg.tabId, !!msg.value);
      sendResponse({ ok: true });
      return true;
    }
    case "stop_ai": {
      stopAI();
      sendResponse({ ok: true });
      return true;
    }
    case "regenerate_token": {
      regenerateToken().then((r) => sendResponse(r));
      return true;
    }
    case "set_agent_tab_control": {
      browser.storage.local.set({ agentTabControl: !!msg.value }).then(() => sendResponse({ ok: true }));
      return true;
    }
    case "approval_get_detail": {
      if (!isApprovalSender(sender)) { sendResponse(null); return true; }
      const p = pendingApprovals.get(msg.callId);
      sendResponse(p ? { tool: p.tool, detail: p.detail, tabId: p.tabId, tabTitle: p.tabTitle } : null);
      return true;
    }
    case "approval_decision": {
      if (!isApprovalSender(sender)) return;
      settleApproval(msg.callId, !!msg.approved, msg.approved ? "user_approved" : "user_denied");
      sendResponse({ ok: true });
      return true;
    }
  }
});

// auto-connect on startup if a token is already saved
getConfig().then((c) => { if (c.token) connect(); });
