import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";

const PORT = Number(process.env.DISPATCH_PORT || 8765);
const bridge = new Bridge(PORT);

const server = new McpServer({ name: "dispatch", version: "0.1.0" });

// ── помощники ───────────────────────────────────────────────────────────────
function text(obj: unknown) {
  const t = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text" as const, text: t }] };
}

/** Обёртка: превращает ошибки моста/расширения в человекочитаемый isError-ответ. */
async function guard(fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: "Ошибка: " + (e?.message || String(e)) }],
      isError: true,
    };
  }
}

// ── инструменты ───────────────────────────────────────────────────────────────
server.registerTool(
  "browser_status",
  {
    description:
      "Статус связки: подключено ли расширение, инфо о браузере, порт. " +
      "Вызывай первым, если сомневаешься, что расширение на связи.",
    inputSchema: {},
  },
  async () =>
    text({
      connected: bridge.connected,
      browser: bridge.lastHello,
      port: PORT,
      hint: bridge.connected
        ? "Готово. Если команды падают на 'нет вкладки с доступом' — дай доступ к вкладке в popup."
        : "Расширение не подключено. Проверь, что оно установлено и мастер-тумблер включён.",
    }),
);

server.registerTool(
  "browser_tabs",
  {
    description: "Список открытых вкладок браузера (id, title, url, активна ли, есть ли доступ).",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("tabs"))),
);

server.registerTool(
  "browser_select_tab",
  {
    description:
      "Дать доступ к вкладке по её id (из browser_tabs). Агент действует только на вкладке с доступом.",
    inputSchema: { tabId: z.number().int().describe("id вкладки из browser_tabs") },
  },
  async ({ tabId }) => guard(async () => text(await bridge.send("select_tab", { tabId }))),
);

server.registerTool(
  "browser_navigate",
  {
    description: "Перейти по URL в вкладке с доступом и дождаться загрузки.",
    inputSchema: { url: z.string().describe("Полный URL, включая https://") },
  },
  async ({ url }) => guard(async () => text(await bridge.send("navigate", { url }, 60000))),
);

server.registerTool(
  "browser_open_tab",
  {
    description:
      "Открыть новую вкладку с URL и (по умолчанию) дать ей доступ — чтобы дальше действовать на ней. " +
      "grant=false — открыть, но не давать доступ; active=false — открыть в фоне.",
    inputSchema: {
      url: z.string().optional().describe("URL новой вкладки (пусто = пустая вкладка)"),
      active: z.boolean().optional().describe("Сделать активной (по умолчанию да)"),
      grant: z.boolean().optional().describe("Дать доступ новой вкладке (по умолчанию да)"),
    },
  },
  async ({ url, active, grant }) =>
    guard(async () => text(await bridge.send("open_tab", { url, active, grant }, 60000))),
);

server.registerTool(
  "browser_close_tab",
  {
    description: "Закрыть вкладку по tabId (или ту, что с доступом, если tabId не указан).",
    inputSchema: { tabId: z.number().int().optional().describe("id вкладки; пусто = вкладка с доступом") },
  },
  async ({ tabId }) => guard(async () => text(await bridge.send("close_tab", { tabId }))),
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Снимок интерактивных элементов страницы: список с ref, ролью, именем. " +
      "Используй ref в browser_click / browser_type. Компактнее, чем полный HTML.",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("snapshot"))),
);

server.registerTool(
  "browser_get_html",
  {
    description: "Вернуть outerHTML всей страницы или узла по CSS-селектору (обрезается до 200К).",
    inputSchema: {
      selector: z.string().optional().describe("CSS-селектор; пусто = вся страница"),
    },
  },
  async ({ selector }) => guard(async () => text(await bridge.send("get_html", { selector }))),
);

server.registerTool(
  "browser_eval",
  {
    description:
      "Выполнить JS в контексте страницы (main world, доступ к window/DOM) и вернуть JSON-результат. " +
      "Top-level await НЕ поддерживается — используй .then(). Возвращаемое значение должно быть сериализуемым.",
    inputSchema: { expression: z.string().describe("JS-выражение, например: document.title") },
  },
  async ({ expression }) =>
    guard(async () => {
      const r = await bridge.send<{ json: string }>("eval", { expression });
      return text(r.json);
    }),
);

