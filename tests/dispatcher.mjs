// Core test (extension/dispatcher.js) on chrome.* mocks — no browser.
// Covers what used to be checked only by hand: the master-switch gate,
// close_tab/select_tab boundaries, allowlist on live tabs, and the CDP queue.
import { createDispatcher } from "../extension/dispatcher.js";
import { boot, cmd, mockChrome, MockWebSocket } from "./mock-chrome.mjs";
import { checker, wait } from "./lib.mjs";

const TABS = [
  { id: 1, url: "https://example.com/a", title: "Own site", active: true },
  { id: 2, url: "https://evil.com/x", title: "Foreign site" },
  { id: 3, url: "http://localhost:3000/app", title: "Local dev" },
];

const t = checker("\n▶ dispatcher: core on chrome mocks");

// ── 1. Master-switch gate ────────────────────────────────────────────────────
{
  const { d, chrome } = await boot(createDispatcher, { storage: { enabled: false }, tabs: TABS });
  t.check("switch off → no connection is opened", d.state.connected === false && d.state.ws === null);

  // Worst case: the socket is open anyway (switch turned off while connected).
  // Commands must still not run — the gate lives in the core itself.
  const sock = new MockWebSocket("ws://127.0.0.1:8765");
  sock.readyState = MockWebSocket.OPEN;
  d.state.ws = sock;
  const ask = async (method) => {
    const id = "gate-" + method;
    await d.onMessage(JSON.stringify({ id, kind: "cmd", method, params: {} }));
    return sock.reply(id) ?? { ok: null, error: "core did not reply" };
  };

  const r1 = await ask("tabs");
  t.check("switch off → tabs rejected (tab list does not leak)",
    r1.ok === false && /master switch/i.test(r1.error), r1);
  const r2 = await ask("status");
  t.check("switch off → even status rejected", r2.ok === false && /master switch/i.test(r2.error), r2);
  t.check("switch off → nothing reached the page", chrome._calls.executeScript.length === 0);
}

// ── 2. Turning the switch off drops the connection and detaches debugging ────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  t.check("switch on → connection open", d.state.connected === true);
  await cmd(d, ws, "debug_start");
  t.check("debug_start opened a CDP session", d.dbg.persistent === true && chrome._attached.has(1));

  await d.handlePopup({ type: "setEnabled", value: false });
  t.check("switching off closed the socket", ws.closed === true);
  t.check("switching off reset connected", d.state.connected === false);
  t.check("switching off closed the debug session (no lingering banner)",
    d.dbg.persistent === false && !chrome._attached.has(1));
  t.check("detach actually reached chrome.debugger",
    chrome._calls.debugger.some((c) => c.op === "detach" && c.tabId === 1));
}

// ── 3. close_tab — granted tab only ──────────────────────────────────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  const r = await cmd(d, ws, "close_tab", { tabId: 2 });
  t.check("close_tab with a foreign id rejected", r.ok === false && /only a granted tab/i.test(r.error), r);
  t.check("foreign tab NOT closed", !chrome._calls.removed.includes(2));

  const ok = await cmd(d, ws, "close_tab", { tabId: 1 });
  t.check("close_tab with own id closes", ok.ok === true && chrome._calls.removed.includes(1));

  const { d: d2, ws: ws2, chrome: c2 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  const noId = await cmd(d2, ws2, "close_tab", {});
  t.check("close_tab without id closes the granted tab", noId.ok === true && c2._calls.removed.includes(1));
}

// ── 4. select_tab respects the allowlist ─────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 } });
  const bad = await cmd(d, ws, "select_tab", { tabId: 2 });
  t.check("select_tab to a tab outside the allowlist rejected", bad.ok === false && /allowlist/i.test(bad.error), bad);
  t.check("access did not move to the foreign tab", d.state.grantedTabId === 1);

  const good = await cmd(d, ws, "select_tab", { tabId: 1 });
  t.check("select_tab inside the allowlist works", good.ok === true && d.state.grantedTabId === 1);

  const { d: d2, ws: ws2 } = await boot(createDispatcher, { tabs: TABS, storage: { allowlist: [] } });
  const any = await cmd(d2, ws2, "select_tab", { tabId: 2 });
  t.check("empty allowlist → select_tab goes anywhere", any.ok === true && d2.state.grantedTabId === 2);
}

