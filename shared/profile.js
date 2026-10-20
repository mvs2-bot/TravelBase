/* TravelBase – Profil-Button oben rechts neben dem Mond
   - zeigt 👤 bzw. das eigene Profilbild, sobald eins hochgeladen ist
   - Menü: Kontoeinstellungen, Admin-Einstellungen (globale und TravelBase-Admins), Ausloggen
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


    const shownName = () => (profile.display_name || '').trim() || (user && user.email) || '';
    const avatarHtml = () => photo ? `<img src="${photo}" alt="">` : '👤';

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
        const who = document.getElementById('tbWho'); if (who && n) who.textContent = '👤 ' + n;
        if (menu && !menu.hidden) renderMenu();
    }

    function renderMenu() {
        menu.innerHTML = `
            <div class="tbp-head">
                <span class="tbp-ava">${avatarHtml()}</span>
                <div><b>${esc(shownName())}</b><small>${esc(user.email)}</small></div>
            </div>
            <button class="tbp-item" type="button" role="menuitem" data-act="settings">⚙️ Kontoeinstellungen</button>
            ${profile.role === 'admin' || profile.app_role === 'admin' ? '<button class="tbp-item" type="button" role="menuitem" data-act="admin">🛡️ Admin-Einstellungen</button>' : ''}
            <button class="tbp-item danger" type="button" role="menuitem" data-act="logout">🚪 Ausloggen</button>`;
    }

    function openMenu() {
        if (!menu) {
            menu = document.createElement('div');
            menu.className = 'tbp-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
            menu.onclick = e => {
                const b = e.target.closest('[data-act]'); if (!b) return;
                closeMenu();
                if (b.dataset.act === 'settings') location.href = SETTINGS;
                else if (b.dataset.act === 'admin') location.href = ADMIN;
                else if (b.dataset.act === 'logout') logout();
            };
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
        .tbp-menu { position: fixed; z-index: 20000; min-width: 250px; max-width: calc(100vw - 20px); background: var(--card, #fff); color: var(--text, #334155); border: 1px solid var(--line, #cbd5e1); border-radius: 14px; box-shadow: 0 12px 32px rgba(15,23,42,.2); padding: 8px; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; line-height: 1.4; }
        .tbp-head { display: flex; gap: 10px; align-items: center; padding: 8px 10px 12px; border-bottom: 1px solid var(--line, #cbd5e1); margin-bottom: 6px; }
        .tbp-head b { display: block; color: var(--ink, #0f172a); font-size: .95rem; }
        .tbp-head small { display: block; color: var(--mute, #64748b); font-size: .78rem; word-break: break-all; }
        .tbp-ava { width: 42px; height: 42px; flex: 0 0 auto; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 1.4rem; background: var(--hover, #f0fdf4); border: 1px solid var(--line, #cbd5e1); }
        .tbp-item { display: flex; width: 100%; align-items: center; gap: 10px; background: none; border: 0; border-radius: 8px; padding: 10px 12px; font: inherit; font-size: .92rem; font-weight: 700; color: var(--ink, #0f172a); text-align: left; cursor: pointer; }
        .tbp-item:hover, .tbp-item:focus-visible { background: var(--hover, #f0fdf4); outline: none; }
        .tbp-item.danger { color: var(--danger, #dc2626); }
        .tbp-menu[hidden] { display: none !important; }`;
    document.head.appendChild(css);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
