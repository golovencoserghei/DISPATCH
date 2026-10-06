// Unit test of the access policy (extension/policy.js) — pure functions, no browser.
import { methodAllowed, matchHost, hostAllowed, urlAllowed, hostOf, isMutating, parseRef } from "../extension/policy.js";
import { checker } from "./lib.mjs";

const t = checker("\n▶ policy: access model");

// read-only mode
t.check("readonly blocks click", methodAllowed("click", "readonly") === false);
t.check("readonly blocks eval", methodAllowed("eval", "readonly") === false);
t.check("readonly blocks navigate", methodAllowed("navigate", "readonly") === false);
t.check("readonly blocks open_tab", methodAllowed("open_tab", "readonly") === false);
t.check("readonly allows snapshot", methodAllowed("snapshot", "readonly") === true);
t.check("readonly allows screenshot", methodAllowed("screenshot", "readonly") === true);
t.check("readonly allows scroll", methodAllowed("scroll", "readonly") === true);
t.check("readonly allows network", methodAllowed("network", "readonly") === true);
// Emulation changes what the page sees (viewport/UA/geolocation) — that's an action.
t.check("readonly blocks emulate", methodAllowed("emulate", "readonly") === false);
t.check("readonly blocks drag", methodAllowed("drag", "readonly") === false);
t.check("readonly blocks upload_file", methodAllowed("upload_file", "readonly") === false);
t.check("readonly allows hover (reveals only, like scroll)", methodAllowed("hover", "readonly") === true);
t.check("readonly allows debug_start (observation)", methodAllowed("debug_start", "readonly") === true);
t.check("readonly allows console_logs", methodAllowed("console_logs", "readonly") === true);
t.check("full allows click", methodAllowed("click", "full") === true);
t.check("full allows eval", methodAllowed("eval", "full") === true);
t.check("full allows emulate", methodAllowed("emulate", "full") === true);

// matchHost
t.check("exact host matches", matchHost("example.com", "example.com") === true);
t.check("exact host does not match", matchHost("evil.com", "example.com") === false);
t.check("*.domain matches a subdomain", matchHost("api.example.com", "*.example.com") === true);
t.check("*.domain matches the root", matchHost("example.com", "*.example.com") === true);
t.check("*.domain does not match a foreign host", matchHost("example.org", "*.example.com") === false);

// ports: the allowlist works on the host, ports are not distinguished
t.check("host with port matches a pattern without port", matchHost("localhost:3000", "localhost") === true);
t.check("pattern with port matches a host without port", matchHost("localhost", "localhost:3000") === true);
t.check("a port does not make a foreign host allowed", matchHost("evil.com:3000", "localhost") === false);
t.check("*.domain matches a subdomain with port", matchHost("api.example.com:8443", "*.example.com") === true);
t.check("IPv6 survives port stripping", matchHost("[::1]", "[::1]") === true);
t.check("URL with port passes the allowlist", urlAllowed("http://localhost:3000/x", ["localhost"]) === true);

// hostOf
t.check("hostOf returns the host without port", hostOf("http://localhost:3000/x") === "localhost");
t.check("hostOf lowercases", hostOf("https://EXAMPLE.com/") === "example.com");
t.check("hostOf on about:blank = null (no host)", hostOf("about:blank") === null);
t.check("hostOf on file:/// = null (no host)", hostOf("file:///tmp/x.html") === null);
t.check("hostOf on garbage = null", hostOf("not-a-url") === null);

// hostAllowed / urlAllowed
t.check("empty allowlist = everything allowed", hostAllowed("any.com", []) === true);
t.check("allowlist allows a listed host", urlAllowed("https://example.com/x", ["example.com"]) === true);
t.check("allowlist blocks a foreign host", urlAllowed("https://evil.com/x", ["example.com"]) === false);
t.check("unparseable URL with a non-empty allowlist = denied", urlAllowed("about:blank", ["example.com"]) === false);

// isMutating
t.check("isMutating(type) = true", isMutating("type") === true);
t.check("isMutating(emulate) = true", isMutating("emulate") === true);
t.check("isMutating(snapshot) = false", isMutating("snapshot") === false);

// parseRef (iframe addressing)
t.check("parseRef frame '3:e12'", (() => { const r = parseRef("3:e12"); return r.frameId === 3 && r.localRef === "e12"; })());
t.check("parseRef bare ref = top", (() => { const r = parseRef("e5"); return r.frameId === 0 && r.localRef === "e5"; })());
t.check("parseRef with ':' in a selector-like ref", (() => { const r = parseRef("0:e1"); return r.frameId === 0 && r.localRef === "e1"; })());
t.check("parseRef null is safe", parseRef(null).frameId === 0);

process.exit(t.done("policy") ? 0 : 1);
