// РУЧНОЙ тест: прогон изменяющих инструментов на РЕАЛЬНОМ браузере.
// Поднимает локальную тест-страницу, через open_tab открывает её в браузере
// пользователя и гоняет все команды. Требует: расширение установлено, обновлено
// (protocolVersion=1), мастер-тумблер включён. Давать доступ вручную НЕ нужно.
//
//   node tests/manual/stage3.mjs
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { startServer, checker, wait } from "../lib.mjs";

const HTTP_PORT = 8799;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const SHOT = fileURLToPath(new URL("./.stage3-shot.png", import.meta.url));

const PAGE = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Dispatch Stage3</title>
<style>body{font:14px sans-serif;margin:20px}.card{border:1px solid #ccc;padding:8px;margin:6px}.filler{height:2000px}</style>
<script>
console.log('DISPATCH_TEST_PAGE loaded');
function doFetch(){fetch('/api/data').then(function(r){return r.json()}).then(function(d){window.__api=d;console.log('DISPATCH_FETCH_OK',d.items.length)})}
</script></head><body>
<h1>Dispatch Stage3</h1>
<form id="f">
  <input id="name" placeholder="Имя"/><input id="keytest" placeholder="press_key"/>
  <textarea id="bio" placeholder="О себе"></textarea>
  <button id="save" type="button" onclick="window.__saved=true;document.title='saved'">Сохранить</button>
  <button id="fetchbtn" type="button" onclick="doFetch()">Fetch</button>
</form>
<ul id="list">
  <li class="card"><h2>Карточка 1</h2><a href="/item/1">открыть 1</a></li>
  <li class="card"><h2>Карточка 2</h2><a href="/item/2">открыть 2</a></li>
  <li class="card"><h2>Карточка 3</h2><a href="/item/3">открыть 3</a></li>
</ul>
<iframe id="fr" src="/frame" style="width:320px;height:80px"></iframe>
<div class="filler"></div><div id="bottom">низ</div></body></html>`;

const FRAME = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"></head><body>
<button id="framebtn" type="button" onclick="window.__frameClicked=true;document.title='frameok'">Кнопка во фрейме</button>
</body></html>`;

const httpSrv = createServer((req, res) => {
  if (req.url.startsWith("/api/data")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ items: ["alpha", "beta", "gamma"] })); }
  else if (req.url.startsWith("/frame")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(FRAME); }
  else { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); }
});

const J = (r) => JSON.parse(r.text);

