// Browser API mock for core tests (extension/dispatcher.js).
// Reproduces the traits of chrome.* the core actually depends on, including
// the callback style with chrome.runtime.lastError in chrome.debugger.

/** WebSocket stub: the test opens the connection itself and reads what was sent. */
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
    this.sent = [];       // everything the core sent to the server (already parsed)
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
  /** test: "server accepted the connection" */
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  /** test: "server sent a message" */
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
  /** the core's reply to the command with the given id */
  reply(id) { return this.sent.find((m) => m.id === id && m.kind === "res"); }
}

/**
 * @param {object} opts
 * @param {Array}  [opts.tabs]     initial tabs
 * @param {object} [opts.storage]  initial chrome.storage.local
 * @param {object} [opts.scriptResult] what executeScript returns
 * @param {Function} [opts.cdpHook] (tabId, method, params) — called on every CDP command, e.g. to emit events
 */
export function mockChrome({ tabs = [], storage = {}, scriptResult = { ok: true }, cdpHook } = {}) {
  const store = { ...storage };
  let tabList = tabs.map((t) => ({ active: false, windowId: 1, status: "complete", ...t }));

  // call log — tests check facts against it ("detach was called")
  const calls = { debugger: [], executeScript: [], removed: [], updated: [], created: [] };

  // Debugger state: as in Chrome, a repeated attach to the same tab is an error.
  const attached = new Set();
  let lastError;

  /** Invoke a chrome-style callback: set lastError first, then clear it. */
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
        if (q && q.windowId != null) out = out.filter((t) => t.windowId === q.windowId);
        return out.map((t) => ({ ...t }));
      },
      async create({ url, active }) {
        const t = { id: Math.max(0, ...tabList.map((x) => x.id)) + 1, url: url || "about:blank", title: "new", active: active !== false, windowId: 1, status: "complete" };
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
        if (t && props.active) for (const x of tabList) if (x.windowId === t.windowId) x.active = x === t;
        return t ? { ...t } : undefined;
      },
      async captureVisibleTab() { return "data:image/png;base64,TEST"; },
      onUpdated: { addListener: (f) => listeners.tabsUpdated.add(f), removeListener: (f) => listeners.tabsUpdated.delete(f) },
      onRemoved: { addListener: (f) => listeners.tabsRemoved.add(f) },
    },
    scripting: {
      async executeScript(opts) {
        calls.executeScript.push(opts);
        // A function may return a promise — including one that never settles,
        // which is how a page frozen by a JS dialog is simulated.
        const r = await (typeof scriptResult === "function" ? scriptResult(opts) : scriptResult);
        // The stub may return a ready array of frames [{frameId, result}] —
        // that's how multi-frame scenarios are tested (snapshot with allFrames).
        return Array.isArray(r) ? r : [{ frameId: 0, result: r }];
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
      sendCommand({ tabId }, method, params, done) {
        calls.debugger.push({ op: "send", tabId, method, params });
        cdpHook?.(tabId, method, params);
        if (!attached.has(tabId)) return cb(done, "Debugger is not attached to the tab with id: " + tabId);
        // replies to commands whose fields the core reads
        if (method === "Page.getLayoutMetrics") return cb(done, null, { cssContentSize: { width: 800, height: 2400 } });
        if (method === "Page.captureScreenshot") return cb(done, null, { data: "PNGDATA" });
        if (method === "Network.getResponseBody") return cb(done, null, { body: "response body", base64Encoded: false });
        if (method === "Runtime.evaluate") return cb(done, null, { result: { type: "object", objectId: "obj-1" } });
        cb(done, null, {});
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
    },
    // test handles
    _calls: calls,
    _attached: attached,
    _tabs: () => tabList,
  };
  return chrome;
}

/** Send the core a command "as if from the server" and return its reply. */
let seq = 0;
export async function cmd(d, ws, method, params = {}) {
  const id = "cmd" + ++seq;
  await ws.recv({ id, kind: "cmd", method, params });
  return ws.reply(id) ?? { ok: false, error: "core did not reply" };
}

/** Start the core with mocks: settings applied, connection open. */
export async function boot(createDispatcher, { storage = {}, tabs = [], scriptResult, cdpHook } = {}) {
  const chrome = mockChrome({ tabs, storage: { enabled: true, port: 8765, ...storage }, scriptResult, cdpHook });
  const d = createDispatcher({ chrome, WebSocketImpl: MockWebSocket, userAgent: "test-ua", now: () => 1700000000000 });
  await d.init();
  const ws = MockWebSocket.last;
  ws?.open();
  return { d, ws, chrome };
}
