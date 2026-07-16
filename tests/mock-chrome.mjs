// Мок браузерного API для тестов ядра (extension/dispatcher.js).
// Повторяет те черты chrome.*, от которых ядро реально зависит, включая
// callback-стиль с chrome.runtime.lastError у chrome.debugger.

/** WebSocket-заглушка: тест сам открывает соединение и читает отправленное. */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last = null;
  static created = 0;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];       // всё, что ядро отправило серверу (уже распарсенное)
    this.closed = false;
    MockWebSocket.last = this;
    MockWebSocket.created++;
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.closed = true;
    this.onclose?.();
  }
  /** тест: «сервер принял соединение» */
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  /** тест: «сервер прислал сообщение» */
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
  /** ответ ядра на команду с данным id */
  reply(id) { return this.sent.find((m) => m.id === id && m.kind === "res"); }
}

/**
 * @param {object} opts
 * @param {Array}  [opts.tabs]     стартовые вкладки
 * @param {object} [opts.storage]  стартовый chrome.storage.local
 * @param {object} [opts.scriptResult] что вернёт executeScript
 */
export function mockChrome({ tabs = [], storage = {}, scriptResult = { ok: true } } = {}) {
  const store = { ...storage };
  let tabList = tabs.map((t) => ({ active: false, windowId: 1, status: "complete", ...t }));

  // журнал вызовов — тесты проверяют по нему факты («detach был вызван»)
  const calls = { debugger: [], executeScript: [], removed: [], updated: [], created: [] };

  // Состояние отладчика: как в Chrome, повторный attach к той же вкладке — ошибка.
  const attached = new Set();
  let lastError;

  /** Вызвать callback в стиле chrome: сначала выставить lastError, потом снять. */
  const cb = (fn, err, ...args) => {
    lastError = err ? { message: err } : undefined;
    try { fn?.(...args); } finally { lastError = undefined; }
  };

  const listeners = { tabsUpdated: new Set(), tabsRemoved: new Set(), alarm: new Set(), message: new Set() };

  const chrome = {
    runtime: {
      get lastError() { return lastError; },
      onMessage: { addListener: (f) => listeners.message.add(f) },
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        },
        set(obj) { Object.assign(store, obj); return Promise.resolve(); },
        _store: store,
      },
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (f) => listeners.alarm.add(f) },
    },
    tabs: {
      async get(id) {
        const t = tabList.find((x) => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      async query(q) {
        let out = tabList;
        if (q && q.active) out = out.filter((t) => t.active);
        return out.map((t) => ({ ...t }));
      },
      async create({ url, active }) {
        const t = { id: Math.max(0, ...tabList.map((x) => x.id)) + 1, url: url || "about:blank", title: "новая", active: active !== false, windowId: 1, status: "complete" };
        tabList.push(t);
        calls.created.push(t);
        return { ...t };
      },
      async remove(id) {
        calls.removed.push(id);
        tabList = tabList.filter((t) => t.id !== id);
        for (const f of listeners.tabsRemoved) f(id);
      },
      async update(id, props) {
        calls.updated.push({ id, ...props });
        const t = tabList.find((x) => x.id === id);
        if (t && props.url) { t.url = props.url; t.status = "complete"; }
        return t ? { ...t } : undefined;
      },
      async captureVisibleTab() { return "data:image/png;base64,TEST"; },
      onUpdated: { addListener: (f) => listeners.tabsUpdated.add(f), removeListener: (f) => listeners.tabsUpdated.delete(f) },
      onRemoved: { addListener: (f) => listeners.tabsRemoved.add(f) },
    },
    scripting: {
      async executeScript(opts) {
        calls.executeScript.push(opts);
        const r = typeof scriptResult === "function" ? scriptResult(opts) : scriptResult;
        return [{ frameId: 0, result: r }];
      },
    },
    debugger: {
      attach({ tabId }, _ver, done) {
        calls.debugger.push({ op: "attach", tabId });
        if (attached.has(tabId)) return cb(done, "Another debugger is already attached to the tab with id: " + tabId);
        attached.add(tabId);
        cb(done);
      },
      detach({ tabId }, done) {
        calls.debugger.push({ op: "detach", tabId });
        if (!attached.has(tabId)) return cb(done, "Debugger is not attached to the tab with id: " + tabId);
        attached.delete(tabId);
        cb(done);
      },
      sendCommand({ tabId }, method, _params, done) {
        calls.debugger.push({ op: "send", tabId, method });
        if (!attached.has(tabId)) return cb(done, "Debugger is not attached to the tab with id: " + tabId);
        // ответы на команды, чьи поля читает ядро
        if (method === "Page.getLayoutMetrics") return cb(done, null, { cssContentSize: { width: 800, height: 2400 } });
        if (method === "Page.captureScreenshot") return cb(done, null, { data: "PNGDATA" });
        if (method === "Network.getResponseBody") return cb(done, null, { body: "тело ответа", base64Encoded: false });
        cb(done, null, {});
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
    },
    // тестовые ручки
    _calls: calls,
    _attached: attached,
    _tabs: () => tabList,
  };
  return chrome;
}

/** Отправить ядру команду «как от сервера» и вернуть его ответ. */
let seq = 0;
export async function cmd(d, ws, method, params = {}) {
  const id = "cmd" + ++seq;
  await ws.recv({ id, kind: "cmd", method, params });
  return ws.reply(id) ?? { ok: false, error: "ядро не ответило" };
}

/** Поднять ядро с моками: настройки применены, соединение открыто. */
export async function boot(createDispatcher, { storage = {}, tabs = [], scriptResult } = {}) {
  const chrome = mockChrome({ tabs, storage: { enabled: true, port: 8765, ...storage }, scriptResult });
  const d = createDispatcher({ chrome, WebSocketImpl: MockWebSocket, userAgent: "test-ua", now: () => 1700000000000 });
  await d.init();
  const ws = MockWebSocket.last;
  ws?.open();
  return { d, ws, chrome };
}
