# firefox-mcp

Let a local AI agent (Claude Code, Codex, any MCP client) drive **your real
Firefox** — navigate, read the DOM, query/click/fill — over MCP. Because it runs
inside genuine Firefox (real fingerprint, real session, **no CDP / no
`navigator.webdriver`**), it avoids the automation fingerprinting that gets
Electron/Playwright/Puppeteer flagged by anti-bot systems.

```
  AI agent ──MCP (stdio)──▶  bridge  ──ws://127.0.0.1──▶  Firefox extension ──▶ page
                            (Node)                        (WebExtension)
```

A browser extension can't listen on a port (so it can't *be* an MCP server), but
it can dial **out** over a WebSocket. The **bridge** is the middle: an MCP server
to the agent, a WebSocket server to the extension. Each MCP tool call is relayed to
the extension, which does the work in the real browser and replies.

**Two ways to use it:**
- **MCP mode** — register `bridge.js` with your agent (below); it calls tools like
  `navigate` / `find`.
- **Driver-script mode** — a standalone `.mjs` script *is* the WebSocket server and
  drives the extension directly (no MCP registration needed). This is how the
  bundled **ready-made scrapers** run (see below), and it works from any shell.

> 🤖 **Building on it?** See **[AGENT_GUIDE.md](AGENT_GUIDE.md)** — a full guide for
> an AI agent (architecture, both modes, a driver template, and the hard-won gotchas).

## Layout
- `bridge/bridge.js` — Node MCP server + localhost WebSocket server.
- `bridge/*.mjs` — ready-made scrapers (see below) + a driver template pattern.
- `extension/` — the Firefox WebExtension (background WS client + tab/DOM executor + popup).
- `AGENT_GUIDE.md` — how an AI agent uses/extends it.

## Tools exposed
| Tool | What it does |
| --- | --- |
| `list_tabs` | open tabs (id, active, url, title) |
| `navigate {url, tabId?}` | open a URL in a tab, wait for load, return url+title |
| `read_page {tabId?}` | url, title, visible text (truncated), links |
| `find {selector, all?, attr?}` | element text (+ optional attribute) by CSS selector |
| `click {selector}` / `fill {selector,value}` | interact with the page |
| `wait_for {selector, timeoutMs?}` | wait until a selector appears |
| `ebay_sold_count {term, domain?}` | convenience: open the eBay **sold-items** search and return the result count (≈ sold in last ~90 days) |

## Setup

### 1. Install the bridge deps (once)
```bash
cd ~/dev/tools/firefox-mcp/bridge && npm install
```

### 2. Register it with your agent
```bash
claude mcp add firefox-mcp -- node ~/dev/tools/firefox-mcp/bridge/bridge.js
```
On first run the bridge generates a token, prints it to stderr, and saves it to
`~/.firefox-mcp/token.txt`. Default WebSocket port `8765` (override with
`FXMCP_PORT`; fix the token with `FXMCP_TOKEN`).

### 3. Load the extension in Firefox
- Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
  pick `extension/manifest.json`.
- (Temporary add-ons unload on restart. To keep it permanently on Firefox ESR/Dev,
  set `xpinstall.signatures.required=false` in `about:config` and install the
  packaged `.xpi`, or sign it with `web-ext`.)

### 4. Connect the extension to the bridge
- Click the extension's toolbar icon → paste the **token** (from step 2) → **Save &
  Connect**. Status should go green (`connected`). It auto-reconnects afterwards.

## Use it (MCP mode)
Once the agent has the `firefox-mcp` MCP server and the popup shows *connected*, ask
your agent to e.g. *"use firefox-mcp to get the eBay sold count for Bandai Master
Grade Gundam"* — it calls `ebay_sold_count`, Firefox navigates the sold-search, and
the number comes back. Since it's your real browser, eBay serves the page normally.

## Ready-made scrapers (driver-script mode)
These live in `bridge/` and drive the extension directly — **no MCP registration
needed**, just Firefox open with the extension connected. Run them from `bridge/`.
Each prints a `RESULTS_JSON:` line; pace multi-term runs with `FXMCP_DELAY_MS=8000`.

| Script | What it pulls |
| --- | --- |
| `driver.mjs "term" …` | eBay **sold** median + count (`EBAY_DOMAIN`, `EBAY_COND` 1000=New/3000=Used) |
| `jp_driver.mjs "term" …` | **Buyee**/HLJ **buy** prices (`SITE_URL_TPL`, `PRICE_SEL`, `PRICE_CCY`) |
| `verify.mjs` | eBay sold **title-filtered** (edit its `ITEMS` array) |
| `buyee_cheap.mjs "q" "kw"` | cheapest genuine Buyee listings |
| `buyee_links.mjs "q" "kw" max` | Buyee listings **with item links** |
| `peek.mjs [url]` | dump the current tab's url/title/text |
| `watch_auction.mjs url log` | log a Buyee auction's price/bids/time (used with cron) |

```bash
cd ~/dev/tools/firefox-mcp/bridge
EBAY_DOMAIN=www.ebay.com FXMCP_DELAY_MS=8000 node driver.mjs "Burberry Sandringham trench"
FXMCP_DELAY_MS=8000 node jp_driver.mjs "Pilot Custom 74"          # Buyee (Japan) buy prices
node peek.mjs                                                      # read the page you're on
```

> **Port note:** only one WS server can hold `:8765`. If a bridge/monitor is already
> running, a scraper will fail to bind — check `ss -tlnp | grep 8765` first.

## Security
- The bridge binds **127.0.0.1 only** and requires the shared **token** before any
  command runs; it rejects non-`moz-extension://` WebSocket origins.
- The extension only acts while **Firefox is open** and you've clicked **Connect**.
- It runs in your logged-in browser — treat it like handing the agent your session.
  Keep the token private; disconnect in the popup when you're done.
- Not a stealth tool: it doesn't spoof anything. It's low-detection simply because
  it *is* the real browser. Respect sites' Terms of Service.

## Status
Working. Bridge + extension relay verified end-to-end, and the driver-script scrapers
are used in anger for real research (eBay UK/US sold data, Buyee/Yahoo-Auctions/Mercari
buy prices, HLJ retail, live auction monitoring). Extension DOM ops use standard
`tabs.executeScript`. Selectors and site quirks are documented in
[AGENT_GUIDE.md](AGENT_GUIDE.md) §6 — read it before adding a new scraper.
