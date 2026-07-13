# ridealong — Agent Guide

**Audience:** an AI agent (Claude Code, Codex, etc.) that needs to read/drive a
**real, logged-in Firefox** — to reach sites that block automation (marketplaces
behind Cloudflare, anything checking for automation), or to act on a user's
authenticated session.

**Why it exists:** headless automation (Electron/Playwright/Puppeteer) and plain
`curl`/WebFetch get fingerprinted and blocked — CDP attached, `navigator.webdriver`,
datacenter IP, etc. ridealong runs commands **inside the user's genuine Firefox**
(real fingerprint, real cookies, **no CDP**), so the site sees an ordinary browser.
It is **not a stealth tool** — it's simply the real browser, driven politely.

---

## 1. Architecture

```
  Agent ──(A) MCP/stdio──▶ bridge.js ──ws://127.0.0.1:8765──▶ Firefox extension ──▶ page
  Agent ──(B) is the WS server itself (a driver .mjs) ───────▶ Firefox extension ──▶ page
```

A browser extension **cannot listen on a port**, so it can't be an MCP server. But
it **dials OUT** over a WebSocket. Two ways to use that:

- **(A) MCP mode** — `bridge.js` is a stdio MCP server the agent connects to, *and*
  a WS server the extension connects to. The agent calls MCP tools; the bridge
  relays them to the extension.
- **(B) Driver mode** — a standalone `.mjs` script **is** the WS server (skipping
  the MCP layer) and sends commands to the extension directly. It works from any Bash
  shell with no MCP registration; see `bridge/driver.example.mjs`.

**Prefer Driver mode (B)** unless ridealong is already registered as an MCP server
in your session. It's more flexible and needs no session restart.

---

## 2. Permission ladder (read this before your first call ever fails)

The extension now gates every tool call through a per-tab broker
(`extension/background.js` `dispatch()` — see `PLAN.md` for the full design/audit
trail). **Every tab defaults to Off**, which denies ALL tools on that tab — this
is new and it is not a bug if your driver script suddenly gets `insufficient_mode`
errors. A human must open the extension popup and grant the tab a mode before any
agent (MCP or driver) can touch it:

| Mode | Unlocks | Approval |
| --- | --- | --- |
| Off (default) | nothing | — |
| Read | `read_page`, `find`, `wait_for`, `list_tabs`, `get_mode` | no |
| Browse | + `navigate` | no |
| Assist | + `click`, `fill` | yes, per action (trusted popup window), unless auto-approve is on for that tab |
| Developer | + `run_js` | yes, always — shows the exact source, ignores auto-approve |

Targeting rules that changed:
- `click`, `fill`, `run_js`, and `navigate` now **require an explicit `tabId`** —
  no active-tab fallback. Get one from `list_tabs` first.
- `list_tabs` is Read-tier, gated on the **foreground** tab's mode, and returns
  reduced fields (`id`+`title` always; `url` only for tabs individually at ≥ Read).
  With the extension's `agentTabControl` setting OFF (the default), it — and every
  other tool — is confined to the single foreground tab; background tabs are
  invisible/untargetable even if granted.
- `get_mode` is read-only and off-the-ladder (works even on an Off tab so an agent
  can tell it has no access). **Mode can only be changed by a human in the popup —
  there is no way to grant/escalate a tab's mode over MCP/WS/driver.**

