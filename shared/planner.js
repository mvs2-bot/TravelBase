/* TravelBase – Live-Planung (Vorlage und Thailand)
   Bearbeiten direkt in der Oberfläche, gespeichert in travelbase_trip_sections über die RPC travelbase_save_trip_section
   (TB.saveSection). Jede Änderung ersetzt ganze Schlüssel der obersten Ebene (places, plans/days, stations, flights);
   ein Konfliktschutz über updated_at verhindert, dass sich zwei Geräte gegenseitig überschreiben.

   Bereiche
     Stopps      Liste neben der Karte: hinzufügen, bearbeiten (Ortssuche über OpenStreetMap Nominatim), löschen,
                 umsortieren; Luftlinien-Distanzen zwischen den Stopps und gesamt
     Etappen     Nächte je nummeriertem Stopp (places[k].nights, − / +) sind die zentrale Planung: Ankunft = Reisebeginn
                 + Nächte davor. Unterkünfte (place-Verknüpfung), Tagesplan (plan.legs = true) und ein offenes Reiseende
                 richten sich danach.
     Ablauf      Tageszeilen bearbeiten, hinzufügen, löschen, umsortieren; leere Tage aus Start/Ende erzeugen
     Unterkünfte Tabelle (Desktop) / Karten (Handy), Storno-Fristen-Wächter, Lücken zwischen Stationen
     Transporte  Flug, Zug, Fähre, Bus, Mietwagen (Karten aus shared/flights.js) inkl. Buchungscode & Preis

   Die Seite übergibt ihre Daten mit TBPlanner.init(host):
     host = { tripId, slug, role, offline, raw, sections, today,
              meta()          → { start, end } (abgeleitet, ISO),
              plans()         → [{ id, title, rows }] – rows sind die Original-Arrays in raw,
              planKey         'plans' (Vorlage) | 'days' (Thailand),
              rowFormat       'template' | 'thailand',
              stationGroups() → [{ id, label, list }] – Original-Arrays in raw.stations,
              newPlan()       optional: legt einen leeren Ablauf in raw an und gibt ihn zurück,
              refresh(keys)   Seite aus raw neu zeichnen,
              focusPlace(k) }
   Schreiben nur online und nur für member/admin (die Datenbank prüft das ebenfalls). Gäste sehen nichts davon. */
