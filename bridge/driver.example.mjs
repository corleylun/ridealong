/* driver.example.mjs — minimal Driver-mode example.
 *
 * Driver mode: this script IS the WebSocket server the extension connects to
 * (no MCP registration needed). It authenticates with the shared token, then
 * sends {id, tool, params} commands and awaits {id, ok, output} replies — the
 * same protocol bridge.js speaks. Copy this as the starting point for your own
 * driver scripts.
 *
 * Run it from bridge/ (so the `ws` dependency resolves), with Firefox open and
 * the Ridealong extension connected:
 *     cd bridge && node driver.example.mjs
 *
 * Governance note: every tab starts "Off". For this example to get past the
 * per-tab gate, grant the FOREGROUND tab at least "Browse" in the extension
 * popup first (navigate needs Browse; read_page needs Read). navigate/click/fill
 * require an EXPLICIT tabId — there is no active-tab fallback — so we resolve the
 * foreground tab id via list_tabs and thread it through.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.FXMCP_PORT || 8765);
const TOKEN = readFileSync(join(homedir(), ".firefox-mcp", "token.txt"), "utf8").trim();
const URL = process.argv[2] || "https://example.com";

const log = (...a) => console.error("[driver.example]", ...a); // stderr; DATA -> stdout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ext = null, seq = 0;
const pending = new Map();

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("error", (e) => { log("ws error (port busy?):", e.message); process.exit(1); });
wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "";
  if (origin && !origin.startsWith("moz-extension://")) { ws.close(); return; }
  let authed = false;
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!authed) {
      if (m.type === "hello" && m.token === TOKEN) {
        authed = true; ext = ws; ws.send(JSON.stringify({ type: "welcome" })); run();
      } else ws.close();
      return;
    }
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.ok ? p.resolve(m.output) : p.reject(new Error(m.error || "extension error"));
    }
  });
  ws.on("close", () => { if (ext === ws) ext = null; });
});

function call(tool, params, ms = 45000) {
  return new Promise((resolve, reject) => {
    if (!ext) return reject(new Error("extension not connected"));
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, ms);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    ext.send(JSON.stringify({ id, tool, params }));
  });
}

setTimeout(() => { log("overall timeout"); process.exit(1); }, 120000); // never hang forever

let ran = false;
async function run() {
  if (ran) return; ran = true; // guard: the extension can reconnect mid-run and re-fire
  try {
    // Resolve the foreground tab id — navigate requires an explicit tabId.
    const { tabs = [] } = await call("list_tabs", {});
    const active = tabs.find((t) => t.active) || tabs[0];
    if (!active) throw new Error("no visible tab — grant the foreground tab Read+ in the popup");

    await call("navigate", { url: URL, tabId: active.id });
    await sleep(2000);
    const page = await call("read_page", { tabId: active.id });

    console.log("RESULTS_JSON:" + JSON.stringify({ url: page.url, title: page.title }));
    process.exit(0);
  } catch (e) {
    log("failed:", e.message);
    process.exit(1);
  }
}

log(`waiting for extension… (will open ${URL} in the foreground tab)`);
