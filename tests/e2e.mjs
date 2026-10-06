// End-to-end: the REAL extension in Chromium, the real MCP server, a real page.
// Branded Chrome 137+ refuses --load-extension next to remote debugging, but
// Chromium and Chrome for Testing still accept both — so this suite needs one of
// those ($DISPATCH_E2E_BROWSER, or `chromium` in PATH) and is skipped otherwise.
//
// DISPATCH_E2E_BACKGROUND=1 runs a visible browser with the agent's tab BEHIND
// the user's tab — the everyday setup, which headless mode can't reproduce
// (in headless every tab renders). Needs a display, so it's for local runs.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startServer, checker, wait } from "./lib.mjs";

const BROWSER = process.env.DISPATCH_E2E_BROWSER || "chromium";
if (spawnSync("which", [BROWSER]).status !== 0) {
  console.log(`\n(e2e skipped — no ${BROWSER}; set $DISPATCH_E2E_BROWSER to Chromium or Chrome for Testing)`);
  process.exit(0);
}

const BACKGROUND = process.env.DISPATCH_E2E_BACKGROUND === "1";
const MCP_PORT = 8795, CDP_PORT = 9566;
const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "dispatch-e2e-"));
const upload = join(tmp, "hello.txt");
writeFileSync(upload, "hello");

const PAGE = `<!doctype html><body style="margin:0;font:14px sans-serif">
<style>#h{width:120px;height:30px}#h:hover{background:rgb(255,0,0)}</style>
<div id="h">hover me</div>
<div id="src" draggable="true" style="width:80px;height:30px;background:#9cf;margin-top:10px">drag</div>
<div id="dst" style="width:120px;height:50px;background:#fc9;margin-top:10px">drop here</div>
<div id="knob" style="position:absolute;left:300px;top:10px;width:24px;height:24px;background:#333"></div>
<select id="color"><option value="r">Red</option><option value="b">Blue</option></select>
<input type="file" id="f">
<button id="ask" onclick="window.answer = confirm('Delete item?')">delete</button>
<button id="name" onclick="window.named = prompt('Your name?')">name</button>
<script>
window.log = [];
src.ondragstart = (e) => e.dataTransfer.setData("text/plain", "card");
dst.ondragover = (e) => e.preventDefault();
dst.ondrop = (e) => { e.preventDefault(); log.push("drop:" + e.dataTransfer.getData("text/plain")); };
let down = false;
knob.onpointerdown = () => { down = true; };
onpointermove = (e) => { if (down) knob.style.left = e.clientX + "px"; };
onpointerup = () => { if (down) { down = false; log.push("slid"); } };
f.onchange = () => log.push("file:" + [...f.files].map((x) => x.name + "/" + x.size).join());
</script></body>`;

const http = createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE); });
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${http.address().port}/`;

const browser = spawn(BROWSER, [
  ...(BACKGROUND ? ["--window-size=1100,800"] : ["--headless=new"]), "--no-sandbox", "--disable-gpu", "--no-first-run",
  `--user-data-dir=${join(tmp, "profile")}`, `--remote-debugging-port=${CDP_PORT}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "about:blank",
], { stdio: "ignore" });
const srv = startServer({ port: MCP_PORT });
const t = checker(`\n▶ e2e: real extension + server + page${BACKGROUND ? " (agent tab in the background)" : ""}`);

function cleanup() { srv.close(); browser.kill(); http.close(); rmSync(tmp, { recursive: true, force: true }); }

/** Evaluate in an extension page — the same chrome.runtime messages the popup sends. */
async function popupSend(extId, messages) {
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?chrome-extension://${extId}/popup.html`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const evaluate = (expression) => new Promise((res) => {
    const mid = ++id;
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id === mid) res(m.result); });
    ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  // The page may still be loading (slower with a visible browser): retry until
  // chrome.runtime is there and the worker answers.
  const replies = [];
  for (const m of messages) {
    let r;
    for (let i = 0; i < 40; i++) {
      r = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
      if (r && !r.exceptionDetails && r.result?.value?.ok) break;
      await wait(250);
    }
    replies.push(r?.result?.value ?? r?.exceptionDetails?.exception?.description ?? r);
  }
  ws.close();
  return replies;
}

