/* TravelBase – Service Worker (gilt für die Übersicht und alle Reise-Ordner)
   - Eigene Dateien: erst Netz (max. 4 s), sonst gespeicherte Version → Updates kommen sofort an
   - Bibliotheken/Schriften: aus dem Speicher
   - Kartenkacheln: gespeichert (max. 500)
   - Supabase-Anfragen werden NICHT gespeichert (die App merkt sich die Daten selbst, pro Benutzer) */
const P="travelbase-",V=P+"v13";
const CORE=['./','index.html','manifest.json','shared/config.js','shared/travelbase.js','shared/profile.js','shared/flags.css','shared/trip.css','shared/trip.js','icons/icon-192.png','icons/icon-512.png','icons/icon-maskable-512.png','icons/apple-touch-icon.png','icons/favicon-32.png'];
const EXTRA=["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js","https://unpkg.com/leaflet@1.9.4/dist/leaflet.css","https://unpkg.com/leaflet@1.9.4/dist/leaflet.js","https://unpkg.com/leaflet@1.9.4/dist/images/layers.png","https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png","https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap","https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js","https://cdn.jsdelivr.net/npm/country-flag-emoji-polyfill@0.1/dist/TwemojiCountryFlags.woff2"];
const RULES=[["unpkg.com|fonts.googleapis.com|fonts.gstatic.com|cdn.jsdelivr.net","cf"],["openstreetmap|opentopomap|arcgisonline","tile"]];
const TILE=/openstreetmap|opentopomap|arcgisonline/;
const LIMIT=500;
self.addEventListener('install',e=>{e.waitUntil((async()=>{const c=await caches.open(V);await c.addAll(CORE);await Promise.allSettled(EXTRA.map(u=>c.add(u)));await self.skipWaiting();})());});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith(P)&&k!==V)await caches.delete(k);await self.clients.claim();})());});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);if(u.protocol!=='https:'&&u.protocol!=='http:')return;
  let s=null;
  if(u.origin===location.origin){if(!u.pathname.startsWith(new URL(self.registration.scope).pathname))return;s='nf';}
  else{const m=RULES.find(x=>new RegExp(x[0]).test(u.host));s=m?m[1]:null;}
  if(s)e.respondWith(handle(r,s));
});
async function trim(c){const k=(await c.keys()).filter(q=>TILE.test(new URL(q.url).host));for(let i=0;i<k.length-LIMIT;i++)await c.delete(k[i]);}
async function handle(r,s){
  const c=await caches.open(V);
  const nav=r.mode==='navigate';
  const hit=await c.match(r,{ignoreSearch:nav});
  const net=()=>fetch(r).then(async res=>{if(res.ok||res.type==='opaque'){await c.put(r,res.clone());if(s==='tile')trim(c);}return res;});
  if(s==='cf')return hit||net();
  if(s==='nf'){
    try{return await Promise.race([net(),new Promise((_,j)=>setTimeout(j,4000))]);}
    catch(_){return hit||(nav?await c.match('index.html'):null)||Response.error();}
  }
  if(hit){net().catch(()=>{});return hit;}
  return net();
}
