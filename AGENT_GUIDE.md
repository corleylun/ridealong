# firefox-mcp — Agent Guide

**Audience:** an AI agent (Claude Code, Codex, etc.) that needs to read/drive a
**real, logged-in Firefox** — to scrape sites that block automation (eBay Seller
Hub, Yahoo! Japan, Buyee, marketplaces behind Cloudflare), or to act on a user's
authenticated session.

**Why it exists:** headless automation (Electron/Playwright/Puppeteer) and plain
`curl`/WebFetch get fingerprinted and blocked — CDP attached, `navigator.webdriver`,
datacenter IP, etc. firefox-mcp runs commands **inside the user's genuine Firefox**
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
  the MCP layer) and sends commands to the extension directly. **This is the
  workhorse** — it works from any Bash shell with no MCP registration, and it's how
  all the existing scrapers run.

**Prefer Driver mode (B)** unless firefox-mcp is already registered as an MCP server
in your session. It's more flexible and needs no session restart.

---

## 2. Prerequisites (must be true for ANYTHING to work)

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

## 3. Mode A — MCP tools

Register once (needs a session restart to appear as `mcp__firefox-mcp__*` tools):
```bash
claude mcp add firefox-mcp -- node ~/dev/tools/firefox-mcp/bridge/bridge.js
```

Tools exposed by `bridge.js`:

| Tool | Params | Returns |
| --- | --- | --- |
| `list_tabs` | — | open tabs (id, active, url, title) |
| `navigate` | `{url, tabId?}` | opens URL, waits for load, `{url, title}` |
| `read_page` | `{tabId?}` | `{url, title, text (≤8k), links[]}` |
| `find` | `{selector, all?, attr?, tabId?}` | element text (+ optional attr); `all` → `{matches[], count}` |
| `click` | `{selector, tabId?}` | `{clicked}` |
| `fill` | `{selector, value, tabId?}` | `{filled}` |
| `wait_for` | `{selector, timeoutMs?, tabId?}` | `{found}` |
| `ebay_sold_count` | `{term, domain?}` | convenience: navigate eBay sold-search → `{count, raw, url}` |

No `run_js` is exposed (structured tools only — safer). If you need custom DOM logic,
either add a tool to `bridge.js` or use Driver mode with a bespoke `find`/read flow.

---

## 4. Mode B — Driver scripts (the workhorse)

A driver `.mjs` binds `ws://127.0.0.1:8765`, waits for the extension to connect
(`hello`→`welcome`), then sends `{id, tool, params}` and awaits `{id, ok, output}`.
The tools are the **same names** the extension's `background.js` dispatches:
`list_tabs, navigate, read_page, find, click, fill, wait_for`.

