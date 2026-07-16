import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

// Все логи — только в stderr: stdout занят MCP-протоколом (JSON-RPC).
const log = (...a: unknown[]) => console.error("[dispatch]", ...a);

/** Версия протокола расширение↔сервер; при расхождении major — предупреждаем. */
export const PROTOCOL_VERSION = 1;
/** Если задан DISPATCH_TOKEN — расширение обязано прислать совпадающий токен в hello. */
const REQUIRED_TOKEN = process.env.DISPATCH_TOKEN || "";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

/**
 * Мост между MCP-сервером и расширением.
 * Поднимает локальный WebSocket-сервер, к которому подключается фоновый
 * service worker расширения. Команды отправляются с уникальным id, ответы
 * сопоставляются по нему (request/response поверх WS).
 */
export class Bridge {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private clientReady = false; // прошёл ли клиент валидный hello (+ токен)
  private pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Последнее «hello» от расширения (инфо о браузере). */
  public lastHello: unknown = null;

  constructor(public readonly port: number) {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port,
      // Отсекаем веб-страницы: любой открытый сайт может постучаться в localhost,
      // но у него Origin = http(s)://… У расширения — chrome-extension://… (или без Origin).
      verifyClient: (info, cb) => {
        const origin = info.origin || "";
        if (/^https?:\/\//i.test(origin)) {
          log(`ОТКЛОНЕНО соединение с веб-origin: ${origin}`);
          cb(false, 403, "forbidden origin");
          return;
        }
        cb(true);
      },
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("error", (e) => log("WS server error:", e));
    log(`WebSocket слушает ws://127.0.0.1:${port}`);
  }

  get connected(): boolean {
    // Готов = сокет открыт И прошёл валидный hello: команды не уходят «полу-клиенту».
    return !!this.client && this.client.readyState === WebSocket.OPEN && this.clientReady;
  }

  /**
   * Отклонить все ждущие команды. Без этого при разрыве связи они висят до
   * своего таймаута (30с), хотя ответить уже некому.
   */
  private failPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${reason} (команда «${p.method}» не выполнена)`));
    }
    this.pending.clear();
  }

  private onConnection(ws: WebSocket) {
    // Одно активное соединение: новое вытесняет старое.
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      log("новое соединение расширения вытесняет предыдущее");
      try { this.client.close(); } catch { /* noop */ }
      this.failPending("Соединение вытеснено новым подключением расширения");
    }
    this.client = ws;
    this.clientReady = false;
    log("соединение установлено, жду hello…");

    ws.on("message", (buf) => this.onMessage(String(buf), ws));
    ws.on("close", () => {
      if (this.client === ws) { this.client = null; this.clientReady = false; }
      this.failPending("Расширение отключилось");
      log("расширение отключилось");
    });
    ws.on("error", (e) => log("WS client error:", e));

    // Пинг поддерживает service worker живым (активность сбрасывает idle-таймер MV3).
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (this.connected) {
          try { this.client!.send(JSON.stringify({ kind: "ping" })); } catch { /* noop */ }
        }
      }, 15000);
    }
  }

  private onMessage(text: string, ws: WebSocket) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.kind === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "ошибка расширения"));
      return;
    }

    if (msg.kind === "event") {
      if (msg.event === "hello") {
        const data = msg.data || {};
        // Токен: если сервер запущен с DISPATCH_TOKEN — расширение обязано прислать его.
        if (REQUIRED_TOKEN && data.token !== REQUIRED_TOKEN) {
          log("ОТКЛОНЕНО: неверный/отсутствующий токен в hello");
          try { ws.close(4001, "bad token"); } catch { /* noop */ }
          if (this.client === ws) { this.client = null; this.clientReady = false; }
          return;
        }
        if (data.protocolVersion !== PROTOCOL_VERSION) {
          log(`ВНИМАНИЕ: версия протокола расширения = ${data.protocolVersion}, сервера = ${PROTOCOL_VERSION}`);
        }
        this.lastHello = data;
        if (this.client === ws) this.clientReady = true;
        log("hello принят:", JSON.stringify({ ...data, token: data.token ? "***" : undefined }));
      } else {
        log(`event ${msg.event}:`, JSON.stringify(msg.data ?? {}).slice(0, 300));
      }
    }
    // kind === "pong" и прочее игнорируем.
  }

  /** Отправить команду расширению и дождаться ответа. */
  send<T = any>(method: string, params: unknown = {}, timeoutMs = 30000): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new Error(
        "Расширение Dispatch не подключено. Открой браузер с установленным расширением " +
        "и убедись, что мастер-тумблер в popup включён.",
      ));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Таймаут команды «${method}» (${timeoutMs}мс)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.client!.send(JSON.stringify({ id, kind: "cmd", method, params }));
    });
  }
}
