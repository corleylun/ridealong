const $ = (id) => document.getElementById(id);

async function load() {
  const c = await browser.storage.local.get(["port", "token"]);
  if (c.port) $("port").value = c.port;
  if (c.token) $("token").value = c.token;
  refresh();
  refreshTabs();
}

function render(s) {
  const el = $("status");
  el.className = s.status;
  el.textContent = s.status + (s.detail ? ` — ${s.detail}` : "");
}

async function refresh() {
  const s = await browser.runtime.sendMessage({ cmd: "status" }).catch(() => null);
  if (s) render(s);
}

async function refreshTabs() {
  const res = await browser.runtime.sendMessage({ cmd: "get_tab_states" }).catch(() => null);
  if (!res || !res.tabs) return;

  $("agentTabControl").checked = !!res.agentTabControl;

  const fgTab = res.tabs.find((t) => t.id === res.foregroundTabId);
  if (fgTab) {
    $("thisTabTitle").textContent = (fgTab.title || ("tab " + fgTab.id)).slice(0, 30);
    $("thisTabMode").value = fgTab.mode;
    $("thisTabMode").dataset.tabId = String(fgTab.id);
    $("thisTabAutoApprove").checked = !!fgTab.autoApprove;
    $("thisTabAutoApprove").dataset.tabId = String(fgTab.id);
  }

  const list = $("tabList");
  list.innerHTML = "";
  for (const t of res.tabs) {
    const row = document.createElement("div");
    row.className = "tabRow";

    const label = document.createElement("span");
    label.textContent = (t.active ? "● " : "○ ") + (t.title || ("tab " + t.id));
    label.title = t.title || "";

    const sel = document.createElement("select");
    for (const m of ["Off", "Read", "Browse", "Assist", "Developer"]) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === t.mode) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      browser.runtime.sendMessage({ cmd: "set_mode", tabId: t.id, mode: sel.value }).then(refreshTabs);
    });

    row.appendChild(label);
    row.appendChild(sel);
    list.appendChild(row);
  }
}

$("connect").addEventListener("click", async () => {
  await browser.storage.local.set({
    port: Number($("port").value) || 8765,
    token: $("token").value.trim(),
  });
  browser.runtime.sendMessage({ cmd: "connect" });
  setTimeout(refresh, 500);
});

$("disconnect").addEventListener("click", () => {
  // "Disconnect agent" — sets desired=false so the extension does NOT auto-reconnect.
  // The real containment lever against a rogue driver (PLAN.md §7); Stop AI is the
  // other half (mode gate).
  browser.runtime.sendMessage({ cmd: "disconnect_agent" });
  setTimeout(refresh, 300);
});

$("thisTabMode").addEventListener("change", (e) => {
  const tabId = Number(e.target.dataset.tabId);
  if (!Number.isFinite(tabId)) return;
  browser.runtime.sendMessage({ cmd: "set_mode", tabId, mode: e.target.value }).then(refreshTabs);
});

$("thisTabAutoApprove").addEventListener("change", (e) => {
  const tabId = Number(e.target.dataset.tabId);
  if (!Number.isFinite(tabId)) return;
  browser.runtime.sendMessage({ cmd: "set_auto_approve", tabId, value: e.target.checked }).then(refreshTabs);
});

$("agentTabControl").addEventListener("change", (e) => {
  browser.runtime.sendMessage({ cmd: "set_agent_tab_control", value: e.target.checked });
});

$("stopAI").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "stop_ai" }).then(refreshTabs);
});

$("regenToken").addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({ cmd: "regenerate_token" }).catch(() => null);
  if (res && res.token) {
    $("token").value = res.token;
    alert(
      "Token rotated LOCALLY (this extension only). The bridge/driver still has the " +
        "OLD token in ~/.firefox-mcp/token.txt and won't recognize this new one.\n\n" +
        "This immediately revokes this extension's access to an honest/stale bridge. " +
        "To reconnect, regenerate the bridge's token file (delete it and restart the " +
        "bridge/driver) and paste ITS new printed token in here.",
    );
  }
  refresh();
});

browser.runtime.onMessage.addListener((msg) => { if (msg.type === "status") render(msg); });
load();
setInterval(() => { refresh(); refreshTabs(); }, 2000);
