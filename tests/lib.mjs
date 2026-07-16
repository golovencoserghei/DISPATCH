// Общие помощники тестов: запуск MCP-сервера по stdio, фейковое расширение, счётчик.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SRV_DIR = fileURLToPath(new URL("../mcp-server", import.meta.url));
// tsx может лежать в mcp-server/node_modules (обычно) или в корне (при hoisting).
const TSX = fileURLToPath(
  [
    new URL("../mcp-server/node_modules/.bin/tsx", import.meta.url),
    new URL("../node_modules/.bin/tsx", import.meta.url),
  ].find((u) => existsSync(fileURLToPath(u))) ?? new URL("../mcp-server/node_modules/.bin/tsx", import.meta.url),
);

/** Поднять MCP-сервер как дочерний процесс и общаться с ним по stdio (JSON-RPC). */
export function startServer({ port, env } = {}) {
  const srv = spawn(TSX, ["src/index.ts"], {
    cwd: SRV_DIR,
    env: { ...process.env, ...(port ? { DISPATCH_PORT: String(port) } : {}), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = ""; const waiters = []; let id = 0;
  srv.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiters.find((x) => x.id === m.id);
      if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    }
  });
  const rpc = (method, params) => {
    const mid = ++id;
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    return new Promise((r) => waiters.push({ id: mid, resolve: r }));
  };
  const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  async function initialize() {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tests", version: "0" } });
    notify("notifications/initialized");
  }
  async function callTool(name, args) {
    const r = await rpc("tools/call", { name, arguments: args || {} });
    if (r.error) return { ok: false, text: r.error.message };
    const res = r.result || {};
    const text = (res.content || []).find((c) => c.type === "text")?.text ?? "";
    const img = (res.content || []).find((c) => c.type === "image")?.data;
    return { ok: !res.isError, text, img };
  }
  const listTools = async () => (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  return { srv, rpc, notify, initialize, callTool, listTools, close: () => srv.kill() };
}

/**
 * Фейковое «расширение»: подключается к WS-серверу и отвечает на команды.
 * silent=true — принимать команды и НЕ отвечать (для проверки поведения при разрыве).
 */
export function fakeExtension(port, { origin, token = "", protocolVersion = 1, onCommand, silent = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  const state = { opened: false, closed: false };
  ws.on("open", () => {
    state.opened = true;
    ws.send(JSON.stringify({ kind: "event", event: "hello", data: { name: "Dispatch", protocolVersion, token, ua: "test" } }));
  });
  ws.on("close", () => { state.closed = true; });
  ws.on("error", () => { /* ожидаемо при reject origin */ });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.kind === "ping") { ws.send(JSON.stringify({ kind: "pong" })); return; }
    if (m.kind === "cmd") {
      if (silent) return; // команда принята, ответа не будет
      const result = onCommand ? onCommand(m.method, m.params) : { ok: true, echo: m.method };
      ws.send(JSON.stringify({ id: m.id, kind: "res", ok: true, result }));
    }
  });
  return { ws, state, close: () => ws.close() };
}

/** Простой счётчик проверок. */
export function checker(title) {
  let pass = 0, fail = 0;
  if (title) console.log(title);
  return {
    check(name, cond, extra) {
      if (cond) { pass++; console.log(`  ✓ ${name}`); }
      else { fail++; console.log(`  ✗ ${name}`, extra ?? ""); }
    },
    done(label) {
      console.log(`${fail === 0 ? "✅" : "❌"} ${label || "итог"}: ${pass} прошло, ${fail} упало`);
      return fail === 0;
    },
  };
}
