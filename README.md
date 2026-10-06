<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="Dispatch icon">
</p>

<h1 align="center">Dispatch</h1>

<p align="center">
  <b>Let your AI agent use your real browser — and stay in control of it.</b><br>
  A Chrome extension + MCP server for Claude Code, Claude Desktop, Cursor, VS Code and any other MCP client.
</p>

<p align="center">
  <a href="https://github.com/golovencoserghei/DISPATCH/actions/workflows/ci.yml"><img src="https://github.com/golovencoserghei/DISPATCH/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/dispatch-browser-mcp"><img src="https://img.shields.io/npm/v/dispatch-browser-mcp" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
  <a href="README.ru.md">Русская версия</a>
</p>

<!-- DEMO: replace with a 20–30 s GIF — agent opens a logged-in page, snapshots it, clicks, reads network; then the user flips read-only and the next click is refused. -->

Headless browsers can't see your logged-in dashboards, SSO-protected tools or
2FA-gated admin panels. Dispatch gives the agent **your actual Chrome profile**:
it reads the DOM, clicks, types, takes screenshots and inspects network traffic
and console — on the tabs you choose.

Handing an agent your logged-in browser is a big deal, so Dispatch is built
around **guardrails you can see and flip at any moment**:

| Guardrail | What it does |
|---|---|
| 🔴 **Master switch** | Off = the WebSocket is closed. The agent can't even list tabs. |
| 🌐 **Host allowlist** | Outside the list the agent can't switch to a tab, navigate, open, read or act — checked per host, **per iframe**, and re-checked on every network/console read. |
| 👁 **Read-only mode** | The agent observes (snapshot, screenshot, network, console) but can't click, type, navigate, run JS or emulate. |
| 🏷 **On-page badge** | Every tab the agent can touch shows a small “Dispatch · full access / read-only” label. No hidden access. |
| 🔒 **Locked-down transport** | Local WebSocket only; origin allowlist on the handshake (web pages, `null` and `file://` origins are refused); optional shared token compared in constant time. |
| 📜 **Action log** | The popup shows what the agent did recently. |

## Quick start

**1. Install the extension**

- Chrome Web Store: *coming soon*
- Or download `dispatch-extension-v*.zip` from [Releases](https://github.com/golovencoserghei/DISPATCH/releases), unzip it, open `chrome://extensions`, enable **Developer mode** → **Load unpacked** → pick the folder.

**2. Add the MCP server to your client**

Claude Code:

```bash
claude mcp add dispatch -- npx -y dispatch-browser-mcp
```

Claude Desktop / Cursor / VS Code / anything that takes an `mcpServers` config:

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "npx",
      "args": ["-y", "dispatch-browser-mcp"],
      "env": { "DISPATCH_TOKEN": "pick-a-long-random-string" }
    }
  }
}
```

**3. Grant access**

Open the Dispatch popup → turn on the **Master switch** → paste the same token →
on the tab you want to work with, click **Grant access to this tab**. Then ask
your agent something like *“look at the open tab and summarize the failed
requests”*.

> Without `DISPATCH_TOKEN` any local process could connect to the port; the
> server prints a warning on start. Set a token on any machine you share.

## What the agent can do

**Pages and DOM**

| Tool | |
|---|---|
| `browser_status` | Connection, granted tabs, debug session state |
| `browser_tabs` | Open tabs (`granted` / `current` flags) |
| `browser_select_tab` | Make a tab current (within the allowlist) |
| `browser_open_tab` / `browser_close_tab` | Open a new tab / close a granted one |
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Interactive elements with `ref`s, across same-allowlist iframes |
| `browser_get_html` | outerHTML of the page or a node |
| `browser_extract` | Structured scraping by CSS selectors (cards, table rows) |
| `browser_eval` | Run JS in the page, get JSON back |
| `browser_click` / `browser_type` / `browser_press_key` | Act by `ref` or selector; keys via CDP |
| `browser_scroll` / `browser_wait_for` | Scroll (incl. infinite feeds), wait for a selector |
| `browser_screenshot` | Visible area or full page |

**Debugging (persistent CDP session)**

| Tool | |
|---|---|
| `browser_debug_start` / `browser_debug_stop` | Start/stop capturing console and network |
| `browser_console_logs` | Console output, exceptions, browser warnings |
| `browser_network` | Captured requests (method, status, type, size, URL) |
| `browser_network_body` | Response body by `requestId` |
| `browser_emulate` | Device, viewport, user agent, geolocation |

Page tools take an optional `tabId`, so you can hand the agent several tabs at
once (e.g. *“compare pricing on these three tabs”*).

## Why Dispatch

- **Your real session.** Works where headless dies: SSO, 2FA, CAPTCHAs you
  already passed, internal tools, browser extensions you rely on.
- **Guardrails first.** Allowlist, read-only and the kill switch are enforced in
  the extension, not by asking the model nicely.
- **Built for debugging, not just clicking.** Response bodies, console and
  exceptions from a live, logged-in page — useful for “why does this request
  fail for my account?”.
- **Small and auditable.** ~2k lines, no build step for the extension, no
  telemetry, no remote servers. You can read all of it before trusting it with
  your browser.
- **Tested without a browser.** The extension core sits behind a `chrome`
  facade and runs in Node against mocks; page functions run against headless
  Chrome in CI.

## Access model in detail

There are exactly two hard boundaries: the **master switch** and the
**allowlist**.

- **Switch off** — nothing is reachable, not even the tab list.
- **Switch on, allowlist empty** — the agent may switch to **any** tab, open
  any URL and read it. “Granted” tabs are the agent's working set, not a
  per-tab permission: the agent can extend it with `browser_select_tab`. If
  that's not what you want, fill in the allowlist.
- **Switch on, allowlist set** — the real boundary. Outside the list the agent
  can't switch to a tab, navigate, open a tab (even a blank one) or act on an
  already open one. Matching is by **host** (`localhost` covers
  `localhost:3000`, `*.example.com` covers subdomains; `about:blank` and
  `file://` have no host and are refused).
  - **iframes are checked separately**: off-list frames are left out of
    `browser_snapshot` (counted in `skippedFrames`), and clicks/typing into
    them are refused.
  - **Interception stops when a tab leaves the allowlist**: the debug session
    is closed and its buffers cleared; network/console reads are re-checked
    against the allowlist every time.

