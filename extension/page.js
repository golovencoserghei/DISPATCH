// Functions executed INSIDE the page via chrome.scripting.executeScript({func}).
// EACH must be SELF-CONTAINED: executeScript serializes only the function itself
// (func.toString()), so references to other module functions do NOT exist in the page.
// No shared helpers between them — ref/selector resolution is inlined into click/type.

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
  if (!el) return { ok: false, error: "selector not found: " + selector };
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
  if (!el) return { ok: false, error: ref ? `ref ${ref} not found — take a fresh browser_snapshot` : "no element matches the selector" };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, clicked: (el.innerText || el.value || el.tagName).toString().slice(0, 80) };
}

export function pageType(ref, selector, text, submit) {
  const store = window.__DISPATCH__ || {};
  const el = ref ? (store.refs || {})[ref] : (selector ? document.querySelector(selector) : null);
  if (!el) return { ok: false, error: "element not found" };
  el.focus();
  if (el instanceof HTMLSelectElement) {
    // <select>: text is the option's value or its visible label.
    const want = String(text).trim();
    const opts = Array.from(el.options);
    const opt = opts.find((o) => o.value === want) || opts.find((o) => o.text.trim() === want);
    if (!opt) {
      return { ok: false, error: `no option "${want}". Options: ${opts.slice(0, 30).map((o) => o.text.trim()).join(" | ")}` };
    }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: opt.text.trim() };
  }
  const isInput = el instanceof HTMLInputElement;
  const isArea = el instanceof HTMLTextAreaElement;
  if (isInput || isArea) {
    const proto = isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text); // native setter — React-compatible
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    return { ok: false, error: "element is not an input field" };
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
      return { ok: false, error: `element "${selector}" did not appear within ${timeoutMs}ms`, found: false };
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
    if (!root) return { ok: false, error: "container not found: " + container };
    return { ok: true, item: mapFields(root) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * "This tab is controlled by an agent" badge: a small pill in the bottom-right
 * corner. mode = "full" | "readonly", or null to remove the badge.
 * Lives in Shadow DOM (page styles don't touch it and it doesn't clutter
 * get_html), ignores the mouse (pointer-events:none) and stays out of the
 * snapshot — so it never gets in the agent's way.
 */
export function pageShield(mode) {
  const ID = "__dispatch_shield__";
  const old = document.getElementById(ID);
  if (!mode) { old?.remove(); return { ok: true, shield: false }; }
  if (!document.body) return { ok: true, shield: false, note: "no body" };

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
    <div class="s"><span class="d"></span>Dispatch · ${full ? "full access" : "read-only"}</div>
  `;
  return { ok: true, shield: true, mode: full ? "full" : "readonly" };
}

/**
 * URL of the frame's document. Needed to check the allowlist BEFORE acting in a
 * nested frame: it may have a completely different host than the tab itself.
 */
export function pageHref() {
  return { ok: true, url: location.href };
}

/**
 * Viewport point (CSS px) at the center of an element — where CDP mouse events
 * go for hover and drag. scroll=true brings the element into view first.
 */
export function pagePoint(ref, selector, scroll) {
  const store = window.__DISPATCH__ || {};
  const el = ref ? (store.refs || {})[ref] : (selector ? document.querySelector(selector) : null);
  if (!el) return { ok: false, error: ref ? `ref ${ref} not found — take a fresh browser_snapshot` : "no element matches the selector" };
  if (scroll) el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const inViewport = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  return { ok: true, x, y, inViewport, name: (el.innerText || el.value || el.tagName).toString().trim().slice(0, 80) };
}

/**
 * Tag a file input with data-dispatch-upload=<mark> so the CDP side (main world)
 * can find the same element the agent pointed at in this (isolated) world.
 */
export function pageMarkFileInput(ref, selector, mark, count) {
  const store = window.__DISPATCH__ || {};
  const el = ref ? (store.refs || {})[ref] : (selector ? document.querySelector(selector) : null);
  if (!el) return { ok: false, error: ref ? `ref ${ref} not found — take a fresh browser_snapshot` : "no element matches the selector" };
  if (!(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, error: "element is not <input type=file>" };
  if (count > 1 && !el.multiple) return { ok: false, error: "this file input accepts a single file" };
  el.setAttribute("data-dispatch-upload", mark);
  return { ok: true };
}

export function pageScroll(selector, dx, dy, toBottom) {
  const el = selector ? document.querySelector(selector) : (document.scrollingElement || document.documentElement);
  if (!el) return { ok: false, error: "scroll element not found" };
  if (toBottom) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  else el.scrollBy({ left: dx || 0, top: dy || 0, behavior: "auto" });
  return { ok: true, scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}
