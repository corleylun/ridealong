const $ = (id) => document.getElementById(id);

// ── onboarding prompt (ONBOARDING_PLAN.md §2 — reproduce verbatim, token filled in) ──
function buildPrompt(token) {
  return (
`Ridealong is installed in this Firefox and wants you (the AI agent) to finish setup so you
can drive this browser over MCP. You are on the user's LOCAL machine (same machine as
Firefox). Please do the following, explaining each step to the user as you go:

1. Clone the repo if it isn't already present:
     git clone https://github.com/corleylun/ridealong.git
2. Install the bridge dependencies:
     cd ridealong/bridge && npm install
3. Register a stdio MCP server named "ridealong" that runs:
     node <ABSOLUTE_PATH>/ridealong/bridge/bridge.js
   with this environment variable set (do NOT change it — the extension already holds this
   exact token and will only connect to a bridge that uses it):
     FXMCP_TOKEN=${token}
   - If you are Claude Code:
       claude mcp add ridealong --env FXMCP_TOKEN=${token} -- node <ABSOLUTE_PATH>/ridealong/bridge/bridge.js
   - If you are Codex (near-identical):
       codex mcp add ridealong --env FXMCP_TOKEN=${token} -- node <ABSOLUTE_PATH>/ridealong/bridge/bridge.js
4. Tell the user to RESTART you so the MCP server loads, then have them open the Ridealong
   popup in Firefox — it should show "connected".
5. Once connected: every tab is OFF by default. The user grants you a permission mode per
   tab from the popup (Read / Browse / Assist / Developer); effectful actions may need their
   approval. Full docs + troubleshooting: https://flowstations.net/ridealong/docs

Security note for the user: this makes your AI agent clone a repo, run npm install, and
register a local MCP server that can act in your logged-in Firefox — only within the per-tab
permission you grant, off by default, with a full audit log. Read the steps before running.`
  );
}

// ── agent usage primer (procedural — for a NEW session to drive Firefox) ──────
// The setup prompt (above) registers the MCP server once. This primer orients an
// agent that already HAS the tools on the per-tab permission model, so weaker agents
// (e.g. Codex) follow the workflow and recover from denials instead of stalling.
function buildUsagePrimer() {
  return (
`You have the "ridealong" MCP tools that control the user's real, logged-in Firefox.
Follow this exact sequence — do not skip steps:

1. Call list_tabs to see the tabs you're allowed to use.
2. If list_tabs is empty or denied, STOP and tell the user: "Open the Ridealong popup and
   set the tab you want me to use to at least 'Read'." Then wait for them.
3. To READ a page: call read_page (or find) with a tabId from list_tabs.
4. To CLICK or FILL: the tab must be at 'Assist'. Call click/fill with the explicit tabId.
   The user gets an approval popup — tell them to approve it.
5. If any tool returns an error containing "→", DO WHAT THE ARROW SAYS (it tells you the
   exact recovery step — usually "ask the user to set THIS tab to <mode> in the popup, then
   retry"). Then retry the same call.
6. You can NEVER change a tab's permission mode yourself — only the user can, in the popup.
   Never assume access to a tab you weren't granted.

Full tool reference: https://flowstations.net/ridealong/docs`
  );
}

// ── token minting (ONBOARDING_PLAN.md §3) ──────────────────────────────────
// ~32 bytes, hex-encoded — stored under the SAME `token` key connectWs() (background.js)
// already reads, so minting here is all that's needed for the extension to auto-connect
// once a bridge is started with this same value as FXMCP_TOKEN.
function genToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let mintedToken = "";
let onboardingCollapsed = false; // becomes true once we've hidden onboarding this session

/**
 * Mints a token into storage.local.token if none exists yet (fresh install).
 * Returns true iff it MINTED a fresh token (storage was empty) — the caller uses
 * that to force the onboarding view, because a freshly-minted token means the bridge
 * (if any) still holds the OLD/other token and the user must re-register (LOW #1).
 */
async function ensureToken() {
  const c = await browser.storage.local.get(["token"]);
  if (c.token) { mintedToken = c.token; return false; }
  mintedToken = genToken();
  await browser.storage.local.set({ token: mintedToken });
  return true;
}

function paintOnboarding() {
  $("onboardPrompt").value = buildPrompt(mintedToken);
  $("mintedTokenDisplay").value = mintedToken;
}

