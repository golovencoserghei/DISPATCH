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

// ── 12. Шильдик на вкладке с доступом ────────────────────────────────────────
{
  const shields = (chrome) => chrome._calls.executeScript.filter((c) => c.func?.name === "pageShield");
  const lastMode = (chrome) => shields(chrome).at(-1)?.args?.[0];

  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS });
  await cmd(d, ws, "select_tab", { tabId: 1 });
  t.check("выдача доступа рисует шильдик на вкладке", shields(chrome).at(-1)?.target?.tabId === 1);
  t.check("шильдик знает режим (полный доступ)", lastMode(chrome) === "full");

  // вторая вкладка получает доступ: у первой он остаётся, шильдик с неё не снимается
  const before = shields(chrome).length;
  await cmd(d, ws, "select_tab", { tabId: 2 });
  const moves = shields(chrome).slice(before);
  t.check("со старой вкладки шильдик НЕ снят — доступ у неё остался", !moves.some((c) => c.target.tabId === 1 && c.args[0] === null));
  t.check("на новой вкладке шильдик нарисован", moves.some((c) => c.target.tabId === 2 && c.args[0] === "full"));

  await d.handlePopup({ type: "setMode", value: "readonly" });
  const repainted = shields(chrome).filter((c) => c.args[0] === "readonly").map((c) => c.target.tabId);
  t.check("смена режима перерисовывает шильдик на ВСЕХ вкладках с доступом",
    repainted.includes(1) && repainted.includes(2), repainted);

  await d.handlePopup({ type: "revokeAccess" });
  const hidden = shields(chrome).filter((c) => c.args[0] === null).map((c) => c.target.tabId);
  t.check("отзыв доступа убирает шильдик со всех вкладок", hidden.includes(1) && hidden.includes(2), hidden);
}

// ── 13. Шильдик следует за состоянием тумблера и навигацией ──────────────────
{
  const shields = (chrome) => chrome._calls.executeScript.filter((c) => c.func?.name === "pageShield");
  const { d, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });

  await d.handlePopup({ type: "setEnabled", value: false });
  t.check("выключенный тумблер убирает шильдик (агент не действует — плашки нет)",
    shields(chrome).at(-1)?.args?.[0] === null);

  await d.handlePopup({ type: "setEnabled", value: true });
  t.check("включённый тумблер возвращает шильдик", shields(chrome).at(-1)?.args?.[0] === "full");

  const before = shields(chrome).length;
  d.onTabUpdated(1, { status: "complete" }); // навигация стёрла плашку вместе с документом
  await wait(10);
  t.check("после навигации шильдик рисуется заново", shields(chrome).length > before);

  const n = shields(chrome).length;
  d.onTabUpdated(2, { status: "complete" });   // чужая вкладка
  d.onTabUpdated(1, { status: "loading" });    // ещё не догрузилась
  await wait(10);
  t.check("чужая вкладка и недогруженная страница шильдик не трогают", shields(chrome).length === n);
  await d.handlePopup({ type: "setEnabled", value: false });
}

// ── 14. Шильдик не мешает агенту ─────────────────────────────────────────────
{
  // Плашка не должна попадать в снимок: она не интерактивна и висит в Shadow DOM.
  const { pageShield, pageSnapshot } = await import("../extension/page.js");
  t.check("pageShield(null) — снятие без падения на пустой странице",
    typeof pageShield === "function" && typeof pageSnapshot === "function");
  const src = pageShield.toString();
  t.check("шильдик не ловит мышь (pointer-events:none)", /pointer-events:\s*none/.test(src));
  t.check("шильдик изолирован в Shadow DOM", /attachShadow/.test(src));
  t.check("шильдик поверх всего (z-index)", /z-index:\s*2147483647/.test(src));
}

