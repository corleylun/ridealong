#!/usr/bin/env node
/**
 * ridealong bridge — an MCP server (stdio) that drives a REAL Firefox through a
 * WebExtension connected over a localhost WebSocket.
 *
 *   AI agent ──MCP/stdio──▶ this bridge ──ws://127.0.0.1──▶ Firefox extension ──▶ page
 *
 * Why: a browser extension can't listen on a port (so it can't BE an MCP server),
 * but it CAN dial out over a WebSocket. This bridge is the missing middle: it
 * speaks MCP to the agent and relays each tool call to the extension, which does
 * the work in the real browser (no CDP, real fingerprint/session).
 *
 * Security: binds 127.0.0.1 only; the extension must present a shared token before
 * any command is accepted. One extension client at a time (the newest wins).
 *
 * stdout is reserved for the MCP protocol — ALL logging goes to stderr.
 */

import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const log = (...a) => console.error("[ridealong]", ...a);

// ── Token + port ────────────────────────────────────────────────────────
const PORT = Number(process.env.FXMCP_PORT || 8765);
const CFG_DIR = join(homedir(), ".firefox-mcp");
const TOKEN_FILE = join(CFG_DIR, "token.txt");

function resolveToken() {
  if (process.env.FXMCP_TOKEN) return process.env.FXMCP_TOKEN.trim();
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {}
  const t = randomBytes(24).toString("hex");
  try {
    mkdirSync(CFG_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  } catch (e) {
    log("could not persist token file:", e.message);
  }
  return t;
}
const TOKEN = resolveToken();
// NOTE on token rotation (PLAN.md §7): the extension's "Regenerate token" button
// only rotates ITS OWN storage.local copy — it cannot reach this file. To rotate
// the bridge side (revoking an honest/stale extension), delete TOKEN_FILE (or set
// FXMCP_TOKEN) and RESTART this process so it mints/reads a fresh token, then
// paste the newly printed value into the extension popup.

// ── Audit log — authoritative sink (PLAN.md §6) ────────────────────────────
// The extension computes the hash chain (seq/prevHash/hash) and streams each
// sealed record here over the WS connection; this process's only job is durable,
// append-only persistence to disk (0600), surviving a Firefox/extension restart.
// A write failure is surfaced loudly and acked back false so the extension can
// fail closed rather than silently desync its chain (mirrors JoinTab
// file-sink.ts:76-86).
const AUDIT_FILE = join(CFG_DIR, "audit-log.jsonl");
function appendAudit(record) {
  try {
    mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(AUDIT_FILE, JSON.stringify(record) + "\n", { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    log("AUDIT WRITE FAILED — decision not persisted:", e.message);
    return { ok: false, error: e.message };
  }
}

// Last sealed record in the authoritative file (PLAN.md §6). Sent to the
// extension on connect so it can RESUME its in-memory hash chain instead of
// restarting at seq=1/GENESIS after a background-script restart — otherwise the
// file gains a spurious GENESIS discontinuity mid-stream and stops verifying.
function readAuditTail() {
  try {
    if (!existsSync(AUDIT_FILE)) return null;
    const lines = readFileSync(AUDIT_FILE, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const rec = JSON.parse(line);
      if (typeof rec.seq === "number" && typeof rec.hash === "string") {
        return { seq: rec.seq, hash: rec.hash };
      }
      return null; // newest line is malformed — don't scan further, resume disabled
    }
  } catch (e) {
    log("could not read audit tail (chain resume disabled this connect):", e.message);
  }
  return null;
}

// ── WebSocket server: the extension connects here ────────────────────────
let ext = null; // the authenticated extension socket, or null
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("listening", () => {
  log(`WebSocket listening on ws://127.0.0.1:${PORT}`);
  log(`token: ${TOKEN}`);
  log(`(also saved to ${TOKEN_FILE}) — paste it into the extension popup.`);
});
wss.on("error", (e) => log("ws server error:", e.message));

wss.on("connection", (ws, req) => {
  // Same-origin-ish guard: only accept moz-extension:// origins (or none).
  const origin = req.headers.origin || "";
  if (origin && !origin.startsWith("moz-extension://")) {
    log("rejecting non-extension origin:", origin);
    ws.close();
    return;
  }
  let authed = false;
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!authed) {
      if (msg.type === "hello" && msg.token === TOKEN) {
        authed = true;
        // Newest client wins: actively evict the previous socket so a stale (or
        // rogue) prior extension can't keep streaming audit records / resolving
        // pending command ids into our shared maps after being superseded.
        if (ext && ext !== ws) { try { ext.close(); } catch {} }
        ext = ws;
        log("extension connected + authenticated");
        // Include the authoritative chain tail so the extension resumes rather
        // than restarts its hash chain (see readAuditTail).
        ws.send(JSON.stringify({ type: "welcome", audit: readAuditTail() }));
      } else {
        log("auth failed — closing socket");
        ws.close();
      }
      return;
    }
    // Authenticated: an audit record streamed from the extension's broker (its
    // hash chain — we just persist it durably). Ack so the extension knows
    // whether to fail closed or fall back to its own IndexedDB sink.
    if (msg.type === "audit" && msg.auditId != null) {
      const result = appendAudit(msg.record);
      try {
        ws.send(JSON.stringify({ type: "audit_ack", auditId: msg.auditId, ...result }));
      } catch {}
      return;
    }

    // Authenticated: this is a reply to a command.
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.output);
      else p.reject(new Error(msg.error || "extension error"));
    }
  });
  ws.on("close", () => {
    if (ext === ws) { ext = null; log("extension disconnected"); }
  });
});

