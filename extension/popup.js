// Dispatch popup — the control panel. Talks to background via chrome.runtime.

const $ = (id) => document.getElementById(id);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

/** Fill static texts from _locales: data-i18n → textContent, data-i18n-<attr> → attribute. */
function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const s = await send({ type: "getState" });
  if (!s) return;

  $("enabled").checked = s.enabled;
  $("dot").classList.toggle("on", s.connected);
  $("conn").textContent = s.connected
    ? t("connOk", s.port)
    : (s.enabled ? t("connNoServer", s.port) : t("connOff"));

  // The popup page is read from disk on every open, the service worker only
  // when the extension reloads. If the files were updated but the extension
  // wasn't, the popup is new and the core is old: it lacks grantedTabs.
  if (s.grantedTabs === undefined) {
    $("granted").textContent = "";
    const warn = document.createElement("span");
    warn.className = "muted";
    warn.textContent = t("staleCore");
    $("granted").appendChild(warn);
    delete $("granted").dataset.key;
    // An extension page may reload its own extension: settings live in
    // storage and survive the restart, the popup just closes.
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
    ? t("debugOn", d.net, d.console)
    : t("debugOff");
  $("stopdbg").style.display = d.active ? "" : "none";

  $("log").textContent = (s.log || []).join("\n");
}

/** Tabs with access: click a row = make it current, ✕ = revoke access from that one. */
function renderGranted(tabs) {
  const box = $("granted");
  const key = JSON.stringify(tabs.map((x) => [x.id, x.title, x.current]));
  if (box.dataset.key === key) return; // skip re-render when unchanged, otherwise it flickers on hover
  box.dataset.key = key;
  box.textContent = "";
  if (!tabs.length) {
    const none = document.createElement("span");
    none.className = "muted"; none.textContent = t("none");
    box.appendChild(none);
    return;
  }
  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = "tab" + (tab.current ? " current" : "");
    row.title = tab.url || "";
    const mark = document.createElement("span");
    mark.className = "mark"; mark.textContent = tab.current ? "◉" : "○";
    const title = document.createElement("span");
    title.className = "title"; title.textContent = `#${tab.id} · ${tab.title || tab.url || t("untitled")}`;
    const x = document.createElement("button");
    x.className = "x"; x.textContent = "✕"; x.title = t("revokeOneTitle");
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      await send({ type: "revokeAccess", tabId: tab.id });
      refresh();
    });
    row.addEventListener("click", async () => {
      if (tab.current) return;
      await send({ type: "setCurrent", tabId: tab.id });
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
  if (r && !r.ok) alert(r.error || t("grantFailed"));
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
  if (e.target.value === "••••••") return; // don't overwrite with the mask
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

localize();
refresh();
setInterval(refresh, 1500);
