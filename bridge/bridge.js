#!/usr/bin/env node
/**
 * ridealong bridge — an MCP server that drives a REAL Firefox through a
 * WebExtension connected over a localhost WebSocket.
 *
 *   AI agent ──MCP/stdio or MCP/HTTP──▶ this bridge ──ws://127.0.0.1──▶ Firefox extension ──▶ page
 *
 * Why: a browser extension can't listen on a port (so it can't BE an MCP server),
 * but it CAN dial out over a WebSocket. This bridge is the missing middle: it
 * speaks MCP to the agent and relays each tool call to the extension, which does
 * the work in the real browser (no CDP, real fingerprint/session).
 *
 * Two agent-facing transports, ONE relay: this process still exposes the classic
 * stdio MCP transport (so `claude mcp add ridealong -- node bridge.js` keeps
 * working — one bridge subprocess per agent), and ALSO a long-lived MCP-over-HTTP
 * server on a dynamic 127.0.0.1 port, gated by a bearer token + Host/Origin
 * allowlist. Both transports forward every tool call through the exact same
 * `callExtension()` relay (same `seq`/`pending` map) into the exact same extension
 * WebSocket — so multiple agents (Claude, Codex, ...) can share ONE running bridge
 * over HTTP instead of each fighting over :8765 with their own stdio subprocess.
 * The extension-facing WS path (protocol, auth, audit) is completely unchanged.
 *
 * Security: binds 127.0.0.1 only; the extension must present a shared token before
 * any command is accepted. One extension client at a time (the newest wins).
 *
 * stdout is reserved for the stdio MCP protocol — ALL logging goes to stderr.
 */

import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const log = (...a) => console.error("[ridealong]", ...a);

// ── Token + port ────────────────────────────────────────────────────────
const PORT = Number(process.env.FXMCP_PORT || 8765);
// FXMCP_CFG_DIR is a test-only override (bridge.test.mjs points it at a scratch
// dir so tests never touch a real user's ~/.firefox-mcp); production always gets
// the default below.
const CFG_DIR = process.env.FXMCP_CFG_DIR || join(homedir(), ".firefox-mcp");
const TOKEN_FILE = join(CFG_DIR, "token.txt");

// Create ~/.firefox-mcp AND enforce 0700 on it even if it already existed. mkdir's
// `mode` only applies to dirs it newly creates, and resolveToken() below is the
// FIRST thing to create CFG_DIR — without this re-tighten, a pre-existing (or
// freshly mkdir'd-at-umask-0755) dir would stay world-readable, and the later
// {mode:0o700} in writeEndpointAtomic would be a silent no-op. Secrets inside are
// already 0600; this is defense-in-depth on the containing dir. Best-effort: log
// and continue on failure (e.g. a dir we don't own) rather than abort.
function ensureCfgDir() {
  mkdirSync(CFG_DIR, { recursive: true });
  try {
    chmodSync(CFG_DIR, 0o700);
  } catch (e) {
    log("could not tighten CFG_DIR permissions on", CFG_DIR + ":", e.message);
  }
}

