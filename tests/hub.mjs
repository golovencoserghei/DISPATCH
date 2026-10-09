// Several Claude sessions, one browser: every session starts its own MCP
// server, and they must all reach the extension — not just whoever got the
// port first. Covers hub/peer relay, failover when the hub's session ends,
// an old (pre-hub) server holding the port, and the peer secret.
import { WebSocket, WebSocketServer } from "ws";
import { startServer, fakeExtension, checker, wait } from "./lib.mjs";

const PORT = 8783;
const env = { DISPATCH_LISTEN_RETRY_MS: "500" };
const t = checker("\n▶ hub: several sessions share one browser");

const status = async (s) => { const r = await s.callTool("browser_status"); return r.ok ? JSON.parse(r.text) : { error: r.text }; };
const tabs = (who) => [{ id: 1, title: `answered for ${who}`, url: "https://example.com", active: true, granted: true }];

async function main() {
  // ── 1. The first server is the hub, the second joins as a peer ──
  const A = startServer({ port: PORT, env });
  await wait(1500); await A.initialize();
  const ext = fakeExtension(PORT, { onCommand: (m) => (m === "tabs" ? tabs("ext") : { ok: true }) });
  await wait(500);
  const B = startServer({ port: PORT, env });
  await wait(1800); await B.initialize();

  const a = await status(A), b = await status(B);
  t.check("first server is the hub", a.role === "hub" && a.connected === true, a);
  t.check("second server joins as a peer and sees the browser", b.role === "peer" && b.connected === true, b);
  t.check("a peer joining doesn't knock the extension off", ext.state.closed === false);

  const viaB = await B.callTool("browser_tabs");
  t.check("a command from the peer reaches the extension", viaB.ok && /answered for ext/.test(viaB.text), viaB.text);
  const [r1, r2] = await Promise.all([A.callTool("browser_tabs"), B.callTool("browser_tabs")]);
  t.check("both sessions work at the same time", r1.ok && r2.ok, { r1: r1.text, r2: r2.text });

  // ── 2. Someone without the peer secret can't drive the browser through the hub ──
  const intruder = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const closeCode = await new Promise((res) => {
    intruder.on("open", () => intruder.send(JSON.stringify({ kind: "peer", secret: "guess" })));
    intruder.on("close", (code) => res(code));
    intruder.on("error", () => {});
  });
  t.check("a peer with the wrong secret is turned away", closeCode === 4003, closeCode);
  t.check("…and the extension stays connected", ext.state.closed === false);

  // ── 3. The hub's session ends: a peer takes over, the extension follows ──
  const C = startServer({ port: PORT, env });
  await wait(1800); await C.initialize();
  t.check("a third session joins too", (await status(C)).role === "peer");
  A.close();
  await wait(1500);
  const roles = [(await status(B)).role, (await status(C)).role].sort();
  t.check("after the hub exits, one peer becomes the hub and the other rejoins it", roles.join() === "hub,peer", roles);
  t.check("the extension's old connection is gone", ext.state.closed === true);
  // The real extension reconnects every 1.5 s; the fake one is simply reconnected.
  const ext2 = fakeExtension(PORT, { onCommand: (m) => (m === "tabs" ? tabs("ext2") : { ok: true }) });
  await wait(600);
  const [b2, c2] = await Promise.all([B.callTool("browser_tabs"), C.callTool("browser_tabs")]);
  t.check("both remaining sessions reach the reconnected extension",
    b2.ok && c2.ok && /ext2/.test(b2.text) && /ext2/.test(c2.text), { b2: b2.text, c2: c2.text });

  // ── 4. A command in flight when the hub dies fails at once, not after 30 s ──
  const hubOf = (await status(B)).role === "hub" ? B : C;
  const peerOf = hubOf === B ? C : B;
  ext2.close();
  const slow = fakeExtension(PORT, { silent: true });
  await wait(600);
  const inFlight = peerOf.callTool("browser_tabs");
  await wait(300);
  const t0 = Date.now();
  hubOf.close();
  const r = await inFlight;
  t.check("in-flight command fails fast when the hub goes away", !r.ok && Date.now() - t0 < 5000, r.text);
  slow.close();
  peerOf.close();
  ext.close();
  await wait(800);

  // ── 5. A server from before hubs holds the port: don't barge in ──
  const OLD_PORT = PORT + 1;
  const old = new WebSocketServer({ host: "127.0.0.1", port: OLD_PORT });
  let oldConnections = 0;
  old.on("connection", () => { oldConnections++; });
  const oldExt = new WebSocket(`ws://127.0.0.1:${OLD_PORT}`, { origin: "chrome-extension://x" });
  await new Promise((r2) => oldExt.on("open", r2));
  const D = startServer({ port: OLD_PORT, env });
  await wait(2500); await D.initialize();
  const d = await status(D);
  t.check("next to an old server: not connected, and says why", d.connected === false && /older Dispatch server/.test(d.hint), d);
  t.check("…without connecting to it (that would drop the real extension)", oldConnections === 1, oldConnections);
  D.close(); oldExt.close(); old.close();
}

let ok = false;
try { await main(); ok = t.done("hub"); }
catch (e) { console.error("hub crashed:", e); }
process.exit(ok ? 0 : 1);
