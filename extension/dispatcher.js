// Dispatch core: MCP-server transport, access gate, command dispatcher, CDP manager.
//
// There are NO references to the global `chrome` or `WebSocket` here — both arrive
// as a facade via createDispatcher(). That lets the core run in Node with mocks
// (tests/dispatcher.mjs), not only in a browser: the real extension cannot be put
// under automated tests — Chrome 137+ ignores --load-extension when the remote
// debugger is enabled (the very protection Dispatch itself shields the user with).
//
// background.js is a thin shell: it passes the real chrome in and registers listeners.

import {
  pageSnapshot, pageGetHtml, pageEval, pageFocus, pageHref,
  pageClick, pageType, pageWaitFor, pageExtract, pageScroll, pageShield,
} from "./page.js";
import { methodAllowed, hostAllowed, urlAllowed, hostOf, parseRef } from "./policy.js";

export const DEFAULT_PORT = 8765;
export const PROTOCOL_VERSION = 1; // must match the server (bridge.ts)
const NET_MAX = 500;      // network request ring buffer size
const CONSOLE_MAX = 500;  // console log ring buffer size
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

// Script injection and capture work only on regular pages, not on internal ones.
const isInjectable = (url) => /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");

/**
 * @param {object} deps
 * @param {object} deps.chrome            facade of the extension API
 * @param {Function} deps.WebSocketImpl   WebSocket constructor
 * @param {string} [deps.userAgent]       browser UA — sent to the server in hello
 * @param {Function} [deps.now]           time source (for tests)
 */