// ── 15. Буферы перехвата закрыты allowlist'ом ────────────────────────────────
{
  const { d, ws, chrome } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
  });
  await cmd(d, ws, "debug_start");
  d.handleCdpEvent({ tabId: 1 }, "Network.requestWillBeSent",
    { requestId: "r1", request: { url: "https://example.com/api", method: "GET" }, type: "XHR" });

  const inside = await cmd(d, ws, "network", {});
  t.check("в пределах allowlist сеть читается", inside.ok === true && inside.result.count === 1, inside);

  // Человек уводит вкладку с доступом на хост вне списка: команды-то проверяются,
  // а перехват пишет сам по себе — его надо снять сразу.
  chrome._tabs().find((x) => x.id === 1).url = "https://bank.example/account";
  await d.onTabUpdated(1, { status: "complete", url: "https://bank.example/account" });
  t.check("уход вкладки за allowlist снял перехват",
    d.dbg.persistent === false && !chrome._attached.has(1));

  const net = await cmd(d, ws, "network", {});
  t.check("вне allowlist сеть не читается", net.ok === false && /allowlist/i.test(net.error), net);
  const logs = await cmd(d, ws, "console_logs", {});
  t.check("вне allowlist консоль не читается", logs.ok === false && /allowlist/i.test(logs.error), logs);
  const body = await cmd(d, ws, "network_body", { requestId: "r1" });
  t.check("вне allowlist тело ответа не читается", body.ok === false && /allowlist/i.test(body.error), body);

  // Вернулись на разрешённый хост — накопленного чужого быть не должно.
  chrome._tabs().find((x) => x.id === 1).url = "https://example.com/back";
  const back = await cmd(d, ws, "network", {});
  t.check("буфер очищен вместе с сессией, а не просто закрыт",
    back.ok === false && /перехват не включён/i.test(back.error), back);
}

// ── 15б. Ужесточение allowlist из popup снимает уже идущий перехват ──────────
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  t.check("перехват идёт при пустом allowlist", d.dbg.persistent === true);

  await d.handlePopup({ type: "setAllowlist", value: "only-this.example" });
  t.check("новый allowlist, запрещающий текущую вкладку, снял перехват",
    d.dbg.persistent === false && !chrome._attached.has(1));
}

// ── 16. Перехват только на вкладке с доступом ────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 1 } });
  await cmd(d, ws, "debug_start");
  d.state.grantedTabId = 3; // доступ переехал мимо grantAccess (например, восстановлен из storage)
  const r = await cmd(d, ws, "network", {});
  t.check("чтение буферов чужой вкладки отклонено", r.ok === false && /другой|заново|#/i.test(r.error), r);
}

// ── 17. Кросс-доменный iframe не попадает в снимок ───────────────────────────
{
  const FRAMES = [
    { frameId: 0, result: { ok: true, url: "https://example.com/a", title: "Свой сайт", count: 1,
      elements: [{ ref: "e1", role: "button", tag: "button", name: "своя кнопка" }] } },
    { frameId: 3, result: { ok: true, url: "https://ads.evil.com/widget", title: "Реклама", count: 1,
      elements: [{ ref: "e1", role: "button", tag: "button", name: "чужая кнопка" }] } },
  ];
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: (opts) => (opts.target.allFrames ? FRAMES : { ok: true }),
  });
  const snap = await cmd(d, ws, "snapshot");
  const names = (snap.result?.elements || []).map((e) => e.name);
  t.check("свой фрейм в снимке есть", names.includes("своя кнопка"), names);
  t.check("фрейм вне allowlist отброшен", !names.includes("чужая кнопка") && snap.result.skippedFrames === 1, snap.result);

  // Без allowlist ограничивать нечем — оба фрейма на месте.
  const { d: d2, ws: ws2 } = await boot(createDispatcher, {
    tabs: TABS, storage: { grantedTabId: 1 },
    scriptResult: (opts) => (opts.target.allFrames ? FRAMES : { ok: true }),
  });
  const all = await cmd(d2, ws2, "snapshot");
  t.check("пустой allowlist — фреймы не фильтруются",
    all.result.elements.length === 2 && all.result.skippedFrames === 0, all.result);
}

