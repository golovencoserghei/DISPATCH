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

  // Popup-страница читается с диска при каждом открытии, а service worker —
  // только при перезагрузке расширения. Если файлы обновили, а расширение
  // нет, popup новый, ядро старое: оно не знает поля grantedTabs.
  if (s.grantedTabs === undefined) {
    $("granted").textContent = "";
    const warn = document.createElement("span");
    warn.className = "muted";
    warn.textContent = "ядро расширения устарело — перезагружаю расширение…";
    $("granted").appendChild(warn);
    delete $("granted").dataset.key;
    // Страница расширения вправе перезагрузить его сама: настройки лежат в
    // storage и переживут перезапуск, popup просто закроется.
    if (!refresh.reloading) {
      refresh.reloading = true;
      setTimeout(() => chrome.runtime.reload(), 300);
    }
  } else {
    renderGranted(s.grantedTabs);
  }
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

/** Список вкладок с доступом: строка = сделать текущей, ✕ = забрать доступ у одной. */
function renderGranted(tabs) {
  const box = $("granted");
  const key = JSON.stringify(tabs.map((t) => [t.id, t.title, t.current]));
  if (box.dataset.key === key) return; // не перерисовывать без изменений — иначе мигает при hover
  box.dataset.key = key;
  box.textContent = "";
  if (!tabs.length) {
    const none = document.createElement("span");
    none.className = "muted"; none.textContent = "— нет —";
    box.appendChild(none);
    return;
  }
  for (const t of tabs) {
    const row = document.createElement("div");
    row.className = "tab" + (t.current ? " current" : "");
    row.title = t.url || "";
    const mark = document.createElement("span");
    mark.className = "mark"; mark.textContent = t.current ? "◉" : "○";
    const title = document.createElement("span");
    title.className = "title"; title.textContent = `#${t.id} · ${t.title || t.url || "без названия"}`;
    const x = document.createElement("button");
    x.className = "x"; x.textContent = "✕"; x.title = "Забрать доступ у этой вкладки";
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      await send({ type: "revokeAccess", tabId: t.id });
      refresh();
    });
    row.addEventListener("click", async () => {
      if (t.current) return;
      await send({ type: "setCurrent", tabId: t.id });
      refresh();
    });
    row.append(mark, title, x);
    box.appendChild(row);
  }
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
