/* TravelBase – Profil-Button oben rechts neben dem Mond
   - zeigt 👤 bzw. das eigene Profilbild, sobald eins hochgeladen ist
   - Menü: Kontoeinstellungen (Name, Geburtsdatum, Foto), Passwort ändern / vergessen, Ausloggen
   Benötigt vorher: shared/travelbase.js. Die Seite braucht einen <button id="tbProfileBtn" hidden>.
   Fotos liegen im privaten Storage-Bucket "avatars" unter <user-id>/…, der Pfad steht in overall_profiles.avatar_path. */
(function () {
    const ROOT = new URL('../', document.currentScript.src).href;   /* Übersicht = Ziel für Logout und Passwort-Link */
    const BUCKET = 'avatars';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const check = ({ data, error }) => { if (error) throw error; return data; };

    let btn = null, menu = null, modal = null;
    let user = null;            /* { id, email } */
    let profile = {};           /* { display_name, birthday, avatar_path } */
    let photo = null;           /* data:-URL des Profilbilds oder null */
    let extended = true;        /* false = Spalten birthday/avatar_path fehlen noch in der Datenbank */

    function errText(e) {
        const m = String(e && (e.message || e));
        if (/bucket not found/i.test(m)) return 'Der Foto-Speicher ist noch nicht eingerichtet (Supabase-SQL fehlt).';
        if (/row-level security|permission denied|unauthorized/i.test(m)) return 'Keine Berechtigung – ist die Datenbank-Einrichtung (SQL) schon gelaufen?';
        if (/payload too large|exceeded the maximum/i.test(m)) return 'Das Bild ist zu groß.';
        return window.TB && TB.errorText ? TB.errorText(e) : m;
    }
    function msg(el, text, ok) { el.textContent = text; el.className = 'tbp-msg ' + (ok ? 'ok' : 'err'); el.hidden = !text; }
    const shownName = () => (profile.display_name || '').trim() || (user && user.email) || '';
    const avatarHtml = () => photo ? `<img src="${photo}" alt="">` : '👤';

    /* ---------- Daten ---------- */
    async function loadProfile() {
        let row;
        try {
            row = check(await TB.sb.from('overall_profiles').select('display_name, birthday, avatar_path').eq('id', user.id).maybeSingle());
            extended = true;
        } catch (e) {
            if (!/column|does not exist|schema cache/i.test(String(e && e.message))) throw e;
            /* SQL für Geburtsdatum/Foto noch nicht ausgeführt → nur den Namen laden */
            extended = false;
            row = check(await TB.sb.from('overall_profiles').select('display_name').eq('id', user.id).maybeSingle());
        }
        profile = row || {};
        TB.cacheSet('profile_' + user.id, profile);
        TB.cacheSet('name_' + user.id, (profile.display_name || '').trim());
    }

    async function loadPhoto() {
        const path = profile.avatar_path;
        if (!path) { photo = null; TB.cacheSet('avatar_' + user.id, null); return; }
        const cached = TB.cacheGet('avatar_' + user.id);
        if (cached && cached.path === path) { photo = cached.data; return; }
        const blob = check(await TB.sb.storage.from(BUCKET).download(path));
        photo = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(blob); });
        TB.cacheSet('avatar_' + user.id, { path, data: photo });
    }

    /* Zeile in profiles ändern; gibt es noch keine, wird sie angelegt */
    async function saveProfile(fields) {
        if (extended) fields = { ...fields, updated_at: new Date().toISOString() };
        const rows = check(await TB.sb.from('overall_profiles').update(fields).eq('id', user.id).select('id'));
        if (!rows.length) check(await TB.sb.from('overall_profiles').insert({ id: user.id, ...fields }));
        Object.assign(profile, fields);
        TB.cacheSet('profile_' + user.id, profile);
        TB.cacheSet('name_' + user.id, (profile.display_name || '').trim());
    }

    /* Foto quadratisch zuschneiden und auf max. 400 px verkleinern (JPEG) */
    async function shrink(file) {
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('Das Bild konnte nicht gelesen werden. Bitte ein JPG oder PNG wählen.')); i.src = url; });
            const s = Math.min(img.naturalWidth, img.naturalHeight), size = Math.min(400, s);
            const c = document.createElement('canvas'); c.width = c.height = size;
            c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
            return await new Promise((ok, fail) => c.toBlob(b => b ? ok(b) : fail(new Error('Das Bild konnte nicht verarbeitet werden.')), 'image/jpeg', 0.85));
        } finally { URL.revokeObjectURL(url); }
    }

    async function uploadPhoto(file) {
        const blob = await shrink(file);
        const old = profile.avatar_path;
        const path = `${user.id}/avatar-${Date.now()}.jpg`;
        check(await TB.sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true }));
        try { await saveProfile({ avatar_path: path }); }
        catch (e) { TB.sb.storage.from(BUCKET).remove([path]).catch(() => {}); throw e; }
        if (old) TB.sb.storage.from(BUCKET).remove([old]).catch(() => {});
        await loadPhoto();
    }

    async function removePhoto() {
        const old = profile.avatar_path;
        await saveProfile({ avatar_path: null });
        if (old) TB.sb.storage.from(BUCKET).remove([old]).catch(() => {});
        await loadPhoto();
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
            <button class="tbp-item" type="button" role="menuitem" data-act="password">🔑 Passwort ändern / vergessen</button>
            <button class="tbp-item danger" type="button" role="menuitem" data-act="logout">🚪 Ausloggen</button>`;
    }

    function openMenu() {
        if (!menu) {
            menu = document.createElement('div');
            menu.className = 'tbp-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
            menu.onclick = e => {
                const b = e.target.closest('[data-act]'); if (!b) return;
                closeMenu();
                if (b.dataset.act === 'settings') openSettings();
                else if (b.dataset.act === 'password') openPassword();
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

    function openModal(html) {
        closeModal();
        modal = document.createElement('div');
        modal.className = 'tbp-modal';
        modal.innerHTML = `<div class="tbp-dialog" role="dialog" aria-modal="true">${html}</div>`;
        modal.onclick = e => { if (e.target === modal || e.target.closest('.tbp-close')) closeModal(); };
        document.body.appendChild(modal);
        return modal.querySelector('.tbp-dialog');
    }
    function closeModal() { if (modal) { modal.remove(); modal = null; } }

    function openSettings() {
        const d = openModal(`
            <h2>⚙️ Kontoeinstellungen <button class="tbp-close" type="button" aria-label="Schließen">✕</button></h2>
            <div class="tbp-photo">
                <span class="tbp-ava tbp-ava-lg" id="tbpAva">${avatarHtml()}</span>
                <div class="tbp-photo-actions">
                    <button class="tbp-ghost" type="button" id="tbpPick">📷 Foto wählen</button>
                    <button class="tbp-link" type="button" id="tbpRemove"${profile.avatar_path ? '' : ' hidden'}>Foto entfernen</button>
                    <input type="file" id="tbpFile" accept="image/*" hidden>
                </div>
            </div>
            <form id="tbpForm">
                <label>Anzeigename<input type="text" id="tbpName" maxlength="60" autocomplete="nickname" value="${esc(profile.display_name || '')}" placeholder="${esc(user.email)}"></label>
                <label>Geburtsdatum<input type="date" id="tbpBirthday" value="${esc(profile.birthday || '')}"></label>
                <label>E-Mail<input type="email" value="${esc(user.email)}" disabled></label>
                <button class="tbp-btn" type="submit">Speichern</button>
            </form>
            <div class="tbp-msg" id="tbpMsg" hidden></div>`);
        const $ = s => d.querySelector(s), out = $('#tbpMsg');
        if (!extended) {
            $('#tbpPick').disabled = $('#tbpBirthday').disabled = true;
            msg(out, 'Foto und Geburtsdatum sind noch nicht freigeschaltet: In Supabase fehlt noch die Einrichtung (SQL).');
        }
        const refreshPhoto = () => { $('#tbpAva').innerHTML = avatarHtml(); $('#tbpRemove').hidden = !profile.avatar_path; render(); };
        $('#tbpPick').onclick = () => $('#tbpFile').click();
        $('#tbpFile').onchange = async () => {
            const f = $('#tbpFile').files[0]; $('#tbpFile').value = '';
            if (!f) return;
            $('#tbpPick').disabled = true; msg(out, '⏳ Foto wird hochgeladen …', true);
            try { await uploadPhoto(f); refreshPhoto(); msg(out, '✅ Profilbild gespeichert.', true); }
            catch (e) { msg(out, errText(e)); }
            finally { $('#tbpPick').disabled = false; }
        };
        $('#tbpRemove').onclick = async () => {
            if (!confirm('Profilbild wirklich entfernen?')) return;
            try { await removePhoto(); refreshPhoto(); msg(out, '✅ Profilbild entfernt.', true); }
            catch (e) { msg(out, errText(e)); }
        };
        $('#tbpForm').onsubmit = async e => {
            e.preventDefault();
            const b = $('#tbpForm button'); b.disabled = true; msg(out, '');
            const fields = { display_name: $('#tbpName').value.trim() || null };
            if (extended) fields.birthday = $('#tbpBirthday').value || null;
            try { await saveProfile(fields); render(); msg(out, '✅ Gespeichert.', true); }
            catch (err) { msg(out, errText(err)); }
            finally { b.disabled = false; }
        };
    }

    function openPassword() {
        const d = openModal(`
            <h2>🔑 Passwort <button class="tbp-close" type="button" aria-label="Schließen">✕</button></h2>
            <form id="tbpPwForm">
                <input type="email" value="${esc(user.email)}" autocomplete="username" hidden>
                <label>Neues Passwort<input type="password" id="tbpPw1" autocomplete="new-password" minlength="8" required></label>
                <label>Neues Passwort wiederholen<input type="password" id="tbpPw2" autocomplete="new-password" minlength="8" required></label>
                <button class="tbp-btn" type="submit">Passwort speichern</button>
            </form>
            <hr class="tbp-sep">
            <p class="tbp-note">Passwort vergessen? Wir schicken dir einen Link an <b>${esc(user.email)}</b>, mit dem du ein neues festlegen kannst.</p>
            <button class="tbp-ghost" type="button" id="tbpReset">📧 Link per E-Mail senden</button>
            <div class="tbp-msg" id="tbpMsg" hidden></div>`);
        const $ = s => d.querySelector(s), out = $('#tbpMsg');
        $('#tbpPwForm').onsubmit = async e => {
            e.preventDefault();
            if ($('#tbpPw1').value !== $('#tbpPw2').value) return msg(out, 'Die beiden Passwörter sind nicht gleich.');
            const b = $('#tbpPwForm button'); b.disabled = true; msg(out, '');
            try { await TB.updatePassword($('#tbpPw1').value); $('#tbpPwForm').reset(); msg(out, '✅ Passwort geändert.', true); }
            catch (err) { msg(out, errText(err)); }
            finally { b.disabled = false; }
        };
        $('#tbpReset').onclick = async () => {
            const b = $('#tbpReset'); b.disabled = true; msg(out, '');
            try {
                check(await TB.sb.auth.resetPasswordForEmail(user.email, { redirectTo: ROOT }));
                msg(out, '📧 Link ist unterwegs. Falls nichts ankommt: bitte im Spam-Ordner schauen.', true);
            } catch (err) { msg(out, errText(err)); }
            finally { b.disabled = false; }
        };
    }

    async function logout() {
        await TB.signOut();
        location.href = ROOT;
    }

    /* ---------- Start ---------- */
    async function refresh(session) {
        user = session ? { id: session.user.id, email: session.user.email } : null;
        if (!user) { profile = {}; photo = null; closeMenu(); closeModal(); render(); return; }
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
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); closeModal(); } });
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
        .tbp-ava-lg { width: 92px; height: 92px; font-size: 2.8rem; }
        .tbp-item { display: flex; width: 100%; align-items: center; gap: 10px; background: none; border: 0; border-radius: 8px; padding: 10px 12px; font: inherit; font-size: .92rem; font-weight: 700; color: var(--ink, #0f172a); text-align: left; cursor: pointer; }
        .tbp-item:hover, .tbp-item:focus-visible { background: var(--hover, #f0fdf4); outline: none; }
        .tbp-item.danger { color: var(--danger, #dc2626); }
        .tbp-modal { position: fixed; inset: 0; z-index: 20001; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
        .tbp-dialog { width: 100%; max-width: 440px; max-height: calc(100vh - 32px); overflow: auto; background: var(--card, #fff); color: var(--text, #334155); border: 1px solid var(--line, #cbd5e1); border-radius: 16px; padding: 22px; box-shadow: 0 20px 50px rgba(0,0,0,.25); font-family: 'Plus Jakarta Sans', system-ui, sans-serif; line-height: 1.5; text-align: left; }
        .tbp-dialog h2 { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 1.15rem; font-weight: 800; color: var(--ink, #0f172a); margin: 0 0 6px; }
        .tbp-close { background: none; border: 0; font-size: 1.2rem; color: var(--mute, #64748b); cursor: pointer; padding: 4px 8px; border-radius: 8px; }
        .tbp-close:hover { background: var(--hover, #f0fdf4); }
        .tbp-dialog form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
        .tbp-dialog label { display: flex; flex-direction: column; gap: 4px; font-size: .78rem; font-weight: 700; color: var(--mute, #64748b); }
        .tbp-dialog input { background: var(--bg, #f4f7f4); border: 1px solid var(--line, #cbd5e1); border-radius: 8px; padding: 10px 12px; font: inherit; font-size: 16px; color: var(--ink, #0f172a); }
        .tbp-dialog input:disabled { opacity: .6; }
        .tbp-btn { background: var(--p1, #15803d); color: #fff; border: 2px solid var(--p1, #15803d); border-radius: 10px; padding: 10px 16px; font: inherit; font-weight: 800; font-size: .95rem; cursor: pointer; }
        :root[data-theme="dark"] .tbp-btn { color: #052e16; }
        .tbp-btn:disabled, .tbp-ghost:disabled { opacity: .6; cursor: wait; }
        .tbp-ghost { background: var(--card, #fff); color: var(--text, #334155); border: 1px solid var(--line, #cbd5e1); border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 700; font-size: .85rem; cursor: pointer; }
        .tbp-ghost:hover { background: var(--hover, #f0fdf4); border-color: var(--p1, #15803d); }
        .tbp-link { background: none; border: 0; padding: 2px 0; font: inherit; font-weight: 700; font-size: .84rem; color: var(--danger, #dc2626); cursor: pointer; }
        .tbp-link:hover { text-decoration: underline; }
        .tbp-photo { display: flex; align-items: center; gap: 16px; margin: 14px 0 18px; }
        .tbp-photo-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
        .tbp-note { font-size: .84rem; color: var(--mute, #64748b); margin: 0 0 10px; }
        .tbp-sep { border: 0; border-top: 1px solid var(--line, #cbd5e1); margin: 18px 0 14px; }
        .tbp-msg { font-size: .84rem; font-weight: 600; border-radius: 8px; padding: 8px 12px; margin-top: 12px; background: #fee2e2; color: #b91c1c; }
        .tbp-msg.ok { background: #dcfce7; color: #15803d; }
        :root[data-theme="dark"] .tbp-msg { background: #3b1717; color: #fca5a5; }
        :root[data-theme="dark"] .tbp-msg.ok { background: #14361f; color: #86efac; }
        .tbp-msg[hidden], .tbp-menu[hidden] { display: none !important; }`;
    document.head.appendChild(css);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