// ── 5. allowlist by host with port (regression: host vs hostname) ────────────
{
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["localhost"], grantedTabId: 3 }, scriptResult: { ok: true, html: "<b>test</b>" },
  });
  const r = await cmd(d, ws, "get_html", {});
  t.check("allowlist \"localhost\" allows localhost:3000", r.ok === true, r);

  const nav = await cmd(d, ws, "navigate", { url: "http://localhost:3000/other" });
  t.check("navigate to localhost:3000 with allowlist \"localhost\" allowed", nav.ok === true, nav);

  const out = await cmd(d, ws, "navigate", { url: "https://evil.com/" });
  t.check("navigate outside the allowlist rejected", out.ok === false && /allowlist/i.test(out.error), out);
}

// ── 6. Read-only mode ────────────────────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { mode: "readonly", grantedTabId: 1 }, scriptResult: { ok: true, elements: [], url: "https://example.com/a", title: "Own site" },
  });
  const click = await cmd(d, ws, "click", { selector: "button" });
  t.check("readonly blocks click", click.ok === false && /read-only/i.test(click.error), click);
  const snap = await cmd(d, ws, "snapshot");
  t.check("readonly allows snapshot", snap.ok === true, snap);
  const nav = await cmd(d, ws, "navigate", { url: "https://example.com/b" });
  t.check("readonly blocks navigate", nav.ok === false && /read-only/i.test(nav.error));
}

// ── 7. CDP queue: concurrent operations don't fight over attach ──────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  // Two one-off CDP calls start simultaneously on the SAME tab.
  // Without the queue the second attach would fail with "already attached", or the
  // first one's detach would kill the second's session.
  const [a, b] = await Promise.all([
    cmd(d, ws, "screenshot", { fullPage: true }),
    cmd(d, ws, "press_key", { key: "Enter" }),
  ]);
  t.check("concurrent CDP operations: both succeed", a.ok === true && b.ok === true, { a: a.error, b: b.error });

  const ops = chrome._calls.debugger.filter((c) => c.op === "attach" || c.op === "detach").map((c) => c.op);
  let depth = 0, overlap = false;
  for (const op of ops) { depth += op === "attach" ? 1 : -1; if (depth > 1 || depth < 0) overlap = true; }
  t.check("attach/detach strictly paired, no overlap", !overlap && depth === 0, ops.join(","));
  t.check("after one-off operations the session is closed (banner gone)", !chrome._attached.has(1) && !d.dbg.attached);
}

// ── 8. CDP queue: a one-off operation doesn't break the persistent session ───
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  const shot = await cmd(d, ws, "screenshot", { fullPage: true });
  t.check("screenshot during an active debug session succeeds", shot.ok === true, shot);
  t.check("persistent session SURVIVED the one-off operation",
    d.dbg.persistent === true && chrome._attached.has(1));

  const logs = await cmd(d, ws, "console_logs", {});
  t.check("console capture keeps working", logs.ok === true, logs);
}

// ── 9. Capture buffers and CDP events ────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  d.handleCdpEvent({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }] });
  d.handleCdpEvent({ tabId: 1 }, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.com/api", method: "GET" }, type: "XHR" });
  d.handleCdpEvent({ tabId: 999 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "foreign tab" }] });

  const logs = await cmd(d, ws, "console_logs", {});
  t.check("console captured", logs.result.count === 1 && logs.result.logs[0].text === "boom", logs.result);
  t.check("events from a foreign tab are ignored", logs.result.count === 1);
  const net = await cmd(d, ws, "network", {});
  t.check("network captured", net.result.count === 1 && net.result.requests[0].url.includes("/api"), net.result);
  const filtered = await cmd(d, ws, "network", { filter: "no-such-thing" });
  t.check("network filter works", filtered.result.count === 0);
}