async function main() {
  let extId;
  for (let i = 0; i < 40 && !extId; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      extId = list.find((x) => x.type === "service_worker" && x.url.endsWith("/background.js"))?.url.split("/")[2];
    } catch { /* browser still starting */ }
    if (!extId) await wait(250);
  }
  t.check("extension loaded", !!extId);
  await srv.initialize();
  const setup = await popupSend(extId, [{ type: "setPort", value: MCP_PORT }, { type: "setEnabled", value: true }]);
  let status;
  for (let i = 0; i < 30; i++) {
    status = await srv.callTool("browser_status");
    if (status.ok && /"connected": true/.test(status.text)) break;
    await wait(300);
  }
  const connected = status.ok && /"connected": true/.test(status.text);
  if (!connected) {
    // Say why: browser build, what the popup messages got back, the extension's own log.
    const version = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).Browser;
    const [st] = await popupSend(extId, [{ type: "getState" }]);
    console.log("diagnostics:", JSON.stringify({ version, setup, log: st?.log, enabled: st?.enabled, port: st?.port }));
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=e2e diagnostics::${JSON.stringify({ version, setup, log: st?.log?.slice(0, 8), enabled: st?.enabled, port: st?.port }).slice(0, 900)}`);
  }
  t.check("extension connected to the server", connected, status.text);

  const open = await srv.callTool("browser_open_tab", { url: pageUrl, active: !BACKGROUND });
  t.check("opened and granted the test page", open.ok, open.text);
  let userTab = null;
  if (BACKGROUND) {
    userTab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?data:text/html,<h1>user's tab</h1>`, { method: "PUT" })).json();
    await wait(500);
  }
  const agentInFront = async () => JSON.parse((await srv.callTool("browser_tabs")).text).find((x) => x.current).active;
  // Put the user's tab back in front, as if they kept working in it.
  const userToFront = async () => { await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${userTab.id}`); await wait(300); };
  const js = async (expr) => JSON.parse((await srv.callTool("browser_eval", { expression: expr })).text);

  const hv = await srv.callTool("browser_hover", { selector: "#h" });
  t.check("hover: CSS :hover applies", hv.ok && (await js("getComputedStyle(h).backgroundColor")) === "rgb(255, 0, 0)", hv.text);
  if (BACKGROUND) {
    t.check("hover: the agent's tab stays in front (hiding it would drop the hover)", await agentInFront());
    await userToFront();
  }

  const dr = await srv.callTool("browser_drag", { fromSelector: "#src", toSelector: "#dst" });
  t.check("drag: native HTML5 drop delivered", dr.ok && (await js("log")).includes("drop:card"), dr.text);
  const sl = await srv.callTool("browser_drag", { fromSelector: "#knob", toSelector: "#dst" });
  t.check("drag: pointer-driven widget moves", sl.ok && (await js("log")).includes("slid"), sl.text);
  if (BACKGROUND) t.check("drag: the user's tab is back in front", !(await agentInFront()));

  const up = await srv.callTool("browser_upload_file", { selector: "#f", files: [upload] });
  t.check("upload: the page receives the file", up.ok && (await js("log")).includes("file:hello.txt/5"), up.text);
  const missing = await srv.callTool("browser_upload_file", { selector: "#f", files: [join(tmp, "nope.txt")] });
  t.check("upload: missing file rejected by the server", !missing.ok && /no such file/.test(missing.text), missing.text);

  const sel = await srv.callTool("browser_type", { selector: "#color", text: "Blue" });
  t.check("select: option picked by label", sel.ok && (await js("color.value")) === "b", sel.text);

  const yes = await srv.callTool("browser_click", { selector: "#ask", dialog: "accept" });
  t.check("dialog accept: confirm answered and reported", yes.ok && /Delete item\?/.test(yes.text) && (await js("window.answer")) === true, yes.text);
  const no = await srv.callTool("browser_click", { selector: "#ask", dialog: "dismiss" });
  t.check("dialog dismiss", no.ok && (await js("window.answer")) === false, no.text);
  const pr = await srv.callTool("browser_click", { selector: "#name", dialog: "accept", promptText: "Ada" });
  t.check("prompt answered with promptText", pr.ok && (await js("window.named")) === "Ada", pr.text);

  if (BACKGROUND) {
    // Chrome dismisses dialogs that a background tab opens — nothing freezes.
    const bg = await srv.callTool("browser_click", { selector: "#ask" });
    t.check("unarmed dialog in a background tab is dismissed by Chrome", bg.ok && (await js("window.answer")) === false, bg.text);
    return;
  }
  // Last: an unarmed dialog freezes the page for good.
  const t0 = Date.now();
  const frozen = await srv.callTool("browser_click", { selector: "#ask" });
  t.check("unarmed dialog → clear error, fast", !frozen.ok && /dialog/i.test(frozen.text) && Date.now() - t0 < 8000, frozen.text);
}

let ok = false;
try { await main(); ok = t.done("e2e"); }
catch (e) {
  console.error("e2e crashed:", e);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=e2e::crashed: ${String(e && e.stack || e).slice(0, 300).replace(/\n/g, " ")}`);
}
finally { cleanup(); }
process.exit(ok ? 0 : 1);
