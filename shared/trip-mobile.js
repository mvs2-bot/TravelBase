/* TravelBase – Reise-Seite am Handy (< 768 px)
   - Start ist eine Übersicht der Reise: Status/Countdown, „Heute“, Kacheln für alle Bereiche, Route als Zeitstrahl
   - jede Kachel öffnet den Bereich wie bisher; oben links führt „‹“ zurück (Bereich → Übersicht → Alle Reisen)
   - unten die schwebende Leiste wie auf der Übersicht: Zukünftige · Vielleicht · Vergangene · Profil
   Am Desktop ändert sich nichts (alles hängt an der Media Query in trip.css).
   Funktioniert mit jeder Reise-Seite, die .pop-btn[data-t] und .pane hat (Vorlage und Thailand).
   „Heute“, Route und Zusatzinfos der Kacheln liefert die Seite über TBTripMobile.setData(), sonst nur Kacheln. */
(function () {
    'use strict';
    const mq = matchMedia('(max-width: 767.98px)');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = n => window.tbIcon ? tbIcon(n) : '';
    const KEY = 'travelbase-trip-view:' + location.pathname;
    let data = {}, home = null, bar = null, back = null, showAllStops = false;

    /* Offene Ansicht pro Reise merken: Neuladen bleibt dort, ein neuer Aufruf startet auf der Übersicht */
    const stored = () => { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } };
    const store = v => { try { sessionStorage.setItem(KEY, v); } catch (e) {} };

    function setHome(on) {
        document.body.classList.toggle('m-home', on);
        store(on ? 'home' : (location.hash.slice(1) || 'section'));
        if (on) { render(); window.scrollTo(0, 0); }
    }
    function open(id) {
        const b = document.querySelector(`.pop-btn[data-t="${CSS.escape(id)}"]`);
        if (!b) return;
        b.click();
        setHome(false);
        store(id);
        /* eigener Verlaufseintrag: Zurück (Knopf, Wischgeste, App-Leiste) führt einen Schritt zurück zur Reise-Übersicht */
        if (mq.matches) history.pushState({ tbView: id }, '', location.pathname + location.search + '#' + id);
    }
    /* einen Schritt zurück: Bereich → Reise-Übersicht → Alle Reisen */
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

    function tileSub(id) { return (data.tiles || {})[id] || {}; }
    function render() {
        if (!home) return;
        const title = (document.getElementById('tripTitle') || {}).textContent || '';
        const period = (document.getElementById('tripPeriod') || {}).textContent || '';
        const cd = document.getElementById('countdown');
        const btns = [...document.querySelectorAll('.pop-btn[data-t]')];
        const t = data.today;
        const stops = data.route || [];
        const shown = showAllStops ? stops : stops.slice(0, 6);
        home.innerHTML = `
            <div class="m-hero">
                ${data.flags && data.flags.length ? `<div class="m-flags">${data.flags.map(esc).join('')}</div>` : ''}
                <div class="m-status">${cd && cd.innerHTML.trim() ? cd.innerHTML : esc(title)}</div>
                <div class="m-sub">${esc(period)}${data.people ? ' · ' + esc(data.people) : ''}</div>
            </div>
            ${t ? `<div class="box m-today">
                <h2>${ic('star')}${esc(t.label)} · ${esc(t.date)}</h2>
                <div class="m-today-title">${esc(t.title)}</div>
                ${t.details ? `<div class="m-today-text">${t.details}</div>` : ''}
                <div class="m-today-pills">${t.transport ? `<span class="pill">${t.transport}</span>` : ''}${t.hotel ? `<span class="pill hotel-pill">${t.hotel}</span>` : ''}</div>
            </div>` : ''}
            <div class="m-tiles">${btns.map(b => {
                const s = tileSub(b.dataset.t), icon = b.querySelector('span');
                return `<button type="button" class="m-tile" data-open="${esc(b.dataset.t)}">
                    <span class="m-ti">${icon ? icon.innerHTML : ''}</span>
                    <b>${esc([...b.childNodes].filter(n => n !== icon).map(n => n.textContent).join('').trim())}</b>
                    ${s.text ? `<small>${esc(s.text)}</small>` : ''}
                    ${s.pct != null ? `<i class="m-prog"><i style="width:${s.pct}%"></i></i>` : ''}
                </button>`; }).join('')}</div>
            ${stops.length ? `<div class="box m-route">
                <h2>${ic('pin')}Route</h2>
                <div class="m-tl">${shown.map(s => `<div class="m-stop${s.now ? ' now' : ''}" style="--c:${esc(s.color || 'var(--p1)')}"><i>${esc(s.num ?? '')}</i>
                    <div><b>${esc(s.name)}${s.now ? ` <span class="m-now">${s.label || 'Jetzt'}</span>` : ''}</b>
                    ${s.when ? `<small>${esc(s.when)}</small>` : ''}</div></div>`).join('')}</div>
                ${stops.length > 6 ? `<button type="button" class="link-btn m-more">${showAllStops ? 'Weniger anzeigen' : `Alle ${stops.length} Stationen anzeigen`} ›</button>` : ''}
            </div>` : ''}`;
        home.querySelectorAll('[data-open]').forEach(b => b.onclick = () => open(b.dataset.open));
        const more = home.querySelector('.m-more');
        if (more) more.onclick = () => { showAllStops = !showAllStops; render(); };
    }

    function goOverview(tab) {
        try { sessionStorage.setItem('travelbase-tab', tab); } catch (e) {}
        location.href = '../';
    }
    function markBar() {
        if (!bar) return;
        const past = data.past != null ? data.past : /abgeschlossen/i.test((document.getElementById('countdown') || {}).textContent || '');
        const cur = past ? 'past' : data.maybe ? 'maybe' : 'upcoming';
        bar.querySelectorAll('[data-go]').forEach(b => b.dataset.go === cur ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
    }

    function init() {
        const header = document.querySelector('.sticky-header header');
        const sticky = document.querySelector('.sticky-header');
        if (!header || !sticky) return;
        /* Zurück-Knopf vor dem Titel (nur Handy sichtbar) */
        back = document.createElement('button');
        back.type = 'button'; back.className = 'm-back'; back.setAttribute('aria-label', 'Zurück');
        back.innerHTML = ic('chevronLeft');
        back.onclick = stepBack;
        /* Browser-Zurück aus einem Bereich: wieder die Reise-Übersicht */
        window.addEventListener('popstate', e => { if (mq.matches && !(e.state && e.state.tbView)) setHome(true); });
        header.insertBefore(back, header.firstElementChild);
        /* Übersicht direkt unter der Kopfzeile */
        home = document.createElement('section');
        home.id = 'tripHome'; home.className = 'm-home-view';
        sticky.after(home);
        /* Leiste wie auf der Übersicht */
        bar = document.createElement('nav');
        bar.className = 'tabbar'; bar.setAttribute('aria-label', 'Navigation');
        bar.innerHTML = `<button type="button" data-go="upcoming">${ic('compass')}Zukünftige</button>
            <button type="button" data-go="maybe">${ic('bulb')}Vielleicht</button>
            <button type="button" data-go="past">${ic('archive')}Vergangene</button>
            <button type="button" data-go="profile"><span class="bar-ava" data-tbp-avatar></span>Profil</button>`;
        bar.querySelectorAll('[data-go]').forEach(b => b.onclick = () => goOverview(b.dataset.go));
        document.body.appendChild(bar);
        document.body.classList.add('has-tabbar');
        /* Start: Übersicht, außer beim Neuladen eines offenen Bereichs */
        const s = stored();
        setHome(!s || s === 'home');
        markBar();
        /* Seite fertig geladen (tb-loading weg) oder Countdown aktualisiert → Übersicht neu zeichnen */
        new MutationObserver(() => { render(); markBar(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        const cd = document.getElementById('countdown');
        if (cd) new MutationObserver(() => { if (document.body.classList.contains('m-home')) render(); markBar(); }).observe(cd, { childList: true, characterData: true, subtree: true });
        const links = document.getElementById('popLinks');
        if (links) new MutationObserver(render).observe(links, { childList: true });
        /* Bereich über Desktop-Tabs gewählt und dann schmal gezogen: offenen Bereich zeigen */
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
        setData(d) { const tiles = Object.assign({}, data.tiles, d && d.tiles); data = Object.assign(data, d || {}, { tiles }); render(); markBar(); },
        setTile(id, t) { data.tiles = Object.assign({}, data.tiles, { [id]: t }); render(); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