// ── 18. Действие внутри фрейма сверяется с allowlist отдельно ────────────────
{
  const withFrameUrl = (url) => (opts) =>
    opts.func?.name === "pageHref" ? { ok: true, url } : { ok: true, clicked: "кнопка" };

  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: withFrameUrl("https://ads.evil.com/widget"),
  });
  const bad = await cmd(d, ws, "click", { ref: "3:e1" });
  t.check("клик во фрейм вне allowlist отклонён", bad.ok === false && /allowlist/i.test(bad.error), bad);

  const { d: d2, ws: ws2, chrome: c2 } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: withFrameUrl("https://example.com/inner"),
  });
  const good = await cmd(d2, ws2, "click", { ref: "3:e1" });
  t.check("клик во фрейм внутри allowlist проходит", good.ok === true, good);
  t.check("клик ушёл именно в нужный фрейм",
    c2._calls.executeScript.some((c) => c.func?.name === "pageClick" && c.target.frameIds?.[0] === 3));

  // Верхний фрейм уже проверен по вкладке — лишнего запроса location не делаем.
  const { d: d3, ws: ws3, chrome: c3 } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabId: 1 },
    scriptResult: withFrameUrl("https://example.com/a"),
  });
  await cmd(d3, ws3, "click", { selector: "button" });
  t.check("для верхнего фрейма лишней проверки нет",
    !c3._calls.executeScript.some((c) => c.func?.name === "pageHref"));
}

// ── 19. readonly и пустая вкладка ────────────────────────────────────────────
{
  const { d, ws } = await boot(createDispatcher, { tabs: TABS, storage: { mode: "readonly", grantedTabId: 1 } });
  const em = await cmd(d, ws, "emulate", { device: "iPhone 14" });
  t.check("readonly блокирует emulate", em.ok === false && /только чтение/i.test(em.error), em);
  const start = await cmd(d, ws, "debug_start");
  t.check("readonly не мешает наблюдению (debug_start проходит)", start.ok === true, start);
}
{
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { allowlist: ["example.com"] } });
  const r = await cmd(d, ws, "open_tab", {});
  t.check("open_tab без url при непустом allowlist отклонён", r.ok === false && /allowlist/i.test(r.error), r);
  t.check("пустая вкладка не создана", chrome._calls.created.length === 0);

  const { d: d2, ws: ws2, chrome: c2 } = await boot(createDispatcher, { tabs: TABS, storage: {} });
  const ok = await cmd(d2, ws2, "open_tab", {});
  t.check("без allowlist пустая вкладка по-прежнему открывается", ok.ok === true && c2._calls.created.length === 1, ok);
}

