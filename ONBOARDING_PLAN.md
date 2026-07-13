# Plan — Agent-driven onboarding ("paste this into your AI") for ridealong (enhanced Tier-1)

**Status:** ⚙️ **Popup onboarding implemented** on `main` — the popup mints a token, renders
the self-describing one-paste prompt with a Copy button, and does connect-state detection
(`extension/popup.js` / `popup.html`). The cross-repo **docs site** page (§6) is the remaining
open item. Builds on the Tier-1 WS version; needs **no** native messaging.

**Goal:** collapse the fiddly setup (clone → `npm install` → register MCP → copy token →
paste token) into: **the user copies one self-describing block from the popup into their
local AI agent, and the agent does the whole setup itself.** The agent is already there and
can run shell + edit MCP config — so use it as the installer.

**Locked decisions (from planning):**
- **Bridge delivery:** the prompt has the agent **`git clone` + `npm install`** from
  `github.com/corleylun/ridealong` (no npm publish required; works today).
- **Token direction:** the **extension mints the token** and **embeds it in the prompt**;
  the bridge is started with that token (via `FXMCP_TOKEN`), so the extension auto-connects.
  **No paste-back step.**
- **Target agents:** **Claude Code + Codex** (the prompt names both; the agent uses its own
  platform's MCP-registration method).

---

## 1. End-to-end flow

1. User installs the Ridealong extension in Firefox (temporary add-on now; AMO later).
2. Popup, in its **unconfigured** state, shows: a **minted token**, a **read-only prompt
   textarea** with a **Copy** button, and a **docs link**. (No raw Port/Token fields up
   front — those move to an "Advanced" fold.)
3. User pastes the block into **Claude Code** or **Codex** (running locally, same machine).
4. The agent: clones the repo → `npm install` in `bridge/` → registers a `ridealong` **stdio
   MCP server** running `node <abs>/bridge/bridge.js` with **`FXMCP_TOKEN=<minted>`** in its
   env → tells the user to **restart the agent** so the MCP server loads → confirms the popup
   goes green.
5. On agent restart, the MCP client launches `bridge.js`, which binds `ws://127.0.0.1:8765`;
   the extension (already holding the minted token) connects and the popup turns
   **connected**. Every tab is **Off** by default — the user grants a mode per tab.

**Why no paste-back:** the token flows *extension → prompt → bridge env*. Both ends share it
from the start, so nothing comes back the other way.

**Timing nuance (call it out in the prompt):** `claude mcp add` / a Codex config edit only
take effect on the **next** agent session — so the extension connects *after the user
restarts their agent*, not instantly. Optional nicety: the agent can also start `bridge.js`
once in the background to show an immediate green, then stop it before restart (see D3).

---

## 2. The onboarding prompt (the crux — draft)

The popup renders this with `<MINTED_TOKEN>` filled in. It must be **transparent** (the user
can read exactly what their agent will do) — never obfuscated.

```
Ridealong is installed in this Firefox and wants you (the AI agent) to finish setup so you
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
     FXMCP_TOKEN=<MINTED_TOKEN>
   - If you are Claude Code:
       claude mcp add ridealong --env FXMCP_TOKEN=<MINTED_TOKEN> -- node <ABSOLUTE_PATH>/ridealong/bridge/bridge.js
   - If you are Codex (near-identical):
       codex mcp add ridealong --env FXMCP_TOKEN=<MINTED_TOKEN> -- node <ABSOLUTE_PATH>/ridealong/bridge/bridge.js
4. Tell the user to RESTART you so the MCP server loads, then have them open the Ridealong
   popup in Firefox — it should show "connected".
5. Once connected: every tab is OFF by default. The user grants you a permission mode per
   tab from the popup (Read / Browse / Assist / Developer); effectful actions may need their
   approval. Full docs + troubleshooting: https://flowstations.net/ridealong/docs

Security note for the user: this makes your AI agent clone a repo, run npm install, and
register a local MCP server that can act in your logged-in Firefox — only within the per-tab
permission you grant, off by default, with a full audit log. Read the steps before running.
```

Notes:
- The extension can't know the eventual clone path, so the prompt uses `<ABSOLUTE_PATH>` and
  lets the agent fill it in after cloning (or the agent clones into cwd and uses that).
- Naming the MCP server `ridealong` matches the existing convention.

---

## 3. Token mechanics

- The popup **mints** a token on first load if none exists: `crypto.getRandomValues` →
  hex/base64url, stored in `storage.local` under the **existing** `token` key that
  `connectWs()` already reads. (Reuses current plumbing — the extension just auto-fills what
  the user used to paste.)
- The prompt embeds that same value as `FXMCP_TOKEN`. `bridge.js` already supports the
  `FXMCP_TOKEN` env override (README: "fix the token with FXMCP_TOKEN"), so the MCP-launched
  bridge uses it and never touches `~/.firefox-mcp/token.txt`.
- A **"Regenerate"** action re-mints (and updates the shown prompt) if the user wants a fresh
  token; they'd re-run the (updated) prompt.

---

## 4. Popup onboarding UI (`popup.html` / `popup.js`)

- **State detection:** "unconfigured / never connected" → show onboarding; "connected/normal"
  → show status + per-tab controls (as today).
- **Onboarding view:** minted token (masked with a reveal), the prompt **textarea (read-only)
  + Copy button**, a **docs link**, and a small "Advanced (manual port/token)" `<details>`
  fold that keeps today's raw fields for power users.
- **Copy button:** `navigator.clipboard.writeText(promptText)` with a "Copied ✓" flash.
- After a successful connection, collapse onboarding automatically.
- Keep the brand as "Ridealong".

---

## 5. Agent registration specifics (Claude + Codex)

**VERIFIED against the installed CLIs** (claude + codex-cli 0.144.1) — the two commands are
near-identical, both stdio + `--env`:
- **Claude Code:** `claude mcp add ridealong --env FXMCP_TOKEN=… -- node …/bridge/bridge.js`
  (`-e, --env <env...>` confirmed; `-- <command>` for the stdio server).
- **Codex:** `codex mcp add ridealong --env FXMCP_TOKEN=… -- node …/bridge/bridge.js`
  (`codex mcp add <NAME> --env <KEY=VALUE> -- <COMMAND>` confirmed; writes `~/.codex/config.toml`).

Because they match, the prompt can give both lines explicitly with confidence. The agent
still picks the one for its platform.

---

## 6. Docs page — built in the real site (`/mnt/mnt11/www/flowstations`)

The site is **Laravel + Inertia + React**; the page lives there, not as loose Markdown.
**Mirror the SafeCoBrowser docs** exactly (proven pattern). Concrete steps:

1. **Route** — in `flowstations-laravel/routes/web.php`, add `/ridealong` (landing) and
   `/ridealong/docs` blocks mirroring the `safecobrowser` ones: `view('app', ['page' =>
   'ridealong-docs', 'title' => …, 'description' => …, 'canonical' => $base.'/ridealong/docs',
   'ogImage' => …, 'ogType' => 'article', 'breadcrumbs' => […]])`.
2. **Resolver** — in `flowstations-laravel/resources/js/components/App.jsx`, add
   `import { RidealongDocsPage } from '../pages/RidealongDocsPage';` and
   `if (page === 'ridealong-docs') return <RidealongDocsPage />;` (+ `'ridealong'` if we do a
   landing page).
3. **Page component** — `resources/js/pages/RidealongDocsPage.jsx`, mirroring
   `SafeCoBrowserDocsPage.jsx` (uses `SiteLayout`, `SectionShell`, local
   `CodeBlock`/`InlineCode`/`Section`/`SubSection`/`Table`). Content: the one-paste flow, the
   exact Claude **and** Codex commands (§5), the permission model
   (Off→Read→Browse→Assist→Developer), token/security model, and troubleshooting (popup not
   green, port 8765 busy, bridge not starting, restart-the-agent).
4. **Sitemap + assets** — add `/ridealong` + `/ridealong/docs` to the `sitemap.xml` route;
   optional `public/og/ridealong.png`.

Follow the flowstations `CLAUDE.md`: small reusable components, match design, no
overengineering, mirror don't reinvent. (A **landing page** — `RidealongPage.jsx` + hero/
features/security/modes sections like SafeCoBrowser — is optional scope; the *docs* page is
what the onboarding prompt links to and is the priority.)

