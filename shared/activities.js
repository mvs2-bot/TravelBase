/* TravelBase – Mögliche Aktivitäten pro Ort (Supabase-Tabelle travelbase_activities)
   - Unterseite #activities: eine Card pro Ort in Routen-Reihenfolge, Orte mehrfach in der Route nur einmal
   - Modal (aus der Route am Handy): dieselben Aktivitäten eines Orts
   - Verknüpfung über trip_id + location_name, damit doppelte Routen-Stopps (z. B. 2× Antigua) dieselben Aktivitäten teilen
   Seite und Modal zeichnen aus derselben Liste, Änderungen erscheinen sofort in beiden.
   Aufruf: TBActivities.init({ tripId, slug, stops: [{ num, name, color }] }), danach TBActivities.open(name, num, punktElement). */
(function () {
    'use strict';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = n => window.tbIcon ? tbIcon(n) : '';
    const FIELDS = 'id, location_name, title, description, duration, cost_info, sort_order';
    let tripId = null, cacheKey = '', places = [], list = [], online = false, editing = null, modal = null;

    const q = async p => { const { data, error } = await p; if (error) throw error; return data; };
    const forLoc = name => list.filter(a => a.location_name === name);

    async function load() {
        try {
            list = await q(TB.sb.from('travelbase_activities').select(FIELDS).eq('trip_id', tripId).order('sort_order').order('created_at'));
            TB.cacheSet(cacheKey, list);
            online = true;
        } catch (e) {
            list = TB.cacheGet(cacheKey) || [];
            online = false;
            if (!TB.isNetErr(e)) console.error('Aktivitäten laden', e);
        }
        renderAll();
    }
    function editable() {
        if (online && navigator.onLine) return true;
        alert('📴 Offline – Aktivitäten können gerade nicht bearbeitet werden. Bitte später erneut versuchen.');
        return false;
    }
    async function write(fn) {
        try { await fn(); TB.cacheSet(cacheKey, list); renderAll(); }
        catch (e) { alert('⚠️ Speichern fehlgeschlagen: ' + TB.errorText(e)); await load(); }
    }

    /* Inhalt eines Orts: Liste + Formular (neu oder bearbeiten); gleiche Optik wie die To-Do-Liste */
    function body(name) {
        const items = forLoc(name);
        const form = a => `<form class="pack-add-form act-form" data-id="${a ? esc(a.id) : ''}">
                <input type="text" name="title" placeholder="Aktivität *" required maxlength="200" value="${esc(a && a.title)}">
                <input type="text" name="duration" placeholder="Dauer (optional)" maxlength="80" value="${esc(a && a.duration)}">
                <input type="text" name="cost_info" placeholder="Kosten (optional)" maxlength="80" value="${esc(a && a.cost_info)}">
                <textarea name="description" rows="2" placeholder="Notiz (optional)" maxlength="2000">${esc(a && a.description)}</textarea>
                <button class="f on" type="submit">${ic('check')}Speichern</button>
                <button class="f" type="button" data-act="cancel">Abbrechen</button>
            </form>`;
        const row = a => editing && editing.id === a.id ? `<li class="act-edit">${form(a)}</li>` : `
            <li class="todo-item act-item">
                <div class="act-main">
                    <b>${esc(a.title)}</b>
                    ${a.duration || a.cost_info ? `<div class="act-meta">${a.duration ? `<span class="pill">${ic('clock')}${esc(a.duration)}</span>` : ''}${a.cost_info ? `<span class="pill">${esc(a.cost_info)}</span>` : ''}</div>` : ''}
                    ${a.description ? `<p>${esc(a.description)}</p>` : ''}
                </div>
                <button type="button" data-act="edit" data-id="${esc(a.id)}" aria-label="Bearbeiten" title="Bearbeiten">${ic('pencil')}</button>
                <button type="button" data-act="del" data-id="${esc(a.id)}" aria-label="Löschen" title="Löschen">${ic('trash')}</button>
            </li>`;
        const adding = editing && editing.loc === name && !editing.id;
        return (items.length ? `<ul class="todo-list act-list">${items.map(row).join('')}</ul>` : (adding ? '' : '<p class="note act-empty">Noch keine Aktivitäten gespeichert.</p>'))
            + (adding ? form(null) : `<button class="btn-action act-add" type="button" data-act="add">${ic('plus')}Aktivität hinzufügen</button>`);
    }
    const head = p => `<span class="act-num" style="--c:${esc(p.color || 'var(--p1)')}">${esc(p.num ?? '')}</span>${esc(p.name)}`;

    function renderAll() {
        const pane = document.getElementById('activities');
        if (pane) pane.innerHTML = `<div class="box">
                <h2>${ic('sparkles')}Mögliche Aktivitäten</h2>
                <p class="note">Ideen pro Ort für alle Mitreisenden. Orte, die mehrfach in der Route vorkommen, teilen sich ihre Aktivitäten.</p>
                ${online ? '' : `<div class="tb-banner">${ic('wifiOff')}<span>Offline – du siehst den letzten Stand. Bearbeiten ist erst wieder mit Internet möglich.</span></div>`}
            </div>` + places.map(p => `<div class="box act-card">
                <div class="mh"><h2>${head(p)}</h2><small class="act-count">${forLoc(p.name).length || ''}</small></div>
                <div data-loc="${esc(p.name)}">${body(p.name)}</div>
            </div>`).join('');
        if (modal && modal.classList.contains('open')) {
            const box = modal.querySelector('[data-loc]');
            box.innerHTML = body(box.dataset.loc);
        }
        if (window.TBTripMobile && TBTripMobile.setTile) TBTripMobile.setTile('activities', { text: `${list.length} ${list.length === 1 ? 'Aktivität' : 'Aktivitäten'}` });
    }

    /* Klicks und Formulare überall (Seite + Modal) über Delegation */
    function onClick(e) {
        const b = e.target.closest('[data-act]'), box = e.target.closest('[data-loc]');
        if (!b || !box) return;
        const loc = box.dataset.loc, act = b.dataset.act, a = list.find(x => x.id === b.dataset.id);
        if (act === 'cancel') { editing = null; renderAll(); return; }
        if (!editable()) return;
        if (act === 'add') { editing = { loc }; renderAll(); focusForm(box); }
        else if (act === 'edit' && a) { editing = { loc, id: a.id }; renderAll(); focusForm(box); }
        else if (act === 'del' && a && confirm(`„${a.title}“ löschen?`)) {
            list = list.filter(x => x !== a);
            write(() => q(TB.sb.from('travelbase_activities').delete().eq('id', a.id)));
        }
    }
    /* Seite und Modal zeigen das Formular beide; Fokus dorthin, wo geklickt wurde */
    function focusForm(box) {
        const scope = modal && modal.contains(box) ? modal : document.getElementById('activities');
        const i = scope && scope.querySelector(`[data-loc="${CSS.escape(box.dataset.loc)}"] .act-form input`);
        if (i) i.focus();
    }
    function onSubmit(e) {
        const f = e.target.closest('.act-form');
        if (!f) return;
        e.preventDefault();
        if (!editable()) return;
        const loc = f.closest('[data-loc]').dataset.loc, val = n => f.elements[n].value.trim() || null;
        const fields = { title: val('title'), description: val('description'), duration: val('duration'), cost_info: val('cost_info') };
        if (!fields.title) return alert('Bitte einen Titel eingeben!');
        const id = f.dataset.id;
        editing = null;
        if (id) {
            const a = list.find(x => x.id === id);
            Object.assign(a, fields);
            write(() => q(TB.sb.from('travelbase_activities').update(fields).eq('id', id)));
        } else {
            const sort_order = forLoc(loc).reduce((m, x) => Math.max(m, x.sort_order || 0), -1) + 1;
            write(async () => list.push(await q(TB.sb.from('travelbase_activities').insert({ trip_id: tripId, location_name: loc, sort_order, ...fields }).select(FIELDS).single())));
        }
    }

    /* Expanding Modal: wächst aus dem angetippten Routen-Punkt heraus und fällt beim Schließen dorthin zurück.
       Derselbe Punkt sitzt im Modal immer auf gleicher Höhe direkt unter der Kopfleiste, in der Spalte der Routen-Punkte,
       und schließt es wieder (ebenso ESC und Klick daneben). Ohne Ursprungs-Punkt öffnet es mittig. */
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    let origin = null, from0 = null, closing = false;
    function open(name, num, from) {
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'act-modal';
            modal.innerHTML = `<div class="act-panel" role="dialog" aria-modal="true" aria-labelledby="actModalTitle">
                <div class="act-head"><button type="button" class="act-dot" aria-label="Schließen"></button><h2 id="actModalTitle"></h2></div>
                <div data-loc=""></div></div>`;
            modal.onclick = e => { if (e.target === modal || e.target.closest('.act-dot')) close(); };
            /* seitlich wischen (links oder rechts) schließt; senkrechtes Scrollen in der Liste bleibt unberührt */
            let t0 = null;
            modal.addEventListener('touchstart', e => { const t = e.touches[0]; t0 = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
            modal.addEventListener('touchend', e => {
                const t = e.changedTouches[0];
                if (t0 && Math.abs(t.clientX - t0.x) > 70 && Math.abs(t.clientX - t0.x) > 2 * Math.abs(t.clientY - t0.y)) close();
                t0 = null;
            }, { passive: true });
            document.body.appendChild(modal);
        }
        const p = places.find(x => x.name === name) || { name, num };
        const panel = modal.querySelector('.act-panel'), dot = modal.querySelector('.act-dot');
        dot.textContent = num ?? '';
        dot.style.setProperty('--c', p.color || 'var(--p1)');
        modal.querySelector('h2').textContent = name;
        modal.querySelector('[data-loc]').dataset.loc = p.name;
        editing = null;
        origin = from || null;
        panel.removeAttribute('style');
        from0 = null;
        if (origin) {
            const r = origin.getBoundingClientRect(), hd = document.querySelector('.sticky-header');
            from0 = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            panel.style.top = ((hd ? hd.getBoundingClientRect().bottom : 0) + 8) + 'px';
            panel.style.setProperty('--dx', (r.left - 8) + 'px');
        }
        modal.classList.add('open');
        renderAll();
        animate(false);
        dot.focus({ preventScroll: true });
    }
    /* Kreis um den Punkt öffnet sich bzw. schließt sich wieder */
    function animate(back) {
        const panel = modal.querySelector('.act-panel'), dot = modal.querySelector('.act-dot');
        const pr = panel.getBoundingClientRect(), dr = dot.getBoundingClientRect();
        /* Kreis-Mitte: angetippter Routen-Punkt, sonst der Punkt im Modal */
        const c = from0 || { x: dr.left + dr.width / 2, y: dr.top + dr.height / 2 }, cx = c.x - pr.left, cy = c.y - pr.top;
        const R = Math.hypot(Math.max(cx, pr.width - cx), Math.max(cy, pr.height - cy));
        const frames = [{ clipPath: `circle(${dr.width / 2}px at ${cx}px ${cy}px)` }, { clipPath: `circle(${R}px at ${cx}px ${cy}px)` }];
        const opt = { duration: reduced() ? 0 : back ? 260 : 380, easing: back ? 'cubic-bezier(.4,0,1,1)' : 'cubic-bezier(.2,.8,.2,1)', fill: 'both' };
        modal.animate([{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,.32)' }], { ...opt, direction: back ? 'reverse' : 'normal' });
        return panel.animate(back ? frames.reverse() : frames, opt).finished;
    }
    async function close() {
        if (!modal || !modal.classList.contains('open') || closing) return;
        closing = true;
        try { await animate(true); } catch (e) {}
        modal.classList.remove('open');
        modal.getAnimations({ subtree: true }).forEach(x => x.cancel());
        closing = false;
        editing = null;
        renderAll();
        /* Route wurde inzwischen neu gezeichnet: den Punkt desselben Orts wieder fokussieren */
        const back = origin && document.querySelector(`#tripRoute .m-num[data-num="${CSS.escape(origin.dataset.num || '')}"][data-loc="${CSS.escape(origin.dataset.loc || '')}"]`);
        if (back) back.focus({ preventScroll: true });
    }

    function init(o) {
        if (tripId || !o || !o.tripId || !window.TB || !TB.sb) return;
        tripId = o.tripId;
        cacheKey = `lists_${o.slug}_activities`;
        const seen = new Set();
        places = (o.stops || []).filter(s => s.name && !seen.has(s.name) && seen.add(s.name));
        document.addEventListener('click', onClick);
        document.addEventListener('submit', onSubmit);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal && modal.classList.contains('open')) { e.stopPropagation(); close(); } }, true);
        /* Zurück-Geste/-Taste (Android, Browser) schließt das Modal mit */
        window.addEventListener('popstate', () => close());
        window.TBActivities.ready = true;
        renderAll();
        load();
    }

    window.TBActivities = { init, open, close, ready: false };
})();
