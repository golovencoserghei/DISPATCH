// Release metadata stays consistent: one version everywhere, every __MSG_*__
// in the manifest resolves, and all locales carry the same keys.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checker } from "./lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (p) => JSON.parse(readFileSync(root + p, "utf8"));

const t = checker("▶ release metadata");
const manifest = json("extension/manifest.json");
const pkg = json("mcp-server/package.json");
const server = json("server.json");

t.check("manifest version = npm version", manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);
t.check("server.json version = npm version", server.version === pkg.version && server.packages[0].version === pkg.version);
t.check("server.json name = mcpName", server.name === pkg.mcpName);
t.check("server.json identifier = npm name", server.packages[0].identifier === pkg.name);
t.check("server.json description ≤ 100 chars", server.description.length <= 100, server.description.length);

const locales = readdirSync(root + "extension/_locales");
const msgs = Object.fromEntries(locales.map((l) => [l, json(`extension/_locales/${l}/messages.json`)]));
t.check("default_locale exists", locales.includes(manifest.default_locale), manifest.default_locale);
const refs = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
for (const k of refs) t.check(`manifest __MSG_${k}__ resolves`, k in msgs[manifest.default_locale]);
const base = Object.keys(msgs.en).sort().join();
for (const l of locales) t.check(`locale ${l} has the same keys as en`, Object.keys(msgs[l]).sort().join() === base);

const popup = readFileSync(root + "extension/popup.html", "utf8") + readFileSync(root + "extension/popup.js", "utf8");
const used = new Set([...popup.matchAll(/data-i18n(?:-\w+)?="(\w+)"|\bt\("(\w+)"/g)].map((m) => m[1] || m[2]));
for (const k of used) t.check(`popup key "${k}" exists`, k in msgs.en);
t.check("store name ≤ 75 chars", msgs.en.extName.message.length <= 75);
t.check("store description ≤ 132 chars", msgs.en.extDescription.message.length <= 132, msgs.en.extDescription.message.length);
for (const s of [16, 32, 48, 128]) t.check(`icon ${s} listed`, manifest.icons[String(s)] === `icons/icon${s}.png`);

process.exit(t.done("release") ? 0 : 1);
