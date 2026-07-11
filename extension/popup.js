const $ = (id) => document.getElementById(id);

async function load() {
  const c = await browser.storage.local.get(["port", "token"]);
  if (c.port) $("port").value = c.port;
  if (c.token) $("token").value = c.token;
  refresh();
}

function render(s) {
  const el = $("status");
  el.className = s.status;
  el.textContent = s.status + (s.detail ? ` — ${s.detail}` : "");
}

async function refresh() {
  const s = await browser.runtime.sendMessage({ cmd: "status" }).catch(() => null);
  if (s) render(s);
}

$("connect").addEventListener("click", async () => {
  await browser.storage.local.set({
    port: Number($("port").value) || 8765,
    token: $("token").value.trim(),
  });
  browser.runtime.sendMessage({ cmd: "connect" });
  setTimeout(refresh, 500);
});

$("disconnect").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "disconnect" });
  setTimeout(refresh, 300);
});

browser.runtime.onMessage.addListener((msg) => { if (msg.type === "status") render(msg); });
load();
setInterval(refresh, 2000);
