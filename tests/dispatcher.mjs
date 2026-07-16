// Тест ядра (extension/dispatcher.js) на моках chrome.* — без браузера.
// Покрывает то, что раньше проверялось только руками: гейт мастер-тумблера,
// границы close_tab/select_tab, allowlist на живых вкладках и очередь CDP.
import { createDispatcher } from "../extension/dispatcher.js";
import { boot, cmd, MockWebSocket } from "./mock-chrome.mjs";
import { checker, wait } from "./lib.mjs";

const TABS = [
  { id: 1, url: "https://example.com/a", title: "Свой сайт", active: true },
  { id: 2, url: "https://evil.com/x", title: "Чужой сайт" },
  { id: 3, url: "http://localhost:3000/app", title: "Локальная разработка" },
];

const t = checker("\n▶ dispatcher: ядро на моках chrome");

// ── 1. Гейт мастер-тумблера ──────────────────────────────────────────────────
{
  const { d, chrome } = await boot(createDispatcher, { storage: { enabled: false }, tabs: TABS });
  t.check("тумблер выключен → соединение не открывается", d.state.connected === false && d.state.ws === null);

  // Худший случай: сокет всё-таки открыт (тумблер выключили при живой связи).
  // Команды всё равно не должны исполняться — гейт живёт в самом ядре.
  const sock = new MockWebSocket("ws://127.0.0.1:8765");
  sock.readyState = MockWebSocket.OPEN;
  d.state.ws = sock;
  const ask = async (method) => {
    const id = "gate-" + method;
    await d.onMessage(JSON.stringify({ id, kind: "cmd", method, params: {} }));
    return sock.reply(id) ?? { ok: null, error: "ядро не ответило" };
  };

  const r1 = await ask("tabs");
  t.check("тумблер выключен → tabs отклонён (список вкладок не утекает)",
    r1.ok === false && /тумблер/i.test(r1.error), r1);
  const r2 = await ask("status");
  t.check("тумблер выключен → даже status отклонён", r2.ok === false && /тумблер/i.test(r2.error), r2);
  t.check("тумблер выключен → до страницы дело не дошло", chrome._calls.executeScript.length === 0);
}

// ── 2. Выключение тумблера рвёт связь и снимает отладку ──────────────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  t.check("тумблер включён → соединение открыто", d.state.connected === true);
  await cmd(d, ws, "debug_start");
  t.check("debug_start поднял CDP-сессию", d.dbg.persistent === true && chrome._attached.has(1));

  await d.handlePopup({ type: "setEnabled", value: false });
  t.check("выключение тумблера закрыло сокет", ws.closed === true);
  t.check("выключение тумблера сбросило connected", d.state.connected === false);
  t.check("выключение тумблера сняло debug-сессию (баннер не висит)",
    d.dbg.persistent === false && !chrome._attached.has(1));
  t.check("детач реально ушёл в chrome.debugger",
    chrome._calls.debugger.some((c) => c.op === "detach" && c.tabId === 1));
}

// ── 3. close_tab — только вкладка с доступом ─────────────────────────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  const r = await cmd(d, ws, "close_tab", { tabId: 2 });
  t.check("close_tab по чужому id отклонён", r.ok === false && /только вкладку с доступом/i.test(r.error), r);
  t.check("чужая вкладка НЕ закрыта", !chrome._calls.removed.includes(2));

  const ok = await cmd(d, ws, "close_tab", { tabId: 1 });
  t.check("close_tab по своему id закрывает", ok.ok === true && chrome._calls.removed.includes(1));

  const { d: d2, ws: ws2, chrome: c2 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  const noId = await cmd(d2, ws2, "close_tab", {});
  t.check("close_tab без id закрывает вкладку с доступом", noId.ok === true && c2._calls.removed.includes(1));
}

// ── 4. select_tab уважает allowlist ──────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 } });
  const bad = await cmd(d, ws, "select_tab", { tabId: 2 });
  t.check("select_tab на вкладку вне allowlist отклонён", bad.ok === false && /allowlist/i.test(bad.error), bad);
  t.check("доступ не переехал на чужую вкладку", d.state.grantedTabId === 1);

  const good = await cmd(d, ws, "select_tab", { tabId: 1 });
  t.check("select_tab внутри allowlist работает", good.ok === true && d.state.grantedTabId === 1);

  const { d: d2, ws: ws2 } = await boot(createDispatcher, { tabs: TABS, storage: { allowlist: [] } });
  const any = await cmd(d2, ws2, "select_tab", { tabId: 2 });
  t.check("пустой allowlist → select_tab пускает куда угодно", any.ok === true && d2.state.grantedTabId === 2);
}

