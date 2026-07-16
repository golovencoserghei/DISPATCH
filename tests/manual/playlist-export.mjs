// ПРИМЕР-утилита: собрать названия треков открытого плейлиста Spotify.
// Показывает работу с виртуализированным списком (скролл + накопление уникальных).
// Требует: расширение включено, выдан доступ вкладке страницы плейлиста Spotify
// (…/playlist/… или /collection/tracks).
//
//   node tests/manual/playlist-export.mjs
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { startServer, wait } from "../lib.mjs";

const OUT = fileURLToPath(new URL("./.playlist.json", import.meta.url));
const J = (r) => JSON.parse(r.text);
const isPlaylist = (u) => /open\.spotify\.com\/(playlist\/|collection)/i.test(u || "");

const PICK = `function pick(){var best=null,area=0;document.querySelectorAll('div').forEach(function(el){if(el.scrollHeight>el.clientHeight+80){var has=el.querySelector('[data-testid=\\'tracklist-row\\'], [role=\\'row\\']');var r=el.getBoundingClientRect();var a=r.width*r.height;if(has)a*=10;if(a>area){area=a;best=el;}}});return best;}`;
const RESET = `(()=>{${PICK} window.__wd={}; var sc=pick(); if(sc)sc.scrollTop=0; return {reset:true};})()`;
const STEP = `(()=>{${PICK}
  window.__wd=window.__wd||{};
  var rows=document.querySelectorAll('[data-testid="tracklist-row"], [role="row"]');
  rows.forEach(function(row){
    var link=row.querySelector('[data-testid="internal-track-link"]')||row.querySelector('a[href*="/track/"]');
    var name=link?link.textContent.trim():''; if(!name){var c=row.querySelector('div[dir="auto"]');name=c?c.textContent.trim():'';}
    if(!name)return;
    var artists=Array.prototype.map.call(row.querySelectorAll('a[href*="/artist/"]'),function(a){return a.textContent.trim();});
    var key=name+'|'+artists.join(','); if(!window.__wd[key])window.__wd[key]={name:name,artists:artists};
  });
  var sc=pick(),atBottom=true; if(sc){atBottom=(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-8);sc.scrollBy(0,Math.round(sc.clientHeight*0.85));}
  return {total:Object.keys(window.__wd).length,atBottom:atBottom};
})()`;

async function main() {
  const s = startServer();
  await wait(1300); await s.initialize();
  const ev = async (e) => JSON.parse((await s.callTool("browser_eval", { expression: e })).text);

  console.log("Открой страницу плейлиста Spotify и дай ей доступ (тумблер вкл).");
  const deadline = Date.now() + 240000; let tab = null;
  while (Date.now() < deadline) {
    const st = await s.callTool("browser_status");
    if (st.ok && J(st).connected) {
      const granted = J(await s.callTool("browser_tabs")).find((t) => t.granted);
      if (granted && isPlaylist(granted.url)) { tab = granted; break; }
      console.log(granted ? `… дай доступ странице ПЛЕЙЛИСТА (сейчас: ${granted.url})` : "… дай доступ плейлисту");
    } else console.log("… жду расширение…");
    await wait(2500);
  }
  if (!tab) { console.log("⏱ не дождался плейлиста"); s.close(); process.exit(2); }
  console.log(`\n▶ ${tab.title}\n  ${tab.url}`);

  await ev(RESET); await wait(600);
  let prev = -1, stagnant = 0;
  for (let i = 0; i < 300; i++) {
    const r = await ev(STEP);
    if (i % 5 === 0 || r.atBottom) console.log(`  шаг ${i}: собрано ${r.total}${r.atBottom ? " (дно)" : ""}`);
    if (r.total === prev) stagnant++; else stagnant = 0; prev = r.total;
    if (r.atBottom) { await wait(700); await ev(STEP); break; }
    if (stagnant >= 6) break;
    await wait(700);
  }
  const tracks = await ev(`Object.values(window.__wd||{})`);
  writeFileSync(OUT, JSON.stringify(tracks, null, 2));
  console.log(`\n▶ Собрано ${tracks.length} треков → ${OUT}`);
  tracks.slice(0, 40).forEach((t, i) => console.log(`${i + 1}. ${t.name}${t.artists?.length ? " — " + t.artists.join(", ") : ""}`));
  s.close(); process.exit(0);
}
main().catch((e) => { console.error("упал:", e); process.exit(1); });
