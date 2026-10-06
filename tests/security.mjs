// Тест безопасности транспорта: origin-check, ready-гейт, токен.
import { startServer, fakeExtension, checker, wait } from "./lib.mjs";

async function connected(s) {
  const r = await s.callTool("browser_status");
  return r.ok && JSON.parse(r.text).connected === true;
}

async function main() {
  const t = checker();
  let ok = true;

  // ── A. Кого пускает рукопожатие ──
  // Проверка — ALLOWLIST, а не «всё кроме http(s)»: opaque origin («null» у
  // <iframe sandbox>) и file:// раньше проходили, а это ровно веб-страница.
  console.log("\n▶ security A: allowlist origin'ов на рукопожатии");
  const A = startServer({ port: 8782 });
  await wait(1300); await A.initialize();

  /** Подключиться с данным Origin и вернуть, приняли ли соединение. */
  async function accepts(origin) {
    const c = fakeExtension(8782, { origin });
    await wait(700);
    const opened = c.state.opened;
    c.close();
    await wait(250);
    return opened;
  }

  t.check("веб-origin отклонён", (await accepts("https://evil.example")) === false);
  t.check("«null» (iframe sandbox, opaque origin) отклонён", (await accepts("null")) === false);
  t.check("file:// отклонён", (await accepts("file://")) === false);
  t.check("chrome-extension:// пускается", (await accepts("chrome-extension://abcdef")) === true);
  t.check("локальный процесс без заголовка Origin пускается", (await accepts(null)) === true);
  t.check("после всех отказов клиент не подключён", !(await connected(A)));

  // Клиент считается готовым только после валидного hello.
  const late = fakeExtension(8782, { protocolVersion: 1 });
  await wait(600);
  t.check("после валидного hello клиент готов", await connected(A));
  late.close(); A.close();
  await wait(400);

  // ── B. С токеном ──
  console.log("\n▶ security B: сервер с DISPATCH_TOKEN=s3cret");
  const B = startServer({ port: 8783, env: { DISPATCH_TOKEN: "s3cret" } });
  await wait(1300); await B.initialize();

  const bad = fakeExtension(8783, { token: "wrong" });
  await wait(700);
  t.check("неверный токен не пускает", !(await connected(B)));
  t.check("неверный токен → сервер закрыл соединение", bad.state.closed, bad.state);

  const empty = fakeExtension(8783, { token: "" });
  await wait(700);
  t.check("пустой токен не пускает", !(await connected(B)));
  empty.close();
  await wait(300);

  const good = fakeExtension(8783, { token: "s3cret" });
  await wait(700);
  t.check("верный токен пускает", await connected(B));
  good.close(); B.close();
  await wait(400);

  // ── C. Разрыв связи не оставляет команду висеть до таймаута (30с) ──
  console.log("\n▶ security C: pending-команды при разрыве");
  const C = startServer({ port: 8784 });
  await wait(1300); await C.initialize();

  const mute = fakeExtension(8784, { silent: true }); // принимает команду, не отвечает
  await wait(600);
  t.check("silent-клиент подключён", await connected(C));

  const started = Date.now();
  const hanging = C.callTool("browser_tabs"); // ответа не будет
  await wait(300);
  mute.close(); // рвём связь — команда должна упасть сразу, а не через 30с

  const r = await hanging;
  const elapsed = Date.now() - started;
  t.check("команда при разрыве завершилась быстро (<5с, не по таймауту)", elapsed < 5000, `${elapsed}мс`);
  t.check("команда при разрыве вернула ошибку", r.ok === false, r);
  t.check("ошибка объясняет причину (отключение)", /отключ/i.test(r.text), r.text);
  C.close();

  process.exit(t.done("security") ? 0 : 1);
}
main().catch((e) => { console.error("security упал:", e); process.exit(1); });