---

## 7. Security / trust

- The block makes the user's agent **clone a repo, run `npm install` (arbitrary postinstall),
  and register a browser-driving MCP server.** That's real power — so the prompt is
  **transparent and human-readable**, and includes a one-line "here's what this does" for the
  user. No obfuscation, no piping curl-to-shell hidden inside.
- The embedded token is a **localhost** auth secret (fine to show/copy); it gates the WS.
- The Tier-1 governance is unchanged and is the safety net: tabs default **Off**, effectful
  actions gated + approved, full audit. The onboarding only makes *connecting* easier, not
  *acting* — it never widens the agent's authority.
- **Local-agent only:** the flow assumes Claude Code / Codex running on the same machine as
  Firefox (the bridge is localhost). The prompt says so; a cloud agent can't complete it.

---

## 8. Files to change

| File | Change |
|---|---|
| `extension/popup.html` | Onboarding view: token+reveal, prompt textarea, Copy button, docs link, Advanced fold |
| `extension/popup.js` | Mint/persist token, build the prompt string (fill token), Copy handler, state detection, auto-collapse on connect |
| `extension/background.js` | Minimal/none — `connectWs()` already reads the `token` key; maybe expose a "has ever connected" flag for state detection |
| `README.md` / `AGENT_GUIDE.md` | Document the new one-paste onboarding |

