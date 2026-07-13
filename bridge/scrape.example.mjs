/* scrape.example.mjs — a generic, site-agnostic results-page scraper.
 *
 * Demonstrates the full driver-mode scraping method on ANY search/listing page,
 * with no site-specific logic baked in — you point it at a URL and give it a CSS
 * selector for the repeating "item" (via env), and it:
 *
 *   1. resolves the foreground tabId       (navigate needs an explicit tabId)
 *   2. navigates to the URL
 *   3. runs a SETTLE LOOP so it reads the NEW results, not a stale pre-render page
 *   4. find({all}) on the item selector, extracts text + an optional link attr
 *   5. parses a number/price out of each item's text
 *   6. emits one machine-readable RESULTS_JSON line
 *
 * It also has a --probe mode that helps you DISCOVER the selectors on a site you've
 * never scraped before (needs the tab at Developer, since it uses run_js).
 *
 * Usage (from bridge/, Firefox open + extension connected, foreground tab granted):
 *   ITEM_SEL='.result-card'            node scrape.example.mjs "https://site/search?q=x"
 *   ITEM_SEL='.card' LINK_ATTR='href'  node scrape.example.mjs "https://site/search?q=x"
 *   COUNT_SEL='.result-count'          node scrape.example.mjs "https://site/search?q=x"
 *   node scrape.example.mjs --probe    "https://site/search?q=x"   # discover selectors
 *
 * Tiers: extract mode needs the foreground tab at Browse (navigate) + it reads at
 * Read. --probe needs Developer (run_js always prompts with the source).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.FXMCP_PORT || 8765);
const TOKEN = readFileSync(join(homedir(), ".firefox-mcp", "token.txt"), "utf8").trim();

const argv = process.argv.slice(2);
const PROBE = argv.includes("--probe");
const URL = argv.find((a) => !a.startsWith("--")) || "https://example.com";

// Site config — override per site. No site-specific defaults on purpose.
const ITEM_SEL = process.env.ITEM_SEL || "";       // required in extract mode
const COUNT_SEL = process.env.COUNT_SEL || "";     // optional: a "N results" heading
const LINK_ATTR = process.env.LINK_ATTR || "href"; // attribute to pull off each item
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 40);

const log = (...a) => console.error("[scrape.example]", ...a); // stderr; DATA -> stdout
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
    const t = setTimeout(() => { pending.delete(id); reject(new Error("timeout: " + tool)); }, ms);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    ext.send(JSON.stringify({ id, tool, params }));
  });
}

setTimeout(() => { log("overall timeout"); process.exit(1); }, 120000); // never hang forever

// Pull the first number out of a string ("£71,500" -> 71500, "1,234 sold" -> 1234).
function parseNumber(text) {
  const m = String(text || "").replace(/[,\s](?=\d)/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// Read the current result "signature": the count heading (if any) + how many items
// match + a sample of their text. The settle loop below waits for this to stabilise.
async function readState(tabId) {
  let heading = "";
  if (COUNT_SEL) {
    const h = await call("find", { selector: COUNT_SEL, tabId }).catch(() => null);
    heading = (h && h.text || "").trim();
  }
  const res = await call("find", { selector: ITEM_SEL, all: true, attr: LINK_ATTR, tabId }).catch(() => null);
  const matches = (res && res.matches) || [];
  const sig = heading + "|" + matches.length + "|" + matches.slice(0, 3).map((m) => (m.text || "").slice(0, 24)).join("~");
  return { heading, matches, sig };
}

async function probe(tabId) {
  // Discover candidate selectors: list the most common class tokens on the page,
  // and a few elements whose class looks price/card/item/result-ish. run_js is the
  // most powerful way to do this (Developer tier; it will prompt with this source).
  const code = `
    var counts = {};
    document.querySelectorAll('*').forEach(function(el){
      (el.className && el.className.split ? el.className.split(/\\s+/) : []).forEach(function(c){
        if (c) counts[c] = (counts[c]||0)+1;
      });
    });
    var top = Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];}).slice(0,40)
      .map(function(c){ return { cls: c, n: counts[c] }; });
    var interesting = top.filter(function(t){ return /price|card|item|result|listing|product|title/i.test(t.cls); });
    return { interesting: interesting, topClasses: top };`;
  const out = await call("run_js", { code, tabId });
  return out && out.result;
}

let ran = false;
async function run() {
  if (ran) return; ran = true; // guard: the extension can reconnect mid-run and re-fire
  try {
    const { tabs = [] } = await call("list_tabs", {});
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (!tab) throw new Error("no visible tab — grant the foreground tab Read+ in the popup");

    if (PROBE) {
      await call("navigate", { url: URL, tabId: tab.id });
      await sleep(2500);
      const found = await probe(tab.id);
      console.log("RESULTS_JSON:" + JSON.stringify({ mode: "probe", url: URL, ...found }));
      process.exit(0);
    }

    if (!ITEM_SEL) throw new Error("set ITEM_SEL to the repeating item's CSS selector (or run --probe to discover it)");

    // Capture the page we START on so even the first read waits for a real change.
    const before = await readState(tab.id);
    await call("navigate", { url: URL, tabId: tab.id });

    // SETTLE LOOP: poll until the results actually rendered — the signature is
    // non-empty, differs from the pre-navigation page, AND is stable across two
    // consecutive polls (so we don't read a half-rendered grid). A fixed sleep is
    // NOT enough for SPA search pages that swap results in after load.
    let cur = null, stableFor = 0, prevSig = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = await readState(tab.id);
      if (!s.matches.length || s.sig === before.sig) { stableFor = 0; prevSig = s.sig; continue; }
      stableFor = s.sig === prevSig ? stableFor + 1 : 0;
      prevSig = s.sig;
      if (stableFor >= 1) { cur = s; break; } // seen the same non-empty result twice
    }
    if (!cur) throw new Error("results didn't settle — check ITEM_SEL, or the page needs longer/scroll");

    const items = cur.matches.slice(0, MAX_ITEMS).map((m) => ({
      text: (m.text || "").trim(),
      value: parseNumber(m.text),
      link: m[LINK_ATTR] || null,
    }));

    console.log("RESULTS_JSON:" + JSON.stringify({
      mode: "extract",
      url: URL,
      count: cur.matches.length,
      heading: cur.heading || null,
      items,
    }));
    process.exit(0);
  } catch (e) {
    log("failed:", e.message);
    console.log("RESULTS_JSON:" + JSON.stringify({ error: e.message, url: URL }));
    process.exit(1);
  }
}

log(`waiting for extension… (${PROBE ? "probe" : "extract"} mode, url=${URL})`);
