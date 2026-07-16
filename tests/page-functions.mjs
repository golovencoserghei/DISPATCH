// Тест page-функций (extension/page.js) на живом headless-Chrome через CDP.
// Исполняет ТЕ ЖЕ функции так же, как chrome.scripting.executeScript({func}) —
// через сериализацию исходника. Требует google-chrome (или $DISPATCH_CHROME).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import * as page from "../extension/page.js";
import { checker, wait } from "./lib.mjs";

const CHROME = process.env.DISPATCH_CHROME || "google-chrome";
const PORT = 9333;
const PROFILE = fileURLToPath(new URL("./.chrome-prof", import.meta.url));
const PAGE_URL = "file://" + fileURLToPath(new URL("./testpage.html", import.meta.url));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "about:blank",
], { stdio: "ignore" });

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* ждём */ }
    await wait(250);
  }
  throw new Error("Chrome не отдал page-таргет (установлен ли google-chrome? задай $DISPATCH_CHROME)");
}

function cdpClient(url) {
  const ws = new WebSocket(url); const waiters = new Map(); const events = []; let id = 0;
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } else if (m.method) events.push(m); });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (method, params) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params: params || {} })); return new Promise((res, rej) => waiters.set(mid, (m) => m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result))); };
  async function run(fn, args = []) {
    const expr = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page-исключение: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  return { ws, ready, send, run, events };
}

async function main() {
  const t = checker("\n▶ page-functions на живом Chrome");
  const target = await getPageTarget();
  const cdp = cdpClient(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: PAGE_URL });
  for (let i = 0; i < 40 && !cdp.events.some((e) => e.method === "Page.loadEventFired"); i++) await wait(150);

  const snap = await cdp.run(page.pageSnapshot);
  t.check("snapshot вернул элементы", snap.ok && snap.count >= 6, snap.count);
  const saveBtn = snap.elements.find((e) => e.tag === "button");
  t.check("snapshot нашёл кнопку", saveBtn && saveBtn.name === "Сохранить");

  const html = await cdp.run(page.pageGetHtml, ["#f"]);
  t.check("get_html содержит textarea", html.ok && html.html.includes("textarea"));

  t.check("eval 1+2*3==7", (await cdp.run(page.pageEval, ["1+2*3"])).json === "7");
  t.check("eval .card==3", (await cdp.run(page.pageEval, ["document.querySelectorAll('.card').length"])).json === "3");

  await cdp.run(page.pageType, [null, "#name", "Привет мир", false]);
  t.check("type записал значение", (await cdp.run(page.pageEval, ["document.getElementById('name').value"])).json === '"Привет мир"');

  const foc = await cdp.run(page.pageFocus, ["#bio"]);
  t.check("focus сфокусировал #bio", foc.ok && (await cdp.run(page.pageEval, ["document.activeElement.id"])).json === '"bio"');

  const clicked = await cdp.run(page.pageClick, [saveBtn.ref, null]);
  t.check("click по ref (ref-резолвинг)", clicked.ok && (await cdp.run(page.pageEval, ["window.__saved===true"])).json === "true");

  const ext = await cdp.run(page.pageExtract, [".card", { title: { selector: "h2" }, link: { selector: "a", attr: "href" } }, true]);
  t.check("extract собрал 3 карточки", ext.ok && ext.count === 3);
  t.check("extract взял href", ext.items && /\/item\/1$/.test(ext.items[0].link));

  t.check("scroll toBottom", (await cdp.run(page.pageScroll, [null, 0, 0, true])).scrollTop > 100);
  t.check("wait_for нашёл #bottom", (await cdp.run(page.pageWaitFor, ["#bottom", 3000])).found === true);

  // шильдик: рисуется, живёт в Shadow DOM, не ловит мышь, не лезет в снимок
  const sh = await cdp.run(page.pageShield, ["full"]);
  t.check("шильдик нарисован", sh.ok && sh.shield === true && sh.mode === "full", sh);
  t.check("шильдик в Shadow DOM с текстом режима",
    (await cdp.run(page.pageEval, ["document.getElementById('__dispatch_shield__').shadowRoot.textContent.trim()"])).json.includes("полный доступ"));
  const snapWithShield = await cdp.run(page.pageSnapshot);
  t.check("шильдик не попадает в snapshot", snapWithShield.count === snap.count, { было: snap.count, стало: snapWithShield.count });
  t.check("шильдик не перехватывает клики (pointer-events:none)",
    (await cdp.run(page.pageEval, ["(()=>{const s=document.getElementById('__dispatch_shield__').getBoundingClientRect();const el=document.elementFromPoint(innerWidth-20, innerHeight-20);return el && el.id !== '__dispatch_shield__';})()"])).json === "true");
  t.check("шильдик идемпотентен (повторный вызов не плодит копии)",
    (await cdp.run(page.pageShield, ["readonly"])).ok &&
    (await cdp.run(page.pageEval, ["document.querySelectorAll('[data-dispatch-shield]').length"])).json === "1");
  await cdp.run(page.pageShield, [null]);
  t.check("шильдик снимается",
    (await cdp.run(page.pageEval, ["document.getElementById('__dispatch_shield__')===null"])).json === "true");

  const metrics = await cdp.send("Page.getLayoutMetrics");
  const size = metrics.cssContentSize || metrics.contentSize;
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
  t.check("full-page скриншот получен", shot.data && shot.data.length > 1000);
  t.check("скриншот захватил всю высоту", size.height > 2000);

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await wait(150);
  const dpr = JSON.parse((await cdp.run(page.pageEval, ["window.devicePixelRatio"])).json);
  t.check("эмуляция дала devicePixelRatio≈3", Math.abs(dpr - 3) < 0.01, dpr);
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  cdp.ws.close(); chrome.kill();
  process.exit(t.done("page-functions") ? 0 : 1);
}
main().catch((e) => { console.error("page-functions упал:", e); chrome.kill(); process.exit(1); });
