import { WebSocketServer, WebSocket } from "ws";
import { createServer, get as httpGet, type Server } from "node:http";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// All logs go to stderr only: stdout is reserved for the MCP protocol (JSON-RPC).
const log = (...a: unknown[]) => console.error("[dispatch]", ...a);

/** Extension↔server protocol version; we warn on a major mismatch. */
export const PROTOCOL_VERSION = 1;
/** If DISPATCH_TOKEN is set, the extension must send a matching token in hello. */
const REQUIRED_TOKEN = process.env.DISPATCH_TOKEN || "";
/** Delay before trying again when the port is held by a server we can't join. */
const LISTEN_RETRY_MS = Number(process.env.DISPATCH_LISTEN_RETRY_MS || 3000);
/** Path the hub answers on plain HTTP, so a joining server knows what holds the port. */
const PROBE_PATH = "/dispatch";

/**
 * Constant-time comparison: we compare sha256 digests, not the strings.
 * Digests are always 32 bytes, so timingSafeEqual never throws on a length mismatch
 * and the secret's length itself does not leak through response timing.
 */
const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : "").digest();
const secretMatches = (expected: string, got: unknown) => timingSafeEqual(digest(expected), digest(got));

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
 * the protection is DISPATCH_TOKEN (for the extension) and the peer secret.
 */
export function originAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // no header — not a browser
  return /^chrome-extension:\/\//i.test(origin);
}

/**
 * Secret that lets other Dispatch servers of the SAME OS USER join the hub.
 * Without it, any local process could send commands to the browser through the
 * hub. One file per user, 0600, created once and atomically (write a temp file,
 * hard-link it into place — the link fails if another server got there first).
 */
