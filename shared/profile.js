/* TravelBase – Profil-Button oben rechts neben dem Mond
   - zeigt ein Personen-Symbol bzw. das eigene Profilbild, sobald eins hochgeladen ist
   - Menü wie in allen Apps (Vorlage: JobTracker): Kopf mit Bild/Initialen, Name, E-Mail und Rolle, Cloud-Sync-Status,
     Dashboard, Kontoeinstellungen, Admin-Einstellungen (globale und TravelBase-Admins), Abmelden
   Admin-Einstellungen sind wie die Kontoeinstellungen eine gemeinsame Seite im Dashboard (/admin.html).
   Kontoeinstellungen sind eine gemeinsame Seite für alle Apps im Dashboard (/konto.html);
   shared/overall-account.js wird hier nur noch für das Profilbild gebraucht.
   Benötigt vorher: shared/travelbase.js und shared/overall-account.js. Die Seite braucht einen <button id="tbProfileBtn" hidden>.
   Fotos liegen im privaten Storage-Bucket "avatars" unter <user-id>/…, der Pfad steht in overall_profiles.avatar_path. */
(function () {
    const ROOT = new URL('../', document.currentScript.src).href;   /* Übersicht = Ziel für Logout und Passwort-Link */
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const check = ({ data, error }) => { if (error) throw error; return data; };

    let btn = null, menu = null;
    let user = null;            /* { id, email } */
    let profile = {};           /* { display_name, birthday, avatar_path, role, app_role } */
    let photo = null;           /* data:-URL des Profilbilds oder null */


    const ic = n => window.tbIcon ? tbIcon(n) : '';
    const shownName = () => (profile.display_name || '').trim() || (user && user.email) || '';
    const avatarHtml = () => photo ? `<img src="${photo}" alt="">` : (ic('person') || '👤');
    const AVATAR_COLORS = ['#0b6e79', '#4a7356', '#b25000', '#5856d6', '#0066cc', '#a2453a'];
    const ROLE_LABELS = { admin: 'Admin', member: 'Mitglied', guest: 'Gast' };
    const myRole = () => profile.role === 'admin' ? 'admin' : (profile.app_role || null);
    function menuAvaHtml() {
        if (photo) return `<span class="tbp-ava"><img src="${photo}" alt=""></span>`;
        const n = shownName();
        let h = 0; for (const c of n) h = (h * 31 + c.codePointAt(0)) >>> 0;
        const ini = n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
        return `<span class="tbp-ava" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(ini)}</span>`;
    }
    function syncHtml() {
        const off = !navigator.onLine, t = window.TB && TB.lastSync;
        const text = off ? 'Offline · zuletzt geladener Stand'
            : t ? 'Verbunden · zuletzt ' + t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'Verbunden';
        return `<div class="tbp-sync" role="status"><i class="${off ? 'pending' : ''}"></i><span><b>Cloud-Sync</b> · ${esc(text)}</span></div>`;
    }

    /* ---------- Daten ---------- */
    async function loadProfile() {
        const row = check(await TB.sb.from('overall_profiles').select('display_name, birthday, avatar_path, role').eq('id', user.id).maybeSingle());
        profile = row || {};
        profile.app_role = await TB.sb.rpc('overall_app_role', { p_app: 'travelbase' }).then(check).catch(() => null);
        TB.cacheSet('profile_' + user.id, profile);
        TB.cacheSet('name_' + user.id, (profile.display_name || '').trim());
    }

    async function loadPhoto() {
        const path = profile.avatar_path;
        if (!path) { photo = null; TB.cacheSet('avatar_' + user.id, null); return; }
        const cached = TB.cacheGet('avatar_' + user.id);
        if (cached && cached.path === path) { photo = cached.data; return; }
        photo = await OverallAccount.loadPhoto(TB.sb, path);
        TB.cacheSet('avatar_' + user.id, { path, data: photo });
    }

    /* ---------- Anzeige ---------- */
    function fitButton() {
        if (!btn) return;
        const ref = btn.parentElement && btn.parentElement.querySelector('.theme-toggle, #themeToggle');
        /* gleiche Größe und Form wie der Hell/Dunkel-Button, auch mit Foto */
        const w = ref && ref.offsetWidth, h = ref && ref.offsetHeight;
        btn.style.boxSizing = 'border-box';
        btn.style.width = w ? w + 'px' : '';
        btn.style.height = h ? h + 'px' : '';
    }

    function render() {
        if (!btn) return;
        btn.hidden = !user;
        btn.classList.toggle('has-photo', !!photo);
        btn.innerHTML = avatarHtml();
        btn.title = user ? shownName() : '';
        fitButton();
        /* Namen, die die Seite selbst anzeigt, gleich mitziehen */
        const n = shownName();
        const ue = document.getElementById('userEmail'); if (ue && n) ue.textContent = n;
        const who = document.getElementById('tbWho'); if (who && n) who.innerHTML = ic('person') + esc(n);
        if (menu && !menu.hidden) renderMenu();
        /* Profil-Seite und Profilbild in der Handy-Leiste (nur Übersicht) mitziehen */
        document.querySelectorAll('[data-tbp-avatar]').forEach(el => { el.innerHTML = user ? menuAvaHtml() : ''; });
        document.querySelectorAll('[data-tbp-page]').forEach(el => { if (user) renderMenu(el, true); else el.innerHTML = ''; });
        document.querySelectorAll('[data-tbp-name]').forEach(el => { el.textContent = user ? shownName() : ''; });
        document.querySelectorAll('[data-tbp-mail]').forEach(el => { el.textContent = user ? user.email : ''; });
        document.querySelectorAll('[data-tbp-role]').forEach(el => { const r = myRole(); el.textContent = r ? (ROLE_LABELS[r] || r) : ''; el.hidden = !r; });
    }

    /* page = true: dasselbe Menü als feste Liste auf der Profil-Seite (ohne Kopf, der steht dort groß) */
    function renderMenu(el = menu, page = false) {
        const role = myRole();
        el.innerHTML = (page ? '' : `
            <div class="tbp-head">
                ${menuAvaHtml()}
                <div><b>${esc(shownName())}</b><small>${esc(user.email)}</small>${role ? `<span class="tbp-role">${esc(ROLE_LABELS[role] || role)}</span>` : ''}</div>
            </div>`) + `
            ${syncHtml()}
            <button class="tbp-item" type="button" role="menuitem" data-act="dashboard">${ic('home')}Dashboard</button>
            <button class="tbp-item" type="button" role="menuitem" data-act="settings">${ic('gear')}Kontoeinstellungen</button>
            ${role === 'admin' ? `<button class="tbp-item" type="button" role="menuitem" data-act="admin">${ic('shield')}Admin-Einstellungen<small>nur Admins</small></button>` : ''}
            <div class="tbp-sep"></div>
            <button class="tbp-item danger" type="button" role="menuitem" data-act="logout">${ic('logout')}Abmelden</button>`;
    }

    function openMenu() {
        if (!menu) {
            menu = document.createElement('div');
            menu.className = 'tbp-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
            menu.onclick = onAct;
            document.body.appendChild(menu);
        }
        renderMenu();
        const r = btn.getBoundingClientRect();
        menu.style.top = (r.bottom + 8) + 'px';
        menu.style.right = Math.max(10, window.innerWidth - r.right) + 'px';
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        const first = menu.querySelector('.tbp-item'); if (first) first.focus();
    }
    function onAct(e) {
        const b = e.target.closest('[data-act]'); if (!b) return;
        closeMenu();
        if (b.dataset.act === 'dashboard') location.href = '/';
        else if (b.dataset.act === 'settings') location.href = SETTINGS;
        else if (b.dataset.act === 'admin') location.href = ADMIN;
        else if (b.dataset.act === 'logout') logout();
    }
    function closeMenu() {
        if (menu) menu.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    /* Gemeinsame Kontoeinstellungen aller Apps (Dashboard-Repo), TravelBase-Bereich vorne */
    const SETTINGS = '/konto.html?from=travelbase#app-travelbase';
    const ADMIN = '/admin.html?from=travelbase#app-travelbase';

    async function logout() {
        await TB.signOut();
        location.href = ROOT;
    }

    /* ---------- Start ---------- */
    async function refresh(session) {
        user = session ? { id: session.user.id, email: session.user.email } : null;
        if (!user) { profile = {}; photo = null; closeMenu(); OverallAccount.close(); render(); return; }
        /* sofort mit dem gespeicherten Stand anzeigen, dann aus der Datenbank nachladen */
        profile = TB.cacheGet('profile_' + user.id) || {};
        const cached = TB.cacheGet('avatar_' + user.id);
        photo = cached && cached.path === profile.avatar_path ? cached.data : null;
        render();
        try { await loadProfile(); await loadPhoto(); }
        catch (e) { if (!TB.isNetErr(e)) console.warn('Profil laden', e); }
        render();
    }

    function init() {
        btn = document.getElementById('tbProfileBtn');
        if (!btn || !window.TB || !TB.configured || !TB.sb) return;
        btn.type = 'button';
        btn.classList.add('tb-profile-btn');
        btn.setAttribute('aria-label', 'Profil-Menü öffnen');
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        document.querySelectorAll('[data-tbp-page]').forEach(el => { el.classList.add('tbp-menu', 'tbp-page'); el.setAttribute('role', 'menu'); el.onclick = onAct; });
        btn.onclick = e => { e.stopPropagation(); (menu && !menu.hidden) ? closeMenu() : openMenu(); };
        document.addEventListener('click', e => { if (menu && !menu.hidden && !menu.contains(e.target)) closeMenu(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
        window.addEventListener('resize', () => { closeMenu(); fitButton(); });
        /* Anmelden/Abmelden ohne Neuladen (Übersicht). Supabase-Aufrufe nicht direkt im Callback starten. */
        TB.sb.auth.onAuthStateChange((ev, session) => {
            if (ev === 'INITIAL_SESSION' || ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') setTimeout(() => refresh(session), 0);
            else if (ev === 'USER_UPDATED' && session && user) user.email = session.user.email;
        });
    }

    const css = document.createElement('style');
    css.textContent = `
        .tb-profile-btn { display: inline-flex; align-items: center; justify-content: center; }
        .tb-profile-btn.has-photo { padding: 0 !important; overflow: hidden; }
        .tb-profile-btn img, .tbp-ava img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .tbp-menu { position: fixed; z-index: 20000; width: 290px; max-width: calc(100vw - 32px); background: var(--card, #fff); color: var(--text, #3a3a3c); border-radius: 14px; box-shadow: 0 12px 36px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.06); padding: 6px; font-family: var(--font, -apple-system, BlinkMacSystemFont, system-ui, sans-serif); font-size: 14px; line-height: 1.4; text-align: left; }
        :root[data-theme="dark"] .tbp-menu { background: #2c2c2e; box-shadow: 0 12px 36px rgba(0,0,0,.5); }
        .tbp-head { display: flex; gap: 10px; align-items: center; padding: 8px 10px 10px; min-width: 0; }
        .tbp-head > div { min-width: 0; }
        .tbp-head b { display: block; color: var(--ink, #1c1c1e); font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tbp-head small { display: block; color: var(--mute, #6c6c70); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tbp-ava { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; color: #fff; font-size: 14px; font-weight: 600; background: var(--well, #f2f2f7); }
        .tbp-role { display: inline-block; margin-top: 3px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--p1-soft, #e6f0f9); color: var(--p1, #1f6fb2); }
        .tbp-sync { display: flex; align-items: center; gap: 8px; margin: 0 4px 6px; padding: 8px 10px; border-radius: 10px; background: var(--well, #f2f2f7); font-size: 12px; color: var(--text, #3a3a3c); }
        :root[data-theme="dark"] .tbp-sync { background: #3a3a3c; }
        .tbp-sync i { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #34c759); flex: none; }
        .tbp-sync i.pending { background: var(--warn, #ff9f0a); }
        .tbp-sync span { min-width: 0; }
        .tbp-sync b { font-weight: 600; color: var(--ink, #1c1c1e); }
        .tbp-item { display: flex; width: 100%; align-items: center; gap: 10px; background: none; border: 0; border-radius: 8px; padding: 8px 10px; min-height: 40px; font: inherit; font-size: 14px; font-weight: 500; color: var(--ink, #1c1c1e); text-align: left; cursor: pointer; }
        .tbp-item .ic { width: 18px; height: 18px; color: var(--mute, #6c6c70); flex: none; }
        .tbp-item:hover, .tbp-item:focus-visible { background: var(--hover, #e9e9ef); outline: none; }
        .tbp-item small { margin-left: auto; font-size: 11px; color: var(--mute, #6c6c70); white-space: nowrap; }
        .tbp-item.danger, .tbp-item.danger .ic { color: var(--danger, #d70015); }
        .tbp-sep { height: 1px; margin: 4px 6px; background: var(--sep, rgba(60, 60, 67, .14)); }
        .tbp-menu[hidden] { display: none !important; }
        .tbp-menu.tbp-page { position: static; width: auto; max-width: none; box-shadow: var(--shadow); border-radius: var(--radius, 18px); }
        :root[data-theme="dark"] .tbp-menu.tbp-page { background: var(--card); box-shadow: none; }`;
    document.head.appendChild(css);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