server.registerTool(
  "browser_click",
  {
    description: "Клик по элементу: либо ref из browser_snapshot, либо CSS-селектор.",
    inputSchema: {
      ref: z.string().optional().describe("ref из snapshot, например e12"),
      selector: z.string().optional().describe("CSS-селектор (если нет ref)"),
    },
  },
  async ({ ref, selector }) =>
    guard(async () => text(await bridge.send("click", { ref, selector }))),
);

server.registerTool(
  "browser_type",
  {
    description: "Ввести текст в поле (input/textarea/contenteditable) по ref или CSS-селектору.",
    inputSchema: {
      ref: z.string().optional().describe("ref из snapshot"),
      selector: z.string().optional().describe("CSS-селектор (если нет ref)"),
      text: z.string().describe("Текст для ввода"),
      submit: z.boolean().optional().describe("Отправить форму / нажать Enter после ввода"),
    },
  },
  async ({ ref, selector, text: value, submit }) =>
    guard(async () => text(await bridge.send("type", { ref, selector, text: value, submit }))),
);

server.registerTool(
  "browser_wait_for",
  {
    description: "Дождаться появления элемента по CSS-селектору (или просто подождать).",
    inputSchema: {
      selector: z.string().optional().describe("CSS-селектор для ожидания"),
      timeoutMs: z.number().int().optional().describe("Таймаут, мс (по умолчанию 10000)"),
    },
  },
  async ({ selector, timeoutMs }) =>
    guard(async () => text(await bridge.send("wait_for", { selector, timeoutMs }, (timeoutMs ?? 10000) + 5000))),
);

server.registerTool(
  "browser_screenshot",
  {
    description:
      "Скриншот вкладки с доступом. fullPage=true снимает всю страницу через CDP " +
      "(на время появляется полоса отладки Chrome), иначе — только видимую область.",
    inputSchema: { fullPage: z.boolean().optional().describe("Снять всю страницу целиком") },
  },
  async ({ fullPage }) =>
    guard(async () => {
      const r = await bridge.send<{ data: string }>("screenshot", { fullPage: !!fullPage }, 60000);
      return { content: [{ type: "image" as const, data: r.data, mimeType: "image/png" }] };
    }),
);

server.registerTool(
  "browser_scroll",
  {
    description:
      "Прокрутка страницы или контейнера. toBottom=true — до самого низа (для бесконечных лент); " +
      "иначе на dx/dy пикселей. Без selector скроллит саму страницу.",
    inputSchema: {
      selector: z.string().optional().describe("CSS-селектор контейнера прокрутки"),
      dx: z.number().optional().describe("Прокрутка по горизонтали, px"),
      dy: z.number().optional().describe("Прокрутка по вертикали, px"),
      toBottom: z.boolean().optional().describe("Прокрутить до конца"),
    },
  },
  async ({ selector, dx, dy, toBottom }) =>
    guard(async () => text(await bridge.send("scroll", { selector, dx, dy, toBottom }))),
);

server.registerTool(
  "browser_press_key",
  {
    description:
      "Нажать клавишу через CDP (надёжнее синтетических DOM-событий). Спец-клавиши: " +
      "Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space. " +
      "Одиночный печатный символ тоже можно. Клавиша идёт в текущий фокус (или в selector, если задан).",
    inputSchema: {
      key: z.string().describe("Клавиша, например Enter или a"),
      selector: z.string().optional().describe("CSS-селектор — сфокусировать перед нажатием"),
    },
  },
  async ({ key, selector }) =>
    guard(async () => text(await bridge.send("press_key", { key, selector }))),
);