function resolveToken() {
  if (process.env.FXMCP_TOKEN) return process.env.FXMCP_TOKEN.trim();
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {}
  const t = randomBytes(24).toString("hex");
  try {
    ensureCfgDir();
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

// ── Agent-facing HTTP bearer token — DELIBERATELY SEPARATE from TOKEN above.
// TOKEN authenticates the Firefox extension over WS; HTTP_TOKEN authenticates MCP
// agents (Claude/Codex/...) over HTTP. Different trust boundaries, different
// secrets, different files — rotating one never invalidates the other.
const HTTP_TOKEN_FILE = join(CFG_DIR, "mcp-token.txt");
function resolveHttpToken() {
  if (process.env.FXMCP_HTTP_TOKEN) return process.env.FXMCP_HTTP_TOKEN.trim();
  try {
    if (existsSync(HTTP_TOKEN_FILE)) return readFileSync(HTTP_TOKEN_FILE, "utf8").trim();
  } catch {}
  const t = randomBytes(32).toString("hex"); // 256 bits
  try {
    ensureCfgDir();
    writeFileSync(HTTP_TOKEN_FILE, t + "\n", { mode: 0o600 });
  } catch (e) {
    log("could not persist HTTP MCP token file:", e.message);
  }
  return t;
}
const HTTP_TOKEN = resolveHttpToken();

// ── HTTP auth: bearer token + Host/Origin DNS-rebinding guard ─────────────
// Lifted from the native-messaging host.js prototype's mintToken/buildAuthConfig/
// checkAuth. Loopback-only allowlist (no LAN opt-in): a DNS name that merely
// *resolves* to 127.0.0.1 is still rejected because the Host header itself must
// be one of the literal loopback forms below — the allowlist is the guard, not
// name resolution.
function headerValue(raw) {
  return Array.isArray(raw) ? raw[0] : raw;
}
function constantTimeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false; // length isn't secret; avoids the mismatched-length throw
  return timingSafeEqual(ba, bb);
}
function buildAuthConfig(token, port) {
  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  const allowedHosts = new Set(hosts.map((h) => `${h}:${port}`));
  const allowedOrigins = new Set(hosts.map((h) => `http://${h}:${port}`));
  return { token, allowedHosts, allowedOrigins };
}
// Order matters: Host is checked first so a rejected origin is turned away before
// the token (the real secret) is even inspected. Fails closed on any mismatch.
function checkAuth(headers, cfg) {
  const host = headerValue(headers["host"])?.toLowerCase();
  if (!host || !cfg.allowedHosts.has(host)) {
    return { ok: false, status: 403, reason: "host not allowed" };
  }
  const origin = headerValue(headers["origin"]);
  if (origin !== undefined && !cfg.allowedOrigins.has(origin.toLowerCase())) {
    return { ok: false, status: 403, reason: "origin not allowed" };
  }
  const authz = headerValue(headers["authorization"]) ?? "";
  const prefix = "Bearer ";
  const token = authz.startsWith(prefix) ? authz.slice(prefix.length) : "";
  if (token.length === 0 || !constantTimeEqual(token, cfg.token)) {
    return { ok: false, status: 401, reason: "invalid token" };
  }
  return { ok: true };
}

// ── Endpoint discovery file ~/.firefox-mcp/endpoint.json ──────────────────
// One bridge, one endpoint file (unlike the native-messaging host, there's no
// per-instance id here — this process is the single long-lived singleton).
// Atomic write (temp file + rename) so a concurrent reader never sees a partial
// file; 0600/0700 so only this user can read the bearer token off disk.
const ENDPOINT_FILE = join(CFG_DIR, "endpoint.json");
function writeEndpointAtomic(data) {
  ensureCfgDir();
  const tmp = join(CFG_DIR, `.endpoint.json.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, ENDPOINT_FILE); // atomic replace on the same filesystem
}
function removeEndpointFile() {
  try {
    unlinkSync(ENDPOINT_FILE);
  } catch {
    /* already gone — fine, this is best-effort cleanup on shutdown */
  }
}

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
    // Only react to the CURRENTLY-active socket dropping. A superseded socket
    // (evicted by newest-client-wins above) closing must NOT touch `ext` or the
    // shared `pending` map — those now belong to the NEW socket, and rejecting
    // here would kill the new socket's fresh in-flight calls.
    if (ext !== ws) return;
    ext = null;
    log("extension disconnected");
    // Fail fast: reject every in-flight tool call (stdio + HTTP producers share
    // this map) instead of letting each hang for its full 30s/45s per-call
    // timeout. Mirrors host.js's ExtensionRelay.rejectAll.
    rejectAllPending("Firefox extension disconnected");
  });
});

// Reject and clear every in-flight call in the shared `pending` map (e.g. on the
// active extension socket dropping). Snapshot-and-clear first so a reject handler
// that re-enters callExtension() (repopulating `pending`) can't have its new
// entry clobbered by this loop.
function rejectAllPending(reason) {
  const inflight = [...pending.values()];
  pending.clear();
  for (const p of inflight) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
}

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
// extension is still working and its eventual reply is dropped. Everything else
// uses callExtension's 30s default.
const TOOL_TIMEOUTS = { navigate: 45000 };

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

// ── Shared tool-call handler — used by BOTH the stdio MCP server below AND
// every per-request HTTP MCP server (see buildMcpServer()). One implementation,
// one relay (callExtension's shared seq/pending map), so stdio and HTTP agents
// can never diverge in behavior or collide on in-flight ids.
async function handleToolCall(name, args = {}) {
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
}

/** Build one MCP `Server` wired to the shared handleToolCall/TOOLS. Used both for
 *  the single long-lived stdio server and fresh per HTTP request (stateless mode
 *  requires "a separate Protocol instance per connection" per the SDK's own
 *  stateless-HTTP example). */
function buildMcpServer() {
  const s = new Server({ name: "ridealong", version: "0.1.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    return handleToolCall(name, args);
  });
  return s;
}

// ── MCP server (stdio) — unchanged transport for backward-compat: e.g.
// `claude mcp add ridealong -- node bridge.js` still spawns this per-agent
// subprocess and talks stdio. When run standalone (`node bridge.js` with no MCP
// client attached to stdin), connect() just attaches idle stdin listeners — see
// StdioServerTransport.start(), it never blocks waiting for a peer — so this is a
// no-op in that mode and the HTTP + WS + endpoint file below are what matter. ──
const server = buildMcpServer();

// ── MCP server (HTTP) — the new long-lived, multi-agent transport ─────────
// Stateless per the SDK's StreamableHTTPServerTransport contract: no session id,
// fresh Server + transport per request. Every request still funnels into the
// SAME callExtension()/pending map as the stdio path above — this is purely a
// second producer into one relay, not a second relay.
const MAX_BODY = 1_000_000; // 1 MB cap on the agent-facing request body
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of req) {
    if (oversized) continue; // keep draining so we can still reply cleanly
    size += chunk.length;
    if (size > MAX_BODY) {
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) throw new RequestError(413, "request body too large");
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid JSON body");
  }
}

let httpAuthConfig = null; // finalized once the HTTP server's dynamic port is known
function createHttpMcpServer() {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (!httpAuthConfig) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "http mcp server still starting" }));
          return;
        }
        const auth = checkAuth(req.headers, httpAuthConfig);
        if (!auth.ok) {
          res.writeHead(auth.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: auth.reason }));
          return;
        }
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (url.pathname !== "/mcp") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        const body = await readJsonBody(req);
        const reqServer = buildMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: one server+transport per request
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void reqServer.close();
        });
        await reqServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (e instanceof RequestError) {
          res.writeHead(e.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
        log("HTTP request handler error:", e.message);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    })();
  });
}

// ── Startup: WS server is already listening (see wss.on("listening") above) —
// bring up the HTTP MCP server on a dynamic port, publish the endpoint file, then
// connect the stdio transport (harmless no-op if nothing is attached to stdin).
let endpointWritten = false;
let shuttingDown = false;
function cleanupEndpoint() {
  if (endpointWritten) {
    removeEndpointFile();
    endpointWritten = false;
  }
}

const httpServer = createHttpMcpServer();
await new Promise((resolve, reject) => {
  httpServer.once("error", (e) => {
    log("HTTP MCP server error:", e.message);
    reject(e);
  });
  httpServer.listen(0, "127.0.0.1", resolve); // dynamic free port — never hardcoded
});
const HTTP_PORT = httpServer.address().port;
httpAuthConfig = buildAuthConfig(HTTP_TOKEN, HTTP_PORT);
const MCP_URL = `http://127.0.0.1:${HTTP_PORT}/mcp`;

writeEndpointAtomic({
  mcpUrl: MCP_URL,
  token: HTTP_TOKEN,
  pid: process.pid,
  wsPort: PORT,
});
endpointWritten = true;

log(`MCP-over-HTTP listening on ${MCP_URL} (bearer token required)`);
log(`http token: ${HTTP_TOKEN}`);
log(`(also saved to ${HTTP_TOKEN_FILE}; endpoint published to ${ENDPOINT_FILE})`);
log(`Register with Claude Code:`);
log(`  claude mcp add --transport http ridealong ${MCP_URL} --header "Authorization: Bearer ${HTTP_TOKEN}"`);
log(`Register with Codex:`);
log(`  codex mcp add --transport http ridealong ${MCP_URL} --header "Authorization: Bearer ${HTTP_TOKEN}"`);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} received — shutting down`);
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupEndpoint();
    try { httpServer.close(); } catch {}
    try { wss.close(); } catch {}
    process.exit(0);
  });
}
process.on("exit", cleanupEndpoint); // best-effort final safety net

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio (+ HTTP above) — one relay, two agent-facing transports.");
