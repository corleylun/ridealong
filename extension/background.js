/* Firefox MCP Bridge — background (WebSocket client + tab/DOM executor).
 *
 * Connects OUT to the local bridge (ws://127.0.0.1:PORT), authenticates with the
 * shared token, then executes commands the bridge relays from the AI agent.
 * All page work is done with browser.tabs.* + tabs.executeScript in the REAL
 * browser — no CDP, real session/cookies/fingerprint.
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

async function connect() {
  desired = true;
  clearTimeout(reconnectTimer);
  const { port, token } = await getConfig();
  if (!token) { setStatus("error", "no token set"); return; }
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    setStatus("error", String(e));
    scheduleReconnect();
    return;
  }
  setStatus("connecting", `port ${port}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token }));
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "welcome") { setStatus("connected", `port ${port}`); return; }
    if (msg.id != null && msg.tool) {
      try {
        const output = await dispatch(msg.tool, msg.params || {});
        ws.send(JSON.stringify({ id: msg.id, ok: true, output }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) }));
      }
    }
  };
  ws.onclose = () => { setStatus("disconnected"); if (desired) scheduleReconnect(); };
  ws.onerror = () => { setStatus("error", "connection error"); };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (desired) connect(); }, 3000);
}

function disconnect() {
  desired = false;
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch {} ws = null; }
  setStatus("disconnected");
}

// ── command dispatch (runs in the real browser) ───────────────────────────
async function activeTabId(given) {
  if (given != null) return given;
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!t) throw new Error("no active tab");
  return t.id;
}

async function exec(tabId, code) {
  const results = await browser.tabs.executeScript(tabId, { code });
  return results && results[0];
}

async function dispatch(tool, p) {
  switch (tool) {
    case "list_tabs": {
      const tabs = await browser.tabs.query({});
      return {
        tabs: tabs.map((t) => ({ id: t.id, active: t.active, url: t.url, title: t.title })),
      };
    }
    case "navigate": {
      const tabId = await activeTabId(p.tabId);
      await browser.tabs.update(tabId, { url: p.url });
      await waitForComplete(tabId, 40000);
      const info = await browser.tabs.get(tabId);
      return { url: info.url, title: info.title };
    }
    case "read_page": {
      const tabId = await activeTabId(p.tabId);
      return await exec(tabId, `(function(){
        var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'), 0, 120)
          .map(function(a){ return { text: (a.innerText||'').trim().slice(0,80), href: a.href }; });
        return { url: location.href, title: document.title,
          text: (document.body ? document.body.innerText : '').slice(0, 8000), links: links };
      })();`);
    }
    case "find": {
      const tabId = await activeTabId(p.tabId);
      const sel = JSON.stringify(p.selector);
      const attr = JSON.stringify(p.attr || null);
      const all = p.all ? "true" : "false";
      return await exec(tabId, `(function(){
        var sel = ${sel}, attr = ${attr}, all = ${all};
        var els = Array.prototype.slice.call(document.querySelectorAll(sel));
        function pick(el){ var o = { text: (el.innerText||'').trim().slice(0,300) };
          if (attr) o[attr] = el.getAttribute(attr); return o; }
        if (all) return { matches: els.slice(0,60).map(pick), count: els.length };
        return els[0] ? pick(els[0]) : null;
      })();`);
    }
    case "click": {
      const tabId = await activeTabId(p.tabId);
      const sel = JSON.stringify(p.selector);
      return await exec(tabId, `(function(){
        var el = document.querySelector(${sel}); if(!el) return { clicked:false };
        el.scrollIntoView({block:'center'}); el.click(); return { clicked:true };
      })();`);
    }
    case "fill": {
      const tabId = await activeTabId(p.tabId);
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
      const tabId = await activeTabId(p.tabId);
      const sel = JSON.stringify(p.selector);
      const deadline = Date.now() + (p.timeoutMs || 10000);
      while (Date.now() < deadline) {
        const found = await exec(tabId, `!!document.querySelector(${sel})`).catch(() => false);
        if (found) return { found: true };
        await new Promise((r) => setTimeout(r, 400));
      }
      return { found: false };
    }
    default:
      throw new Error("unknown tool: " + tool);
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

// ── popup messaging ────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.cmd === "connect") connect();
  else if (msg.cmd === "disconnect") disconnect();
  else if (msg.cmd === "status") { sendResponse(state); return true; }
});

// auto-connect on startup if a token is already saved
getConfig().then((c) => { if (c.token) connect(); });
