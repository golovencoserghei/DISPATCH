// Ядро Dispatch: связь с MCP-сервером, гейт доступа, диспетчер команд, CDP-менеджер.
//
// Здесь НЕТ обращений к глобальному `chrome` и `WebSocket` — оба приходят фасадом
// в createDispatcher(). Благодаря этому ядро гоняется в Node с моками
// (tests/dispatcher.mjs), а не только в браузере: настоящее расширение под
// автотест не поставить — Chrome 137+ игнорирует --load-extension, когда включён
// удалённый отладчик (та же защита, от которой Dispatch и защищает пользователя).
//
// background.js — тонкая обвязка: отдаёт сюда настоящий chrome и вешает листенеры.

import {
  pageSnapshot, pageGetHtml, pageEval, pageFocus,
  pageClick, pageType, pageWaitFor, pageExtract, pageScroll, pageShield,
} from "./page.js";
import { methodAllowed, hostAllowed, urlAllowed, hostOf, parseRef } from "./policy.js";

export const DEFAULT_PORT = 8765;
export const PROTOCOL_VERSION = 1; // должен совпадать с сервером (bridge.ts)
const NET_MAX = 500;      // размер кольцевого буфера сетевых запросов
const CONSOLE_MAX = 500;  // размер кольцевого буфера логов консоли
const LOG_MAX = 40;

