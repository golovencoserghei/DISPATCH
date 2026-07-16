// Dispatch popup — панель контроля. Общается с background через chrome.runtime.

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const s = await send({ type: "getState" });
  if (!s) return;

  $("enabled").checked = s.enabled;
  $("dot").classList.toggle("on", s.connected);
  $("conn").textContent = s.connected
    ? `подключено к 127.0.0.1:${s.port}`
    : (s.enabled ? `нет связи с сервером (порт ${s.port})` : "выключено");

  $("granted").textContent = s.grantedTitle ? `#${s.grantedTabId} · ${s.grantedTitle}` : "— нет —";
  $("port").value = s.port;
  if (document.activeElement !== $("token")) $("token").value = s.hasToken ? "••••••" : "";
  if (document.activeElement !== $("allowlist")) {
    $("allowlist").value = (s.allowlist || []).join("\n");
  }

  if (document.activeElement !== $("mode")) $("mode").value = s.mode || "full";

  const d = s.debug || {};
  $("dbg").textContent = d.active
    ? `Перехват: активен (${d.net} запр., ${d.console} лог.)`
    : "Перехват: выкл";
  $("stopdbg").style.display = d.active ? "" : "none";

  $("log").textContent = (s.log || []).join("\n");
}

$("enabled").addEventListener("change", async (e) => {
  await send({ type: "setEnabled", value: e.target.checked });
  refresh();
});

$("grant").addEventListener("click", async () => {
  const r = await send({ type: "grantActive" });
  if (r && !r.ok) alert(r.error || "не удалось дать доступ");
  refresh();
});

$("revokeAccess").addEventListener("click", async () => {
  await send({ type: "revokeAccess" });
  refresh();
});

$("port").addEventListener("change", async (e) => {
  await send({ type: "setPort", value: e.target.value });
  refresh();
});

$("token").addEventListener("change", async (e) => {
  if (e.target.value === "••••••") return; // не перезаписывать маску
  await send({ type: "setToken", value: e.target.value });
  refresh();
});

$("mode").addEventListener("change", async (e) => {
  await send({ type: "setMode", value: e.target.value });
  refresh();
});

$("allowlist").addEventListener("change", async (e) => {
  await send({ type: "setAllowlist", value: e.target.value });
  refresh();
});

$("reconnect").addEventListener("click", async () => {
  await send({ type: "reconnect" });
  setTimeout(refresh, 400);
});

$("stopdbg").addEventListener("click", async () => {
  await send({ type: "stopDebug" });
  refresh();
});

refresh();
setInterval(refresh, 1500);
