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
    const field = (lab, input, cls = '') => `<label class="pl-field ${cls}"><span>${lab}</span>${input}</label>`;
    const inp = (name, v, attrs = '') => `<input name="${name}" value="${esc(v ?? '')}" ${attrs}>`;
    const area = (name, v, attrs = '') => `<textarea name="${name}" rows="3" ${attrs}>${esc(v ?? '')}</textarea>`;
    const sel = (name, v, opts) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(v ?? '') === String(k) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const val = (f, n) => (f.elements[n] && f.elements[n].value || '').trim();

    /* ---------- Stopps ---------- */
    const places = () => raw().places || {};
    /* Reihenfolge: nummerierte Orte nach Nummer, danach die übrigen in Daten-Reihenfolge */
    function stopList(P) {
        P = P || places();
        const all = Object.entries(P).map(([k, p], i) => ({ k, p, i }));
        return all.sort((a, b) => (a.p.num == null) - (b.p.num == null) || (a.p.num ?? 0) - (b.p.num ?? 0) || a.i - b.i);
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
    function totalKm(P) {
        const l = routeStops(P);
        let s = 0;
        for (let i = 1; i < l.length; i++) s += km(l[i - 1].p, l[i].p);
        return Math.round(s);
    }
    const kmText = n => n.toLocaleString('de-DE') + ' km';
    /* Fahrzeit grob geschätzt: Straße ≈ Luftlinie × 1,3 bei im Schnitt 60 km/h; ab 800 km eher Flug */
    function driveText(k) {
        if (k >= 800) return 'eher Flug';
        const h = k * 1.3 / 60;
        if (h < 1) return `ca. ${Math.max(10, Math.round(h * 6) * 10)} min`;
        return `ca. ${(h < 10 ? Math.round(h * 2) / 2 : Math.round(h)).toLocaleString('de-DE')} h`;
    }

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
        const list = l.map(({ k, p }) => {
            const n = nightsOf(k, p) ?? 0, o = { k, p, n, d0: off, d1: off + n };
            off += n;
            if (s) { o.from = isoOf(dn(s) + o.d0); o.to = isoOf(dn(s) + o.d1); }
            return o;
        });
        return { on: true, list, total: off, start: s, end: s ? isoOf(dn(s) + off) : null };
    }
    const legText = g => g.from ? (g.n ? `${label(g.from)} – ${label(g.to)}` : `${label(g.from)} · Zwischenstopp`)
        : g.n ? `Tag ${g.d0 + 1} – ${g.d1 + 1}` : `Tag ${g.d0 + 1} · Zwischenstopp`;
    const nightsWord = n => n === 1 ? 'Nacht' : 'Nächte';
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

    function renderStops(el, P) {
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
                <span><b>${n == null ? '–' : n}</b><small>${n == null ? 'Nächte' : nightsWord(n)}</small></span>
                <button type="button" data-pl="n-inc" data-k="${esc(k)}" aria-label="Eine Nacht mehr">${ic('plus')}</button>
            </div>`;
        };
        const next = new Map();
        for (let i = 1; i < rs.length; i++) next.set(rs[i - 1].k, Math.round(km(rs[i - 1].p, rs[i].p)));
        el.hidden = !l.length && !edit;
        const total = totalKm(P);
        /* Reiseende: fester Zeitraum, sonst die Summe der Nächte */
        const end = m.end && !(H.legEnd && H.legEnd()) ? m.end : L.end;
        const drag = edit && l.length > 1;
        el.innerHTML = `<div class="mh"><h2>${ic('route')}Etappen<small class="pl-count">${l.length || ''}</small></h2>
                <span class="pl-head-acts">${H.role === 'admin' ? `<button type="button" data-pl="people" title="Reisende und ihre Farben">${ic('users')}${persons().length ? `<span class="pl-people">${persons().map(x => `<i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>`).join('')}</span>` : 'Reisende'}</button>` : ''}
                ${edit && l.length ? `<button type="button" data-pl="stop-add">${ic('plus')}Stopp</button>` : ''}</span></div>
            ${ring}
            ${rs.length > 1 ? `<p class="note pl-total">${ic('route')}${kmText(total)} Luftlinie entlang der Route${drag ? ' · Reihenfolge per Ziehen am Griff ändern' : ''}</p>` : ''}
            ${l.length ? `<ol class="pl-stops">${l.map(({ k, p }) => `
                <li class="pl-stop" data-k="${esc(k)}" data-sort="stops">
                    <button type="button" class="pl-dot" data-pl="stop-focus" data-k="${esc(k)}" style="--c:${esc(H.placeColor ? H.placeColor(k) : color(p.color, 'var(--p1)'))}" aria-label="Auf der Karte zeigen: ${esc(p.name)}">${p.num != null ? esc(p.num) : ic('pin')}</button>
                    <div class="pl-stop-main">
                        <b>${esc(p.name || k)}</b>
                        ${lg.has(k) ? `<small>${esc(legText(lg.get(k)))}</small>` : p.date ? `<small>${esc(p.date)}</small>` : ''}
                    </div>
                    ${p.num != null ? stepper(k, p) : ''}
                    ${edit ? `<div class="pl-acts">
                        <button type="button" data-pl="stop-edit" data-k="${esc(k)}" aria-label="Bearbeiten">${ic('pencil')}</button>
                        ${drag ? `<button type="button" class="pl-handle" data-drag="stops" data-k="${esc(k)}" aria-label="Verschieben: ${esc(p.name || k)} (Pfeiltasten oder ziehen)" title="Ziehen zum Verschieben">${ic('grip')}</button>` : ''}
                    </div>` : ''}
                    ${next.has(k) ? `<span class="pl-leg" title="Luftlinie · Fahrzeit grob geschätzt">${ic('route')}${kmText(next.get(k))}<i>·</i>${esc(driveText(next.get(k)))}</span>` : ''}
                </li>`).join('')}</ol>
            ${edit ? `<button type="button" class="pl-next" data-pl="stop-add"><span>${ic('plus')}</span>Nächsten Stopp hinzufügen</button>` : ''}
            ${end && L.on ? `<div class="pl-finish"><span>${ic('flag')}</span><div><b>Reiseende</b><small>${esc(fmtY(end))}</small></div></div>` : ''}`
            : `<div class="pl-noroute">${ic('route')}<b>Plane deine Route</b><p>Lege die Orte der Reise in ihrer Reihenfolge an und gib an, wie viele Nächte ihr jeweils bleibt.</p>
                ${edit ? `<button type="button" class="btn-action" data-pl="stop-add">${ic('plus')}Ersten Stopp hinzufügen</button>` : ''}</div>`}`;
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
    async function editPeople() {
        if (!editable()) return;
        let list = persons().map(x => ({ key: x.key, name: x.name, color: x.color }));
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
                        const old = persons().find(o => o.key === key) || {};
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
    function commitPlaces(mutate) {
        const sync = legPlans();
        return commit(['places', ...(sync.length ? [H.planKey] : [])], () => { mutate(); sync.forEach(p => syncPlan(p)); });
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
    function editStop(k) {
        if (!editable()) return;
        const p = k ? places()[k] : null;
        if (k && !p) return;
        const cur = p || { name: '', lat: '', lng: '', num: 1 };
        sheet({
            title: p ? 'Stopp bearbeiten' : 'Neuer Stopp',
            body: `<div class="pl-search">
                    ${field('Ort', inp('name', cur.name, 'required maxlength="120" autocomplete="off" placeholder="z. B. Kyoto"'), 'grow')}
                    <button type="button" class="btn-action pl-find">${ic('search')}Suchen</button>
                </div>
                <ul class="pl-results" hidden></ul>
                <div class="pl-row">
                    ${field('Breite (lat)', inp('lat', cur.lat, 'inputmode="decimal" required'))}
                    ${field('Länge (lng)', inp('lng', cur.lng, 'inputmode="decimal" required'))}
                </div>
                ${field('Zeitraum / Datum (Text)', inp('date', cur.date, 'maxlength="80" placeholder="z. B. 12.–15.04. oder Tag 3–5"'))}
                ${field('Beschreibung', area('desc', cur.desc, 'maxlength="2000"'))}
                ${persons().length ? `<fieldset class="pl-who"><legend>Wer ist dort?</legend>${persons().map(x => `<label class="pl-check"><input type="checkbox" name="who" value="${esc(x.key)}"${!Array.isArray(cur.who) || cur.who.includes(x.key) ? ' checked' : ''}><span><i style="background:${esc(color(x.color, 'var(--p1)'))}"></i>${esc(x.name)}</span></label>`).join('')}</fieldset>` : ''}
                <div class="pl-row">
                    <label class="pl-check"><input type="checkbox" name="numbered"${cur.num != null ? ' checked' : ''}><span>Nummerierter Stopp der Route</span></label>
                </div>
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
                    });
                };
                find.onclick = run;
                f.elements.name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
                const del = f.querySelector('.pl-del');
                if (del) del.onclick = () => { if (confirm(`„${p.name}“ löschen?`)) { dlg.close(); commitPlaces(() => { delete raw().places[k]; renumber(); }); } };
            },
            done: f => {
                const name = val(f, 'name'), lat = parseFloat(val(f, 'lat').replace(',', '.')), lng = parseFloat(val(f, 'lng').replace(',', '.'));
                if (!name) { alert('Bitte einen Ortsnamen eingeben.'); return false; }
                if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { alert('Bitte gültige Koordinaten eintragen (oder über „Suchen“ übernehmen).'); return false; }
                commitPlaces(() => {
                    const P = raw().places = raw().places || {};
                    const key = k || uniqueKey(name, P);
                    const o = P[key] || {};
                    const numbered = f.elements.numbered.checked;
                    Object.assign(o, { name, lat: +lat.toFixed(5), lng: +lng.toFixed(5) });
                    /* Reisende: alle angehakt = kein eigener Eintrag (folgt der Reise) */
                    const who = [...f.querySelectorAll('input[name="who"]')];
                    if (who.length) { const on = who.filter(x => x.checked).map(x => x.value); if (on.length === who.length) delete o.who; else o.who = on; }
                    setOpt(o, 'date', val(f, 'date')); setOpt(o, 'desc', val(f, 'desc'));
                    if (!numbered) delete o.num;
                    else if (o.num == null) o.num = Object.values(P).reduce((m, x) => x.num != null && x !== o ? Math.max(m, +x.num || 0) : m, 0) + 1;
                    P[key] = o;
                    renumber();
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
        const gen = p && !p.rows.length && m.start && m.end && !byLegs;
        return `<div class="pl-toolbar">
            <button type="button" class="btn-action" data-pl="row-add" data-plan="${esc(planId)}">${ic('plus')}Tag hinzufügen</button>
            ${byLegs && p && !p.legs ? `<button type="button" class="btn-action ok" data-pl="days-legs" data-plan="${esc(planId)}">${ic('wand')}Tage aus den Etappen anlegen (${L.total + 1} Tage)</button>` : ''}
            ${byLegs && p && p.legs ? `<span class="note pl-legs-on">${ic('route')}Folgt den Etappen – Nächte bei den Stopps ändern</span>` : ''}
            ${gen ? `<button type="button" class="btn-action ok" data-pl="days-gen" data-plan="${esc(planId)}">${ic('wand')}${dn(m.end) - dn(m.start) + 1} leere Tage anlegen (${fmt(m.start)}–${fmt(m.end)})</button>` : ''}
            ${p && !p.rows.length && !gen ? `<span class="note">Noch keine Tage. Tipp: Mit Start- und Enddatum der Reise lassen sich alle Tage auf einmal anlegen.</span>` : ''}
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
    function editRow(planId, idx) {
        if (!editable()) return;
        let p = planById(planId);
        if (!p && H.newPlan) p = H.newPlan();
        if (!p) return;
        const isNew = idx == null || idx < 0 || idx >= p.rows.length;
        const r = isNew ? {} : p.rows[idx];
        const pl = stopList();
        const foc = new Set(R.focus(r));
        const n = p.rows.length;
        sheet({
            title: isNew ? 'Neuer Tag' : `${r.day || 'Tag'} bearbeiten`,
            body: `<div class="pl-row">
                    ${field('Tag', inp('day', isNew ? `Tag ${n + 1}` : r.day, 'maxlength="40"'))}
                    ${field('Datum', `<input type="date" name="from" value="${esc(R.from(r))}">`)}
                    ${TH() ? '' : field('bis (optional)', `<input type="date" name="to" value="${esc(r.to || '')}">`)}
                </div>
                ${field('Ort & Aktivität', inp('title', R.title(r), 'maxlength="200" placeholder="z. B. Ankunft in Kyoto, Abendspaziergang Gion"'))}
                ${field('Details & Programm', area('details', r.details, 'rows="4" maxlength="5000"'))}
                <div class="pl-row">
                    ${field('Transport', inp('transport', r.transport, 'maxlength="300" placeholder="z. B. Shinkansen 2:15 h"'))}
                    ${field('Unterkunft', inp('hotel', r.hotel, 'maxlength="300" placeholder="Name oder „Noch offen“"'))}
                </div>
                ${pl.length ? `<fieldset class="pl-focus"><legend>${TH() ? 'Ort auf der Karte' : 'Orte auf der Karte'}</legend>${pl.map(({ k, p: x }) =>
                    `<label class="pl-chip"><input type="${TH() ? 'radio' : 'checkbox'}" name="focus" value="${esc(k)}"${foc.has(k) ? ' checked' : ''}><span>${x.num != null ? esc(x.num) + ' · ' : ''}${esc(x.name || k)}</span></label>`).join('')}</fieldset>` : ''}
                <p class="note">Einfache Formatierung in den Details: Zeilenumbrüche bleiben erhalten.</p>`,
            extra: isNew ? '' : `<button type="button" class="btn-action danger pl-del">${ic('trash')}Löschen</button>
                <button type="button" class="btn-action pl-up" aria-label="Nach oben"${idx === 0 ? ' disabled' : ''}>${ic('arrowUp')}</button>
                <button type="button" class="btn-action pl-down" aria-label="Nach unten"${idx === n - 1 ? ' disabled' : ''}>${ic('arrowDown')}</button>`,
            onOpen: f => {
                const del = f.querySelector('.pl-del');
                if (del) del.onclick = () => { if (confirm(`„${r.day || 'Tag'}“ löschen?`)) { dlg.close(); commit([H.planKey], () => p.rows.splice(idx, 1)); } };
                const mv = d => () => { dlg.close(); commit([H.planKey], () => { const [x] = p.rows.splice(idx, 1); p.rows.splice(idx + d, 0, x); }); };
                if (f.querySelector('.pl-up')) { f.querySelector('.pl-up').onclick = mv(-1); f.querySelector('.pl-down').onclick = mv(1); }
            },
            done: f => {
                const from = val(f, 'from'), to = f.elements.to ? val(f, 'to') : '';
                if (to && from && to < from) { alert('„bis“ liegt vor dem Datum.'); return false; }
                const focus = [...f.querySelectorAll('[name=focus]:checked')].map(x => x.value);
                commit([H.planKey], () => {
                    const o = isNew ? { _id: uid() } : r;
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
                    if (isNew) p.rows.push(o);
                });
            }
        });
    }
    /* Für „In Ablauf übernehmen“ (shared/activities.js): alle Tage als Auswahl */
    function dayOptions() {
        const out = [];
        plansOf().forEach(p => {
            ensureIds(p.rows);
            p.rows.forEach(r => out.push({ ref: `${p.id}:${r._id}`, label: [p.title && plansOf().length > 1 ? p.title.replace(/^(Möglicher Ablauf|Tagesplan) /, '') : '', r.day, fmt(R.from(r)) || r.date, R.title(r)].filter(Boolean).join(' · ') }));
        });
        return out;
    }
    function dayLabel(ref) {
        const [pid, rid] = String(ref || '').split(':');
        const p = planById(pid), r = p && p.rows.find(x => x._id === rid);
        return r ? [r.day, fmt(R.from(r)) || r.date].filter(Boolean).join(' · ') : '';
    }
    async function addToDay(ref, text) {
        const [pid, rid] = String(ref || '').split(':');
        const p = planById(pid), r = p && p.rows.find(x => x._id === rid);
        if (!r || !editable()) return false;
        return commit([H.planKey], () => {
            if (TH()) r.details = (r.details ? r.details + '\n' : '') + '• ' + text;
            else { r.extra = (r.extra || []).filter(x => x !== text); r.extra.push(text); }
        });
    }

    /* ---------- Unterkünfte ---------- */
    /* Unterkunft ↔ Etappe: über place (Vorlage), focus (Thailand) oder gleichen Ortsnamen */
    const stayKey = s => s.place || (s.focus && placeKeyByName(s.focus)) || placeKeyByName(s.name ?? s.title ?? '');
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
    function renderAcc(pane) {
        if (!pane) return;
        const gs = groups(), all = allStations(), edit = canEdit();
        const booked = all.filter(s => S.status(s) === 'booked').length, open = all.filter(s => S.status(s) === 'open').length;
        const nights = all.reduce((n, s) => n + S.nights(s), 0);
        const warn = warnings(), gp = gaps();
        const q = accFilter.q.toLowerCase();
        const match = s => (accFilter.st === 'all' || S.status(s) === accFilter.st)
            && (!q || [S.name(s), s.hotel, s.address, s.code, s.note, S.transfer(s).text].join(' ').toLowerCase().includes(q));
        const today = H.today;
        /* Ziehen zum Sortieren nur ohne Filter (sonst stimmt die Reihenfolge nicht mit der Liste überein) */
        const sortable = accFilter.st === 'all' && !q;
        const row = (s, g, i) => {
            const st = S.status(s), c = cancelInfo(s), t = S.transfer(s), n = S.nights(s), cin = S.cin(s), cout = S.cout(s);
            const now = ISO.test(cin) && ISO.test(cout) && today >= cin && today < cout;
            const period = ISO.test(cin) ? `${fmt(cin)} – ${fmt(cout) || '?'}` : rich(s.period || '');
            const statusTag = `<span class="pl-st ${STATUS[st][1]}">${esc(s.statusText && !s._edited ? stripTags(s.statusText) : STATUS[st][0])}</span>`;
            const cancel = c ? `<span class="pl-cancel ${c.warn ? 'warn' : ''}${c.days < 0 ? ' late' : ''}">${ic(c.warn ? 'alert' : 'hourglass')}${esc(c.text)}</span>` : '';
            const maps = mapsHref(s);
            const legacy = (s.bookings || []).map(b => `<div class="pl-legacy">${b.name ? `<b>${rich(b.name)}</b> ` : ''}${[b.room, b.by, b.cancel].filter(Boolean).map(rich).join(' · ')}</div>`).join('');
            const acts = edit ? `<div class="pl-acts">
                    <button type="button" data-pl="acc-edit" data-g="${esc(g.id)}" data-i="${i}" aria-label="Bearbeiten">${ic('pencil')}</button>
                    ${sortable && g.list.length > 1 ? `<button type="button" class="pl-handle" data-drag="acc" data-g="${esc(g.id)}" data-i="${i}" aria-label="Verschieben: ${esc(S.name(s))} (Pfeiltasten oder ziehen)" title="Ziehen zum Verschieben">${ic('grip')}</button>` : ''}</div>` : '';
            const details = `${s.address ? `<div class="pl-addr"><span>${ic('pin')}<span lang="">${esc(s.address)}</span></span>${copyBtn(s.address, 'Adresse kopieren')}</div>` : ''}
                ${maps ? `<a class="pl-link" href="${esc(maps)}" target="_blank" rel="noopener">${ic('map')}Google Maps ↗</a>` : ''}
                ${t.time || t.text ? `<div class="pl-transfer">${t.time ? `<span class="travel-time-pill">${esc(t.time)}</span>` : ''}${rich(t.text)}</div>` : ''}
                ${s.note ? `<div class="pl-note">${rich(s.note)}</div>` : ''}${legacy}`;
            return {
                tr: `<tr class="${now ? 'acc-now' : ''}${st === 'open' ? ' is-open' : ''}" data-g="${esc(g.id)}" data-i="${i}" data-sort="acc:${esc(g.id)}">
                    <td><strong>${esc(S.name(s))}</strong>${now ? `<span class="now-badge">${ic('pin')}Heute hier</span>` : ''}</td>
                    <td class="pl-nowrap">${period}${n ? `<div><span class="stay-badge">${n} ${n === 1 ? 'Nacht' : 'Nächte'}</span></div>` : ''}</td>
                    <td><div class="pl-hotel">${rich(s.hotel || '')}</div>${statusTag}${cancel ? `<div>${cancel}</div>` : ''}</td>
                    <td>${s.code ? `<span class="pl-code"><code>${esc(s.code)}</code>${copyBtn(s.code, 'Buchungscode kopieren')}</span>` : ''}${money(s.price, s.currency) ? `<div class="pl-price">${esc(money(s.price, s.currency))}</div>` : ''}</td>
                    <td class="pl-more">${details}</td>
                    ${edit ? `<td>${acts}</td>` : ''}
                </tr>`,
                card: `<article class="pl-card${now ? ' acc-now' : ''}${st === 'open' ? ' is-open' : ''}" data-g="${esc(g.id)}" data-i="${i}" data-sort="acc:${esc(g.id)}">
                    <div class="pl-card-top">
                        <div><b>${esc(S.name(s))}</b><small>${period}${n ? ` · ${n} ${n === 1 ? 'Nacht' : 'Nächte'}` : ''}</small></div>
                        ${statusTag}
                    </div>
                    ${s.hotel ? `<div class="pl-hotel">${rich(s.hotel)}</div>` : ''}
                    ${cancel}
                    ${s.code ? `<div class="pl-code"><span>Buchung</span><code>${esc(s.code)}</code>${copyBtn(s.code, 'Buchungscode kopieren')}</div>` : ''}
                    ${details.trim() || money(s.price, s.currency) ? `<details><summary>Details</summary>${money(s.price, s.currency) ? `<div class="pl-price">${esc(money(s.price, s.currency))}</div>` : ''}${details}</details>` : ''}
                    ${edit ? acts : ''}
                </article>`
            };
        };
        /* Etappen mit Nächten ohne Unterkunft: als offene Platzhalter */
        const have = new Set(all.map(stayKey).filter(Boolean));
        const missing = legs().list.filter(x => x.n > 0 && !have.has(x.k));
        const ph = (x, g) => ({
            tr: `<tr class="is-open pl-ph"><td><strong>${esc(x.p.name || x.k)}</strong></td><td class="pl-nowrap">${esc(legShort(x))}<div><span class="stay-badge">${x.n} ${nightsWord(x.n)}</span></div></td>
                <td colspan="${edit ? 4 : 3}"><span class="pl-st warn">Unterkunft fehlt</span>${edit ? ` <button type="button" class="btn-action pl-ph-add" data-pl="acc-leg" data-g="${esc(g.id)}" data-k="${esc(x.k)}">${ic('plus')}Eintragen</button>` : ''}</td></tr>`,
            card: `<article class="pl-card is-open pl-ph"><div class="pl-card-top"><div><b>${esc(x.p.name || x.k)}</b><small>${esc(legShort(x))} · ${x.n} ${nightsWord(x.n)}</small></div><span class="pl-st warn">Unterkunft fehlt</span></div>
                ${edit ? `<button type="button" class="btn-action pl-ph-add" data-pl="acc-leg" data-g="${esc(g.id)}" data-k="${esc(x.k)}">${ic('plus')}Unterkunft eintragen</button>` : ''}</article>`
        });
        const blocks = gs.map((g, gi) => {
            const items = g.list.map((s, i) => ({ s, i })).filter(x => match(x.s)).map(x => row(x.s, g, x.i));
            if (gi === 0 && accFilter.st !== 'booked' && !q) {
                /* Platzhalter nach Ankunft einsortieren */
                missing.forEach(x => {
                    const at = items.findIndex(it => { const s = g.list[+(/data-i="(\d+)"/.exec(it.tr) || [])[1]]; return s && ISO.test(S.cin(s)) && x.from && S.cin(s) > x.from; });
                    items.splice(at < 0 ? items.length : at, 0, ph(x, g));
                });
            }
            return `${gs.length > 1 || g.label ? `<h3 class="pl-group">${esc(g.label || '')}</h3>` : ''}
                ${items.length ? `<div class="tw pl-table"><table>
                    <thead><tr><th>Station</th><th>Zeitraum</th><th>Unterkunft &amp; Status</th><th>Buchung</th><th>Adresse &amp; Transfer</th>${edit ? '<th></th>' : ''}</tr></thead>
                    <tbody>${items.map(x => x.tr).join('')}</tbody></table></div>
                <div class="pl-cards">${items.map(x => x.card).join('')}</div>`
                : `<p class="note">${g.list.length ? 'Keine Treffer.' : 'Noch keine Unterkünfte eingetragen.'}</p>`}
                ${edit ? `<button type="button" class="btn-action pl-add" data-pl="acc-add" data-g="${esc(g.id)}">${ic('plus')}Unterkunft${gs.length > 1 && g.label ? ' · ' + esc(g.label) : ''}</button>` : ''}`;
        }).join('');
        pane.innerHTML = `<div class="box">
            <div class="mh"><h2>${ic('bed')}Unterkünfte</h2>
                <span class="pl-sum"><span class="pl-st ok">${booked} gebucht</span>${open ? `<span class="pl-st warn">${open} offen</span>` : ''}${nights ? `<span class="pl-st mute">${nights} Nächte</span>` : ''}</span></div>
            ${warn.length ? `<div class="tb-banner pl-warn">${ic('alert')}<span><b>Storno-Fristen-Wächter:</b> ${warn.map(w => `${esc(w.name)} – ${esc(w.text)}`).join(' · ')}</span></div>` : ''}
            ${gp.length ? `<div class="tb-banner pl-gap">${ic('bed')}<span><b>Nächte ohne Unterkunft:</b> ${gp.map(x => `${fmt(x.from)}–${fmt(x.to)} (${x.nights} ${x.nights === 1 ? 'Nacht' : 'Nächte'})`).join(' · ')}</span></div>` : ''}
            ${all.length > 2 ? `<div class="controls pl-filter">
                <input type="search" class="q-input" data-pl-q placeholder="Unterkunft, Adresse oder Buchungscode suchen …" value="${esc(accFilter.q)}">
                ${[['all', 'Alle'], ['booked', 'Gebucht'], ['open', 'Offen']].map(([k, l]) => `<button type="button" class="f${accFilter.st === k ? ' on' : ''}" data-pl="acc-filter" data-st="${k}">${l}</button>`).join('')}
            </div>` : ''}
            ${blocks || (edit ? `<p class="note">Noch keine Unterkünfte.</p><button type="button" class="btn-action pl-add" data-pl="acc-add" data-g="">${ic('plus')}Unterkunft</button>` : '<p class="note">Noch keine Unterkünfte.</p>')}
        </div>`;
        const qi = pane.querySelector('[data-pl-q]');
        if (qi) qi.oninput = () => { accFilter.q = qi.value; const pos = qi.selectionStart; renderAcc(pane); const n = pane.querySelector('[data-pl-q]'); n.focus(); n.setSelectionRange(pos, pos); };
        pane.querySelectorAll('tbody tr[data-i]').forEach(tr => tr.onclick = e => {
            if (e.target.closest('a, button, summary')) return;
            const s = (gs.find(g => g.id === tr.dataset.g) || { list: [] }).list[+tr.dataset.i];
            const k = s && (s.place || (s.focus && placeKeyByName(s.focus)) || placeKeyByName(S.name(s)));
            if (k && H.focusPlace) H.focusPlace(k);
        });
    }
    const stripTags = s => String(s || '').replace(/<[^>]*>/g, '');
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
        const last = g.list[g.list.length - 1];
        const defIn = isNew ? (last && S.cout(last)) || (H.meta() || {}).start || '' : S.cin(s);
        sheet({
            title: isNew ? 'Neue Unterkunft' : 'Unterkunft bearbeiten',
            body: `${field('Station / Ort', inp('name', S.name(s), 'required maxlength="120" list="plPlaces" placeholder="z. B. Kyoto"'))}
                <datalist id="plPlaces">${pl.map(({ p }) => `<option value="${esc(p.name)}">`).join('')}</datalist>
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
                ${field('Adresse in Landessprache (für Taxi/Navigation)', area('address', s.address, 'rows="2" maxlength="400" lang=""'))}
                ${field('Google-Maps-Link oder Suchbegriff', inp('maps', s.maps, 'maxlength="500" placeholder="https://maps.app.goo.gl/… oder Hotelname, Ort"'))}
                <div class="pl-row">
                    ${field('Transferzeit', inp('ttime', t.time, 'maxlength="40" placeholder="z. B. 2:30 h"'))}
                    ${field('Transfer-Notiz / Weiterreise', inp('ttext', stripTags(t.text), 'maxlength="300"'))}
                </div>
                ${field('Notiz', area('note', s.note, 'rows="2" maxlength="2000"'))}`,
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
                    setOpt(o, 'address', val(f, 'address')); setOpt(o, 'maps', val(f, 'maps')); setOpt(o, 'note', val(f, 'note'));
                    const tt = val(f, 'ttime'), tx = val(f, 'ttext');
                    if (tt || tx || typeof o.transfer === 'object') o.transfer = { time: tt, text: tx }; else delete o.transfer;
                    const pk = (s.place && S.name(s) === name && s.place) || placeKeyByName(name);
                    if (pk && !TH()) o.place = pk; else if (!TH()) delete o.place;
                    if (TH() && isNew) { o.focus = pk ? places()[pk].name : name; if (!o.transfer) o.transfer = { time: '', text: '' }; if (!o.hotel) o.hotel = ''; }
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
            + (edit ? `<div class="pl-toolbar"><button type="button" class="btn-action" data-pl="tr-add">${ic('plus')}Transport hinzufügen</button>${all.length > 1 ? `<button type="button" class="btn-action" data-pl="tr-sort">${ic('calendar')}Nach Datum sortieren</button>` : ''}</div>` : '');
        const qi = bar.querySelector('[data-pl-tq]');
        if (qi) qi.oninput = () => { trFilter.q = qi.value; const pos = qi.selectionStart; renderTransports(listEl); const n = listEl.previousElementSibling.querySelector('[data-pl-tq]'); n.focus(); n.setSelectionRange(pos, pos); };
        const sortable = trFilter.mode === 'all' && !q && all.length > 1;
        const acts = i => edit ? `<div class="pl-acts pl-tr-acts">
                <button type="button" data-pl="tr-edit" data-i="${i}" aria-label="Bearbeiten">${ic('pencil')}</button>
                ${sortable ? `<button type="button" class="pl-handle" data-drag="tr" data-i="${i}" aria-label="Verschieben (Pfeiltasten oder ziehen)" title="Ziehen zum Verschieben">${ic('grip')}</button>` : ''}</div>` : '';
        listEl.innerHTML = shown.map(({ f, i }) => {
            const li = fc && fc.isCard(f) ? fc.card(f) : `<li>
                    <div class="fl-date">${esc(f.date)}</div>
                    <div class="fl-route">${rich(f.route)}</div>
                    ${f.duration ? `<div class="fl-dur">${ic('clock')}${esc(f.duration)}</div>` : ''}
                    ${f.details ? `<div class="fl-details">${rich(f.details)}${url(f.status) ? ` (<a href="${esc(url(f.status))}" target="_blank" rel="noopener" class="fl-link">Status prüfen ↗</a>)` : ''}</div>` : ''}
                    ${f.price ? `<div class="fl-price">${rich(f.price)}</div>` : ''}
                </li>`;
            return edit ? li.replace(/^\s*<li/, `<li data-sort="tr" data-i="${i}"`).replace(/<\/li>\s*$/, acts(i) + '</li>') : li;
        }).join('') || `<li class="pl-empty"><p class="note">${all.length ? 'Keine Treffer.' : 'Noch keine Flüge oder Transporte eingetragen.'}</p></li>`;
    }
    function editTransport(idx) {
        if (!editable()) return;
        const isNew = idx == null || idx < 0;
        const f0 = isNew ? { mode: 'flight', from: {}, to: {} } : flights()[idx];
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
                ${field('Mitreisende – mit Komma getrennt', inp('who', (Array.isArray(f.who) ? f.who : []).join(', '), 'maxlength="200"'))}
                ${field('Notiz', area('note', f.note, 'rows="2" maxlength="1000"'))}`,
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
                    const nos = list(val(fm, 'nos')), who = list(val(fm, 'who'));
                    if (nos.length) o.flightNos = nos; else delete o.flightNos;
                    if (who.length) o.who = who; else delete o.who;
                    if (val(fm, 'planned') === '1') o.planned = true; else delete o.planned;
                    const F = raw().flights = raw().flights || [];
                    if (isNew) F.push(o); else if (legacy) F[idx] = o;
                });
            }
        });
    }
    function sortTransports() {
        if (!editable()) return;
        const key = f => f.from && f.from.date ? f.from.date + 'T' + (f.from.time || '00:00') : '9999';
        commit(['flights'], () => { raw().flights = flights().map((f, i) => ({ f, i })).sort((a, b) => key(a.f).localeCompare(key(b.f)) || a.i - b.i).map(x => x.f); });
    }

    /* ---------- Klicks (Delegation) ---------- */
    document.addEventListener('click', async e => {
        const cp = e.target.closest('.pl-copy');
        if (cp) { e.preventDefault(); e.stopPropagation(); if (await TB.copyText(cp.dataset.copy)) status('copied'); return; }
        const b = e.target.closest('[data-pl]');
        if (!b || !H) return;
        const a = b.dataset.pl, i = b.dataset.i != null ? +b.dataset.i : null;
        if (a !== 'stop-focus' && a !== 'acc-filter' && a !== 'tr-filter') { e.preventDefault(); e.stopPropagation(); }
        switch (a) {
            case 'stop-add': return editStop(null);
            case 'people': return editPeople();
            case 'stop-edit': return editStop(b.dataset.k);
            case 'stop-focus': return H.focusPlace && H.focusPlace(b.dataset.k);
            case 'row-add': return editRow(b.dataset.plan, null);
            case 'row-edit': return editRow(b.dataset.plan, i);
            case 'days-gen': return generateDays(b.dataset.plan);
            case 'days-legs': return planFromLegs(b.dataset.plan);
            case 'n-inc': return stepNights(b.dataset.k, 1);
            case 'n-dec': return stepNights(b.dataset.k, -1);
            case 'acc-leg': return editStation(b.dataset.g, null, b.dataset.k);
            case 'acc-add': return editStation(b.dataset.g, null);
            case 'acc-edit': return editStation(b.dataset.g, i);
            case 'acc-filter': accFilter.st = b.dataset.st; return renderAcc(b.closest('.pane'));
            case 'tr-add': return editTransport(null);
            case 'tr-edit': return editTransport(i);
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

    function init(host) { H = host; window.TBPlanner.ready = true; }

    window.TBPlanner = {
        init, ready: false, canEdit, editable,
        stopList, routeStops, totalKm, kmText, renderStops, mountStops,
        planToolbar, rowEditBtn, editRow, dayOptions, dayLabel, addToDay,
        renderAcc, warnings, gaps, cancelInfo,
        legs, legText,
        renderTransports,
        stationStats: () => { const a = allStations(); return { total: a.length, booked: a.filter(s => S.status(s) === 'booked').length, open: a.filter(s => S.status(s) === 'open').length }; }
    };
})();