// ── 20. Несколько вкладок с доступом: агент читает любую по tabId ────────────
{
  // Человек выдаёт доступ двум вкладкам подряд из popup: набор растёт, текущая — последняя.
  const htmlByTab = (opts) => ({ ok: true, html: `<b>tab-${opts.target.tabId}</b>` });
  const { d, ws, chrome } = await boot(createDispatcher, { tabs: TABS, scriptResult: htmlByTab });
  const list = chrome._tabs();
  list.forEach((x) => { x.active = x.id === 1; });
  await d.handlePopup({ type: "grantActive" });
  list.forEach((x) => { x.active = x.id === 3; });
  await d.handlePopup({ type: "grantActive" });
  t.check("две выдачи из popup → набор из двух вкладок",
    d.state.grantedTabs.length === 2 && d.state.grantedTabs.includes(1) && d.state.grantedTabs.includes(3), d.state.grantedTabs);
  t.check("текущая — выданная последней", d.state.grantedTabId === 3);

  const tabs = (await cmd(d, ws, "tabs")).result;
  const byId = Object.fromEntries(tabs.map((x) => [x.id, x]));
  t.check("browser_tabs помечает обе как granted и одну как current",
    byId[1].granted && byId[3].granted && !byId[2].granted && byId[3].current && !byId[1].current, tabs);

  // Чтение по tabId — на нужной вкладке, текущая не меняется.
  const other = await cmd(d, ws, "get_html", { tabId: 1 });
  t.check("get_html с tabId читает указанную вкладку", other.ok === true && other.result.html.includes("tab-1"), other);
  t.check("чтение по tabId не переключает текущую", d.state.grantedTabId === 3);
  const cur = await cmd(d, ws, "get_html", {});
  t.check("без tabId — текущая вкладка", cur.ok === true && cur.result.html.includes("tab-3"), cur);

  // Вкладка вне набора недоступна даже при пустом allowlist: доступ выдаёт человек (или select_tab).
  const alien = await cmd(d, ws, "get_html", { tabId: 2 });
  t.check("tabId вне набора отклонён", alien.ok === false && /без доступа/i.test(alien.error), alien);
  t.check("до страницы дело не дошло", !chrome._calls.executeScript.some((c) => c.target.tabId === 2));

  // Закрыть по tabId можно любую вкладку набора, не только текущую.
  const closed = await cmd(d, ws, "close_tab", { tabId: 1 });
  t.check("close_tab закрывает вкладку набора, не текущую", closed.ok === true && chrome._calls.removed.includes(1), closed);
  t.check("набор сократился, текущая на месте", d.state.grantedTabs.length === 1 && d.state.grantedTabId === 3);

  const stranger = await cmd(d, ws, "close_tab", { tabId: 2 });
  t.check("close_tab по чужому id по-прежнему отклонён", stranger.ok === false && /только вкладку с доступом/i.test(stranger.error), stranger);
}
{
  // Закрытие ТЕКУЩЕЙ вкладки: текущей становится другая из набора, а не «нет доступа».
  const { d, chrome } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabs: [1, 3], grantedTabId: 3 } });
  await chrome.tabs.remove(3);
  d.onTabRemoved(3);
  t.check("закрытие текущей вкладки передаёт роль оставшейся", d.state.grantedTabId === 1 && d.state.grantedTabs.length === 1);

  // Отзыв у одной вкладки из popup, потом — у всех.
  const { d: d2, chrome: c2 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabs: [1, 3], grantedTabId: 3 } });
  await d2.handlePopup({ type: "revokeAccess", tabId: 3 });
  t.check("отзыв у одной вкладки оставляет остальные", d2.state.grantedTabs.length === 1 && d2.state.grantedTabId === 1);
  t.check("шильдик снят именно с отозванной",
    c2._calls.executeScript.some((c) => c.func?.name === "pageShield" && c.target.tabId === 3 && c.args[0] === null));
  await d2.handlePopup({ type: "setCurrent", tabId: 999 });
  t.check("setCurrent на вкладку вне набора ничего не меняет", d2.state.grantedTabId === 1);
  await d2.handlePopup({ type: "revokeAccess" });
  t.check("отзыв без tabId очищает весь набор", d2.state.grantedTabs.length === 0 && d2.state.grantedTabId === null);
}
{
  // allowlist действует на каждую вкладку набора при каждом обращении.
  const { d, ws } = await boot(createDispatcher, {
    tabs: TABS, storage: { allowlist: ["example.com"], grantedTabs: [1, 2], grantedTabId: 1 },
    scriptResult: { ok: true, html: "x" },
  });
  const bad = await cmd(d, ws, "get_html", { tabId: 2 });
  t.check("вкладка набора вне allowlist не читается", bad.ok === false && /allowlist/i.test(bad.error), bad);
  const good = await cmd(d, ws, "get_html", { tabId: 1 });
  t.check("вкладка набора внутри allowlist читается", good.ok === true, good);

  // Старый формат storage (одна grantedTabId) поднимается как набор из одной вкладки.
  const { d: d2 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabId: 3 } });
  t.check("миграция: одиночная grantedTabId → набор из неё",
    d2.state.grantedTabs.length === 1 && d2.state.grantedTabs[0] === 3 && d2.state.grantedTabId === 3);

  // Перехват привязан к текущей вкладке: чтение буферов «по tabId» другой вкладки не смешивается.
  const { d: d3, ws: ws3 } = await boot(createDispatcher, { tabs: TABS, storage: { grantedTabs: [1, 3], grantedTabId: 1 } });
  await cmd(d3, ws3, "debug_start");
  t.check("debug_start на текущей", d3.dbg.tabId === 1);
  await cmd(d3, ws3, "select_tab", { tabId: 3 });
  t.check("смена текущей снимает перехват (буферы — про одну страницу)", d3.dbg.persistent === false);
  t.check("а доступ у прежней текущей остался", d3.state.grantedTabs.includes(1));
}

process.exit(t.done("dispatcher") ? 0 : 1);
