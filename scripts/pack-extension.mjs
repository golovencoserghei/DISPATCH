// Packs extension/ into dist/dispatch-extension-v<version>.zip — the file you
// upload to the Chrome Web Store and attach to a GitHub release.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(root + "extension/manifest.json", "utf8"));
const out = `${root}dist/dispatch-extension-v${version}.zip`;

mkdirSync(root + "dist", { recursive: true });
rmSync(out, { force: true });
// The SVG is the icon source, not something the extension loads.
const r = spawnSync("zip", ["-r", "-X", "-q", out, ".", "-x", "icons/icon.svg", "-x", "*.DS_Store"], {
  cwd: root + "extension",
  stdio: "inherit",
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(out);
