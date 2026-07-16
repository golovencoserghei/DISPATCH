// Юнит-тест политики доступа (extension/policy.js) — чистые функции, без браузера.
import { methodAllowed, matchHost, hostAllowed, urlAllowed, hostOf, isMutating, parseRef } from "../extension/policy.js";
import { checker } from "./lib.mjs";

const t = checker("\n▶ policy: модель доступа");

// режим read-only
t.check("readonly блокирует click", methodAllowed("click", "readonly") === false);
t.check("readonly блокирует eval", methodAllowed("eval", "readonly") === false);
t.check("readonly блокирует navigate", methodAllowed("navigate", "readonly") === false);
t.check("readonly блокирует open_tab", methodAllowed("open_tab", "readonly") === false);
t.check("readonly пускает snapshot", methodAllowed("snapshot", "readonly") === true);
t.check("readonly пускает screenshot", methodAllowed("screenshot", "readonly") === true);
t.check("readonly пускает scroll", methodAllowed("scroll", "readonly") === true);
t.check("readonly пускает network", methodAllowed("network", "readonly") === true);
t.check("full пускает click", methodAllowed("click", "full") === true);
t.check("full пускает eval", methodAllowed("eval", "full") === true);

// matchHost
t.check("точный хост совпал", matchHost("example.com", "example.com") === true);
t.check("точный хост не совпал", matchHost("evil.com", "example.com") === false);
t.check("*.domain матчит поддомен", matchHost("api.example.com", "*.example.com") === true);
t.check("*.domain матчит корень", matchHost("example.com", "*.example.com") === true);
t.check("*.domain не матчит чужой", matchHost("example.org", "*.example.com") === false);

// порты: allowlist работает по хосту, порт не различается
t.check("хост с портом матчит паттерн без порта", matchHost("localhost:3000", "localhost") === true);
t.check("паттерн с портом матчит хост без порта", matchHost("localhost", "localhost:3000") === true);
t.check("порт не делает чужой хост своим", matchHost("evil.com:3000", "localhost") === false);
t.check("*.domain матчит поддомен с портом", matchHost("api.example.com:8443", "*.example.com") === true);
t.check("IPv6 не ломается при срезании порта", matchHost("[::1]", "[::1]") === true);
t.check("URL с портом проходит allowlist", urlAllowed("http://localhost:3000/x", ["localhost"]) === true);

// hostOf
t.check("hostOf отдаёт хост без порта", hostOf("http://localhost:3000/x") === "localhost");
t.check("hostOf приводит к нижнему регистру", hostOf("https://EXAMPLE.com/") === "example.com");
t.check("hostOf на about:blank = null (хоста нет)", hostOf("about:blank") === null);
t.check("hostOf на file:/// = null (хоста нет)", hostOf("file:///tmp/x.html") === null);
t.check("hostOf на мусоре = null", hostOf("не-url") === null);

// hostAllowed / urlAllowed
t.check("пустой allowlist = всё разрешено", hostAllowed("any.com", []) === true);
t.check("allowlist пускает свой хост", urlAllowed("https://example.com/x", ["example.com"]) === true);
t.check("allowlist блокирует чужой хост", urlAllowed("https://evil.com/x", ["example.com"]) === false);
t.check("непарсируемый URL при непустом allowlist = запрет", urlAllowed("about:blank", ["example.com"]) === false);

// isMutating
t.check("isMutating(type) = true", isMutating("type") === true);
t.check("isMutating(snapshot) = false", isMutating("snapshot") === false);

// parseRef (iframe-адресация)
t.check("parseRef фрейм '3:e12'", (() => { const r = parseRef("3:e12"); return r.frameId === 3 && r.localRef === "e12"; })());
t.check("parseRef голый ref = top", (() => { const r = parseRef("e5"); return r.frameId === 0 && r.localRef === "e5"; })());
t.check("parseRef с ':' в selector-подобном", (() => { const r = parseRef("0:e1"); return r.frameId === 0 && r.localRef === "e1"; })());
t.check("parseRef null безопасен", parseRef(null).frameId === 0);

process.exit(t.done("policy") ? 0 : 1);