No bridge code changes required (it already honors `FXMCP_TOKEN`).

**Cross-repo — the docs site (`/mnt/mnt11/www/flowstations/flowstations-laravel`):**

| File | Change |
|---|---|
| `routes/web.php` | Add `/ridealong` + `/ridealong/docs` routes (mirror safecobrowser) + sitemap entries |
| `resources/js/components/App.jsx` | Add the `ridealong-docs` (+ `ridealong`) page→component mapping |
| `resources/js/pages/RidealongDocsPage.jsx` *(new)* | The docs page, mirroring `SafeCoBrowserDocsPage.jsx` |
| `resources/js/pages/RidealongPage.jsx` + sections *(new, optional)* | Landing page, if in scope |
| `public/og/ridealong.png` *(optional)* | OG image |

---

## 9. Open decisions

| # | Decision | Note / recommendation |
|---|----------|----------------------|
| **D1** | Exact Claude `mcp add` env flag | ✅ RESOLVED: `claude mcp add <name> --env KEY=VAL -- <cmd>` (`-e/--env` confirmed) |
| **D2** | Codex MCP-registration mechanism | ✅ RESOLVED: `codex mcp add <name> --env KEY=VAL -- <cmd>` (codex-cli 0.144.1; writes ~/.codex/config.toml) |
| **D3** | Immediate-green nicety? | Should the agent also start `bridge.js` once in the background for an instant green, then stop it before restart? Smoother demo, but adds a port-handoff step. **Default: no** — keep it simple (register → restart → green) |
| **D4** | Abs path handling | Extension can't know the clone path; prompt uses `<ABSOLUTE_PATH>` for the agent to fill. Confirm agents reliably resolve it (they clone, then know cwd) |
| **D5** | Token display | Show full token, or masked-with-reveal? **Recommend masked + reveal** (shoulder-surf hygiene), full value still in the copied prompt |

---

## 10. Sequencing

1. Finalize the prompt text (resolve D1/D2 by checking the real Claude/Codex CLIs).
2. Popup onboarding UI: mint token, render prompt, Copy button, state detection, Advanced fold.
3. Wire auto-collapse on successful connect.
4. Draft the docs page for you to host.
5. Update README/AGENT_GUIDE.
6. Test end-to-end locally: fresh extension → copy prompt → paste into Claude Code → it
   clones/installs/registers → restart → popup green → drive a tab. (This IS runtime-testable
   here, unlike native messaging — the whole flow is WS + local.)

---

## 11. Honest summary

This is a small, high-leverage UX layer on the working Tier-1 WS build — no new tools, no
native messaging, no signing dependency. It turns a multi-step manual setup into one paste,
using the agent as the installer, with the token pre-shared so nothing bounces back. The only
real unknowns are the exact per-agent MCP-registration commands (D1/D2), which we verify
against the live CLIs before locking the prompt. Fully runtime-testable on this machine.