server.registerTool(
  "browser_extract",
  {
    description:
      "Структурный сбор данных по CSS-селекторам. fields — карта {имя: {selector, attr}}, " +
      "attr по умолчанию 'text' (также 'html', 'href', 'src' или любой атрибут). " +
      "multiple=true + container — вернуть массив объектов по каждому элементу container (карточки, строки таблицы).",
    inputSchema: {
      container: z.string().optional().describe("Селектор повторяющегося блока (при multiple) или области"),
      fields: z
        .record(z.object({ selector: z.string().optional(), attr: z.string().optional() }))
        .describe("{ title: {selector:'h2'}, link: {selector:'a', attr:'href'} }"),
      multiple: z.boolean().optional().describe("Собрать массив по каждому container"),
    },
  },
  async ({ container, fields, multiple }) =>
    guard(async () => text(await bridge.send("extract", { container, fields, multiple }))),
);

// ── отладка: перехват сети и консоли (постоянная CDP-сессия) ─────────────────────
server.registerTool(
  "browser_debug_start",
  {
    description:
      "Включить перехват console и network на вкладке с доступом (открывает CDP-сессию; " +
      "появляется баннер отладки Chrome). После этого работают browser_console_logs и browser_network. " +
      "Выключается через browser_debug_stop.",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("debug_start"))),
);

server.registerTool(
  "browser_debug_stop",
  {
    description: "Остановить перехват, закрыть CDP-сессию (убрать баннер отладки), очистить буферы.",
    inputSchema: {},
  },
  async () => guard(async () => text(await bridge.send("debug_stop"))),
);

server.registerTool(
  "browser_console_logs",
  {
    description:
      "Прочитать накопленные логи консоли, необработанные исключения и браузерные предупреждения. " +
      "Требует browser_debug_start. level фильтрует по уровню (log/info/warn/error).",
    inputSchema: {
      level: z.string().optional().describe("Фильтр по уровню: log|info|warn|error|debug"),
      clear: z.boolean().optional().describe("Очистить буфер после чтения"),
    },
  },
  async ({ level, clear }) =>
    guard(async () => text(await bridge.send("console_logs", { level, clear }))),
);

server.registerTool(
  "browser_network",
  {
    description:
      "Список перехваченных сетевых запросов (метаданные: метод, статус, тип, размер, URL). " +
      "Требует browser_debug_start. filter — подстрока URL. Тело ответа бери через browser_network_body.",
    inputSchema: {
      filter: z.string().optional().describe("Оставить только запросы, чей URL содержит подстроку"),
      clear: z.boolean().optional().describe("Очистить буфер после чтения"),
    },
  },
  async ({ filter, clear }) =>
    guard(async () => text(await bridge.send("network", { filter, clear }))),
);

server.registerTool(
  "browser_network_body",
  {
    description:
      "Тело ответа конкретного запроса по requestId (из browser_network). " +
      "Работает, пока активна debug-сессия и ресурс не выгружен из памяти. Обрезается до 200К.",
    inputSchema: { requestId: z.string().describe("requestId из browser_network") },
  },
  async ({ requestId }) =>
    guard(async () => text(await bridge.send("network_body", { requestId }))),
);

server.registerTool(
  "browser_emulate",
  {
    description:
      "Эмуляция устройства/окружения через CDP (открывает debug-сессию — виден баннер). " +
      "device: 'iPhone 14' | 'Pixel 7' | 'iPad'. Либо задай viewport / userAgent / geolocation вручную. " +
      "reset=true снимает все override'ы и закрывает сессию.",
    inputSchema: {
      device: z.string().optional().describe("Пресет устройства: iPhone 14 | Pixel 7 | iPad"),
      viewport: z
        .object({
          width: z.number(),
          height: z.number(),
          deviceScaleFactor: z.number().optional(),
          mobile: z.boolean().optional(),
        })
        .optional()
        .describe("Ручной размер вьюпорта"),
      userAgent: z.string().optional().describe("Подменить User-Agent"),
      geolocation: z
        .object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().optional() })
        .optional()
        .describe("Подменить геолокацию"),
      reset: z.boolean().optional().describe("Снять всю эмуляцию и закрыть debug-сессию"),
    },
  },
  async ({ device, viewport, userAgent, geolocation, reset }) =>
    guard(async () => text(await bridge.send("emulate", { device, viewport, userAgent, geolocation, reset }))),
);

// ── запуск ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[dispatch] MCP-сервер готов (WS ws://127.0.0.1:${PORT})`);
