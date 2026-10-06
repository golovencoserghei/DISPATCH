#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { Bridge } from "./bridge.js";

const PORT = Number(process.env.DISPATCH_PORT || 8765);
const bridge = new Bridge(PORT);

// ../package.json resolves the same from src/ (tsx) and dist/ (published build).
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "dispatch", version });

// ── helpers ─────────────────────────────────────────────────────────────────
function text(obj: unknown) {
  const t = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text" as const, text: t }] };
}

/** Wrapper: turns bridge/extension errors into a human-readable isError response. */
async function guard(fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: "Error: " + (e?.message || String(e)) }],
      isError: true,
    };
  }
}

// There can be several granted tabs (the user grants them in the popup). Page
// commands take an optional tabId: without it they act on the "current" tab,
// with it — on any tab in the granted set, without switching the current one.
const TAB_ID = z.number().int().optional()
  .describe("id of a granted tab (granted=true in browser_tabs); omit = current tab");

// ── tools ─────────────────────────────────────────────────────────────────────
server.registerTool(
  "browser_status",
  {
    description:
      "Connection status: whether the extension is connected, browser info, port. " +
      "Call this first if you are unsure the extension is reachable.",
    inputSchema: {},
  },
  async () =>
    text({
      connected: bridge.connected,
      browser: bridge.lastHello,
      port: PORT,
      hint: bridge.connected
        ? "Ready. Granted tabs are listed in browser_tabs (granted=true); if there are none, grant access to a tab in the popup."
        : "Extension not connected. Check that it is installed and the master toggle is on.",
    }),
);

server.registerTool(
  "browser_tabs",
  {
    description:
      "List open browser tabs: id, title, url, active. granted=true — a granted tab; " +
      "it can be read by tabId (snapshot/get_html/extract/eval/…) without switching; current=true — the current tab, " +
      "which commands without tabId act on. There can be several granted tabs — compare their contents.",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("tabs"))),
);

server.registerTool(
  "browser_select_tab",
  {
    description:
      "Make a tab current (and grant it access if not yet granted) by id from browser_tabs. " +
      "Other granted tabs keep their access. To read another granted tab once, " +
      "there is no need to switch — pass tabId to the command itself.",
    inputSchema: { tabId: z.number().int().describe("tab id from browser_tabs") },
  },
  async ({ tabId }) => guard(async () => text(await bridge.send("select_tab", { tabId }))),
);

server.registerTool(
  "browser_navigate",
  {
    description: "Navigate a granted tab (the current one or the one given by tabId) to a URL and wait for it to load.",
    inputSchema: { url: z.string().describe("Full URL, including https://"), tabId: TAB_ID },
  },
  async ({ url, tabId }) => guard(async () => text(await bridge.send("navigate", { url, tabId }, 60000))),
);

server.registerTool(
  "browser_open_tab",
  {
    description:
      "Open a new tab with a URL and (by default) grant it access and make it current; previously granted " +
      "tabs keep their access. grant=false — open without granting access; active=false — open in the background.",
    inputSchema: {
      url: z.string().optional().describe("URL for the new tab (omit = blank tab)"),
      active: z.boolean().optional().describe("Make it active (default: true)"),
      grant: z.boolean().optional().describe("Grant access to the new tab (default: true)"),
    },
  },
  async ({ url, active, grant }) =>
    guard(async () => text(await bridge.send("open_tab", { url, active, grant }, 60000))),
);

server.registerTool(
  "browser_close_tab",
  {
    description:
      "Close a granted tab (the current one or the one given by tabId). Non-granted tabs cannot be closed: " +
      "tabId must be one of the granted tabs — otherwise grant it access first via browser_select_tab.",
    inputSchema: { tabId: TAB_ID },
  },
  async ({ tabId }) => guard(async () => text(await bridge.send("close_tab", { tabId }))),
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Snapshot of the page's interactive elements: a list with ref, role, name. " +
      "Use ref in browser_click / browser_type. More compact than full HTML. " +
      "Nested frames on hosts outside the allowlist are excluded from the snapshot — their count is in skippedFrames.",
    inputSchema: { tabId: TAB_ID },
  },
  async ({ tabId }) => guard(async () => text(await bridge.send("snapshot", { tabId }))),
);

