import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";

// Все логи — только в stderr: stdout занят MCP-протоколом (JSON-RPC).
const log = (...a: unknown[]) => console.error("[dispatch]", ...a);

/** Версия протокола расширение↔сервер; при расхождении major — предупреждаем. */
export const PROTOCOL_VERSION = 1;
/** Если задан DISPATCH_TOKEN — расширение обязано прислать совпадающий токен в hello. */
const REQUIRED_TOKEN = process.env.DISPATCH_TOKEN || "";
/** Пауза перед повторной попыткой занять порт, когда он уже занят. */
const LISTEN_RETRY_MS = Number(process.env.DISPATCH_LISTEN_RETRY_MS || 3000);

/**
 * Сравнение токена за постоянное время: сравниваем sha256-дайджесты, а не строки.
 * Дайджесты всегда по 32 байта, поэтому timingSafeEqual не бросает на разной длине
 * и сама длина токена по времени ответа не утекает.
 */
const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : "").digest();
const tokenMatches = (got: unknown) => timingSafeEqual(digest(REQUIRED_TOKEN), digest(got));

/**
 * Кого пускаем на рукопожатии. Это ALLOWLIST, а не denylist: отсекать только
 * http(s)-origin было недостаточно — любая страница может создать
 * <iframe sandbox="allow-scripts">, у которого origin непрозрачный и браузер
 * шлёт «Origin: null», и такое соединение проходило проверку. ws:// на 127.0.0.1
 * считается potentially trustworthy, так что и mixed-content не мешал.
 *
 * Пускаем: расширение (chrome-extension://…) и локальные процессы, вообще не
 * приславшие Origin. Браузер заголовок Origin ставит ВСЕГДА, поэтому веб-страница
 * (в том числе "null" и "file://") сюда не пролезет. От локальных процессов
 * защищает только DISPATCH_TOKEN.
 */
export function originAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // заголовка нет — не браузер
  return /^chrome-extension:\/\//i.test(origin);
}

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
  private wss!: WebSocketServer;
  private listenRetry: ReturnType<typeof setTimeout> | null = null;
  private client: WebSocket | null = null;
  private clientReady = false; // прошёл ли клиент валидный hello (+ токен)
  private pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Последнее «hello» от расширения (инфо о браузере). */
  public lastHello: unknown = null;

  constructor(public readonly port: number) {
    this.listen();
    if (!REQUIRED_TOKEN) {
      log("ВНИМАНИЕ: DISPATCH_TOKEN не задан — управлять браузером сможет любой " +
          "локальный процесс, подключившийся к этому порту. Задай токен в env сервера " +
          "и то же значение в popup расширения.");
    }
  }

  /**
   * Поднять WS-сервер. Порт один на машину, поэтому второй параллельно
   * запущенный сервер (второе окно редактора, забытый процесс) получает
   * EADDRINUSE. Раньше это роняло мост молча — сервер жил, но расширение
   * подключиться к нему не могло, и browser_status врал про «расширение не
   * подключено». Теперь ждём и пробуем снова: как только порт освободится,
   * мост поднимется сам, без перезапуска сервера.
   */
  private listen() {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
      // Кто вообще имеет право подключиться — см. originAllowed() выше.
      verifyClient: (info, cb) => {
        const origin = info.origin || "";
        if (!originAllowed(origin)) {
          log(`ОТКЛОНЕНО соединение с origin: ${origin}`);
          cb(false, 403, "forbidden origin");
          return;
        }
        cb(true);
      },
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("listening", () => log(`WebSocket слушает ws://127.0.0.1:${this.port}`));
    this.wss.on("error", (e: NodeJS.ErrnoException) => {
      if (e?.code === "EADDRINUSE") {
        if (this.listenRetry) return;
        log(`порт ${this.port} занят другим сервером dispatch — жду освобождения, ` +
            `повтор через ${LISTEN_RETRY_MS} мс`);
        this.listenRetry = setTimeout(() => {
          this.listenRetry = null;
          this.wss.removeAllListeners();
          this.listen();
        }, LISTEN_RETRY_MS);
        this.listenRetry.unref?.();
        return;
      }
      log("WS server error:", e);
    });
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
    // Одно активное соединение: новое вытесняет старое. Проверяем сам факт
    // наличия клиента, а не его readyState: полуоткрытый (CONNECTING/CLOSING)
    // сокет тоже надо вытеснить вместе с его ждущими командами.
    if (this.client) {
      log("новое соединение расширения вытесняет предыдущее");
      try { this.client.close(); } catch { /* noop */ }
      this.failPending("Соединение вытеснено новым подключением расширения");
    }
    this.client = ws;
    this.clientReady = false;
    log("соединение установлено, жду hello…");

    ws.on("message", (buf) => this.onMessage(String(buf), ws));
    ws.on("close", () => {
      if (this.client !== ws) return; // уже вытеснен новым соединением — его команды не трогаем
      this.client = null;
      this.clientReady = false;
      this.failPending("Расширение отключилось");
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
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
        if (REQUIRED_TOKEN && !tokenMatches(data.token)) {
          log("ОТКЛОНЕНО: неверный/отсутствующий токен в hello");
          // Закрываем сокет и отдаём уборку обработчику close: он снимет клиента,
          // отклонит ждущие команды и погасит heartbeat. Команды сюда всё равно не
          // уходили — clientReady остался false, значит connected === false.
          try { ws.close(4001, "bad token"); } catch { /* noop */ }
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