### Minimal driver template (copy this to write a new scraper)
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
  await call("navigate", { url: "https://example.com" });
  await sleep(3000);
  const page = await call("read_page");
  console.log("RESULTS_JSON:" + JSON.stringify({ title: page.title }));  // machine-readable line
  process.exit(0);
}
log("waiting for extension…");
```

Run it (from `bridge/` so `ws` resolves):
```bash
cd ~/dev/tools/firefox-mcp/bridge && node my_driver.mjs
```

**Conventions the existing scrapers follow:**
- Log progress to **stderr** (`console.error`), print the final machine-readable
  result to **stdout** as one `RESULTS_JSON:{...}` line (grep it back).
- Always set an **overall timeout** so a cron/agent call can't hang.
- Guard `run()` with a `ran` flag — the extension can reconnect mid-run and re-trigger.

---

## 5. The existing scrapers (in `bridge/`)

| Script | Purpose | Key env / args |
| --- | --- | --- |
| `driver.mjs` | eBay SOLD median + count for search terms | `EBAY_DOMAIN` (www.ebay.co.uk / www.ebay.com), `EBAY_COND` (1000=New, 3000=Used), `GBP_PER_USD`, `FXMCP_DELAY_MS`; args = terms |
| `jp_driver.mjs` | Buyee/HLJ BUY prices (min + median GBP) | `SITE_URL_TPL` (`{q}` placeholder), `PRICE_SEL`, `PRICE_CCY` (JPY/GBP), `GBP_JPY`; args = terms |
| `verify.mjs` | eBay sold **title-filtered** (edit its `ITEMS` array) | in-file config |
| `buyee_cheap.mjs` | cheapest genuine Buyee listings | args: `"query" "keyword"` |
| `buyee_links.mjs` | Buyee listings **with item links** | args: `"query" "keyword" maxGBP` |
| `peek.mjs` | dump current tab (or navigate first) | optional arg: url |
| `watch_auction.mjs` | log a Buyee auction's price/bids/time | args: `url logfile` |

Each prints a `RESULTS_JSON:` line (except peek/watch which log directly).

---

## 6. Hard-won lessons & gotchas (READ THIS)

**Site access**
- **Yahoo! Japan geo-blocks the UK/EEA** — `auctions.yahoo.co.jp` returns a notice
  page. Use **Buyee** (`buyee.jp`), which mirrors Yahoo Auctions + Mercari and is
  UK-accessible. Buyee is also how a UK user would actually buy.
- **Buyee/eBay block plain `curl`/WebFetch** (0 bytes / Cloudflare). You MUST go
  through the real Firefox for these.
- **eBay Seller Hub / Terapeak** requires the account to be enrolled in Seller Hub,
  and it aggressively challenges automation — even the real browser can trip it if
  you navigate too fast. Public **sold-search** pages (`&LH_Sold=1`) are far more
  lenient than Seller Hub.

**Selectors (they drift — verify with a probe first)**
- eBay results price: **`.su-item-card__price`** (old `.s-item__price` is dead).
  Result count heading: `.srp-controls__count-heading`. Item card: `.su-item-card`.
- Buyee price: **`.g-price`** (text like `"71,500 YEN"`); item cards: `.itemCard`;
  item links match `/item/(jdirectitems|yahoo)/auction/` or `/item/mercari/`.
- HLJ price: **`.price`** (already shows GBP if the browser is set to £).
- When unsure, **probe**: `find` with `[class*='price']` / `[class*='rice']` and
  `attr:"class"` to discover the real class + sample text.

**The stale-render trap (critical for multi-term scrapes)**
Navigating a search SPA, `navigate` can resolve before the NEW results render, so a
`find` reads the OLD page. Fix: **wait until BOTH the count heading AND the price
list change** from the previous term before accepting the read (see `readState()` /
the settle loop in `driver.mjs`). Capture the starting page's state first so even the
first term waits for a real change. The first term can still miss ("no settle") if
the page didn't change enough — re-pull it or seed a throwaway first term.

**Data quality**
- **Broad-term medians LIE.** A generic search mixes cheap variants (drag the buy
  median down) with pricey ones (push the sell median up), inventing fake margins.
  Always **drill to a specific model** and **title-filter** (keep only cards whose
  title contains required keywords — see `verify.mjs`). 0 genuine matches = no market.
- **Currency:** parse the symbol. `.co.uk`=£, `.com`=$ (convert via `GBP_PER_USD`),
  Buyee=¥ (convert via `GBP_JPY`). Filter to one currency for a clean median.
- **Decoys:** cheap listings are often the wrong thing — a *nib only*, *case only*,
  a *kids/"mini"* version, a *"style/inspired/replica"* fake, or a ¥1-start auction
  (opening bid ≠ final price). Read titles; don't trust the raw minimum.

**Behaviour / safety**
- **Pace it** — `FXMCP_DELAY_MS=8000` between navigations. It's a real logged-in
  account; hammering risks bot-challenges or rate limits.
- **executeJavaScript is an expression** (internal to the extension) — no top-level
  `return`; wrap awaited logic in an async IIFE `(async()=>{…})()`. Only relevant if
  you extend `background.js`.
- **Link↔price pairing is positional** in `buyee_links.mjs` and imperfect — give the
  user the sorted search URL + a couple sample item links, not a guaranteed map.

---

## 7. Common recipes

```bash
cd ~/dev/tools/firefox-mcp/bridge

# eBay UK used-sold median for specific models
EBAY_COND=3000 FXMCP_DELAY_MS=8000 node driver.mjs "Daiwa Certate LT3000" "Pilot Custom 823"

# eBay US sold (converts $→£)
EBAY_DOMAIN=www.ebay.com FXMCP_DELAY_MS=8000 node driver.mjs "Burberry Sandringham trench"

# Buyee (Japan secondhand) buy prices
FXMCP_DELAY_MS=8000 node jp_driver.mjs "真骨彫 カイザ 555" "Pilot Custom 74"

# HLJ new-retail (GBP)
PRICE_CCY=GBP PRICE_SEL=".price" SITE_URL_TPL="https://www.hlj.com/search/?Word={q}" node jp_driver.mjs "PG Gundam"

# cheapest genuine listings + links
node buyee_cheap.mjs "真骨彫 カイザ 555" "カイザ"
node buyee_links.mjs "Pilot Custom 74 万年筆" "custom 74" 60

# read whatever tab the user is on (e.g. a seller's page)
node peek.mjs
node peek.mjs "https://buyee.jp/item/search/query/..."
```

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Driver hangs at "waiting for extension…" | Firefox closed, extension not loaded, or not connected (popup not green). Confirm with the user. |
| `ws error: EADDRINUSE` | Something already on 8765 (a bridge/monitor). Check `ss -tlnp \| grep 8765`; kill only if safe. |
| Extension connects then nothing | Token mismatch — popup token ≠ `~/.firefox-mcp/token.txt`. |
| Prices misaligned across terms | Stale-render trap — use the both-changed settle (see §6). |
| Median looks wrong / too low | Contamination — title-filter (`verify.mjs`) and drill to a specific model. |
| eBay "Pardon our interruption" | Bot challenge — you navigated too fast, or it's Seller Hub. Slow down; prefer public sold-search. |
| Japan page shows EEA/UK notice | Direct Yahoo JP is geo-blocked — use Buyee. |

---

## 9. Related

- `README.md` — human setup guide.
- The `/resale-research` Claude skill (`~/.claude/skills/resale-research/`) drives
  these scrapers for Japan→UK / UK→overseas resale vetting; its lessons overlap §6.
- The extension's capabilities live in `extension/background.js` (`dispatch()`); add
  new tools there + mirror them in `bridge.js`'s `TOOLS` for MCP mode.
