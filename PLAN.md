# Plan — Tier 1 permission + audit layer for ridealong (firefox-mcp)

**Status:** ✅ **Implemented** on `main` — the broker, per-tab mode ladder, trusted-chrome
approval, session epoch, kill switch, and hash-chained audit all live in
`extension/background.js` (`dispatch()`) and `bridge/bridge.js`. This document is kept as
the design rationale + adversarial audit trail; the code is the source of truth.
**Revised** after an adversarial Opus audit (see §12) — the approval surface, the
`list_tabs` leak, the audit sink, and several honesty caveats were corrected.
**Goal:** give the extension the *safety/governance spine* of JoinTab/SafeCoBrowser
(`src/core/` — Broker, per-tab modes, approval, audit) **without** its isolation model.
ridealong's premise stays: the agent drives **your real, logged-in Firefox**. This plan
just makes that access **gated, per-tab, killable, and logged** instead of "here's a
token, you have my whole session."

**Threat model (be honest about it).** The **web page is hostile**; the **agent/driver is
semi-trusted** (it holds the token and, in driver mode, *is* the WS server). The token is
**not** a boundary against other same-user local processes — the extension dials out and
sends the token to whoever binds port 8765 first (`background.js:40`), and any same-user
process can read `~/.firefox-mcp/token.txt` or port-squat. The **real containment is the
per-tab mode gate + kill switch**, which confines even a rogue driver to tabs *you* granted.
Approval UI must therefore live in **trusted extension chrome**, never in the hostile page.

---

## 1. Scope

### In scope (Tier 1 — the governance layer)
- Per-tab **permission ladder** (Off → Read → Browse → Assist → Developer).
- A **broker** in the extension: single chokepoint, fail-closed, mode gate + input
  validation + approval + session epoch + audit-emit.
- **Per-action approval** for effectful tools, in **trusted extension chrome** (a
  `windows.create` popup) — *never* an in-page overlay (§5).
- **Kill switch** (Stop AI) + **disconnect-agent** + **token rotation** (§7).
- **Hash-chained audit log** — authoritative sink is the **bridge file** when present;
  extension IndexedDB is the driver-mode fallback (§6).
- **Best-effort secret redaction before the WS send** (not a trust boundary — content script
  and background are the same trust level; see §6/§12). Reduces *accidental* secret exposure
  to the agent; it is not a containment control.
- `get_mode` tool (read-only); mode is **never** settable over the wire.
- Optional **`run_js`** tool, gated behind the Developer tier (currently refused entirely).

### Out of scope (Tier 3 — needs Electron, do NOT attempt here)
- **Real trusted input** (`event.isTrusted`) — WebExtensions cannot synthesize it.
  Sites that check `isTrusted` stay out of reach. This is what SafeCoBrowser is *for*.
- **Computer-use trusted coordinate clicking** — screenshots + `locate` are fine;
  the trusted click at `(x,y)` inherits the same blocker.
- **Full profile/container isolation** — against the "real browser" premise.

---

## 2. Permission ladder (mapped to ridealong's real tools)

| Mode | Tools unlocked | Approval |
|------|----------------|----------|
| **Off** (default, every tab) | — (WS stays connected; every tool denied) | — |
| **Read** | `read_page`, `find`, `wait_for`, `list_tabs`, `get_mode` | no |
| **Browse** | + `navigate`, `ebay_sold_count` | no (auto-approve on by default) |
| **Assist** | + `click`, `fill` | **yes**, per action |
| **Developer** | + `run_js` *(new)* | **yes**, script shown in the card |

Notes:
- `ebay_sold_count` and `navigate` cause navigation (a mild side effect), so they sit in
  **Browse**, above pure Read but below the "acting" tools.
- **`navigate` auto-approve is a conscious trade-off, not a freebie.** A granted tab can be
  sent to a GET-triggered state change (logout, unsubscribe, magic-link, some "delete"
  endpoints). Browse keeps `navigate` promptless for scraper ergonomics, but it must be
  **prominently audited**; consider restricting promptless `navigate` to the tab's *current
  origin* and prompting on cross-origin.
- **`ebay_sold_count` is not enforceable at the extension.** The bridge decomposes it into
  `navigate`/`wait_for`/`find` (`bridge.js:219-234`), so the extension only ever sees those
  primitives — the ladder gates it *via its `navigate`*, and the audit logs `navigate`, not
  the composite name. The chokepoint claim holds for *page access* (nothing touches a page
  except through `dispatch`), but the bridge **transforms** args (term → URL), so it is not
  a faithful pass-through.
