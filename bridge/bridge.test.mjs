// bridge.test.mjs — tests for the NEW agent-facing MCP-over-HTTP server added to
// bridge.js (auth, endpoint discovery file, tool listing). Deliberately does NOT
// require a real Firefox extension: tools/list never touches callExtension(), and
// the auth/endpoint-file checks don't call any tool at all, so the whole suite
// runs standalone.
//
// Strategy: bridge.js has top-level side effects (binds the WS server, mints
// tokens, starts the HTTP server) — it isn't structured as an importable module.
// So instead of importing it, we spawn a real `node bridge.js` child process per
// the task's own smoke-test recipe, pointed at a scratch config dir (FXMCP_CFG_DIR)
// and a private WS port (FXMCP_PORT), and drive it over real HTTP.
//
// Run: node --test bridge/bridge.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const BRIDGE_JS = join(import.meta.dirname, "bridge.js");
const TOOL_NAMES = [
  "click", "ebay_sold_count", "fill", "find", "get_mode",
  "list_tabs", "navigate", "read_page", "run_js", "wait_for",
].sort();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Raw HTTP request with full control over headers (esp. Host) — fetch() doesn't
 *  let us override Host, and that's exactly the guard we need to exercise. */
function rawRequest({ port, path = "/mcp", method = "POST", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(data
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return false;
}

let cfgDir;
let child;
let stderrBuf = "";
let endpoint; // parsed ~/.firefox-mcp/endpoint.json (redirected to cfgDir)
let wsPort;
let wsToken; // the extension's WS token (token.txt), distinct from endpoint.token
let mcpHost;
let mcpPort;

/**
 * Connect a FAKE Firefox extension: a WS *client* dialing the bridge's WS *server*
 * (the bridge is the server; the real extension is always the client). Performs the
 * hello/token handshake, waits for the bridge's `welcome`, then hands each inbound
 * `{id,tool,params}` tool-call frame to `onCall(msg, ws)`. Default `onCall` echoes
 * `{id, ok:true, output:{tool, params}}` so a tool call's HTTP reply carries back
 * exactly which tool+args the bridge relayed over the WS — letting us assert
 * divergent-reply routing, not just "didn't crash".
 */
function connectFakeExtension({ onCall } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`, {
    headers: { origin: "moz-extension://fake-test-extension" },
  });
  const handle =
    onCall ||
    ((msg) => {
      if (msg.id != null && msg.tool) {
        ws.send(JSON.stringify({ id: msg.id, ok: true, output: { tool: msg.tool, params: msg.params } }));
      }
    });
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === "welcome") return; // handshake ack
    handle(msg, ws);
  });
  const ready = new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: wsToken })));
    ws.once("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { msg = null; }
      if (msg && msg.type === "welcome") resolve(ws);
      else reject(new Error("expected welcome from bridge, got: " + buf.toString().slice(0, 120)));
    });
    ws.on("error", reject);
  });
  return { ws, ready };
}

function authedHeaders(extra = {}) {
  return {
    host: `${mcpHost}:${mcpPort}`,
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${endpoint.token}`,
    ...extra,
  };
}

before(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "ridealong-bridge-test-"));
  wsPort = await freePort(); // a private WS port so this never fights a real bridge on :8765
  const endpointFile = join(cfgDir, "endpoint.json");

  child = spawn(process.execPath, [BRIDGE_JS], {
    env: {
      ...process.env,
      FXMCP_CFG_DIR: cfgDir,
      FXMCP_PORT: String(wsPort),
      // No FXMCP_TOKEN override here (deliberately): passing one short-circuits
      // resolveToken() before it ever persists token.txt (see bridge.js), and we
      // want to exercise the real mint-and-persist path for both token files.
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => { stderrBuf += c.toString(); });

  const appeared = await waitFor(() => existsSync(endpointFile));
  assert.ok(appeared, `endpoint.json never appeared within timeout; bridge stderr:\n${stderrBuf}`);

  endpoint = JSON.parse(readFileSync(endpointFile, "utf8"));
  const url = new URL(endpoint.mcpUrl);
  mcpHost = url.hostname;
  mcpPort = Number(url.port);

  // The extension WS token was minted+persisted at startup; the fake extension
  // needs it to complete the hello handshake with the bridge's WS server.
  wsToken = readFileSync(join(cfgDir, "token.txt"), "utf8").trim();
});

after(async () => {
  if (child && child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    await waitFor(() => child.exitCode !== null, { timeoutMs: 3000 });
  }
  try { rmSync(cfgDir, { recursive: true, force: true }); } catch {}
});