server.registerTool(
  "browser_get_html",
  {
    description: "Return the outerHTML of the whole page or of a node matched by a CSS selector (truncated to 200K).",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector; omit = whole page"),
      tabId: TAB_ID,
    },
  },
  async ({ selector, tabId }) => guard(async () => text(await bridge.send("get_html", { selector, tabId }))),
);

server.registerTool(
  "browser_eval",
  {
    description:
      "Run JS in the page context (main world, with access to window/DOM) and return the result as JSON. " +
      "Top-level await is NOT supported — use .then(). The return value must be serializable.",
    inputSchema: { expression: z.string().describe("JS expression, e.g. document.title"), tabId: TAB_ID },
  },
  async ({ expression, tabId }) =>
    guard(async () => {
      const r = await bridge.send<{ json: string }>("eval", { expression, tabId });
      return text(r.json);
    }),
);

server.registerTool(
  "browser_click",
  {
    description: "Click an element: either a ref from browser_snapshot or a CSS selector.",
    inputSchema: {
      ref: z.string().optional().describe("ref from snapshot, e.g. e12"),
      selector: z.string().optional().describe("CSS selector (if no ref)"),
      tabId: TAB_ID,
    },
  },
  async ({ ref, selector, tabId }) =>
    guard(async () => text(await bridge.send("click", { ref, selector, tabId }))),
);

server.registerTool(
  "browser_type",
  {
    description: "Type text into a field (input/textarea/contenteditable) by ref or CSS selector.",
    inputSchema: {
      ref: z.string().optional().describe("ref from snapshot"),
      selector: z.string().optional().describe("CSS selector (if no ref)"),
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Submit the form / press Enter after typing"),
      tabId: TAB_ID,
    },
  },
  async ({ ref, selector, text: value, submit, tabId }) =>
    guard(async () => text(await bridge.send("type", { ref, selector, text: value, submit, tabId }))),
);

server.registerTool(
  "browser_wait_for",
  {
    description: "Wait for an element matching a CSS selector to appear (or just wait).",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector to wait for"),
      timeoutMs: z.number().int().optional().describe("Timeout, ms (default 10000)"),
      tabId: TAB_ID,
    },
  },
  async ({ selector, timeoutMs, tabId }) =>
    guard(async () => text(await bridge.send("wait_for", { selector, timeoutMs, tabId }, (timeoutMs ?? 10000) + 5000))),
);

server.registerTool(
  "browser_screenshot",
  {
    description:
      "Screenshot of a granted tab (the current one or the one given by tabId). fullPage=true captures the whole page via CDP " +
      "(the Chrome debugging bar appears temporarily); otherwise only the visible area.",
    inputSchema: { fullPage: z.boolean().optional().describe("Capture the entire page"), tabId: TAB_ID },
  },
  async ({ fullPage, tabId }) =>
    guard(async () => {
      const r = await bridge.send<{ data: string }>("screenshot", { fullPage: !!fullPage, tabId }, 60000);
      return { content: [{ type: "image" as const, data: r.data, mimeType: "image/png" }] };
    }),
);

server.registerTool(
  "browser_scroll",
  {
    description:
      "Scroll the page or a container. toBottom=true — all the way to the bottom (for infinite feeds); " +
      "otherwise by dx/dy pixels. Without selector, scrolls the page itself.",
    inputSchema: {
      selector: z.string().optional().describe("CSS selector of the scroll container"),
      dx: z.number().optional().describe("Horizontal scroll, px"),
      dy: z.number().optional().describe("Vertical scroll, px"),
      toBottom: z.boolean().optional().describe("Scroll to the end"),
      tabId: TAB_ID,
    },
  },
  async ({ selector, dx, dy, toBottom, tabId }) =>
    guard(async () => text(await bridge.send("scroll", { selector, dx, dy, toBottom, tabId }))),
);

server.registerTool(
  "browser_press_key",
  {
    description:
      "Press a key via CDP (more reliable than synthetic DOM events). Special keys: " +
      "Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space. " +
      "A single printable character also works. The key goes to the currently focused element (or to selector, if given).",
    inputSchema: {
      key: z.string().describe("Key, e.g. Enter or a"),
      selector: z.string().optional().describe("CSS selector — focus it before pressing"),
    },
  },
  async ({ key, selector }) =>
    guard(async () => text(await bridge.send("press_key", { key, selector }))),
);

