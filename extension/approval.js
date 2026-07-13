/* Trusted-chrome approval page (PLAN.md §5, D0). Opened by background.js via
 * browser.windows.create({type:"popup", url:"approval.html?callId=..."}).
 *
 * This page learns the concrete effect FROM the background (by callId), never by
 * reconstructing it from the page being acted on. Its Approve/Deny messages are
 * accepted by the background ONLY from a sender with no `sender.tab` whose
 * `sender.url` ends with approval.html — a content script relay cannot forge this.
 */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let callId = params.get("callId");

function render(detail) {
  if (!detail) {
    $("tool").textContent = "(expired)";
    $("tab").textContent = "—";
    $("effect").textContent = "This request already timed out, was resolved, or the window was reused for a different call.";
    $("approve").disabled = true;
    $("deny").disabled = true;
    return;
  }
  $("tool").textContent = detail.tool;
  $("tab").textContent = detail.tabTitle || ("tab " + detail.tabId);
  $("effect").textContent = detail.detail;
  $("approve").disabled = false;
  $("deny").disabled = false;
}

async function loadDetail(id) {
  const detail = await browser.runtime.sendMessage({ cmd: "approval_get_detail", callId: id }).catch(() => null);
  render(detail);
}

$("approve").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "approval_decision", callId, approved: true }).catch(() => {});
  $("approve").disabled = true;
  $("deny").disabled = true;
});

$("deny").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "approval_decision", callId, approved: false }).catch(() => {});
  $("approve").disabled = true;
  $("deny").disabled = true;
});

// The background sends this when the SAME window is reused for the next queued
// call, instead of spawning a new popup (serialized single-window queue).
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "approval_show") {
    callId = msg.callId;
    loadDetail(callId);
  }
});

loadDetail(callId);
