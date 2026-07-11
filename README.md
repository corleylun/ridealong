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

## Layout
- `bridge/` — Node MCP server + localhost WebSocket server (`bridge.js`).
- `extension/` — the Firefox WebExtension (background WS client + tab/DOM executor + popup).

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

## Use it
Once the agent has the `firefox-mcp` MCP server and the popup shows *connected*, ask
your agent to e.g. *"use firefox-mcp to get the eBay sold count for Bandai Master
Grade Gundam"* — it calls `ebay_sold_count`, Firefox navigates the sold-search, and
the number comes back. Since it's your real browser, eBay serves the page normally.

## Security
- The bridge binds **127.0.0.1 only** and requires the shared **token** before any
  command runs; it rejects non-`moz-extension://` WebSocket origins.
- The extension only acts while **Firefox is open** and you've clicked **Connect**.
- It runs in your logged-in browser — treat it like handing the agent your session.
  Keep the token private; disconnect in the popup when you're done.
- Not a stealth tool: it doesn't spoof anything. It's low-detection simply because
  it *is* the real browser. Respect sites' Terms of Service.

## Status
v0.1 — bridge + relay verified end-to-end (MCP ⇄ bridge ⇄ extension). The extension
DOM ops use standard `tabs.executeScript`; load it in Firefox to use for real.
