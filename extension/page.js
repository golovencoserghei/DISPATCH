// Функции, исполняемые ВНУТРИ страницы через chrome.scripting.executeScript({func}).
// КАЖДАЯ должна быть САМОДОСТАТОЧНОЙ: executeScript сериализует только саму функцию
// (func.toString()), поэтому ссылки на другие функции модуля в странице НЕ существуют.
// Никаких общих хелперов между ними — резолвинг ref/selector встроен в click/type.

export function pageSnapshot() {
  const store = (window.__DISPATCH__ = window.__DISPATCH__ || {});
  store.refs = {};
  let n = 0;
  const out = [];
  const selector =
    "a[href], button, input, select, textarea, [role=button], [role=link], " +
    "[role=checkbox], [role=tab], [role=menuitem], [role=switch], [onclick], " +
    "[contenteditable=true], summary, label";
  const els = document.querySelectorAll(selector);
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const ref = "e" + ++n;
    store.refs[ref] = el;
    const tag = el.tagName.toLowerCase();
    const name = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el.value && String(el.value)) ||
      el.innerText ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      ""
    ).trim().replace(/\s+/g, " ").slice(0, 120);
    const item = { ref, role: el.getAttribute("role") || tag, tag, name };
    if (el.type) item.type = el.type;
    if (el.getAttribute("href")) item.href = el.getAttribute("href");
    out.push(item);
    if (out.length >= 250) break;
  }
  return { ok: true, url: location.href, title: document.title, count: out.length, elements: out };
}

export function pageGetHtml(selector) {
  const el = selector ? document.querySelector(selector) : document.documentElement;
  if (!el) return { ok: false, error: "селектор не найден: " + selector };
  const html = el.outerHTML || "";
  const LIMIT = 200000;
  return { ok: true, html: html.slice(0, LIMIT), truncated: html.length > LIMIT, length: html.length };
}

export async function pageEval(expression) {
  try {
    // eslint-disable-next-line no-eval
    let r = eval(expression);
    if (r && typeof r.then === "function") r = await r;
    let json;
    try { json = JSON.stringify(r) ?? "null"; }
    catch { json = JSON.stringify(String(r)); }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: String((e && e.stack) || e) };
  }
}

export function pageFocus(selector) {
  const el = document.querySelector(selector);
  if (el && el.focus) el.focus();
  return { ok: !!el };
}

export function pageClick(ref, selector) {
  const store = window.__DISPATCH__ || {};
  const el = ref ? (store.refs || {})[ref] : (selector ? document.querySelector(selector) : null);
  if (!el) return { ok: false, error: ref ? `ref ${ref} не найден — сделай browser_snapshot заново` : "элемент не найден по селектору" };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, clicked: (el.innerText || el.value || el.tagName).toString().slice(0, 80) };
}

export function pageType(ref, selector, text, submit) {
  const store = window.__DISPATCH__ || {};
  const el = ref ? (store.refs || {})[ref] : (selector ? document.querySelector(selector) : null);
  if (!el) return { ok: false, error: "элемент не найден" };
  el.focus();
  const isInput = el instanceof HTMLInputElement;
  const isArea = el instanceof HTMLTextAreaElement;
  if (isInput || isArea) {
    const proto = isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text); // нативный сеттер — совместимо с React
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    return { ok: false, error: "элемент не является полем ввода" };
  }
  if (submit) {
    const form = el.form;
    if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  }
  return { ok: true };
}

export async function pageWaitFor(selector, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (!selector || document.querySelector(selector)) {
      return { ok: true, found: true, elapsedMs: Date.now() - start };
    }
    if (Date.now() - start >= timeoutMs) {
      return { ok: false, error: `элемент «${selector}» не появился за ${timeoutMs}мс`, found: false };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function pageExtract(container, fields, multiple) {
  function mapFields(root) {
    const obj = {};
    for (const key in fields) {
      const spec = fields[key] || {};
      const el = spec.selector ? root.querySelector(spec.selector) : root;
      if (!el) { obj[key] = null; continue; }
      const attr = spec.attr || "text";
      if (attr === "text") obj[key] = (el.innerText || el.textContent || "").trim();
      else if (attr === "html") obj[key] = el.innerHTML;
      else if (attr === "href" || attr === "src") obj[key] = el[attr] || el.getAttribute(attr);
      else obj[key] = el.getAttribute(attr);
    }
    return obj;
  }
  try {
    if (multiple) {
      const roots = container ? document.querySelectorAll(container) : [document.body];
      const items = Array.from(roots).map(mapFields);
      return { ok: true, count: items.length, items };
    }
    const root = container ? document.querySelector(container) : document.body;
    if (!root) return { ok: false, error: "container не найден: " + container };
    return { ok: true, item: mapFields(root) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Шильдик «эта вкладка под контролем агента»: маленькая плашка в правом нижнем
 * углу. mode = "full" | "readonly", либо null — снять шильдик.
 * Живёт в Shadow DOM (стили страницы его не трогают, и он не мусорит в
 * get_html), не ловит мышь (pointer-events:none) и не попадает в snapshot —
 * поэтому агенту не мешает.
 */
export function pageShield(mode) {
  const ID = "__dispatch_shield__";
  const old = document.getElementById(ID);
  if (!mode) { old?.remove(); return { ok: true, shield: false }; }
  if (!document.body) return { ok: true, shield: false, note: "нет body" };

  const host = old || document.createElement("div");
  if (!old) {
    host.id = ID;
    host.setAttribute("data-dispatch-shield", "");
    host.attachShadow({ mode: "open" });
    (document.body || document.documentElement).appendChild(host);
  }
  const full = mode !== "readonly";
  host.shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .s {
        position: fixed; right: 10px; bottom: 10px; z-index: 2147483647;
        display: flex; align-items: center; gap: 6px;
        padding: 4px 9px; border-radius: 999px;
        font: 500 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #fff; background: ${full ? "rgba(28,110,50,.92)" : "rgba(60,70,85,.92)"};
        box-shadow: 0 2px 8px rgba(0,0,0,.28);
        pointer-events: none; user-select: none;
      }
      .d { width: 7px; height: 7px; border-radius: 50%; background: ${full ? "#7ee08a" : "#aab4c4"}; }
    </style>
    <div class="s"><span class="d"></span>Dispatch · ${full ? "полный доступ" : "только чтение"}</div>
  `;
  return { ok: true, shield: true, mode: full ? "full" : "readonly" };
}

export function pageScroll(selector, dx, dy, toBottom) {
  const el = selector ? document.querySelector(selector) : (document.scrollingElement || document.documentElement);
  if (!el) return { ok: false, error: "элемент прокрутки не найден" };
  if (toBottom) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  else el.scrollBy({ left: dx || 0, top: dy || 0, behavior: "auto" });
  return { ok: true, scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}
