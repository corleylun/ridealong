#!/usr/bin/env node
/**
 * firefox-mcp bridge — an MCP server (stdio) that drives a REAL Firefox through a
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

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

const log = (...a) => console.error("[firefox-mcp]", ...a);

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
        ext = ws;
        log("extension connected + authenticated");
        ws.send(JSON.stringify({ type: "welcome" }));
      } else {
        log("auth failed — closing socket");
        ws.close();
      }
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

// ── MCP tool definitions (raw JSON Schema — no extra deps) ────────────────
const TOOLS = [
  {
    name: "list_tabs",
    description: "List open Firefox tabs (id, active, url, title).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate",
    description: "Navigate a tab to a URL (default: the active tab). Waits for load, returns final url + title.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        tabId: { type: "number", description: "target tab id (optional; default active tab)" },
      },
      required: ["url"], additionalProperties: false,
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
    description: "Click the first element matching a CSS selector (synthesized click).",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tabId: { type: "number" } },
      required: ["selector"], additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Set the value of an input/textarea matching a selector and fire input/change events.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" }, tabId: { type: "number" } },
      required: ["selector", "value"], additionalProperties: false,
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
  { name: "firefox-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    // ebay_sold_count is composed here from primitive extension ops.
    if (name === "ebay_sold_count") {
      const domain = (args.domain || "www.ebay.co.uk").replace(/^https?:\/\//, "");
      const url = `https://${domain}/sch/i.html?_nkw=${encodeURIComponent(args.term)}&LH_Sold=1&LH_Complete=1`;
      await callExtension("navigate", { url }, 45000);
      await callExtension("wait_for", { selector: ".srp-controls__count-heading, .result-count__count-heading, h1", timeoutMs: 12000 }, 15000)
        .catch(() => {});
      const hit = await callExtension("find", {
        selector: ".srp-controls__count-heading, .result-count__count-heading",
      });
      const text = (hit && hit.text) || "";
      const m = text.replace(/,/g, "").match(/([\d]+)/);
      const count = m ? Number(m[1]) : null;
      return {
        content: [{ type: "text", text: JSON.stringify({ term: args.term, count, raw: text, url }) }],
      };
    }
    const output = await callExtension(name, args);
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio.");
