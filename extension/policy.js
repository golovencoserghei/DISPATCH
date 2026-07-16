// Политика доступа Dispatch — чистые функции (юнит-тестируемы без браузера).
// Используется диспетчером background.js для контроля того, что агенту позволено.

// Изменяющие команды: действие на сайте, навигация или произвольный код.
// В режиме read-only они блокируются.
export const MUTATING = new Set([
  "navigate", "open_tab", "close_tab", "click", "type", "press_key", "eval",
]);

export const isMutating = (method) => MUTATING.has(method);

/** Разрешён ли метод в данном режиме ("readonly" | "full"). */
export function methodAllowed(method, mode) {
  if (mode === "readonly") return !MUTATING.has(method);
  return true; // full
}

/**
 * Отбросить порт: allowlist работает по ХОСТУ, порт не различается.
 * "localhost:3000" -> "localhost". IPv6 в скобках ("[::1]") не трогаем.
 */
const stripPort = (h) => String(h || "").trim().toLowerCase().replace(/:\d+$/, "");

/** Совпадение хоста с паттерном allowlist: точное или "*.domain". Порт игнорируется. */
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

/** Разрешён ли хост. Пустой allowlist = разрешено всё. */
export function hostAllowed(host, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((p) => matchHost(host, p));
}

/**
 * Хост URL без порта; null, если хоста нет вообще.
 * Непарсируемый URL бросает, а about:blank / file:/// парсятся с пустым
 * hostname — и то и другое означает «хоста нет», значит allowlist не пройден.
 */
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
}

/** Разрешён ли URL. Пустой allowlist = всё. Непарсируемый URL при непустом = запрет. */
export function urlAllowed(url, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const host = hostOf(url);
  if (host === null) return false;
  return hostAllowed(host, allowlist);
}

/**
 * Разобрать ref из snapshot. Формат "<frameId>:<localRef>" (например "3:e12").
 * Голый ref без префикса относится к верхнему фрейму (frameId 0).
 */
export function parseRef(ref) {
  if (typeof ref === "string") {
    const m = ref.match(/^(\d+):(.+)$/);
    if (m) return { frameId: Number(m[1]), localRef: m[2] };
  }
  return { frameId: 0, localRef: ref || null };
}