server.registerTool(
  "browser_extract",
  {
    description:
      "Structured data extraction by CSS selectors. fields is a map {name: {selector, attr}}, " +
      "attr defaults to 'text' (also 'html', 'href', 'src' or any attribute). " +
      "multiple=true + container — return an array of objects, one per container element (cards, table rows).",
    inputSchema: {
      container: z.string().optional().describe("Selector of the repeating block (with multiple) or of the scope area"),
      fields: z
        .record(z.object({ selector: z.string().optional(), attr: z.string().optional() }))
        .describe("{ title: {selector:'h2'}, link: {selector:'a', attr:'href'} }"),
      multiple: z.boolean().optional().describe("Collect an array, one entry per container"),
      tabId: TAB_ID,
    },
  },
  async ({ container, fields, multiple, tabId }) =>
    guard(async () => text(await bridge.send("extract", { container, fields, multiple, tabId }))),
);

// ── debugging: network and console capture (persistent CDP session) ──────────────
server.registerTool(
  "browser_debug_start",
  {
    description:
      "Start capturing console and network on the granted tab (opens a CDP session; " +
      "the Chrome debugging banner appears). After this, browser_console_logs and browser_network work. " +
      "Turn it off with browser_debug_stop.",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("debug_start"))),
);

server.registerTool(
  "browser_debug_stop",
  {
    description: "Stop capturing, close the CDP session (removing the debugging banner), and clear the buffers.",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("debug_stop"))),
);

server.registerTool(
  "browser_console_logs",
  {
    description:
      "Read accumulated console logs, unhandled exceptions and browser warnings. " +
      "Requires browser_debug_start. level filters by level (log/info/warn/error).",
    inputSchema: {
      level: z.string().optional().describe("Level filter: log|info|warn|error|debug"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
    },
  },
  async ({ level, clear }) =>
    guard(async () => text(await bridge.send("console_logs", { level, clear }))),
);

server.registerTool(
  "browser_network",
  {
    description:
      "List captured network requests (metadata: method, status, type, size, URL). " +
      "Requires browser_debug_start. filter is a URL substring. Get the response body via browser_network_body.",
    inputSchema: {
      filter: z.string().optional().describe("Keep only requests whose URL contains this substring"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
    },
  },
  async ({ filter, clear }) =>
    guard(async () => text(await bridge.send("network", { filter, clear }))),
);

server.registerTool(
  "browser_network_body",
  {
    description:
      "Response body of a specific request by requestId (from browser_network). " +
      "Works while the debug session is active and the resource has not been evicted from memory. Truncated to 200K.",
    inputSchema: { requestId: z.string().describe("requestId from browser_network") },
  },
  async ({ requestId }) =>
    guard(async () => text(await bridge.send("network_body", { requestId }))),
);

server.registerTool(
  "browser_emulate",
  {
    description:
      "Device/environment emulation via CDP (opens a debug session — the banner is visible). " +
      "Counts as a modifying command: blocked in read-only mode. " +
      "device: 'iPhone 14' | 'Pixel 7' | 'iPad'. Or set viewport / userAgent / geolocation manually. " +
      "reset=true removes all overrides and closes the session.",
    inputSchema: {
      device: z.string().optional().describe("Device preset: iPhone 14 | Pixel 7 | iPad"),
      viewport: z
        .object({
          width: z.number(),
          height: z.number(),
          deviceScaleFactor: z.number().optional(),
          mobile: z.boolean().optional(),
        })
        .optional()
        .describe("Manual viewport size"),
      userAgent: z.string().optional().describe("Override the User-Agent"),
      geolocation: z
        .object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().optional() })
        .optional()
        .describe("Override the geolocation"),
      reset: z.boolean().optional().describe("Remove all emulation and close the debug session"),
    },
  },
  async ({ device, viewport, userAgent, geolocation, reset }) =>
    guard(async () => text(await bridge.send("emulate", { device, viewport, userAgent, geolocation, reset }))),
);

// ── startup ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[dispatch] MCP server ready (WS ws://127.0.0.1:${PORT})`);