// ── 10. Closing the granted tab resets state ─────────────────────────────────
{
  const { d, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await chrome.tabs.remove(1); // the mock calls onRemoved listeners itself
  d.onTabRemoved(1);
  t.check("closed tab loses access", d.state.grantedTabId === null);
}

// ── 11. Reconnect after a drop ───────────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS });
  const before = MockWebSocket.created;
  ws.close(); // server went down
  t.check("after the drop connected is reset", d.state.connected === false);
  await wait(1800); // the core reconnects after ~1.5s
  t.check("core reconnected on its own", MockWebSocket.created > before);
  await d.handlePopup({ type: "setEnabled", value: false }); // don't leave a timer behind
}

// ── 12. Badge on the granted tab ─────────────────────────────────────────────
{
  const shields = (chrome) => chrome._calls.executeScript.filter((c) => c.func?.name === "pageShield");
  const lastMode = (chrome) => shields(chrome).at(-1)?.args?.[0];

  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS });
  await cmd(d, ws, "select_tab", { tabId: 1 });
  t.check("granting access draws the badge on the tab", shields(chrome).at(-1)?.target?.tabId === 1);
  t.check("badge knows the mode (full access)", lastMode(chrome) === "full");

  // a second tab gets access: the first keeps it, its badge is not removed
  const before = shields(chrome).length;
  await cmd(d, ws, "select_tab", { tabId: 2 });
  const moves = shields(chrome).slice(before);
  t.check("badge NOT removed from the old tab — it still has access", !moves.some((c) => c.target.tabId === 1 && c.args[0] === null));
  t.check("badge drawn on the new tab", moves.some((c) => c.target.tabId === 2 && c.args[0] === "full"));

  await d.handlePopup({ type: "setMode", value: "readonly" });
  const repainted = shields(chrome).filter((c) => c.args[0] === "readonly").map((c) => c.target.tabId);
  t.check("mode change redraws the badge on ALL granted tabs",
    repainted.includes(1) && repainted.includes(2), repainted);

  await d.handlePopup({ type: "revokeAccess" });
  const hidden = shields(chrome).filter((c) => c.args[0] === null).map((c) => c.target.tabId);
  t.check("revoking access removes the badge from all tabs", hidden.includes(1) && hidden.includes(2), hidden);
}

// ── 13. Badge follows the switch state and navigation ────────────────────────
{
  const shields = (chrome) => chrome._calls.executeScript.filter((c) => c.func?.name === "pageShield");
  const { d, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });

  await d.handlePopup({ type: "setEnabled", value: false });
  t.check("switch off removes the badge (agent inactive — no badge)",
    shields(chrome).at(-1)?.args?.[0] === null);

  await d.handlePopup({ type: "setEnabled", value: true });
  t.check("switch on brings the badge back", shields(chrome).at(-1)?.args?.[0] === "full");

  const before = shields(chrome).length;
  d.onTabUpdated(1, { status: "complete" }); // navigation wiped the badge along with the document
  await wait(10);
  t.check("badge is redrawn after navigation", shields(chrome).length > before);

  const n = shields(chrome).length;
  d.onTabUpdated(2, { status: "complete" });   // foreign tab
  d.onTabUpdated(1, { status: "loading" });    // not finished loading yet
  await wait(10);
  t.check("foreign tab and unfinished page leave the badge alone", shields(chrome).length === n);
  await d.handlePopup({ type: "setEnabled", value: false });
}

// ── 14. Badge doesn't get in the agent's way ─────────────────────────────────
{
  // The badge must not end up in the snapshot: it's non-interactive and lives in Shadow DOM.
  const { pageShield, pageSnapshot } = await import("../extension/page.js");
  t.check("pageShield(null) — removal doesn't crash on an empty page",
    typeof pageShield === "function" && typeof pageSnapshot === "function");
  const src = pageShield.toString();
  t.check("badge ignores the mouse (pointer-events:none)", /pointer-events:\s*none/.test(src));
  t.check("badge isolated in Shadow DOM", /attachShadow/.test(src));
  t.check("badge on top of everything (z-index)", /z-index:\s*2147483647/.test(src));
}

