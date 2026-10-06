import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";

// All logs go to stderr only: stdout is reserved for the MCP protocol (JSON-RPC).
const log = (...a: unknown[]) => console.error("[dispatch]", ...a);

/** Extension↔server protocol version; we warn on a major mismatch. */
export const PROTOCOL_VERSION = 1;
/** If DISPATCH_TOKEN is set, the extension must send a matching token in hello. */
const REQUIRED_TOKEN = process.env.DISPATCH_TOKEN || "";
/** Delay before retrying to bind the port when it is already in use. */
const LISTEN_RETRY_MS = Number(process.env.DISPATCH_LISTEN_RETRY_MS || 3000);

/**
 * Constant-time token comparison: we compare sha256 digests, not the strings.
 * Digests are always 32 bytes, so timingSafeEqual never throws on a length mismatch
 * and the token length itself does not leak through response timing.
 */
const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : "").digest();
const tokenMatches = (got: unknown) => timingSafeEqual(digest(REQUIRED_TOKEN), digest(got));

/**
 * Who is admitted at the handshake. This is an ALLOWLIST, not a denylist: rejecting
 * only http(s) origins was not enough — any page can create an
 * <iframe sandbox="allow-scripts">, whose origin is opaque, so the browser sends
 * "Origin: null", and such a connection used to pass the check. ws:// on 127.0.0.1
 * is considered potentially trustworthy, so mixed-content blocking did not stop it either.
 *
 * Admitted: the extension (chrome-extension://…) and local processes that send
 * no Origin at all. Browsers ALWAYS set the Origin header, so a web page
 * (including "null" and "file://") cannot get through. Against local processes
 * the only protection is DISPATCH_TOKEN.
 */
export function originAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // no header — not a browser
  return /^chrome-extension:\/\//i.test(origin);
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

/**
 * Bridge between the MCP server and the extension.
 * Runs a local WebSocket server that the extension's background service worker
 * connects to. Commands are sent with a unique id and responses are matched
 * by it (request/response over WS).
 */
export class Bridge {
  private wss!: WebSocketServer;
  private listenRetry: ReturnType<typeof setTimeout> | null = null;
  private client: WebSocket | null = null;
  private clientReady = false; // whether the client has sent a valid hello (+ token)
  private pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /** The latest "hello" from the extension (browser info). */
  public lastHello: unknown = null;

  constructor(public readonly port: number) {
    this.listen();
    if (!REQUIRED_TOKEN) {
      log("WARNING: DISPATCH_TOKEN is not set — any local process that connects to this " +
          "port can control the browser. Set the token in the server env " +
          "and the same value in the extension popup.");
    }
  }

  /**
   * Start the WS server. There is one port per machine, so a second server
   * running in parallel (another editor window, a forgotten process) gets
   * EADDRINUSE. This used to kill the bridge silently — the server stayed up,
   * but the extension could not connect to it, and browser_status falsely
   * reported "extension not connected". Now we wait and retry: as soon as the
   * port is freed, the bridge comes up by itself, without restarting the server.
   */
  private listen() {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
      // Who is allowed to connect at all — see originAllowed() above.
      verifyClient: (info, cb) => {
        const origin = info.origin || "";
        if (!originAllowed(origin)) {
          log(`REJECTED connection from origin: ${origin}`);
          cb(false, 403, "forbidden origin");
          return;
        }
        cb(true);
      },
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("listening", () => log(`WebSocket listening on ws://127.0.0.1:${this.port}`));
    this.wss.on("error", (e: NodeJS.ErrnoException) => {
      if (e?.code === "EADDRINUSE") {
        if (this.listenRetry) return;
        log(`port ${this.port} is in use by another dispatch server — waiting for it to free up, ` +
            `retrying in ${LISTEN_RETRY_MS} ms`);
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
    // Ready = socket is open AND a valid hello was received: commands never go to a "half-client".
    return !!this.client && this.client.readyState === WebSocket.OPEN && this.clientReady;
  }

  /**
   * Reject all pending commands. Otherwise, on disconnect they hang until
   * their timeout (30s), even though nobody is left to answer.
   */
  private failPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${reason} (command "${p.method}" was not executed)`));
    }
    this.pending.clear();
  }

  private onConnection(ws: WebSocket) {
    // One active connection: a new one replaces the old one. We check whether a
    // client exists at all, not its readyState: a half-open (CONNECTING/CLOSING)
    // socket must also be replaced together with its pending commands.
    if (this.client) {
      log("new extension connection replaces the previous one");
      try { this.client.close(); } catch { /* noop */ }
      this.failPending("Connection replaced by a new extension connection");
    }
    this.client = ws;
    this.clientReady = false;
    log("connection established, waiting for hello…");

    ws.on("message", (buf) => this.onMessage(String(buf), ws));
    ws.on("close", () => {
      if (this.client !== ws) return; // already replaced by a new connection — leave its commands alone
      this.client = null;
      this.clientReady = false;
      this.failPending("Extension disconnected");
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      log("extension disconnected");
    });
    ws.on("error", (e) => log("WS client error:", e));

    // The ping keeps the service worker alive (activity resets the MV3 idle timer).
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
      else p.reject(new Error(msg.error || "extension error"));
      return;
    }

    if (msg.kind === "event") {
      if (msg.event === "hello") {
        const data = msg.data || {};
        // Token: if the server runs with DISPATCH_TOKEN, the extension must send it.
        if (REQUIRED_TOKEN && !tokenMatches(data.token)) {
          log("REJECTED: invalid/missing token in hello");
          // Close the socket and leave cleanup to the close handler: it drops the client,
          // rejects pending commands and stops the heartbeat. No commands were sent here
          // anyway — clientReady stayed false, so connected === false.
          try { ws.close(4001, "bad token"); } catch { /* noop */ }
          return;
        }
        if (data.protocolVersion !== PROTOCOL_VERSION) {
          log(`WARNING: extension protocol version = ${data.protocolVersion}, server = ${PROTOCOL_VERSION}`);
        }
        this.lastHello = data;
        if (this.client === ws) this.clientReady = true;
        log("hello accepted:", JSON.stringify({ ...data, token: data.token ? "***" : undefined }));
      } else {
        log(`event ${msg.event}:`, JSON.stringify(msg.data ?? {}).slice(0, 300));
      }
    }
    // kind === "pong" and anything else is ignored.
  }

  /** Send a command to the extension and wait for the response. */
  send<T = any>(method: string, params: unknown = {}, timeoutMs = 30000): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new Error(
        "The Dispatch extension is not connected. Open a browser with the extension installed " +
        "and make sure the master toggle in the popup is on.",
      ));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command "${method}" timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.client!.send(JSON.stringify({ id, kind: "cmd", method, params }));
    });
  }
}
