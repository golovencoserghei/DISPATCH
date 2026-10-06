// Standalone test runner (no real browser extension needed).
// smoke + security always; page-functions if Chrome is found.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
// Output is passed through as is; the tail is kept so that a suite that dies
// before any check (no ✗ to annotate) still says why in GitHub Actions.
const run = (file) => new Promise((res) => {
  const p = spawn("node", [dir + file], { stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const keep = (stream, out) => stream.on("data", (d) => { out.write(d); tail = (tail + d).slice(-1500); });
  keep(p.stdout, process.stdout);
  keep(p.stderr, process.stderr);
  p.on("close", (code) => {
    if (code !== 0 && process.env.GITHUB_ACTIONS) {
      const last = tail.split("\n").filter((l) => l.trim() && !l.startsWith("::")).slice(-12).join(" ⏎ ");
      console.log(`::error title=${file} exited with ${code}::${last.slice(0, 1200)}`);
    }
    res(code);
  });
});

const chromeBin = process.env.DISPATCH_CHROME || "google-chrome";
const hasChrome = spawnSync("which", [chromeBin]).status === 0;

const suite = ["policy.mjs", "dispatcher.mjs", "smoke.mjs", "security.mjs", "release.mjs", "e2e.mjs"];
if (hasChrome) suite.push("page-functions.mjs");
else console.log(`(page-functions skipped — ${chromeBin} not found; set $DISPATCH_CHROME)`);

let failed = 0;
for (const f of suite) {
  const code = await run(f);
  if (code !== 0) failed++;
}
console.log(`\n${failed === 0 ? "✅ ALL TESTS PASSED" : `❌ FAILED SUITES: ${failed}`} (${suite.length} suites)`);
process.exit(failed ? 1 : 0);
