// Раннер автономных тестов (без реального браузера-расширения).
// smoke + security всегда; page-functions — если найден Chrome.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const run = (file) => new Promise((res) => spawn("node", [dir + file], { stdio: "inherit" }).on("close", res));

const chromeBin = process.env.DISPATCH_CHROME || "google-chrome";
const hasChrome = spawnSync("which", [chromeBin]).status === 0;

const suite = ["policy.mjs", "dispatcher.mjs", "smoke.mjs", "security.mjs"];
if (hasChrome) suite.push("page-functions.mjs");
else console.log(`(page-functions пропущен — не найден ${chromeBin}; задай $DISPATCH_CHROME)`);

let failed = 0;
for (const f of suite) {
  const code = await run(f);
  if (code !== 0) failed++;
}
console.log(`\n${failed === 0 ? "✅ ВСЕ ТЕСТЫ ПРОШЛИ" : `❌ УПАЛО НАБОРОВ: ${failed}`} (${suite.length} наборов)`);
process.exit(failed ? 1 : 0);
