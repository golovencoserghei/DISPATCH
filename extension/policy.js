// Dispatch access policy — pure functions (unit-testable without a browser).
// Used by the background.js dispatcher to decide what the agent is allowed to do.

// Mutating commands: an action on the site, navigation, or arbitrary code.
// They are blocked in read-only mode.
//
// "emulate" is here on purpose: overriding viewport/User-Agent/geolocation is
// an ACTION — the page starts seeing a different environment. Emulation cannot
// be cleared from read-only; use the "Stop debugging" button in the popup.
//
// "hover" is deliberately NOT here: like scroll, it only reveals what the page
// already shows on mouse-over (menus, tooltips) and submits nothing.
export const MUTATING = new Set([
  "navigate", "open_tab", "close_tab", "click", "type", "press_key", "eval", "emulate",
  "drag", "upload_file",
]);

export const isMutating = (method) => MUTATING.has(method);

/** Whether the method is allowed in the given mode ("readonly" | "full"). */
export function methodAllowed(method, mode) {
  if (mode === "readonly") return !MUTATING.has(method);
  return true; // full
}

/**
 * Drop the port: the allowlist works on the HOST, ports are not distinguished.
 * "localhost:3000" -> "localhost". Bracketed IPv6 ("[::1]") is left alone.
 */
const stripPort = (h) => String(h || "").trim().toLowerCase().replace(/:\d+$/, "");

/** Match a host against an allowlist pattern: exact or "*.domain". Port is ignored. */
export function matchHost(host, pattern) {
  pattern = stripPort(pattern);
  if (!pattern) return false;
  host = stripPort(host);
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === pattern;
}

/** Whether the host is allowed. Empty allowlist = everything allowed. */
export function hostAllowed(host, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((p) => matchHost(host, p));
}

/**
 * Host of a URL without the port; null if there is no host at all.
 * An unparseable URL throws, while about:blank / file:/// parse with an empty
 * hostname — both mean "no host", so the allowlist check fails.
 */
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
}

/** Whether the URL is allowed. Empty allowlist = everything. Unparseable URL with a non-empty one = denied. */
export function urlAllowed(url, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const host = hostOf(url);
  if (host === null) return false;
  return hostAllowed(host, allowlist);
}

/**
 * Parse a ref from a snapshot. Format "<frameId>:<localRef>" (e.g. "3:e12").
 * A bare ref without a prefix refers to the top frame (frameId 0).
 */
export function parseRef(ref) {
  if (typeof ref === "string") {
    const m = ref.match(/^(\d+):(.+)$/);
    if (m) return { frameId: Number(m[1]), localRef: m[2] };
  }
  return { frameId: 0, localRef: ref || null };
}