**Practical upshot when driving a tab:** open the extension popup, find the tab you
will drive (or the tab that's currently foreground), and set its mode to at least
**Browse** for `navigate` + `read_page`/`find`. `click`/`fill` need **Assist** and
pop a trusted approval window per action unless you tick that tab's auto-approve
checkbox first; `run_js` needs **Developer** and always prompts with the source.

## 3. Prerequisites (must be true for ANYTHING to work)

1. **Firefox is open** on the user's machine.
2. **The extension is loaded** (`about:debugging#/runtime/this-firefox` → Load
   Temporary Add-on → `extension/manifest.json`). It's a *temporary* add-on — it
   **unloads when Firefox restarts**, so the user must reload it after a restart.
3. **The extension is connected** — its popup shows green. It auto-reconnects to
   `ws://127.0.0.1:8765` every ~3s using the saved token, so once *anything* binds
   8765, the extension attaches within a few seconds.
4. **Token**: `cat ~/.firefox-mcp/token.txt` (auto-generated on first bridge/driver
   run; overridable via `FXMCP_TOKEN`). The extension popup must hold the same token.
5. **Port 8765 is free** — only one WS server can bind it. Before starting a driver:
   ```bash
   ss -tlnp 2>/dev/null | grep -q ':8765' && kill $(ss -tlnp | grep -oP ':8765.*pid=\K[0-9]+')
   ```
   Do NOT blindly kill it if a monitor/bridge is intentionally running — check first.

**If the extension can't be confirmed connected, STOP** — you'll just hang. There is
no way to drive Firefox without the user's browser + loaded extension.

---

## 4. Mode A — MCP tools

Register once (needs a session restart to appear as `mcp__ridealong__*` tools):
```bash
claude mcp add ridealong -- node ~/ridealong/bridge/bridge.js
```

Tools exposed by `bridge.js` (each gated by the target tab's mode — see §2):

| Tool | Params | Returns |
| --- | --- | --- |
| `list_tabs` | — | tabs (id, active, title; `url` only for tabs at ≥ Read) |
| `get_mode` | `{tabId?}` | `{tabId, mode}` (read-only; off-the-ladder) |
| `navigate` | `{url, tabId}` | opens URL, waits for load, `{url, title}` |
| `read_page` | `{tabId?}` | `{url, title, text (≤8k), links[]}` |
| `find` | `{selector, all?, attr?, tabId?}` | element text (+ optional attr); `all` → `{matches[], count}` |
| `click` | `{selector, tabId}` | `{clicked}` |
| `fill` | `{selector, value, tabId}` | `{filled}` |
| `wait_for` | `{selector, timeoutMs?, tabId?}` | `{found}` |
| `run_js` | `{code, tabId}` | `{result}` — Developer tier; always prompts with the source |
| `ebay_sold_count` | `{term, domain?}` | convenience: navigate eBay sold-search → `{count, raw, url}` |

`run_js` runs arbitrary JS in the tab and is gated behind the **Developer** tier with a
mandatory trusted-window approval showing the exact source — use it for custom DOM logic
without adding a bespoke tool. For anything reusable, prefer adding a structured tool to
`bridge.js` + `background.js`.

---

## 5. Mode B — Driver scripts (the workhorse)

A driver `.mjs` binds `ws://127.0.0.1:8765`, waits for the extension to connect
(`hello`→`welcome`), then sends `{id, tool, params}` and awaits `{id, ok, output}`.
The tools are the **same names** the extension's `background.js` dispatches:
`list_tabs, get_mode, navigate, read_page, find, click, fill, wait_for, run_js`.
A ready-to-run copy of this template lives at `bridge/driver.example.mjs`.

### Minimal driver template (copy this to write a new driver)
```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";           // run from bridge/ (has node_modules)
const TOKEN = readFileSync(join(homedir(), ".firefox-mcp", "token.txt"), "utf8").trim();
const log = (...a) => console.error("[drv]", ...a);   // logs to stderr; DATA to stdout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ext = null, seq = 0; const pending = new Map();
const wss = new WebSocketServer({ host: "127.0.0.1", port: 8765 });
wss.on("error", (e) => { log("ws error (port busy?)", e.message); process.exit(1); });
wss.on("connection", (ws, req) => {
  if (req.headers.origin && !req.headers.origin.startsWith("moz-extension://")) { ws.close(); return; }
  let authed = false;
  ws.on("message", (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; }
    if (!authed) { if (m.type === "hello" && m.token === TOKEN) { authed = true; ext = ws; ws.send(JSON.stringify({ type: "welcome" })); run(); } else ws.close(); return; }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); } });
});
function call(tool, params, ms = 45000) {   // send a command, await its reply
  return new Promise((res, rej) => { const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); rej(new Error("timeout")); }, ms);
    pending.set(id, (m) => { clearTimeout(t); m.ok ? res(m.output) : rej(new Error(m.error)); });
    ext.send(JSON.stringify({ id, tool, params })); });
}
setTimeout(() => { log("overall timeout"); process.exit(1); }, 120000);  // never hang forever
let ran = false;
async function run() {
  if (ran) return; ran = true;                 // guard: extension may reconnect & re-fire
  const { tabs = [] } = await call("list_tabs", {});   // navigate needs an explicit tabId
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) { log("no tab — grant the foreground tab Read+ in the popup"); process.exit(1); }
  await call("navigate", { url: "https://example.com", tabId: tab.id });
  await sleep(3000);
  const page = await call("read_page", { tabId: tab.id });
  console.log("RESULTS_JSON:" + JSON.stringify({ title: page.title }));  // machine-readable line
  process.exit(0);
}
log("waiting for extension…");
```

Run it (from `bridge/` so `ws` resolves):
```bash
cd ~/ridealong/bridge && node my_driver.mjs
```

**Conventions the template follows:**
- Log progress to **stderr** (`console.error`), print the final machine-readable
  result to **stdout** as one `RESULTS_JSON:{...}` line (grep it back).
- Always set an **overall timeout** so a cron/agent call can't hang.
- Guard `run()` with a `ran` flag — the extension can reconnect mid-run and re-trigger.

---

## 6. Driver-mode gotchas (READ THIS)

- **navigate / click / fill / run_js require an explicit `tabId`.** There is no
  active-tab fallback — resolve one from `list_tabs` first. With `agentTabControl`
  OFF (default), that id must be the **foreground** tab; background tabs are
  untargetable.
- **The stale-render trap.** Navigating a search SPA, `navigate` can resolve before
  the NEW content renders, so a `find` reads the OLD page. Don't trust a fixed
  `sleep` — **wait until the content you expect actually changes** (e.g. a count
  heading AND a result list both differ from the previous page) before accepting the
  read.
- **Injected code is an expression.** The extension wraps your `run_js` code in an
  IIFE, so `return` works — but wrap awaited logic in an async IIFE
  `(async()=>{…})()`.
- **Privileged pages** (`about:`, `view-source:`, PDF viewer, `moz-extension://`)
  can't be scripted — calls fail closed with an "unsupported page" error.
- **Pace navigations** on real logged-in sites; hammering risks bot-challenges or
  rate limits.
- **Selectors drift** — when unsure, probe with `find` using `[class*='…']` and
  `attr:"class"` to discover the real class + sample text before hardcoding it.

---

## 7. Writing a scraper for a new site

A reusable, site-agnostic method. `bridge/scrape.example.mjs` implements all of it
end-to-end — copy it and change the selectors; you rarely need to touch the plumbing.

**1. Grant + open.** In the extension popup, set the foreground tab to **Browse**
(navigate + read) — or **Developer** if you'll use the `--probe`/`run_js` step below.
Open the target search/listing page in that tab.

**2. Discover the selectors** (the part that's new per site). You need the CSS
selector for the *repeating item* (card/row/listing), and optionally a "N results"
heading. Two ways:
- **Probe with the example:** `node scrape.example.mjs --probe "<url>"` — it uses
  `run_js` to dump the most common class tokens plus the price/card/item/result-ish
  ones. (Developer tier; it prompts with the source.)
- **Manually:** `find` with `{ selector: "[class*='price']", all: true, attr: "class" }`
  to see real class names + sample text, then narrow to the card selector.

**3. Extract.** `find({ selector: ITEM_SEL, all: true, attr: "href" })` returns
`{ matches: [{ text, href }, …], count }`. Parse numbers/prices out of each `text`
with a regex (see `parseNumber()` in the example).

**4. Beat the stale-render trap** (the part that bites everyone). A search SPA often
swaps results in *after* `navigate` resolves, so a naive `find` reads the OLD page.
Use a **settle loop**: capture the page's "signature" (heading + item count + a text
sample) *before* navigating, then poll after navigation until the signature is
non-empty, **differs from the pre-navigation page**, and is **stable across two
consecutive polls**. Only then read. A fixed `sleep` is not reliable.

**5. Multiple fields per card.** `find({all})` gives each card's whole `innerText`
plus **one** attribute. For separate title / price / link fields you have two options:
- Run several `find({all})` calls (one per sub-selector) and **zip by index** — simple,
  but positional and imperfect if the counts differ.
- Use **`run_js`** (Developer tier) to `querySelectorAll` the cards and map each to a
  precise `{ title, price, link }` in a single call — robust, but always prompts.

**6. Emit.** Print exactly one `RESULTS_JSON:{…}` line to **stdout**; send progress to
**stderr**. Grep the line back from the caller.

**Data-quality notes (generic, apply to any price/listing scrape):**
- Parse the currency/unit from the text — don't assume it.
- Broad queries mix unrelated variants; **filter items by a required keyword** in the
  title before you aggregate, or a median/min is meaningless.
- Watch for decoys — accessories-only listings, "style/inspired/replica" items, or
  opening-bid auctions (start price ≠ final). The cheapest match is often not the thing.

```bash
cd ~/ridealong/bridge
ITEM_SEL='.result-card' LINK_ATTR='href' node scrape.example.mjs "https://site/search?q=widget"
node scrape.example.mjs --probe "https://site/search?q=widget"   # discover selectors first
```

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Driver hangs at "waiting for extension…" | Firefox closed, extension not loaded, or not connected (popup not green). Confirm with the user. |
| `ws error: EADDRINUSE` | Something already on 8765 (a bridge/monitor). Check `ss -tlnp \| grep 8765`; kill only if safe. |
| Extension connects then nothing | Token mismatch — popup token ≠ `~/.firefox-mcp/token.txt`. |
| Every call fails with `insufficient_mode` / `... requires Read+/Browse+/...` | The target tab defaults to **Off**. Ask the user to open the extension popup and grant that tab a mode (§2). This is expected on a fresh tab, not a bug. |
| `click`/`fill` hangs, or `run_js` never returns | A trusted approval popup window opened and is waiting on the human (§2) — it does NOT appear as a page overlay, so it's easy to miss. Ask the user to check for a small extra Firefox window, or enable auto-approve for that tab (`run_js` always prompts regardless). |
| `navigate`/`click`/`fill` errors with "requires an explicit tabId" | These tools don't fall back to the active tab — call `list_tabs` first and pass its `id` explicitly (§2). |
| A `find` reads stale content after `navigate` | Stale-render trap — wait until the expected content changes, not a fixed sleep (§6). |
| `error: could not run on this tab (privileged/internal page…)` | The tab is an `about:`/`view-source:`/PDF/`moz-extension://` page — not scriptable (§6). |

---

## 9. Related

- `README.md` — human setup guide.
- `PLAN.md` — the governance layer's design + adversarial audit trail.
- The extension's capabilities live in `extension/background.js` (`dispatch()`); add
  new tools there + mirror them in `bridge.js`'s `TOOLS` for MCP mode.
