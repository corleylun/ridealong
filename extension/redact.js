/* Best-effort secret redaction (PLAN.md §6/§9).
 *
 * NOT a trust boundary — content scripts and the background are the same trust
 * level, so this only reduces ACCIDENTAL secret exposure to the agent (e.g. a
 * card number or API key sitting in visible page text), not a containment
 * control against a hostile page.
 *
 * Injected ON DEMAND via tabs.executeScript({file:"redact.js"}) only when
 * read_page runs on a tab already granted Read+ — this is deliberately NOT a
 * declared <all_urls> always-on content script (manifest.json has no
 * content_scripts entry for this file). It defines a single global function and
 * does nothing else: no browser.runtime usage, no message relay of any kind.
 */
function fxmcpRedact(text) {
  if (typeof text !== "string") return text;
  var patterns = [
    // Credit-card-like digit runs (13-19 digits, optionally grouped by space/dash).
    /\b(?:\d[ -]?){13,19}\b/g,
    // Common API key / token prefixes (OpenAI/Anthropic-ish, GitHub, Slack, Google).
    /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
    // JWT-shaped strings (header.payload.signature).
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    // Long hex/base64-ish blobs that look like secrets/keys.
    /\b[A-Fa-f0-9]{32,}\b/g,
  ];
  var out = text;
  for (var i = 0; i < patterns.length; i++) {
    out = out.replace(patterns[i], "[REDACTED]");
  }
  return out;
}