**Read-only** blocks `navigate`, `open_tab`, `close_tab`, `click`, `type`,
`press_key`, `eval`, `emulate`. Observation and switching tabs still work, so
read-only ≠ “one tab only”.

`browser_close_tab` closes only granted tabs.

**Everything a granted tab shows (DOM, screenshots, network) is sent to the
model.** Don't grant tabs with data you don't want the model provider to see.

### What the transport protects against — and what it doesn't

- Web pages can't connect: the handshake only accepts `chrome-extension://…`
  origins and clients with no `Origin` header (local processes). Even a
  sandboxed iframe with `Origin: null` is refused.
- Commands go to the client only after a valid `hello`; protocol version is
  checked.
- **Local processes are stopped only by the token**: any process on your
  machine can omit or fake `Origin`. Another extension in the same browser also
  has a `chrome-extension://` origin. The token is the threshold.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Configuration

| Variable | Default | |
|---|---|---|
| `DISPATCH_PORT` | `8765` | Local WebSocket port; set the same port in the popup |
| `DISPATCH_TOKEN` | — | Shared secret; set the same value in the popup |

## Development

```bash
npm install          # root + mcp-server (postinstall)
npm run typecheck
npm test             # policy, dispatcher, smoke, security, release, page-functions
npm run build        # compile the MCP server to mcp-server/dist
npm run pack:extension
```

Run the server from source in your MCP client by pointing it at
`mcp-server/node_modules/.bin/tsx` with `mcp-server/src/index.ts` as the
argument. Run `tsx` directly rather than `npm run dev`: `tsx` forwards SIGTERM
so the port is released on shutdown.

```
MCP client (Claude, Cursor, …)
   │  stdio (MCP)
   ▼
mcp-server (Node/TS) ── ws://127.0.0.1:8765
   ▲
   │  WebSocket
   ▼
extension (MV3) ── background.js  thin binding to the real chrome.* API
                   dispatcher.js  core: connection, access gate, commands, CDP
                   policy.js      pure access rules
                   page.js        functions injected into the page
```

**Why the real extension isn't loaded in CI:** Chrome 137+ deliberately ignores
`--load-extension` when remote debugging is enabled (otherwise malware could
attach CDP to your browser exactly the way Dispatch does). So the extension
logic lives in `dispatcher.js` behind a `chrome` facade and is tested against
mocks, and `page.js` runs in headless Chrome via the same mechanism
`chrome.scripting` uses. Only the thin `background.js` binding is left to
`tests/manual/`.

### Notes

- `ref`s in iframes look like `<frameId>:<localRef>` (e.g. `3:e12`);
  `eval`/`get_html` run in the top frame.
- Chrome shows its “being debugged” banner while a CDP session is open. For
  full-page screenshots and `press_key` it's opened for a split second; for
  `debug_start`/`emulate` it stays until `browser_debug_stop` or **Stop
  debugging** in the popup.
- Capture buffers are ring buffers (500 entries each) in service worker memory.
- `browser_eval` has no top-level `await`; use `.then()`. Return values must be
  JSON-serializable.
- MV3 service workers may be suspended when idle; the server pings every 15 s
  and the extension reconnects automatically.
- `EADDRINUSE` on start means another server holds the port — stop it or pick
  another `DISPATCH_PORT` (and set it in the popup).

## License

[MIT](LICENSE)