// ── 15. Capture buffers are gated by the allowlist ───────────────────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
  });
  await cmd(d, ws, "debug_start");
  d.handleCdpEvent({ tabId: 1 }, "Network.requestWillBeSent",
    { requestId: "r1", request: { url: "https://example.com/api", method: "GET" }, type: "XHR" });

  const inside = await cmd(d, ws, "network", {});
  t.check("network readable within the allowlist", inside.ok === true && inside.result.count === 1, inside);

  // The human steers the granted tab to a host outside the list: commands are checked,
  // but capture records on its own — it must be stopped immediately.
  chrome._tabs().find((x) => x.id === 1).url = "https://bank.example/account";
  await d.onTabUpdated(1, { status: "complete", url: "https://bank.example/account" });
  t.check("tab leaving the allowlist stopped capture",
    d.dbg.persistent === false && !chrome._attached.has(1));

  const net = await cmd(d, ws, "network", {});
  t.check("network not readable outside the allowlist", net.ok === false && /allowlist/i.test(net.error), net);
  const logs = await cmd(d, ws, "console_logs", {});
  t.check("console not readable outside the allowlist", logs.ok === false && /allowlist/i.test(logs.error), logs);
  const body = await cmd(d, ws, "network_body", { requestId: "r1" });
  t.check("response body not readable outside the allowlist", body.ok === false && /allowlist/i.test(body.error), body);

  // Back on an allowed host — nothing foreign accumulated may remain.
  chrome._tabs().find((x) => x.id === 1).url = "https://example.com/back";
  const back = await cmd(d, ws, "network", {});
  t.check("buffer cleared along with the session, not just closed",
    back.ok === false && /capture is not enabled/i.test(back.error), back);
}

// ── 15b. Tightening the allowlist from the popup stops running capture ───────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  t.check("capture runs with an empty allowlist", d.dbg.persistent === true);

  await d.handlePopup({ type: "setAllowlist", value: "only-this.example" });
  t.check("a new allowlist forbidding the current tab stopped capture",
    d.dbg.persistent === false && !chrome._attached.has(1));
}

// ── 16. Capture only on the granted tab ──────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  d.state.grantedTabId = 3; // access moved bypassing grantAccess (e.g. restored from storage)
  const r = await cmd(d, ws, "network", {});
  t.check("reading buffers of a foreign tab rejected", r.ok === false && /another|again|#/i.test(r.error), r);
}

// ── 17. Cross-origin iframe stays out of the snapshot ────────────────────────
{
  const FRAMES = [
    { frameId: 0, result: { ok: true, url: "https://example.com/a", title: "Own site", count: 1,
      elements: [{ ref: "e1", role: "button", tag: "button", name: "own button" }] } },
    { frameId: 3, result: { ok: true, url: "https://ads.evil.com/widget", title: "Ad", count: 1,
      elements: [{ ref: "e1", role: "button", tag: "button", name: "foreign button" }] } },
  ];
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: (opts) => (opts.target.allFrames ? FRAMES : { ok: true }),
  });
  const snap = await cmd(d, ws, "snapshot");
  const names = (snap.result?.elements || []).map((e) => e.name);
  t.check("own frame is in the snapshot", names.includes("own button"), names);
  t.check("frame outside the allowlist dropped", !names.includes("foreign button") && snap.result.skippedFrames === 1, snap.result);

  // Without an allowlist there's nothing to restrict — both frames are present.
  const { d: d2, ws: ws2 } = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabId: 1 },
    scriptResult: (opts) => (opts.target.allFrames ? FRAMES : { ok: true }),
  });
  const all = await cmd(d2, ws2, "snapshot");
  t.check("empty allowlist — frames are not filtered",
    all.result.elements.length === 2 && all.result.skippedFrames === 0, all.result);
}

