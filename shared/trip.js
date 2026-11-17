/* TravelBase – Reise-Vorlage
   Baut die komplette Reiseseite aus den Daten in Supabase (trip_sections) auf.
   Welche Bereiche erscheinen, hängt nur davon ab, welche Daten die eigene Rolle sehen darf:
     meta, places, routes, routeStyles, legend, bounds          → Karte & Zeitraum (alle)
     plans, regions, persons, calendar, flights, infos, links,
     todos, workdays, climate, stations                         → je nach min_role des Abschnitts
   Live-Planung (shared/planner.js): Mitreisende und Admins bearbeiten Stopps, Ablauf, Unterkünfte und Transporte.
   Bearbeitet wird RAW (die Daten wie in der Datenbank); DATA ist die daraus abgeleitete Anzeige
   (z. B. mit verschobenen Daten bei Vielleicht-Reisen) und wird nach jeder Änderung neu erzeugt. */
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
    /* Inhalte, die Mitreisende schreiben: HTML säubern, Farben prüfen (ältere travelbase.js aus dem Cache → escapen) */
    const rich = s => window.TB && TB.safeHtml ? TB.safeHtml(s) : esc(s);
    const col = (c, f = '#15803d') => window.TB && TB.safeColor ? TB.safeColor(c, f) : f;
    /* "Heute" – zum Testen per URL überschreibbar: ?heute=2027-04-10 */
    const TODAY = (() => { const q = new URLSearchParams(location.search).get('heute'); return /^\d{4}-\d{2}-\d{2}$/.test(q || '') ? q : localISO(new Date()); })();
    const TRIP_SLUG = (() => { const p = location.pathname.replace(/index\.html$/, '').split('/').filter(Boolean); return p[p.length - 1]; })();

    let DATA = null, RAW = null, RES = null, ROLE = null, TRIP_ID = null, TRIP_FLAGS = [], TRIP_MAYBE = false, map = null;
    let markers = {};
    const canEdit = () => ROLE === 'admin' || ROLE === 'member';
    const clone = v => JSON.parse(JSON.stringify(v));
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
        RES = res; RAW = res.data; ROLE = res.role; TRIP_ID = res.trip.id; TRIP_FLAGS = res.trip.flags || []; TRIP_MAYBE = !!res.trip.tentative;
        /* Ablauf-IDs werden als HTML-id benutzt: nur sichere Zeichen */
        (RAW.plans || []).forEach((p, i) => { if (!/^[A-Za-z][\w-]{0,40}$/.test(p.id || '')) p.id = 'plan' + (i + 1); p.rows = Array.isArray(p.rows) ? p.rows : []; });
        /* Neue Reise ohne Ablauf: leeren Ablauf zum Befüllen anbieten (gespeichert wird erst mit dem ersten Tag) */
        if (canEdit() && Array.isArray(RAW.plans) && !RAW.plans.length) newPlan();
        derive();
        $('#tbWho').innerHTML = ic('person') + esc(res.user.name || res.user.email);
        $('#tbOffline').hidden = !res.offline;
        return true;
    }

    function newPlan() {
        RAW.plans = RAW.plans || [];
        const p = { id: 'ablauf', title: 'Möglicher Ablauf', tabLabel: 'Möglicher Ablauf', rows: [] };
        RAW.plans.push(p);
        return p;
    }
    /* Anzeige-Daten aus RAW ableiten */
    let LEG_END = false;
    function derive() {
        DATA = clone(RAW);
        applyChosenStart(RES.trip);
        applyLegs();
    }
    /* Etappen (Nächte je Stopp, shared/planner.js): Daten der Stopps für Karte/Popups; ohne festes Ende ergibt
       die Summe der Nächte das Reiseende */
    function applyLegs() {
        LEG_END = false;
        if (!window.TBPlanner || !TBPlanner.legs || !DATA.places) return;
        const m = DATA.meta = DATA.meta || {};
        const P = DATA.places;
        /* erneute Besuche („same“) tragen die Nummer des ersten Besuchs */
        if (TBPlanner.labels) TBPlanner.labels(P).forEach((n, k) => { P[k].label = n; });
        const L = TBPlanner.legs(P, m.start || null);
        if (!L.on) return;
        L.list.forEach(g => { if (P[g.k]) P[g.k].date = TBPlanner.legText(g); });
        /* Punkt auf der Karte = erster Besuch: zeigt alle Zeiträume */
        Object.values(P).forEach(p => { const o = p && p.same && P[p.same]; if (o && p.date && o !== p) o.date = [o.date, p.date].filter(Boolean).join(' · '); });
        if (L.end && (!m.end || m.end === m.start) && L.total > 0) {
            m.end = L.end; LEG_END = true;
            m.period = `${fmtDM(m.start)} – ${fmtDM(m.end)}${m.end.slice(0, 4)}`;
        }
    }

    /* ---------- Vielleicht-Reise mit gewähltem Startdatum ----------
       Tagespläne ohne Datum („Tag 1, Tag 2 …“) bekommen echte Tage, sobald die Reise ein Startdatum hat
       (auf der Übersicht wählbar). Zeitraum im Kopf, Countdown und Karten-Popups ziehen mit. */
    function applyChosenStart(trip) {
        if (!trip || !trip.start_date) return;
        const m0 = DATA.meta || {};
        if (m0.start && m0.start !== trip.start_date) return shiftTrip(m0.start, trip.start_date);
        const s0 = trip.start_date, WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
        const add = n => { const d = new Date(Date.UTC(+s0.slice(0, 4), +s0.slice(5, 7) - 1, +s0.slice(8, 10) + n)); return d.toISOString().slice(0, 10); };
        const label = iso => `${fmtDM(iso)} (${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]})`;
        const tagN = n => /^Tag (\d+)$/.exec(n || '');
        (DATA.plans || []).forEach(p => (p.rows || []).forEach((r, i) => {
            if (r.from) return;
            const m = tagN(r.date), off = m ? +m[1] - 1 : i;
            r.from = add(off); r.date = label(r.from);
        }));
        Object.values(DATA.places || {}).forEach(pl => {
            if (pl.date) pl.date = pl.date.replace(/Tag (\d+)/g, (_, n) => label(add(+n - 1)));
        });
        const m = DATA.meta = DATA.meta || {};
        if (!m.start) {
            m.start = s0; m.end = trip.end_date || s0;
            const range = `${fmtDM(m.start)} – ${fmtDM(m.end)}${m.end.slice(0, 4)}`;
            m.period = m.period ? m.period.replace(/^Zeitraum offen/, range) : range;
        }
    }

    /* Reise mit fertigem, datiertem Plan wurde auf der Übersicht verschoben (date_flexible):
       alle Daten rücken um dieselbe Zahl Tage – ISO-Daten in den Daten und „25.03. (Do)“ / „Do 25.03.“ in Texten.
       Feiertage (workdays.*.holidays) bleiben, wo sie sind. In der Datenbank bleibt der Plan unverändert. */
    function shiftTrip(base, start) {
        const off = dayNum(start) - dayNum(base);
        if (!off) return;
        const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
        const by = +base.slice(0, 4), bm = +base.slice(5, 7);
        const shiftISO = iso => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + off)).toISOString().slice(0, 10);
        const wd = iso => WD[new Date(iso + 'T12:00:00Z').getUTCDay()];
        const RX = /(?:\b(Mo|Di|Mi|Do|Fr|Sa|So),? )?\b(\d{2})\.(\d{2})\.(\d{4})?( \((?:Mo|Di|Mi|Do|Fr|Sa|So)\))?/g;
        const shiftText = t => t.replace(RX, (all, pre, d, mo, y, post) => {
            if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return all;
            const yy = y ? +y : by + (+mo < bm - 6 ? 1 : +mo > bm + 6 ? -1 : 0);
            const iso = shiftISO(`${yy}-${mo}-${d}`), w = wd(iso);
            return (pre ? w + ' ' : '') + `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` + (y ? iso.slice(0, 4) : '') + (post ? ` (${w})` : '');
        });
        const walk = (v, key) => {
            if (key === 'holidays') return v;
            if (typeof v === 'string') {
                if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return shiftISO(v);
                if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return shiftISO(v.slice(0, 10)) + v.slice(10);
                return shiftText(v);
            }
            if (Array.isArray(v)) return v.map(x => walk(x, key));
            if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k], k); return v; }
            return v;
        };
        walk(DATA);
    }

    /* ---------- Kopf ---------- */
    function renderHeader() {
        const m = DATA.meta || {};
        document.title = (m.title || 'Reise') + ' · TravelBase';
        $('#tripTitle').textContent = (m.icon || '🌍') + ' ' + (m.title || '');
        $('#tripPeriod').textContent = m.period || '';
        updateCountdown();
        if (!renderHeader.timer) renderHeader.timer = setInterval(updateCountdown, 30000);
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
        /* Etappen: Stopps mit Nächten als eigener Bereich (Inhalt aus shared/planner.js) */
        if (DATA.places && window.TBPlanner && TBPlanner.mountStops && (Object.keys(DATA.places).length || canEdit())) s.push({ id: 'stops', icon: ic('route'), label: 'Etappen', tab: true });
        (DATA.plans || []).forEach(p => s.push({ id: p.id, icon: p.icon ? esc(p.icon) : ic('calendar'), label: p.tabLabel || 'Tagesplan', tab: true }));
        /* Unterkünfte: wenn Daten da sind oder man sie anlegen darf (Gäste bekommen keine) */
        if ((Array.isArray(DATA.stations) && (DATA.stations.length || canEdit())) || (!DATA.stations && canEdit() && DATA.plans)) s.push({ id: 'acc', icon: ic('bed'), label: 'Unterkünfte', sub: 'bookings' });
        // Mögliche Aktivitäten: eingeschaltet über "activities": true in den Reisedaten (shared/activities.js)
        if (DATA.activities) s.push({ id: 'activities', icon: ic('sparkles'), label: 'Mögliche Aktivitäten' });
        /* Anwesenheit: alte Reisen mit calendar; sonst automatisch, sobald Etappen Nächte und Reisende haben */
        const legsOn = Object.values(DATA.places || {}).some(p => p && p.num != null && p.nights != null);
        if ((DATA.calendar || legsOn) && (DATA.persons || []).length) s.push({ id: 'cal', icon: ic('users'), label: 'Anwesenheit', tab: true });
        // To-Dos als eigener Bereich; eine ältere Seite aus dem Cache ohne #todos zeigt sie weiter unter „Infos & mehr“
        const todoPane = DATA.todos && !!$('#todos');
        if (todoPane) s.push({ id: 'todos', icon: ic('checkCircle'), label: 'To-Dos' });
        if ((DATA.persons || []).some(p => p.start) || DATA.workdays || (DATA.todos && !todoPane) || DATA.infos || DATA.links) s.push({ id: 'misc', icon: ic('info'), label: 'Infos & mehr' });
        if ((DATA.flights || []).length || (canEdit() && DATA.plans)) s.push({ id: 'flights', icon: ic('plane'), label: (DATA.flights || []).some(f => f.mode && f.mode !== 'flight') || canEdit() ? 'Flüge & Transporte' : 'Flüge', sub: 'bookings' });
        /* Buchungen: Unterkünfte und Transporte als Unterbereiche eines Bereichs (direkt hinter den Tagesplänen) */
        const subs = s.filter(x => x.sub === 'bookings');
        if (subs.length) s.splice(s.findIndex(x => x.sub) , 0, { id: 'bookings', icon: ic('ticket'), label: 'Buchungen', tab: true });
        if (DATA.climate) s.push({ id: 'climate', icon: ic('cloudSun'), label: 'Klima & Wetter' });
        return s;
    }
    let SECTIONS = [];
    function renderNav() {
        SECTIONS = sections();
        if (DATA.activities && !$('#activities')) $('#planPanes').insertAdjacentHTML('afterend', '<div id="activities" class="pane"></div>');
        if (SECTIONS.some(x => x.id === 'acc') && !$('#acc')) $('#planPanes').insertAdjacentHTML('afterend', '<div id="acc" class="pane"></div>');
        if (SECTIONS.some(x => x.id === 'stops') && !$('#stops')) $('#mapview').insertAdjacentHTML('afterend', '<div id="stops" class="pane"></div>');
        renderBookingsBar();
        const tabs = SECTIONS.filter(s => s.tab);
        $('#tabs').style.setProperty('--tab-count', tabs.length + 1);
        /* Schnellauswahl einzeilig: „Tagesplan Peru“ / „Möglicher Ablauf Peru“ → „Peru“ (voller Name als Tooltip) */
        $('#tabs').innerHTML = tabs.map(s => `<button class="tab" data-t="${esc(s.id)}" title="${esc(s.label)}"><span>${s.icon}</span>${esc(s.label.replace(/^(Tagesplan|Möglicher Ablauf) (?=\S)/, ''))}</button>`).join('')
            + '<button class="tab tab-menu" id="menuTab" type="button" aria-label="Menü öffnen"><span>' + ic('list') + '</span>Menü</button>';
        $('#popLinks').innerHTML = SECTIONS.filter(s => !s.sub).map(s => `<button data-t="${esc(s.id)}" class="pop-btn"><span>${s.icon}</span>${esc(s.label)}</button>`).join('');
        document.querySelectorAll('.tabs .tab[data-t]').forEach(b => b.onclick = () => switchTab(b.dataset.t));
        $('#menuTab').onclick = () => $('#navPopover').classList.add('open');
        document.querySelectorAll('.pop-btn').forEach(b => b.onclick = () => { switchTab(b.dataset.t); $('#navPopover').classList.remove('open'); });
    }
    /* Buchungen: Bereich mit umschaltbaren Unterbereichen (#acc, #flights wandern in #bookings) */
    let BK_SUB = null;
    function renderBookingsBar() {
        const subs = SECTIONS.filter(x => x.sub === 'bookings');
        if (!subs.length) return;
        let bk = $('#bookings');
        if (!bk) { $('#planPanes').insertAdjacentHTML('afterend', '<div id="bookings" class="pane"><div class="bk-bar" role="tablist" aria-label="Buchungen"></div></div>'); bk = $('#bookings'); }
        subs.forEach(x => { const el = $('#' + x.id); if (el && el.parentElement !== bk) { el.classList.remove('pane', 'on'); el.classList.add('bk-sub'); bk.appendChild(el); } });
        if (!subs.some(x => x.id === BK_SUB)) BK_SUB = subs[0].id;
        const st = window.TBPlanner && TBPlanner.ready ? TBPlanner.stationStats() : null, fl = (DATA.flights || []).length;
        const count = { acc: st && st.total ? `${st.booked}/${st.total}` : '', flights: fl ? String(fl) : '' };
        const short = { acc: 'Unterkünfte', flights: subs.find(x => x.id === 'flights') && /Transporte/.test(subs.find(x => x.id === 'flights').label) ? 'Transporte' : 'Flüge' };
        const bar = bk.querySelector('.bk-bar');
        bar.hidden = subs.length < 2;
        bar.innerHTML = subs.map(x => `<button type="button" role="tab" data-sub="${esc(x.id)}" aria-selected="${x.id === BK_SUB}">${x.icon}<span>${esc(short[x.id] || x.label)}</span>${count[x.id] ? `<small>${esc(count[x.id])}</small>` : ''}</button>`).join('');
        bar.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => switchTab(b.dataset.sub));
        showSub();
    }
    function showSub() {
        document.querySelectorAll('#bookings .bk-sub').forEach(x => x.classList.toggle('on', x.id === BK_SUB));
        document.querySelectorAll('#bookings .bk-bar [data-sub]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.sub === BK_SUB)));
    }
    let CURRENT = null;
    function switchTab(id) {
        /* alte Links (#acc, #flights) öffnen den Unterbereich der Buchungen */
        const sub = SECTIONS.find(s => s.id === id && s.sub);
        if (sub) { BK_SUB = id; id = sub.sub; showSub(); }
        if (!SECTIONS.some(s => s.id === id && !s.sub)) id = SECTIONS[0].id;
        CURRENT = id;
        document.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('on', x.dataset.t === id));
        document.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.id === id));
        document.querySelectorAll('.pop-btn').forEach(x => x.classList.toggle('on', x.dataset.t === id));
        const hash = id === 'bookings' && BK_SUB ? BK_SUB : id;
        if (location.hash !== '#' + hash) history.replaceState(null, '', location.pathname + location.search + '#' + hash);
        window.scrollTo(0, 0);
        if (window.TBTripMobile && TBTripMobile.mark) TBTripMobile.mark(id);
        if (id === 'mapview' && map) setTimeout(() => { map.invalidateSize(); fitStartView(); }, 50);
    }
    function tabFromHash() { switchTab(location.hash.replace('#', '') || SECTIONS[0].id); }

    /* ---------- Karte ---------- */
    const DEFAULT_STYLES = {
        road: { color: '#0d9488', weight: 3.5, opacity: .9 },
        flight: { color: '#059669', weight: 2.5, opacity: .85, dashArray: '6, 6' },
        transfer: { color: '#64748b', weight: 2, opacity: .6, dashArray: '3, 3' }
    };
    /* Kartenfarben nach anwesenden Personen ("mapColors": "persons"): Orte und Strecken in den Farben der Personen,
       die laut Ablauf dort sind (mehrere = Tortenstück-Punkt bzw. gestreifte Linie). Ohne Personen (Gäste) bleiben die Ortsfarben. */
    /* Neue Reisen (ohne "mapColors"): Reisende aus der Live-Planung färben immer; Stopps ohne "who" = alle */
    const autoPersons = () => !DATA.mapColors && (DATA.persons || []).length > 0;
    const byPersons = () => (DATA.mapColors === 'persons' || autoPersons()) && (DATA.persons || []).length;
    const whoColors = who => byPersons() ? (DATA.persons || []).filter(p => (who || []).includes(p.key)).map(p => col(p.color)) : [];
    function placeWho(k) {
        const p = (DATA.places || {})[k] || {};
        if (Array.isArray(p.who)) return p.who;
        const who = new Set();
        (DATA.plans || []).forEach(p => (p.rows || []).forEach(r => { if ((r.focus || []).includes(k)) (r.who || []).forEach(x => who.add(x)); }));
        if (!who.size && autoPersons() && p.num != null) return DATA.persons.map(x => x.key);
        return [...who];
    }
    function placeColorFor(keys) {
        if (keys.every(nobody)) return NOBODY;
        const who = new Set(); keys.forEach(k => placeWho(k).forEach(x => who.add(x)));
        return whoColors([...who]).length ? placeColor(keys[0], [...who]) : placeColor(keys[0]);
    }
    /* Stopp, bei dem bewusst niemand angehakt ist ("who": []): gelb */
    const NOBODY = '#eab308';
    const nobody = k => { const p = (DATA.places || {})[k]; return !!p && Array.isArray(p.who) && !p.who.length && byPersons(); };
    function placeColor(k, whoList) {
        if (!whoList && nobody(k)) return NOBODY;
        const cs = whoColors(whoList || placeWho(k));
        /* neue Reisen: Farbe kommt nur von den Reisenden; noch keine eingetragen = Farbe der ersten Person (Blau) */
        if (!cs.length) return DATA.mapColors ? col((DATA.places[k] || {}).color) : (DATA.persons || []).length ? col(DATA.persons[0].color) : '#2563eb';
        return cs.length === 1 ? cs[0] : `conic-gradient(${cs.map((c, i) => `${c} ${i / cs.length * 360}deg ${(i + 1) / cs.length * 360}deg`).join(', ')})`;
    }
    const legend = () => [...(byPersons() ? DATA.persons.map(p => [p.color, '●', p.name]) : []), ...(DATA.legend || [])].map(([c, sym, t]) => [col(c, 'var(--mute)'), esc(sym), t]);
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
            if (pts.length < 2) return;
            const st = styles[r.style] || DEFAULT_STYLES.road, cs = whoColors(r.who);
            if (!cs.length) return L.polyline(pts, st).addTo(map);
            /* mehrere Personen: Linie in Streifen ihrer Farben (Flüge behalten eine Lücke) */
            const seg = 10, gap = st.dashArray ? 8 : 0, period = seg * cs.length + gap;
            cs.forEach((color, i) => L.polyline(pts, { ...st, color, dashArray: period > seg ? `${seg} ${period - seg}` : null, dashOffset: String(-i * seg) }).addTo(map));
        });
        /* Ohne eigene Strecken: automatische Linie durch die Stopps in Reihenfolge */
        const PL = window.TBPlanner;
        if (!(DATA.routes || []).length && PL) {
            const pts = PL.routeStops(P).map(x => [+x.p.lat, +x.p.lng]);
            if (pts.length > 1) L.polyline(pts, { ...DEFAULT_STYLES.road, dashArray: '8, 6' }).addTo(map);
        }
        const all = [];
        Object.entries(P).forEach(([key, p]) => {
            if (!isFinite(+p.lat) || !isFinite(+p.lng)) return;
            /* erneuter Besuch: kein eigener Punkt, der Punkt des ersten Besuchs gilt */
            if (p.same && P[p.same]) return;
            /* Punkt mit erneuten Besuchen: Farben aller Reisenden, die bei einem der Besuche dort sind */
            const again = Object.keys(P).filter(x => P[x] && P[x].same === key);
            const color = again.length ? placeColorFor([key, ...again]) : placeColor(key), solid = whoColors(placeWho(key))[0] || (DATA.mapColors ? col(p.color) : placeColor(key));
            const popup = `<b style="color:${solid}">${ic('pin')} ${esc(p.name)}</b>${p.date ? `<br><small>${ic('calendar')} ${esc(p.date)}</small>` : ''}${p.desc ? `<br>${rich(p.desc)}` : ''}`;
            const m = p.num != null
                ? L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'nm', html: `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:${color}">${esc(p.label ?? p.num)}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
                : L.circleMarker([p.lat, p.lng], { color: solid, fillColor: solid, fillOpacity: .9, radius: +p.size || 6 });
            m.bindPopup(popup).addTo(map);
            markers[key] = m;
            all.push([p.lat, p.lng]);
        });
        if (legend().length) {
            const lg = L.control({ position: 'bottomright' });
            lg.onAdd = () => {
                const d = L.DomUtil.create('div', 'legend');
                d.innerHTML = `<div class="lh" style="cursor:pointer">${ic('info')}Legende <span>▼</span></div><div class="lb" style="display:none;margin-top:4px">${legend().map(([c, sym, t]) => `<span style="color:${c}">${sym}</span> ${esc(t)}`).join('<br>')}</div>`;
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
        renderStopPanel();
    }
    /* Karte nach Änderungen neu aufbauen, Ausschnitt bleibt */
    function rebuildMap() {
        if (!map) return initMap();
        const view = fitted ? { c: map.getCenter(), z: map.getZoom() } : null;
        map.remove(); map = null; markers = {};
        initMap();
        if (view) map.setView(view.c, view.z, { animate: false });
    }
    /* Stopp-Liste neben der Karte (Desktop: Split-View) + Distanz im Kopf */
    function renderStopPanel() {
        if (window.TBPlanner && TBPlanner.mountStops && DATA.places) TBPlanner.mountStops(RAW.places || {});
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
        const P = DATA.places || {};
        const ms = (keys || []).map(k => markers[k] || (P[k] && markers[P[k].same])).filter(Boolean);
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
        return `<span class="rg rc" style="--c:${col(r.color, '#64748b')}">${esc(r.label)}</span>`;
    }
    function whoBadge(row) {
        if (row.who && row.who.length) {
            const ps = row.who.map(personOf).filter(Boolean);
            return `<span class="who">${ps.map(p => `<i style="background:${col(p.color)}"></i>`).join('')}${esc(ps.map(p => p.name).join(', '))}</span>`;
        }
        if (row.group) return `<span class="who"><i style="background:${col(row.group.color, '#64748b')}"></i>${esc(row.group.label)}</span>`;
        return '';
    }
    const isToday = r => r.from && TODAY >= r.from && TODAY <= (r.to || r.from);
    function renderPlanPanes() {
        const PL = window.TBPlanner;
        $('#planPanes').innerHTML = (DATA.plans || []).map(p => `
            <div id="${esc(p.id)}" class="pane">
                <div class="box">
                    <div class="mh plan-head">
                        <h2>${esc(p.title)}</h2>
                        ${p.note ? `<p class="note" style="margin-bottom:0">${esc(p.note)}</p>` : ''}
                    </div>
                    ${PL && PL.ready ? PL.planToolbar(p.id) : ''}
                    <div class="controls">
                        <input type="search" class="q-input" data-plan="${esc(p.id)}" placeholder="Nach Ort, Aktivität oder Transport suchen …">
                        <span class="plan-filters" data-plan="${esc(p.id)}" style="display:contents"></span>
                    </div>
                    <div class="tw tw-route">
                        <table>
                            <thead><tr><th>Tag / Datum</th><th>Region</th><th>Ort &amp; Aktivität</th><th>Details &amp; Programm</th><th>Transport</th><th>${esc(p.hotelHeader || 'Unterkunft')}</th></tr></thead>
                            <tbody data-plan="${esc(p.id)}"></tbody>
                        </table>
                    </div>
                    <div class="cards" data-plan="${esc(p.id)}"></div>
                </div>
            </div>`).join('');
        (DATA.plans || []).forEach(p => {
            if (!planState[p.id] || !(p.rows || []).some(r => (r.regions || []).includes(planState[p.id]))) planState[p.id] = 'all';
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
        const dnCls = p.color ? ' alt' : '', dnStyle = p.color ? ` style="--c:${col(p.color)}"` : '';
        const pills = r => [r.transport, ...(Array.isArray(r.extra) ? r.extra : [])].filter(Boolean).map(t => `<span class="pill">${rich(t)}</span>`).join(' ');
        const hotel = r => r.hotel ? `<span class="pill hotel-pill${/noch offen|offen$/i.test(r.hotel) ? ' hotel-open' : ''}">${rich(r.hotel)}</span>` : '';
        const PL = window.TBPlanner, edit = i => PL && PL.ready ? PL.rowEditBtn(p.id, i) : '';
        const tbody = $(`tbody[data-plan="${p.id}"]`), cards = $(`.cards[data-plan="${p.id}"]`);
        /* Tage aus den Etappen, die noch keinen Eintrag haben (nur im ersten Ablauf), dazu die Ideen aus „Mögliche Aktivitäten“ */
        const virt = [];
        if (PL && PL.ready && PL.legDays && p === (DATA.plans || [])[0] && sel === 'all') {
            const seen = new Set();
            p.rows.forEach(r => { if (!r.from) return; for (let d = dayNum(r.from); d <= dayNum(r.to || r.from) && d - dayNum(r.from) < 400; d++) seen.add(new Date(d * 864e5).toISOString().slice(0, 10)); });
            const P = DATA.places || {};
            PL.legDays().forEach(v => { if (seen.has(v.iso)) return; const name = v.keys.map(k => (P[k] || {}).name || k).filter((x, i, a) => a.indexOf(x) === i).join(' → '); if (!q || name.toLowerCase().includes(q)) virt.push({ v, name }); });
        }
        const A = window.TBActivities && TBActivities.ideas ? TBActivities : null, shown = new Set();
        const ideas = keys => (keys || []).map(k => (DATA.places[k] || {}).name).filter(n => n && !shown.has(n) && shown.add(n)).map(n => { const xs = A ? A.ideas(n) : []; return xs.length ? `<div class="ab-ideas">${ic('sparkles')}<span><b>Ideen:</b> ${xs.slice(0, 6).map(a => esc(a.title)).join(' · ')}${xs.length > 6 ? ` · +${xs.length - 6}` : ''}</span></div>` : ''; }).join('');
        /* gespeicherte und Etappen-Tage nach Datum mischen */
        const items = [];
        let vi = 0;
        rows.forEach(r => { while (vi < virt.length && r.from && virt[vi].v.iso < r.from) items.push(virt[vi++]); items.push({ r }); });
        while (vi < virt.length) items.push(virt[vi++]);
        const canAdd = PL && PL.ready && PL.canEdit();
        const vRow = x => `<tr class="row ab-virt${x.v.iso === TODAY ? ' today-row' : ''}" data-v="${esc(x.v.keys.join(','))}">
                <td><span class="dn${dnCls}"${dnStyle}>Tag ${x.v.day}</span><div class="dt">${esc(fmtDM(x.v.iso))}</div></td><td></td>
                <td><div class="tt">${esc(x.name || 'Reisetag')}</div></td>
                <td>${ideas(x.v.keys)}${canAdd ? `<button type="button" class="ab-plan" data-pl="row-add" data-plan="${esc(p.id)}" data-iso="${esc(x.v.iso)}">${ic('plus')}Tag planen</button>` : '<span class="note">Noch nichts geplant.</span>'}</td><td></td><td></td></tr>`;
        const vCard = x => `<div class="card ab-virt" data-v="${esc(x.v.keys.join(','))}">
                <div class="ab-vline"><span class="dn${dnCls}"${dnStyle}>Tag ${x.v.day}</span><span class="card-date">${esc(fmtDM(x.v.iso))}</span><b>${esc(x.name || 'Reisetag')}</b>${canAdd ? `<button type="button" class="ab-plan ic-only" data-pl="row-add" data-plan="${esc(p.id)}" data-iso="${esc(x.v.iso)}" aria-label="Tag planen" title="Tag planen">${ic('plus')}</button>` : ''}</div>${ideas(x.v.keys)}</div>`;
        tbody.innerHTML = items.map(x => x.v ? vRow(x) : rowHtml(x.r)).join('') || `<tr><td colspan="6">${p.rows.length ? 'Keine Treffer.' : 'Noch keine Tage im Ablauf.'}</td></tr>`;
        shown.clear();
        cards.innerHTML = items.map(x => x.v ? vCard(x) : cardHtml(x.r)).join('');
        function rowHtml(r) { return `
            <tr class="row${isToday(r) ? ' today-row' : ''}" data-i="${p.rows.indexOf(r)}">
                <td><span class="dn${dnCls}"${dnStyle}>${esc(r.day)}</span>${edit(p.rows.indexOf(r))}<div class="dt">${esc(r.date)}</div>${whoBadge(r)}</td>
                <td>${(r.regions || []).map(regionBadge).join(' ')}</td>
                <td><div class="tt">${esc(r.title)}${isToday(r) ? `<span class="today-tag">${ic('star')}Heute</span>` : ''}</div></td>
                <td>${rich(r.details)}${ideas(r.focus)}</td>
                <td>${pills(r)}</td>
                <td>${hotel(r)}</td>
            </tr>`; }
        function cardHtml(r) { return `
            <div class="card${isToday(r) ? ' today-card' : ''}" data-i="${p.rows.indexOf(r)}">
                <div class="card-header">
                    <div class="card-meta"><span class="dn${dnCls}"${dnStyle}>${esc(r.day)}</span> <span class="card-date">${esc(r.date)}</span> ${whoBadge(r)}</div>
                    <span>${(r.regions || []).map(regionBadge).join(' ')}${edit(p.rows.indexOf(r))}</span>
                </div>
                <div class="card-title">${esc(r.title)}${isToday(r) ? `<span class="today-tag">${ic('star')}Heute</span>` : ''}</div>
                <div class="card-details">${rich(r.details)}${ideas(r.focus)}</div>
                <div class="card-footer">${pills(r)} ${hotel(r)}</div>
            </div>`; }
        const pick = e => { if (e.target.closest('.row-edit, a, [data-pl]')) return; const v = e.target.closest('[data-v]'); if (v) return focusPlaces(v.dataset.v.split(',').filter(Boolean)); const el = e.target.closest('[data-i]'); if (el && p.rows[+el.dataset.i]) focusPlaces(p.rows[+el.dataset.i].focus); };
        tbody.onclick = pick; cards.onclick = pick;
    }

    /* ---------- Anwesenheitskalender ---------- */
    function renderCal() {
        /* aus den Etappen (inkl. Anreise/Abreise), sobald diese Nächte haben; sonst wie bisher aus persons.start/end/home */
        const PLc = window.TBPlanner && TBPlanner.ready && TBPlanner.renderPresence ? TBPlanner : null;
        if (PLc && PLc.legs(RAW.places || {}).on && PLc.renderPresence({ title: $('#calTitle'), body: $('#calBody'), month: $('#calMonth') })) return;
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

    /* Höhe des Sticky-Headers als --hh, damit die Kopfzeile der Anwesenheitstabelle darunter klebt */
    const sh = $('.sticky-header');
    if (sh && window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--hh', sh.offsetHeight + 'px')).observe(sh);

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
        /* Reisezeiträume nur für Personen mit eigenem Zeitraum (Reisende aus der Live-Planung haben keinen) */
        const ps = (DATA.persons || []).filter(p => p.start && homeOf(p));
        $('#statsBox').hidden = !ps.length;
        if (ps.length) {
            $('#stats').innerHTML = ps.map(p => `<div class="stat"><span style="color:${p.color}">●</span> ${esc(p.name)}<b>${dayNum(homeOf(p)) - dayNum(p.start) + 1} Tage</b>${fmtDM(p.start)} – ${fmtDM(homeOf(p))}</div>`).join('');
        }
        const w = DATA.workdays;
        if (w && TODAY < w.until) {
            $('#workBox').hidden = false;
            $('#workNote').textContent = `Verbleibende Werktage (Mo–Fr) ab heute bis zum Abflug am ${fmtDM(w.until)}${w.until.slice(0, 4)}. Gesetzliche Feiertage und persönliche Urlaubstage sind bereits abgezogen.`;
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
            $('#infoList').innerHTML = DATA.infos.map(i => `<li><strong>${esc(i.title)}:</strong> ${rich(i.text)}</li>`).join('');
        }
        if ((DATA.links || []).length) {
            $('#linkBox').hidden = false;
            $('#linkRow').innerHTML = DATA.links.map(l => `<a class="btn ql" href="${esc(l.url)}" target="_blank" rel="noopener">${ic('toolbox')}Link zu den Quick Tools${l.label ? ` · ${esc(l.label)}` : ''} ↗</a>`).join('');
        }
        if (window.TBPlanner && TBPlanner.ready && SECTIONS.some(x => x.id === 'flights')) {
            const h = $('#flights h2');
            if (h) h.innerHTML = ic('plane') + esc(SECTIONS.find(x => x.id === 'flights').label);
            TBPlanner.renderTransports($('#flightList'));
        } else if ((DATA.flights || []).length) {
            const fc = window.tbFlights;
            $('#flightList').innerHTML = DATA.flights.map(f => fc && fc.isCard(f) ? fc.card(f) : `
                <li>
                    <div class="fl-date">${esc(f.date)}</div>
                    <div class="fl-route">${esc(f.route)}</div>
                    ${f.duration ? `<div class="fl-dur">${ic('clock')}${esc(f.duration)}</div>` : ''}
                    ${f.details ? `<div class="fl-details">${rich(f.details)}</div>` : ''}
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
            li.className = 'todo-item sw-row' + (item.done ? ' done' : '');
            const c = tagColor(item.tag);
            li.innerHTML = `<label><input type="checkbox" ${item.done ? 'checked' : ''}><span></span></label>
                <span class="todo-tag${c ? ' rc' : ''}" ${c ? `style="--c:${c}"` : ''}></span>
                <span class="sw-acts"><button type="button" class="sw-edit" aria-label="Bearbeiten" title="Bearbeiten">${ic('pencil')}</button><button type="button" class="sw-del" aria-label="Löschen" title="Löschen">${ic('trash')}</button></span>`;
            li.querySelector('label span').textContent = item.text;
            li.querySelector('.todo-tag').textContent = item.tag;
            li.querySelector('input').onchange = () => toggleTodo(idx);
            li.querySelector('.sw-edit').onclick = () => editTodo(idx);
            li.querySelector('.sw-del').onclick = () => deleteTodo(idx);
            ul.appendChild(li);
        });
        $('#todoEmpty').hidden = !(term && todoList.length && !shown);
        const pct = todoList.length ? Math.round(done / todoList.length * 100) : 0;
        $('#todoProgress').textContent = `${done}/${todoList.length} erledigt (${pct}%)`;
        /* Fortschritt auch auf der Kachel der Handy-Übersicht */
        if (window.TBTripMobile && TBTripMobile.setTile && todoList.length) TBTripMobile.setTile('todos', { text: `${done} / ${todoList.length}`, pct });
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
    /* To-Do bearbeiten (Text und Kategorie); auf dem Handy per Wischen nach links */
    function editTodo(idx) {
        const item = todoList[idx];
        if (!item || !editable()) return;
        const save = (text, tag) => {
            text = String(text || '').trim();
            if (!text) return;
            Object.assign(item, { text, tag });
            renderTodos();
            dbWrite(() => q(TB.sb.from('travelbase_todos').update({ text, tag }).eq('id', item.id)));
        };
        const PL = window.TBPlanner && TBPlanner.ready && TBPlanner.sheet ? TBPlanner : null;
        if (!PL) { const t = prompt('To-Do:', item.text); if (t !== null) save(t, item.tag); return; }
        const tags = (DATA.todos.tags || [{ label: 'Allgemein' }]).map(t => [t.label, t.label]);
        if (item.tag && !tags.some(t => t[0] === item.tag)) tags.push([item.tag, item.tag]);
        const u = PL.ui;
        PL.sheet({
            title: 'To-Do bearbeiten',
            body: u.field('Aufgabe', u.area('text', item.text, 'rows="2" maxlength="500" required')) + u.field('Kategorie', u.sel('tag', item.tag, tags)),
            done: f => { const t = u.val(f, 'text'); if (!t) { alert('Bitte einen Text eingeben.'); return false; } save(t, u.val(f, 'tag')); }
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

    /* ---------- Handy-Übersicht der Reise (shared/trip-mobile.js): Heute, Route, Zusatzinfos der Kacheln ---------- */
    function mobileData() {
        if (!window.TBTripMobile) return;
        const m = DATA.meta || {}, plans = DATA.plans || [], P = DATA.places || {};
        const rows = plans.flatMap(p => p.rows || []);
        const now = dayNum(TODAY), s = m.start ? dayNum(m.start) : null, e = m.end ? dayNum(m.end) : s;
        const past = s != null && now > e;
        /* Heute (unterwegs) bzw. der erste Tag (vor der Reise) */
        let today = null;
        const tr = rows.find(isToday);
        if (tr) today = { ...tr, label: 'Heute' };
        else if (s != null && now < s && rows[0]) today = { ...rows[0], label: 'Los geht’s' };
        /* Route: Tagesplan-Zeilen nach Ort zusammenfassen; ohne Tagesplan (Gäste) die Orte nach Nummer */
        let route = [];
        const fmt = iso => iso ? fmtDM(iso) : '';
        const placeStops = Object.entries(P).filter(([, p]) => p && p.num != null).sort((a, b) => a[1].num - b[1].num).map(([k, p]) => ({ k, num: p.label ?? p.num, name: p.name, color: placeColor(k), when: p.date || '' }));
        if (rows.length) {
            rows.forEach(r => (r.focus || []).forEach((k, i, all) => {
                const last = route[route.length - 1], p = P[k] || {};
                const from = r.from, to = all.length > 1 ? null : (r.to || r.from);
                if (last && last.k === k) { if (to) last.to = to; last.rows.push(r); return; }
                route.push({ k, num: p.label ?? p.num, name: p.name || k, color: placeColor(k), from: i === 0 ? from : null, to, rows: [r] });
            }));
            route.forEach(x => {
                const n = x.from && x.to ? dayNum(x.to) - dayNum(x.from) + 1 : 0;
                x.when = x.from ? fmt(x.from) + (x.to && x.to !== x.from ? ' – ' + fmt(x.to) : '') + (n ? ` · ${n} ${n > 1 ? 'Tage' : 'Tag'}` : '') : (x.rows[0].date || '');
                x.now = x.rows.some(isToday);
            });
        }
        /* Etappen mit Nächten: Route = Etappen (gleiche Nummern, Farben und Zeiträume wie im Bereich Etappen) */
        const PLr = window.TBPlanner && TBPlanner.ready && TBPlanner.legs ? TBPlanner : null, LG = PLr ? PLr.legs(RAW.places || {}, m.start || null) : null;
        if (LG && LG.on && LG.list.length) route = LG.list.map(g => ({
            k: g.k, num: (P[g.k] || {}).label ?? g.p.num, name: g.p.name || g.k, color: placeColor(g.k),
            when: [g.from ? (g.n ? `${fmt(g.from)} – ${fmt(g.to)}` : fmt(g.from)) : '', g.n ? `${g.n} ${g.n === 1 ? 'Nacht' : 'Nächte'}` : 'Zwischenstopp'].filter(Boolean).join(' · '),
            now: !!(g.from && TODAY >= g.from && TODAY < (g.n ? g.to : g.from + 'z'))
        }));
        /* ohne Tagesplan (Gäste) oder ohne Ortszuordnung in den Zeilen: die Orte nach Nummer */
        if (!route.length) route = placeStops;
        /* Etappen-Häkchen: places[k].noRoute blendet in der Route aus, noActs bei den möglichen Aktivitäten (erneute Besuche: der erste Besuch zählt für Aktivitäten) */
        const flagOf = (x, f) => { const p = x.k && P[x.k]; if (!p) return false; return f === 'noActs' && p.same && P[p.same] ? !!P[p.same][f] : !!p[f]; };
        const actRoute = route.concat(placeStops).map(x => flagOf(x, 'noActs') ? { ...x, hide: true } : x);
        route = route.filter(x => !flagOf(x, 'noRoute'));
        /* kurze Zusatzinfos unter den Kacheln */
        const tiles = {};
        if (DATA.places) tiles.mapview = { text: `${Object.values(P).filter(p => !(p && p.same && P[p.same])).length} Orte` };
        /* Zeilen können mehrere Tage umfassen („Tag 33–38“) */
        plans.forEach(p => { tiles[p.id] = { text: `${p.rows.reduce((n, r) => n + (r.from && r.to ? dayNum(r.to) - dayNum(r.from) + 1 : 1), 0)} Tage` }; });
        if ((DATA.persons || []).length) tiles.cal = { text: `${DATA.persons.length} Personen` };
        if ((DATA.flights || []).length) tiles.flights = { text: `${DATA.flights.length} ${DATA.flights.some(f => f.mode && f.mode !== 'flight') ? 'Einträge' : 'Flüge'}` };
        if (window.TBPlanner && TBPlanner.ready && SECTIONS.some(x => x.id === 'acc')) {
            const st = TBPlanner.stationStats(), w = TBPlanner.warnings().length;
            tiles.acc = { text: w ? `${w}× Storno-Frist!` : st.total ? `${st.booked}/${st.total} gebucht` : 'Noch leer' };
        }
        if (SECTIONS.some(x => x.id === 'bookings')) tiles.bookings = { text: [tiles.acc && tiles.acc.text !== 'Noch leer' && tiles.acc.text, tiles.flights && tiles.flights.text].filter(Boolean).join(' · ') || 'Noch leer' };
        if (window.TBPlanner && TBPlanner.ready && TBPlanner.legs) {
            const g = TBPlanner.legs(RAW.places || {}), n = Object.values(P).filter(p => p && p.num != null).length;
            tiles.stops = { text: g.on ? `${n} Stopps · ${g.total} ${g.total === 1 ? 'Nacht' : 'Nächte'}` : n ? `${n} Stopps` : 'Noch leer' };
        }
        if (DATA.climate) tiles.climate = { text: `${(DATA.climate.rows || []).length} Orte` };
        if ((DATA.infos || []).length) tiles.misc = { text: `${DATA.infos.length} Hinweise` };
        const people = (DATA.persons || []).map(p => p.name).join(', ');
        TBTripMobile.setData({ flags: TRIP_FLAGS, past, maybe: TRIP_MAYBE, today, route, tiles, people });
        if (DATA.activities) {
            /* Aktivitäten: Orte der Route, dazu alle nummerierten Stopps, die (noch) in keiner Zeile stehen */
            const stops = actRoute;
            if (window.TBActivities && TBActivities.ready && TBActivities.setStops) return TBActivities.setStops(stops);
            const go = () => TBActivities.init({ tripId: TRIP_ID, slug: TRIP_SLUG, stops });
            if (window.TBActivities) return go();
            const sc = document.createElement('script');
            sc.src = '../shared/activities.js'; sc.onload = go;
            document.head.appendChild(sc);
        }
    }

    /* ---------- Live-Planung (shared/planner.js) ---------- */
    function initPlanner() {
        if (!window.TBPlanner || !RES) return;
        TBPlanner.init({
            tripId: TRIP_ID, slug: TRIP_SLUG, role: ROLE, offline: !!RES.offline, today: TODAY,
            get raw() { return RAW; },
            sections: RES.sections || [],
            meta: () => DATA.meta || {},
            plans: () => RAW.plans || [],
            planKey: 'plans', rowFormat: 'template',
            stationGroups: () => Array.isArray(RAW.stations) ? [{ id: 'all', label: '', list: RAW.stations }] : [],
            ensureStations: () => { RAW.stations = []; return { id: 'all', label: '', list: RAW.stations }; },
            newPlan,
            legEnd: () => LEG_END,
            /* Reisebeginn: der Planer speichert meta.start (die Datenbank zieht travelbase_trips.start_date mit);
               hier nur das geladene Reise-Datum angleichen, damit applyChosenStart nicht zurückschiebt */
            setStart: async (start, end) => {
                if (RES.trip && RES.trip.start_date) { RES.trip.start_date = start; RES.trip.end_date = end || start; }
                return false;
            },
            placeColor: k => placeColor(k),
            suggestPeople: async () => {
                const me = RES.user && RES.user.name, ms = await TB.tripMembers();
                return [me, ...ms.filter(x => x.trip_id === TRIP_ID && x.role !== 'guest').map(x => x.name)].filter(Boolean);
            },
            refresh: rerender,
            focusPlace: k => focusPlaces([k])
        });
    }
    function renderAcc() {
        const pane = $('#acc');
        if (pane && window.TBPlanner && TBPlanner.ready && SECTIONS.some(x => x.id === 'acc')) TBPlanner.renderAcc(pane);
        renderCancelBanner();
    }
    /* Hinweis oben in der Reise: Storno-Fristen in den nächsten 7 Tagen oder abgelaufen */
    function renderCancelBanner() {
        if (!window.TBPlanner || !TBPlanner.ready) return;
        let el = $('#tbCancelWarn');
        if (!el) { $('#tbLimited').insertAdjacentHTML('afterend', '<div id="tbCancelWarn" class="tb-banner pl-warn" hidden></div>'); el = $('#tbCancelWarn'); }
        const w = TBPlanner.warnings();
        el.hidden = !w.length;
        el.innerHTML = w.length ? `${ic('alert')}<span><b>Storno-Frist${w.length > 1 ? 'en' : ''}:</b> ${w.map(x => `${esc(x.name)} – ${esc(x.text)}`).join(' · ')} <button type="button" class="link-inline" data-goto="acc">Zu den Unterkünften</button></span>` : '';
        const b = el.querySelector('[data-goto]');
        if (b) b.onclick = () => { BK_SUB = 'acc'; const x = document.querySelector('.pop-btn[data-t="bookings"]'); if (x) x.click(); document.body.classList.remove('m-home'); };
    }
    /* Nach jeder Änderung: Anzeige aus RAW neu ableiten und alles neu zeichnen, aktiver Bereich bleibt */
    /* Ideen aus „Mögliche Aktivitäten“ erscheinen im Ablauf */
    let actTimer = 0;
    document.addEventListener('tb:activities', () => { clearTimeout(actTimer); actTimer = setTimeout(() => { if (DATA) (DATA.plans || []).forEach(p => { if ($(`tbody[data-plan="${p.id}"]`)) safe(() => renderPlan(p)); }); }, 50); });
    function rerender() {
        const keep = CURRENT, y = window.scrollY;
        derive();
        safe(renderHeader);
        safe(renderNav);
        safe(renderPlanPanes);
        safe(rebuildMap);
        safe(renderCal);
        safe(renderMisc);
        safe(renderAcc);
        safe(mobileData);
        if (keep) {
            document.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('on', x.dataset.t === keep));
            document.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.id === keep));
            document.querySelectorAll('.pop-btn').forEach(x => x.classList.toggle('on', x.dataset.t === keep));
            CURRENT = keep;
        }
        window.scrollTo(0, y);
    }

    /* ---------- Hell/Dunkel ---------- */
    function applyTheme(dark, save) {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? '#000000' : '#f2f2f7';
        document.querySelectorAll('.theme-toggle').forEach(b => { b.innerHTML = ic(dark ? 'sun' : 'moon'); b.setAttribute('aria-label', dark ? 'Zum hellen Modus wechseln' : 'Zum dunklen Modus wechseln'); });
        if (save) { try { localStorage.setItem('overall-theme', dark ? 'dark' : 'light'); } catch (e) {} }
    }

    /* Ältere Reise-Seite aus dem Cache ohne planner.js: bei Bedarf nachladen */
    function ensurePlanner() {
        if (window.TBPlanner) return Promise.resolve();
        return new Promise(res => {
            const sc = document.createElement('script');
            sc.src = '../shared/planner.js'; sc.onload = sc.onerror = () => res();
            document.head.appendChild(sc);
        });
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
        await ensurePlanner();
        safe(initPlanner);
        safe(renderHeader);
        safe(renderNav);
        safe(renderPlanPanes);
        safe(initMap);
        safe(renderCal);
        safe(renderMisc);
        safe(renderAcc);
        safe(initTodos);
        tabFromHash();
        window.addEventListener('hashchange', tabFromHash);
        safe(mobileData);
    });
    if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js').catch(() => {}));
})();
