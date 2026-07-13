# ridealong

Let a local AI agent (Claude Code, Codex, any MCP client) drive **your real
Firefox** — navigate, read the DOM, query/click/fill — over MCP. Because it runs
inside genuine Firefox (real fingerprint, real session, **no CDP / no
`navigator.webdriver`**), it avoids the automation fingerprinting that gets
Electron/Playwright/Puppeteer flagged by anti-bot systems.

Every tool call is gated through a **per-tab permission layer**: every tab starts
**Off**, a human grants a mode from the popup, effectful actions prompt for approval
in trusted extension chrome, and everything is written to a hash-chained audit log.
See [AGENT_GUIDE.md §2](AGENT_GUIDE.md) for the ladder and [PLAN.md](PLAN.md) for the
full design/threat model.

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
- `bridge/driver.example.mjs` — a minimal driver-mode example to copy.
- `extension/` — the Firefox WebExtension (background WS client + broker + tab/DOM executor + popup).
- `AGENT_GUIDE.md` — how an AI agent uses/extends it.
- `PLAN.md` — the governance layer's design + adversarial audit trail.

## Tools exposed
Each is gated by the target tab's mode (see the ladder below); `tabId` is **required**
for `navigate`/`click`/`fill`/`run_js` (no active-tab fallback).

| Tool | Tier | What it does |
| --- | --- | --- |
| `list_tabs` | Read | open tabs (id, active, title; `url` only for tabs at ≥ Read) |
| `get_mode {tabId?}` | — | read a tab's current mode (read-only; off-the-ladder) |
| `read_page {tabId?}` | Read | url, title, visible text (truncated), links |
| `find {selector, all?, attr?, tabId?}` | Read | element text (+ optional attribute) by CSS selector |
| `wait_for {selector, timeoutMs?, tabId?}` | Read | wait until a selector appears |
| `navigate {url, tabId}` | Browse | open a URL in a tab, wait for load, return url+title |
| `click {selector, tabId}` / `fill {selector,value,tabId}` | Assist | interact (per-action approval) |
| `run_js {code, tabId}` | Developer | run JS in a tab (always shows the source for approval) |
| `ebay_sold_count {term, domain?}` | Browse¹ | convenience: open the eBay **sold-items** search and return the result count |

¹ `ebay_sold_count` is composed in the bridge from `list_tabs`/`navigate`/`find`, so it's gated via those primitives on the foreground tab.

## Permission model
Every tab starts **Off** (all tools denied). A human raises a tab's mode from the
extension popup — never the agent, never a web page:

**Off → Read → Browse → Assist → Developer.** Effectful actions (click/fill/run_js)
prompt for approval in a trusted extension window a page can't reach or fake; `run_js`
always shows its exact source. A **Stop AI** button reverts every tab instantly, and
every decision is written to a hash-chained audit log. Full detail: [AGENT_GUIDE.md §2](AGENT_GUIDE.md).

## Setup

### 1. Install the bridge deps (once)
```bash
cd ~/ridealong/bridge && npm install
```

### 2. Register it with your agent
```bash
claude mcp add ridealong -- node ~/ridealong/bridge/bridge.js
```
On first run the bridge generates a token, prints it to stderr, and saves it to
`~/.firefox-mcp/token.txt`. Default WebSocket port `8765` (override with
`FXMCP_PORT`; fix the token with `FXMCP_TOKEN`).

### 3. Load the extension in Firefox
- Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
  pick `extension/manifest.json`.
- (Temporary add-ons unload on restart. To keep it permanently on Firefox ESR/Dev,
  set `xpinstall.signatures.required=false` in `about:config` and install the
  packaged `.xpi`, or sign it with `web-ext`. An AMO listing is in review.)

### 4. Connect the extension to the bridge
- Click the extension's toolbar icon → paste the **token** (from step 2) → **Save &
  Connect**. Status should go green (`connected`). It auto-reconnects afterwards.
- Or use the popup's **one-paste onboarding**: it mints a token and generates a
  self-describing prompt you hand to your local agent, which clones, installs, and
  registers the bridge for you (see [ONBOARDING_PLAN.md](ONBOARDING_PLAN.md)).

## Use it (MCP mode)
Once the agent has the `ridealong` MCP server and the popup shows *connected*, grant a
tab a mode and ask your agent to read or drive it — e.g. *"use ridealong to read the
current tab"* or *"navigate tab N to …"*. Since it's your real browser, sites serve the
page normally.

## Driver-script mode
A standalone `.mjs` can **be** the WebSocket server and drive the extension directly —
**no MCP registration needed**, just Firefox open with the extension connected. Copy
`bridge/driver.example.mjs` as a starting point; it resolves the foreground tab via
`list_tabs`, navigates it, and reads the page:

```bash
cd ~/ridealong/bridge
node driver.example.mjs https://example.com    # grant the foreground tab Browse+ first
```

The full driver template + conventions are in [AGENT_GUIDE.md §5](AGENT_GUIDE.md).

> **Port note:** only one WS server can hold `:8765`. If a bridge/driver is already
> running, another will fail to bind — check `ss -tlnp | grep 8765` first.

## Security
- The bridge binds **127.0.0.1 only** and requires the shared **token** before any
  command runs; it rejects non-`moz-extension://` WebSocket origins.
- Every tab starts **Off** — the agent can do nothing until a human grants that tab a
  mode from the popup. Effectful actions (click/fill/run_js) prompt for approval in
  trusted extension chrome a page can't reach; **Stop AI** revokes everything at once.
- Every allow/deny decision is written to a hash-chained, tamper-evident audit log.
- The token is **not** a boundary against other same-user local processes — the real
  containment is the per-tab mode gate + kill switch. Keep the token private anyway.
- Not a stealth tool: it doesn't spoof anything. It's low-detection simply because
  it *is* the real browser. Respect sites' Terms of Service.

## Status
Working. Bridge + extension relay verified end-to-end; the Tier-1 governance layer
(per-tab modes, trusted-chrome approval, hash-chained audit) is implemented in
`extension/background.js` and `bridge/bridge.js`. Extension DOM ops use standard
`tabs.executeScript`. Extending it? Read [AGENT_GUIDE.md](AGENT_GUIDE.md) first.