// ── 18. An action inside a frame is checked against the allowlist separately ─
{
  const withFrameUrl = (url) => (opts) =>
    opts.func?.name === "pageHref" ? { ok: true, url } : { ok: true, clicked: "button" };

  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: withFrameUrl("https://ads.evil.com/widget"),
  });
  const bad = await cmd(d, ws, "click", { ref: "3:e1" });
  t.check("click into a frame outside the allowlist rejected", bad.ok === false && /allowlist/i.test(bad.error), bad);

  const { d: d2, ws: ws2, chrome: c2 } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: withFrameUrl("https://example.com/inner"),
  });
  const good = await cmd(d2, ws2, "click", { ref: "3:e1" });
  t.check("click into a frame inside the allowlist passes", good.ok === true, good);
  t.check("click went to exactly the right frame",
    c2._calls.executeScript.some((c) => c.func?.name === "pageClick" && c.target.frameIds?.[0] === 3));

  // The top frame is already checked via the tab — no extra location request.
  const { d: d3, ws: ws3, chrome: c3 } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: withFrameUrl("https://example.com/a"),
  });
  await cmd(d3, ws3, "click", { selector: "button" });
  t.check("no extra check for the top frame",
    !c3._calls.executeScript.some((c) => c.func?.name === "pageHref"));
}

// ── 19. readonly and a blank tab ─────────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { mode: "readonly", grantedTabId: 1 } });
  const em = await cmd(d, ws, "emulate", { device: "iPhone 14" });
  t.check("readonly blocks emulate", em.ok === false && /read-only/i.test(em.error), em);
  const start = await cmd(d, ws, "debug_start");
  t.check("readonly doesn't block observation (debug_start passes)", start.ok === true, start);
}
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { allowlist: ["example.com"] } });
  const r = await cmd(d, ws, "open_tab", {});
  t.check("open_tab without url with a non-empty allowlist rejected", r.ok === false && /allowlist/i.test(r.error), r);
  t.check("blank tab not created", chrome._calls.created.length === 0);

  const { d: d2, ws: ws2, chrome: c2 } = await boot(createDispatcher, { tabs: TABS, storage: {} });
  const ok = await cmd(d2, ws2, "open_tab", {});
  t.check("without an allowlist a blank tab still opens", ok.ok === true && c2._calls.created.length === 1, ok);
}

