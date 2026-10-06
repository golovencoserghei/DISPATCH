// Smoke test: MCP handshake, tool list, request/response over the WS bridge.
// Needs no browser — uses a fake extension.
import { startServer, fakeExtension, checker, wait } from "./lib.mjs";

const EXPECTED = [
  "browser_status", "browser_tabs", "browser_select_tab", "browser_navigate",
  "browser_open_tab", "browser_close_tab", "browser_snapshot", "browser_get_html",
  "browser_eval", "browser_click", "browser_type", "browser_press_key",
  "browser_scroll", "browser_wait_for", "browser_extract", "browser_screenshot",
  "browser_debug_start", "browser_debug_stop", "browser_console_logs",
  "browser_network", "browser_network_body", "browser_emulate",
];

const PORT = 8781;

async function main() {
  const s = startServer({ port: PORT });
  const t = checker("\n▶ smoke: protocol and bridge");
  await wait(1300);
  await s.initialize();

  const ext = fakeExtension(PORT, {
    onCommand: (method) => {
      if (method === "tabs") return [{ id: 7, title: "Example", url: "https://example.com", active: true, granted: false }];
      if (method === "snapshot") return { ok: true, url: "https://example.com", title: "Example", count: 1, elements: [{ ref: "e1", role: "link", tag: "a", name: "More" }] };
      return { ok: true, echo: method };
    },
  });
  await wait(500);

  const names = await s.listTools();
  const missing = EXPECTED.filter((n) => !names.includes(n));
  t.check(`all ${EXPECTED.length} tools registered`, missing.length === 0, "missing: " + missing.join(", "));

  const st = JSON.parse((await s.callTool("browser_status")).text);
  t.check("browser_status: extension connected", st.connected === true);

  const tabs = await s.callTool("browser_tabs");
  t.check("browser_tabs goes through the bridge", tabs.ok && tabs.text.includes("example.com"));

  const snap = await s.callTool("browser_snapshot");
  t.check("browser_snapshot returns data", snap.ok && JSON.parse(snap.text).count === 1);

  ext.close(); s.close();
  process.exit(t.done("smoke") ? 0 : 1);
}
main().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
