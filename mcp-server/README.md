# dispatch-browser-mcp

MCP server for **[Dispatch](https://github.com/golovencoserghei/DISPATCH)** —
let your AI agent use your real, logged-in Chrome, with a master switch, host
allowlist, read-only mode and a visible on-page badge.

This package is the server half. You also need the Dispatch Chrome extension —
see the [main README](https://github.com/golovencoserghei/DISPATCH#quick-start).

```bash
claude mcp add dispatch -- npx -y dispatch-browser-mcp
```

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

| Variable | Default | |
|---|---|---|
| `DISPATCH_PORT` | `8765` | Local WebSocket port (set the same in the popup) |
| `DISPATCH_TOKEN` | — | Shared secret (set the same in the popup) |

22 tools: navigation, DOM snapshot with refs, click/type/keys, scroll,
structured extraction, JS eval, screenshots, and a persistent CDP session for
console, network (with response bodies) and device emulation.

MIT licensed.