// ── 20. Several granted tabs: the agent reads any of them by tabId ───────────
{
  // The human grants two tabs in a row from the popup: the set grows, the last one is current.
  const htmlByTab = (opts) => ({ ok: true, html: `<b>tab-${opts.target.tabId}</b>` });
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, scriptResult: htmlByTab });
  const list = chrome._tabs();
  list.forEach((x) => { x.active = x.id === 1; });
  await d.handlePopup({ type: "grantActive" });
  list.forEach((x) => { x.active = x.id === 3; });
  await d.handlePopup({ type: "grantActive" });
  t.check("two grants from the popup → a set of two tabs",
    d.state.grantedTabs.length === 2 && d.state.grantedTabs.includes(1) && d.state.grantedTabs.includes(3), d.state.grantedTabs);
  t.check("current = the most recently granted", d.state.grantedTabId === 3);

  const tabs = (await cmd(d, ws, "tabs")).result;
  const byId = Object.fromEntries(tabs.map((x) => [x.id, x]));
  t.check("browser_tabs marks both as granted and one as current",
    byId[1].granted && byId[3].granted && !byId[2].granted && byId[3].current && !byId[1].current, tabs);

  // Reading by tabId hits the right tab; the current one doesn't change.
  const other = await cmd(d, ws, "get_html", { tabId: 1 });
  t.check("get_html with tabId reads the given tab", other.ok === true && other.result.html.includes("tab-1"), other);
  t.check("reading by tabId doesn't switch the current tab", d.state.grantedTabId === 3);
  const cur = await cmd(d, ws, "get_html", {});
  t.check("without tabId — the current tab", cur.ok === true && cur.result.html.includes("tab-3"), cur);

  // A tab outside the set is inaccessible even with an empty allowlist: access is granted by the human (or select_tab).
  const alien = await cmd(d, ws, "get_html", { tabId: 2 });
  t.check("tabId outside the set rejected", alien.ok === false && /has no access/i.test(alien.error), alien);
  t.check("nothing reached the page", !chrome._calls.executeScript.some((c) => c.target.tabId === 2));

  // Any tab in the set can be closed by tabId, not only the current one.
  const closed = await cmd(d, ws, "close_tab", { tabId: 1 });
  t.check("close_tab closes a set tab that isn't current", closed.ok === true && chrome._calls.removed.includes(1), closed);
  t.check("set shrank, current tab unchanged", d.state.grantedTabs.length === 1 && d.state.grantedTabId === 3);

  const stranger = await cmd(d, ws, "close_tab", { tabId: 2 });
  t.check("close_tab with a foreign id still rejected", stranger.ok === false && /only a granted tab/i.test(stranger.error), stranger);
}
{
  // Closing the CURRENT tab: another tab from the set becomes current, not "no access".
  const { d, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabs: [1, 3], grantedTabId: 3 } });
  await chrome.tabs.remove(3);
  d.onTabRemoved(3);
  t.check("closing the current tab hands the role to the remaining one", d.state.grantedTabId === 1 && d.state.grantedTabs.length === 1);

  // Revoke from one tab via the popup, then from all.
  const { d: d2, chrome: c2 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabs: [1, 3], grantedTabId: 3 } });
  await d2.handlePopup({ type: "revokeAccess", tabId: 3 });
  t.check("revoking one tab keeps the others", d2.state.grantedTabs.length === 1 && d2.state.grantedTabId === 1);
  t.check("badge removed from exactly the revoked tab",
    c2._calls.executeScript.some((c) => c.func?.name === "pageShield" && c.target.tabId === 3 && c.args[0] === null));
  await d2.handlePopup({ type: "setCurrent", tabId: 999 });
  t.check("setCurrent to a tab outside the set changes nothing", d2.state.grantedTabId === 1);
  await d2.handlePopup({ type: "revokeAccess" });
  t.check("revoke without tabId clears the whole set", d2.state.grantedTabs.length === 0 && d2.state.grantedTabId === null);
}
{
  // The allowlist applies to every tab in the set on every access.
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabs: [1, 2], grantedTabId: 1 },
    scriptResult: { ok: true, html: "x" },
  });
  const bad = await cmd(d, ws, "get_html", { tabId: 2 });
  t.check("set tab outside the allowlist is not readable", bad.ok === false && /allowlist/i.test(bad.error), bad);
  const good = await cmd(d, ws, "get_html", { tabId: 1 });
  t.check("set tab inside the allowlist is readable", good.ok === true, good);

  // The old storage format (a single grantedTabId) loads as a one-tab set.
  const { d: d2 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 3 } });
  t.check("migration: single grantedTabId → a set of it",
    d2.state.grantedTabs.length === 1 && d2.state.grantedTabs[0] === 3 && d2.state.grantedTabId === 3);

  // Capture is bound to the current tab: buffers are not mixed when reading another tab "by tabId".
  const { d: d3, ws: ws3 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabs: [1, 3], grantedTabId: 1 } });
  await cmd(d3, ws3, "debug_start");
  t.check("debug_start on the current tab", d3.dbg.tabId === 1);
  await cmd(d3, ws3, "select_tab", { tabId: 3 });
  t.check("changing the current tab stops capture (buffers belong to one page)", d3.dbg.persistent === false);
  t.check("and the previous current tab keeps access", d3.state.grantedTabs.includes(1));
}