/** Toggles between the onboarding view and the normal per-tab/status view. */
function setOnboardingVisible(visible) {
  $("onboarding").style.display = visible ? "" : "none";
  $("mainView").style.display = visible ? "none" : "";
  onboardingCollapsed = !visible;
}

async function load() {
  const freshlyMinted = await ensureToken();
  const c = await browser.storage.local.get(["port", "token", "everConnected"]);
  if (c.port) $("port").value = c.port;
  $("token").value = c.token || mintedToken;
  paintOnboarding();

  // HIGH fix: on a fresh profile, background.js's startup connect() was skipped (no
  // token existed then), and minting a token does not itself dial. Kick off dialing
  // now so the extension's reconnect loop is live and will latch onto the bridge the
  // moment the agent starts it — otherwise the "switches to connected automatically"
  // promise is false for exactly the target user. Guard against a duplicate dial:
  // background's connect() reassigns `ws` WITHOUT closing an existing socket, so only
  // dial when we are not already connected/connecting.
  const s = await browser.runtime.sendMessage({ cmd: "status" }).catch(() => null);
  if (!s || (s.status !== "connected" && s.status !== "connecting")) {
    browser.runtime.sendMessage({ cmd: "connect" });
  }

  // State detection (ONBOARDING_PLAN.md §4): show onboarding unless this profile has
  // ever completed a successful connection before (persisted, not just live status —
  // a later disconnect/bridge restart should NOT re-show the onboarding wizard). But a
  // freshly-minted token (storage was cleared) always forces onboarding back on, even
  // if everConnected was set, because the bridge no longer shares this new token and
  // the user must re-register (LOW #1).
  setOnboardingVisible(freshlyMinted || !c.everConnected);
  if (s) render(s);
  refreshTabs();
}

function render(s) {
  const el = $("status");
  el.className = s.status;
  el.textContent = s.status + (s.detail ? ` — ${s.detail}` : "");
  if (s.status === "connected" && !onboardingCollapsed) {
    setOnboardingVisible(false);
    browser.storage.local.set({ everConnected: true });
  }
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

$("copyPrompt").addEventListener("click", async () => {
  const text = $("onboardPrompt").value;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback if the async Clipboard API is unavailable in this popup context.
    $("onboardPrompt").focus();
    $("onboardPrompt").select();
    document.execCommand("copy");
  }
  const flash = $("copiedFlash");
  flash.style.display = "";
  clearTimeout(flash.__hideTimer);
  flash.__hideTimer = setTimeout(() => { flash.style.display = "none"; }, 1500);
});

$("copyPrimer").addEventListener("click", async () => {
  const text = buildUsagePrimer();
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback: stash in a temporary textarea and execCommand copy.
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  const flash = $("primerFlash");
  flash.style.display = "";
  clearTimeout(flash.__hideTimer);
  flash.__hideTimer = setTimeout(() => { flash.style.display = "none"; }, 1500);
});

$("toggleTokenReveal").addEventListener("click", () => {
  const input = $("mintedTokenDisplay");
  const btn = $("toggleTokenReveal");
  const revealed = input.type === "text";
  input.type = revealed ? "password" : "text";
  btn.textContent = revealed ? "Show" : "Hide";
});

$("connect").addEventListener("click", async () => {
  const tok = $("token").value.trim();
  await browser.storage.local.set({
    port: Number($("port").value) || 8765,
    token: tok,
  });
  if (tok) { mintedToken = tok; paintOnboarding(); }
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
    mintedToken = res.token;
    $("token").value = res.token;
    paintOnboarding();
    // LOW #2: Regenerate lives in mainView, where the onboarding prompt is hidden.
    // Surface the onboarding view so the "updated prompt" the alert points at is
    // actually on screen (with the new token already filled in) for the user to copy.
    setOnboardingVisible(true);
    alert(
      "Token rotated LOCALLY (this extension only). The bridge/driver still has the " +
        "OLD token in ~/.firefox-mcp/token.txt and won't recognize this new one.\n\n" +
        "This immediately revokes this extension's access to an honest/stale bridge. " +
        "To reconnect, either regenerate the bridge's token file (delete it and restart " +
        "the bridge/driver) and paste ITS new printed token in here, or use the onboarding " +
        "prompt now shown above (updated with the new token) — copy it and have your agent " +
        "re-register.",
    );
  }
  refresh();
});

browser.runtime.onMessage.addListener((msg) => { if (msg.type === "status") render(msg); });
load();
setInterval(() => { refresh(); refreshTabs(); }, 2000);