function callExtension(tool, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ext || ext.readyState !== ext.OPEN) {
      reject(new Error("Firefox extension not connected. Open Firefox, load the "
        + "extension, and click Connect in its popup."));
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("extension call timed out")); }
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ id, tool, params }));
  });
}

// Per-tool bridge-side timeouts. navigate MUST exceed the extension's own
// internal load wait (waitForComplete = 40s in background.js) — otherwise a page
// that loads in 31–40s makes the bridge reject with "timed out" while the
// extension is still working and its eventual reply is dropped.
//
// The approval-gated tools (run_js/click/fill) block on a HUMAN, who has up to
// the extension's approvalTimeoutMs (default 120s) to read the prompt and click.
// The bridge must wait longer than that whole window or it rejects with "timed
// out" while the popup is still open — dropping the reply even after the human
// approves. 130s = 120s approval budget + execution margin. Everything else uses
// callExtension's 30s default.
const TOOL_TIMEOUTS = { navigate: 45000, run_js: 130000, click: 130000, fill: 130000 };

// ── MCP tool definitions (raw JSON Schema — no extra deps) ────────────────
const TOOLS = [
  {
    name: "list_tabs",
    description: "List Firefox tabs (id, title, active; url only for tabs granted Read+). Gated on the FOREGROUND tab's mode (Off there => denied) and scope-limited by the extension's agentTabControl setting: only the foreground tab when off, all tabs when on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate",
    description: "Navigate a tab to a URL. Waits for load, returns final url + title. The extension requires an explicit tabId for this tool (no active-tab fallback) — use list_tabs to find one.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        tabId: { type: "number", description: "target tab id (required by the extension's broker)" },
      },
      required: ["url", "tabId"], additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description: "Read the active (or given) tab: url, title, visible text (truncated), and links.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } }, additionalProperties: false,
    },
  },
  {
    name: "find",
    description: "Query the page by CSS selector; returns matched element text and an optional attribute.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        all: { type: "boolean", description: "return all matches (default false = first only)" },
        attr: { type: "string", description: "also return this attribute's value" },
        tabId: { type: "number" },
      },
      required: ["selector"], additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click the first element matching a CSS selector (synthesized click). Requires Assist+ tier and an explicit tabId; the user is prompted per action unless auto-approve is on for that tab.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tabId: { type: "number", description: "required" } },
      required: ["selector", "tabId"], additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Set the value of an input/textarea matching a selector and fire input/change events. Requires Assist+ tier and an explicit tabId; the user is prompted per action unless auto-approve is on for that tab.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" }, tabId: { type: "number", description: "required" } },
      required: ["selector", "value", "tabId"], additionalProperties: false,
    },
  },
  {
    name: "wait_for",
    description: "Wait until a CSS selector appears in the page (or timeout).",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        timeoutMs: { type: "number", description: "default 10000" },
        tabId: { type: "number" },
      },
      required: ["selector"], additionalProperties: false,
    },
  },
  {
    name: "get_mode",
    description: "Read-only: get the extension's current permission mode for a tab (default: active/foreground tab). Mode is off-the-ladder and can ONLY be changed by the human via the extension popup — never over MCP/WS, by design.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "target tab id (optional; default active tab)" } },
      additionalProperties: false,
    },
  },
  {
    name: "run_js",
    description: "Run arbitrary JS in a tab. Gated behind the extension's Developer tier and ALWAYS prompts the user with the exact source in a trusted approval window before running, regardless of any auto-approve setting. Requires an explicit tabId (no active-tab fallback).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "target tab id (required)" },
        code: { type: "string", description: "JS to run, wrapped in an IIFE; `return` works as expected" },
      },
      required: ["tabId", "code"], additionalProperties: false,
    },
  },
  {
    name: "ebay_sold_count",
    description: "Convenience: navigate the active tab to the eBay SOLD-items search for a term and return the reported result count (approx sold in the last ~90 days).",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        domain: { type: "string", description: "eBay domain, default www.ebay.co.uk" },
      },
      required: ["term"], additionalProperties: false,
    },
  },
];