// ── 16. JS dialogs: answered when armed, reported when not ───────────────────
{
  const sends = (chrome, method) => chrome._calls.debugger.filter((c) => c.op === "send" && c.method === method);
  let d;
  const booted = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabs: [1], grantedTabId: 1 },
    // The click opens a confirm: the core hears about it via CDP while the script "runs".
    scriptResult: (opts) => {
      if (opts.func.name === "pageClick") d.handleCdpEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete item?" });
      return { ok: true, clicked: "Delete" };
    },
  });
  d = booted.d;
  const { ws, chrome } = booted;
  const r = await cmd(d, ws, "click", { selector: "#del", dialog: "accept" });
  t.check("armed click succeeds", r.ok === true, r);
  t.check("Page enabled BEFORE the click (otherwise CDP never sees the dialog)",
    chrome._calls.debugger.findIndex((c) => c.method === "Page.enable") >= 0);
  const h = sends(chrome, "Page.handleJavaScriptDialog");
  t.check("dialog answered as asked", h.length === 1 && h[0].params.accept === true, h);
  t.check("agent sees what the dialog said", r.result.dialog?.message === "Delete item?" && r.result.dialog?.type === "confirm", r.result);
  t.check("session closed after the armed action", !chrome._attached.has(1));

  const r2 = await cmd(d, ws, "click", { selector: "#x" });
  t.check("unarmed click opens no CDP session (no banner on every click)",
    sends(chrome, "Page.enable").length === 1 && r2.ok === true);

  const bad = await cmd(d, ws, "click", { selector: "#x", dialog: "maybe" });
  t.check("unknown dialog answer rejected", bad.ok === false && /accept.*dismiss/.test(bad.error), bad);
}
{
  // A page frozen by a dialog nobody armed for: neither the command nor the probe answers.
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabs: [1], grantedTabId: 1 },
    scriptResult: () => new Promise(() => {}),
  });
  const t0 = Date.now();
  const r = await cmd(d, ws, "get_html", {});
  t.check("frozen page → clear error mentioning the dialog", r.ok === false && /dialog/i.test(r.error), r);
  t.check("…in seconds, not the 30 s server timeout", Date.now() - t0 < 6000, Date.now() - t0);
}
{
  // A slow but alive page (wait_for polling): the probe answers, the command keeps waiting.
  let calls = 0;
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabs: [1], grantedTabId: 1 },
    scriptResult: (opts) => opts.func.name === "pageWaitFor"
      ? (calls++, wait(2600).then(() => ({ ok: true, found: true })))
      : { ok: true, url: "https://example.com/a" },
  });
  const r = await cmd(d, ws, "wait_for", { selector: "#late" });
  t.check("slow but responsive page is not mistaken for a frozen one", r.ok === true && calls === 1, r);
}