export function createDispatcher({ chrome, WebSocketImpl, userAgent = "", now = () => Date.now() }) {
  const WS = WebSocketImpl;

  // ── transport/control state ────────────────────────────────────────────────
  const state = {
    ws: null,
    connected: false,
    enabled: false,        // master switch
    port: DEFAULT_PORT,
    token: "",             // optional secret; required if the server runs with DISPATCH_TOKEN
    mode: "full",          // "full" | "readonly" — read-only blocks mutating commands
    // There can be SEVERAL granted tabs: the human grants access to pages the agent
    // needs to cross-reference, and the agent reads them by tabId without switching.
    grantedTabs: [],       // ids of granted tabs, in grant order
    grantedTabId: null,    // the "current" one: commands without tabId run on it
    allowlist: [],         // host patterns; empty = any
    log: [],               // ring buffer of recent actions
  };

  // ── CDP session state (capture/emulation) ──────────────────────────────────
  const dbg = {
    tabId: null,           // tab the persistent session is attached to
    attached: false,
    persistent: false,     // enabled via debug_start/emulate
    net: [],               // ring buffer of request records
    netById: new Map(),    // requestId -> record
    console: [],           // ring buffer of console logs
    emulation: [],         // applied overrides (for status)
  };

  function pushLog(line) {
    const ts = new Date(now()).toLocaleTimeString();
    state.log.unshift(`${ts}  ${line}`);
    if (state.log.length > LOG_MAX) state.log.pop();
  }

  async function loadSettings() {
    const s = await chrome.storage.local.get(["enabled", "port", "token", "mode", "allowlist", "grantedTabs", "grantedTabId"]);
    state.enabled = !!s.enabled;
    state.port = s.port || DEFAULT_PORT;
    state.token = s.token || "";
    state.mode = s.mode === "readonly" ? "readonly" : "full";
    state.allowlist = Array.isArray(s.allowlist) ? s.allowlist : [];
    // The old format stored a single grantedTabId — it is also the only tab in the set.
    const ids = Array.isArray(s.grantedTabs) ? s.grantedTabs : (s.grantedTabId != null ? [s.grantedTabId] : []);
    state.grantedTabs = ids.filter((id) => Number.isInteger(id));
    state.grantedTabId = state.grantedTabs.includes(s.grantedTabId) ? s.grantedTabId : (state.grantedTabs.at(-1) ?? null);
  }

  function saveSettings() {
    chrome.storage.local.set({
      enabled: state.enabled,
      port: state.port,
      token: state.token,
      mode: state.mode,
      allowlist: state.allowlist,
      grantedTabs: state.grantedTabs,
      grantedTabId: state.grantedTabId,
    });
  }

  const isGranted = (tabId) => state.grantedTabs.includes(tabId);

  // ── icon badge: color = connection status, "◉" on granted tabs ─────────────
  let badgedTabs = new Set();
  const safe = (p) => { try { if (p && p.catch) p.catch(() => {}); } catch { /* noop */ } };

  function updateBadge() {
    const color = !state.enabled ? "#888888" : (state.connected ? "#2c8a3d" : "#bb3333");
    safe(chrome.action.setBadgeBackgroundColor({ color }));
    safe(chrome.action.setBadgeText({ text: !state.enabled ? "" : (state.connected ? "on" : "off") }));
    // clear the mark from tabs that lost access
    for (const id of badgedTabs) {
      if (!isGranted(id)) safe(chrome.action.setBadgeText({ text: "", tabId: id }));
    }
    badgedTabs = new Set(state.grantedTabs);
    for (const id of state.grantedTabs) {
      // "◉" = current, "○" = other granted tabs
      safe(chrome.action.setBadgeText({ text: id === state.grantedTabId ? "◉" : "○", tabId: id }));
      safe(chrome.action.setBadgeBackgroundColor({ color: "#2c8a3d", tabId: id }));
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
      pushLog(`WS creation error: ${e}`);
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      pushLog("connected to the MCP server");
      send({ kind: "event", event: "hello", data: { name: "Dispatch", protocolVersion: PROTOCOL_VERSION, token: state.token || "", ua: userAgent, ts: now() } });
      updateBadge();
    };
    ws.onclose = () => {
      state.connected = false;
      pushLog("connection to the server closed");
      updateBadge();
      if (state.enabled) scheduleReconnect(1500); // quick retry; the alarm is the fallback
    };
    ws.onerror = () => { /* onclose will follow */ };
    ws.onmessage = (ev) => onMessage(ev.data);
  }

  /** Fully disconnect: close the socket, detach the debugger, cancel reconnect. */
  async function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (state.ws) { try { state.ws.close(); } catch { /* noop */ } }
    state.ws = null;
    state.connected = false;
    if (dbg.attached) await releasePersistent(); // don't leave the debugging banner hanging
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
      if (!handler) throw new Error(`unknown method: ${method}`);
      // Main master-switch gate: while it is off, NO command runs — including
      // status/tabs (a list of tabs with URLs is data too).
      // Duplicated in requireGranted as a safety net.
      if (!state.enabled) {
        throw new Error("Dispatch is off — turn on the “Master switch” in the Dispatch popup.");
      }
      if (!methodAllowed(method, state.mode)) {
        throw new Error(`Read-only mode: command "${method}" is blocked. Switch the mode to “Full” in the Dispatch popup.`);
      }
      const result = await handler(params || {});
      send({ id, kind: "res", ok: true, result });
      pushLog(`✓ ${method}`);
    } catch (e) {
      send({ id, kind: "res", ok: false, error: e && e.message ? e.message : String(e) });
      pushLog(`✗ ${method}: ${e && e.message ? e.message : e}`);
    }
  }

  // ── security checks ────────────────────────────────────────────────────────
  function requireGranted() {
    if (!state.enabled) throw new Error("Dispatch is off — turn on the “Master switch” in the Dispatch popup.");
    if (state.grantedTabId == null) throw new Error("No tab has access — open the Dispatch popup and click “Grant access to this tab”.");
  }

  /**
   * The tab the command will run on. Without tabId — the current one; with tabId —
   * the given one, but ONLY if it is in the set of granted tabs: access to others
   * is still granted by the human in the popup or by the agent via select_tab.
   * In both cases the tab is checked against the allowlist right now.
   */
  async function grantedTab(tabId) {
    requireGranted();
    const id = tabId ?? state.grantedTabId;
    if (!isGranted(id)) {
      throw new Error(`Tab #${id} has no access. Granted tabs: ${state.grantedTabs.map((x) => "#" + x).join(", ") || "none"} — grant access in the Dispatch popup or via browser_select_tab.`);
    }
    let tab;
    try {
      tab = await chrome.tabs.get(id);
    } catch {
      forgetTab(id);
      throw new Error(`Granted tab #${id} was closed — grant access again.`);
    }
    if (state.allowlist.length) {
      const host = hostOf(tab.url); // null for about:, chrome: and other unparseable URLs
      if (host === null || !hostAllowed(host, state.allowlist)) {
        throw new Error(`Host "${host ?? tab.url ?? "?"}" is not in the allowlist. Allow it in the Dispatch popup or clear the list.`);
      }
    }
    return tab;
  }

  // ── on-page badge: shows which tab is under control ────────────────────────
  // The icon badge is only visible next to the icon; the on-page badge shows it
  // right on the page, so an agent-controlled tab can't be mistaken for another.
  async function paintShield(tabId, mode) {
    if (tabId == null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isInjectable(tab.url)) return; // scripts are forbidden on internal pages
      await chrome.scripting.executeScript({
        target: { tabId }, world: "ISOLATED", func: pageShield, args: [mode],
      });
    } catch { /* tab closed or unavailable — the badge is not critical */ }
  }
  const showShield = (tabId) => paintShield(tabId, state.mode);
  const hideShield = (tabId) => paintShield(tabId, null);

  /**
   * Grant a tab access and make it current. Other tabs in the set do NOT lose
   * access. The debug session is bound to the current tab: if it was on another
   * one, it is closed (capture buffers belong to one page and must not be mixed).
   */
  async function grantAccess(tab) {
    if (dbg.attached && dbg.tabId !== tab.id) await releasePersistent();
    if (!isGranted(tab.id)) state.grantedTabs.push(tab.id);
    state.grantedTabId = tab.id;
    saveSettings();
    updateBadge();
    await showShield(tab.id);
  }

  /** Remove a tab from the set (in memory); the most recently granted one becomes current. */
  function forgetTab(tabId) {
    state.grantedTabs = state.grantedTabs.filter((id) => id !== tabId);
    if (state.grantedTabId === tabId) state.grantedTabId = state.grantedTabs.at(-1) ?? null;
    saveSettings();
    updateBadge();
  }

  /** Revoke access from one tab: stop capture if it runs there, and remove the badge. */
  async function revokeTab(tabId) {
    if (!isGranted(tabId)) return;
    if (dbg.attached && dbg.tabId === tabId) await releasePersistent();
    forgetTab(tabId);
    await hideShield(tabId);
  }

  /** Granted tabs with live title/url — for the popup and status. */
  async function grantedTabsInfo() {
    const out = [];
    for (const id of state.grantedTabs) {
      try {
        const t = await chrome.tabs.get(id);
        out.push({ id, title: t.title || "", url: t.url || "", current: id === state.grantedTabId });
      } catch { /* closed — onTabRemoved will clean up */ }
    }
    return out;
  }

  const forEachGranted = (fn) => Promise.all(state.grantedTabs.map(fn));

  function requireInjectable(tab) {
    if (!isInjectable(tab.url)) {
      throw new Error(`Internal page (${tab.url || "?"}) — Chrome forbids scripts and capture here. Grant access to a regular site (http/https).`);
    }
  }

  /**
   * The allowlist is checked against the tab's TOP frame URL, but an action on a
   * ref like "3:e12" goes into a nested frame — which may be a foreign host (ads,
   * an embedded widget, anyone's iframe). So before acting in a frame we ask
   * for its own location and check it separately.
   */
  async function requireFrameAllowed(tabId, frameId) {
    if (!state.allowlist.length) return;
    let url = null;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, world: "ISOLATED", func: pageHref,
      });
      url = r && r[0] && r[0].result ? r[0].result.url : null;
    } catch {
      throw new Error(`Frame #${frameId} is unavailable — take a fresh browser_snapshot.`);
    }
    if (!urlAllowed(url, state.allowlist)) {
      throw new Error(`Frame #${frameId} ("${hostOf(url) ?? url ?? "?"}") is not in the allowlist. Allow its host in the Dispatch popup or clear the list.`);
    }
  }

  // ── in-page execution (chrome.scripting) ───────────────────────────────────
  async function runInPage(func, args = [], world = "ISOLATED", frameId = 0, tabId = undefined) {
    const tab = await grantedTab(tabId);
    requireInjectable(tab);
    if (frameId) await requireFrameAllowed(tab.id, frameId);
    const target = frameId ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id };
    const res = await chrome.scripting.executeScript({ target, world, func, args });
    const r = res && res[0] ? res[0].result : undefined;
    if (r && r.ok === false) throw new Error(r.error || "in-page execution error");
    return r;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CDP manager: the single access point to chrome.debugger.
  // ══════════════════════════════════════════════════════════════════════════

  function dbgAttach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const e = chrome.runtime.lastError;
        if (e) {
          const m = e.message || "";
          reject(new Error(/already attached/i.test(m)
            ? `Another debugger is already attached to the tab (close DevTools on it). ${m}`
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

  // All operations touching attach/detach go through ONE queue. Otherwise two
  // concurrent calls on the same tab fight: the second attach fails with
  // "already attached", and the first one's detach kills the second's session midway.
  let cdpQueue = Promise.resolve();
  function cdpSerial(fn) {
    const run = cdpQueue.then(fn, fn); // a failed previous operation doesn't break the queue
    cdpQueue = run.then(() => {}, () => {});
    return run;
  }

  /** One-off CDP operation: reuses the active session or spins up a temporary one. */
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

  // raw* — "raw" versions without the queue: safe to call from INSIDE cdpSerial.
  // The public wrappers below serialize outside calls (otherwise — self-deadlock).

  /** Ensure a persistent debug session on the tab (for capture/emulation). */
  async function rawEnsurePersistent(tabId) {
    if (dbg.persistent && dbg.attached && dbg.tabId === tabId) return;
    if (dbg.attached) await rawReleasePersistent();
    await dbgAttach(tabId);
    dbg.tabId = tabId;
    dbg.attached = true;
    dbg.persistent = true;
    await enableDomains(tabId);
    pushLog(`debug session opened on tab #${tabId}`);
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
    if (!dbg.persistent) throw new Error("Capture is not enabled — call browser_debug_start first.");
  }

  /**
   * Gate for READING capture buffers. The session being on is not enough: it must
   * run on a granted tab, and that tab must pass the allowlist right now.
   * Without this the allowlist could be bypassed both ways: buffers fill on their
   * own, outside commands, so a single check at debug_start time is not enough.
   */
  async function requireDebugAccess() {
    const tab = await grantedTab();
    requirePersistent();
    if (dbg.tabId !== tab.id) {
      throw new Error(`Capture is running on tab #${dbg.tabId}, but access is granted to #${tab.id} — call browser_debug_start again.`);
    }
    return tab;
  }

  /**
   * A granted tab navigated to a host outside the allowlist — stop capture and
   * clear the buffers. Commands are checked before they run, but CDP records
   * network and console on its own: without this, simply steering the tab to a
   * foreign site would let its traffic land in the buffer.
   */
  async function dropCaptureOutsideAllowlist(tabId) {
    if (!state.allowlist.length) return;
    if (!dbg.persistent || dbg.tabId !== tabId) return;
    let url = null;
    try { url = (await chrome.tabs.get(tabId)).url; } catch { return; }
    if (urlAllowed(url, state.allowlist)) return;
    await releasePersistent();
    pushLog(`capture stopped: tab navigated to "${hostOf(url) ?? url ?? "?"}" outside the allowlist`);
  }

  // ── CDP event handling ─────────────────────────────────────────────────────
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
    try { dispatchCdpEvent(method, params); } catch { /* protect the buffer */ }
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
          text: (d.exception && d.exception.description) || d.text || "uncaught exception",
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
      pushLog(`debug session detached (${reason})`);
    }
  }

  // ── screenshots ────────────────────────────────────────────────────────────
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

  // ── emulation ──────────────────────────────────────────────────────────────
  async function emulate(params) {
    const tab = await grantedTab();
    if (params.reset) {
      await releasePersistent();
      return { ok: true, reset: true, note: "All overrides cleared, debug session closed." };
    }
    await ensurePersistent(tab.id);
    const applied = [];
    if (params.device) {
      const d = DEVICES[params.device];
      if (!d) throw new Error(`Unknown device "${params.device}". Available: ${Object.keys(DEVICES).join(", ")}`);
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
    return { ok: true, applied, note: "Emulation stays active while the debug session runs (Chrome shows its debugging banner)." };
  }

  // ── precise input (CDP Input) ──────────────────────────────────────────────
  async function pressKey(params) {
    const tab = await grantedTab();
    const key = params.key;
    if (!key) throw new Error("no key specified (key)");
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

  // ── navigation: wait for complete ──────────────────────────────────────────
  function waitComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
      const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
      const timer = setTimeout(done, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      // If already complete — finish right away.
      chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
    });
  }

  // ── command handlers ───────────────────────────────────────────────────────
  const handlers = {
    async status() {
      const granted = await grantedTabsInfo();
      const current = granted.find((t) => t.current);
      return {
        connected: state.connected,
        enabled: state.enabled,
        mode: state.mode,
        grantedTabId: state.grantedTabId,
        grantedTitle: current ? current.title : "",
        grantedTabs: granted,
        allowlist: state.allowlist,
        debug: { active: dbg.persistent, tabId: dbg.tabId, net: dbg.net.length, console: dbg.console.length, emulation: dbg.emulation },
      };
    },

    async tabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, title: t.title, url: t.url, active: t.active,
        granted: isGranted(t.id),            // can be read/acted on by tabId
        current: t.id === state.grantedTabId, // commands without tabId run on it
      }));
    },

    async select_tab({ tabId }) {
      const tab = await chrome.tabs.get(tabId);
      // The agent switches access itself, so the allowlist is the only boundary:
      // switching to a tab outside the list is not allowed.
      if (!urlAllowed(tab.url, state.allowlist)) {
        throw new Error(`Access to "${tab.url || "?"}" denied: host is not in the allowlist. Allow it in the Dispatch popup or clear the list.`);
      }
      await grantAccess(tab);
      return { grantedTabId: tab.id, title: tab.title, url: tab.url, grantedTabs: state.grantedTabs };
    },

    async open_tab({ url, active, grant }) {
      // Check an empty url too: without one, about:blank opens, which has no host —
      // with a non-empty allowlist such a tab must not be created.
      if (!urlAllowed(url || "", state.allowlist)) {
        throw new Error(`Opening "${url || "a blank tab"}" denied: host is not in the allowlist. Allow it in the Dispatch popup or clear the list.`);
      }
      const tab = await chrome.tabs.create({ url: url || undefined, active: active !== false });
      // Grant access to the new tab by default — the agent opened it explicitly.
      if (grant !== false) await grantAccess(tab);
      await waitComplete(tab.id, 30000).catch(() => {});
      const t = await chrome.tabs.get(tab.id);
      return { tabId: t.id, url: t.url, title: t.title, granted: isGranted(t.id) };
    },

    // Only a GRANTED tab can be closed: otherwise the agent could close any browser
    // tab by someone else's id. To close another one — select_tab first.
    async close_tab({ tabId }) {
      let tab;
      try {
        tab = await grantedTab(tabId);
      } catch (e) {
        if (tabId != null && !isGranted(tabId)) {
          throw new Error(`Only a granted tab can be closed (${state.grantedTabs.map((x) => "#" + x).join(", ") || "none"}), not #${tabId}. Grant access via browser_select_tab first.`);
        }
        throw e;
      }
      await chrome.tabs.remove(tab.id);
      forgetTab(tab.id); // don't wait for onTabRemoved: the next command must already see the new set
      return { closed: tab.id, grantedTabs: state.grantedTabs, grantedTabId: state.grantedTabId };
    },

    async navigate({ url, tabId }) {
      const tab = await grantedTab(tabId);
      if (!urlAllowed(url, state.allowlist)) {
        throw new Error(`Navigation to "${url}" denied: host is not in the allowlist. Allow it in the Dispatch popup or clear the list.`);
      }
      await chrome.tabs.update(tab.id, { url });
      await waitComplete(tab.id, 30000);
      const t = await chrome.tabs.get(tab.id);
      return { url: t.url, title: t.title };
    },

    async snapshot({ tabId } = {}) {
      const tab = await grantedTab(tabId);
      requireInjectable(tab);
      // allFrames: snapshot from ALL injectable frames; ref = "<frameId>:<localRef>".
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, world: "ISOLATED", func: pageSnapshot,
      });
      const elements = [];
      let url = tab.url, title = tab.title || "";
      let skippedFrames = 0;
      for (const r of results) {
        const v = r.result;
        if (!v || !v.ok) continue;
        if (r.frameId === 0) {
          url = v.url; title = v.title; // the top frame is already checked by grantedTab()
        } else if (!urlAllowed(v.url, state.allowlist)) {
          skippedFrames++; // nested frame on a foreign host — its content is withheld
          continue;
        }
        for (const el of v.elements) elements.push({ ...el, ref: `${r.frameId}:${el.ref}`, frameId: r.frameId });
      }
      return { ok: true, tabId: tab.id, url, title, count: elements.length, frames: results.length, skippedFrames, elements };
    },

    async get_html({ selector, tabId }) {
      return runInPage(pageGetHtml, [selector || null], "ISOLATED", 0, tabId);
    },

    async eval({ expression, tabId }) {
      return runInPage(pageEval, [expression], "MAIN", 0, tabId);
    },

    async click({ ref, selector, tabId }) {
      const { frameId, localRef } = parseRef(ref);
      return runInPage(pageClick, [localRef, selector || null], "ISOLATED", frameId, tabId);
    },

    async type({ ref, selector, text, submit, tabId }) {
      const { frameId, localRef } = parseRef(ref);
      return runInPage(pageType, [localRef, selector || null, text, !!submit], "ISOLATED", frameId, tabId);
    },

    async wait_for({ selector, timeoutMs, tabId }) {
      return runInPage(pageWaitFor, [selector || null, timeoutMs || 10000], "ISOLATED", 0, tabId);
    },

    async extract({ container, fields, multiple, tabId }) {
      return runInPage(pageExtract, [container || null, fields || {}, !!multiple], "ISOLATED", 0, tabId);
    },

    async scroll({ selector, dx, dy, toBottom, tabId }) {
      return runInPage(pageScroll, [selector || null, dx || 0, dy || 0, !!toBottom], "ISOLATED", 0, tabId);
    },

    async press_key(params) {
      return pressKey(params);
    },

    async screenshot({ fullPage, tabId }) {
      const tab = await grantedTab(tabId);
      requireInjectable(tab);
      if (fullPage) return fullPageShot(tab.id);
      // Visible area: for the active tab — the fast path, no banner.
      if (tab.active) {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { data: dataUrl.split(",")[1], format: "png", fullPage: false };
      }
      // Inactive tab: captureVisibleTab would capture the wrong one — go through CDP.
      return withTempCdp(tab.id, async () => {
        const s = await dbgSend(tab.id, "Page.captureScreenshot", { format: "png" });
        return { data: s.data, format: "png", fullPage: false };
      });
    },

    // ── debugging: network/console capture ──
    async debug_start() {
      const tab = await grantedTab();
      await ensurePersistent(tab.id);
      return { ok: true, attached: true, tabId: tab.id, note: "Console/network capture enabled. Chrome's debugging banner stays visible until browser_debug_stop." };
    },

    async debug_stop() {
      const captured = { network: dbg.net.length, console: dbg.console.length };
      await releasePersistent();
      return { ok: true, detached: true, captured };
    },

    async console_logs({ level, clear }) {
      await requireDebugAccess();
      let items = dbg.console;
      if (level) items = items.filter((e) => String(e.level).toLowerCase() === String(level).toLowerCase());
      const logs = items.slice(-200);
      if (clear) dbg.console = [];
      return { ok: true, count: logs.length, logs };
    },

    async network({ filter, clear }) {
      await requireDebugAccess();
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
      await requireDebugAccess();
      if (!requestId) throw new Error("no requestId specified (take one from browser_network)");
      const r = await dbgSend(dbg.tabId, "Network.getResponseBody", { requestId });
      const body = r.body || "";
      const LIMIT = 200000;
      return { ok: true, base64Encoded: !!r.base64Encoded, truncated: body.length > LIMIT, body: body.slice(0, LIMIT) };
    },

    async emulate(params) {
      return emulate(params);
    },
  };

  // ── popup messages ─────────────────────────────────────────────────────────
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
          grantedTabs: await grantedTabsInfo(),
          allowlist: state.allowlist,
          log: state.log,
          debug: { active: dbg.persistent, tabId: dbg.tabId, net: dbg.net.length, console: dbg.console.length },
        };
      case "setEnabled":
        state.enabled = !!msg.value;
        saveSettings();
        if (state.enabled) { connect(); await forEachGranted(showShield); }
        else { await disconnect(); await forEachGranted(hideShield); } // off = no connection and no badge
        pushLog(state.enabled ? "enabled" : "disabled");
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
        pushLog(`mode: ${state.mode}`);
        if (state.enabled) await forEachGranted(showShield); // redraw for the new mode
        return { ok: true };
      case "grantActive": {
        // Adds the active tab to the set (and makes it current); previously granted
        // tabs keep their access — that's how a set for cross-analysis is built.
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) return { ok: false, error: "no active tab" };
        await grantAccess(tab);
        pushLog(`access granted: ${tab.title}`);
        return { ok: true, grantedTabId: tab.id, grantedTitle: tab.title, grantedTabs: state.grantedTabs };
      }
      case "setCurrent": {
        // Switch the current tab among already granted ones — without granting new ones.
        const id = Number(msg.tabId);
        if (!isGranted(id)) return { ok: false, error: `tab #${id} has no access` };
        let tab;
        try { tab = await chrome.tabs.get(id); } catch { forgetTab(id); return { ok: false, error: "tab is closed" }; }
        await grantAccess(tab);
        return { ok: true, grantedTabId: id };
      }
      case "revokeAccess": {
        // With tabId — revoke from one tab; without — from all at once.
        if (msg.tabId != null) {
          await revokeTab(Number(msg.tabId));
          pushLog(`access revoked from #${msg.tabId}`);
          return { ok: true, grantedTabs: state.grantedTabs };
        }
        if (dbg.attached) await releasePersistent();
        const were = state.grantedTabs.slice();
        state.grantedTabs = [];
        state.grantedTabId = null;
        saveSettings();
        pushLog("access revoked from all tabs");
        updateBadge();
        await Promise.all(were.map(hideShield));
        return { ok: true, grantedTabs: [] };
      }
      case "stopDebug":
        await releasePersistent();
        pushLog("capture stopped from the popup");
        return { ok: true };
      case "setAllowlist":
        state.allowlist = String(msg.value || "")
          .split("\n").map((s) => s.trim()).filter(Boolean);
        saveSettings();
        // The new list may forbid exactly what is being captured right now.
        if (dbg.persistent && dbg.tabId != null) await dropCaptureOutsideAllowlist(dbg.tabId);
        return { ok: true, allowlist: state.allowlist };
      case "reconnect":
        if (state.ws) try { state.ws.close(); } catch { /* noop */ }
        connect();
        return { ok: true };
      default:
        return { ok: false, error: "unknown popup message" };
    }
  }

  // ── reacting to closed tabs ────────────────────────────────────────────────
  function onTabRemoved(tabId) {
    if (tabId === dbg.tabId) { dbg.attached = false; dbg.persistent = false; dbg.tabId = null; }
    if (isGranted(tabId)) {
      forgetTab(tabId);
      pushLog(`granted tab #${tabId} closed`);
    }
    updateBadge();
  }

  /**
   * Navigation wipes the badge along with the old document — redraw it.
   * This is also the only moment a granted tab can leave the allowlist:
   * then capture must be stopped immediately, without waiting for a command.
   */
  async function onTabUpdated(tabId, info) {
    try {
      if (!isGranted(tabId)) return;
      if (info.url || info.status === "complete") await dropCaptureOutsideAllowlist(tabId);
      if (!state.enabled) return;
      if (info.status !== "complete") return;
      await showShield(tabId);
    } catch { /* browser listener: nothing above to throw to */ }
  }

  /** Fallback: the alarm restores the connection if the service worker was unloaded. */
  function onKeepalive() {
    if (state.enabled && !state.connected) connect();
  }

  async function init() {
    await loadSettings();
    updateBadge();
    if (state.enabled) { connect(); forEachGranted(showShield); }
    pushLog("service worker started");
  }

  return {
    state, dbg, handlers,
    init, connect, disconnect, onMessage, handlePopup,
    handleCdpEvent, onCdpDetach, onTabRemoved, onTabUpdated, onKeepalive,
  };
}
