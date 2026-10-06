# Privacy policy — Dispatch browser extension

_Last updated: 2026-10-06_

**Dispatch does not collect, store or send any data to its developers or to
any third party.** It has no analytics, no telemetry and no remote servers.

## What the extension does with data

- It connects only to a WebSocket server **on your own computer**
  (`ws://127.0.0.1`, port of your choice). That server is the Dispatch MCP
  server you run yourself.
- When you turn on the master switch and grant access to a tab, the extension
  reads that tab on request from the local server — page content, screenshots,
  and, if you start debugging, network requests and console output — and sends
  it to the local server.
- The local server passes it to the AI client you configured (for example
  Claude Code or Cursor). **That client may send it to its model provider**
  under the provider's own privacy policy. Dispatch has no control over this;
  don't grant access to tabs with data you don't want to share with it.

## What is stored

Settings only — master switch state, access mode, port, token and host
allowlist — in `chrome.storage.local` on your device. A short log of recent
actions is kept in memory and shown in the popup. Nothing is synced.

## Permissions

- `tabs` — list tabs and their URLs so you and the agent can pick one.
- `scripting` and host access to all sites — read and interact with the pages
  you grant; restricted at runtime by the master switch, your allowlist and
  read-only mode.
- `debugger` — full-page screenshots, key presses, and network/console capture
  via the Chrome DevTools Protocol; Chrome shows its debugging banner while
  this is active.
- `storage` — keep your settings.
- `alarms` — reconnect to the local server after Chrome suspends the extension.

## Contact

Questions: open an issue at https://github.com/golovencoserghei/DISPATCH/issues