- `get_mode` is off-the-ladder (read-only; an agent may see the mode but never *change* it).
- **`list_tabs` is NOT off-the-ladder.** At mode Off it would otherwise leak every tab's
  `url`+`title` (`background.js:85-90`) to a token-holder with zero grants. It is **Read-tier
  — gated on the *foreground* tab's mode** (foreground at Off ⇒ no enumeration, even with
  `agentTabControl` ON) — and **scope-limited** by `agentTabControl` (foreground tab only when
  OFF; all tabs when ON), returning **reduced fields** (id + title only; URLs only for tabs at
  ≥ Read) — see §4.

---

## 3. Broker placement & flow

**The broker lives in `extension/background.js` `dispatch()` — this is non-negotiable.**
In *driver-script mode* a standalone `.mjs` **is** the WebSocket server and talks straight
to the extension, bypassing `bridge.js`. So `background.js` is the only chokepoint both
MCP mode and driver mode pass through. `bridge.js` may gate too (defense-in-depth for MCP
mode), but the extension is the authoritative boundary.

Per-call flow inside `dispatch(tool, params)`:
1. **Resolve target tab** (see §4).
2. **Mode gate** — look up the target tab's mode; deny if the tool isn't unlocked at that mode.
3. **Input validation** — shape-check params (selector is a string, url is http(s), etc.).
4. **Approval** — if the tool requires it and the tab isn't set to auto-approve, open a
   **trusted extension-chrome approval window** (§5) and await the user's decision
   (timeout → **deny**, fail-closed). **Never** an in-page overlay (the page is hostile —
   see §5/§12).
5. **Epoch capture** — record the current session epoch; re-check it immediately before
   dispatching the irreversible step. See §7 for the honest TOCTOU limit (the check cannot
   straddle a single `executeScript` inject-and-act call).
6. **Execute** via `tabs.executeScript(tabId, …)` as today.
7. **Audit-emit** — append an allow/deny/error record to the hash-chained log (§6). If the
   audit write **fails**, the call **fails-closed** (deny) and surfaces loudly — the chain is
   never silently desynced (mirrors JoinTab `file-sink.ts:76-86`).

**Privileged pages.** On `about:`, `view-source:`, addon, PDF-viewer and other
`moz-extension://` pages, `executeScript` throws — both the action and any injected UI fail.
That is fail-closed and fine, but the broker should return a clear "unsupported page" error
rather than a raw throw.

Every branch that isn't an explicit allow is a **deny** (unknown tool, insufficient mode,
bad input, missing/rejected approval, stale epoch, handler throw).

---

## 4. Per-tab model & tab targeting

Mode is keyed by tab, not global: `Map<tabId, { mode, autoApprove }>` in the background.

- **Every tab defaults to Off.** A background tab is invisible until explicitly granted.
- Grants are **independent** — Tab A = Assist, Tab B = Read, Tab C = Off, simultaneously.
- Grant **persists across navigation** within a tab (like JoinTab). Privacy caveat: a
  granted tab you then navigate to something private *stays granted* — **Stop AI first.**
- **Tab closed** → drop its entry (`tabs.onRemoved`). **New tab** → clear any stale entry on
  `tabs.onCreated`, default Off. (No `openedAt` composite key — Firefox exposes no tab
  creation-time property, and the risk is largely theoretical: the grant `Map` is in-memory,
  wiped on reload, and Firefox tab ids are session-monotonic, so the `onRemoved`+`onCreated`
  clear is sufficient.)

