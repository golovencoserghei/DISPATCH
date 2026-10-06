// Dispatch — the extension's background service worker.
//
// A thin shell: hands the real browser APIs to the core (dispatcher.js) and
// registers global listeners. All logic — transport, access gate, command
// dispatcher, CDP manager — lives in the core so it can be tested without a browser.

import { createDispatcher } from "./dispatcher.js";

const d = createDispatcher({
  chrome,
  WebSocketImpl: WebSocket,
  userAgent: navigator.userAgent,
});

// Global CDP listeners (registered once, at module load).
chrome.debugger.onEvent.addListener((source, method, params) => d.handleCdpEvent(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => d.onCdpDetach(source, reason));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  d.handlePopup(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => d.onTabRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => d.onTabUpdated(tabId, info));

// Fallback in case the service worker gets unloaded.
// 0.5 min = 30 s — going lower is pointless: Chrome raises the period to
// 30 seconds anyway.
chrome.alarms.create("dispatch-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "dispatch-keepalive") d.onKeepalive(); });

d.init();
