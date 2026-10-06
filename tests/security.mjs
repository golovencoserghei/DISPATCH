// Transport security test: origin check, ready gate, token.
import { startServer, fakeExtension, checker, wait } from "./lib.mjs";

async function connected(s) {
  const r = await s.callTool("browser_status");
  return r.ok && JSON.parse(r.text).connected === true;
}

async function main() {
  const t = checker();
  let ok = true;

  // ── A. Who the handshake lets in ──
  // The check is an ALLOWLIST, not "anything but http(s)": an opaque origin ("null"
  // from <iframe sandbox>) and file:// used to pass, and those are exactly web pages.
  console.log("\n▶ security A: origin allowlist at handshake");
  const A = startServer({ port: 8782 });
  await wait(1300); await A.initialize();

  /** Connect with the given Origin and return whether the connection was accepted. */
  async function accepts(origin) {
    const c = fakeExtension(8782, { origin });
    await wait(700);
    const opened = c.state.opened;
    c.close();
    await wait(250);
    return opened;
  }

  t.check("web origin rejected", (await accepts("https://evil.example")) === false);
  t.check("\"null\" (iframe sandbox, opaque origin) rejected", (await accepts("null")) === false);
  t.check("file:// rejected", (await accepts("file://")) === false);
  t.check("chrome-extension:// accepted", (await accepts("chrome-extension://abcdef")) === true);
  t.check("local process without an Origin header accepted", (await accepts(null)) === true);
  t.check("after all rejections the client is not connected", !(await connected(A)));

  // A client counts as ready only after a valid hello.
  const late = fakeExtension(8782, { protocolVersion: 1 });
  await wait(600);
  t.check("after a valid hello the client is ready", await connected(A));
  late.close(); A.close();
  await wait(400);

  // ── B. With a token ──
  console.log("\n▶ security B: server with DISPATCH_TOKEN=s3cret");
  const B = startServer({ port: 8783, env: { DISPATCH_TOKEN: "s3cret" } });
  await wait(1300); await B.initialize();

  const bad = fakeExtension(8783, { token: "wrong" });
  await wait(700);
  t.check("wrong token is rejected", !(await connected(B)));
  t.check("wrong token → server closed the connection", bad.state.closed, bad.state);

  const empty = fakeExtension(8783, { token: "" });
  await wait(700);
  t.check("empty token is rejected", !(await connected(B)));
  empty.close();
  await wait(300);

  const good = fakeExtension(8783, { token: "s3cret" });
  await wait(700);
  t.check("correct token is accepted", await connected(B));
  good.close(); B.close();
  await wait(400);

  // ── C. A disconnect doesn't leave a command hanging until the timeout (30s) ──
  console.log("\n▶ security C: pending commands on disconnect");
  const C = startServer({ port: 8784 });
  await wait(1300); await C.initialize();

  const mute = fakeExtension(8784, { silent: true }); // accepts the command, never answers
  await wait(600);
  t.check("silent client connected", await connected(C));

  const started = Date.now();
  const hanging = C.callTool("browser_tabs"); // no answer will come
  await wait(300);
  mute.close(); // drop the connection — the command must fail immediately, not after 30s

  const r = await hanging;
  const elapsed = Date.now() - started;
  t.check("command finished fast on disconnect (<5s, not by timeout)", elapsed < 5000, `${elapsed}ms`);
  t.check("command returned an error on disconnect", r.ok === false, r);
  t.check("error explains the cause (disconnect)", /disconnect/i.test(r.text), r.text);
  C.close();

  process.exit(t.done("security") ? 0 : 1);
}
main().catch((e) => { console.error("security crashed:", e); process.exit(1); });
