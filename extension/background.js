// Dispatch — фоновый service worker расширения.
//
// Тонкая обвязка: отдаёт ядру (dispatcher.js) настоящие браузерные API и вешает
// глобальные листенеры. Вся логика — связь, гейт доступа, диспетчер команд,
// CDP-менеджер — живёт в ядре, чтобы её можно было тестировать без браузера.

import { createDispatcher } from "./dispatcher.js";

const d = createDispatcher({
  chrome,
  WebSocketImpl: WebSocket,
  userAgent: navigator.userAgent,
});

// Глобальные листенеры CDP (регистрируются один раз при загрузке модуля).
chrome.debugger.onEvent.addListener((source, method, params) => d.handleCdpEvent(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => d.onCdpDetach(source, reason));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  d.handlePopup(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // ответ асинхронный
});

chrome.tabs.onRemoved.addListener((tabId) => d.onTabRemoved(tabId));

// Резервный путь на случай выгрузки service worker'а.
chrome.alarms.create("dispatch-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "dispatch-keepalive") d.onKeepalive(); });

d.init();
