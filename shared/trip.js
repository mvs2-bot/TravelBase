/* TravelBase – Reise-Vorlage
   Baut die komplette Reiseseite aus den Daten in Supabase (trip_sections) auf.
   Welche Bereiche erscheinen, hängt nur davon ab, welche Daten die eigene Rolle sehen darf:
     meta, places, routes, routeStyles, legend, bounds          → Karte & Zeitraum (alle)
     plans, regions, persons, calendar, flights, infos, links,
     todos, workdays, climate                                   → je nach min_role des Abschnitts */
(function () {
    'use strict';
    const $ = s => document.querySelector(s);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pad = n => String(n).padStart(2, '0');
    const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dayNum = iso => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5);
    const fmtDM = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
    /* Linien-Symbol aus shared/icons.js (ältere Seite aus dem Cache ohne icons.js → leer) */
    const ic = n => window.tbIcon ? tbIcon(n) : '';
    /* "Heute" – zum Testen per URL überschreibbar: ?heute=2027-04-10 */
    const TODAY = (() => { const q = new URLSearchParams(location.search).get('heute'); return /^\d{4}-\d{2}-\d{2}$/.test(q || '') ? q : localISO(new Date()); })();
    const TRIP_SLUG = (() => { const p = location.pathname.replace(/index\.html$/, '').split('/').filter(Boolean); return p[p.length - 1]; })();

    let DATA = null, ROLE = null, TRIP_ID = null, map = null;
    const markers = {};
    const planState = {};

    /* ---------- Laden ---------- */
    function gate(html) { const g = $('#tbGate'); g.innerHTML = html; g.hidden = !html; }
    async function load() {
        if (!window.TB || !TB.configured) { gate(`<h2>${ic('gear')}Noch nicht eingerichtet</h2><p class="note">Supabase ist noch nicht verbunden (shared/config.js).</p>`); return false; }
        let res;
        try { res = await TB.loadTrip(TRIP_SLUG); }
        catch (e) { gate(`<h2>${ic('alert')}Fehler beim Laden</h2><p class="note">${esc(TB.errorText(e))}</p><a href="../">← Zur Übersicht</a>`); return false; }
        if (!res) { location.replace('../?next=' + encodeURIComponent(TRIP_SLUG)); return false; }
        if (res.denied) { gate(`<h2>${ic('lock')}Kein Zugriff</h2><p class="note">Du bist für diese Reise nicht freigeschaltet.</p><a href="../">← Zur Übersicht</a>`); return false; }
        DATA = res.data; ROLE = res.role; TRIP_ID = res.trip.id;
        $('#tbWho').innerHTML = ic('person') + esc(res.user.name || res.user.email);
        $('#tbOffline').hidden = !res.offline;
        return true;
    }

    /* ---------- Kopf ---------- */
    function renderHeader() {
        const m = DATA.meta || {};
        document.title = (m.title || 'Reise') + ' · TravelBase';
        $('#tripTitle').textContent = (m.icon || '🌍') + ' ' + (m.title || '');
        $('#tripPeriod').textContent = m.period || '';
        updateCountdown();
        setInterval(updateCountdown, 30000);
    }
    function updateCountdown() {
        const m = DATA.meta || {}, el = $('#countdown');
        if (!m.start) { el.hidden = true; return; }
        const end = m.end || m.start, now = dayNum(TODAY);
        if (now > dayNum(end)) { el.innerHTML = ic('checkCircle') + 'Reise abgeschlossen'; return; }
        if (now >= dayNum(m.start)) { el.innerHTML = ic('sparkles') + `Unterwegs · Tag ${now - dayNum(m.start) + 1} von ${dayNum(end) - dayNum(m.start) + 1}`; return; }
        const target = m.departureUTC ? new Date(m.departureUTC).getTime() : Date.UTC(+m.start.slice(0, 4), +m.start.slice(5, 7) - 1, +m.start.slice(8, 10));
        const t = Math.max(0, Math.floor((target - Date.now()) / 1000));
        el.innerHTML = ic('clock') + `Noch <b>${Math.floor(t / 86400)}</b> T., <b>${Math.floor(t / 3600) % 24}</b> Std., <b>${Math.floor(t / 60) % 60}</b> Min.`;
    }

    /* ---------- Navigation (Tabs & Menü werden aus den vorhandenen Daten gebaut) ---------- */
    function sections() {
        const s = [];
        if (DATA.places) s.push({ id: 'mapview', icon: ic('map'), label: 'Karte', tab: true });
        (DATA.plans || []).forEach(p => s.push({ id: p.id, icon: p.icon ? esc(p.icon) : ic('calendar'), label: p.tabLabel || 'Tagesplan', tab: true }));
        if (DATA.calendar && (DATA.persons || []).length) s.push({ id: 'cal', icon: ic('users'), label: 'Anwesenheit', tab: true });
        // To-Dos als eigener Bereich; eine ältere Seite aus dem Cache ohne #todos zeigt sie weiter unter „Infos & mehr“
        const todoPane = DATA.todos && !!$('#todos');
        if (todoPane) s.push({ id: 'todos', icon: ic('checkCircle'), label: 'To-Dos' });
        if (DATA.persons || DATA.workdays || (DATA.todos && !todoPane) || DATA.infos || DATA.links) s.push({ id: 'misc', icon: ic('info'), label: 'Infos & mehr' });
        if ((DATA.flights || []).length) s.push({ id: 'flights', icon: ic('plane'), label: 'Flüge' });
        if (DATA.climate) s.push({ id: 'climate', icon: ic('cloudSun'), label: 'Klima & Wetter' });
        return s;
    }
    let SECTIONS = [];
    function renderNav() {
        SECTIONS = sections();
        const tabs = SECTIONS.filter(s => s.tab);
        $('#tabs').style.setProperty('--tab-count', tabs.length + 1);
        /* Schnellauswahl einzeilig: „Tagesplan Peru“ → „Peru“ (voller Name als Tooltip) */
        $('#tabs').innerHTML = tabs.map(s => `<button class="tab" data-t="${s.id}" title="${esc(s.label)}"><span>${s.icon}</span>${esc(s.label.replace(/^Tagesplan (?=\S)/, ''))}</button>`).join('')
            + '<button class="tab tab-menu" id="menuTab" type="button" aria-label="Menü öffnen"><span>' + ic('list') + '</span>Menü</button>';
        $('#popLinks').innerHTML = SECTIONS.map(s => `<button data-t="${s.id}" class="pop-btn"><span>${s.icon}</span>${esc(s.label)}</button>`).join('');
        document.querySelectorAll('.tabs .tab[data-t]').forEach(b => b.onclick = () => switchTab(b.dataset.t));
        $('#menuTab').onclick = () => $('#navPopover').classList.add('open');
        document.querySelectorAll('.pop-btn').forEach(b => b.onclick = () => { switchTab(b.dataset.t); $('#navPopover').classList.remove('open'); });
    }
    function switchTab(id) {
        if (!SECTIONS.some(s => s.id === id)) id = SECTIONS[0].id;
        document.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('on', x.dataset.t === id));
        document.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.id === id));
        document.querySelectorAll('.pop-btn').forEach(x => x.classList.toggle('on', x.dataset.t === id));
        if (location.hash !== '#' + id) history.replaceState(null, '', location.pathname + location.search + '#' + id);
        window.scrollTo(0, 0);
        if (id === 'mapview' && map) setTimeout(() => { map.invalidateSize(); fitStartView(); }, 50);
    }
    function tabFromHash() { switchTab(location.hash.replace('#', '') || SECTIONS[0].id); }

    /* ---------- Karte ---------- */
    const DEFAULT_STYLES = {
        road: { color: '#0d9488', weight: 3.5, opacity: .9 },
        flight: { color: '#059669', weight: 2.5, opacity: .85, dashArray: '6, 6' },
        transfer: { color: '#64748b', weight: 2, opacity: .6, dashArray: '3, 3' }
    };
    function initMap() {
        const layer = (url, attr, maxZoom = 15) => L.tileLayer(url, { maxZoom, attribution: attr });
        const baseLayers = {
            '🇩🇪 OSM Deutsch (Deutsch / Landessprache)': layer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> (Deutscher Stil)'),
            '🌏 OSM Standard (NUR Landessprache)': layer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', '&copy; OpenStreetMap', 18),
            '🗺️ Esri Street (Englisch)': layer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', 'Tiles &copy; Esri'),
            '⛰️ Topografisch (CyclOSM)': layer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', '&copy; OpenStreetMap / CyclOSM', 18),
            '⛰ OpenTopoMap (Gelände)': layer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', '&copy; OpenTopoMap', 17)
        };
        const first = DATA.mapLayer && baseLayers[DATA.mapLayer] ? DATA.mapLayer : Object.keys(baseLayers)[0];
        map = L.map('map', { layers: [baseLayers[first]] });
        L.control.layers(baseLayers, null, { collapsed: true, position: 'topright' }).addTo(map);

        const P = DATA.places || {}, styles = { ...DEFAULT_STYLES, ...(DATA.routeStyles || {}) };
        (DATA.routes || []).forEach(r => {
            const pts = r.path || (r.via || []).map(k => P[k] && [P[k].lat, P[k].lng]).filter(Boolean);
            if (pts.length > 1) L.polyline(pts, styles[r.style] || DEFAULT_STYLES.road).addTo(map);
        });
        const all = [];
        Object.entries(P).forEach(([key, p]) => {
            const color = p.color || '#15803d';
            const popup = `<b style="color:${color}">${ic('pin')} ${esc(p.name)}</b>${p.date ? `<br><small>${ic('calendar')} ${esc(p.date)}</small>` : ''}${p.desc ? `<br>${p.desc}` : ''}`;
            const m = p.num != null
                ? L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'nm', html: `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:${color}">${esc(p.num)}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
                : L.circleMarker([p.lat, p.lng], { color, fillColor: color, fillOpacity: .9, radius: p.size || 6 });
            m.bindPopup(popup).addTo(map);
            markers[key] = m;
            all.push([p.lat, p.lng]);
        });
        if ((DATA.legend || []).length) {
            const lg = L.control({ position: 'bottomright' });
            lg.onAdd = () => {
                const d = L.DomUtil.create('div', 'legend');
                d.innerHTML = `<div class="lh" style="cursor:pointer">${ic('info')}Legende <span>▼</span></div><div class="lb" style="display:none;margin-top:4px">${DATA.legend.map(([c, sym, t]) => `<span style="color:${c}">${sym}</span> ${esc(t)}`).join('<br>')}</div>`;
                L.DomEvent.disableClickPropagation(d);
                d.querySelector('.lh').onclick = () => {
                    const b = d.querySelector('.lb'), open = b.style.display === 'none';
                    b.style.display = open ? 'block' : 'none';
                    d.querySelector('span').textContent = open ? '▲' : '▼';
                };
                return d;
            };
            lg.addTo(map);
        }
        ALL_POINTS = all;
    }
    /* Start-Ausschnitt erst setzen, wenn die Karte sichtbar ist – sonst rechnet Leaflet
       mit 0 Pixeln Größe und zoomt viel zu weit hinein.
       Eigener Ausschnitt pro Reise möglich über "bounds" oder "view": { center: [lat, lng], zoom } */
    let ALL_POINTS = [], fitted = false;
    function fitStartView() {
        if (!map || fitted || !$('#map').offsetWidth) return;
        map.invalidateSize();
        if (DATA.view) map.setView(DATA.view.center, DATA.view.zoom);
        else if (DATA.bounds) map.fitBounds(DATA.bounds, { padding: [20, 20] });
        else if (ALL_POINTS.length) map.fitBounds(ALL_POINTS, { padding: [30, 30] });
        else map.setView([20, 0], 2);
        fitted = true;
    }
    function focusPlaces(keys) {
        const ms = (keys || []).map(k => markers[k]).filter(Boolean);
        if (!ms.length || !map) return;
        switchTab('mapview');
        setTimeout(() => {
            map.invalidateSize();
            fitted = true;
            if (ms.length === 1) { map.flyTo(ms[0].getLatLng(), 9, { duration: 1 }); ms[0].openPopup(); }
            else map.flyToBounds(L.latLngBounds(ms.map(m => m.getLatLng())), { padding: [40, 40], duration: 1 });
            $('#mapBox').scrollIntoView({ behavior: 'smooth' });
        }, 100);
    }

    /* ---------- Tagespläne ---------- */
    const REG = () => DATA.regions || {};
    const personOf = k => (DATA.persons || []).find(p => p.key === k);
    const homeOf = p => p.home || p.end;
    function regionBadge(k) {
        const r = REG()[k] || { label: k, color: '#64748b' };
        return `<span class="rg rc" style="--c:${r.color}">${esc(r.label)}</span>`;
    }
    function whoBadge(row) {
        if (row.who && row.who.length) {
            const ps = row.who.map(personOf).filter(Boolean);
            return `<span class="who">${ps.map(p => `<i style="background:${p.color}"></i>`).join('')}${esc(ps.map(p => p.name).join(', '))}</span>`;
        }
        if (row.group) return `<span class="who"><i style="background:${row.group.color || '#64748b'}"></i>${esc(row.group.label)}</span>`;
        return '';
    }
    const isToday = r => r.from && TODAY >= r.from && TODAY <= (r.to || r.from);
    function renderPlanPanes() {
        $('#planPanes').innerHTML = (DATA.plans || []).map(p => `
            <div id="${p.id}" class="pane">
                <div class="box">
                    <div class="mh plan-head">
                        <h2>${esc(p.title)}</h2>
                        ${p.note ? `<p class="note" style="margin-bottom:0">${esc(p.note)}</p>` : ''}
                    </div>
                    <div class="controls">
                        <input type="search" class="q-input" data-plan="${p.id}" placeholder="Nach Ort, Aktivität oder Transport suchen …">
                        <span class="plan-filters" data-plan="${p.id}" style="display:contents"></span>
                    </div>
                    <div class="tw tw-route">
                        <table>
                            <thead><tr><th>Tag / Datum</th><th>Region</th><th>Ort &amp; Aktivität</th><th>Details &amp; Programm</th><th>Transport</th><th>${esc(p.hotelHeader || 'Unterkunft')}</th></tr></thead>
                            <tbody data-plan="${p.id}"></tbody>
                        </table>
                    </div>
                    <div class="cards" data-plan="${p.id}"></div>
                </div>
            </div>`).join('');
        (DATA.plans || []).forEach(p => {
            planState[p.id] = 'all';
            $(`.q-input[data-plan="${p.id}"]`).oninput = () => renderPlan(p);
            renderPlanFilters(p);
            renderPlan(p);
        });
    }
    function renderPlanFilters(p) {
        const regs = [...new Set(p.rows.flatMap(r => r.regions || []))];
        const el = $(`.plan-filters[data-plan="${p.id}"]`);
        if (regs.length < 2) { el.innerHTML = ''; return; }
        el.innerHTML = ['all', ...regs].map(k => `<button class="f ${planState[p.id] === k ? 'on' : ''}" data-r="${esc(k)}">${k === 'all' ? 'Alle' : esc((REG()[k] || { label: k }).label)}</button>`).join('');
        el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { planState[p.id] = b.dataset.r; renderPlanFilters(p); renderPlan(p); });
    }
    function renderPlan(p) {
        const q = ($(`.q-input[data-plan="${p.id}"]`).value || '').toLowerCase();
        const sel = planState[p.id];
        const rows = p.rows.filter(r => (sel === 'all' || (r.regions || []).includes(sel)) &&
            (!q || [r.day, r.date, r.title, r.details, r.transport, r.hotel, ...(r.extra || []), ...(r.regions || []).map(k => (REG()[k] || {}).label)].join(' ').toLowerCase().includes(q)));
        const dnCls = p.color ? ' alt' : '', dnStyle = p.color ? ` style="--c:${p.color}"` : '';
        const pills = r => [r.transport, ...(r.extra || [])].filter(Boolean).map(t => `<span class="pill">${t}</span>`).join(' ');
        const hotel = r => r.hotel ? `<span class="pill hotel-pill${/noch offen|offen$/i.test(r.hotel) ? ' hotel-open' : ''}">${r.hotel}</span>` : '';
        const tbody = $(`tbody[data-plan="${p.id}"]`), cards = $(`.cards[data-plan="${p.id}"]`);
        tbody.innerHTML = rows.map((r, i) => `
            <tr class="row${isToday(r) ? ' today-row' : ''}" data-i="${p.rows.indexOf(r)}">
                <td><span class="dn${dnCls}"${dnStyle}>${esc(r.day)}</span><div class="dt">${esc(r.date)}</div>${whoBadge(r)}</td>
                <td>${(r.regions || []).map(regionBadge).join(' ')}</td>
                <td><div class="tt">${esc(r.title)}${isToday(r) ? `<span class="today-tag">${ic('star')}Heute</span>` : ''}</div></td>
                <td>${r.details || ''}</td>
                <td>${pills(r)}</td>
                <td>${hotel(r)}</td>
            </tr>`).join('') || '<tr><td colspan="6">Keine Treffer.</td></tr>';
        cards.innerHTML = rows.map(r => `
            <div class="card${isToday(r) ? ' today-card' : ''}" data-i="${p.rows.indexOf(r)}">
                <div class="card-header">
                    <div class="card-meta"><span class="dn${dnCls}"${dnStyle}>${esc(r.day)}</span> <span class="card-date">${esc(r.date)}</span> ${whoBadge(r)}</div>
                    <span>${(r.regions || []).map(regionBadge).join(' ')}</span>
                </div>
                <div class="card-title">${esc(r.title)}${isToday(r) ? `<span class="today-tag">${ic('star')}Heute</span>` : ''}</div>
                <div class="card-details">${r.details || ''}</div>
                <div class="card-footer">${pills(r)} ${hotel(r)}</div>
            </div>`).join('');
        const pick = e => { const el = e.target.closest('[data-i]'); if (el) focusPlaces(p.rows[+el.dataset.i].focus); };
        tbody.onclick = pick; cards.onclick = pick;
    }

    /* ---------- Anwesenheitskalender ---------- */
    function renderCal() {
        const ps = DATA.persons || [], m = DATA.meta || {};
        if (!DATA.calendar || !ps.length || !m.start) return;
        /* "home" = Ankunft zu Hause; Rückflüge nach Europa gehen über Nacht und belegen zwei Flugtage */
        const last = ps.reduce((x, p) => p.home && p.home > x ? p.home : x, m.end || m.start);
        const d0 = dayNum(m.start), n = dayNum(last) - d0 + 1;
        $('#calTitle').innerHTML = ic('users') + `Anwesenheit · ${n} Tage`;
        $('#calBody').style.setProperty('--pc', ps.length);
        let h = `<div class="cr hd"><div>Tag</div>${ps.map(p => `<div style="color:${p.color}">${esc(p.name)}</div>`).join('')}</div>`;
        for (let d = 0; d < n; d++) {
            const dt = new Date((d0 + d) * 864e5), iso = dt.toISOString().slice(0, 10);
            const we = [0, 6].includes(dt.getUTCDay());
            const lab = `${'So Mo Di Mi Do Fr Sa'.split(' ')[dt.getUTCDay()]} ${fmtDM(iso)}`;
            h += `<div class="cr${we ? ' we' : ''}${iso === TODAY ? ' today' : ''}"><div class="cd">Tag ${d + 1}<small>${lab}</small></div>`;
            ps.forEach(p => {
                const a = dayNum(p.start) - d0, b = dayNum(p.end) - d0, back = dayNum(homeOf(p)) - d0;
                let c = '';
                if (d >= a && d <= back) {
                    const fl = d === a || d >= b;
                    c = `<div class="bar${fl ? ' fl' : ''}" style="${fl ? `color:${p.color}` : `background:${p.color}`}" title="${esc(p.name)}: Tag ${d - a + 1}">${fl ? ic('plane') : ''}${d - a + 1}</div>`;
                }
                h += `<div class="cc">${c}</div>`;
            });
            h += '</div>';
        }
        $('#calBody').innerHTML = h;
        renderMonth(ps, m.start, last);
    }

    /* Monatsansicht über der Tabelle: ein Punkt je anwesender Person (Ring = An-/Abreisetag); alle Reisemonate; nur wo #calMonth im HTML steht */
    function renderMonth(ps, start, last) {
        const box = $('#calMonth');
        if (!box) return;
        const months = [];
        for (let y = +start.slice(0, 4), mo = +start.slice(5, 7); y * 12 + mo <= +last.slice(0, 4) * 12 + +last.slice(5, 7); mo === 12 ? (y++, mo = 1) : mo++) months.push([y, mo]);
        const one = ([y, mo]) => {
            const first = Date.UTC(y, mo - 1, 1) / 864e5, len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
            let g = '<div></div>'.repeat((new Date(first * 864e5).getUTCDay() + 6) % 7);
            for (let d = 0; d < len; d++) {
                const dn = first + d, iso = new Date(dn * 864e5).toISOString().slice(0, 10);
                const dots = ps.map(p => dn >= dayNum(p.start) && dn <= dayNum(homeOf(p))
                    ? `<i class="${dn === dayNum(p.start) || dn >= dayNum(p.end) ? 'fl' : ''}" style="color:${p.color}" title="${esc(p.name)}"></i>` : '').join('');
                g += `<div class="md${dots ? ' on' : ''}${iso === TODAY ? ' now' : ''}">${d + 1}<span>${dots}</span></div>`;
            }
            return `<div><div class="mn"><b>${'Januar Februar März April Mai Juni Juli August September Oktober November Dezember'.split(' ')[mo - 1]} ${y}</b></div>`
                + `<div class="mg">${'Mo Di Mi Do Fr Sa So'.split(' ').map(w => `<div class="wd">${w}</div>`).join('')}${g}</div></div>`;
        };
        /* alle Monate auf einmal: Handy untereinander, Rechner nebeneinander (siehe .mw in trip.css) */
        box.innerHTML = `<div class="mw" style="--n:${months.length}">${months.map(one).join('')}</div>`
            + `<div class="ml">${ps.map(p => `<span><i style="color:${p.color}"></i>${esc(p.name)}</span>`).join('')}</div>`;
    }

    /* ---------- Infos & mehr ---------- */
    function renderMisc() {
        const ps = DATA.persons || [];
        if (ps.length) {
            $('#statsBox').hidden = false;
            $('#stats').innerHTML = ps.map(p => `<div class="stat"><span style="color:${p.color}">●</span> ${esc(p.name)}<b>${dayNum(homeOf(p)) - dayNum(p.start) + 1} Tage</b>${fmtDM(p.start)} – ${fmtDM(homeOf(p))}</div>`).join('');
        }
        const w = DATA.workdays;
        if (w && TODAY < w.until) {
            $('#workBox').hidden = false;
            $('#workNote').textContent = `Verbleibende Werktage (Mo–Fr) ab heute bis zum Abflug am ${fmtDM(w.until)}${w.until.slice(0, 4)}. Gesetzliche Feiertage sind bereits abgezogen (ohne persönliche Urlaubstage).`;
            const [y, mo, d] = w.until.split('-').map(Number), end = new Date(y, mo - 1, d);
            $('#workStats').innerHTML = w.regions.map(r => {
                let n = 0;
                for (let cur = new Date(); cur.setHours(0, 0, 0, 0), cur < end; cur.setDate(cur.getDate() + 1)) {
                    const wd = cur.getDay();
                    if (wd && wd !== 6 && !r.holidays.includes(localISO(cur))) n++;
                }
                return `<div class="stat"><span style="color:${r.color}">●</span> ${esc(r.label)}<b>${n} Tage</b>bis Abflug ${fmtDM(w.until)}</div>`;
            }).join('');
            $('#workHolidays').textContent = w.note || '';
        }
        if ((DATA.infos || []).length) {
            $('#infoBox').hidden = false;
            $('#infoList').innerHTML = DATA.infos.map(i => `<li><strong>${esc(i.title)}:</strong> ${i.text}</li>`).join('');
        }
        if ((DATA.links || []).length) {
            $('#linkBox').hidden = false;
            $('#linkRow').innerHTML = DATA.links.map(l => `<a class="btn ql" href="${esc(l.url)}" target="_blank" rel="noopener">${ic('toolbox')}Link zu den Quick Tools${l.label ? ` · ${esc(l.label)}` : ''} ↗</a>`).join('');
        }
        if ((DATA.flights || []).length) {
            $('#flightList').innerHTML = DATA.flights.map(f => `
                <li>
                    <div class="fl-date">${esc(f.date)}</div>
                    <div class="fl-route">${esc(f.route)}</div>
                    ${f.duration ? `<div class="fl-dur">${ic('clock')}${esc(f.duration)}</div>` : ''}
                    ${f.details ? `<div class="fl-details">${esc(f.details)}</div>` : ''}
                    ${f.price ? `<div class="fl-price">${esc(f.price)}</div>` : ''}
                </li>`).join('');
        }
        if (DATA.climate) {
            const c = DATA.climate;
            if (c.title) $('#climateTitle').textContent = c.title;
            if (c.note) $('#climateNote').textContent = c.note;
            $('#climateBody').innerHTML = c.rows.map(r => `<tr><td><strong>${esc(r[0])}</strong></td>${r.slice(1).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
            $('#climateCards').innerHTML = c.rows.map(r => `
                <div class="climate-card">
                    <div class="climate-card-title">${esc(r[0])} <span style="font-weight:normal;color:var(--mute);font-size:.75rem">· ${esc(r[1])}</span></div>
                    <div class="climate-card-grid">
                        <div class="climate-card-item"><b>Temperatur</b>${esc(r[2])}</div>
                        <div class="climate-card-item"><b>Sonnenstunden</b>${esc(r[3])}</div>
                        <div class="climate-card-item"><b>Niederschlag</b>${esc(r[4])}</div>
                        <div class="climate-card-item"><b>Wassertemperatur</b>${esc(r[5])}</div>
                    </div>
                    <div class="climate-card-desc">${esc(r[6])}</div>
                </div>`).join('');
        }
    }

    /* ---------- Gemeinsame To-Dos (Supabase) ---------- */
    let todoList = [], LISTS_ONLINE = false;
    const LIST_CACHE = `lists_${TRIP_SLUG}_todos`;
    const q = async p => { const { data, error } = await p; if (error) throw error; return data; };
    const tagColor = t => ((DATA.todos.tags || []).find(x => x.label === t) || {}).color;
    function editable() {
        if (LISTS_ONLINE && navigator.onLine) return true;
        alert('📴 Offline – Änderungen an den To-Dos sind gerade nicht möglich. Bitte später erneut versuchen.');
        return false;
    }
    async function dbWrite(fn) {
        try { await fn(); } catch (e) { alert('⚠️ Speichern fehlgeschlagen: ' + TB.errorText(e)); await loadTodos(); }
    }
    function localTodoSeed() {
        const t = DATA.todos;
        let list = null;
        try { if (t.legacyKey) list = JSON.parse(localStorage.getItem(t.legacyKey) || 'null'); } catch (e) {}
        return (list || t.defaults || []).map(({ text, tag, done }) => ({ text, tag, done: !!done }));
    }
    async function loadTodos() {
        const fetchAll = () => q(TB.sb.from('travelbase_todos').select('id, text, tag, done, sort_order').eq('trip_id', TRIP_ID).order('sort_order').order('created_at'));
        try {
            let rows = await fetchAll();
            if (!rows.length && await q(TB.sb.rpc('travelbase_seed_todos', { p_trip: TRIP_ID, p_items: localTodoSeed() }))) rows = await fetchAll();
            todoList = rows;
            TB.cacheSet(LIST_CACHE, rows);
            LISTS_ONLINE = true;
        } catch (e) {
            todoList = TB.cacheGet(LIST_CACHE) || [];
            LISTS_ONLINE = false;
            if (!TB.isNetErr(e)) console.error('To-Dos laden', e);
        }
        document.querySelectorAll('.lists-offline').forEach(el => el.hidden = LISTS_ONLINE);
        renderTodos();
    }
    function renderTodos() {
        const ul = $('#todoList');
        ul.innerHTML = '';
        let done = 0, shown = 0;
        const term = $('#todoSearch').value.trim().toLowerCase();
        todoList.forEach((item, idx) => {
            if (item.done) done++;
            if (term && !`${item.text} ${item.tag}`.toLowerCase().includes(term)) return;
            shown++;
            const li = document.createElement('li');
            li.className = 'todo-item' + (item.done ? ' done' : '');
            const c = tagColor(item.tag);
            li.innerHTML = `<label><input type="checkbox" ${item.done ? 'checked' : ''}><span></span></label>
                <span class="todo-tag${c ? ' rc' : ''}" ${c ? `style="--c:${c}"` : ''}></span>
                <button type="button" aria-label="Löschen" title="Löschen">${ic('trash')}</button>`;
            li.querySelector('label span').textContent = item.text;
            li.querySelector('.todo-tag').textContent = item.tag;
            li.querySelector('input').onchange = () => toggleTodo(idx);
            li.querySelector('button').onclick = () => deleteTodo(idx);
            ul.appendChild(li);
        });
        $('#todoEmpty').hidden = !(term && todoList.length && !shown);
        const pct = todoList.length ? Math.round(done / todoList.length * 100) : 0;
        $('#todoProgress').textContent = `${done}/${todoList.length} erledigt (${pct}%)`;
    }
    function toggleTodo(idx) {
        const item = todoList[idx];
        if (!editable()) { renderTodos(); return; }
        item.done = !item.done;
        renderTodos();
        dbWrite(() => q(TB.sb.from('travelbase_todos').update({ done: item.done }).eq('id', item.id)));
    }
    function addTodo() {
        const text = $('#newTodoText').value.trim();
        if (!text) return alert('Bitte Text eingeben!');
        if (!editable()) return;
        const tag = $('#newTodoTag').value;
        const sort_order = todoList.reduce((m, x) => Math.max(m, x.sort_order || 0), -1) + 1;
        $('#newTodoText').value = '';
        dbWrite(async () => {
            const row = await q(TB.sb.from('travelbase_todos').insert({ trip_id: TRIP_ID, text, tag, done: false, sort_order }).select('id, text, tag, done, sort_order').single());
            todoList.push(row);
            TB.cacheSet(LIST_CACHE, todoList);
            renderTodos();
        });
    }
    function deleteTodo(idx) {
        const item = todoList[idx];
        if (!editable()) return;
        if (!confirm(`„${item.text}“ löschen?`)) return;
        todoList.splice(idx, 1);
        renderTodos();
        dbWrite(() => q(TB.sb.from('travelbase_todos').delete().eq('id', item.id)));
    }
    function initTodos() {
        if (!DATA.todos) return;
        $('#todoBox').hidden = false;
        const tags = DATA.todos.tags || [{ label: 'Allgemein' }];
        $('#newTodoTag').innerHTML = tags.map(t => `<option>${esc(t.label)}</option>`).join('');
        $('#addTodoBtn').onclick = addTodo;
        $('#newTodoText').onkeydown = e => { if (e.key === 'Enter') addTodo(); };
        $('#todoSearch').oninput = renderTodos;
        loadTodos();
    }

    /* ---------- Hell/Dunkel ---------- */
    function applyTheme(dark, save) {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? '#000000' : '#f2f2f7';
        document.querySelectorAll('.theme-toggle').forEach(b => { b.innerHTML = ic(dark ? 'sun' : 'moon'); b.setAttribute('aria-label', dark ? 'Zum hellen Modus wechseln' : 'Zum dunklen Modus wechseln'); });
        if (save) { try { localStorage.setItem('overall-theme', dark ? 'dark' : 'light'); } catch (e) {} }
    }

    /* ---------- Start ---------- */
    const safe = fn => { try { fn(); } catch (err) { console.error('Startfehler in', fn.name || 'Schritt', err); } };
    window.addEventListener('DOMContentLoaded', async () => {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'dark', false);
        document.querySelectorAll('.theme-toggle').forEach(b => b.onclick = e => { e.stopPropagation(); applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark', true); });
        $('#closePopover').onclick = () => $('#navPopover').classList.remove('open');
        $('#navPopover').onclick = e => { if (e.target === $('#navPopover')) $('#navPopover').classList.remove('open'); };
        $('#fs').onclick = () => { const f = $('#mapBox').classList.toggle('full'); $('#fs').innerHTML = f ? ic('shrink') + 'Verkleinern' : ic('expand') + 'Vollbild'; setTimeout(() => map && map.invalidateSize(), 200); };
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if ($('#mapBox').classList.contains('full')) $('#fs').click();
            $('#navPopover').classList.remove('open');
        });
        $('#tbLogout').onclick = async () => { await TB.signOut(); location.href = '../'; };

        if (!await load()) return;
        document.body.classList.remove('tb-loading');
        gate('');
        const m = DATA.meta || {};
        if (!DATA.plans && m.detailsFor) {
            $('#tbLimited').hidden = false;
            $('#tbLimited').innerHTML = ic('eye') + `<span>Du siehst die Route und den Zeitraum. Weitere Details sind nur für ${m.detailsFor === 'admin' ? 'den Admin' : 'Mitreisende'} sichtbar.</span>`;
        }
        safe(renderHeader);
        safe(renderNav);
        safe(renderPlanPanes);
        safe(initMap);
        safe(renderCal);
        safe(renderMisc);
        safe(initTodos);
        tabFromHash();
        window.addEventListener('hashchange', tabFromHash);
    });
    if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js').catch(() => {}));
})();