const DEVICES = {
  "iPhone 14": { w: 390, h: 844, dsf: 3, mobile: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  "Pixel 7":   { w: 412, h: 915, dsf: 2.625, mobile: true, ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36" },
  "iPad":      { w: 820, h: 1180, dsf: 2, mobile: true, ua: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
};

const KEY_MAP = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

function remoteToStr(o) {
  if (!o) return "";
  if (Object.prototype.hasOwnProperty.call(o, "value")) {
    return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  }
  if (o.unserializableValue) return String(o.unserializableValue);
  if (o.description) return o.description;
  return o.type + (o.subtype ? `:${o.subtype}` : "");
}

// Инжект скриптов и захват возможны только на обычных страницах, не на служебных.
const isInjectable = (url) => /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");

/**
 * @param {object} deps
 * @param {object} deps.chrome            фасад расширенческого API
 * @param {Function} deps.WebSocketImpl   конструктор WebSocket
 * @param {string} [deps.userAgent]       UA браузера — уходит серверу в hello
 * @param {Function} [deps.now]           источник времени (для тестов)
 */
export function createDispatcher({ chrome, WebSocketImpl, userAgent = "", now = () => Date.now() }) {
  const WS = WebSocketImpl;

  // ── состояние связи/контроля ───────────────────────────────────────────────
  const state = {
    ws: null,
    connected: false,
    enabled: false,        // мастер-тумблер
    port: DEFAULT_PORT,
    token: "",             // опциональный секрет; нужен, если сервер запущен с DISPATCH_TOKEN
    mode: "full",          // "full" | "readonly" — read-only блокирует изменяющие команды
    grantedTabId: null,    // вкладка, на которой разрешено действовать
    grantedTitle: "",
    allowlist: [],         // список хостов-паттернов; пусто = любой
    log: [],               // кольцевой буфер последних действий
  };

  // ── состояние CDP-сессии (перехват/эмуляция) ───────────────────────────────
  const dbg = {
    tabId: null,           // к какой вкладке прикреплена постоянная сессия
    attached: false,
    persistent: false,     // включена ли пользователем через debug_start/emulate
    net: [],               // кольцевой буфер записей запросов
    netById: new Map(),    // requestId -> запись
    console: [],           // кольцевой буфер логов
    emulation: [],         // применённые override'ы (для статуса)
  };

  function pushLog(line) {
    const ts = new Date(now()).toLocaleTimeString();
    state.log.unshift(`${ts}  ${line}`);
    if (state.log.length > LOG_MAX) state.log.pop();
  }

  async function loadSettings() {
    const s = await chrome.storage.local.get(["enabled", "port", "token", "mode", "allowlist", "grantedTabId", "grantedTitle"]);
    state.enabled = !!s.enabled;
    state.port = s.port || DEFAULT_PORT;
    state.token = s.token || "";
    state.mode = s.mode === "readonly" ? "readonly" : "full";
    state.allowlist = Array.isArray(s.allowlist) ? s.allowlist : [];
    state.grantedTabId = s.grantedTabId ?? null;
    state.grantedTitle = s.grantedTitle || "";
  }

  function saveSettings() {
    chrome.storage.local.set({
      enabled: state.enabled,
      port: state.port,
      token: state.token,
      mode: state.mode,
      allowlist: state.allowlist,
      grantedTabId: state.grantedTabId,
      grantedTitle: state.grantedTitle,
    });
  }

  // ── бейдж на иконке: цвет = статус связи, «◉» на вкладке с доступом ─────────
  let lastGrantedBadge = null;
  const safe = (p) => { try { if (p && p.catch) p.catch(() => {}); } catch { /* noop */ } };

  function updateBadge() {
    const color = !state.enabled ? "#888888" : (state.connected ? "#2c8a3d" : "#bb3333");
    safe(chrome.action.setBadgeBackgroundColor({ color }));
    safe(chrome.action.setBadgeText({ text: !state.enabled ? "" : (state.connected ? "on" : "off") }));
    // снять пометку со старой вкладки с доступом
    if (lastGrantedBadge != null && lastGrantedBadge !== state.grantedTabId) {
      safe(chrome.action.setBadgeText({ text: "", tabId: lastGrantedBadge }));
      lastGrantedBadge = null;
    }
    if (state.grantedTabId != null) {
      safe(chrome.action.setBadgeText({ text: "◉", tabId: state.grantedTabId }));
      safe(chrome.action.setBadgeBackgroundColor({ color: "#2c8a3d", tabId: state.grantedTabId }));
      lastGrantedBadge = state.grantedTabId;
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  let reconnectTimer = null;
  function scheduleReconnect(delayMs) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (state.enabled && !state.connected) connect();
    }, delayMs);
  }

  function connect() {
    if (state.ws && (state.ws.readyState === WS.OPEN || state.ws.readyState === WS.CONNECTING)) return;
    const url = `ws://127.0.0.1:${state.port}`;
    let ws;
    try {
      ws = new WS(url);
    } catch (e) {
      pushLog(`WS ошибка создания: ${e}`);
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      pushLog("подключено к MCP-серверу");
      send({ kind: "event", event: "hello", data: { name: "Dispatch", protocolVersion: PROTOCOL_VERSION, token: state.token || "", ua: userAgent, ts: now() } });
      updateBadge();
    };
    ws.onclose = () => {
      state.connected = false;
      pushLog("соединение с сервером закрыто");
      updateBadge();
      if (state.enabled) scheduleReconnect(1500); // быстрый повтор; alarm — резервный
    };
    ws.onerror = () => { /* onclose последует */ };
    ws.onmessage = (ev) => onMessage(ev.data);
  }

  /** Полностью разорвать связь: закрыть сокет, снять отладку, отменить реконнект. */
  async function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (state.ws) { try { state.ws.close(); } catch { /* noop */ } }
    state.ws = null;
    state.connected = false;
    if (dbg.attached) await releasePersistent(); // не оставлять баннер отладки висеть
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WS.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  async function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.kind === "ping") { send({ kind: "pong" }); return; }
    if (msg.kind !== "cmd") return;

    const { id, method, params } = msg;
    try {
      const handler = handlers[method];
      if (!handler) throw new Error(`неизвестный метод: ${method}`);
      // Главный гейт мастер-тумблера: пока он выключен, НИ ОДНА команда не
      // исполняется — включая status/tabs (список вкладок с URL — тоже данные).
      // Дублируется в requireGranted как страховка.
      if (!state.enabled) {
        throw new Error("Мастер-тумблер Dispatch выключен — включи его в popup.");
      }
      if (!methodAllowed(method, state.mode)) {
        throw new Error(`Режим «только чтение»: команда «${method}» заблокирована. Переключи режим в popup Dispatch.`);
      }
      const result = await handler(params || {});
      send({ id, kind: "res", ok: true, result });
      pushLog(`✓ ${method}`);
    } catch (e) {
      send({ id, kind: "res", ok: false, error: e && e.message ? e.message : String(e) });
      pushLog(`✗ ${method}: ${e && e.message ? e.message : e}`);
    }
  }

  // ── проверки безопасности ──────────────────────────────────────────────────
  function requireGranted() {
    if (!state.enabled) throw new Error("Мастер-тумблер выключен — включи Dispatch в popup.");
    if (state.grantedTabId == null) throw new Error("Нет вкладки с доступом — открой popup и нажми «Дать доступ к этой вкладке».");
  }

  async function grantedTab() {
    requireGranted();
    let tab;
    try {
      tab = await chrome.tabs.get(state.grantedTabId);
    } catch {
      state.grantedTabId = null; saveSettings();
      throw new Error("Вкладка с доступом закрыта — дай доступ заново.");
    }
    if (state.allowlist.length) {
      const host = hostOf(tab.url); // null для about:, chrome: и прочих непарсируемых
      if (host === null || !hostAllowed(host, state.allowlist)) {
        throw new Error(`Хост «${host ?? tab.url ?? "?"}» не в allowlist. Разреши его в popup или очисти список.`);
      }
    }
    return tab;
  }

  // ── шильдик на странице: видно, какая вкладка под контролем ────────────────
  // Бейдж на иконке виден только рядом с иконкой; шильдик показывает это прямо
  // на самой странице, чтобы вкладку под агентом нельзя было спутать.
  async function paintShield(tabId, mode) {
    if (tabId == null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isInjectable(tab.url)) return; // на служебных страницах скрипты запрещены
      await chrome.scripting.executeScript({
        target: { tabId }, world: "ISOLATED", func: pageShield, args: [mode],
      });
    } catch { /* вкладка закрыта или недоступна — шильдик не критичен */ }
  }
  const showShield = (tabId) => paintShield(tabId, state.mode);
  const hideShield = (tabId) => paintShield(tabId, null);

  /** Сменить вкладку с доступом; закрыть debug-сессию, если она на другой вкладке. */
  async function grantAccess(tab) {
    if (dbg.attached && dbg.tabId !== tab.id) await releasePersistent();
    const prev = state.grantedTabId;
    state.grantedTabId = tab.id;
    state.grantedTitle = tab.title || "";
    saveSettings();
    updateBadge();
    if (prev != null && prev !== tab.id) await hideShield(prev);
    await showShield(tab.id);
  }

  function requireInjectable(tab) {
    if (!isInjectable(tab.url)) {
      throw new Error(`Служебная страница (${tab.url || "?"}) — Chrome запрещает здесь скрипты и захват. Дай доступ обычному сайту (http/https).`);
    }
  }

  // ── исполнение в странице (chrome.scripting) ───────────────────────────────
  async function runInPage(func, args = [], world = "ISOLATED", frameId = 0) {
    const tab = await grantedTab();
    requireInjectable(tab);
    const target = frameId ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id };
    const res = await chrome.scripting.executeScript({ target, world, func, args });
    const r = res && res[0] ? res[0].result : undefined;
    if (r && r.ok === false) throw new Error(r.error || "ошибка выполнения в странице");
    return r;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CDP-менеджер: единственная точка доступа к chrome.debugger.
  // ══════════════════════════════════════════════════════════════════════════

  function dbgAttach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const e = chrome.runtime.lastError;
        if (e) {
          const m = e.message || "";
          reject(new Error(/already attached/i.test(m)
            ? `К вкладке уже подключён другой отладчик (закрой DevTools на ней). ${m}`
            : `CDP attach: ${m}`));
        } else resolve();
      });
    });
  }

  function dbgDetach(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
    });
  }

  function dbgSend(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(`${method}: ${e.message}`)); else resolve(r);
      });
    });
  }

  // Все операции, трогающие attach/detach, идут через ОДНУ очередь. Иначе два
  // конкурентных вызова на одной вкладке дерутся: второй attach падает с
  // «already attached», а detach первого убивает сессию второго на полпути.
  let cdpQueue = Promise.resolve();
  function cdpSerial(fn) {
    const run = cdpQueue.then(fn, fn); // сбой предыдущей операции не рвёт очередь
    cdpQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Разовая CDP-операция: переиспользует активную сессию или поднимает временную. */
  async function rawWithTempCdp(tabId, fn) {
    const reuse = dbg.attached && dbg.tabId === tabId;
    if (!reuse) await dbgAttach(tabId);
    try { return await fn(); }
    finally { if (!reuse) await dbgDetach(tabId); }
  }
  const withTempCdp = (tabId, fn) => cdpSerial(() => rawWithTempCdp(tabId, fn));

  async function enableDomains(tabId) {
    await dbgSend(tabId, "Page.enable", {}).catch(() => {});
    await dbgSend(tabId, "Network.enable", {}).catch(() => {});
    await dbgSend(tabId, "Runtime.enable", {}).catch(() => {});
    await dbgSend(tabId, "Log.enable", {}).catch(() => {});
  }

  // raw* — «сырые» версии без очереди: их можно звать ИЗНУТРИ cdpSerial.
  // Публичные обёртки ниже сериализуют вызовы извне (иначе — дедлок на себе).

  /** Гарантировать постоянную debug-сессию на вкладке (для перехвата/эмуляции). */
  async function rawEnsurePersistent(tabId) {
    if (dbg.persistent && dbg.attached && dbg.tabId === tabId) return;
    if (dbg.attached) await rawReleasePersistent();
    await dbgAttach(tabId);
    dbg.tabId = tabId;
    dbg.attached = true;
    dbg.persistent = true;
    await enableDomains(tabId);
    pushLog(`debug-сессия открыта на вкладке #${tabId}`);
  }
  const ensurePersistent = (tabId) => cdpSerial(() => rawEnsurePersistent(tabId));

  async function rawReleasePersistent() {
    const id = dbg.tabId;
    dbg.persistent = false;
    dbg.attached = false;
    dbg.tabId = null;
    dbg.net = [];
    dbg.netById.clear();
    dbg.console = [];
    dbg.emulation = [];
    if (id != null) { try { await dbgDetach(id); } catch { /* noop */ } }
  }
  const releasePersistent = () => cdpSerial(rawReleasePersistent);

  function requirePersistent() {
    if (!dbg.persistent) throw new Error("Перехват не включён — сначала вызови browser_debug_start.");
  }

  // ── обработка CDP-событий ──────────────────────────────────────────────────
  function addNet(rec) {
    if (!dbg.netById.has(rec.requestId)) {
      dbg.netById.set(rec.requestId, rec);
      dbg.net.push(rec);
      if (dbg.net.length > NET_MAX) {
        const old = dbg.net.shift();
        if (old) dbg.netById.delete(old.requestId);
      }
    }
  }

  function pushConsole(entry) {
    dbg.console.push(entry);
    if (dbg.console.length > CONSOLE_MAX) dbg.console.shift();
  }

  function handleCdpEvent(source, method, params) {
    if (!dbg.persistent || source.tabId !== dbg.tabId) return;
    try { dispatchCdpEvent(method, params); } catch { /* защита буфера */ }
  }

  function dispatchCdpEvent(method, params) {
    switch (method) {
      case "Network.requestWillBeSent": {
        const rec = dbg.netById.get(params.requestId) || { requestId: params.requestId };
        const req = params.request || {};
        rec.url = req.url;
        rec.method = req.method;
        rec.postData = req.postData;
        rec.requestHeaders = req.headers;
        rec.resourceType = params.type || rec.resourceType;
        rec.ts = now();
        addNet(rec);
        break;
      }
      case "Network.responseReceived": {
        const rec = dbg.netById.get(params.requestId) || { requestId: params.requestId };
        const res = params.response || {};
        rec.status = res.status;
        rec.statusText = res.statusText;
        rec.mimeType = res.mimeType;
        rec.responseHeaders = res.headers;
        rec.fromCache = res.fromDiskCache || res.fromServiceWorker || false;
        rec.resourceType = params.type || rec.resourceType;
        addNet(rec);
        break;
      }
      case "Network.loadingFinished": {
        const rec = dbg.netById.get(params.requestId);
        if (rec) rec.encodedDataLength = params.encodedDataLength;
        break;
      }
      case "Network.loadingFailed": {
        const rec = dbg.netById.get(params.requestId);
        if (rec) { rec.failed = true; rec.errorText = params.errorText; }
        break;
      }
      case "Runtime.consoleAPICalled": {
        pushConsole({
          kind: "console",
          level: params.type,
          text: (params.args || []).map(remoteToStr).join(" "),
          ts: now(),
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        pushConsole({
          kind: "exception",
          level: "error",
          text: (d.exception && d.exception.description) || d.text || "необработанное исключение",
          url: d.url,
          line: d.lineNumber,
          ts: now(),
        });
        break;
      }
      case "Log.entryAdded": {
        const e = params.entry || {};
        pushConsole({ kind: "log", level: e.level, text: e.text, url: e.url, line: e.lineNumber, ts: now() });
        break;
      }
    }
  }

  function onCdpDetach(source, reason) {
    if (source.tabId === dbg.tabId) {
      dbg.attached = false;
      dbg.persistent = false;
      pushLog(`debug-сессия отсоединена (${reason})`);
    }
  }

  // ── скриншоты ──────────────────────────────────────────────────────────────
  async function fullPageShot(tabId) {
    return withTempCdp(tabId, async () => {
      const m = await dbgSend(tabId, "Page.getLayoutMetrics");
      const size = m.cssContentSize || m.contentSize;
      const shot = await dbgSend(tabId, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 },
      });
      return { data: shot.data, format: "png", fullPage: true };
    });
  }

  // ── эмуляция ───────────────────────────────────────────────────────────────
  async function emulate(params) {
    const tab = await grantedTab();
    if (params.reset) {
      await releasePersistent();
      return { ok: true, reset: true, note: "Все override'ы сняты, debug-сессия закрыта." };
    }
    await ensurePersistent(tab.id);
    const applied = [];
    if (params.device) {
      const d = DEVICES[params.device];
      if (!d) throw new Error(`Неизвестное устройство «${params.device}». Доступны: ${Object.keys(DEVICES).join(", ")}`);
      await dbgSend(tab.id, "Emulation.setDeviceMetricsOverride", { width: d.w, height: d.h, deviceScaleFactor: d.dsf, mobile: d.mobile });
      await dbgSend(tab.id, "Emulation.setUserAgentOverride", { userAgent: d.ua });
      applied.push(`device:${params.device}`);
    }
    if (params.viewport) {
      const v = params.viewport;
      await dbgSend(tab.id, "Emulation.setDeviceMetricsOverride", {
        width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor || 1, mobile: !!v.mobile,
      });
      applied.push(`viewport:${v.width}x${v.height}`);
    }
    if (params.userAgent) {
      await dbgSend(tab.id, "Emulation.setUserAgentOverride", { userAgent: params.userAgent });
      applied.push("userAgent");
    }
    if (params.geolocation) {
      const g = params.geolocation;
      await dbgSend(tab.id, "Emulation.setGeolocationOverride", {
        latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy || 10,
      });
      applied.push("geolocation");
    }
    dbg.emulation = applied;
    return { ok: true, applied, note: "Эмуляция активна, пока идёт debug-сессия (виден баннер отладки Chrome)." };
  }

  // ── точный ввод (CDP Input) ────────────────────────────────────────────────
  async function pressKey(params) {
    const tab = await grantedTab();
    const key = params.key;
    if (!key) throw new Error("не указана клавиша (key)");
    if (params.selector) await runInPage(pageFocus, [params.selector], "ISOLATED");
    const spec = KEY_MAP[key] || (key.length === 1
      ? { key, code: "Key" + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0), text: key }
      : { key, code: key, keyCode: 0 });
    return withTempCdp(tab.id, async () => {
      const base = {
        key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode,
      };
      await dbgSend(tab.id, "Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, text: spec.text });
      await dbgSend(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return { ok: true, key };
    });
  }

  // ── навигация: ждём complete ───────────────────────────────────────────────
  function waitComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
      const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
      const timer = setTimeout(done, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      // Если уже complete — завершаем сразу.
      chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
    });
  }

  // ── обработчики команд ─────────────────────────────────────────────────────
  const handlers = {
    async status() {
      return {
        connected: state.connected,
        enabled: state.enabled,
        mode: state.mode,
        grantedTabId: state.grantedTabId,
        grantedTitle: state.grantedTitle,
        allowlist: state.allowlist,
        debug: { active: dbg.persistent, tabId: dbg.tabId, net: dbg.net.length, console: dbg.console.length, emulation: dbg.emulation },
      };
    },

    async tabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, title: t.title, url: t.url, active: t.active, granted: t.id === state.grantedTabId,
      }));
    },

    async select_tab({ tabId }) {
      const tab = await chrome.tabs.get(tabId);
      // Агент переключает доступ сам, поэтому allowlist — единственная граница:
      // на вкладку вне списка переключиться нельзя.
      if (!urlAllowed(tab.url, state.allowlist)) {
        throw new Error(`Доступ к «${tab.url || "?"}» запрещён: хост не в allowlist. Разреши его в popup или очисти список.`);
      }
      await grantAccess(tab);
      return { grantedTabId: tab.id, title: tab.title, url: tab.url };
    },

    async open_tab({ url, active, grant }) {
      if (url && !urlAllowed(url, state.allowlist)) {
        throw new Error(`Открытие «${url}» запрещено: хост не в allowlist. Разреши его в popup или очисти список.`);
      }
      const tab = await chrome.tabs.create({ url: url || undefined, active: active !== false });
      // По умолчанию даём доступ новой вкладке — агент её явно открыл.
      if (grant !== false) await grantAccess(tab);
      await waitComplete(tab.id, 30000).catch(() => {});
      const t = await chrome.tabs.get(tab.id);
      return { tabId: t.id, url: t.url, title: t.title, granted: t.id === state.grantedTabId };
    },

    // Закрыть можно ТОЛЬКО вкладку с доступом: иначе агент мог бы закрыть любую
    // вкладку браузера по чужому id. Чтобы закрыть другую — сначала select_tab.
    async close_tab({ tabId }) {
      const tab = await grantedTab();
      if (tabId != null && tabId !== tab.id) {
        throw new Error(`Закрыть можно только вкладку с доступом (#${tab.id}), а не #${tabId}. Сначала дай доступ через browser_select_tab.`);
      }
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    },

    async navigate({ url }) {
      const tab = await grantedTab();
      if (!urlAllowed(url, state.allowlist)) {
        throw new Error(`Переход на «${url}» запрещён: хост не в allowlist. Разреши его в popup или очисти список.`);
      }
      await chrome.tabs.update(tab.id, { url });
      await waitComplete(tab.id, 30000);
      const t = await chrome.tabs.get(tab.id);
      return { url: t.url, title: t.title };
    },

    async snapshot() {
      const tab = await grantedTab();
      requireInjectable(tab);
      // allFrames: снимок со ВСЕХ инъектируемых фреймов; ref = "<frameId>:<localRef>".
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, world: "ISOLATED", func: pageSnapshot,
      });
      const elements = [];
      let url = tab.url, title = tab.title || "";
      for (const r of results) {
        const v = r.result;
        if (!v || !v.ok) continue;
        if (r.frameId === 0) { url = v.url; title = v.title; }
        for (const el of v.elements) elements.push({ ...el, ref: `${r.frameId}:${el.ref}`, frameId: r.frameId });
      }
      return { ok: true, url, title, count: elements.length, frames: results.length, elements };
    },

    async get_html({ selector }) {
      return runInPage(pageGetHtml, [selector || null], "ISOLATED");
    },

    async eval({ expression }) {
      return runInPage(pageEval, [expression], "MAIN");
    },

    async click({ ref, selector }) {
      const { frameId, localRef } = parseRef(ref);
      return runInPage(pageClick, [localRef, selector || null], "ISOLATED", frameId);
    },

    async type({ ref, selector, text, submit }) {
      const { frameId, localRef } = parseRef(ref);
      return runInPage(pageType, [localRef, selector || null, text, !!submit], "ISOLATED", frameId);
    },

    async wait_for({ selector, timeoutMs }) {
      return runInPage(pageWaitFor, [selector || null, timeoutMs || 10000], "ISOLATED");
    },

    async extract({ container, fields, multiple }) {
      return runInPage(pageExtract, [container || null, fields || {}, !!multiple], "ISOLATED");
    },

    async scroll({ selector, dx, dy, toBottom }) {
      return runInPage(pageScroll, [selector || null, dx || 0, dy || 0, !!toBottom], "ISOLATED");
    },

    async press_key(params) {
      return pressKey(params);
    },

    async screenshot({ fullPage }) {
      const tab = await grantedTab();
      requireInjectable(tab);
      if (fullPage) return fullPageShot(tab.id);
      // Видимая область: для активной вкладки — быстрый путь без баннера.
      if (tab.active) {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { data: dataUrl.split(",")[1], format: "png", fullPage: false };
      }
      // Неактивная вкладка: captureVisibleTab снял бы не ту — идём через CDP.
      return withTempCdp(tab.id, async () => {
        const s = await dbgSend(tab.id, "Page.captureScreenshot", { format: "png" });
        return { data: s.data, format: "png", fullPage: false };
      });
    },

    // ── отладка: перехват сети/консоли ──
    async debug_start() {
      const tab = await grantedTab();
      await ensurePersistent(tab.id);
      return { ok: true, attached: true, tabId: tab.id, note: "Перехват console/network включён. Баннер отладки Chrome виден до browser_debug_stop." };
    },

    async debug_stop() {
      const captured = { network: dbg.net.length, console: dbg.console.length };
      await releasePersistent();
      return { ok: true, detached: true, captured };
    },

    async console_logs({ level, clear }) {
      requirePersistent();
      let items = dbg.console;
      if (level) items = items.filter((e) => String(e.level).toLowerCase() === String(level).toLowerCase());
      const logs = items.slice(-200);
      if (clear) dbg.console = [];
      return { ok: true, count: logs.length, logs };
    },

    async network({ filter, clear }) {
      requirePersistent();
      let items = dbg.net;
      if (filter) items = items.filter((r) => (r.url || "").includes(filter));
      const requests = items.map((r) => ({
        requestId: r.requestId, method: r.method, status: r.status, type: r.resourceType,
        mime: r.mimeType, failed: r.failed || false, errorText: r.errorText,
        bytes: r.encodedDataLength, url: (r.url || "").slice(0, 300),
      }));
      if (clear) { dbg.net = []; dbg.netById.clear(); }
      return { ok: true, count: requests.length, requests };
    },

    async network_body({ requestId }) {
      requirePersistent();
      if (!requestId) throw new Error("не указан requestId (возьми из browser_network)");
      const r = await dbgSend(dbg.tabId, "Network.getResponseBody", { requestId });
      const body = r.body || "";
      const LIMIT = 200000;
      return { ok: true, base64Encoded: !!r.base64Encoded, truncated: body.length > LIMIT, body: body.slice(0, LIMIT) };
    },

    async emulate(params) {
      return emulate(params);
    },
  };

  // ── сообщения от popup ─────────────────────────────────────────────────────
  async function handlePopup(msg) {
    switch (msg.type) {
      case "getState":
        return {
          connected: state.connected,
          enabled: state.enabled,
          port: state.port,
          hasToken: !!state.token,
          mode: state.mode,
          grantedTabId: state.grantedTabId,
          grantedTitle: state.grantedTitle,
          allowlist: state.allowlist,
          log: state.log,
          debug: { active: dbg.persistent, tabId: dbg.tabId, net: dbg.net.length, console: dbg.console.length },
        };
      case "setEnabled":
        state.enabled = !!msg.value;
        saveSettings();
        if (state.enabled) { connect(); await showShield(state.grantedTabId); }
        else { await disconnect(); await hideShield(state.grantedTabId); } // выключен = связи нет и шильдика тоже
        pushLog(state.enabled ? "включено" : "выключено");
        updateBadge();
        return { ok: true };
      case "setPort":
        state.port = Number(msg.value) || DEFAULT_PORT;
        saveSettings();
        if (state.ws) try { state.ws.close(); } catch { /* noop */ }
        if (state.enabled) connect();
        return { ok: true };
      case "setToken":
        state.token = String(msg.value || "");
        saveSettings();
        if (state.ws) try { state.ws.close(); } catch { /* noop */ }
        if (state.enabled) connect();
        return { ok: true };
      case "setMode":
        state.mode = msg.value === "readonly" ? "readonly" : "full";
        saveSettings();
        pushLog(`режим: ${state.mode}`);
        if (state.enabled) await showShield(state.grantedTabId); // перерисовать под новый режим
        return { ok: true };
      case "grantActive": {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) return { ok: false, error: "нет активной вкладки" };
        await grantAccess(tab);
        pushLog(`доступ выдан: ${tab.title}`);
        return { ok: true, grantedTabId: tab.id, grantedTitle: tab.title };
      }
      case "revokeAccess": {
        if (dbg.attached) await releasePersistent();
        const was = state.grantedTabId;
        state.grantedTabId = null;
        state.grantedTitle = "";
        saveSettings();
        pushLog("доступ забран");
        updateBadge();
        await hideShield(was);
        return { ok: true };
      }
      case "stopDebug":
        await releasePersistent();
        pushLog("перехват остановлен из popup");
        return { ok: true };
      case "setAllowlist":
        state.allowlist = String(msg.value || "")
          .split("\n").map((s) => s.trim()).filter(Boolean);
        saveSettings();
        return { ok: true, allowlist: state.allowlist };
      case "reconnect":
        if (state.ws) try { state.ws.close(); } catch { /* noop */ }
        connect();
        return { ok: true };
      default:
        return { ok: false, error: "неизвестное сообщение popup" };
    }
  }

  // ── реакция на закрытие вкладок ────────────────────────────────────────────
  function onTabRemoved(tabId) {
    if (tabId === dbg.tabId) { dbg.attached = false; dbg.persistent = false; dbg.tabId = null; }
    if (tabId === state.grantedTabId) {
      state.grantedTabId = null; state.grantedTitle = ""; saveSettings();
      pushLog("вкладка с доступом закрыта");
    }
    updateBadge();
  }

  /** Навигация стирает шильдик вместе со старым документом — рисуем заново. */
  function onTabUpdated(tabId, info) {
    if (!state.enabled) return;
    if (tabId !== state.grantedTabId) return;
    if (info.status !== "complete") return;
    showShield(tabId);
  }

  /** Резервный путь: alarm поднимает связь, если service worker выгружали. */
  function onKeepalive() {
    if (state.enabled && !state.connected) connect();
  }

  async function init() {
    await loadSettings();
    updateBadge();
    if (state.enabled) { connect(); showShield(state.grantedTabId); }
    pushLog("service worker запущен");
  }

  return {
    state, dbg, handlers,
    init, connect, disconnect, onMessage, handlePopup,
    handleCdpEvent, onCdpDetach, onTabRemoved, onTabUpdated, onKeepalive,
  };
}