### Targeting rule (resolves decision D1)
- **Read-only tools** (`read_page`, `find`, `wait_for`): may fall back to the **active tab**
  when `tabId` is omitted (convenience; still gated by that tab's mode). **Caveat (audit):**
  the active-tab fallback still races a user tab/window switch between decision and dispatch,
  so a read can land on an unintended-but-granted tab. Acceptable *only* with `agentTabControl`
  ON (single-foreground-tab); with it OFF, prefer explicit `tabId` for reads too.
- **Effectful tools** (`click`, `fill`, `run_js`) and `navigate`: **require an explicit
  `tabId`**. No silent fall-back to the active tab — an unknown/missing id is rejected
  outright (mirrors JoinTab; prevents "you switched tabs and the agent followed you").
- The agent gets ids from `list_tabs` (itself gated — see below).
- **Multi-window note:** `activeTabId` uses `{active:true, currentWindow:true}`
  (`background.js:73`); from the background "currentWindow" is the last-focused window, which
  is ambiguous with several windows open — another reason effectful tools must be explicit.

### Global "multi-tab" toggle (resolves decision D2 — ship it, default OFF for enumeration)
A Settings switch, `agentTabControl`:
- **OFF (conservative default):** the agent is confined to the **foreground** tab.
  `list_tabs` returns only the active tab, and any call with a `tabId` other than the
  foreground is rejected — background tabs are wholly invisible even if granted.
- **ON (user opts into multi-tab):** `list_tabs` enumerates all tabs but with **reduced
  fields** — `id` + `title` always, `url` **only** for tabs at ≥ Read grant. Background-tab
  targeting works; unknown/mistyped ids are rejected **without** revealing whether the id
  exists (no oracle), mirroring JoinTab `tab-target.ts:47-54`.

Either way this closes the "zero-grant token-holder enumerates every tab's URL" leak in the
current `list_tabs` (`background.js:85-90`, which returns all URLs unconditionally).

---

## 5. Approval UX — **trusted extension chrome, never an in-page overlay** (resolves D0)

**The approval prompt must NOT be a content-script overlay in the page.** The page is
hostile: page JS could dispatch a synthetic click on "Approve" (unless every handler
strictly rejects `event.isTrusted === false` — the exact primitive we otherwise say is out
of reach), or cover/remove the overlay to clickjack a real user click, or read the masked
value / `run_js` source out of the light DOM. An in-page card lets the page **auto-approve
the agent's own effectful calls.** It also *cannot* prompt for a **background-tab** action —
an overlay in a tab you're not viewing is invisible.

**Use trusted, non-page-scriptable extension chrome instead:**
- **`browser.windows.create({ type: "popup", url: "approval.html" })`** — a real extension
  page in its own small window. No user gesture needed, not reachable by page script, and it
  works for background-tab actions (the card just names the tab). This is the recommended
  surface. (`browserAction.openPopup()` is *not* usable — it needs a gesture — which is the
  constraint the first draft wrongly generalized into "use an overlay.")
- Alternative/fallback: `browser.notifications` with action buttons (lighter, less room to
  show a `run_js` body).

The approval page (trusted context):
- shows the **concrete effect** — `click #buy-now`, `fill #card = 4242…` (redacted), or the
  **exact `run_js` source**; for a background-tab action it is labelled `Tab: <title>`.
- **Approve / Deny** resolve the pending call. **Timeout → Deny** (default 120s, fail-closed).
- **Auto-approve** is a *per-tab*, *user-set* toggle (a deliberate "don't ask"); when on,
  `click`/`fill` skip the prompt but are **still audited**. `run_js` **always** prompts.
  **It resets to `false` on Stop AI and on any mode downgrade** — otherwise re-granting Assist
  later would silently resurrect a prior "don't ask" without fresh consent.
- **Window dismissal = Deny.** Closing the approval popup via the OS window chrome (not the
  Deny button) must resolve the pending call as **Deny** (`windows.onRemoved` → deny), so a
  dismissed prompt never leaves a dangling pending call.

**Decision-channel security (required — from 2nd audit).** The approval page returns its
Approve/Deny over `runtime.sendMessage`, and `redact.js` is *also* extension code that could
send such a message from inside a page. So the background's decision handler **must verify the
sender**: `!sender.tab` (not from any content script) **and** `sender.url` ends with
`approval.html`. Web pages themselves can't reach `moz-extension://` pages or send `runtime`
messages (no `externally_connectable` in the manifest — keep it that way), so this is
defense-in-depth against a content-script relay, not the primary boundary. **`approval.html`
must learn the concrete effect *from the background*** (e.g. `?callId=…` then pull details) —
never reconstruct it from page content. **Serialize approvals into a single reused window/queue**
so pipelined effectful calls don't spawn a stack of popups the user mis-approves.

---

## 6. Audit log

Same hash-chained JSONL idea as JoinTab's `src/audit/`. The audit found the first draft had
the sink backwards — `storage.local` is the *weakest* link, not the authoritative one:
- no append primitive (each write is a whole-array read-modify-write — O(n) and race-prone
  under concurrent `dispatch` calls),
- a ~5 MB quota an append-only chain eventually blows (then writes fail — must fail-closed),
- and it is **not reliably durable for a *temporary* add-on** across a Firefox restart
  (AGENT_GUIDE §2), so "survives restart" was an overclaim.

**Revised sink hierarchy:**
- **Authoritative: the bridge file sink** (when present, i.e. MCP mode) — the extension
  streams each record to `bridge.js`, which appends to `~/.firefox-mcp/audit-log.jsonl`,
  `0600`, on disk, surviving restart. Reuse JoinTab's `file-sink.ts` design **including its
  write-failure surfacing and fail-closed policy** (`file-sink.ts:76-86`).
- **Fallback: the extension** (driver mode has no bridge) — **IndexedDB** (not
  `storage.local`), with `unlimitedStorage` and a defined **quota + rotation**. Honestly a
  *weaker* sink; driver-mode durability is a genuine gap — a driver that wants a durable log
  should persist the streamed records itself.
- Record shape: `{ seq, ts, tabId, tool, params(redacted), decision, reason, prevHash, hash }`.
- **Honest guarantee:** detects accidental corruption and naive edits/reordering. Does **not**
  resist a determined *same-user* local attacker (who can rewrite either the file *or*
  IndexedDB) and does not detect tail truncation without an external anchor. It *does* keep
  the hostile page and a rogue driver out of the log (neither can reach bridge disk or
  extension storage).

---

## 7. Kill switch & session epoch

- A monotonic `epoch` integer in the background, **bumped on EVERY mode change — a per-tab
  downgrade (e.g. one tab Assist→Off) as well as Stop AI — not only Stop AI** (matches JoinTab
  `session.ts:35-40`, which always bumps even on a no-op). Bumping only on Stop AI would let a
  targeted "kill one tab" downgrade miss an already-in-flight effectful call on that tab — a
  second mid-flight TOCTOU on the exact path the per-tab model sells.
- **Stop AI** (popup button): set every tab to Off, bump `epoch`, reject all pending approval
  prompts, **and reset every tab's `autoApprove` to false** (see below).
- Effectful tools capture `epoch` at step 5 and re-check it immediately **before dispatching**
  the `executeScript` call → instant revoke for anything not already dispatched.
- **Honest limit (TOCTOU).** `tabs.executeScript(tabId, {code})` injects **and** performs the
  click/fill in one opaque async call — the background cannot re-check the epoch *between*
  "injected" and "acted." So a Stop-AI that fires after the call is dispatched still lets that
  one action land. This is **strictly weaker than JoinTab**, whose handler holds an
  `AbortSignal` and checks `isLive()` *inside* the handler right before the irreversible step
  (`broker.ts:140-156`, `tool.ts:30-36`). **Do not claim epoch parity.** To approach it, split
  into an inject-primed-listener call then a second gated "commit" call, or pass the epoch into
  the injected code so it self-aborts. Treat this as a follow-up, not a v1 blocker.
- **Revoking an agent (revised after 2nd audit — the first pass here was wrong).** Stop AI only
  flips modes; the agent stays *connected* and re-drives the instant any tab is re-granted.
  Distinguish the two adversaries:
  - **Against a *rogue* driver** (it *is* the WS server and won't honour the token), the levers
    are **(a) Disconnect agent** — must call `disconnect()` which sets `desired=false`
    (`background.js:63-68`); a plain `ws.close()` is useless because `scheduleReconnect()`
    re-attaches to whatever holds 8765 within 3s (`background.js:54,58-61`) — and **(b) Stop AI**
    (all tabs → Off) as the actual containment. **Token rotation does NOT help here** — a rogue
    server accepts any token. (The earlier "only real lever = regenerate token" claim was false
    and contradicted the threat model; removed.)
  - **Against an *honest/stale* bridge**, **Regenerate token** works, but must rotate **both**
    stores — `~/.firefox-mcp/token.txt` *and* the extension's `storage.local` copy
    (`background.js:23-24`), which are separate and can desync — and the bridge must restart to
    re-read the file. Rotating only the file leaves the extension sending the old token.

---

## 8. UI changes (`popup.html` / `popup.js`)

- **Per-tab mode control** for the active tab (dropdown: Off/Read/Browse/Assist/Developer).
- **Auto-approve** checkbox (per active tab).
- **Stop AI** button (big, always visible).
- Optional: a small **tab list** with each tab's current mode, so a background tab can be
  granted without switching to it.
- **Disconnect agent** + **Regenerate token** controls (§7).
- **Settings:** the `agentTabControl` toggle (§4), approval timeout, audit-sink location.

Mode changes only ever originate from popup → background messages. **No WS/MCP/driver path
can set a mode** (the `get_mode` tool is read-only).

---

## 9. Files touched

| File | Change |
|------|--------|
| `extension/background.js` | The broker: per-tab mode map, gate in `dispatch()`, epoch, approval orchestration, audit-emit, `get_mode`, `run_js`, targeting rules, disconnect/rotate |
| `extension/approval.html` / `approval.js` *(new)* | **Trusted-chrome** approval page opened via `windows.create` (§5) — shows effect, Approve/Deny |
| `extension/redact.js` *(new)* | Best-effort secret redaction before `read_page` returns (not a boundary — §6). **Injected on-demand via `executeScript` only when `read_page` runs on a granted tab — NOT a declared `<all_urls>` always-on content script — and carries no page-message relay** (2nd audit) |
| `extension/popup.html` / `popup.js` | Mode dropdown, auto-approve, Stop AI, tab list, disconnect-agent, regenerate-token, settings |
| `extension/manifest.json` | Add `notifications`? ; ensure `storage`, `tabs`, and (for the fallback sink) `unlimitedStorage`. `windows.create` needs no extra permission |
| `bridge/bridge.js` | **Authoritative** audit file sink for MCP mode (`file-sink.ts` design); mode-gate defense-in-depth; token-rotate support; expose `get_mode`/`run_js` in `TOOLS` |
| `AGENT_GUIDE.md` / `README.md` | Document the ladder, targeting rules, explicit-`tabId` for effectful tools, and the honest threat model |

Reuse note: JoinTab's `src/core/` (`Broker`, `SessionManager`, `Tool` contract) is
Electron-free TypeScript and could be adapted, but the extension is currently plain JS with
no build step. **Recommendation: write a lean inline JS broker** to keep it buildless
(decision D3), mirroring the core's *contract* rather than importing its code.

---

## 10. Open decisions

| # | Decision | Recommendation |
|---|----------|----------------|
| **D0** *(new — the load-bearing one)* | Where does approval UI live? | **Trusted extension chrome** (`windows.create` popup), never an in-page overlay (§5). Everything at Assist/Developer depends on this. |
| **D1** | `navigate` tier; explicit `tabId` vs active-tab fallback | **Browse tier**; explicit `tabId` for effectful tools + `navigate`. Active-tab fallback for **reads only, and only with `agentTabControl` ON** (it races a tab switch otherwise) |
| **D2** | Ship the `agentTabControl` toggle + gate `list_tabs`? | **Yes.** It gates enumeration and background targeting; `list_tabs` returns reduced fields to close the URL-leak (§4) |
| **D3** | Reuse JoinTab `src/core/` vs lean inline JS broker | **Lean inline JS** — keep buildless; mirror the *contract*. Note the `AbortSignal`/`isLive()` handler guarantee is **not** replicable under `executeScript` (§7) — don't claim parity |
| **D4** | Add `run_js` at Developer tier? | **Yes — but only after D0 is fixed.** Arbitrary page JS behind a *forgeable* overlay = page self-approves its own `run_js`. Safe once approval is trusted chrome |
| **D5** | Where is the audit authoritative? | **The bridge file sink** when present; extension **IndexedDB** is the driver-mode fallback (weaker; durability gap acknowledged). Reversed from the first draft (§6) |

---

## 11. Rough sequencing (when this becomes a build)

1. Per-tab mode map + gate in `dispatch()` + `get_mode` + popup dropdown/Stop AI. *(core)*
2. Session epoch + kill switch + **disconnect-agent + regenerate-token**.
3. **Trusted-chrome approval** (`approval.html` via `windows.create`) + auto-approve toggle.
   *(D0 — before any effectful tier ships)*
4. `agentTabControl` toggle + gated `list_tabs` (reduced fields) — close the enumeration leak.
5. Hash-chained audit: **bridge file sink** (authoritative) + extension IndexedDB fallback,
   with fail-closed-on-write-failure.
6. Best-effort redaction before the WS send (`read_page`/approval-card values).
7. `run_js` at Developer tier — **only after step 3 lands.**
8. Follow-up (not v1): split inject/commit to narrow the epoch TOCTOU (§7).
9. Docs (`AGENT_GUIDE.md`, `README.md`) — ladder, targeting, honest threat model.

---

## 12. Audit trail (Opus adversarial review)

This plan was revised after a skeptical Opus audit. Verdict: *sound-with-fixes*, one
load-bearing flaw. Changes folded in:

- **Approval moved to trusted extension chrome** (was: in-page overlay — forgeable /
  clickjackable by the hostile page; also couldn't prompt for background-tab actions). → §5, D0.
- **`list_tabs` gated + reduced fields** (was: off-ladder, leaking every tab's URL to a
  zero-grant token-holder). → §2, §4, D2.
- **Audit sink reversed** — bridge file authoritative, extension IndexedDB fallback (was:
  `storage.local` authoritative — no append primitive, quota, not durable for a temp add-on).
  → §6, D5.
- **Honesty corrections:** "in-page masking" → best-effort redaction before the WS (no trust
  boundary; `innerText` doesn't even contain `input.value`); token is **not** a local boundary
  (extension broadcasts it to whoever binds 8765) — real containment is the mode gate; epoch
  re-check **can't** straddle `executeScript`, so **no parity claim** with JoinTab's
  `AbortSignal`. → §1, §6, §7, threat-model note.
- **Added:** token rotation + disconnect-agent (Stop AI alone leaves the agent connected to
  re-drive on re-grant); privileged-page fail-closed; tabId-reuse guard; multi-window caveat;
  audit-write-failure = fail-closed. → §7, §3, §4.
- **Kept (sound):** fail-closed default-Off per-tab model; kill switch (with honest caveat);
  explicit-`tabId` for effectful tools; "mode never settable over the wire" invariant. The
  core thesis holds — the governance layer genuinely confines a rogue driver to granted tabs.

### Second pass (re-audit of the revision)
Verdict: *sound-with-fixes, materially improved.* All four headline fixes landed; the revision
itself introduced one wrong claim (now corrected) plus refinements:

- **§7 token story corrected** — the "regenerate token = only lever against a rogue driver"
  line was **false** (a rogue driver won't honour the token) and contradicted the threat model.
  Rewritten: Disconnect (`desired=false`) + Stop-AI is the containment; token rotation only
  revokes an *honest/stale* bridge and must rotate **both** token stores + restart the bridge.
- **Approval decision channel** — background must verify `sender` is `approval.html`
  (`!sender.tab` + url match); `approval.html` learns the effect *from the background*, never
  from the page; approvals serialized into one window. → §5.
- **`redact.js`** — injected **on-demand** on granted tabs, not an always-on `<all_urls>`
  content script; no page-message relay. → §9.
- **`navigate` auto-approve** flagged as a conscious, audited trade-off (GET side effects);
  consider same-origin-only promptless. → §2.
- **tabId keying** simplified to `onRemoved`+`onCreated` clear (no `openedAt` — Firefox has no
  tab creation-time property; risk is theoretical). → §4.
- **No deadlock** from gating `list_tabs`: with `agentTabControl` OFF it still returns the
  active tab, so the agent can always learn the one id it may act on.

Confirmed accurate now: redaction-not-masking, epoch no-parity, sink durability, "token not a
local boundary." No fatal flaw remains.

### Third pass (confirmation)
Verdict: **v3 clean — lock-and-build ready for D0–D5.** Every 2nd-pass fix landed correctly and
the §7 rewrite introduced **no** new false claim (verified line-by-line against `background.js`).
Two pre-existing under-specs folded in (spec-level, no decision reopened):

- **Epoch bumps on EVERY mode change**, not just Stop AI — else a per-tab downgrade misses an
  in-flight call on that tab (`session.ts:35-40`). → §7.
- **`autoApprove` resets** on Stop AI / downgrade — else re-granting silently resurrects a prior
  "don't ask." → §5.
- Minor: `list_tabs` gates on the **foreground** tab's mode (stated); approval-**window close =
  Deny** (`windows.onRemoved`). → §2, §5.

Nothing new broken. Decisions D0–D5 are internally consistent and correctly reasoned; the plan
is ready to build.