export function peerSecret(dir = process.env.DISPATCH_STATE_DIR || join(homedir(), ".config", "dispatch")): string {
  const file = join(dir, "peer.secret");
  try { return readFileSync(file, "utf8").trim(); } catch { /* not created yet */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
  try { linkSync(tmp, file); } catch { /* another server created it first — use theirs */ }
  try { unlinkSync(tmp); } catch { /* noop */ }
  return readFileSync(file, "utf8").trim();
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

/**
 * Bridge between this MCP server and the browser extension.
 *
 * There is one browser and one port, but every Claude session (each editor
 * window, each terminal) starts its own MCP server. So the servers share:
 *
 *  - The first one to bind the port is the HUB. The extension connects to it.
 *  - Every later server finds the port taken and joins the hub as a PEER: its
 *    commands are relayed through the hub to the extension and back. All
 *    sessions use the browser at once; none takes it away from another.
 *  - When the hub's session ends, a peer binds the port and becomes the hub;
 *    the others and the extension reconnect to it on their own.
 */
export class Bridge {
  /** "hub" holds the port and the extension; "peer" relays through the hub. */
  public role: "starting" | "hub" | "peer" = "starting";

  // hub side
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null; // the extension
  private clientReady = false; // whether the extension has sent a valid hello (+ token)
  private peers = new Set<WebSocket>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  // peer side
  private hub: WebSocket | null = null;
  private hubState = { connected: false, hello: null as unknown };
  /** Why we can't reach the browser, when it isn't simply "extension not connected". */
  private blocked = "";

  private pending = new Map<string, Pending>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly secret = peerSecret();

  /** The latest "hello" from the extension (browser info). */
  private ownHello: unknown = null;

  constructor(public readonly port: number) {
    this.start();
    if (!REQUIRED_TOKEN) {
      log("WARNING: DISPATCH_TOKEN is not set — any local process that connects to this " +
          "port can pose as the extension. Set the token in the server env " +
          "and the same value in the extension popup.");
    }
  }

  get connected(): boolean {
    if (this.role === "peer") return !!this.hub && this.hub.readyState === WebSocket.OPEN && this.hubState.connected;
    // Ready = socket is open AND a valid hello was received: commands never go to a "half-client".
    return !!this.client && this.client.readyState === WebSocket.OPEN && this.clientReady;
  }

  /** Why the browser can't be reached, beyond "the extension isn't connected". */
  get blockedReason(): string {
    return this.blocked;
  }

  get lastHello(): unknown {
    return this.role === "peer" ? this.hubState.hello : this.ownHello;
  }

  // ── becoming the hub or a peer ──────────────────────────────────────────────

  private start() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.role = "starting";
    const http = createServer((req, res) => {
      if (req.url === PROBE_PATH) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ dispatch: "hub", protocolVersion: PROTOCOL_VERSION }));
      } else {
        res.statusCode = 426;
        res.end();
      }
    });
    const wss = new WebSocketServer({
      server: http,
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
    // ws re-emits the http server's errors on itself; they're handled just below.
    wss.on("error", () => {});
    http.once("error", (e: NodeJS.ErrnoException) => {
      wss.close();
      if (e?.code === "EADDRINUSE") this.join();
      else { log("server error:", e); this.later(); }
    });
    http.listen(this.port, "127.0.0.1", () => {
      this.http = http;
      this.wss = wss;
      this.role = "hub";
      this.blocked = "";
      wss.on("connection", (ws) => this.onConnection(ws));
      log(`hub: listening on ws://127.0.0.1:${this.port}`);
    });
  }

  private later() {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, LISTEN_RETRY_MS);
    this.retry.unref?.();
  }

  /**
   * The port is taken. Ask what holds it before connecting: a server from before
   * hubs existed would treat our connection as the extension's and drop the real
   * one. So we join only a server that answers as a hub.
   */
  private join() {
    const req = httpGet({ host: "127.0.0.1", port: this.port, path: PROBE_PATH, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        let isHub = false;
        try { isHub = JSON.parse(body).dispatch === "hub"; } catch { /* not ours */ }
        if (isHub) this.connectToHub();
        else {
          this.blocked =
            `Port ${this.port} is held by an older Dispatch server (started before an update) that ` +
            `can't share the browser. Close that Claude session or end that process — this one ` +
            `takes over automatically within seconds.`;
          log(this.blocked);
          this.later();
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
    req.on("error", () => this.later()); // the hub just went away — try to bind again
  }

  private connectToHub() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ kind: "peer", secret: this.secret, pid: process.pid }));
      this.hub = ws;
      this.role = "peer";
      this.blocked = "";
      log(`peer: sharing the browser through the hub on port ${this.port}`);
    });
    ws.on("message", (buf) => {
      let msg: any;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (msg.kind === "state") this.hubState = { connected: !!msg.connected, hello: msg.hello ?? null };
      else if (msg.kind === "res") this.settle(msg);
    });
    ws.on("close", (code) => {
      if (this.hub !== ws) { this.later(); return; }
      this.hub = null;
      this.hubState = { connected: false, hello: null };
      this.failPending("The Dispatch hub went away (its Claude session ended); reconnecting — retry the command");
      if (code === 4003) {
        this.blocked = "The Dispatch hub rejected this server: the peer secret doesn't match (different OS user?).";
        log(this.blocked);
        this.later();
        return;
      }
      log("peer: hub disconnected — taking over or rejoining");
      this.start(); // become the hub, or join whoever did
    });
    ws.on("error", () => { /* close follows */ });
  }

  // ── hub: connections from the extension and from peers ─────────────────────

  /**
   * A new connection is classified by its first message: a hello is the
   * extension, a peer message is another Dispatch server. Nothing is replaced
   * before that, so a peer joining never knocks the extension off.
   */
  private onConnection(ws: WebSocket) {
    ws.on("error", (e) => log("WS client error:", e));
    ws.once("message", (buf) => {
      let msg: any;
      try { msg = JSON.parse(String(buf)); } catch { ws.close(); return; }
      if (msg.kind === "peer") this.addPeer(ws, msg);
      else if (msg.kind === "event" && msg.event === "hello") this.addExtension(ws, msg.data || {});
      else ws.close();
    });
  }

  private addPeer(ws: WebSocket, msg: any) {
    if (!secretMatches(this.secret, msg.secret)) {
      log("REJECTED peer: wrong secret");
      try { ws.close(4003, "bad peer secret"); } catch { /* noop */ }
      return;
    }
    this.peers.add(ws);
    log(`hub: peer joined (pid ${msg.pid ?? "?"}), ${this.peers.size} peer(s)`);
    this.sendState(ws);
    ws.on("message", (buf) => this.onPeerMessage(ws, String(buf)));
    ws.on("close", () => { this.peers.delete(ws); log(`hub: peer left, ${this.peers.size} peer(s)`); });
  }

  private onPeerMessage(ws: WebSocket, text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.kind !== "cmd") return;
    const reply = (body: object) => { try { ws.send(JSON.stringify({ kind: "res", id: msg.id, ...body })); } catch { /* peer gone */ } };
    this.send(msg.method, msg.params, msg.timeoutMs)
      .then((result) => reply({ ok: true, result }), (e: Error) => reply({ ok: false, error: e.message }));
  }

  private sendState(ws?: WebSocket) {
    const state = JSON.stringify({ kind: "state", connected: this.connected, hello: this.ownHello });
    for (const p of ws ? [ws] : this.peers) { try { p.send(state); } catch { /* noop */ } }
  }

  private addExtension(ws: WebSocket, data: any) {
    // Token: if the server runs with DISPATCH_TOKEN, the extension must send it.
    if (REQUIRED_TOKEN && !secretMatches(REQUIRED_TOKEN, data.token)) {
      log("REJECTED: invalid/missing token in hello");
      try { ws.close(4001, "bad token"); } catch { /* noop */ }
      return;
    }
    // One extension connection: a new one replaces the old one with its pending commands.
    if (this.client) {
      log("new extension connection replaces the previous one");
      const old = this.client;
      this.client = null;
      try { old.close(); } catch { /* noop */ }
      this.failPending("Connection replaced by a new extension connection");
    }
    if (data.protocolVersion !== PROTOCOL_VERSION) {
      log(`WARNING: extension protocol version = ${data.protocolVersion}, server = ${PROTOCOL_VERSION}`);
    }
    this.client = ws;
    this.clientReady = true;
    this.ownHello = data;
    log("hello accepted:", JSON.stringify({ ...data, token: data.token ? "***" : undefined }));
    this.sendState();

    ws.on("message", (buf) => {
      let msg: any;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (msg.kind === "res") this.settle(msg);
      else if (msg.kind === "event") log(`event ${msg.event}:`, JSON.stringify(msg.data ?? {}).slice(0, 300));
      // kind === "pong" and anything else is ignored.
    });
    ws.on("close", () => {
      if (this.client !== ws) return; // already replaced by a new connection — leave its commands alone
      this.client = null;
      this.clientReady = false;
      this.failPending("Extension disconnected");
      log("extension disconnected");
      this.sendState();
    });

    // The ping keeps the service worker alive (activity resets the MV3 idle timer).
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (this.client && this.clientReady) {
          try { this.client.send(JSON.stringify({ kind: "ping" })); } catch { /* noop */ }
        }
      }, 15000);
      this.heartbeat.unref?.();
    }
  }

  // ── commands ────────────────────────────────────────────────────────────────

  private settle(msg: any) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "extension error"));
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

  /** Send a command to the extension (directly, or through the hub) and wait for the response. */
  send<T = any>(method: string, params: unknown = {}, timeoutMs = 30000): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new Error(this.blocked ||
        "The Dispatch extension is not connected. Open a browser with the extension installed " +
        "and make sure the master toggle in the popup is on."));
    }
    const id = randomUUID();
    const target = this.role === "peer" ? this.hub! : this.client!;
    return new Promise<T>((resolve, reject) => {
      // A peer waits a little longer than the hub, so the hub's own timeout error wins.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command "${method}" timed out (${timeoutMs}ms)`));
      }, this.role === "peer" ? timeoutMs + 2000 : timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      target.send(JSON.stringify({ id, kind: "cmd", method, params, timeoutMs }));
    });
  }
}
