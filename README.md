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
| `browser_click` / `browser_type` / `browser_press_key` | Act by `ref` or selector; keys via CDP; `type` also picks `<select>` options. Pass `dialog: "accept"` / `"dismiss"` to answer an alert/confirm/prompt the action opens |
| `browser_hover` | Real mouse-over: reveals menus, tooltips, row actions |
| `browser_drag` | Drag onto a target — kanban cards, sortable lists, sliders, HTML5 drop zones |
| `browser_upload_file` | Put local files into an `<input type=file>` |
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

## How it compares

There are good tools in this space. Here's where Dispatch sits, honestly —
including where others are ahead. Checked against each project's docs and
source on **2026-10-06**; corrections welcome via issue or PR.

✅ yes · ⚠️ partial · ❌ no · — not documented

| | **Dispatch** | [Chrome DevTools MCP][cdm] `--autoConnect` | [Playwright MCP][pwm] `--extension` | [mcp-chrome][mcc] | [Browser MCP][bmc] | [Claude in Chrome][cic] |
|---|---|---|---|---|---|---|
| GitHub stars | new | ~53k | ~38k | ~12.5k | ~7.2k | closed source |
| License | MIT | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0, extension closed | proprietary |
| Last commit | Oct 2026 | Oct 2026 | Sep 2026 | Jan 2026 | Apr 2025 | — |
| Works with any MCP client | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ Claude apps, paid plans |
| Attaches via | extension | CDP remote debugging | extension | extension + native host | extension | extension |
| **Host allowlist** | ✅ enforced, per iframe, re-checked on capture reads | ✅ URL patterns ¹ | ⚠️ origin filter, “not a security boundary” | ❌ | — | ⚠️ admins only (Team/Enterprise) + built-in blocked categories |
| **Read-only mode** | ✅ one switch | ⚠️ disable tool categories via flags | ❌ | ❌ | — | — |
| **Per-action approval** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Kill switch in the UI** | ✅ | ⚠️ turn off remote debugging | ⚠️ disconnect per client | ⚠️ connect/disconnect | ⚠️ connect/disconnect | — |
| **Visible marker** | on-page badge on every reachable tab | Chrome automation banner | tab group + icon badge | Chrome debugging banner | Chrome debugging banner | tab group |
| Tabs the agent can reach | granted tabs; it can add others ⁴, only on allowlisted hosts if a list is set | all tabs of the profile | picked tab group ² | any tab | one connected tab | its tab group |
| Local transport protection | origin allowlist + optional token | Chrome consent dialog per session | consent dialog or token, Host/Origin checks | 127.0.0.1, no auth | all interfaces, no auth ³ | native messaging |
| Network capture with response bodies | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ requests |
| Console logs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Full-page screenshots | ✅ | ✅ | ✅ | ✅ | ❌ visible area | — |
| Device emulation | ✅ device, viewport, UA, geo | ✅ + CPU/network throttling | ⚠️ media, resize | ⚠️ viewport | ❌ | — |
| Hover, drag, file upload, dialogs | ✅ ⁵ | ✅ | ✅ | ✅ | ⚠️ hover | ⚠️ upload |
| Performance traces / Lighthouse | ❌ | ✅ | ⚠️ Playwright traces | ⚠️ perf traces | ❌ | — |
| Tools | 25 | 59 incl. opt-in | 25 (72 with `--caps`) | 27 | 12 | — |
| Chrome Web Store | soon | no extension | ✅ | ❌ unpacked only | ✅ | ✅ |
| Telemetry | none | usage stats on by default (opt-out) | — | — | anonymous analytics per tool call | — |

¹ Allowlist patterns need Chrome 149+.<br>
² The extension's relay doesn't check
that commands target tabs in the group; its own connect dialog warns it
“exposes the entire browser”.<br>
³ [Issue #158][bmc158], closed as not planned.<br>
⁴ Via `browser_select_tab` / `browser_open_tab` — see [Access model](#access-model-in-detail).<br>
⁵ Top frame only; dialogs are answered when the agent says so up front (`dialog: "accept"`).

**Pick Dispatch** if you want to leave an agent connected to your everyday
browser and need hard, visible limits: an allowlist that also covers iframes
and captured traffic, a read-only switch, a badge on every tab the agent can
touch, and a kill switch — with any MCP client, in ~2k lines you can audit.

**Pick something else** if you need per-action approval (Claude in Chrome),
deep performance work — traces, Lighthouse, heap snapshots (Chrome DevTools
MCP), or test generation, tracing/video and network mocking (Playwright MCP).
These are good companions: run Chrome DevTools MCP next to Dispatch when you
need a performance deep-dive.

[cdm]: https://github.com/ChromeDevTools/chrome-devtools-mcp
[pwm]: https://github.com/microsoft/playwright-mcp
[mcc]: https://github.com/hangwin/mcp-chrome
[bmc]: https://github.com/BrowserMCP/mcp
[bmc158]: https://github.com/BrowserMCP/mcp/issues/158
[cic]: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome

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
`press_key`, `eval`, `emulate`, `drag`, `upload_file`. Observation and switching tabs still work, so
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
npm test             # policy, dispatcher, smoke, security, release, e2e, page-functions
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

**How it's tested.** The extension logic lives in `dispatcher.js` behind a
`chrome` facade and is unit-tested against mocks; `page.js` runs in headless
Chrome via the same mechanism `chrome.scripting` uses. `tests/e2e.mjs` then
loads the **real extension** into Chromium, connects it to the real server and
drives a page through MCP (hover, drag, upload, dialogs…). Branded Chrome 137+
refuses `--load-extension` next to remote debugging (otherwise malware could
attach CDP to your browser exactly the way Dispatch does), so e2e needs
Chromium or Chrome for Testing (`$DISPATCH_E2E_BROWSER`) and is skipped
without one.

### Notes

- **JS dialogs.** An `alert`/`confirm`/`prompt` freezes the page, and CDP can
  only answer one that opened while it was already attached. So the agent says
  up front: `browser_click({ selector: "#delete", dialog: "accept" })`. If an
  unexpected dialog freezes the page, commands fail within ~3 s with an error
  that says so, instead of hanging; the user answers it in the browser.
- `browser_hover`, `browser_drag` and `browser_upload_file` work in the top
  frame (mouse coordinates of a cross-origin iframe aren't knowable).
  `hover` is allowed in read-only mode, `drag` and `upload_file` are not.
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
