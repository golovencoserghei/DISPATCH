# Security policy

Dispatch hands an AI agent a logged-in browser, so security reports are the
most valuable contribution you can make.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository. You'll get a reply
within a few days; fixes for confirmed issues ship as a patch release with
credit to the reporter (unless you prefer otherwise).

## In scope

- Anything that lets the agent act **outside the allowlist**, act in
  **read-only** mode, or reach the browser while the **master switch** is off.
- A web page, iframe or other non-local origin connecting to the local
  WebSocket, or a client getting commands before a valid `hello`.
- Bypassing the `DISPATCH_TOKEN` check.
- The on-page badge missing on a tab the agent can act on.
- Captured network/console data from a host outside the allowlist reaching the
  agent.

## Known limits (by design, documented)

- Without `DISPATCH_TOKEN`, any local process can connect to the port.
- Any local process that knows the token is equivalent to the extension.
- Another extension in the same browser has a `chrome-extension://` origin and
  passes the origin check; the token is the boundary.
- With an **empty allowlist** the agent may switch to any tab — the allowlist,
  not the “granted” set, is the hard boundary.
- Everything a granted tab shows is sent to the model provider of your MCP
  client.