// ── MCP server ────────────────────────────────────────────────────────────
const server = new Server(
  { name: "ridealong", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    // ebay_sold_count is composed here from primitive extension ops. PLAN.md §2:
    // this is "not enforceable at the extension" as a single unit — the extension
    // only ever sees the decomposed navigate/wait_for/find calls, and the ladder
    // gates it via those (navigate needs Browse+; the audit log records
    // "navigate", not "ebay_sold_count"). Since navigate now REQUIRES an explicit
    // tabId (no active-tab fallback, PLAN.md §4), we resolve the foreground tab id
    // via list_tabs first and thread it through every sub-call — this also means
    // the foreground tab must be granted Read+ (for list_tabs) and Browse+ (for
    // navigate) before this composite tool works.
    if (name === "ebay_sold_count") {
      const domain = (args.domain || "www.ebay.co.uk").replace(/^https?:\/\//, "");
      const url = `https://${domain}/sch/i.html?_nkw=${encodeURIComponent(args.term)}&LH_Sold=1&LH_Complete=1`;
      const tabsRes = await callExtension("list_tabs", {});
      const activeTab = (tabsRes.tabs || []).find((t) => t.active) || (tabsRes.tabs || [])[0];
      if (!activeTab) {
        throw new Error("no active tab visible to list_tabs — grant the foreground tab Read+ mode in the extension popup first");
      }
      const tabId = activeTab.id;
      await callExtension("navigate", { url, tabId }, 45000);
      await callExtension("wait_for", { selector: ".srp-controls__count-heading, .result-count__count-heading, h1", timeoutMs: 12000, tabId }, 15000)
        .catch(() => {});
      const hit = await callExtension("find", {
        selector: ".srp-controls__count-heading, .result-count__count-heading",
        tabId,
      });
      const text = (hit && hit.text) || "";
      const m = text.replace(/,/g, "").match(/([\d]+)/);
      const count = m ? Number(m[1]) : null;
      return {
        content: [{ type: "text", text: JSON.stringify({ term: args.term, count, raw: text, url }) }],
      };
    }
    const output = await callExtension(name, args, TOOL_TIMEOUTS[name]);
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio.");