// ── 17. hover / drag / upload_file ───────────────────────────────────────────
{
  const point = (opts) => {
    const [ref, sel] = opts.args || [];
    if (opts.func.name === "pagePoint") return { ok: true, x: sel === "#dst" ? 300 : 100, y: 50, inViewport: true, name: sel || ref };
    return { ok: true };
  };
  let d;
  const booted = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabs: [1], grantedTabId: 1 },
    scriptResult: point,
    // The page starts an HTML5 drag once the pressed mouse moves.
    cdpHook: (tabId, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1) {
        d.handleCdpEvent({ tabId }, "Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
      }
    },
  });
  d = booted.d;
  const { ws, chrome } = booted;
  const sent = (m) => chrome._calls.debugger.filter((c) => c.op === "send" && c.method === m).map((c) => c.params);

  const hv = await cmd(d, ws, "hover", { selector: "#menu" });
  const mv = sent("Input.dispatchMouseEvent");
  t.check("hover moves the real mouse to the element center",
    hv.ok === true && mv.length === 1 && mv[0].type === "mouseMoved" && mv[0].x === 100, { hv, mv });
  t.check("hover detaches afterwards", !chrome._attached.has(1));
  const inFrame = await cmd(d, ws, "hover", { ref: "3:e1" });
  t.check("hover into a nested frame rejected (top frame only)", inFrame.ok === false && /top frame/.test(inFrame.error), inFrame);

  const dr = await cmd(d, ws, "drag", { fromSelector: "#src", toSelector: "#dst" });
  const types = sent("Input.dispatchMouseEvent").slice(1).map((p) => p.type);
  t.check("drag = press, moves, release", dr.ok === true && types[1] === "mousePressed" && types.at(-1) === "mouseReleased", { dr, types });
  const drops = sent("Input.dispatchDragEvent").map((p) => p.type);
  t.check("HTML5 drag is completed with dragEnter/dragOver/drop on the target",
    drops.join() === "dragEnter,dragOver,drop" && sent("Input.dispatchDragEvent")[2].x === 300, drops);
  t.check("drag interception switched off again", sent("Input.setInterceptDrags").map((p) => p.enabled).join() === "true,false");

  const up = await cmd(d, ws, "upload_file", { selector: "input[type=file]", files: ["/tmp/a.txt"] });
  const set = sent("DOM.setFileInputFiles");
  t.check("upload goes through DOM.setFileInputFiles on the marked input",
    up.ok === true && set.length === 1 && set[0].objectId === "obj-1" && set[0].files[0] === "/tmp/a.txt", { up, set });
  const mark = chrome._calls.executeScript.find((c) => c.func.name === "pageMarkFileInput").args[2];
  t.check("the CDP side looks up exactly the marked element and unmarks it",
    sent("Runtime.evaluate")[0].expression.includes(mark) && /removeAttribute/.test(sent("Runtime.evaluate")[0].expression));
  const none = await cmd(d, ws, "upload_file", { selector: "input" , files: [] });
  t.check("upload without files rejected", none.ok === false, none);
}
{
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabs: [1], grantedTabId: 1, mode: "readonly" },
    scriptResult: { ok: true, x: 1, y: 1, inViewport: true, name: "m" },
  });
  const dr = await cmd(d, ws, "drag", { fromSelector: "#a", toSelector: "#b" });
  const up = await cmd(d, ws, "upload_file", { selector: "input", files: ["/tmp/a.txt"] });
  const hv = await cmd(d, ws, "hover", { selector: "#m" });
  t.check("read-only blocks drag", dr.ok === false && /read-only/i.test(dr.error));
  t.check("read-only blocks file upload", up.ok === false && /read-only/i.test(up.error));
  t.check("read-only allows hover (it only reveals, like scroll)", hv.ok === true, hv);
}

// ── 18. Mouse actions on a background tab ────────────────────────────────────
{
  // Tab 3 is the agent's, tab 1 is what the user is looking at (same window).
  const { d, ws, chrome } = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabs: [3], grantedTabId: 3 },
    scriptResult: { ok: true, x: 10, y: 10, inViewport: true, name: "menu" },
  });
  const activations = () => chrome._calls.updated.filter((u) => "active" in u).map((u) => u.id);
  const dr = await cmd(d, ws, "drag", { fromSelector: "#a", toSelector: "#b" });
  t.check("drag on a background tab: shown for the action, then the user's tab is back",
    dr.ok === true && activations().join() === "3,1" && chrome._tabs().find((x) => x.id === 1).active === true, { dr, a: activations() });
  const hv = await cmd(d, ws, "hover", { selector: "#menu" });
  t.check("hover on a background tab brings it to the front and leaves it there (hiding drops the hover)",
    hv.ok === true && activations().join() === "3,1,3" && hv.result.broughtToFront === true, { hv, a: activations() });
  await cmd(d, ws, "hover", { selector: "#menu" });
  t.check("hover on the tab already in front switches nothing", activations().length === 3);
}

// ── 19. A popup click right at worker start isn't lost ───────────────────────
{
  const chrome = mockChrome({ tabs: TABS, storage: { enabled: false } });
  const d = createDispatcher({ chrome, WebSocketImpl: MockWebSocket, now: () => 0 });
  const starting = d.init();                                   // settings still loading…
  await d.handlePopup({ type: "setEnabled", value: true });   // …when the user flips the switch
  await starting;
  t.check("switch flipped during startup stays on", d.state.enabled === true);
}

process.exit(t.done("dispatcher") ? 0 : 1);
