/* TravelBase – Reise-Seite am Handy (< 768 px)
   - Start ist eine Übersicht der Reise wie in den iPhone-Einstellungen: oben Status und „Heute“,
     darunter gruppierte Listen (Reise · Organisation · Infos) mit der wichtigsten Zahl rechts
   - jede Zeile öffnet den Bereich wie bisher; „Route“ öffnet den Zeitstrahl der Stationen,
     dort öffnet die Nummer eines Orts seine möglichen Aktivitäten (shared/activities.js)
   - oben links führt „‹“ einen Schritt zurück (Bereich → Übersicht der Reise → Alle Reisen), ebenso Wischgeste/App-Leiste
   - unten eine schwebende Leiste: Start (diese Übersicht) · Karte · Route · Infos; aktive Seite als Pille.
     Bereiche, die man von Start aus öffnet, zählen zu „Start“
   Am Desktop ändert sich nichts (alles hängt an der Media Query in trip.css).
   Funktioniert mit jeder Reise-Seite, die .pop-btn[data-t] und .pane hat (Vorlage und Thailand).
   „Heute“, Route und Zahlen liefert die Seite über TBTripMobile.setData()/setTile(). */
(function () {
    'use strict';
    const mq = matchMedia('(max-width: 767.98px)');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = n => window.tbIcon ? tbIcon(n) : '';
    const KEY = 'travelbase-trip-view:' + location.pathname;
    let data = {}, home = null, routeView = null, bar = null;
    const TABS = [['home', 'Start', 'home'], ['mapview', 'Karte', 'map'], ['route', 'Route', 'pin'], ['misc', 'Infos', 'info']];

    /* Gruppen und Farben der Zeilen; unbekannte Bereiche (z. B. Tagespläne) landen bei „Reise“ */
    const GROUP = { mapview: 'trip', acc: 'trip', activities: 'trip', route: 'trip', flights: 'org', cal: 'org', todos: 'org', pack: 'org', climate: 'info', misc: 'info' };
    const COLOR = { mapview: '#15803d', route: '#0e7490', acc: '#b45309', activities: '#ff9500', flights: '#e11d48', cal: '#d97706', todos: '#248a3d', pack: '#5856d6', climate: '#0284c7', misc: '#8a5a00' };
    const PLAN_COLORS = ['#1f6fb2', '#7c3aed', '#0d9488', '#be185d'];

    /* Offene Ansicht pro Reise merken: Neuladen bleibt dort, ein neuer Aufruf startet auf der Übersicht */
    const stored = () => { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } };
    const store = v => { try { sessionStorage.setItem(KEY, v); } catch (e) {} };

    function setHome(on) {
        document.body.classList.toggle('m-home', on);
        if (on) document.body.classList.remove('m-route');
        store(on ? 'home' : (location.hash.slice(1) || 'section'));
        if (on) { render(); window.scrollTo(0, 0); }
        mark(on ? 'home' : null);
    }
    /* aktive Seite in der Leiste: Karte/Route/Infos oder sonst Start */
    let current = 'home';
    function mark(id) {
        if (id) current = id;
        if (!bar) return;
        const t = TABS.some(x => x[0] === current) ? current : 'home';
        bar.querySelectorAll('[data-tab]').forEach(b => b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
    }
    function open(id, viaBar) {
        /* Wechsel per Leiste zwischen Bereichen ersetzt den Verlaufseintrag, damit Zurück direkt zu Start führt */
        const replace = viaBar && !document.body.classList.contains('m-home') && history.state && history.state.tbView;
        if (id === 'route') {
            document.body.classList.remove('m-home');
            document.body.classList.add('m-route');
            store('route');
            window.scrollTo(0, 0);
        } else {
            const b = document.querySelector(`.pop-btn[data-t="${CSS.escape(id)}"]`);
            if (!b) return;
            b.click();
            document.body.classList.remove('m-route');
            setHome(false);
            store(id);
            window.scrollTo(0, 0);
        }
        current = id; mark();
        /* eigener Verlaufseintrag: Zurück (Knopf, Wischgeste, App-Leiste) führt einen Schritt zurück zur Übersicht der Reise */
        if (mq.matches) history[replace ? 'replaceState' : 'pushState']({ tbView: id }, '', location.pathname + location.search + (id === 'route' ? location.hash : '#' + id));
    }
    function tab(id) {
        if (id === 'home') { if (document.body.classList.contains('m-home')) window.scrollTo({ top: 0, behavior: 'smooth' }); else stepBack(); return; }
        if (id === current && !document.body.classList.contains('m-home')) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
        open(id, true);
    }
    /* einen Schritt zurück: Bereich → Übersicht der Reise → Alle Reisen */
    function stepBack() {
        if (document.body.classList.contains('m-home') || !mq.matches) {
            /* kam man von der Übersicht, dorthin zurück (statt einen neuen Eintrag anzulegen) */
            let fromOverview = false;
            try { fromOverview = new URL(document.referrer).pathname === new URL('../', location.href).pathname; } catch (e) {}
            if (fromOverview && history.length > 1) history.back(); else location.href = '../';
            return;
        }
        if (history.state && history.state.tbView) history.back();
        else setHome(true);
    }

    function rowsFor() {
        const btns = [...document.querySelectorAll('.pop-btn[data-t]')];
        const items = [];
        let plan = 0;
        btns.forEach(b => {
            const id = b.dataset.t, span = b.querySelector('span');
            const label = [...b.childNodes].filter(n => n !== span).map(n => n.textContent).join('').trim();
            const known = id in GROUP;
            const svg = span && span.querySelector('svg') ? span.innerHTML : ic('calendar');
            items.push({ id, label, group: known ? GROUP[id] : 'trip', color: COLOR[id] || PLAN_COLORS[plan++ % PLAN_COLORS.length], icon: svg, value: ((data.tiles || {})[id] || {}).text });
            /* Route direkt nach der Karte */
            if (id === 'mapview' && (data.route || []).length) items.push({ id: 'route', label: 'Route', group: 'trip', color: COLOR.route, icon: ic('pin'), value: `${data.route.length} Stationen` });
        });
        if ((data.route || []).length && !items.some(i => i.id === 'route')) items.push({ id: 'route', label: 'Route', group: 'trip', color: COLOR.route, icon: ic('pin'), value: `${data.route.length} Stationen` });
        return items;
    }

    function render() {
        if (!home) return;
        const title = (document.getElementById('tripTitle') || {}).textContent || '';
        const cd = document.getElementById('countdown');
        const t = data.today;
        const items = rowsFor();
        const list = (g, name) => {
            const rows = items.filter(i => i.group === g);
            return rows.length ? `<div class="m-grp">${name}</div><div class="m-list">${rows.map(i => `
                <button type="button" class="m-li" data-open="${esc(i.id)}">
                    <span class="m-bx" style="background:${i.color}">${i.icon}</span>
                    <span class="m-lt">${esc(i.label)}</span>
                    ${i.value ? `<small>${esc(i.value)}</small>` : ''}${ic('chevronRight')}
                </button>`).join('')}</div>` : '';
        };
        home.innerHTML = `
            <button type="button" class="m-status"${t && t.plan ? ` data-open="${esc(t.plan)}"` : ''}>
                ${data.flags && data.flags.length ? `<span class="m-flags">${data.flags.map(esc).join('')}</span>` : ''}
                <span class="m-st">
                    <span class="m-cd">${cd && cd.innerHTML.trim() ? cd.innerHTML : esc(title)}</span>
                    ${t ? `<small>${esc(t.label)}: ${esc(t.title)}</small>` : ''}
                </span>
            </button>
            ${list('trip', 'Reise')}${list('org', 'Organisation')}${list('info', 'Infos')}`;
        home.querySelectorAll('[data-open]').forEach(b => b.onclick = () => open(b.dataset.open));
        const stops = data.route || [];
        /* Nummern öffnen die möglichen Aktivitäten des Orts (shared/activities.js), sobald geladen */
        const act = window.TBActivities && TBActivities.ready;
        if (routeView) routeView.innerHTML = stops.length ? `<div class="box m-route">
                <h2>${ic('pin')}Route · ${stops.length} Stationen</h2>
                <div class="m-tl">${stops.map(s => `<div class="m-stop${s.now ? ' now' : ''}" style="--c:${esc(s.color || 'var(--p1)')}">${act
                    ? `<button type="button" class="m-num" data-loc="${esc(s.name)}" data-num="${esc(s.num ?? '')}" aria-label="Mögliche Aktivitäten: ${esc(s.name)}" title="Mögliche Aktivitäten">${esc(s.num ?? '')}</button>`
                    : `<i>${esc(s.num ?? '')}</i>`}
                    <div><b>${esc(s.name)}${s.now ? ` <span class="m-now">${s.label || 'Jetzt'}</span>` : ''}</b>
                    ${s.when ? `<small>${esc(s.when)}</small>` : ''}</div></div>`).join('')}</div>
            </div>` : `<div class="box m-route"><h2>${ic('pin')}Route</h2><p class="note">Für diese Reise sind noch keine Stationen hinterlegt.</p></div>`;
        if (routeView) routeView.querySelectorAll('.m-num').forEach(b => b.onclick = () => TBActivities.open(b.dataset.loc, b.dataset.num, b));
    }

    function init() {
        const header = document.querySelector('.sticky-header header');
        const sticky = document.querySelector('.sticky-header');
        if (!header || !sticky) return;
        /* Zurück-Knopf vor dem Titel (nur Handy sichtbar) */
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'm-back'; back.setAttribute('aria-label', 'Zurück');
        back.innerHTML = ic('chevronLeft');
        back.onclick = stepBack;
        header.insertBefore(back, header.firstElementChild);
        /* Browser-Zurück aus einem Bereich: wieder die Übersicht der Reise */
        window.addEventListener('popstate', e => { if (mq.matches && !(e.state && e.state.tbView)) setHome(true); });
        /* Übersicht und Route direkt unter der Kopfzeile */
        home = document.createElement('section');
        home.id = 'tripHome'; home.className = 'm-home-view';
        routeView = document.createElement('section');
        routeView.id = 'tripRoute'; routeView.className = 'm-route-view';
        sticky.after(home, routeView);
        /* Schwebende Leiste unten (nur Handy, siehe trip.css) */
        bar = document.createElement('nav');
        bar.className = 'm-tabbar'; bar.setAttribute('aria-label', 'Reise');
        bar.innerHTML = TABS.map(([id, label, icon]) => `<button type="button" data-tab="${id}">${ic(icon)}${label}</button>`).join('');
        bar.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => tab(b.dataset.tab));
        document.body.appendChild(bar);
        /* Start: Übersicht, außer beim Neuladen eines offenen Bereichs */
        const s = stored();
        if (s === 'route') { setHome(false); document.body.classList.add('m-route'); store('route'); mark('route'); }
        else { setHome(!s || s === 'home'); if (s && s !== 'home') mark(s); }
        /* Seite fertig geladen (tb-loading weg) oder Countdown aktualisiert → Übersicht neu zeichnen */
        new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        const cd = document.getElementById('countdown');
        if (cd) new MutationObserver(() => { if (document.body.classList.contains('m-home')) render(); }).observe(cd, { childList: true, characterData: true, subtree: true });
        const links = document.getElementById('popLinks');
        if (links) new MutationObserver(render).observe(links, { childList: true });
        mq.addEventListener('change', e => { if (e.matches) render(); });
        /* Neuladen mit #bereich: der Browser springt sonst unter die Kopfzeile */
        window.addEventListener('load', () => { if (mq.matches) setTimeout(() => window.scrollTo(0, 0), 0); });
        /* Start hängt (schwaches Netz, Bibliothek fehlt): nach 8 s „Neu laden“ anbieten */
        setTimeout(() => {
            const g = document.getElementById('tbGate');
            if (document.body.classList.contains('tb-loading') && g && !g.hidden && !g.querySelector('.m-reload'))
                g.insertAdjacentHTML('beforeend', '<p class="note">Das dauert ungewöhnlich lange.</p><button class="btn m-reload" type="button" onclick="location.reload()">Neu laden</button>');
        }, 8000);
    }

    window.TBTripMobile = {
        setData(d) { const tiles = Object.assign({}, data.tiles, d && d.tiles); data = Object.assign(data, d || {}, { tiles }); render(); },
        setTile(id, t) { data.tiles = Object.assign({}, data.tiles, { [id]: t }); render(); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