async function main() {
  await new Promise((r) => httpSrv.listen(HTTP_PORT, "127.0.0.1", r));
  const s = startServer();
  const t = checker();
  await wait(1300); await s.initialize();
  console.log(`тест-страница ${BASE}. Жду расширение (обновлённое + тумблер вкл). Давать доступ не надо.`);

  const deadline = Date.now() + 240000;
  let conn = false;
  while (Date.now() < deadline) {
    const st = await s.callTool("browser_status");
    if (st.ok && J(st).connected) { conn = true; break; }
    console.log("… жду подключения…"); await wait(2500);
  }
  if (!conn) { console.log("⏱ не подключилось"); httpSrv.close(); s.close(); process.exit(2); }
  const hello = J(await s.callTool("browser_status")).browser || {};
  if (hello.protocolVersion !== 1) { console.log(`⚠ старая версия расширения (protocolVersion=${hello.protocolVersion}) — обнови (⟳) в chrome://extensions`); httpSrv.close(); s.close(); process.exit(3); }
  console.log("✓ на связи, версия = 1\n");

  const ot = await s.callTool("browser_open_tab", { url: `${BASE}/`, active: true, grant: true });
  t.check("open_tab открыл и выдал доступ", ot.ok && J(ot).granted === true, ot.text);
  const tabId = ot.ok ? J(ot).tabId : null;
  await wait(500);

  await s.callTool("browser_wait_for", { selector: "#save", timeoutMs: 5000 });
  const snap = await s.callTool("browser_snapshot"); t.check("snapshot нашёл элементы", snap.ok && J(snap).count >= 5, snap.text);
  t.check("get_html содержит textarea", J(await s.callTool("browser_get_html", { selector: "#f" })).html.includes("textarea"));
  t.check("eval вернул title", (await s.callTool("browser_eval", { expression: "document.title" })).text === '"Dispatch Stage3"');

  await s.callTool("browser_type", { selector: "#name", text: "Привет" });
  t.check("type записал текст", (await s.callTool("browser_eval", { expression: "document.getElementById('name').value" })).text.includes("Привет"));

  await s.callTool("browser_press_key", { selector: "#keytest", key: "z" });
  await s.callTool("browser_press_key", { selector: "#keytest", key: "Q" });
  const kv = (await s.callTool("browser_eval", { expression: "document.getElementById('keytest').value" })).text;
  t.check("press_key ввёл символы (CDP)", /z/i.test(kv) && /Q/i.test(kv), kv);

  const saveRef = J(await s.callTool("browser_snapshot")).elements.find((e) => e.tag === "button" && e.name === "Сохранить");
  if (saveRef) { await s.callTool("browser_click", { ref: saveRef.ref }); t.check("click по ref", (await s.callTool("browser_eval", { expression: "window.__saved===true" })).text === "true"); }
  else t.check("click по ref", false, "кнопка не найдена");

  t.check("scroll toBottom", J(await s.callTool("browser_scroll", { toBottom: true })).scrollTop > 100);
  t.check("extract 3 карточки", J(await s.callTool("browser_extract", { container: ".card", fields: { title: { selector: "h2" }, link: { selector: "a", attr: "href" } }, multiple: true })).count === 3);

  // iframe: snapshot по всем фреймам + click по ref во фрейме
  await wait(500);
  const snapF = J(await s.callTool("browser_snapshot"));
  const frameEl = snapF.elements.find((e) => e.frameId !== 0 && /фрейме/.test(e.name || ""));
  t.check("snapshot видит элемент во фрейме", !!frameEl, `frames=${snapF.frames}`);
  if (frameEl) {
    await s.callTool("browser_click", { ref: frameEl.ref });
    const fc = await s.callTool("browser_eval", { expression: "(window.frames[0] && window.frames[0].__frameClicked) === true" });
    t.check("click по ref во фрейме сработал", fc.text === "true", fc.text);
  }

  t.check("debug_start", J(await s.callTool("browser_debug_start")).attached === true);
  await wait(300);
  await s.callTool("browser_click", { selector: "#fetchbtn" });
  await wait(800);
  const apiReq = J(await s.callTool("browser_network", { filter: "/api/data" })).requests.find((r) => r.url.includes("/api/data"));
  t.check("network перехватил /api/data", !!apiReq);
  if (apiReq) t.check("network_body вернул тело", J(await s.callTool("browser_network_body", { requestId: apiReq.requestId })).body.includes("items"));
  t.check("console_logs поймал лог", J(await s.callTool("browser_console_logs", {})).logs.some((l) => String(l.text).includes("DISPATCH_FETCH_OK")));

  t.check("emulate device", J(await s.callTool("browser_emulate", { device: "iPhone 14" })).applied.some((a) => a.includes("iPhone")));
  const dpr = parseFloat((await s.callTool("browser_eval", { expression: "window.devicePixelRatio" })).text);
  t.check("эмуляция devicePixelRatio≈3", Math.abs(dpr - 3) < 0.01, dpr);
  await s.callTool("browser_emulate", { reset: true });

  const shot = await s.callTool("browser_screenshot", { fullPage: true });
  if (shot.ok && shot.img) { writeFileSync(SHOT, Buffer.from(shot.img, "base64")); t.check("full-page скрин", shot.img.length > 5000); } else t.check("full-page скрин", false, shot.text);

  t.check("navigate сменил URL", J(await s.callTool("browser_navigate", { url: `${BASE}/?p=2` })).url.includes("p=2"));
  t.check("close_tab закрыл вкладку", J(await s.callTool("browser_close_tab", { tabId })).closed === tabId);

  if (shot.img) console.log(`Скриншот: ${SHOT}`);
  httpSrv.close(); s.close();
  process.exit(t.done("stage3 (реальный браузер)") ? 0 : 1);
}
main().catch((e) => { console.error("stage3 упал:", e); httpSrv.close(); process.exit(1); });