test("endpoint.json has the right shape, is 0600, and matches the running HTTP port", () => {
  assert.equal(typeof endpoint.mcpUrl, "string");
  assert.match(endpoint.mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(typeof endpoint.token, "string");
  assert.ok(endpoint.token.length >= 32, "HTTP bearer token should be high-entropy");
  assert.equal(typeof endpoint.pid, "number");
  assert.equal(endpoint.wsPort, wsPort);

  const st = statSync(join(cfgDir, "endpoint.json"));
  assert.equal(st.mode & 0o777, 0o600);

  // The two tokens are separate secrets/files, per the task's requirement.
  const wsToken = readFileSync(join(cfgDir, "token.txt"), "utf8").trim();
  assert.notEqual(endpoint.token, wsToken);
  assert.ok(existsSync(join(cfgDir, "mcp-token.txt")));
  assert.ok(existsSync(join(cfgDir, "token.txt")));
});

test("no bearer token -> 401", async () => {
  const res = await rawRequest({
    port: mcpPort,
    headers: { host: `${mcpHost}:${mcpPort}`, accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(res.status, 401);
});

test("bad bearer token -> 401", async () => {
  const res = await rawRequest({
    port: mcpPort,
    headers: authedHeaders({ authorization: "Bearer not-the-real-token" }),
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(res.status, 401);
});

test("non-loopback Host header -> 403 (even with a valid token)", async () => {
  const res = await rawRequest({
    port: mcpPort,
    headers: authedHeaders({ host: "evil.example.com" }),
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(res.status, 403);
});

test("non-loopback Origin header -> 403 (even with a valid token + Host)", async () => {
  const res = await rawRequest({
    port: mcpPort,
    headers: authedHeaders({ origin: "http://evil.example.com" }),
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(res.status, 403);
});

test("wrong path -> 404", async () => {
  const res = await rawRequest({
    port: mcpPort,
    path: "/not-mcp",
    headers: authedHeaders(),
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(res.status, 404);
});

test("valid token: MCP initialize + tools/list returns the full tool set", async () => {
  const initRes = await rawRequest({
    port: mcpPort,
    headers: authedHeaders(),
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bridge-test", version: "0.0.1" },
      },
    },
  });
  assert.equal(initRes.status, 200, `initialize failed: ${initRes.raw}`);
  assert.equal(initRes.body?.result?.serverInfo?.name, "ridealong");

  const listRes = await rawRequest({
    port: mcpPort,
    headers: authedHeaders(),
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  assert.equal(listRes.status, 200, `tools/list failed: ${listRes.raw}`);
  const names = (listRes.body?.result?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, TOOL_NAMES);
});

test("concurrent HTTP tool calls don't collide (same shared pending-id scheme)", async () => {
  // Neither call reaches a real extension (none is connected), so both are
  // expected to reject with the same "not connected" error — the point of this
  // test is that firing them concurrently doesn't crash the server or cross-wire
  // ids in the shared seq/pending map (see callExtension() in bridge.js).
  const call = (id) =>
    rawRequest({
      port: mcpPort,
      headers: authedHeaders(),
      body: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_tabs", arguments: {} } },
    });
  const [a, b] = await Promise.all([call(10), call(11)]);
  for (const res of [a, b]) {
    assert.equal(res.status, 200);
    const text = res.body?.result?.content?.[0]?.text ?? "";
    assert.match(text, /error: Firefox extension not connected/);
  }
});

test("with a connected extension, concurrent tool calls route divergent replies to the right caller", async () => {
  const { ws, ready } = connectFakeExtension(); // default echo handler
  await ready;
  try {
    // Two concurrent HTTP tools/call with DIFFERENT tools + args. The fake
    // extension echoes {tool, params} back per id; each HTTP reply must carry
    // ITS OWN tool's echo — proving the shared seq/pending map routes divergent
    // replies to the correct caller (not just "doesn't crash").
    const navArgs = { url: "https://example.com/A", tabId: 111 };
    const findArgs = { selector: "#unique-B", attr: "href" };
    const callTool = (id, name, args) =>
      rawRequest({
        port: mcpPort,
        headers: authedHeaders(),
        body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      });
    const [navRes, findRes] = await Promise.all([
      callTool(20, "navigate", navArgs),
      callTool(21, "find", findArgs),
    ]);

    assert.equal(navRes.status, 200);
    assert.equal(findRes.status, 200);
    const navOut = JSON.parse(navRes.body.result.content[0].text);
    const findOut = JSON.parse(findRes.body.result.content[0].text);
    // Each caller got back exactly the tool + args IT sent — no cross-wiring.
    assert.deepEqual(navOut, { tool: "navigate", params: navArgs });
    assert.deepEqual(findOut, { tool: "find", params: findArgs });
    assert.notEqual(navRes.body.id, findRes.body.id);
  } finally {
    ws.close();
    await delay(100); // let the bridge observe the close before the next test
  }
});

test("in-flight tool call rejects FAST when the extension disconnects mid-flight (FIX 1)", async () => {
  // Fake extension that NEVER replies but hard-drops its socket the moment a tool
  // call arrives — simulating the extension dying mid-request. The bridge's active-
  // socket close handler must reject the in-flight pending entry immediately rather
  // than let it wait out the 30s per-call timeout.
  const { ws, ready } = connectFakeExtension({
    onCall: (_msg, sock) => { sock.terminate(); }, // hard drop, no reply
  });
  await ready;

  const started = Date.now();
  const res = await rawRequest({
    port: mcpPort,
    headers: authedHeaders(),
    body: { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "read_page", arguments: {} } },
  });
  const elapsedMs = Date.now() - started;

  assert.equal(res.status, 200);
  const text = res.body?.result?.content?.[0]?.text ?? "";
  assert.match(text, /Firefox extension disconnected/);
  // The whole point of FIX 1: fail fast, NOT after the 30s per-call timeout.
  assert.ok(elapsedMs < 5000, `expected fast rejection but took ${elapsedMs}ms (per-call timeout is 30s)`);

  try { ws.close(); } catch {}
});

test("SIGTERM removes endpoint.json and exits the process", async () => {
  const endpointFile = join(cfgDir, "endpoint.json");
  assert.ok(existsSync(endpointFile), "precondition: endpoint.json should still exist");
  child.kill("SIGTERM");
  const gone = await waitFor(() => !existsSync(endpointFile), { timeoutMs: 3000 });
  assert.ok(gone, "endpoint.json was not removed after SIGTERM");
  const exited = await waitFor(() => child.exitCode !== null, { timeoutMs: 3000 });
  assert.ok(exited, "bridge process did not exit after SIGTERM");
});