(function () {
    'use strict';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = n => window.tbIcon ? tbIcon(n) : '';
    const rich = s => window.TB && TB.safeHtml ? TB.safeHtml(s) : esc(s);
    const color = (c, f) => window.TB && TB.safeColor ? TB.safeColor(c, f) : 'var(--p1)';
    const url = u => window.TB && TB.safeUrl ? TB.safeUrl(u) : '';
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const dn = iso => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5);
    const isoOf = n => new Date(n * 864e5).toISOString().slice(0, 10);
    const fmt = iso => ISO.test(iso || '') ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '';
    const fmtY = iso => ISO.test(iso || '') ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
    const label = iso => ISO.test(iso || '') ? `${fmt(iso)} (${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]})` : '';
    const uid = () => Math.random().toString(36).slice(2, 10);
    const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    const ORDER = { guest: 0, member: 1, admin: 2 };

    let H = null;
    const raw = () => H.raw;
    const canEdit = () => !!H && (H.role === 'admin' || H.role === 'member');

    /* ---------- Speichern ---------- */
    function editable() {
        if (!canEdit()) return false;
        if (H.offline || !navigator.onLine) { alert('Offline – Änderungen sind gerade nicht möglich. Bitte später mit Internet erneut versuchen.'); return false; }
        return true;
    }
    function sectionFor(key) {
        const has = H.sections.filter(s => (s.keys || []).includes(key)).sort((a, b) => (ORDER[b.key] ?? 9) - (ORDER[a.key] ?? 9));
        if (has[0]) return has[0];
        const want = key === 'places' || key === 'routes' ? 'guest' : 'member';
        return H.sections.find(s => s.key === want) || H.sections.find(s => s.min_role === want)
            || { key: want, min_role: want, keys: [], updated_at: null, isNew: true };
    }
    let busy = false;
    /* Ändern → sofort neu zeichnen → speichern; bei Fehler alten Stand zurück */
    async function commit(keys, mutate) {
        if (busy) { alert('Einen Moment – die letzte Änderung wird noch gespeichert.'); return false; }
        const before = {};
        keys.forEach(k => { before[k] = clone(raw()[k]); });
        try { mutate(); } catch (e) { console.error(e); return false; }
        H.refresh(keys);
        busy = true; status('saving');
        try {
            const bySec = new Map();
            keys.forEach(k => { const s = sectionFor(k); if (!bySec.has(s)) bySec.set(s, {}); bySec.get(s)[k] = raw()[k] === undefined ? null : raw()[k]; });
            for (const [sec, patch] of bySec) {
                const r = await TB.saveSection(H.tripId, sec.key, patch, sec.min_role, sec.updated_at);
                sec.updated_at = r.updated_at;
                Object.keys(patch).forEach(k => { if (patch[k] === null) sec.keys = sec.keys.filter(x => x !== k); else if (!sec.keys.includes(k)) sec.keys.push(k); });
                if (sec.isNew) { delete sec.isNew; H.sections.push(sec); }
            }
            TB.updateTripCache(H.slug, c => { keys.forEach(k => { c.data[k] = raw()[k]; }); c.sections = H.sections; });
            status('ok');
            return true;
        } catch (e) {
            keys.forEach(k => { if (before[k] === undefined) delete raw()[k]; else raw()[k] = before[k]; });
            H.refresh(keys);
            status('err');
            const m = TB.errorText(e);
            if (/Konflikt/.test(m)) { if (confirm('Jemand hat die Reise inzwischen geändert. Jetzt neu laden?')) location.reload(); }
            else alert('Speichern fehlgeschlagen: ' + m);
            return false;
        } finally { busy = false; }
    }
    /* kleiner Hinweis unten: „Gespeichert“ */
    let toastEl = null, toastT = 0;
    function status(s) {
        if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'pl-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
        clearTimeout(toastT);
        toastEl.className = 'pl-toast show ' + s;
        toastEl.innerHTML = s === 'saving' ? ic('refresh') + 'Speichert …' : s === 'ok' ? ic('check') + 'Gespeichert' : s === 'copied' ? ic('copy') + 'Kopiert' : ic('alert') + 'Nicht gespeichert';
        if (s !== 'saving') toastT = setTimeout(() => toastEl.classList.remove('show'), 1800);
    }

    /* ---------- Bottom-Sheet / Modal (ein <dialog> für alle Masken) ---------- */
    let dlg = null, onSubmit = null;
    function sheet({ title, body, submit = 'Speichern', extra = '', onOpen, done }) {
        if (!dlg) {
            dlg = document.createElement('dialog');
            dlg.className = 'pl-sheet';
            dlg.innerHTML = '<form method="dialog" class="pl-form" novalidate></form>';
            document.body.appendChild(dlg);
            dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
            dlg.querySelector('form').addEventListener('submit', async e => {
                e.preventDefault();
                const f = e.target, b = f.querySelector('.pl-save');
                if (!onSubmit) return dlg.close();
                b.disabled = true;
                try { if (await onSubmit(f) !== false) dlg.close(); } finally { b.disabled = false; }
            });
        }
        onSubmit = done;
        const f = dlg.querySelector('form');
        f.innerHTML = `<div class="pl-grip" aria-hidden="true"></div>
            <div class="pl-head"><h2>${esc(title)}</h2><button type="button" class="pl-x" aria-label="Schließen">${ic('x')}</button></div>
            <div class="pl-body">${body}</div>
            <div class="pl-foot">${extra}<span class="pl-sp"></span><button type="button" class="btn-action pl-cancel">Abbrechen</button><button type="submit" class="btn-action pl-save">${ic('check')}${esc(submit)}</button></div>`;
        f.querySelector('.pl-x').onclick = f.querySelector('.pl-cancel').onclick = () => dlg.close();
        dlg.showModal();
        if (onOpen) onOpen(f);
        const first = f.querySelector('.pl-body input:not([type=checkbox]):not([type=hidden]), .pl-body textarea, .pl-body select');
        if (first && matchMedia('(pointer: fine)').matches) first.focus();
        return f;
    }
    /* Aufräumen erst, wenn das Sheet wirklich zu ist: dlg.close() feuert „close“ verzögert. Öffnet ein Sheet direkt das nächste
       (z. B. „Hier einfügen“ → „Neuer Stopp“), käme das alte close-Ereignis sonst beim neuen Sheet an und entfernte dessen Karte. */
    function onSheetClose(fn) {
        const h = () => { if (dlg.open) return; dlg.removeEventListener('close', h); fn(); };
        dlg.addEventListener('close', h);
    }
    const field = (lab, input, cls = '') => `<label class="pl-field ${cls}"><span>${lab}</span>${input}</label>`;
    const inp = (name, v, attrs = '') => `<input name="${name}" value="${esc(v ?? '')}" ${attrs}>`;
    const area = (name, v, attrs = '') => `<textarea name="${name}" rows="3" ${attrs}>${esc(v ?? '')}</textarea>`;
    const sel = (name, v, opts) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(v ?? '') === String(k) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const val = (f, n) => (f.elements[n] && f.elements[n].value || '').trim();

    /* ---------- Stopps ---------- */
    const places = () => raw().places || {};
    /* Reihenfolge = Reihenfolge in den Daten (moveStop schreibt sie so); nummerierte Orte stehen untereinander nach Nummer,
       nicht nummerierte Orte behalten ihren Platz dazwischen */
    function stopList(P) {
        P = P || places();
        const all = Object.entries(P).map(([k, p], i) => ({ k, p, i }));
        /* alte Reisen ohne Nummern (Import): nach dem ersten Datum des Orts (Tagesplan bzw. Datumstext), nur Anzeige */
        const dt = byDate(P);
        if (dt) return all.sort((a, b) => (dt.get(a.k) ?? 1e12) - (dt.get(b.k) ?? 1e12) || a.i - b.i);
        const slots = all.filter(x => x.p && x.p.num != null);
        const sorted = slots.slice().sort((a, b) => (+a.p.num || 0) - (+b.p.num || 0) || a.i - b.i);
        let j = 0;
        return all.map(x => x.p && x.p.num != null ? sorted[j++] : x);
    }
    /* Datum eines Orts bei alten Reisen ohne Nummern und Nächte: frühester Tag aus den Tagesplan-Zeilen (focus + from/date)
       bzw. aus dem Datumstext des Orts („14.12. - 16.12.2025 / 2 Nächte“, „Sa, 18.07. 2026“, „04.09. (Etappe 1)“).
       Ohne Jahr gilt das Jahr des Reisebeginns. Liefert null, sobald ein Ort eine Nummer hat oder kein Datum erkennbar ist. */
    let DT = null;
    function dayOfText(t, y0, s0) {
        const m = String(t || '').match(/(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\.(\d{1,2})\.\s*(\d{4}|\d{2}(?!\d))?/);
        if (!m) return null;
        if (m[1]) return dn(`${m[1]}-${m[2]}-${m[3]}`);
        let y = m[6] ? (m[6].length === 2 ? 2000 + +m[6] : +m[6]) : y0;
        if (!y) return null;
        const iso = d => `${d}-${String(m[5]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
        if (!ISO.test(iso(y))) return null;
        let n = dn(iso(y));
        /* Datum ohne Jahr kurz nach dem Jahreswechsel (Reise über Silvester) */
        if (!m[6] && s0 != null && n < s0 - 30) n = dn(iso(y + 1));
        return n;
    }
    function byDate(P) {
        if (Object.values(P).some(p => p && (p.num != null || p.nights != null))) return null;
        const m = H ? H.meta() || {} : {}, s0 = ISO.test(m.start || '') ? dn(m.start) : null, y0 = s0 != null ? +m.start.slice(0, 4) : null;
        const sig = JSON.stringify([Object.keys(P), m.start, (H && H.plans ? H.plans() : []).length]);
        if (DT && DT.P === P && DT.sig === sig) return DT.map;
        const out = new Map(), put = (k, n) => { if (n != null && P[k] && !(out.get(k) <= n)) out.set(k, n); };
        /* gleicher Tag: Reihenfolge der Tagesplan-Zeilen; Orte nur mit Datumstext (z. B. Abflughafen) vor den Zeilen des Tages */
        let ri = 0;
        (H && H.plans ? H.plans() : []).forEach(pl => (pl.rows || []).forEach(r => {
            const n = ISO.test(r.from || '') ? dn(r.from) : dayOfText(r.date, y0, s0), i = ++ri;
            (Array.isArray(r.focus) ? r.focus : r.focus ? [r.focus] : []).forEach(k => put(k, n == null ? null : n * 1000 + Math.min(i, 998)));
        }));
        Object.entries(P).forEach(([k, p]) => { if (p && !out.has(k)) { const n = dayOfText(p.date, y0, s0); put(k, n == null ? null : n * 1000); } });
        const map = out.size >= 2 ? out : null;
        DT = { P, sig, map };
        return map;
    }
    /* Erneuter Besuch eines Orts: eigener Eintrag mit "same": "<Schlüssel des Orts>" (Name/Koordinaten werden mitgeführt),
       eigene Position, Nächte, Reisende und Unterkunft; er trägt die Nummer des ersten Besuchs */
    function labels(P) {
        P = P || places();
        const out = new Map();
        let n = 0;
        stopList(P).forEach(({ k, p }) => { if (p.num == null) return; if (p.same && P[p.same]) return; out.set(k, ++n); });
        stopList(P).forEach(({ k, p }) => { if (p.num != null && p.same && P[p.same]) out.set(k, out.get(p.same) ?? '↺'); });
        return out;
    }
    function km(a, b) {
        const R = 6371, r = x => x * Math.PI / 180;
        const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }
    const valid = p => p && isFinite(+p.lat) && isFinite(+p.lng);
    /* Route für Linie und Distanz: nummerierte Stopps; gibt es keine, alle Orte in Reihenfolge */
    function routeStops(P) {
        const l = stopList(P).filter(x => valid(x.p));
        const num = l.filter(x => x.p.num != null);
        return (num.length >= 2 ? num : l);
    }
    /* Linien auf der Karte aus den Etappen: je zwei aufeinanderfolgende Stopps eine geschätzte Strecke (ab 800 km Flug,
       sonst Straße); ist zwischen beiden ein Transport eingetragen, zeichnet ihn transportSegments */
    function routeSegments(P) {
        P = P || places();
        const l = routeStops(P).filter(x => !x.p.noRoute), out = [];
        /* eingetragene Transporte haben Vorrang: keine geschätzte Strecke, wenn von a ein Transport woandershin geht,
           in b einer von woanders ankommt, a eine Abreise oder b eine Anreise ist (z. B. eine Person fliegt heim, eine andere reist nach) */
        const lg = new Map(legs(P).list.map(g => [g.k, g])), FL = (raw().flights || []).filter(f => f && f.from && f.to);
        const base = x => x.p.same && P[x.p.same] ? Object.assign({}, P[x.p.same], { name: x.p.name || P[x.p.same].name }) : x.p;
        const near = (d, g) => !g || !g.from || !ISO.test(d || '') || (dn(d) >= dn(g.from) - 1 && dn(d) <= dn(g.to) + 1);
        /* ein Transport-Ende gehört nur zu den am besten passenden Orten (Flughafen-Code schlägt Stadtname) */
        const top = end => Math.max(0, ...l.map(x => endScore(end, base(x))));
        const at = (end, x) => { const sc = endScore(end, base(x)); return sc > 0 && sc >= top(end); };
        const leaving = (a, b) => FL.filter(f => at(f.from, a) && near(f.from.date, lg.get(a.k)) && !at(f.to, b));
        const arriving = (a, b) => FL.filter(f => at(f.to, b) && near(f.to.date || f.from.date, lg.get(b.k)) && !at(f.from, a));
        const dep = x => FL.some(f => at(f.from, x) && near(f.from.date, lg.get(x.k))), arr = x => FL.some(f => at(f.to, x) && near(f.to.date || f.from.date, lg.get(x.k)));
        const onlyDep = x => dep(x) && !arr(x), onlyArr = x => arr(x) && !dep(x);
        for (let i = 1; i < l.length; i++) {
            const a = l[i - 1], b = l[i];
            if (+a.p.lat === +b.p.lat && +a.p.lng === +b.p.lng) continue;
            if (a.p.kind === 'depart' || b.p.kind === 'arrive') continue;
            /* ein Transport geht von a woandershin bzw. kommt in b von woanders an: Strecke nur, wenn jemand anderes von a nach b weiterreist
               (z. B. eine Person fliegt heim, die anderen fahren weiter; eine Person reist nach, die anderen kommen über Land) */
            const other = [...leaving(a, b), ...arriving(a, b)];
            if (other.length) {
                const ab = whoAt(a.k).filter(x => whoAt(b.k).includes(x));
                if (!ab.filter(x => !other.some(f => flightWho(f).includes(x))).length) continue;
            }
            /* weite Strecke zu einem Ort, an dem nur abgeflogen wird (Startpunkt), oder von einem, an dem nur angekommen wird (Endpunkt) */
            if (km(a.p, b.p) >= 800 && (onlyArr(a) || onlyDep(b))) continue;
            /* ein eingetragener Transport zwischen a und b hat seine eigene Linie (transportSegments, ggf. zwischen den Flughäfen):
               keine zweite Linie zwischen den Orten selbst (z. B. Bangkok → Colombo neben BKK → CMB, wenn die Flughäfen nicht auf der Route sind) */
            const tb = transportBetween(a.p, b.p);
            if (tb && !tb.f.noMap) continue;
            const lm = legacyMode(a.k, b.k, P);
            out.push({ from: [+a.p.lat, +a.p.lng], to: [+b.p.lat, +b.p.lng], k: b.k, mode: lm === 'walk' || lm === 'ferry' || lm === 'flight' ? lm : km(a.p, b.p) >= 800 ? 'flight' : 'road' });
        }
        return out;
    }
    /* Linien aus eingetragenen Transporten: Start und Ziel über Flughafen-Code („Flughafen Wien (VIE)“) bzw. Ortsnamen */
    /* Reisende eines Stopps (Schlüssel) und eines Transports (who mit Namen oder Schlüsseln, leer = alle); ohne Reisende ein Platzhalter */
    function whoAt(k) {
        const ps = persons();
        if (!ps.length) return ['*'];
        if (H.placeWho) return H.placeWho(k) || [];
        const p = places()[k] || {};
        return Array.isArray(p.who) ? p.who : ps.map(pkey);
    }
    function flightWho(f) {
        const ps = persons();
        if (!ps.length) return ['*'];
        return !Array.isArray(f.who) || !f.who.length ? ps.map(pkey) : ps.filter(x => f.who.some(w => w === x.name || w === pkey(x))).map(pkey);
    }
    /* Linien aus eingetragenen Transporten: Start und Ziel über Flughafen-Code („Flughafen Wien (VIE)“) bzw. Ortsnamen.
       Passt ein Ende zu keinem Ort (z. B. Flug ab „GUA“, Etappe heißt „Antigua“), gilt der Stopp, an dem die Reisenden des Transports
       an diesem Tag sind: Abflug = Etappe, die am Abflugtag endet bzw. läuft, Ankunft = Etappe, die am Ankunftstag beginnt.
       Kommt ein Ende von außerhalb (Flug von zu Hause), gibt es keine Linie. */
    function transportSegments(P) {
        P = P || places();
        const cand = Object.entries(P).filter(([, p]) => valid(p) && !p.same);
        const best = end => { let b = null, bs = 0; cand.forEach(([k, p]) => { const sc = endScore(end, p); if (sc > bs) { bs = sc; b = p; } }); return b; };
        const L = legs(P).list.filter(g => g.from && valid(g.p));
        const geo = g => g.p.same && P[g.p.same] ? P[g.p.same] : g.p;
        const by = (f, ok, dist) => {
            const fw = flightWho(f);
            let b = null, bd = 1e9;
            L.forEach(g => { if (!ok(g) || !whoAt(g.k).some(x => fw.includes(x))) return; const d = dist(g); if (d < bd) { bd = d; b = geo(g); } });
            return b;
        };
        const dep = f => { const d = f.from.date; return ISO.test(d || '') ? by(f, g => g.from <= d && d <= g.to, g => dn(g.to) - dn(d)) : null; };
        const arr = f => {
            const d0 = f.from.date, d = ISO.test((f.to && f.to.date) || '') ? f.to.date : d0;
            return ISO.test(d0 || '') ? by(f, g => g.from >= d0 && dn(g.from) <= dn(d) + 1, g => Math.abs(dn(g.from) - dn(d))) : null;
        };
        return (raw().flights || []).filter(f => f && f.from && f.to && !f.noMap).map(f => {
            const ha = !best(f.from) && homeAirport(f.from), hb = !best(f.to) && homeAirport(f.to);
            const a = best(f.from) || ha || dep(f), b = best(f.to) || hb || arr(f);
            if (!a || !b || a === b || (+a.lat === +b.lat && +a.lng === +b.lng)) return null;
            const home = ha || hb;
            return { from: [+a.lat, +a.lng], to: [+b.lat, +b.lng], mode: home ? 'home' : f.mode || 'flight', home: home ? { lat: home.lat, lng: home.lng, name: home.name } : null };
        }).filter(Boolean);
    }
    /* Heimat-Flughäfen ohne eigene Etappe (Flug von/nach zu Hause): Linie bis dorthin, Karte zeigt sie mit (Weltansicht).
       Erkannt über den Code bzw. den Stadtnamen; „Europa“ ohne Code bleibt ohne Linie. */
    const AIRPORTS = {
        MUC: [48.354, 11.786, 'München'], VIE: [48.110, 16.570, 'Wien'], FRA: [50.038, 8.562, 'Frankfurt'], ZRH: [47.458, 8.555, 'Zürich'],
        NUE: [49.499, 11.078, 'Nürnberg'], STR: [48.690, 9.222, 'Stuttgart'], SZG: [47.793, 13.004, 'Salzburg'], BER: [52.366, 13.503, 'Berlin'],
        HAM: [53.630, 9.988, 'Hamburg'], DUS: [51.289, 6.767, 'Düsseldorf'], GVA: [46.238, 6.109, 'Genf'], INN: [47.260, 11.344, 'Innsbruck'],
        GRZ: [46.991, 15.440, 'Graz'], LNZ: [48.233, 14.188, 'Linz'], MAD: [40.472, -3.561, 'Madrid'], BCN: [41.297, 2.078, 'Barcelona'],
        LIS: [38.774, -9.134, 'Lissabon'], CDG: [49.010, 2.548, 'Paris'], AMS: [52.310, 4.768, 'Amsterdam'], LHR: [51.470, -0.454, 'London'],
        FCO: [41.800, 12.239, 'Rom'], IST: [41.262, 28.742, 'Istanbul'], CPH: [55.618, 12.656, 'Kopenhagen'], BRU: [50.901, 4.484, 'Brüssel']
    };
    function homeAirport(end) {
        if (!end) return null;
        const code = String(end.code || '').trim().toUpperCase();
        let hit = AIRPORTS[code] && [code, AIRPORTS[code]];
        if (!hit) { const t = [end.city, end.name].filter(Boolean).join(' ').toLowerCase(); hit = t && Object.entries(AIRPORTS).find(([, x]) => t.includes(x[2].toLowerCase())); }
        return hit ? { lat: hit[1][0], lng: hit[1][1], name: `${hit[1][2]} (${hit[0]})` } : null;
    }
    /* Punkte der Heimat-Flughäfen (für den Kartenausschnitt) */
    const homePoints = P => legs(P || places()).on ? transportSegments(P).filter(s => s.home).map(s => [s.home.lat, s.home.lng]) : [];
    const SEG_STYLE = { flight: { color: '#059669', weight: 2.5, opacity: .85, dashArray: '6, 6' }, ferry: { color: '#0d9488', weight: 3, opacity: .9, dashArray: '2, 7' },
        home: { color: '#059669', weight: 2, opacity: .6, dashArray: '3, 7' },
        train: { color: '#dc2626', weight: 3, opacity: .9, dashArray: '4, 4' }, road: { color: '#0d9488', weight: 3.5, opacity: .9 }, walk: { color: '#ca8a04', weight: 3.5, opacity: .9, dashArray: '6, 8' }, bus: { color: '#0d9488', weight: 3.5, opacity: .9 }, car: { color: '#0d9488', weight: 3.5, opacity: .9 } };
    /* zeichnet die Strecken der Etappen in eine Leaflet-Karte; true, wenn die Etappen die Linien bestimmen */
    function drawRoute(map, P) {
        if (!window.L || !map || !legs(P || places()).on) return false;
        /* zuerst die eingetragenen Transporte, dann die Strecken zwischen den Etappen (ohne doppelte Linien) */
        const seen = new Set(), key = s => [s.from.join(','), s.to.join(',')].sort().join('|');
        const homes = new Set();
        [...transportSegments(P), ...routeSegments(P)].forEach(s => {
            const q = key(s); if (seen.has(q)) return; seen.add(q);
            L.polyline([s.from, s.to], SEG_STYLE[s.mode] || SEG_STYLE.road).addTo(map);
            /* Heimat-Flughafen: kleiner Punkt mit Namen */
            if (s.home && !homes.has(s.home.name)) { homes.add(s.home.name); L.circleMarker([s.home.lat, s.home.lng], { radius: 4, color: '#059669', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }).bindTooltip(esc(s.home.name), { direction: 'top' }).addTo(map); }
        });
        return true;
    }
    function totalKm(P) {
        const l = routeStops(P);
        let s = 0;
        for (let i = 1; i < l.length; i++) s += km(l[i - 1].p, l[i].p);
        return Math.round(s);
    }
    const kmText = n => n.toLocaleString('de-DE') + ' km';

    /* ---------- Etappen: Nächte je Stopp ---------- */
    const pendingN = {};
    const nightsOf = (k, p) => k in pendingN ? pendingN[k]
        : p.nights === '' || p.nights == null || !isFinite(+p.nights) ? null : Math.max(0, Math.round(+p.nights));
    /* Etappen = nummerierte Stopps in Reihenfolge; aktiv, sobald einer davon Nächte hat */
    function legs(P, start) {
        P = P || places();
        if (start === undefined) start = H ? (H.meta() || {}).start : null;
        const l = stopList(P).filter(x => x.p.num != null);
        if (!l.some(x => nightsOf(x.k, x.p) != null)) return { on: false, list: [], total: 0 };
        const s = ISO.test(start || '') ? start : null;
        let off = 0;
        /* parallele An-/Abreise (places[k].parallel, z. B. eine Person reist eine Woche später nach): verbraucht keine Zeit der Reise.
           Anreise endet am Beginn der nächsten Etappe, Abreise beginnt am Ende der vorigen. */
        const list = l.map(({ k, p }) => {
            const n = nightsOf(k, p) ?? 0, par = !!(p.kind && p.parallel);
            const o = par && p.kind === 'arrive' ? { k, p, n, d0: off - n, d1: off, parallel: true } : { k, p, n, d0: off, d1: off + n, parallel: par };
            if (!par) off += n;
            if (s) { o.from = isoOf(dn(s) + o.d0); o.to = isoOf(dn(s) + o.d1); }
            return o;
        });
        return { on: true, list, total: off, start: s, end: s ? isoOf(dn(s) + off) : null };
    }
    const legText = g => g.from ? (g.n ? `${label(g.from)} – ${label(g.to)}` : `${label(g.from)} · Zwischenstopp`)
        : g.n ? `Tag ${g.d0 + 1} – ${g.d1 + 1}` : `Tag ${g.d0 + 1} · Zwischenstopp`;
    const nightsWord = n => n === 1 ? 'Nacht' : 'Nächte';
    /* Etappe braucht eine Unterkunft: Nächte > 0 und nicht als „Keine Unterkunft nötig“ markiert (places[k].noStay, z. B. Nachtflug) */
    const needsStay = g => g.n > 0 && !g.p.noStay && !g.p.kind;
    /* Art der Etappe: places[k].kind = 'arrive' (Anreise) | 'depart' (Abreise), z. B. lange Flüge mit Nächten; sonst Aufenthalt */
    const KINDS = [['', 'Aufenthalt'], ['arrive', 'Anreise'], ['depart', 'Abreise']];
    const kindLabel = k => (KINDS.find(x => x[0] === k) || ['', ''])[1];
    const parallelBox = p => `<label class="pl-check pl-parallel"><input type="checkbox" name="parallel"${p.parallel ? ' checked' : ''}><span>Parallel zu den anderen Etappen (z. B. eine Person reist später nach oder früher ab) – nur bei Anreise / Abreise</span></label>`;
    const readKind = (f, o) => { setOpt(o, 'kind', val(f, 'kind')); if (o.kind && f.elements.parallel && f.elements.parallel.checked) o.parallel = true; else delete o.parallel; };
    const legShort = g => g.from ? `${fmt(g.from)} – ${fmt(g.to)}` : `Tag ${g.d0 + 1} – ${g.d1 + 1}`;
    /* − / +: sofort anzeigen, gesammelt speichern (kurz nach dem letzten Klick) */
    let nTimer = 0;
    function stepNights(k, d) {
        const p = places()[k];
        if (!p || !editable()) return;
        const cur = nightsOf(k, p);
        pendingN[k] = Math.min(99, Math.max(0, (cur ?? (d > 0 ? 0 : 1)) + d));
        renderStops(document.getElementById('stopPanel'));
        clearTimeout(nTimer);
        nTimer = setTimeout(flushNights, 900);
    }
    async function flushNights() {
        if (!Object.keys(pendingN).length) return;
        if (busy) { nTimer = setTimeout(flushNights, 500); return; }
        const sync = legPlans();
        const keys = ['places', ...(sync.length ? [H.planKey] : [])];
        const vals = { ...pendingN };
        Object.keys(pendingN).forEach(k => delete pendingN[k]);
        await commit(keys, () => {
            Object.entries(vals).forEach(([k, n]) => { if (raw().places && raw().places[k]) raw().places[k].nights = n; });
            sync.forEach(p => syncPlan(p));
        });
    }

    /* „+“ zwischen den Etappen ein-/ausblenden (je Gerät gemerkt) */
    const INS_KEY = 'tb_stops_ins';
    const insOn = () => { try { return localStorage.getItem(INS_KEY) !== '0'; } catch (e) { return true; } };
    function toggleIns() {
        const on = !insOn();
        try { localStorage.setItem(INS_KEY, on ? '1' : '0'); } catch (e) {}
        document.querySelectorAll('.pl-ins-tg').forEach(b => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        document.body.classList.toggle('pl-noins', !on);
    }
    function renderStops(el, P) {
        document.body.classList.toggle('pl-noins', !insOn());
        if (!el) return;
        P = P || places();
        const l = stopList(P), rs = routeStops(P), edit = canEdit(), L = legs(P), m = H.meta() || {};
        const lg = new Map(L.list.map(g => [g.k, g]));
        /* Ziel: Nächte des Reisezeitraums (sofern fest), sonst nur die Summe */
        const goal = m.start && m.end && !(H.legEnd && H.legEnd()) ? dn(m.end) - dn(m.start) : 0;
        const ring = L.on ? `<div class="pl-nightsum${goal && L.total > goal ? ' over' : ''}">
                <span class="pl-ring" style="--pct:${goal ? Math.min(100, Math.round(L.total / goal * 100)) : 100}"><b>${L.total}${goal ? `<small>/${goal}</small>` : ''}</b></span>
                <span>${goal ? 'Nächte geplant' : `${nightsWord(L.total)} geplant`}${goal && L.total > goal ? `<small>${L.total - goal} mehr als der Reisezeitraum</small>` : goal && L.total < goal ? `<small>noch ${goal - L.total} offen</small>` : L.end ? `<small>Reiseende ${fmtY(L.end)}</small>` : ''}</span>
            </div>` : edit && l.some(x => x.p.num != null) ? `<p class="note pl-hint">${ic('calendar')}Tipp: Mit − / + bei jedem Stopp die Nächte planen – Daten, Unterkünfte und Tagesplan richten sich danach.</p>` : '';
        const stepper = (k, p) => {
            const n = nightsOf(k, p);
            if (!edit) return n == null ? '' : `<span class="pl-n-ro">${n ? `${n} ${nightsWord(n)}` : 'Zwischenstopp'}</span>`;
            return `<div class="pl-nights" role="group" aria-label="Nächte in ${esc(p.name || k)}">
                <button type="button" data-pl="n-dec" data-k="${esc(k)}" aria-label="Eine Nacht weniger"${n === 0 ? ' disabled' : ''}>${ic('minus')}</button>
                <span title="${n == null ? 'Nächte offen' : `${n} ${nightsWord(n)}`}"><b>${n == null ? '–' : n}</b><small>N.</small></span>
                <button type="button" data-pl="n-inc" data-k="${esc(k)}" aria-label="Eine Nacht mehr">${ic('plus')}</button>
            </div>`;
        };
        const next = new Map();
        for (let i = 1; i < rs.length; i++) next.set(rs[i - 1].k, { km: Math.round(km(rs[i - 1].p, rs[i].p)), to: rs[i].p, k: rs[i].k });
        el.hidden = !l.length && !edit;
        const total = totalKm(P);
        /* Reiseende: fester Zeitraum, sonst die Summe der Nächte */
        const end = m.end && !(H.legEnd && H.legEnd()) ? m.end : L.end;
        const drag = edit && l.length > 1 && !byDate(P);
        const dayLong = iso => ISO.test(iso || '') ? `${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]}. ${fmtY(iso)}` : '';
        /* Pille „Nächte geplant“ wie bei Polarsteps (oben rechts neben „Reise beginnt“) */
        const pct = goal ? Math.min(100, Math.round(L.total / goal * 100)) : 100;
        const pill = L.on ? `<span class="pl-npill${goal && L.total > goal ? ' over' : ''}" title="${goal && L.total > goal ? `${L.total - goal} mehr als der Reisezeitraum` : goal && L.total < goal ? `noch ${goal - L.total} offen` : ''}">
                <i class="pl-ring sm" style="--pct:${pct}"></i><span><b>${L.total}${goal ? `/${goal}` : ''}</b> Nächte geplant</span></span>` : '';
        /* Lücke zwischen zwei Stopps: „+“ zum Einfügen und das Verkehrsmittel */
        const ins = (at, k, nk) => edit ? `<button type="button" class="pl-ins" data-pl="gap-add" data-at="${at}" data-k="${esc(k || '')}" data-n="${esc(nk || '')}" aria-label="Hier einen Aufenthalt oder Transport einfügen">${ic('plus')}</button>` : '<span class="pl-ins-sp"></span>';
        /* Transporte (flights mit Datum) stehen als eigene Einträge im Zeitstrahl: nach dem letzten Aufenthalt, der vor ihrem Datum beginnt */
        const trAfter = new Map();
        if (L.on && L.start) flights().map((f, i) => ({ f, i })).filter(({ f }) => f && f.from && f.to && ISO.test(f.from.date || ''))
            .sort((a, b) => (a.f.from.date + (a.f.from.time || '')).localeCompare(b.f.from.date + (b.f.from.time || '')))
            .forEach(t => { const pos = trPos(t.f, l, lg); if (!trAfter.has(pos)) trAfter.set(pos, []); trAfter.get(pos).push(t); });
        const trLi = ({ f, i }) => {
            const [, lab, icon] = MODES.find(x => x[0] === (f.mode || 'flight')) || MODES[0];
            const route = [f.from.code || f.from.city, f.to.code || f.to.city].filter(Boolean).join(' → ');
            const toD = f.to.date && f.to.date !== f.from.date ? fmt(f.to.date) : '';
            const when = [fmt(f.from.date), f.from.time, toD || f.to.time ? `– ${[toD, f.to.time].filter(Boolean).join(' ')}` : ''].filter(Boolean).join(' ');
            const who = Array.isArray(f.who) && f.who.length ? f.who.join(', ') : '';
            return `<li class="pl-stop pl-tr"><span class="pl-dot" aria-hidden="true">${ic(icon)}</span>
                <button type="button" class="pl-stop-main" data-pl="tr-edit" data-i="${i}"${edit ? '' : ' disabled'}><b>${esc(lab)} · ${esc(route)}${ic('chevronRight')}</b><small>${esc([when, who, f.planned ? 'geplant' : 'gebucht'].filter(Boolean).join(' · '))}</small></button></li>`;
        };
        const trs = pos => (trAfter.get(pos) || []).map(trLi).join('');
        const gap = (at, k, nk) => {
            const x = k && next.get(k), tr = x && !trAfter.has(l.findIndex(y => y.k === k)) && transportBetween(P[k], x.to);
            /* ohne eingetragenen Transport: Verkehrsmittel aus den gespeicherten Strecken (alte Reisen, z. B. Wanderetappen) */
            const lm = x && !tr ? legacyMode(k, x.k, P) : null;
            const chip = x ? `<span class="pl-leg" title="${tr ? esc(tr.label) : lm ? `${MODE_TXT[lm]} · Luftlinie, Zeit grob geschätzt` : 'Luftlinie · Zeit grob geschätzt'}">${ic(tr ? tr.icon : lm ? MODE_IC[lm] : x.km >= 800 ? 'plane' : 'car')}${kmText(x.km)}<i>·</i>${esc(travelText(x.km, tr ? tr.mode : lm))}</span>` : '';
            /* eingetragener Transport: Status dezent daneben (gebucht / geplant) und ggf. Link zur Flugstatus-Seite */
            const f = tr && tr.f, st = f ? (f.planned ? ['warn', 'geplant'] : ['ok', 'gebucht']) : null, su = f && url(f.status);
            const badge = f ? `<span class="pl-tr-st ${st[0]}" title="${esc([f.airline, (f.flightNos || []).join(', '), f.booking && 'Buchung ' + f.booking].filter(Boolean).join(' · '))}">${ic(st[0] === 'ok' ? 'check' : 'clock')}${st[1]}</span>${su ? `<a class="pl-tr-link" href="${esc(su)}" target="_blank" rel="noopener" title="Flugstatus prüfen">Status ↗</a>` : ''}` : '';
            return `<li class="pl-tl-gap">${ins(at, k, nk)}${trAfter.has(l.findIndex(y => y.k === k)) && k ? '' : chip}${badge}</li>`;
        };
        const nums = l.filter(x => x.p.num != null), lab = labels(P);
        el.innerHTML = `<div class="mh"><h2>${ic('route')}Etappen<small class="pl-count">${l.length || ''}</small></h2>
                <span class="pl-head-acts">${edit ? `<button type="button" class="pl-ins-tg${insOn() ? ' on' : ''}" data-pl="ins-toggle" aria-pressed="${insOn()}" title="„+“ zwischen den Etappen ein- oder ausblenden">${ic('plus')}</button>` : ''}${H.role === 'admin' ? `<button type="button" data-pl="people" title="Reisende und ihre Farben">${ic('users')}${persons().length ? `<span class="pl-people">${persons().map(x => `<i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>`).join('')}</span>` : 'Reisende'}</button>` : ''}</span></div>
            ${!L.on && edit && nums.length && !(m.end && H.today && m.end < H.today) ? `<p class="note pl-hint">${ic('calendar')}Tipp: Mit − / + bei jedem Stopp die Nächte planen – Daten, Unterkünfte und Tagesplan richten sich danach.</p>` : ''}
            ${l.length ? `<ol class="pl-tl">
                <li class="pl-tl-row">${H.role === 'admin' && edit ? `<button type="button" class="pl-tl-start" data-pl="trip-dates" title="Reisebeginn ändern"><span class="pl-tl-ic home">${ic('home')}</span><div><b>Reise beginnt</b><small>${esc(dayLong(m.start) || 'Datum offen – antippen')}${ic('pencil')}</small></div></button>` : `<span class="pl-tl-ic home">${ic('home')}</span><div><b>Reise beginnt</b><small>${esc(dayLong(m.start) || 'Datum offen')}</small></div>`}${pill}</li>
                ${trs(-1)}${gap(0, null, l[0] && l[0].k)}
                ${l.map(({ k, p }, i) => {
                    const g = lg.get(k), when = g ? (g.from && g.n ? legShort(g) : legText(g)) : p.date || '';
                    const whenX = [p.kind ? kindLabel(p.kind) + (p.kind && p.parallel ? ' (parallel)' : '') : '', p.noStay && !p.kind && g && g.n ? `${when} · ohne Unterkunft` : when].filter(Boolean).join(' · ');
                    return `<li class="pl-stop" data-k="${esc(k)}" data-sort="stops">
                    <button type="button" class="pl-dot" data-pl="stop-focus" data-k="${esc(k)}" style="--c:${esc(H.placeColor ? H.placeColor(k) : color(p.color, 'var(--p1)'))}" aria-label="Auf der Karte zeigen: ${esc(p.name)}">${p.num != null ? esc(lab.get(k) ?? p.num) : ic('pin')}</button>
                    <button type="button" class="pl-stop-main" data-pl="stop-open" data-k="${esc(k)}">
                        <b>${esc(p.name || k)}${p.same ? `<span class="pl-again-tag">${ic('refresh')}<span class="pl-again-txt">erneut</span></span>` : ''}${ic('chevronRight')}</b>
                        ${whenX ? `<small>${esc(whenX)}</small>` : ''}
                    </button>
                    ${p.num != null ? stepper(k, p) : ''}
                    ${drag ? `<div class="pl-acts"><button type="button" class="pl-handle" data-drag="stops" data-k="${esc(k)}" aria-label="Verschieben: ${esc(p.name || k)} (Pfeiltasten oder ziehen)" title="Ziehen zum Verschieben">${ic('grip')}</button></div>` : ''}
                </li>${trs(i)}${gap(i + 1, k, l[i + 1] && l[i + 1].k)}`;
                }).join('')}
                ${end && L.on ? `<li class="pl-tl-row end"><span class="pl-tl-ic">${ic('flag')}</span><div><b>Reiseende</b><small>${esc(dayLong(end))}</small></div></li>` : ''}
            </ol>
            ${rs.length > 1 ? `<p class="note pl-total">${ic('route')}${kmText(total)} Luftlinie entlang der Route${drag ? ' · Reihenfolge per Ziehen am Griff' : ''}</p>` : ''}`
            : `<div class="pl-noroute">${ic('route')}<b>Plane deine Route</b><p>Lege die Orte der Reise in ihrer Reihenfolge an und gib an, wie viele Nächte ihr jeweils bleibt.</p>
                ${edit ? `<button type="button" class="btn-action" data-pl="stop-add">${ic('plus')}Ersten Stopp hinzufügen</button>` : ''}</div>`}
            ${edit ? `<div class="pl-fab-wrap"><div class="pl-fab-menu" hidden>
                    <button type="button" data-pl="stop-add">${ic('pin')}Reiseziel hinzufügen</button>
                    <button type="button" data-pl="fab-tr">${ic('plane')}Transport hinzufügen</button>
                    <button type="button" data-pl="fab-acc">${ic('bed')}Unterkunft hinzufügen</button>
                </div><button type="button" class="pl-fab" data-pl="fab" aria-label="Hinzufügen" aria-expanded="false">${ic('plus')}</button></div>` : ''}`;
        if (detailK && dlg && dlg.open) renderDetail();
    }
    /* Verkehrsmittel zwischen zwei Stopps: eingetragener Transport mit passenden Orten, sonst Schätzung */
    const MODE_IC = { flight: 'plane', train: 'train', ferry: 'ship', bus: 'bus', car: 'car', walk: 'walk' };
    const MODE_TXT = { flight: 'Flug', train: 'Zug', ferry: 'Fähre', bus: 'Bus', car: 'Auto', walk: 'Zu Fuß' };
    const placeWords = p => String(p && p.name || '').toLowerCase().split(/[\s,/·()&-]+/).filter(w => w.length > 2);
    const endHits = (end, p) => { const t = [end && end.city, end && end.name, end && end.code].filter(Boolean).join(' ').toLowerCase(); return !!t && placeWords(p).some(w => t.includes(w)); };
    /* Übereinstimmung Transport-Ende ↔ Ort: 3 = Flughafen-Code im Namen, 1 = Ortsname, 0 = keine */
    function endScore(end, p) {
        if (!end || !p) return 0;
        const code = String(end.code || '').trim().toLowerCase(), nm = String(p.name || '').toLowerCase();
        if (code.length >= 3 && (nm.includes('(' + code + ')') || placeWords(p).includes(code))) return 3;
        return endHits(end, p) ? 1 : 0;
    }
    /* Platz eines Transports im Zeitstrahl: nach dem Stopp, an dem er startet (Code/Name und Datum passen),
       sonst vor dem Stopp, an dem er ankommt, sonst nach dem letzten Aufenthalt, der vor seinem Datum beginnt */
    function trPos(f, l, lg) {
        const d = f.from.date, inR = g => !!(g && g.from && g.from <= d && d <= g.to);
        const pick = (end, cmpDay) => {
            let best = null;
            l.forEach(({ k, p }, j) => {
                const sc = endScore(end, p.same && places()[p.same] ? Object.assign({}, places()[p.same], { name: p.name || places()[p.same].name }) : p);
                if (!sc) return;
                const g = lg.get(k), dist = g && g.from ? (inR(g) ? 0 : Math.min(Math.abs(dn(g.from) - dn(cmpDay)), Math.abs(dn(g.to) - dn(cmpDay)))) : 50;
                const score = sc * 100 - dist * 10 + (inR(g) ? 50 : 0);
                if (dist <= 2 && (!best || score >= best.score)) best = { j, score };
            });
            return best;
        };
        const a = pick(f.from, d);
        if (a) return a.j;
        const b = ISO.test((f.to && f.to.date) || '') ? pick(f.to, f.to.date) : pick(f.to, d);
        if (b) return b.j - 1;
        let pos = -1;
        l.forEach(({ k }, j) => { const g = lg.get(k); if (g && g.from && g.from < d) pos = j; });
        return pos;
    }
    /* Verkehrsmittel aus den gespeicherten Strecken alter Reisen (routes: { via: [a, b] } oder { path } durch beide Orte),
       erkannt am Namen des Stils: „walk“ → zu Fuß, „ferry“ → Fähre, „flight…“ → Flug, „bus“, „train/transit“, „drive/car“ */
    const STYLE_MODE = [[/walk|hike|wander|trek|fuss|foot/i, 'walk'], [/ferry|faehre|boat|ship/i, 'ferry'], [/flight|flug|plane/i, 'flight'],
        [/bus/i, 'bus'], [/train|rail|zug|transit/i, 'train'], [/drive|car|auto|road/i, 'car']];
    function legacyMode(ka, kb, P) {
        P = P || places();
        const a = P[ka], b = P[kb], R = raw().routes;
        if (!Array.isArray(R) || !valid(a) || !valid(b)) return null;
        const near = (pt, p) => Array.isArray(pt) && km({ lat: +pt[0], lng: +pt[1] }, p) <= 2;
        const r = R.find(r => {
            if (!r || !r.style) return false;
            if (Array.isArray(r.via)) { const i = r.via.indexOf(ka), j = r.via.indexOf(kb); return i >= 0 && j >= 0 && Math.abs(i - j) === 1; }
            if (!Array.isArray(r.path)) return false;
            const i = r.path.findIndex(pt => near(pt, a)), j = r.path.findIndex(pt => near(pt, b));
            return i >= 0 && j >= 0 && i !== j;
        });
        const hit = r && STYLE_MODE.find(([re]) => re.test(r.style));
        /* kurzes Stück auf einer Flug-Strecke (z. B. Flughafen → Ort) ist kein Flug */
        if (hit && hit[1] === 'flight' && km(a, b) < 150) return null;
        return hit ? hit[1] : null;
    }
    function transportBetween(a, b) {
        const f = (raw().flights || []).find(f => f && f.from && f.to && endHits(f.from, a) && endHits(f.to, b));
        if (!f) return null;
        const mode = f.mode || 'flight';
        return { f, mode, icon: MODE_IC[mode] || 'plane', label: (MODES.find(x => x[0] === mode) || ['', 'Transport'])[1] + ' eingetragen' };
    }
    /* Zeit grob: Flug ≈ km/750 + 25 min, Fähre ≈ 30 km/h, zu Fuß ≈ 4 km/h (Luftlinie × 1,25), sonst Straße/Schiene (Luftlinie × 1,3 bei 60 km/h) */
    function travelText(k, mode) {
        if (!mode && k >= 800) mode = 'flight';
        const h = mode === 'flight' ? k / 750 + .4 : mode === 'ferry' ? k * 1.2 / 30 : mode === 'walk' ? k * 1.25 / 4 : k * 1.3 / 60;
        if (h < 1) return `ca. ${Math.max(10, Math.round(h * 6) * 10)} min`;
        const hh = Math.floor(h), mm = Math.round((h - hh) * 6) * 10;
        return `ca. ${hh} h${mm && hh < 10 ? ` ${mm === 60 ? '' : mm + ' min'}` : ''}`.trim();
    }
    /* ---------- Etappe öffnen: Zeitraum, Nächte, Notizen, Unterkünfte, Transporte ---------- */
    let detailK = null;
    function openStop(k) {
        const p = places()[k];
        if (!p) return;
        detailK = k;
        sheet({ title: p.name || k, body: '<div class="pl-detail"></div>', submit: 'Fertig', done: () => true });
        onSheetClose(() => { detailK = null; });
        renderDetail();
    }
    function renderDetail() {
        const k = detailK, p = places()[k], box = dlg && dlg.querySelector('.pl-detail');
        if (!p || !box) return;
        const edit = canEdit(), g = legs().list.find(x => x.k === k), n = nightsOf(k, p);
        const stays = [];
        groups().forEach(gr => gr.list.forEach((s, i) => { if (stayKey(s) === k) stays.push({ s, gr, i }); }));
        const bn = g ? Math.min(g.n, stays.filter(o => S.status(o.s) === 'booked').reduce((m, o) => m + (S.nights(o.s) || g.n), 0)) : 0;
        const g0 = groups()[0] || { id: '' };
        const trs = (raw().flights || []).map((f, i) => ({ f, i })).filter(({ f }) => f && f.from && f.to && (endHits(f.to, p) || endHits(f.from, p)));
        box.innerHTML = `
            <div class="pl-d-when">${ic('calendar')}<span>${g ? esc(legShort(g)) : esc(p.date || 'Kein Zeitraum')}</span>
                ${p.num != null && edit ? `<div class="pl-nights" role="group" aria-label="Nächte">
                    <button type="button" data-pl="n-dec" data-k="${esc(k)}" aria-label="Eine Nacht weniger"${n === 0 ? ' disabled' : ''}>${ic('minus')}</button>
                    <span><b>${n == null ? '–' : n}</b><small>${n == null ? 'Nächte' : nightsWord(n)}</small></span>
                    <button type="button" data-pl="n-inc" data-k="${esc(k)}" aria-label="Eine Nacht mehr">${ic('plus')}</button></div>` : n != null ? `<span class="pl-n-ro">${n} ${nightsWord(n)}</span>` : ''}</div>
            ${edit ? `<button type="button" class="pl-d-edit" data-pl="stop-edit" data-k="${esc(k)}">${ic('pencil')}<span><b>Etappe bearbeiten</b><small>Ort, Reisende, Notizen</small></span>${ic('chevronRight')}</button>` : ''}
            ${persons().length ? `<div class="pl-d-who">${persons().filter(x => !Array.isArray(p.who) || p.who.includes(pkey(x))).map(x => `<span><i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>${esc(x.name)}</span>`).join('') || '<span class="note">Niemand ausgewählt</span>'}</div>` : ''}
            ${p.desc ? `<h3 class="pl-d-h">Notizen</h3><div class="pl-d-note">${rich(p.desc)}</div>` : ''}
            <h3 class="pl-d-h">Unterkünfte${edit && !p.noStay ? `<button type="button" class="link-inline" data-pl="acc-leg" data-g="${esc(g0.id)}" data-k="${esc(k)}">${ic('plus')}Unterkunft</button>` : ''}</h3>
            ${edit && p.num != null ? `<label class="pl-check pl-nostay"><input type="checkbox" data-pl-nostay="${esc(k)}"${p.noStay ? ' checked' : ''}><span>Keine Unterkunft nötig (z. B. Flug, Nachtzug)</span></label>` : ''}
            ${p.noStay ? `<p class="note">Für diese Etappe ist keine Unterkunft nötig – sie erscheint nicht bei den Unterkünften.</p>` : ''}
            ${g && g.n && !p.noStay ? `<div class="bk-prog${bn >= g.n ? ' done' : ''}"><span>${bn} / ${g.n} Nächte gebucht</span><i style="--pct:${Math.round(bn / g.n * 100)}"></i></div>` : ''}
            ${p.noStay && !stays.length ? '' : (stays.map(({ s, gr, i }) => `<button type="button" class="pl-d-item" data-pl="acc-edit" data-g="${esc(gr.id)}" data-i="${i}"${edit ? '' : ' disabled'}>${ic('bed')}<span><b>${s.hotel ? esc(stripTags(s.hotel)) : esc(S.name(s))}</b><small>${esc([fmt(S.cin(s)) && `${fmt(S.cin(s))} – ${fmt(S.cout(s))}`, s.code].filter(Boolean).join(' · '))}</small></span><span class="pl-st ${STATUS[S.status(s)][1]}">${STATUS[S.status(s)][0]}</span></button>`).join('') || '<p class="note">Noch keine Unterkunft.</p>')}
            ${trs.length ? `<h3 class="pl-d-h">Transporte</h3>${trs.map(({ f, i }) => `<button type="button" class="pl-d-item" data-pl="tr-edit" data-i="${i}"${edit ? '' : ' disabled'}>${ic(MODE_IC[f.mode || 'flight'] || 'plane')}<span><b>${esc([f.from.code || f.from.city || f.from.name, f.to.code || f.to.city || f.to.name].filter(Boolean).join(' → '))}</b><small>${esc([f.from.date && fmt(f.from.date), f.from.time].filter(Boolean).join(' '))}</small></span></button>`).join('')}` : ''}
            <div class="pl-d-acts">
                <button type="button" class="btn-action" data-pl="stop-focus" data-k="${esc(k)}">${ic('map')}Auf der Karte</button>
                ${edit ? `<button type="button" class="btn-action" data-pl="stop-again" data-k="${esc(p.same || k)}">${ic('refresh')}Erneut besuchen</button>` : ''}
                ${window.TBActivities && TBActivities.ready ? `<button type="button" class="btn-action" data-pl="stop-acts" data-k="${esc(k)}">${ic('sparkles')}Aktivitäten</button>` : ''}
            </div>`;
    }
    /* Desktop (ab 1100 px): Karte rechts neben dem Etappen-Zeitstrahl, damit man beim Planen die Route sieht.
       Punkt antippen → Stopp in der Liste; „Auf der Karte“ in der Liste → Karte daneben, ohne den Bereich zu wechseln. */
    let SM = null;
    const wide = () => !!(window.matchMedia && matchMedia('(min-width: 1100px)').matches);
    function sideMap(P) {
        const pane = document.getElementById('stops');
        if (!pane || !window.L || !window.ResizeObserver) return;
        let box = pane.querySelector('.pl-sidemap');
        if (!box) {
            pane.insertAdjacentHTML('beforeend', `<div class="box pl-sidemap"><div class="pl-smap" aria-label="Karte der Etappen"></div></div>`);
            box = pane.querySelector('.pl-sidemap');
            pane.classList.add('pl-split');
        }
        const hdr = document.querySelector('.sticky-header');
        if (hdr) document.documentElement.style.setProperty('--hdr-h', hdr.offsetHeight + 'px');
        if (!SM) {
            const map = L.map(box.firstElementChild, { zoomControl: true, attributionControl: true });
            L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
            SM = { map, layer: L.layerGroup().addTo(map), fitted: false, pts: [], marks: {} };
            new ResizeObserver(() => { if (!box.offsetWidth) return; map.invalidateSize(); if (!SM.fitted) fitSide(); }).observe(box);
        }
        drawSide(P || places());
    }
    function fitSide() {
        if (!SM || !SM.pts.length || !SM.map.getContainer().offsetWidth) return;
        SM.map.fitBounds(L.latLngBounds(SM.pts), { padding: [36, 36], maxZoom: 9 });
        SM.fitted = true;
    }
    function drawSide(P) {
        SM.layer.clearLayers(); SM.pts = []; SM.marks = {};
        const lab = labels(P);
        stopList(P).forEach(({ k, p }) => {
            if (!valid(p) || (p.same && P[p.same])) return;
            const ll = [+p.lat, +p.lng], c = H.placeColor ? H.placeColor(k) : color(p.color, 'var(--p1)');
            const m = L.marker(ll, { icon: L.divIcon({ className: 'pl-smk', html: `<span style="--c:${esc(c)}">${p.num != null ? esc(lab.get(k) ?? p.num) : ''}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), title: p.name || k })
                .bindTooltip(esc(p.name || k), { direction: 'top', offset: [0, -12] })
                .on('click', () => flashStop(k)).addTo(SM.layer);
            SM.marks[k] = m; SM.pts.push(ll);
        });
        SM.pts.push(...homePoints(P));
        /* ohne Etappen-Nächte: die gespeicherten Strecken wie auf der Karte (alte Reisen), sonst eine Linie durch die Stopps */
        if (!drawRoute(SM.layer, P) && !(H.drawStored && H.drawStored(SM.layer))) {
            const l = routeStops(P).filter(x => !x.p.noRoute).map(x => [+x.p.lat, +x.p.lng]);
            if (l.length > 1) L.polyline(l, SEG_STYLE.road).addTo(SM.layer);
        }
        if (!SM.fitted) fitSide();
    }
    function flashStop(k) {
        const li = document.querySelector(`#stopPanel .pl-stop[data-k="${CSS.escape(k)}"]`);
        if (!li) return;
        li.scrollIntoView({ block: 'center', behavior: 'smooth' });
        li.classList.remove('pl-flash'); void li.offsetWidth; li.classList.add('pl-flash');
    }
    function sideFocus(k) {
        const pane = document.getElementById('stops');
        if (!SM || !wide() || !pane || !pane.classList.contains('on')) return false;
        const p = places()[k];
        if (!valid(p)) return false;
        SM.map.flyTo([+p.lat, +p.lng], Math.max(SM.map.getZoom() || 0, 9), { duration: .6 });
        const m = SM.marks[k];
        if (m) setTimeout(() => m.openTooltip(), 650);
        return true;
    }
    /* Stopp-Liste in den eigenen Bereich „Etappen“ (#stops) hängen – gibt es den nicht, neben die Karte (Split-View) –
       und die Distanz in den Karten-Kopf schreiben */
    function mountStops(P) {
        const box = document.getElementById('mapBox');
        if (!box) return;
        let panel = document.getElementById('stopPanel');
        const pane = document.getElementById('stops');
        if (pane) {
            if (!panel) { pane.insertAdjacentHTML('beforeend', '<aside id="stopPanel" class="box stop-panel" hidden></aside>'); panel = document.getElementById('stopPanel'); }
            if (panel.parentElement !== pane) { const old = panel.parentElement; pane.appendChild(panel); old.classList.remove('has-panel'); }
        } else if (!panel) {
            const wrap = document.createElement('div');
            wrap.className = 'map-split';
            box.before(wrap); wrap.appendChild(box);
            wrap.insertAdjacentHTML('beforeend', '<aside id="stopPanel" class="box stop-panel" hidden></aside>');
            panel = document.getElementById('stopPanel');
        }
        renderStops(panel, P);
        if (pane) sideMap(P);
        if (!pane && panel.parentElement) panel.parentElement.classList.toggle('has-panel', !panel.hidden);
        const n = routeStops(P).length;
        let el = document.getElementById('mapKm');
        const fs = document.getElementById('fs');
        if (!el && fs) { el = document.createElement('span'); el.id = 'mapKm'; el.className = 'map-km'; fs.before(el); }
        if (el) { el.innerHTML = n > 1 ? `${ic('route')}${kmText(totalKm(P))} · ${n} Stopps` : ''; el.hidden = n < 2; }
    }
    /* ---------- Reisende: Name + Farbe; färben Punkte auf Karte, Etappen und Route (wie die Südamerika-Reise) ---------- */
    const PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#64748b'];
    const persons = () => Array.isArray(raw().persons) ? raw().persons : [];
    /* Schlüssel einer Person: key (Vorlage) bzw. Name (Thailand, ältere Einträge) */
    const pkey = x => x.key || x.name;
    /* Reisezeitraum (nur Admins): Beginn (und optional ein festes Ende). Die Vorlage kann das Setzen übernehmen
       (Vielleicht-Reise mit gewähltem Startdatum → H.setStart), sonst steht es in meta.start / meta.end. */
    function editTripDates() {
        if (!editable() || H.role !== 'admin') return;
        const m = H.meta() || {}, L = legs();
        sheet({
            title: 'Reisezeitraum',
            body: `<div class="pl-row">
                    ${field('Reise beginnt', `<input type="date" name="start" value="${esc(ISO.test(m.start || '') ? m.start : '')}" required>`)}
                    ${field('Reiseende (optional)', `<input type="date" name="end" value="${esc(ISO.test((raw().meta || {}).end || '') ? raw().meta.end : '')}">`)}
                </div>
                <p class="note">${L.on ? `Die Etappen ergeben ${L.total} ${nightsWord(L.total)}. ` : ''}Ohne festes Ende ergibt die Summe der Nächte das Reiseende. Alle Daten der Etappen, Unterkünfte und des Ablaufs richten sich nach dem Beginn.</p>`,
            done: async f => {
                const start = val(f, 'start'), end = val(f, 'end');
                if (!ISO.test(start)) { alert('Bitte ein Startdatum wählen.'); return false; }
                if (end && end < start) { alert('Das Reiseende liegt vor dem Beginn.'); return false; }
                if (H.setStart && await H.setStart(start, end)) return true;
                commit(['meta'], () => {
                    const o = raw().meta = raw().meta || {}, old = o.start;
                    o.start = start;
                    if (end) o.end = end; else delete o.end;
                    /* Zeitraum-Text im Kopf mitziehen, falls vorhanden */
                    if (o.period && (old !== start || end)) o.period = end ? `${fmt(start)} – ${fmtY(end)}` : `ab ${fmtY(start)}`;
                });
            }
        });
    }
    async function editPeople() {
        if (!editable()) return;
        let list = persons().map(x => ({ key: pkey(x), name: x.name, color: x.color }));
        /* Vorschlag: man selbst + die Mitglieder der Reise */
        if (!list.length && H.suggestPeople) { try { list = (await H.suggestPeople()).map((n, i) => ({ key: '', name: n, color: PALETTE[i % PALETTE.length] })); } catch (e) {} }
        if (!list.length) list = [{ key: '', name: '', color: PALETTE[0] }];
        const rowHtml = (x, i) => `<div class="pl-person" data-key="${esc(x.key || '')}">
                <input type="color" name="pc" value="${esc(/^#[0-9a-f]{6}$/i.test(x.color || '') ? x.color : PALETTE[i % PALETTE.length])}" aria-label="Farbe">
                <input name="pn" value="${esc(x.name || '')}" maxlength="40" placeholder="Name" aria-label="Name">
                <button type="button" class="pl-person-x" aria-label="Entfernen">${ic('trash')}</button></div>`;
        sheet({
            title: 'Reisende & Farben',
            body: `<p class="note">Die Punkte auf Karte, Etappen und Route tragen immer die Farben der Reisenden, die dort sind (mehrere = geteilter Punkt). Wer wo ist, stellst du beim Stopp ein – ohne Angabe sind alle dabei.</p>
                <div class="pl-people-list">${list.map(rowHtml).join('')}</div>
                <button type="button" class="btn-action pl-person-add">${ic('plus')}Person</button>`,
            onOpen: f => {
                const box = f.querySelector('.pl-people-list');
                const wire = () => box.querySelectorAll('.pl-person-x').forEach(b => b.onclick = () => b.closest('.pl-person').remove());
                wire();
                f.querySelector('.pl-person-add').onclick = () => { box.insertAdjacentHTML('beforeend', rowHtml({}, box.children.length)); wire(); box.lastElementChild.querySelector('[name=pn]').focus(); };
            },
            done: f => {
                const used = new Set();
                const out = [...f.querySelectorAll('.pl-person')].map(r => ({ key: r.dataset.key, name: r.querySelector('[name=pn]').value.trim(), color: r.querySelector('[name=pc]').value }))
                    .filter(x => x.name).map(x => {
                        let key = x.key || x.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'p';
                        while (used.has(key)) key += '2';
                        used.add(key);
                        const old = persons().find(o => pkey(o) === key) || {};
                        return { ...old, key, name: x.name, color: x.color };
                    });
                const keys = new Set(out.map(x => x.key));
                commit(['persons', 'places'], () => {
                    if (out.length) raw().persons = out; else delete raw().persons;
                    /* entfernte Personen auch aus den Stopps nehmen */
                    Object.values(raw().places || {}).forEach(p => { if (Array.isArray(p.who)) { p.who = p.who.filter(k => keys.has(k)); if (!p.who.length || p.who.length === keys.size) delete p.who; } });
                });
            }
        });
    }
    /* Stopps ändern: Tagespläne, die den Etappen folgen, gleich mit anordnen */
    function commitPlaces(mutate, more = []) {
        const sync = legPlans();
        const keys = [...new Set(['places', ...(sync.length ? [H.planKey] : []), ...more])];
        return commit(keys, () => { mutate(); sync.forEach(p => syncPlan(p)); });
    }
    /* Ort umbenannt: Unterkünfte (Thailand: focus über den Namen) und Thailand-Tage (locName) zeigen danach auf den Schlüssel bzw. neuen Namen,
       damit die Zuordnung zur Etappe bleibt; mögliche Aktivitäten (über den Ortsnamen verknüpft) ziehen mit */
    function renameRefs(key, oldName, name) {
        allStations().forEach(st => {
            if (st.focus === oldName) st.focus = key;
            if (!st.place && !st.focus && S.name(st) === oldName) { if (TH()) st.focus = key; else st.place = key; }
        });
        if (TH()) plansOf().forEach(pl => pl.rows.forEach(r => { if (r.locName === oldName) r.locName = name; }));
    }
    function moveStop(k, j) {
        const l = stopList(), i = l.findIndex(x => x.k === k);
        if (i < 0 || j < 0 || j >= l.length || i === j || !editable()) return;
        commitPlaces(() => {
            const [x] = l.splice(i, 1); l.splice(j, 0, x);
            const out = {};
            let n = 0;
            l.forEach(x => { if (x.p.num != null) x.p.num = ++n; out[x.k] = x.p; });
            raw().places = out;
        });
    }
    /* Kleine Karte im Stopp-Sheet: Tippen setzt Breite/Länge (Marker ziehbar), ohne Namen wird er per Nominatim ergänzt */
    function pickMap(f, cur, k) {
        const box = f.querySelector('.pl-pick'), none = { set() {} };
        if (!box || !window.L) return none;
        const pts = Object.entries(places()).filter(([x, p]) => x !== k && valid(p) && !p.same).map(([, p]) => [+p.lat, +p.lng]);
        const map = L.map(box, { zoomControl: true, attributionControl: true });
        L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
        pts.forEach(q => L.circleMarker(q, { radius: 4, color: '#8e8e93', fillOpacity: .7, weight: 1 }).addTo(map));
        let mk = null;
        const set = (lat, lng, fly) => {
            if (!isFinite(lat) || !isFinite(lng)) return;
            if (mk) mk.setLatLng([lat, lng]);
            else { mk = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: 'pl-pick-pin', html: ic('pin'), iconSize: [30, 30], iconAnchor: [15, 28] }) }).addTo(map); mk.on('dragend', () => { const q = mk.getLatLng(); put(q.lat, q.lng); }); }
            if (fly) map.setView([lat, lng], Math.max(map.getZoom() || 0, 9));
        };
        const put = async (lat, lng) => {
            f.elements.lat.value = lat.toFixed(5); f.elements.lng.value = lng.toFixed(5);
            if (val(f, 'name')) return;
            try { const n = await reverseGeocode(lat, lng); if (n && !val(f, 'name')) f.elements.name.value = n; } catch (e) {}
        };
        map.on('click', e => { set(e.latlng.lat, e.latlng.lng); put(e.latlng.lat, e.latlng.lng); });
        const read = () => [parseFloat(val(f, 'lat').replace(',', '.')), parseFloat(val(f, 'lng').replace(',', '.'))];
        ['lat', 'lng'].forEach(n => f.elements[n].addEventListener('change', () => { const [a, b] = read(); set(a, b, true); }));
        /* erst nach dem Öffnen des Sheets messen, sonst rechnet Leaflet mit 0 px */
        setTimeout(() => {
            map.invalidateSize();
            const [a, b] = read();
            if (isFinite(a) && isFinite(b)) { set(a, b); map.setView([a, b], 9); }
            else if (pts.length > 1) map.fitBounds(pts, { padding: [20, 20], maxZoom: 9 });
            else if (pts.length) map.setView(pts[0], 7);
            else map.setView([30, 10], 2);
        }, 60);
        onSheetClose(() => map.remove());
        return { set };
    }
    async function reverseGeocode(lat, lng) {
        const wait = 1100 - (Date.now() - lastGeo);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastGeo = Date.now();
        const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=de&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`;
        const r = await TB.withTimeout(fetch(u, { headers: { Accept: 'application/json' } }), 8000);
        if (!r.ok) return '';
        const j = await r.json(), a = (j && j.address) || {};
        return a.city || a.town || a.village || a.municipality || a.county || (j && j.name) || (j && j.display_name ? String(j.display_name).split(',')[0] : '');
    }
    /* Etappe anzeigen in: Unterkünfte (noStay), Route (noRoute), mögliche Aktivitäten (noActs); angehakt = anzeigen */
    const SHOW_IN = [['noStay', 'Unterkünfte (aus = keine nötig, z. B. Flug, Nachtzug)'], ['noRoute', 'Route'], ['noActs', 'Mögliche Aktivitäten']];
    const showIn = (p, acts) => `<fieldset class="pl-who pl-showin"><legend>Anzeigen bei</legend>${SHOW_IN.filter(([k]) => acts || k !== 'noActs').map(([k, l]) => `<label class="pl-check"><input type="checkbox" name="${k}"${p[k] ? '' : ' checked'}><span>${l}</span></label>`).join('')}</fieldset>`;
    const readShowIn = (f, o) => SHOW_IN.forEach(([k]) => { const c = f.elements[k]; if (c) { if (c.checked) delete o[k]; else o[k] = true; } });
    function editStop(k, at) {
        if (!editable()) return;
        const p = k ? places()[k] : null;
        if (k && !p) return;
        const cur = p || { name: '', lat: '', lng: '', num: 1 };
        if (p && p.same) return editAgain(k);
        const again = !p ? stopList().filter(x => !x.p.same && valid(x.p)) : [];
        sheet({
            title: p ? 'Stopp bearbeiten' : 'Neuer Stopp',
            body: `${again.length ? `<details class="pl-again"><summary>${ic('refresh')}Einen Ort der Route erneut besuchen</summary><div>${again.map(x => `<button type="button" class="pl-again-btn" data-again="${esc(x.k)}"><i style="background:${esc(H.placeColor ? H.placeColor(x.k) : 'var(--p1)')}">${esc(labels().get(x.k) ?? '')}</i>${esc(x.p.name || x.k)}</button>`).join('')}</div></details>` : ''}
                <div class="pl-search">
                    ${field('Ort', inp('name', cur.name, 'required maxlength="120" autocomplete="off" placeholder="z. B. Kyoto"'), 'grow')}
                    <button type="button" class="btn-action pl-find">${ic('search')}Suchen</button>
                </div>
                <ul class="pl-results" hidden></ul>
                ${window.L ? `<div class="pl-pick-wrap"><div class="pl-pick" aria-label="Ort auf der Karte wählen"></div><span class="pl-pick-hint">${ic('pin')}Auf die Karte tippen, um den Ort zu setzen</span></div>` : ''}
                <div class="pl-row">
                    ${field('Breite (lat)', inp('lat', cur.lat, 'inputmode="decimal" required'))}
                    ${field('Länge (lng)', inp('lng', cur.lng, 'inputmode="decimal" required'))}
                </div>
                ${field('Zeitraum / Datum (Text)', inp('date', cur.date, 'maxlength="80" placeholder="z. B. 12.–15.04. oder Tag 3–5"'))}
                ${field('Beschreibung', area('desc', cur.desc, 'maxlength="2000"'))}
                ${persons().length ? `<fieldset class="pl-who"><legend>Wer ist dort?</legend>${persons().map(x => `<label class="pl-check"><input type="checkbox" name="who" value="${esc(pkey(x))}"${!Array.isArray(cur.who) || cur.who.includes(pkey(x)) ? ' checked' : ''}><span><i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>${esc(x.name)}</span></label>`).join('')}</fieldset>` : ''}
                ${cur.kind ? `${field('Art der Etappe (älter – neue Flüge, Züge usw. als Transport eintragen)', sel('kind', cur.kind || '', KINDS))}
                ${parallelBox(cur)}` : ''}
                <div class="pl-row">
                    <label class="pl-check"><input type="checkbox" name="numbered"${cur.num != null ? ' checked' : ''}><span>Nummerierter Stopp der Route</span></label>
                </div>
                ${showIn(cur, true)}
                <p class="note pl-src">Ortssuche: © OpenStreetMap-Mitwirkende (Nominatim)</p>`,
            extra: p ? `<button type="button" class="btn-action danger pl-del">${ic('trash')}Löschen</button>` : '',
            onOpen: f => {
                const find = f.querySelector('.pl-find'), res = f.querySelector('.pl-results');
                const run = async () => {
                    const q = val(f, 'name');
                    if (q.length < 2) return;
                    find.disabled = true; res.hidden = false; res.innerHTML = `<li class="note">${ic('search')}Suche …</li>`;
                    try { renderResults(await geocode(q)); }
                    catch (e) { res.innerHTML = `<li class="note">Suche gerade nicht möglich (${esc(TB.errorText(e))}).</li>`; }
                    finally { find.disabled = false; }
                };
                const renderResults = list => {
                    res.innerHTML = list.length ? list.map((r, i) => `<li><button type="button" data-i="${i}">${ic('pin')}<span><b>${esc(r.name)}</b><small>${esc(r.display_name)}</small></span></button></li>`).join('')
                        : '<li class="note">Nichts gefunden – anders schreiben oder Koordinaten von Hand eintragen.</li>';
                    res.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
                        const r = list[+b.dataset.i];
                        f.elements.lat.value = (+r.lat).toFixed(5); f.elements.lng.value = (+r.lon).toFixed(5);
                        if (!p || !val(f, 'name')) f.elements.name.value = r.name || r.display_name.split(',')[0];
                        res.hidden = true;
                        pick.set(+r.lat, +r.lon, true);
                    });
                };
                const pick = pickMap(f, cur, k);
                /* Anreise/Abreise: Unterkunft und Aktivitäten standardmäßig aus */
                if (f.elements.kind) f.elements.kind.onchange = () => { if (f.elements.kind.value) ['noStay', 'noActs'].forEach(n => { if (f.elements[n]) f.elements[n].checked = false; }); };
                find.onclick = run;
                f.querySelectorAll('[data-again]').forEach(b => b.onclick = () => { dlg.close(); addAgain(b.dataset.again, at); });
                f.elements.name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
                const del = f.querySelector('.pl-del');
                const visits = Object.keys(places()).filter(x => places()[x].same === k).length;
                if (del) del.onclick = () => { if (confirm(`„${p.name}“ löschen?${visits ? ` Auch ${visits === 1 ? 'der erneute Besuch wird' : `die ${visits} erneuten Besuche werden`} entfernt.` : ''}`)) { dlg.close(); commitPlaces(() => { const P = raw().places; delete P[k]; Object.keys(P).forEach(x => { if (P[x].same === k) delete P[x]; }); renumber(); }); } };
            },
            done: f => {
                const name = val(f, 'name'), lat = parseFloat(val(f, 'lat').replace(',', '.')), lng = parseFloat(val(f, 'lng').replace(',', '.'));
                if (!name) { alert('Bitte einen Ortsnamen eingeben.'); return false; }
                if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { alert('Bitte gültige Koordinaten eintragen (oder über „Suchen“ übernehmen).'); return false; }
                const oldName = k && raw().places && raw().places[k] ? raw().places[k].name || '' : '';
                const renamed = !!oldName && oldName !== name && !(raw().places[k].same);
                commitPlaces(() => {
                    const P = raw().places = raw().places || {};
                    const key = k || uniqueKey(name, P);
                    if (renamed) renameRefs(key, oldName, name);
                    const o = P[key] || {};
                    const numbered = f.elements.numbered.checked;
                    Object.assign(o, { name, lat: +lat.toFixed(5), lng: +lng.toFixed(5) });
                    /* Reisende: alle angehakt = kein eigener Eintrag (folgt der Reise) */
                    const who = [...f.querySelectorAll('input[name="who"]')];
                    if (who.length) { const on = who.filter(x => x.checked).map(x => x.value); if (on.length === who.length) delete o.who; else o.who = on; }
                    setOpt(o, 'date', val(f, 'date')); setOpt(o, 'desc', val(f, 'desc'));
                    readShowIn(f, o); readKind(f, o);
                    if (!numbered) delete o.num;
                    /* „+“ zwischen zwei Stopps: an dieser Stelle einfügen, sonst ans Ende */
                    else if (o.num == null) o.num = at != null && isFinite(at) ? at + .5 : Object.values(P).reduce((m, x) => x.num != null && x !== o ? Math.max(m, +x.num || 0) : m, 0) + 1;
                    /* neuer Stopp, während die Etappen schon Nächte haben: mit 1 Nacht starten */
                    if (!k && numbered && legs().on && o.nights == null) o.nights = 1;
                    P[key] = o;
                    /* erneute Besuche führen Name und Koordinaten des Orts mit */
                    Object.values(P).forEach(x => { if (x.same === key) Object.assign(x, { name: o.name, lat: o.lat, lng: o.lng }); });
                    renumber();
                }, renamed ? ['stations', ...(TH() ? [H.planKey] : [])] : []).then(ok => { if (ok && renamed && window.TBActivities && TBActivities.renameLocation) TBActivities.renameLocation(oldName, name); });
            }
        });
    }
    /* Ort erneut besuchen: neuer Eintrag an Position „at“ (sonst ans Ende) */
    function addAgain(src, at) {
        const P = places(), o = P[src];
        if (!o || !editable()) return;
        commitPlaces(() => {
            const Q = raw().places, key = uniqueKey(o.name + ' 2', Q);
            const end = Object.values(Q).reduce((m, x) => x.num != null ? Math.max(m, +x.num || 0) : m, 0) + 1;
            Q[key] = { same: src, name: o.name, lat: o.lat, lng: o.lng, num: at != null && isFinite(at) ? at + .5 : end };
            if (legs().on) Q[key].nights = 1;
            renumber();
        });
    }
    /* erneuten Besuch bearbeiten: nur Reisende, Notizen, Löschen (Ort selbst über den ersten Besuch) */
    function editAgain(k) {
        const p = places()[k], src = places()[p.same] || {};
        sheet({
            title: `Erneuter Besuch: ${p.name || src.name || ''}`,
            body: `<p class="note">Name und Lage kommen vom ersten Besuch (Nr. ${esc(labels().get(p.same) ?? '')}). Hier gelten eigene Nächte, Unterkunft und Notizen.</p>
                ${field('Notizen', area('desc', p.desc, 'maxlength="2000"'))}
                ${persons().length ? `<fieldset class="pl-who"><legend>Wer ist dort?</legend>${persons().map(x => `<label class="pl-check"><input type="checkbox" name="who" value="${esc(pkey(x))}"${!Array.isArray(p.who) || p.who.includes(pkey(x)) ? ' checked' : ''}><span><i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>${esc(x.name)}</span></label>`).join('')}</fieldset>` : ''}
                ${p.kind ? `${field('Art der Etappe', sel('kind', p.kind || '', KINDS))}${parallelBox(p)}` : ''}
                ${showIn(p, false)}`,
            extra: `<button type="button" class="btn-action danger pl-del">${ic('trash')}Löschen</button>`,
            onOpen: f => { f.querySelector('.pl-del').onclick = () => { if (confirm('Diesen erneuten Besuch löschen?')) { dlg.close(); commitPlaces(() => { delete raw().places[k]; renumber(); }); } }; },
            done: f => {
                commitPlaces(() => {
                    const o = raw().places[k];
                    setOpt(o, 'desc', val(f, 'desc')); readShowIn(f, o); readKind(f, o);
                    const who = [...f.querySelectorAll('input[name="who"]')];
                    if (who.length) { const on = who.filter(x => x.checked).map(x => x.value); if (on.length === who.length) delete o.who; else o.who = on; }
                });
            }
        });
    }
    const setOpt = (o, k, v) => { if (v) o[k] = v; else delete o[k]; };
    function renumber() { let n = 0; stopList().forEach(x => { if (x.p.num != null) x.p.num = ++n; }); }
    function uniqueKey(name, P) {
        const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ort';
        let k = base, i = 2;
        while (P[k]) k = base + '-' + i++;
        return k;
    }
    /* Ortssuche über Nominatim (OpenStreetMap): nur auf Knopfdruck, max. 1 Anfrage pro Sekunde */
    let lastGeo = 0;
    async function geocode(q) {
        const wait = 1100 - (Date.now() - lastGeo);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastGeo = Date.now();
        const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=de&q=' + encodeURIComponent(q);
        const r = await TB.withTimeout(fetch(u, { headers: { Accept: 'application/json' } }), 10000);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return (await r.json()).filter(x => x && x.lat && x.lon);
    }

    /* ---------- Ablauf (Tagesplan) ---------- */
    const plansOf = () => H.plans() || [];
    const planById = id => plansOf().find(p => p.id === id);
    const TH = () => H.rowFormat === 'thailand';
    /* Felder einer Zeile unabhängig vom Format lesen/schreiben */
    const R = {
        from: r => r.from || r.rawDate || '',
        title: r => r.title || '',
        focus: r => TH() ? [placeKeyByName(r.locName)].filter(Boolean) : (r.focus || [])
    };
    function placeKeyByName(name) { const e = Object.entries(places()).find(([, p]) => p.name === name); return e ? e[0] : (places()[name] ? name : null); }
    function ensureIds(rows) { rows.forEach(r => { if (!r._id) r._id = uid(); }); }

    /* Werkzeugleiste über einem Ablauf: + Tag, leere Tage erzeugen */
    function planToolbar(planId) {
        if (!canEdit()) return '';
        const p = planById(planId), m = H.meta() || {};
        const L = legs(), byLegs = !TH() && L.on && L.start;
        const gen = p && !p.rows.length && m.start && m.end && !(L.on && L.start);
        return `<div class="pl-toolbar">
            <button type="button" class="btn-action" data-pl="row-add" data-plan="${esc(planId)}">${ic('plus')}Tag hinzufügen</button>
            ${byLegs && p && !p.legs ? `<button type="button" class="btn-action ok" data-pl="days-legs" data-plan="${esc(planId)}">${ic('wand')}Tage aus den Etappen anlegen (${L.total + 1} Tage)</button>` : ''}
            ${byLegs && p && p.legs ? `<span class="note pl-legs-on">${ic('route')}Folgt den Etappen – Nächte bei den Stopps ändern</span>` : ''}
            ${gen ? `<button type="button" class="btn-action ok" data-pl="days-gen" data-plan="${esc(planId)}">${ic('wand')}${dn(m.end) - dn(m.start) + 1} leere Tage anlegen (${fmt(m.start)}–${fmt(m.end)})</button>` : ''}
            ${p && !p.rows.length && !gen && !(L.on && L.start) ? `<span class="note">Noch keine Tage. Tipp: Mit Start- und Enddatum der Reise lassen sich alle Tage auf einmal anlegen.</span>` : ''}
        </div>`;
    }
    /* Bearbeiten-Knopf für eine Zeile (Tabelle und Karte) */
    const rowEditBtn = (planId, i) => canEdit() ? `<button type="button" class="row-edit" data-pl="row-edit" data-plan="${esc(planId)}" data-i="${i}" aria-label="Tag bearbeiten" title="Bearbeiten">${ic('pencil')}</button>` : '';

    /* Tagesplan nach Etappen: ein Tag je Datum mit den Orten des Tages (Ankunft, Aufenthalt, Abreise).
       Inhalte vorhandener Tage bleiben; leere Tage außerhalb der Reise fallen weg. Nur Vorlage (Thailand hat eigene Tage je Land). */
    const legPlans = () => TH() ? [] : plansOf().filter(p => p.legs);
    function syncPlan(p) {
        const L = legs();
        if (!L.on || !L.start) return;
        ensureIds(p.rows);
        const byDate = new Map(p.rows.filter(r => ISO.test(r.from || '')).map(r => [r.from, r]));
        const used = new Set(), out = [];
        for (let d = 0; d <= L.total; d++) {
            const iso = isoOf(dn(L.start) + d);
            const here = L.list.filter(g => g.d0 <= d && d <= g.d1 && (g.n || g.d0 === d));
            const auto = here.map(g => g.p.name || g.k).filter((x, i, a) => a.indexOf(x) === i).join(' → ');
            let r = byDate.get(iso);
            if (r) used.add(r); else r = { _id: uid(), title: '' };
            r.from = iso; delete r.to;
            if (!r.date || /^\d{2}\.\d{2}\. \(\w\w\)$/.test(r.date) || /^Tag \d+$/.test(r.date)) r.date = label(iso);
            if (!r.day || /^Tag \d+$/.test(r.day)) r.day = `Tag ${d + 1}`;
            if (!r.title || r.auto) { r.title = auto; r.auto = true; }
            if (here.length) r.focus = [...new Set(here.map(g => g.k))]; else delete r.focus;
            out.push(r);
        }
        const keep = p.rows.filter(r => !used.has(r) && !out.includes(r) && (!r.auto && r.title || r.details || (r.extra || []).length));
        p.rows.splice(0, p.rows.length, ...out, ...keep);
    }
    function planFromLegs(planId) {
        const p = planById(planId), L = legs();
        if (!p || !L.on || !editable()) return;
        if (!L.start) return alert('Die Reise hat noch kein Startdatum. Ohne Datum lassen sich die Tage nicht anlegen.');
        commit([H.planKey], () => { p.legs = true; syncPlan(p); });
    }

    function generateDays(planId) {
        const p = planById(planId), m = H.meta() || {};
        if (!p || !m.start || !m.end || !editable()) return;
        const n = dn(m.end) - dn(m.start) + 1;
        if (n > 400) return alert('Der Zeitraum ist zu lang.');
        commit([H.planKey], () => {
            for (let i = 0; i < n; i++) {
                const iso = isoOf(dn(m.start) + i);
                p.rows.push(TH() ? { _id: uid(), day: `Tag ${i + 1}`, date: label(iso), rawDate: iso, title: '', details: '', transport: '', hotel: '' }
                    : { _id: uid(), day: `Tag ${i + 1}`, from: iso, date: label(iso), title: '' });
            }
        });
    }
    function editRow(planId, idx, preset) {
        if (!editable()) return;
        let p = planById(planId);
        if (!p && H.newPlan) p = H.newPlan();
        if (!p) return;
        const isNew = idx == null || idx < 0 || idx >= p.rows.length;
        const r = isNew ? (preset ? presetRow(preset) : {}) : p.rows[idx];
        const pl = stopList();
        const foc = new Set(R.focus(r));
        const n = p.rows.length;
        /* Etappe des Tags: gespeicherter Ort, sonst die Etappe am Datum */
        const LL = legs(), atDate = iso => (LL.list.find(g => g.from && g.from <= iso && (g.n ? iso < g.to : iso === g.from)) || {}).k;
        const LB = labels();
        const curK = [...foc].pop() || (ISO.test(R.from(r) || '') ? atDate(R.from(r)) : '') || '';
        const stopOpts = pl.filter(x => x.p.num != null || foc.has(x.k));
        sheet({
            title: isNew ? 'Neuer Tag' : `${r.day || 'Tag'} bearbeiten`,
            body: `${stopOpts.length ? field('Etappe / Ort auf der Karte', `<select name="stop"><option value="">– kein Ort –</option>${stopOpts.map(({ k, p: x }) => { const g = LL.list.find(y => y.k === k); return `<option value="${esc(k)}"${k === curK ? ' selected' : ''}>${esc(LB.get(k) ?? x.num ?? '')}${x.num != null ? ' · ' : ''}${esc(x.name || k)}${g && g.from ? ` · ${esc(legShort(g))}` : ''}</option>`; }).join('')}</select>`) : ''}
                <div class="pl-row">
                    ${field('Datum', `<input type="date" name="from" value="${esc(R.from(r))}">`)}
                    ${TH() ? '' : field('bis (optional)', `<input type="date" name="to" value="${esc(r.to || '')}">`)}
                    ${field('Tag', inp('day', isNew ? r.day || `Tag ${n + 1}` : r.day, 'maxlength="40" class="pl-short"'))}
                </div>
                ${field('Ort & Aktivität', inp('title', R.title(r), 'maxlength="200" placeholder="z. B. Ankunft in Kyoto, Abendspaziergang Gion"'))}
                ${window.TBActivities && TBActivities.forLocation ? field('Mögliche Aktivität übernehmen', '<select name="act"><option value="">– auswählen –</option></select>') : ''}
                ${field('Details & Programm', area('details', r.details, 'rows="4" maxlength="5000"'))}
                <div class="pl-row">
                    ${field('Transport', inp('transport', r.transport, 'maxlength="300" placeholder="z. B. Shinkansen 2:15 h"'))}
                    ${field('Unterkunft', inp('hotel', r.hotel, 'maxlength="300" placeholder="Name oder „Noch offen“"'))}
                </div>
                <p class="note">Einfache Formatierung in den Details: Zeilenumbrüche bleiben erhalten.</p>`,
            extra: isNew ? '' : `<button type="button" class="btn-action danger pl-del">${ic('trash')}Löschen</button>
                <button type="button" class="btn-action pl-up" aria-label="Nach oben"${idx === 0 ? ' disabled' : ''}>${ic('arrowUp')}</button>
                <button type="button" class="btn-action pl-down" aria-label="Nach unten"${idx === n - 1 ? ' disabled' : ''}>${ic('arrowDown')}</button>`,
            onOpen: f => {
                /* Etappe wählen: Datum in den Zeitraum der Etappe, Tag-Nummer und mögliche Aktivitäten des Orts */
                const fillActs = () => {
                    const a = f.elements.act, k = f.elements.stop ? f.elements.stop.value : '', P0 = places()[k];
                    if (!a) return;
                    const nm = P0 ? (P0.same && places()[P0.same] ? places()[P0.same].name : P0.name) : '';
                    const list = nm ? (TBActivities.forLocation(nm) || []).filter(x => !x.done) : [];
                    a.innerHTML = `<option value="">${list.length ? '– auswählen –' : nm ? 'Keine Ideen für diesen Ort' : 'Erst eine Etappe wählen'}</option>` + list.map(x => `<option value="${esc(x.title)}">${esc(x.title)}${x.duration ? ` (${esc(x.duration)})` : ''}</option>`).join('');
                    a.disabled = !list.length;
                };
                const setDay = () => { const d = val(f, 'from'), L0 = legs(); if (ISO.test(d) && L0.start && !val(f, 'day').replace(/^Tag \d+$/, '')) f.elements.day.value = `Tag ${dn(d) - dn(L0.start) + 1}`; };
                if (f.elements.stop) f.elements.stop.onchange = () => {
                    const g = legs().list.find(y => y.k === f.elements.stop.value), d = val(f, 'from');
                    if (g && g.from && !(d >= g.from && (g.n ? d < g.to : d === g.from))) { f.elements.from.value = g.from; setDay(); }
                    fillActs();
                };
                f.elements.from.addEventListener('change', setDay);
                if (f.elements.act) f.elements.act.onchange = () => {
                    const t = f.elements.act.value;
                    if (!t) return;
                    if (!val(f, 'title')) f.elements.title.value = t;
                    else { const d = f.elements.details; d.value = [d.value.trim(), '• ' + t].filter(Boolean).join('\n'); }
                    f.elements.act.value = '';
                };
                fillActs();
                const del = f.querySelector('.pl-del');
                if (del) del.onclick = () => { if (confirm(`„${r.day || 'Tag'}“ löschen?`)) { dlg.close(); commit([H.planKey], () => p.rows.splice(idx, 1)); } };
                const mv = d => () => { dlg.close(); commit([H.planKey], () => { const [x] = p.rows.splice(idx, 1); p.rows.splice(idx + d, 0, x); }); };
                if (f.querySelector('.pl-up')) { f.querySelector('.pl-up').onclick = mv(-1); f.querySelector('.pl-down').onclick = mv(1); }
            },
            done: f => {
                const from = val(f, 'from'), to = f.elements.to ? val(f, 'to') : '';
                if (to && from && to < from) { alert('„bis“ liegt vor dem Datum.'); return false; }
                /* Ort: Auswahl der Etappe; in der Vorlage bleiben weitere gespeicherte Orte erhalten, wenn die Auswahl gleich bleibt */
                const sk = f.elements.stop ? val(f, 'stop') : '';
                const focus = !f.elements.stop ? [...foc] : !sk ? [] : sk === curK && foc.has(sk) ? [...foc] : [sk];
                /* Thailand: neuer Tag landet im Teil (Thailand / Sri Lanka), zu dem das Datum gehört */
                if (isNew && from && H.planFor) { const q = planById(H.planFor(from)); if (q) p = q; }
                commit([H.planKey], () => {
                    const o = isNew ? { _id: uid(), ...(preset ? r : {}) } : r;
                    o.day = val(f, 'day');
                    if (o.title !== val(f, 'title')) delete o.auto;
                    o.title = val(f, 'title');
                    setOpt(o, 'details', val(f, 'details')); setOpt(o, 'transport', val(f, 'transport')); setOpt(o, 'hotel', val(f, 'hotel'));
                    if (TH()) {
                        if (from) { o.rawDate = from; o.date = label(from); } else delete o.rawDate;
                        if (focus[0]) o.locName = (places()[focus[0]] || {}).name || focus[0];
                        ['details', 'transport', 'hotel'].forEach(k => { if (o[k] == null) o[k] = ''; });
                    } else {
                        const oldAuto = !o.date || o.date === label(o.from) || /^\d{2}\.\d{2}\. \(\w\w\)( – .*)?$/.test(o.date);
                        setOpt(o, 'from', from); setOpt(o, 'to', to && to !== from ? to : '');
                        if (from && oldAuto) o.date = label(from) + (o.to ? ' – ' + label(o.to) : '');
                        if (!from && oldAuto) delete o.date;
                        if (focus.length) o.focus = focus; else delete o.focus;
                    }
                    if (isNew) { const d0 = R.from(o), at = ISO.test(d0) ? p.rows.findIndex(x => ISO.test(R.from(x)) && R.from(x) > d0) : -1; p.rows.splice(at < 0 ? p.rows.length : at, 0, o); }
                });
            }
        });
    }
    /* ---------- Ablauf aus den Etappen: jeder Reisetag mit seinen Orten (Ankunft, Aufenthalt, Abreise) ---------- */
    function legDays() {
        const L = legs();
        if (!L.on || !L.start) return [];
        const out = [];
        for (let d = 0; d <= L.total; d++) {
            const here = L.list.filter(g => g.d0 <= d && d <= g.d1 && (g.n || g.d0 === d));
            out.push({ iso: isoOf(dn(L.start) + d), day: d + 1, keys: [...new Set(here.map(g => g.k))] });
        }
        return out;
    }
    const placeNames = keys => keys.map(k => (places()[k] || {}).name || k).filter((x, i, a) => a.indexOf(x) === i).join(' → ');
    /* neuer Tag aus einem Etappen-Tag (Datum, Orte, Titel) */
    function presetRow(v) {
        const keys = v.keys || [], name = placeNames(keys);
        return TH() ? { day: `Tag ${v.day}`, rawDate: v.iso, date: label(v.iso), title: name, locName: keys.length ? (places()[keys[keys.length - 1]] || {}).name : '' }
            : { day: `Tag ${v.day}`, from: v.iso, title: name, focus: keys };
    }
    /* Ablauf als eine Liste: gespeicherte Tage aller Abläufe nach Datum, dazwischen Etappen-Tage ohne Eintrag (virtual).
       planFor(iso) wählt den Ablauf für neue Tage (Thailand: Thailand / Sri Lanka) */
    function ablauf(planIds) {
        const ps = plansOf().filter(p => !planIds || planIds.includes(p.id));
        const items = [];
        ps.forEach(p => p.rows.forEach((r, i) => items.push({ r, plan: p.id, i, iso: R.from(r) })));
        const seen = new Set();
        items.forEach(x => { if (!ISO.test(x.iso || '')) return; seen.add(x.iso); const to = x.r.to; if (ISO.test(to || '') && to > x.iso) for (let d = dn(x.iso); d <= dn(to) && d - dn(x.iso) < 400; d++) seen.add(isoOf(d)); });
        legDays().forEach(v => { if (!seen.has(v.iso)) items.push({ virtual: true, iso: v.iso, v, plan: planFor(v.iso, ps), name: placeNames(v.keys) }); });
        /* nach Datum; Tage ohne Datum behalten ihre Stelle hinter dem Vorgänger */
        let last = '';
        items.forEach((x, n) => { x._k = (x.iso || last) + '|' + String(n).padStart(5, '0'); if (x.iso) last = x.iso; });
        return items.sort((a, b) => a._k < b._k ? -1 : a._k > b._k ? 1 : 0);
    }
    function planFor(iso, ps) {
        ps = ps || plansOf();
        if (H.planFor) { const id = H.planFor(iso); if (id) return id; }
        /* der Ablauf, dessen Zeitraum das Datum enthält, sonst der letzte, der davor beginnt, sonst der erste */
        const rng = ps.map(p => { const ds = p.rows.map(R.from).filter(x => ISO.test(x)).sort(); return { id: p.id, a: ds[0], b: ds[ds.length - 1] }; });
        const hit = rng.find(x => x.a && x.a <= iso && iso <= x.b) || rng.filter(x => x.a && x.a <= iso).pop() || rng[0];
        return hit ? hit.id : (ps[0] || {}).id || '';
    }
    /* Reisezeitraum je Person aus den Etappen: erster bis letzter Stopp, bei dem sie dabei ist */
    function personRanges() {
        const out = new Map(), L = legs(), ps = persons();
        if (!L.on || !L.start) return out;
        ps.forEach(x => {
            const key = pkey(x);
            const on = L.list.filter(g => (H.placeWho ? H.placeWho(g.k) : Array.isArray(g.p.who) ? g.p.who : ps.map(pkey)).includes(key));
            if (on.length) { const a = on[0], b = on[on.length - 1]; out.set(key, { start: a.from, end: b.n ? b.to : b.from }); }
        });
        return out;
    }
    /* Anwesenheit je Person aus den Etappen: Tag → 'on' (vor Ort) | 'fl' (An-/Abreise).
       Anreise-/Abreise-Etappen sind Reisetage (Abreise inkl. Ankunftstag zu Hause); ohne eigene Anreise ist der erste Tag
       ein Anreisetag, ohne eigene Abreise der Tag nach der letzten Nacht ein Abreisetag. */
    function presence() {
        const L = legs(), ps = persons();
        if (!L.on || !L.start || !ps.length) return [];
        const whoOf = g => H.placeWho ? H.placeWho(g.k) : Array.isArray(g.p.who) ? g.p.who : ps.map(pkey);
        return ps.map(x => {
            const key = pkey(x), on = L.list.filter(g => g.from && whoOf(g).includes(key));
            /* Transporte (flights mit Datum) dieser Person: Reisetage, dürfen Aufenthalte anderer überlappen */
            const trs = (raw().flights || []).filter(f => f && f.from && ISO.test(f.from.date || '') && (!Array.isArray(f.who) || !f.who.length || f.who.some(w => w === x.name || w === key)));
            if (!on.length && !trs.length) return null;
            const days = new Map(), put = (iso, v) => { if (v === 'fl' || !days.has(iso)) days.set(iso, v); };
            on.forEach(g => {
                const k = g.p.kind;
                if (!g.n) { put(g.from, k ? 'fl' : 'on'); return; }
                for (let d = dn(g.from); d < dn(g.to); d++) put(isoOf(d), k ? 'fl' : 'on');
                if (k === 'depart') put(g.to, 'fl');
            });
            if (on.length) {
                const a = on[0], b = on[on.length - 1];
                if (a.p.kind !== 'arrive') days.set(a.from, 'fl');
                if (!b.p.kind && b.n) days.set(b.to, 'fl');
            }
            trs.forEach(f => { const e = ISO.test(f.to && f.to.date || '') && f.to.date >= f.from.date ? f.to.date : f.from.date; for (let d = dn(f.from.date); d <= dn(e) && d - dn(f.from.date) < 30; d++) days.set(isoOf(d), 'fl'); });
            /* Lücken (Etappen nur anderer Reisender dazwischen, z. B. Abreise einer Person): weiter vor Ort */
            let isos = [...days.keys()].sort();
            for (let d = dn(isos[0]) + 1; d < dn(isos[isos.length - 1]); d++) if (!days.has(isoOf(d))) days.set(isoOf(d), 'on');
            isos = [...days.keys()].sort();
            return { key, name: x.name || key, color: color(x.color, 'var(--p1)'), start: isos[0], end: isos[isos.length - 1], days };
        }).filter(Boolean);
    }
    /* Anwesenheitskalender (Vorlage und Thailand): Monatsansicht + Tabelle; Zahl = Tag der eigenen Reise */
    function renderPresence(o) {
        const ps = presence(), body = o && o.body;
        if (!body) return false;
        if (!ps.length) { body.innerHTML = '<p class="note">Sobald die Etappen Nächte und einen Reisebeginn haben, entsteht hier der Kalender.</p>'; if (o.month) o.month.innerHTML = ''; return false; }
        const first = ps.reduce((m, p) => p.start < m ? p.start : m, ps[0].start), last = ps.reduce((m, p) => p.end > m ? p.end : m, ps[0].end);
        const d0 = dn(first), n = dn(last) - d0 + 1, today = H.today;
        if (o.title) o.title.innerHTML = ic('users') + `Anwesenheit · ${n} Tage`;
        body.style.setProperty('--pc', ps.length);
        const cell = (p, iso) => {
            const v = p.days.get(iso);
            if (!v) return '';
            const nr = dn(iso) - dn(p.start) + 1;
            return `<div class="bar${v === 'fl' ? ' fl' : ''}" style="${v === 'fl' ? `color:${esc(p.color)}` : `background:${esc(p.color)}`}" title="${esc(p.name)}: Tag ${nr}${v === 'fl' ? ' (An-/Abreise)' : ''}">${v === 'fl' ? ic('plane') : ''}${nr}</div>`;
        };
        let h = `<div class="cr hd"><div>Tag</div>${ps.map(p => `<div style="color:${esc(p.color)}">${esc(p.name)}</div>`).join('')}</div>`;
        for (let d = 0; d < n; d++) {
            const iso = isoOf(d0 + d), wd = new Date((d0 + d) * 864e5).getUTCDay();
            h += `<div class="cr${wd === 0 || wd === 6 ? ' we' : ''}${iso === today ? ' today' : ''}"><div class="cd">Tag ${d + 1}<small>${'So Mo Di Mi Do Fr Sa'.split(' ')[wd]} ${fmt(iso)}</small></div>`
                + ps.map(p => `<div class="cc">${cell(p, iso)}</div>`).join('') + '</div>';
        }
        body.innerHTML = h;
        if (o.month) {
            const months = [];
            for (let y = +first.slice(0, 4), mo = +first.slice(5, 7); y * 12 + mo <= +last.slice(0, 4) * 12 + +last.slice(5, 7); mo === 12 ? (y++, mo = 1) : mo++) months.push([y, mo]);
            const one = ([y, mo]) => {
                const f = Date.UTC(y, mo - 1, 1) / 864e5, len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
                let g = '<div></div>'.repeat((new Date(f * 864e5).getUTCDay() + 6) % 7);
                for (let d = 0; d < len; d++) {
                    const iso = isoOf(f + d);
                    const dots = ps.map(p => p.days.has(iso) ? `<i class="${p.days.get(iso) === 'fl' ? 'fl' : ''}" style="color:${esc(p.color)}" title="${esc(p.name)}"></i>` : '').join('');
                    g += `<div class="md${dots ? ' on' : ''}${iso === today ? ' now' : ''}">${d + 1}<span>${dots}</span></div>`;
                }
                return `<div><div class="mn"><b>${'Januar Februar März April Mai Juni Juli August September Oktober November Dezember'.split(' ')[mo - 1]} ${y}</b></div>`
                    + `<div class="mg">${'Mo Di Mi Do Fr Sa So'.split(' ').map(w => `<div class="wd">${w}</div>`).join('')}${g}</div></div>`;
            };
            o.month.innerHTML = `<div class="mw" style="--n:${months.length}">${months.map(one).join('')}</div>`
                + `<div class="ml">${ps.map(p => `<span><i style="color:${esc(p.color)}"></i>${esc(p.name)}</span>`).join('')}</div>`;
        }
        return true;
    }
    /* Für „In Ablauf übernehmen“ (shared/activities.js): alle Tage als Auswahl, auch Etappen-Tage ohne Eintrag */
    function dayOptions() {
        const out = [];
        const multi = plansOf().length > 1;
        ablauf().forEach(x => {
            if (x.virtual) { out.push({ ref: `${x.plan}:@${x.iso}`, iso: x.iso, label: [`Tag ${x.v.day}`, fmt(x.iso), x.name].filter(Boolean).join(' · ') }); return; }
            const p = planById(x.plan), r = x.r;
            ensureIds(p.rows);
            out.push({ ref: `${p.id}:${r._id}`, iso: x.iso, label: [p.title && multi ? p.title.replace(/^(Möglicher Ablauf|Tagesplan) /, '') : '', r.day, fmt(R.from(r)) || r.date, R.title(r)].filter(Boolean).join(' · ') });
        });
        return out;
    }
    function dayLabel(ref) {
        const [pid, rid] = String(ref || '').split(':');
        if (/^@\d{4}-\d\d-\d\d$/.test(rid || '')) { const p = planById(pid), r = p && p.rows.find(x => R.from(x) === rid.slice(1)); return r ? [r.day, fmt(R.from(r))].filter(Boolean).join(' · ') : fmt(rid.slice(1)); }
        const p = planById(pid), r = p && p.rows.find(x => x._id === rid);
        return r ? [r.day, fmt(R.from(r)) || r.date].filter(Boolean).join(' · ') : '';
    }
    /* Gibt die Referenz des Tags zurück (bei einem Etappen-Tag ohne Eintrag wird er dabei angelegt) – oder false */
    async function addToDay(ref, text) {
        const [pid, rid] = String(ref || '').split(':');
        let p = planById(pid);
        if (!p && H.newPlan && editable()) p = H.newPlan();
        if (!p || !editable()) return false;
        let r = p.rows.find(x => x._id === rid), fresh = null;
        if (!r && /^@\d{4}-\d\d-\d\d$/.test(rid || '')) {
            const iso = rid.slice(1);
            r = p.rows.find(x => R.from(x) === iso);
            if (!r) { const v = legDays().find(x => x.iso === iso) || { iso, day: '', keys: [] }; fresh = { _id: uid(), ...presetRow(v) }; if (TH()) ['details', 'transport', 'hotel'].forEach(k => { if (fresh[k] == null) fresh[k] = ''; }); r = fresh; }
        }
        if (!r) return false;
        ensureIds(p.rows);
        const ok = await commit([H.planKey], () => {
            if (fresh) { const at = p.rows.findIndex(x => ISO.test(R.from(x)) && R.from(x) > R.from(fresh)); p.rows.splice(at < 0 ? p.rows.length : at, 0, fresh); }
            if (TH()) r.details = (r.details ? r.details + '\n' : '') + '• ' + text;
            else { r.extra = (r.extra || []).filter(x => x !== text); r.extra.push(text); }
        });
        return ok ? `${p.id}:${r._id}` : false;
    }

    /* ---------- Unterkünfte ---------- */
    /* Unterkunft ↔ Etappe: über place (Vorlage), focus (Thailand) oder gleichen Ortsnamen */
    /* robust: Schlüssel (place/focus) zuerst; sonst Name – bei mehreren Besuchen der, dessen Etappe das Check-in-Datum enthält;
       sonst der längste Stopp-Name, mit dem der Text beginnt (z. B. „Bangkok Stadtzentrum“ → „Bangkok“ nach Umbenennen) */
    function stayKey(s) {
        const P = places(), ref = s.place || s.focus;
        if (ref && P[ref]) return ref;
        const d = s.checkin || s.from;
        const inLeg = k => { const g = ISO.test(d || '') && legs(P).list.find(x => x.k === k && x.from); return !!g && g.from <= d && d < (g.n ? g.to : isoOf(dn(g.from) + 1)); };
        const pick = (name, strict) => {
            name = String(name || '').replace(/^\d+\.\s*/, '').trim();
            if (!name) return null;
            let ks = Object.keys(P).filter(k => P[k] && P[k].name === name);
            if (!ks.length) {
                const low = name.toLowerCase();
                const hits = Object.keys(P).filter(k => { const n = String((P[k] || {}).name || '').toLowerCase(); return P[k].num != null && n && low.startsWith(n) && !/[\p{L}\d]/u.test(low.charAt(n.length)); });
                const best = hits.reduce((m, k) => Math.max(m, P[k].name.length), 0);
                ks = hits.filter(k => P[k].name.length === best);
                /* nur ungefähr passender Stationsname: lediglich, wenn das Datum in der Etappe liegt */
                if (strict) ks = ks.filter(inLeg);
            }
            return ks.length > 1 ? ks.find(inLeg) || ks[0] : ks[0] || null;
        };
        return pick(ref) || pick(s.name ?? s.title, true);
    }
    function legFor(s) {
        const k = stayKey(s);
        if (!k) return null;
        const g = legs().list.find(x => x.k === k && x.n > 0);
        return g && g.from ? g : null;
    }
    const S = {
        name: s => s.name ?? s.title ?? '',
        cin: s => { const g = legFor(s); return g ? g.from : s.checkin || s.from || ''; },
        cout: s => { const g = legFor(s); return g ? g.to : s.checkout || s.to || ''; },
        status: s => s.status === 'booked' ? 'booked' : s.status === 'none' ? 'none' : 'open',
        nights: s => { const a = S.cin(s), b = S.cout(s); return ISO.test(a) && ISO.test(b) ? Math.max(0, dn(b) - dn(a)) : (+s.nights || 0); },
        transfer: s => typeof s.transfer === 'object' && s.transfer ? s.transfer : { time: '', text: s.transfer || '' }
    };
    const setAlias = (o, a, b, v) => { const k = (b in o) && !(a in o) ? b : a; setOpt(o, k, v); if (k === a && b in o && !v) delete o[b]; };
    const groups = () => (H.stationGroups ? H.stationGroups() : []) || [];
    const allStations = () => groups().flatMap(g => g.list);
    const STATUS = { booked: ['Gebucht', 'ok'], open: ['Noch offen', 'warn'], none: ['Keine nötig', 'mute'] };

    /* Storno-Frist: gebucht, Frist gesetzt und nicht als geprüft markiert, Aufenthalt noch nicht begonnen */
    function cancelInfo(s) {
        const cu = s.cancel_until;
        if (S.status(s) !== 'booked' || !ISO.test(cu || '') || s.cancel_checked) return null;
        const ci = S.cin(s);
        if (ISO.test(ci) && ci < H.today) return null;
        const d = dn(cu) - dn(H.today);
        return { days: d, warn: d <= 7, text: d < 0 ? `Storno-Frist abgelaufen (${fmt(cu)})` : d === 0 ? 'Kostenlos stornierbar nur noch heute' : `Kostenlos stornierbar bis ${fmt(cu)} · noch ${d} ${d === 1 ? 'Tag' : 'Tage'}` };
    }
    function warnings() {
        return allStations().map(s => ({ s, c: cancelInfo(s) })).filter(x => x.c && x.c.warn).map(x => ({ name: S.name(x.s), until: x.s.cancel_until, days: x.c.days, text: x.c.text }));
    }
    /* Nächte ohne Unterkunft zwischen Reisebeginn und -ende */
    function gaps() {
        const m = H.meta() || {}, st = allStations().filter(s => ISO.test(S.cin(s)) && ISO.test(S.cout(s)));
        if (!m.start || !m.end || !st.length) return [];
        const covered = new Set();
        st.forEach(s => { for (let d = dn(S.cin(s)); d < dn(S.cout(s)); d++) covered.add(d); });
        const out = [];
        let run = null;
        for (let d = dn(m.start); d < dn(m.end); d++) {
            if (!covered.has(d)) { if (run && run.to === d - 1) run.to = d; else out.push(run = { from: d, to: d }); }
        }
        return out.map(r => ({ from: isoOf(r.from), to: isoOf(r.to + 1), nights: r.to - r.from + 1 }));
    }
    const mapsHref = s => { const m = (s.maps || '').trim(); return !m ? '' : url(m) || 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(m); };
    const money = (v, cur) => v === '' || v == null || !isFinite(+v) ? '' : (+v).toLocaleString('de-DE', { minimumFractionDigits: +v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' ' + (cur || '€');
    const copyBtn = (text, lab = 'Kopieren') => text ? `<button type="button" class="pl-copy" data-copy="${esc(text)}" aria-label="${esc(lab)}: ${esc(text)}" title="${esc(lab)}">${ic('copy')}</button>` : '';

    let accFilter = { q: '', st: 'all' };
    let accPane = null;
    /* Unterkünfte wie bei Polarsteps/Stippl: je Etappe ein Abschnitt „Aufenthalt in …“ mit „x/y Nächte gebucht“,
       darin kompakte Karten; was zu keiner Etappe gehört, steht darunter (nach Gruppen, z. B. Thailand/Sri Lanka) */
    function renderAcc(pane) {
        pane = pane || accPane;
        if (!pane) return;
        accPane = pane;
        const gs = groups(), all = allStations(), edit = canEdit(), L = legs();
        const booked = all.filter(s => S.status(s) === 'booked').length, open = all.filter(s => S.status(s) === 'open').length;
        const warn = warnings(), gp = gaps();
        const q = accFilter.q.toLowerCase();
        const match = s => (accFilter.st === 'all' || accFilter.st === 'missing' || S.status(s) === accFilter.st)
            && (!q || [S.name(s), s.hotel, s.address, s.code, s.note, S.transfer(s).text].join(' ').toLowerCase().includes(q));
        const filtering = accFilter.st !== 'all' || !!q;
        const missN = L.list.filter(needsStay).filter(x => !all.some(s => stayKey(s) === x.k)).length;
        const today = H.today;
        const nightsTxt = n => `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`;
        const card = (s, g, i, drag, inLeg) => {
            const st = S.status(s), c = cancelInfo(s), t = S.transfer(s), n = S.nights(s), cin = S.cin(s), cout = S.cout(s);
            const now = ISO.test(cin) && ISO.test(cout) && today >= cin && today < cout;
            const period = ISO.test(cin) ? `${fmt(cin)} – ${fmt(cout) || '?'}` : rich(s.period || '');
            const statusTag = `<span class="pl-st ${STATUS[st][1]}">${esc(s.statusText && !s._edited ? stripTags(s.statusText) : STATUS[st][0])}</span>`;
            const cancel = c ? `<span class="pl-cancel ${c.warn ? 'warn' : ''}${c.days < 0 ? ' late' : ''}">${ic(c.warn ? 'alert' : 'hourglass')}${esc(c.text)}</span>` : '';
            const maps = mapsHref(s), price = money(s.price, s.currency);
            /* alte Buchungsangaben aus dem Import: nur zeigen, was noch nicht in der Notiz steht */
            const legacy = legacyOpen(s).map(b => `<div class="pl-legacy">${b.name ? `<b>${rich(b.name)}</b> ` : ''}${[b.room, b.by, b.cancel].filter(Boolean).map(rich).join(' · ')}</div>`).join('');
            const details = `${s.address ? `<div class="pl-addr"><span>${ic('pin')}<span lang="">${esc(s.address)}</span></span>${copyBtn(s.address, 'Adresse kopieren')}</div>` : ''}
                ${maps ? `<a class="pl-link" href="${esc(maps)}" target="_blank" rel="noopener">${ic('map')}Google Maps ↗</a>` : ''}
                ${t.time || t.text ? `<div class="pl-transfer">${t.time ? `<span class="travel-time-pill">${esc(t.time)}</span>` : ''}${rich(t.text)}</div>` : ''}
                ${s.note ? `<div class="pl-note">${rich(s.note)}</div>` : ''}${legacy}`;
            /* Titel: Hotel, sonst der Ort; der Ort steht nur dabei, wenn die Karte nicht schon im Abschnitt der Etappe liegt */
            const title = s.hotel ? rich(s.hotel) : esc(S.name(s) || 'Unterkunft');
            const sub = [s.hotel && !inLeg ? esc(S.name(s)) : '', period, n ? nightsTxt(n) : ''].filter(Boolean).join(' · ');
            return `<article class="bk-card st-${st}${now ? ' acc-now' : ''}" data-g="${esc(g.id)}" data-i="${i}"${drag ? ` data-sort="acc:${esc(g.id)}"` : ''}>
                <div class="bk-row">
                    <span class="bk-ic">${ic('bed')}</span>
                    <div class="bk-txt"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}
                        <div class="bk-tags">${statusTag}${now ? `<span class="now-badge">${ic('pin')}Heute hier</span>` : ''}${cancel}</div></div>
                    ${edit || details.trim() ? `<div class="bk-side">${edit ? `<div class="pl-acts">
                        <button type="button" data-pl="acc-edit" data-g="${esc(g.id)}" data-i="${i}" aria-label="Bearbeiten: ${esc(S.name(s))}">${ic('pencil')}</button>
                        ${drag ? `<button type="button" class="pl-handle" data-drag="acc" data-g="${esc(g.id)}" data-i="${i}" aria-label="Verschieben: ${esc(S.name(s))} (Pfeiltasten oder ziehen)" title="Ziehen zum Verschieben">${ic('grip')}</button>` : ''}</div>` : ''}
                        ${details.trim() ? `<button type="button" class="bk-det" data-pl="acc-det" aria-expanded="false">Details${ic('chevronDown')}</button>` : ''}</div>` : ''}
                </div>
                ${s.code || price ? `<div class="bk-meta">${s.code ? `<span class="pl-code"><span>Buchung</span><code>${esc(s.code)}</code>${copyBtn(s.code, 'Buchungscode kopieren')}</span>` : ''}${price ? `<span class="pl-price">${esc(price)}</span>` : ''}</div>` : ''}
                ${details.trim() ? `<div class="bk-more">${details}</div>` : ''}
            </article>`;
        };
        /* Etappen (mit Nächten) als Abschnitte */
        const g0 = gs[0] || { id: '' };
        const used = new Set();
        const legSecs = L.list.filter(needsStay).map(x => {
            const stays = [];
            gs.forEach(g => g.list.forEach((s, i) => { if (stayKey(s) === x.k) { used.add(s); if (match(s)) stays.push({ s, g, i }); } }));
            const bn = Math.min(x.n, stays.filter(o => S.status(o.s) === 'booked').reduce((n, o) => n + (S.nights(o.s) || x.n), 0));
            const allStays = all.filter(s => stayKey(s) === x.k);
            if (accFilter.st === 'missing') return allStays.length ? '' : `<section class="bk-sec">
                <div class="bk-head"><span class="pl-dot" style="--c:${esc(H.placeColor ? H.placeColor(x.k) : color(x.p.color, 'var(--p1)'))}">${esc(labels().get(x.k) ?? x.p.num ?? '')}</span>
                    <div><h3>${esc(x.p.name || x.k)}</h3><small>${esc(legShort(x))} · ${nightsTxt(x.n)}</small></div></div>
                <div class="bk-missing">${ic('bed')}<span><b>Unterkunft fehlt</b><small>${nightsTxt(x.n)} zu planen</small></span>
                    ${edit ? `<button type="button" class="btn-action" data-pl="acc-leg" data-g="${esc(g0.id)}" data-k="${esc(x.k)}">${ic('plus')}Eintragen</button>` : ''}</div></section>`;
            if (filtering && !stays.length) return '';
            return `<section class="bk-sec">
                <div class="bk-head">
                    <span class="pl-dot" style="--c:${esc(H.placeColor ? H.placeColor(x.k) : color(x.p.color, 'var(--p1)'))}">${esc(labels().get(x.k) ?? x.p.num ?? '')}</span>
                    <div><h3>${esc(x.p.name || x.k)}</h3><small>${esc(legShort(x))} · ${nightsTxt(x.n)}</small></div>
                    ${edit ? `<button type="button" class="bk-add" data-pl="acc-leg" data-g="${esc(g0.id)}" data-k="${esc(x.k)}" aria-label="Unterkunft in ${esc(x.p.name || x.k)} hinzufügen">${ic('plus')}<span>Unterkunft</span></button>` : ''}
                </div>
                <div class="bk-prog${bn >= x.n ? ' done' : ''}"><span>${bn} / ${x.n} Nächte gebucht</span><i style="--pct:${Math.round(bn / x.n * 100)}"></i></div>
                ${stays.map(o => card(o.s, o.g, o.i, false, true)).join('')}
                ${!allStays.length ? `<div class="bk-missing">${ic('bed')}<span><b>Unterkunft fehlt</b><small>${nightsTxt(x.n)} zu planen</small></span>
                    ${edit ? `<button type="button" class="btn-action" data-pl="acc-leg" data-g="${esc(g0.id)}" data-k="${esc(x.k)}">${ic('plus')}Eintragen</button>` : ''}</div>` : ''}
            </section>`;
        }).join('');
        /* Etappen ohne Übernachtung bzw. „Keine Unterkunft nötig“: zugeordnete, nicht gebuchte Einträge ausblenden */
        const skip = new Set(L.list.filter(x => !needsStay(x)).map(x => x.k));
        if (skip.size) all.forEach(s => { if (!used.has(s) && S.status(s) !== 'booked' && skip.has(stayKey(s))) used.add(s); });
        const openN = all.filter(s => S.status(s) === 'open' && !skip.has(stayKey(s))).length;
        /* übrige Unterkünfte (ohne Etappe), nach Gruppen */
        const rest = gs.map(g => {
            const items = g.list.map((s, i) => ({ s, i })).filter(o => !used.has(o.s) && match(o.s));
            const drag = edit && !filtering && items.length > 1;
            if (accFilter.st === 'missing') return '';
            if (!items.length && (legSecs || gs.length > 1 || filtering)) return '';
            const title = gs.length > 1 && g.label ? g.label : legSecs ? 'Weitere Unterkünfte' : '';
            return `<section class="bk-sec">
                ${title ? `<div class="bk-head"><span class="bk-ic">${ic('bed')}</span><div><h3>${esc(title)}</h3><small>${items.length} ${items.length === 1 ? 'Eintrag' : 'Einträge'}</small></div>
                    ${edit ? `<button type="button" class="bk-add" data-pl="acc-add" data-g="${esc(g.id)}">${ic('plus')}<span>Unterkunft</span></button>` : ''}</div>` : ''}
                ${items.map(o => card(o.s, g, o.i, drag, false)).join('') || `<p class="note">${filtering ? 'Keine Treffer.' : 'Noch keine Unterkünfte eingetragen.'}</p>`}
                ${!title && edit ? `<button type="button" class="btn-action pl-add" data-pl="acc-add" data-g="${esc(g.id)}">${ic('plus')}Unterkunft</button>` : ''}
            </section>`;
        }).join('');
        /* Kopf: gebuchte Nächte über alle Etappen (sonst über alle Unterkünfte) */
        const LS = L.list.filter(needsStay);
        const legN = LS.reduce((n, x) => n + x.n, 0);
        const bookedN = legN ? LS.reduce((n, x) => n + Math.min(x.n, all.filter(s => stayKey(s) === x.k && S.status(s) === 'booked').reduce((m, s) => m + (S.nights(s) || x.n), 0)), 0)
            : all.filter(s => S.status(s) === 'booked').reduce((n, s) => n + S.nights(s), 0);
        const totalN = legN || all.reduce((n, s) => n + S.nights(s), 0);
        const legN0 = all.filter(s => 'bookings' in s).length;
        pane.innerHTML = `<div class="box bk-box">
            <div class="mh"><h2>${ic('bed')}Unterkünfte</h2>
                <span class="pl-sum"><span class="pl-st ok">${booked} gebucht</span>${openN ? `<span class="pl-st warn">${openN} offen</span>` : ''}${missN ? `<span class="pl-st bad">${missN} fehlt</span>` : ''}</span></div>
            ${totalN ? `<div class="bk-prog big${bookedN >= totalN ? ' done' : ''}"><span><b>${bookedN} / ${totalN}</b> Nächte gebucht</span><i style="--pct:${Math.round(bookedN / totalN * 100)}"></i></div>` : ''}
            ${edit && legN0 ? `<div class="tb-banner pl-gap">${ic('info')}<span>${legN0 === 1 ? 'Eine Unterkunft hat' : `${legN0} Unterkünfte haben`} noch alte Buchungsangaben aus dem Import, die man nicht bearbeiten kann.</span><button type="button" class="btn-action" data-pl="acc-legacy">In Notizen übernehmen</button></div>` : ''}
            ${warn.length ? `<div class="tb-banner pl-warn">${ic('alert')}<span><b>Storno-Fristen-Wächter:</b> ${warn.map(w => `${esc(w.name)} – ${esc(w.text)}`).join(' · ')}</span></div>` : ''}
            ${gp.length && !legSecs ? `<div class="tb-banner pl-gap">${ic('bed')}<span><b>Nächte ohne Unterkunft:</b> ${gp.map(x => `${fmt(x.from)}–${fmt(x.to)} (${nightsTxt(x.nights)})`).join(' · ')}</span></div>` : ''}
            ${all.length > 4 || missN ? `<div class="controls pl-filter">
                <input type="search" class="q-input" data-pl-q placeholder="Unterkunft, Adresse oder Buchungscode suchen …" value="${esc(accFilter.q)}">
                ${[['all', 'Alle'], ['booked', 'Gebucht'], ['open', 'Offen'], ...(missN ? [['missing', `Fehlt (${missN})`]] : [])].map(([k, l]) => `<button type="button" class="f${accFilter.st === k ? ' on' : ''}" data-pl="acc-filter" data-st="${k}">${l}</button>`).join('')}
            </div>` : ''}
        </div>
        <div class="bk-list">${legSecs}${rest || (!legSecs ? `<section class="bk-sec"><p class="note">Noch keine Unterkünfte.</p>${edit ? `<button type="button" class="btn-action pl-add" data-pl="acc-add" data-g="">${ic('plus')}Unterkunft</button>` : ''}</section>` : '')}</div>`;
        const qi = pane.querySelector('[data-pl-q]');
        if (qi) qi.oninput = () => { accFilter.q = qi.value; const pos = qi.selectionStart; renderAcc(pane); const n = pane.querySelector('[data-pl-q]'); n.focus(); n.setSelectionRange(pos, pos); };
    }
    const stripTags = s => String(s || '').replace(/<[^>]*>/g, '');
    /* Alte Buchungsangaben (stations[].bookings aus dem Import) → Notiz */
    const plainNorm = x => stripTags(x).replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/[\s·–—\-|,;:]+/g, ' ').trim().toLowerCase();
    const legacyLine = b => [stripTags(b.name), [b.room, b.by, b.cancel].filter(Boolean).map(stripTags).join(' · ')].filter(Boolean).join(' – ');
    const legacyOpen = s => (Array.isArray(s.bookings) ? s.bookings : []).filter(b => b && legacyLine(b) && !plainNorm(s.note).includes(plainNorm(legacyLine(b))));
    /* Notiz mit den noch fehlenden alten Angaben; bookings entfällt danach */
    function legacyNote(s, note) {
        const add = legacyOpen(Object.assign({}, s, { note })).map(legacyLine);
        return [note, ...add].filter(Boolean).join('\n');
    }
    function migrateLegacy(s) {
        if (!('bookings' in s)) return false;
        setOpt(s, 'note', legacyNote(s, s.note || ''));
        const m = (s.bookings || []).map(b => b && b.maps).find(Boolean);
        if (m && !s.maps) s.maps = m;
        delete s.bookings;
        return true;
    }
    function migrateAllLegacy() {
        if (!editable()) return;
        commit(['stations'], () => { allStations().forEach(migrateLegacy); });
    }
    function editStation(gid, idx, legKey) {
        if (!editable()) return;
        let g = groups().find(x => x.id === gid) || groups()[0];
        if (!g && H.ensureStations) g = H.ensureStations();
        if (!g) return;
        const isNew = idx == null || idx < 0;
        const s = isNew ? (legKey && places()[legKey] ? (TH() ? { title: places()[legKey].name, focus: places()[legKey].name } : { name: places()[legKey].name, place: legKey }) : {}) : g.list[idx];
        const t = S.transfer(s);
        const lg = legFor(s);
        const pl = stopList();
        const curStop = isNew ? (legKey && places()[legKey] ? legKey : '') : stayKey(s) || '';
        const last = g.list[g.list.length - 1];
        const defIn = isNew ? (last && S.cout(last)) || (H.meta() || {}).start || '' : S.cin(s);
        sheet({
            title: isNew ? 'Neue Unterkunft' : 'Unterkunft bearbeiten',
            body: `${field('Station / Ort', inp('name', S.name(s), 'required maxlength="120" list="plPlaces" placeholder="z. B. Kyoto"'))}
                <datalist id="plPlaces">${pl.map(({ p }) => `<option value="${esc(p.name)}">`).join('')}</datalist>
                ${pl.some(x => x.p.num != null) ? field('Etappe', `<select name="stop"><option value="">– keine Etappe –</option>${pl.filter(x => x.p.num != null).map(({ k, p }) => { const g = legs().list.find(x => x.k === k); return `<option value="${esc(k)}"${k === curStop ? ' selected' : ''}>${esc(labels().get(k) ?? p.num)} · ${esc(p.name || k)}${g && g.from ? ` · ${esc(legShort(g))}` : ''}</option>`; }).join('')}</select>`) : ''}
                <div class="pl-row">
                    ${field('Check-in', `<input type="date" name="cin" value="${esc(lg ? lg.from : defIn)}"${lg ? ' readonly' : ''}>`)}
                    ${field('Check-out', `<input type="date" name="cout" value="${esc(S.cout(s))}"${lg ? ' readonly' : ''}>`)}
                </div>
                ${lg ? `<p class="note pl-legs-on">${ic('route')}Daten folgen der Etappe ${esc(lg.p.name || lg.k)} (${lg.n} ${nightsWord(lg.n)}) – ändern über − / + bei den Stopps.</p>` : ''}
                ${field('Unterkunft', inp('hotel', s.hotel, 'maxlength="300" placeholder="Name des Hotels / der Unterkunft"'))}
                <div class="pl-row">
                    ${field('Status', sel('status', S.status(s), [['open', 'Noch offen'], ['booked', 'Gebucht'], ['none', 'Keine nötig (z. B. Nachtfahrt)']]))}
                    ${field('Buchungscode', inp('code', s.code, 'maxlength="80" autocomplete="off"'))}
                </div>
                <div class="pl-row">
                    ${field('Kostenlos stornierbar bis', `<input type="date" name="cancel_until" value="${esc(s.cancel_until || '')}">`)}
                    <label class="pl-check"><input type="checkbox" name="cancel_checked"${s.cancel_checked ? ' checked' : ''}><span>Frist erledigt / geprüft (keine Warnung mehr)</span></label>
                </div>
                <div class="pl-row">
                    ${field('Preis', inp('price', s.price, 'inputmode="decimal" placeholder="z. B. 240"'))}
                    ${field('Währung', inp('currency', s.currency || '€', 'maxlength="4" class="pl-short"'))}
                </div>
                ${field('Google-Maps-Link oder Suchbegriff', inp('maps', s.maps, 'maxlength="500" placeholder="https://maps.app.goo.gl/… oder Hotelname, Ort"'))}
                <div class="pl-row">
                    ${field('Transferzeit', inp('ttime', t.time, 'maxlength="40" placeholder="z. B. 2:30 h"'))}
                    ${field('Transfer-Notiz / Weiterreise', inp('ttext', stripTags(t.text), 'maxlength="300"'))}
                </div>
                ${field('Notiz', area('note', (n => s.address && !plainNorm(n).includes(plainNorm(s.address)) ? [n, s.address].filter(Boolean).join('\n') : n)(legacyNote(s, s.note || '')), 'rows="3" maxlength="2000"'))}
                ${legacyOpen(s).length ? `<p class="note">Alte Buchungsangaben aus dem Import stehen jetzt in der Notiz und können dort bearbeitet werden.</p>` : ''}`,
            extra: isNew ? '' : `<button type="button" class="btn-action danger pl-del">${ic('trash')}Löschen</button>`,
            onOpen: f => {
                const del = f.querySelector('.pl-del');
                if (del) del.onclick = () => { if (confirm(`„${S.name(s)}“ löschen?`)) { dlg.close(); commit(['stations'], () => g.list.splice(idx, 1)); } };
            },
            done: f => {
                const name = val(f, 'name'), cin = val(f, 'cin'), cout = val(f, 'cout'), price = val(f, 'price').replace(',', '.');
                if (!name) { alert('Bitte eine Station angeben.'); return false; }
                if (cin && cout && cout <= cin) { alert('Check-out muss nach dem Check-in liegen.'); return false; }
                if (price && !isFinite(+price)) { alert('Bitte den Preis als Zahl eingeben.'); return false; }
                commit(['stations'], () => {
                    const o = isNew ? (TH() ? { title: '', from: '', to: '' } : {}) : s;
                    setAlias(o, 'name', 'title', name);
                    setAlias(o, 'checkin', 'from', cin);
                    setAlias(o, 'checkout', 'to', cout);
                    if (cin && cout && (TH() || 'nights' in o)) o.nights = dn(cout) - dn(cin);
                    if (cin && cout && (TH() || 'period' in o)) o.period = `${fmt(cin)} – ${fmt(cout)}`;
                    const newStatus = val(f, 'status');
                    if (o.status !== newStatus) delete o.statusText;
                    o.status = newStatus;
                    setOpt(o, 'hotel', val(f, 'hotel')); setOpt(o, 'code', val(f, 'code'));
                    setOpt(o, 'cancel_until', val(f, 'cancel_until'));
                    if (f.elements.cancel_checked.checked) o.cancel_checked = true; else delete o.cancel_checked;
                    if (price) o.price = +price; else delete o.price;
                    setOpt(o, 'currency', price ? val(f, 'currency') : '');
                    setOpt(o, 'maps', val(f, 'maps')); setOpt(o, 'note', val(f, 'note'));
                    /* Adresse hat kein eigenes Feld mehr: vorhandene in die Notiz übernehmen */
                    if (o.address) { if (!plainNorm(o.note).includes(plainNorm(o.address))) o.note = [o.note, o.address].filter(Boolean).join('\n'); delete o.address; }
                    if ('bookings' in o) { const m = (o.bookings || []).map(b => b && b.maps).find(Boolean); if (m && !o.maps) o.maps = m; delete o.bookings; }
                    const tt = val(f, 'ttime'), tx = val(f, 'ttext');
                    if (tt || tx || typeof o.transfer === 'object') o.transfer = { time: tt, text: tx }; else delete o.transfer;
                    /* Etappe als Schlüssel speichern (bleibt beim Umbenennen des Orts erhalten) */
                    const sk = f.elements.stop ? val(f, 'stop') : (placeKeyByName(name) || '');
                    if (!TH()) { if (sk) o.place = sk; else delete o.place; }
                    else if (sk) o.focus = sk;
                    else if (isNew || !o.focus || places()[o.focus]) o.focus = name;
                    if (TH() && isNew) { if (!o.transfer) o.transfer = { time: '', text: '' }; if (!o.hotel) o.hotel = ''; }
                    if (isNew) {
                        /* nach Datum einsortieren */
                        const at = cin ? g.list.findIndex(x => ISO.test(S.cin(x)) && S.cin(x) > cin) : -1;
                        g.list.splice(at < 0 ? g.list.length : at, 0, o);
                    }
                });
            }
        });
    }
    function moveStation(gid, i, j) {
        const g = groups().find(x => x.id === gid);
        if (!g || i === j || j < 0 || j >= g.list.length || !editable()) return;
        commit(['stations'], () => { const [x] = g.list.splice(i, 1); g.list.splice(j, 0, x); });
    }
    function moveTransport(i, j) {
        const F = flights();
        if (i === j || j < 0 || j >= F.length || !editable()) return;
        commit(['flights'], () => { const [x] = F.splice(i, 1); F.splice(j, 0, x); });
    }

    /* ---------- Flüge & Transporte ---------- */
    const MODES = [['flight', 'Flug', 'plane'], ['train', 'Zug', 'train'], ['ferry', 'Fähre', 'ship'], ['bus', 'Bus', 'bus'], ['car', 'Mietwagen', 'car']];
    const flights = () => raw().flights || [];
    let trFilter = { q: '', mode: 'all' };
    function renderTransports(listEl) {
        if (!listEl) return;
        const fc = window.tbFlights, edit = canEdit(), all = flights();
        const modeOf = f => f.mode || 'flight';
        const q = trFilter.q.toLowerCase();
        const shown = all.map((f, i) => ({ f, i })).filter(({ f }) => (trFilter.mode === 'all' || modeOf(f) === trFilter.mode)
            && (!q || JSON.stringify(f).toLowerCase().includes(q)));
        const modes = [...new Set(all.map(modeOf))];
        let bar = listEl.previousElementSibling && listEl.previousElementSibling.classList.contains('pl-trbar') ? listEl.previousElementSibling : null;
        if (!bar) { bar = document.createElement('div'); bar.className = 'pl-trbar'; listEl.before(bar); }
        bar.innerHTML = (all.length > 3 || modes.length > 1 ? `<div class="controls pl-filter">
                <input type="search" class="q-input" data-pl-tq placeholder="Ort, Nummer oder Buchungscode suchen …" value="${esc(trFilter.q)}">
                ${modes.length > 1 ? [['all', 'Alle', ''], ...MODES.filter(m => modes.includes(m[0]))].map(([k, l, icon]) => `<button type="button" class="f${trFilter.mode === k ? ' on' : ''}" data-pl="tr-filter" data-mode="${k}">${icon ? ic(icon) : ''}${l}</button>`).join('') : ''}
            </div>` : '')
            /* Transporte entstehen in den Etappen (Zeitstrahl); hier die Übersicht */
            + (document.getElementById('stops') ? `<p class="note pl-srcnote">${ic('sparkles')}Aus den Etappen: Flüge, Züge, Busse usw. im Zeitstrahl der Etappen über „+“ eintragen.${edit ? ` <button type="button" class="link-inline" data-pl="go-stops">Zu den Etappen</button>` : ''}</p>` : '')
            + (edit ? `<div class="pl-toolbar">${document.getElementById('stops') ? '' : `<button type="button" class="btn-action" data-pl="tr-add">${ic('plus')}Transport hinzufügen</button>`}${all.length > 1 ? `<button type="button" class="btn-action" data-pl="tr-sort">${ic('calendar')}Nach Datum sortieren</button>` : ''}</div>` : '');
        const qi = bar.querySelector('[data-pl-tq]');
        if (qi) qi.oninput = () => { trFilter.q = qi.value; const pos = qi.selectionStart; renderTransports(listEl); const n = listEl.previousElementSibling.querySelector('[data-pl-tq]'); n.focus(); n.setSelectionRange(pos, pos); };
        const sortable = trFilter.mode === 'all' && !q && all.length > 1;
        const acts = i => edit ? `<div class="pl-acts pl-tr-acts">
                <button type="button" data-pl="tr-edit" data-i="${i}" aria-label="Bearbeiten">${ic('pencil')}</button>
                ${sortable ? `<button type="button" class="pl-handle" data-drag="tr" data-i="${i}" aria-label="Verschieben (Pfeiltasten oder ziehen)" title="Ziehen zum Verschieben">${ic('grip')}</button>` : ''}</div>` : '';
        listEl.innerHTML = shown.map(({ f, i }) => {
            const card = fc && fc.isCard(f);
            const li = card ? fc.card(f, edit ? acts(i) : '') : `<li>
                    <div class="fl-date">${esc(f.date)}</div>
                    <div class="fl-route">${rich(f.route)}</div>
                    ${f.duration ? `<div class="fl-dur">${ic('clock')}${esc(f.duration)}</div>` : ''}
                    ${f.details ? `<div class="fl-details">${rich(f.details)}${url(f.status) ? ` (<a href="${esc(url(f.status))}" target="_blank" rel="noopener" class="fl-link">Status prüfen ↗</a>)` : ''}</div>` : ''}
                    ${f.price ? `<div class="fl-price">${rich(f.price)}</div>` : ''}
                </li>`;
            /* Handy: nach links wischen zeigt Bearbeiten / Löschen (.sw-acts), wie bei To-Dos */
            const sw = `<span class="sw-acts"><button type="button" class="sw-edit" data-pl="tr-edit" data-i="${i}" aria-label="Bearbeiten" title="Bearbeiten">${ic('pencil')}</button><button type="button" class="sw-del" data-pl="tr-del" data-i="${i}" aria-label="Löschen" title="Löschen">${ic('trash')}</button></span>`;
            return edit ? li.replace(/^\s*<li( class=")?/, (m, c) => `<li data-sort="tr" data-i="${i}" class="sw-row${c ? ' ' : '"'}`).replace(/<\/li>\s*$/, (card ? '' : acts(i)) + sw + '</li>') : li;
        }).join('') || `<li class="pl-empty"><p class="note">${all.length ? 'Keine Treffer.' : 'Noch keine Flüge oder Transporte eingetragen.'}</p></li>`;
    }
    function editTransport(idx, preset) {
        if (!editable()) return;
        const isNew = idx == null || idx < 0;
        const f0 = isNew ? Object.assign({ mode: 'flight', from: {}, to: {} }, preset || {}) : flights()[idx];
        const legacy = !isNew && !(f0.from && f0.to);
        const f = legacy ? { mode: 'flight', label: f0.date, note: stripTags([f0.route, f0.details].filter(Boolean).join(' – ')), cost: stripTags(f0.price), status: f0.status, from: {}, to: {} } : f0;
        const end = (side, o) => `<fieldset class="pl-end"><legend>${side === 'from' ? 'Abfahrt / Start' : 'Ankunft / Ziel'}</legend>
            <div class="pl-row">
                ${field('Kürzel', inp(side + '_code', o.code, 'maxlength="8" class="pl-short" placeholder="z. B. VIE"'))}
                ${field('Ort / Bahnhof / Hafen', inp(side + '_city', o.city, 'maxlength="80"'), 'grow')}
            </div>
            <div class="pl-row">
                ${field('Datum', `<input type="date" name="${side}_date" value="${esc(o.date || '')}">`)}
                ${field('Uhrzeit', `<input type="time" name="${side}_time" value="${esc(/^\d{2}:\d{2}$/.test(o.time || '') ? o.time : '')}">`)}
            </div></fieldset>`;
        sheet({
            title: isNew ? 'Neuer Transport' : 'Transport bearbeiten',
            body: `<div class="pl-modes" role="radiogroup" aria-label="Transportmittel">${MODES.map(([k, l, icon]) => `<label class="pl-chip"><input type="radio" name="mode" value="${k}"${(f.mode || 'flight') === k ? ' checked' : ''}><span>${ic(icon)}${l}</span></label>`).join('')}</div>
                ${legacy ? '<p class="note">Älterer Eintrag als Text – beim Speichern wird er in eine Karte umgewandelt.</p>' : ''}
                ${field('Bezeichnung', inp('label', f.label, 'maxlength="80" placeholder="z. B. Hinflug, Shinkansen nach Kyoto"'))}
                ${end('from', f.from || {})}${end('to', f.to || {})}
                <div class="pl-row">
                    ${field('Dauer', inp('dur', f.dur, 'maxlength="40" placeholder="z. B. 2 Std. 15 Min."'))}
                    ${field('Gesellschaft / Anbieter', inp('airline', f.airline, 'maxlength="80"'))}
                </div>
                ${field('Nummer(n) – mit Komma getrennt', inp('nos', (Array.isArray(f.flightNos) ? f.flightNos : [f.flightNos].filter(Boolean)).join(', '), 'maxlength="120" placeholder="z. B. OS51, NH204"'))}
                <div class="pl-row">
                    ${field('Buchungscode', inp('booking', f.booking, 'maxlength="80" autocomplete="off"'))}
                    ${field('Status', sel('planned', f.planned ? '1' : '0', [['0', 'Gebucht'], ['1', 'Geplant / noch offen']]))}
                </div>
                <div class="pl-row">
                    ${field('Preis', inp('price', f.price_value ?? '', 'inputmode="decimal"'))}
                    ${field('Währung', inp('currency', f.currency || '€', 'maxlength="4" class="pl-short"'))}
                    ${field('oder Kosten als Text', inp('cost', f.cost, 'maxlength="80" placeholder="z. B. 349,90 € p.P."'), 'grow')}
                </div>
                ${field('Ticket- / Status-Link', inp('status', f.status, 'type="url" maxlength="500" placeholder="https://…"'))}
                ${persons().length ? `<fieldset class="pl-who"><legend>Wer reist mit? (keiner angehakt = alle)</legend>${persons().map(x => `<label class="pl-check"><input type="checkbox" name="whoP" value="${esc(x.name || pkey(x))}"${Array.isArray(f.who) && f.who.some(w => w === x.name || w === pkey(x)) ? ' checked' : ''}><span><i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>${esc(x.name || pkey(x))}</span></label>`).join('')}</fieldset>`
                    : field('Mitreisende – mit Komma getrennt', inp('who', (Array.isArray(f.who) ? f.who : []).join(', '), 'maxlength="200"'))}
                ${field('Notiz', area('note', f.note, 'rows="2" maxlength="1000"'))}
                <label class="pl-check"><input type="checkbox" name="onMap"${f.noMap ? '' : ' checked'}><span>Linie auf der Karte (Start und Ziel als Etappe oder Flughafen-Kürzel, z. B. MUC)</span></label>`,
            extra: isNew ? '' : `<button type="button" class="btn-action danger pl-del">${ic('trash')}Löschen</button>`,
            onOpen: fm => {
                const del = fm.querySelector('.pl-del');
                if (del) del.onclick = () => { if (confirm('Diesen Eintrag löschen?')) { dlg.close(); commit(['flights'], () => raw().flights.splice(idx, 1)); } };
            },
            done: fm => {
                const st = val(fm, 'status'), price = val(fm, 'price').replace(',', '.');
                if (st && !url(st)) { alert('Der Link muss mit https:// beginnen.'); return false; }
                if (price && !isFinite(+price)) { alert('Bitte den Preis als Zahl eingeben.'); return false; }
                if (!val(fm, 'from_code') && !val(fm, 'from_city') || !val(fm, 'to_code') && !val(fm, 'to_city')) { alert('Bitte Start und Ziel angeben (Kürzel oder Ort).'); return false; }
                const endOf = side => { const o = {}; ['code', 'city', 'date', 'time'].forEach(k => setOpt(o, k, val(fm, side + '_' + k))); if (o.code) o.code = o.code.toUpperCase(); return o; };
                const list = s => s.split(',').map(x => x.trim()).filter(Boolean);
                commit(['flights'], () => {
                    const o = isNew || legacy ? {} : f0;
                    o.mode = fm.querySelector('[name=mode]:checked').value;
                    o.from = endOf('from'); o.to = endOf('to');
                    ['label', 'dur', 'airline', 'booking', 'cost', 'status', 'note', 'currency'].forEach(k => setOpt(o, k, val(fm, k)));
                    if (price) o.price_value = +price; else { delete o.price_value; delete o.currency; }
                    const wb = [...fm.querySelectorAll('input[name="whoP"]')];
                    const nos = list(val(fm, 'nos')), who = wb.length ? (wb.every(x => x.checked) ? [] : wb.filter(x => x.checked).map(x => x.value)) : list(val(fm, 'who'));
                    if (nos.length) o.flightNos = nos; else delete o.flightNos;
                    if (who.length) o.who = who; else delete o.who;
                    if (val(fm, 'planned') === '1') o.planned = true; else delete o.planned;
                    if (fm.elements.onMap.checked) delete o.noMap; else o.noMap = true;
                    const F = raw().flights = raw().flights || [];
                    if (isNew) F.push(o); else if (legacy) F[idx] = o;
                });
            }
        });
    }
    /* „+“ im Zeitstrahl: Aufenthalt oder Transport an dieser Stelle */
    function addAt(at, k, nk) {
        if (!editable()) return;
        const P = places(), a = k && P[k], z = nk && P[nk], g = k && legs().list.find(x => x.k === k);
        sheet({
            title: 'Hier einfügen',
            body: `<div class="pl-choice">
                <button type="button" class="pl-choice-btn" data-c="stay">${ic('pin')}<span><b>Aufenthalt</b><small>Ort mit Nächten (Etappe)</small></span></button>
                <button type="button" class="pl-choice-btn" data-c="tr">${ic('plane')}<span><b>Transport</b><small>Flug, Zug, Bus, Auto, Fähre${a && z ? ` · ${esc(a.name)} → ${esc(z.name)}` : ''}</small></span></button>
            </div>`,
            onOpen: f => {
                f.querySelector('.pl-save').hidden = true;
                f.querySelector('[data-c=stay]').onclick = () => { dlg.close(); editStop(null, at); };
                f.querySelector('[data-c=tr]').onclick = () => { dlg.close(); editTransport(null, { from: { city: a ? a.name : '', date: g && g.to ? g.to : '' }, to: { city: z ? z.name : '' } }); };
            },
            done: () => true
        });
    }
    function sortTransports() {
        if (!editable()) return;
        const key = f => f.from && f.from.date ? f.from.date + 'T' + (f.from.time || '00:00') : '9999';
        commit(['flights'], () => { raw().flights = flights().map((f, i) => ({ f, i })).sort((a, b) => key(a.f).localeCompare(key(b.f)) || a.i - b.i).map(x => x.f); });
    }

    /* ---------- Klicks (Delegation) ---------- */
    /* Etappe ohne Unterkunft (Detail-Sheet) */
    document.addEventListener('change', e => {
        const c = e.target.closest && e.target.closest('[data-pl-nostay]');
        if (!c) return;
        const k = c.dataset.plNostay;
        if (!editable()) { c.checked = !c.checked; return; }
        commitPlaces(() => { const o = raw().places[k]; if (!o) return; if (c.checked) o.noStay = true; else delete o.noStay; }).then(() => renderDetail());
    });
    document.addEventListener('click', async e => {
        const cp = e.target.closest('.pl-copy');
        if (cp) { e.preventDefault(); e.stopPropagation(); if (await TB.copyText(cp.dataset.copy)) status('copied'); return; }
        const b = e.target.closest('[data-pl]');
        if (!b || !H) return;
        const a = b.dataset.pl, i = b.dataset.i != null ? +b.dataset.i : null;
        if (a !== 'stop-focus' && a !== 'acc-filter' && a !== 'tr-filter') { e.preventDefault(); e.stopPropagation(); }
        switch (a) {
            case 'stop-add': closeFab(); return editStop(null, b.dataset.at != null ? +b.dataset.at : null);
            case 'stop-open': return openStop(b.dataset.k);
            case 'stop-again': if (dlg && dlg.open) dlg.close(); return addAgain(b.dataset.k, null);
            case 'stop-acts': { const p = places()[b.dataset.k]; if (dlg) dlg.close(); return p && window.TBActivities && TBActivities.open(p.name, labels().get(b.dataset.k) ?? p.num ?? '', b); }
            case 'fab': { const m = b.parentElement.querySelector('.pl-fab-menu'); m.hidden = !m.hidden; b.setAttribute('aria-expanded', String(!m.hidden)); b.classList.toggle('on', !m.hidden); return; }
            case 'fab-tr': closeFab(); return editTransport(null);
            case 'go-stops': { const t = document.querySelector('.tabs .tab[data-t="stops"], .pop-btn[data-t="stops"]'); if (t) t.click(); return; }
            case 'info-add': return editInfo(null);
            case 'info-edit': return editInfo(i);
            case 'info-del': { const x = (raw().infos || [])[i]; if (x && editable() && confirm(`„${stripTags(x.title || x.text).slice(0, 60)}“ löschen?`)) commit(['infos'], () => raw().infos.splice(i, 1)); return; }
            case 'gap-add': return addAt(b.dataset.at != null ? +b.dataset.at : null, b.dataset.k, b.dataset.n);
            case 'fab-acc': closeFab(); return editStation((groups()[0] || {}).id, null);
            case 'people': return editPeople();
            case 'ins-toggle': return toggleIns();
            case 'trip-dates': return editTripDates();
            case 'stop-edit': return editStop(b.dataset.k);
            case 'stop-focus': { if (dlg && dlg.open) dlg.close(); const p = places()[b.dataset.k], fk = p && p.same && places()[p.same] ? p.same : b.dataset.k; if (sideFocus(fk)) return; return H.focusPlace && H.focusPlace(fk); }
            case 'row-add': return editRow(b.dataset.plan, null, b.dataset.iso ? (legDays().find(x => x.iso === b.dataset.iso) || { iso: b.dataset.iso, day: '', keys: [] }) : null);
            case 'row-edit': return editRow(b.dataset.plan, i);
            case 'row-del': { const p = planById(b.dataset.plan), r = p && p.rows[i]; if (r && editable() && confirm(`„${r.day || 'Tag'}${R.title(r) ? ' · ' + R.title(r) : ''}“ löschen?`)) commit([H.planKey], () => p.rows.splice(i, 1)); return; }
            case 'days-gen': return generateDays(b.dataset.plan);
            case 'days-legs': return planFromLegs(b.dataset.plan);
            case 'n-inc': return stepNights(b.dataset.k, 1);
            case 'n-dec': return stepNights(b.dataset.k, -1);
            case 'acc-leg': return editStation(b.dataset.g, null, b.dataset.k);
            case 'acc-add': return editStation(b.dataset.g, null);
            case 'acc-edit': return editStation(b.dataset.g, i);
            case 'acc-filter': accFilter.st = b.dataset.st; return renderAcc();
            case 'acc-legacy': return migrateAllLegacy();
            case 'acc-det': { const o = b.closest('.bk-card').classList.toggle('det-open'); b.setAttribute('aria-expanded', o); return; }
            case 'tr-add': return editTransport(null);
            case 'tr-edit': return editTransport(i);
            case 'tr-del': { const f = flights()[i]; if (f && editable() && confirm('Diesen Eintrag löschen?')) commit(['flights'], () => raw().flights.splice(i, 1)); return; }
            case 'tr-sort': return sortTransports();
            case 'tr-filter': { trFilter.mode = b.dataset.mode; const l = b.closest('.pl-trbar').nextElementSibling; return renderTransports(l); }
        }
    }, true);

    /* ---------- Verschieben per Ziehen am Griff (Maus, Finger) oder Pfeiltasten ---------- */
    function dropTo(g, from, to) {
        if (from === to) return;
        if (g.dataset.drag === 'stops') {
            /* Index in der Stoppliste = Position unter den sortierbaren Zeilen */
            moveStop(g.dataset.k, to);
        } else if (g.dataset.drag === 'acc') moveStation(g.dataset.g, +g.dataset.i, +g.dataset.i + (to - from));
        else if (g.dataset.drag === 'tr') moveTransport(+g.dataset.i, +g.dataset.i + (to - from));
    }
    const sortItems = item => [...item.parentElement.children].filter(x => x.dataset.sort === item.dataset.sort && x.offsetParent);
    document.addEventListener('keydown', e => {
        const g = e.target.closest && e.target.closest('.pl-handle');
        if (!g || !H || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const item = g.closest('[data-sort]'), items = sortItems(item), from = items.indexOf(item);
        const to = Math.max(0, Math.min(items.length - 1, from + (e.key === 'ArrowUp' ? -1 : 1)));
        dropTo(g, from, to);
    });
    document.addEventListener('pointerdown', e => {
        const g = e.target.closest('.pl-handle');
        if (!g || !H || e.button > 0 || !editable()) return;
        const item = g.closest('[data-sort]');
        if (!item) return;
        e.preventDefault();
        const items = sortItems(item), from = items.indexOf(item);
        if (from < 0 || items.length < 2) return;
        const page = y => y + window.scrollY;
        const rects = items.map(x => { const r = x.getBoundingClientRect(); return { top: page(r.top), h: r.height, mid: page(r.top) + r.height / 2 }; });
        /* Abstand zum Nachbarn = Höhe der Lücke, um die die anderen Zeilen ausweichen */
        const step = from < items.length - 1 ? rects[from + 1].top - rects[from].top : rects[from].top - rects[from - 1].top + rects[from].h - rects[from - 1].h;
        const y0 = page(e.clientY);
        let to = from, lastY = e.clientY, raf = 0;
        item.classList.add('pl-dragging');
        items.forEach(x => { if (x !== item) x.classList.add('pl-shift'); });
        try { g.setPointerCapture(e.pointerId); } catch (err) {}
        const update = () => {
            const dy = page(lastY) - y0, mid = rects[from].mid + dy;
            to = from;
            for (let i = from + 1; i < items.length; i++) if (mid > rects[i].mid) to = i;
            for (let i = from - 1; i >= 0; i--) if (mid < rects[i].mid) to = i;
            item.style.transform = `translateY(${dy}px)`;
            items.forEach((x, i) => {
                if (x === item) return;
                const off = from < to && i > from && i <= to ? -step : from > to && i < from && i >= to ? step : 0;
                x.style.transform = off ? `translateY(${off}px)` : '';
            });
        };
        /* am Bildschirmrand weiterscrollen */
        const edge = () => {
            const m = 70, v = lastY < m ? -(m - lastY) / 4 : lastY > innerHeight - m ? (lastY - innerHeight + m) / 4 : 0;
            if (v) { window.scrollBy(0, v); update(); }
            raf = requestAnimationFrame(edge);
        };
        raf = requestAnimationFrame(edge);
        const move = ev => { lastY = ev.clientY; update(); };
        const end = ev => {
            cancelAnimationFrame(raf);
            g.removeEventListener('pointermove', move);
            g.removeEventListener('pointerup', end);
            g.removeEventListener('pointercancel', end);
            item.classList.remove('pl-dragging');
            items.forEach(x => { x.style.transform = ''; x.classList.remove('pl-shift'); });
            if (ev.type === 'pointerup') dropTo(g, from, to);
        };
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', end);
        g.addEventListener('pointercancel', end);
    });

    function closeFab() { document.querySelectorAll('.pl-fab-menu').forEach(m => { m.hidden = true; }); document.querySelectorAll('.pl-fab').forEach(f => { f.classList.remove('on'); f.setAttribute('aria-expanded', 'false'); }); }
    document.addEventListener('pointerdown', e => { if (!e.target.closest('.pl-fab-wrap')) closeFab(); });

    /* ---------- Listen: Suchleiste + „+“ statt Eingabezeile (To-Dos, Packliste) ----------
       Die vorhandene Eingabezeile der Seite (.pack-add-form) wandert beim Tippen auf „+“ in ein eigenes Bottom-Sheet und danach zurück,
       so bleibt die Speicher-Logik der Seite unverändert. */
    function plusAdd(form, anchor, title) {
        if (!form || !anchor || form.dataset.plus) return;
        form.dataset.plus = '1';
        /* Desktop (ab 1100 px): Eingabezeile bleibt sichtbar – schneller zum Eintragen; Handy: „+“ öffnet ein Sheet */
        const mqW = matchMedia('(min-width: 1100px)');
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'add-plus'; btn.setAttribute('aria-label', title); btn.title = title;
        btn.innerHTML = ic('plus');
        anchor.appendChild(btn);
        const home = form.parentNode, next = form.nextSibling;
        let d = null;
        const sync = () => { if (!(d && d.open)) form.hidden = !mqW.matches; btn.hidden = mqW.matches; form.classList.toggle('add-inline', mqW.matches); };
        mqW.addEventListener('change', sync);
        sync();
        const close = () => { if (d && d.open) d.close(); };
        btn.onclick = () => {
            if (!d) {
                d = document.createElement('dialog');
                d.className = 'pl-sheet pl-add-sheet';
                d.innerHTML = `<div class="pl-form"><div class="pl-grip" aria-hidden="true"></div><div class="pl-head"><h2>${esc(title)}</h2><button type="button" class="pl-x" aria-label="Schließen">${ic('x')}</button></div><div class="pl-body"></div></div>`;
                document.body.appendChild(d);
                d.querySelector('.pl-x').onclick = close;
                d.addEventListener('click', e => { if (e.target === d) close(); });
                d.addEventListener('close', () => { home.insertBefore(form, next); sync(); });
            }
            d.querySelector('.pl-body').appendChild(form);
            form.hidden = false;
            d.showModal();
            const first = form.querySelector('input[type=text], input:not([type])');
            if (first) setTimeout(() => first.focus(), 50);
        };
        /* nach dem Hinzufügen (Seite leert das Textfeld) schließen */
        const after = () => setTimeout(() => { const t = form.querySelector('input[type=text], input:not([type])'); if (t && !t.value) { if (d && d.open) close(); else if (mqW.matches) t.focus(); } }, 60);
        form.addEventListener('click', e => { if (e.target.closest('button')) after(); });
        form.addEventListener('keydown', e => { if (e.key === 'Enter') after(); });
    }
    /* Packliste: Suchleiste über der Tabelle (filtert die Zeilen nach Text) */
    function packSearch(box) {
        if (!box || box.querySelector('.pack-search')) return null;
        const form = box.querySelector('.pack-add-form');
        const row = document.createElement('div');
        row.className = 'controls pack-search';
        row.innerHTML = '<input type="search" class="q-input" placeholder="Packliste durchsuchen …" aria-label="Packliste durchsuchen">';
        (form || box.firstChild).before(row);
        const qi = row.querySelector('input');
        const run = () => { const t = qi.value.trim().toLowerCase(); box.querySelectorAll('tbody tr, .pack-card').forEach(r => { r.hidden = !!t && !r.textContent.toLowerCase().includes(t); }); };
        qi.oninput = run;
        new MutationObserver(() => { if (qi.value) run(); }).observe(box, { childList: true, subtree: true });
        return row;
    }
    function enhanceLists() {
        const tf = document.querySelector('#todos .pack-add-form'), ts = document.querySelector('#todos .todo-search');
        if (tf && ts) plusAdd(tf, ts, 'Neues To-Do');
        const pbox = document.querySelector('#pack .pack-add-form') && document.querySelector('#pack .pack-add-form').closest('.box');
        if (pbox) { const row = packSearch(pbox); if (row) plusAdd(pbox.querySelector('.pack-add-form'), row, 'Neuer Gegenstand'); }
    }
    /* ---------- Infos & Hinweise (infos: [{ title, text }]) – Admins: „+“, Wischen zum Bearbeiten/Löschen ---------- */
    function renderInfos(ul) {
        if (!ul) return;
        const L = raw().infos || [], admin = H.role === 'admin' && canEdit();
        const box = ul.closest('.box');
        if (box) {
            box.hidden = !L.length && !admin;
            const h = box.querySelector('h2');
            if (h && admin && !h.querySelector('.add-plus')) h.insertAdjacentHTML('beforeend', `<button type="button" class="add-plus" data-pl="info-add" aria-label="Hinweis hinzufügen" title="Hinweis hinzufügen">${ic('plus')}</button>`);
        }
        ul.innerHTML = L.map((x, i) => `<li class="${admin ? 'sw-row info-row' : ''}"><span class="info-txt"><strong>${esc(x.title || '')}${x.title ? ':' : ''}</strong> ${rich(x.text)}</span>${admin ? `<span class="sw-acts"><button type="button" class="sw-edit" data-pl="info-edit" data-i="${i}" aria-label="Bearbeiten" title="Bearbeiten">${ic('pencil')}</button><button type="button" class="sw-del" data-pl="info-del" data-i="${i}" aria-label="Löschen" title="Löschen">${ic('trash')}</button></span>` : ''}</li>`).join('')
            || (admin ? '<li class="note">Noch keine Hinweise – über „+“ hinzufügen.</li>' : '');
    }
    function editInfo(i) {
        if (!editable()) return;
        const isNew = i == null, x = isNew ? {} : (raw().infos || [])[i];
        if (!x) return;
        sheet({
            title: isNew ? 'Neuer Hinweis' : 'Hinweis bearbeiten',
            body: field('Titel', inp('title', x.title, 'maxlength="120" placeholder="z. B. Visum"')) + field('Text', area('text', x.text, 'rows="4" maxlength="2000" required')),
            done: f => {
                const t = val(f, 'text');
                if (!t) { alert('Bitte einen Text eingeben.'); return false; }
                commit(['infos'], () => { const L = raw().infos = raw().infos || []; const o = isNew ? {} : L[i]; o.title = val(f, 'title'); o.text = t; if (isNew) L.push(o); });
            }
        });
    }
    /* Ablauf-Karten (Handy): Wischen nach links zeigt Bearbeiten / Löschen; die Karten tragen dafür ihren Bearbeiten-Knopf */
    function swipeCards() {
        document.querySelectorAll('.card:not(.sw-row)').forEach(c => {
            const e = c.querySelector('.row-edit[data-pl="row-edit"]');
            if (!e) return;
            c.classList.add('sw-row', 'ab-sw');
            const d = `data-plan="${esc(e.dataset.plan)}" data-i="${esc(e.dataset.i)}"`;
            c.insertAdjacentHTML('beforeend', `<div class="sw-acts"><button type="button" class="sw-edit" data-pl="row-edit" ${d} aria-label="Bearbeiten">${ic('pencil')}</button><button type="button" class="sw-del" data-pl="row-del" ${d} aria-label="Löschen">${ic('trash')}</button></div>`);
        });
    }
    function init(host) {
        H = host; window.TBPlanner.ready = true; setTimeout(enhanceLists, 0);
        let t = 0;
        if (window.MutationObserver) new MutationObserver(() => { if (!t) t = requestAnimationFrame(() => { t = 0; swipeCards(); }); }).observe(document.body, { childList: true, subtree: true });
        setTimeout(swipeCards, 0);
    }

    window.TBPlanner = {
        init, ready: false, canEdit, editable,
        stopList, routeStops, totalKm, kmText, renderStops, mountStops,
        planToolbar, rowEditBtn, editRow, dayOptions, dayLabel, addToDay,
        renderAcc, warnings, gaps, cancelInfo,
        legs, legText, labels, legDays, ablauf, personRanges, presence, renderPresence, routeSegments, drawRoute, homePoints, stayKey: s => stayKey(s),
        saveKeys: (keys, mutate) => commit(keys, mutate),
        sheet: o => sheet(o), ui: { field, inp, area, sel: (n, v, o) => sel(n, v, o), val: (f, n) => val(f, n) },
        renderTransports, renderInfos, enhanceLists,
        stationStats: () => { const a = allStations(); return { total: a.length, booked: a.filter(s => S.status(s) === 'booked').length, open: a.filter(s => S.status(s) === 'open').length }; }
    };
})();