// ── 5. allowlist по хосту с портом (регрессия: host vs hostname) ─────────────
{
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["localhost"], grantedTabId: 3 }, scriptResult: { ok: true, html: "<b>тест</b>" },
  });
  const r = await cmd(d, ws, "get_html", {});
  t.check("allowlist «localhost» пускает на localhost:3000", r.ok === true, r);

  const nav = await cmd(d, ws, "navigate", { url: "http://localhost:3000/other" });
  t.check("navigate на localhost:3000 при allowlist «localhost» разрешён", nav.ok === true, nav);

  const out = await cmd(d, ws, "navigate", { url: "https://evil.com/" });
  t.check("navigate вне allowlist отклонён", out.ok === false && /allowlist/i.test(out.error), out);
}

// ── 6. Режим «только чтение» ─────────────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { mode: "readonly", grantedTabId: 1 }, scriptResult: { ok: true, elements: [], url: "https://example.com/a", title: "Свой сайт" },
  });
  const click = await cmd(d, ws, "click", { selector: "button" });
  t.check("readonly блокирует click", click.ok === false && /только чтение/i.test(click.error), click);
  const snap = await cmd(d, ws, "snapshot");
  t.check("readonly пропускает snapshot", snap.ok === true, snap);
  const nav = await cmd(d, ws, "navigate", { url: "https://example.com/b" });
  t.check("readonly блокирует navigate", nav.ok === false && /только чтение/i.test(nav.error));
}

// ── 7. Очередь CDP: конкурентные операции не дерутся за attach ───────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  // Два разовых CDP-вызова стартуют одновременно на ОДНОЙ вкладке.
  // Без очереди второй attach падал бы «already attached», либо detach первого
  // убивал сессию второго.
  const [a, b] = await Promise.all([
    cmd(d, ws, "screenshot", { fullPage: true }),
    cmd(d, ws, "press_key", { key: "Enter" }),
  ]);
  t.check("конкурентные CDP-операции: обе успешны", a.ok === true && b.ok === true, { a: a.error, b: b.error });

  const ops = chrome._calls.debugger.filter((c) => c.op === "attach" || c.op === "detach").map((c) => c.op);
  let depth = 0, overlap = false;
  for (const op of ops) { depth += op === "attach" ? 1 : -1; if (depth > 1 || depth < 0) overlap = true; }
  t.check("attach/detach строго парные, без наложения", !overlap && depth === 0, ops.join(","));
  t.check("после разовых операций сессия закрыта (баннер снят)", !chrome._attached.has(1) && !d.dbg.attached);
}

// ── 8. Очередь CDP: разовая операция не рушит постоянную сессию ──────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  const shot = await cmd(d, ws, "screenshot", { fullPage: true });
  t.check("скриншот при активной debug-сессии успешен", shot.ok === true, shot);
  t.check("постоянная сессия ПЕРЕЖИЛА разовую операцию",
    d.dbg.persistent === true && chrome._attached.has(1));

  const logs = await cmd(d, ws, "console_logs", {});
  t.check("перехват консоли продолжает работать", logs.ok === true, logs);
}

// ── 9. Буферы перехвата и события CDP ────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  d.handleCdpEvent({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "бум" }] });
  d.handleCdpEvent({ tabId: 1 }, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.com/api", method: "GET" }, type: "XHR" });
  d.handleCdpEvent({ tabId: 999 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "чужая вкладка" }] });

  const logs = await cmd(d, ws, "console_logs", {});
  t.check("консоль перехвачена", logs.result.count === 1 && logs.result.logs[0].text === "бум", logs.result);
  t.check("события чужой вкладки игнорируются", logs.result.count === 1);
  const net = await cmd(d, ws, "network", {});
  t.check("сеть перехвачена", net.result.count === 1 && net.result.requests[0].url.includes("/api"), net.result);
  const filtered = await cmd(d, ws, "network", { filter: "нет-такого" });
  t.check("фильтр сети работает", filtered.result.count === 0);
}

// ── 10. Закрытие вкладки с доступом сбрасывает состояние ─────────────────────
{
  const { d, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await chrome.tabs.remove(1); // мок сам зовёт onRemoved-листенеры
  d.onTabRemoved(1);
  t.check("закрытая вкладка снимает доступ", d.state.grantedTabId === null);
}

// ── 11. Реконнект после разрыва ──────────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS });
  const before = MockWebSocket.created;
  ws.close(); // сервер упал
  t.check("после обрыва connected сброшен", d.state.connected === false);
  await wait(1800); // ядро переподключается через ~1.5с
  t.check("ядро переподключилось само", MockWebSocket.created > before);
  await d.handlePopup({ type: "setEnabled", value: false }); // не оставлять таймер
}

process.exit(t.done("dispatcher") ? 0 : 1);
