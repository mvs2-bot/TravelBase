/* TravelBase – gemeinsame Logik für Login, Datenzugriff & Offline-Zwischenspeicher
   Benötigt vorher: supabase-js (CDN) und shared/config.js */
(function () {
    const cfg = window.TB_CONFIG || {};
    const configured = !!(cfg.url && cfg.key && !/DEIN-PROJEKT|DEIN-PUBLISHABLE/.test(cfg.url + cfg.key));
    const sb = configured && window.supabase
        ? window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
        : null;

    /* Offline-Zwischenspeicher: zuletzt geladene Daten bleiben auf dem Gerät,
       damit die Seiten unterwegs ohne Netz funktionieren. Wird beim Abmelden gelöscht. */
    const CACHE = 'tb_cache_v1_';
    const cacheGet = k => { try { return JSON.parse(localStorage.getItem(CACHE + k)); } catch (e) { return null; } };
    const cacheSet = (k, v) => { try { localStorage.setItem(CACHE + k, JSON.stringify(v)); } catch (e) {} };
    function clearCache() {
        try { Object.keys(localStorage).filter(k => k.startsWith(CACHE)).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    }
    const isNetErr = e => !navigator.onLine || /fetch|network|load failed|timeout/i.test(String(e && (e.message || e)));
    const check = ({ data, error }) => { if (error) throw error; return data; };
    /* Hängende Anfragen (schwaches Netz, App aus dem Hintergrund) nach ms abbrechen; „timeout“ gilt als Netzfehler */
    const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    async function getSession() {
        if (!sb) return null;
        try { return (await withTimeout(sb.auth.getSession(), 6000)).data.session; } catch (e) { return null; }
    }

    /* Anzeigename aus overall_profiles (display_name); ohne Eintrag oder offline → E-Mail */
    async function displayName(session) {
        if (!session) return '';
        const key = 'name_' + session.user.id;
        try {
            const row = check(await withTimeout(sb.from('overall_profiles').select('display_name').eq('id', session.user.id).maybeSingle(), 8000));
            const name = (row && row.display_name || '').trim();
            cacheSet(key, name);
            return name || session.user.email;
        } catch (e) {
            return cacheGet(key) || session.user.email;
        }
    }

    /* Flaggen aller Reisen – auch ohne Login sichtbar (nur Flaggen, keine Details) */
    async function publicFlags() {
        if (!sb) return cacheGet('flags') || [];
        try {
            const rows = check(await withTimeout(sb.rpc('travelbase_get_public_flags'), 10000));
            const flags = rows.map(r => r.flags || []);
            cacheSet('flags', flags);
            return flags;
        } catch (e) {
            return cacheGet('flags') || [];
        }
    }

    /* Reisen des angemeldeten Benutzers inkl. Rolle (Admins von TravelBase sehen alle Reisen als admin) */
    async function myTrips() {
        const session = await getSession();
        if (!session) return null;
        try {
            const list = check(await withTimeout(sb.rpc('travelbase_my_trips'), 12000));
            cacheSet('trips_' + session.user.id, list);
            TB.lastSync = new Date();
            return { list, offline: false };
        } catch (e) {
            const cached = cacheGet('trips_' + session.user.id);
            if (cached && isNetErr(e)) return { list: cached, offline: true };
            throw e;
        }
    }

    /* Nur für Admins: wer auf welchen Reisen welche Rolle hat (ohne einen selbst). Fehler → leere Liste */
    async function tripMembers() {
        const session = await getSession();
        if (!session) return [];
        const key = 'members_' + session.user.id;
        try {
            const list = check(await withTimeout(sb.rpc('travelbase_trip_members_overview'), 10000));
            cacheSet(key, list);
            return list;
        } catch (e) { return cacheGet(key) || []; }
    }

    /* Vielleicht-Reise: Startdatum setzen (null = wieder offen). Das Ende rechnet die Datenbank aus dem Tagesplan. */
    async function setTripStart(tripId, start) {
        const res = check(await withTimeout(sb.rpc('travelbase_set_trip_start', { p_trip: tripId, p_start: start || null }), 10000));
        clearCache();
        return res && res[0];
    }

    const SECTION_ORDER = { guest: 0, member: 1, admin: 2 };

    /* Inhalte einer Reise laden. Rückgabe:
       null            → nicht angemeldet
       { denied:true } → angemeldet, aber kein Mitglied dieser Reise
       { trip, role, data, user, offline } → OK (data = alle Abschnitte, die die Rolle sehen darf) */
    async function loadTrip(slug) {
        const cached = cacheGet('trip_' + slug);
        const session = await getSession();
        if (!session) return (cached && !navigator.onLine) ? { ...cached, offline: true } : null;
        if (cached && cached.userId !== session.user.id) clearCache();
        try {
            const trip = check(await withTimeout(sb.from('travelbase_trips').select('id, slug, title, flags, start_date, end_date, tentative').eq('slug', slug).maybeSingle(), 12000));
            if (!trip) return { denied: true };
            const myRole = check(await withTimeout(sb.rpc('travelbase_trip_role', { p_trip: trip.id }), 10000));
            const [secsRes, name] = await withTimeout(Promise.all([sb.from('travelbase_trip_sections').select('key, min_role, updated_at, data').eq('trip_id', trip.id), displayName(session)]), 12000);
            const secs = check(secsRes);
            secs.sort((a, b) => (SECTION_ORDER[a.key] ?? 9) - (SECTION_ORDER[b.key] ?? 9));
            const result = {
                trip, role: myRole || 'guest',
                data: Object.assign({}, ...secs.map(s => s.data)),
                /* Wo welcher Schlüssel liegt (für das Speichern einzelner Bereiche, siehe saveSection) */
                sections: secs.map(s => ({ key: s.key, min_role: s.min_role, updated_at: s.updated_at, keys: Object.keys(s.data || {}) })),
                user: { email: session.user.email, name }, userId: session.user.id, savedAt: Date.now()
            };
            cacheSet('trip_' + slug, result);
            TB.lastSync = new Date();
            return { ...result, offline: false };
        } catch (e) {
            if (cached && cached.userId === session.user.id && isNetErr(e)) return { ...cached, offline: true };
            throw e;
        }
    }

    /* ---------- Live-Planung: Reisen anlegen, Bereiche speichern ---------- */

    /* Eigene Rolle in der App TravelBase (admin/member/guest/null); offline aus dem Cache */
    async function appRole() {
        const session = await getSession();
        if (!session) return null;
        const key = 'approle_' + session.user.id;
        try {
            const r = check(await withTimeout(sb.rpc('overall_app_role', { p_app: 'travelbase' }), 8000));
            cacheSet(key, r || null);
            return r || null;
        } catch (e) { return cacheGet(key); }
    }

    /* Teil-Update eines Abschnitts: patch = { places: …, plans: … } ersetzt diese Schlüssel, null entfernt sie.
       expected = updated_at des geladenen Stands → Konflikt, falls jemand anderes inzwischen gespeichert hat. */
    async function saveSection(tripId, key, patch, minRole, expected) {
        const res = check(await withTimeout(sb.rpc('travelbase_save_trip_section', {
            p_trip_id: tripId, p_key: key, p_patch: patch, p_min_role: minRole || null, p_expected: expected || null
        }), 15000));
        TB.lastSync = new Date();
        return res;
    }
    /* Zuletzt geladenen Stand einer Reise im Offline-Cache nachziehen (nach dem Speichern) */
    function updateTripCache(slug, fn) {
        const c = cacheGet('trip_' + slug);
        if (!c) return;
        try { fn(c); cacheSet('trip_' + slug, c); } catch (e) {}
    }

    const rpc = (name, args, ms) => withTimeout(sb.rpc(name, args), ms || 15000).then(check);
    async function createTrip(o) {
        const r = await rpc('travelbase_create_trip', { p_slug: o.slug, p_title: o.title, p_flags: o.flags || [],
            p_start_date: o.start || null, p_end_date: o.end || null, p_tentative: !!o.tentative });
        clearCacheKey('trips_');
        return r;
    }
    async function duplicateTrip(sourceId, slug, title, tentative = true) {
        const r = await rpc('travelbase_duplicate_trip', { p_source_trip_id: sourceId, p_new_slug: slug, p_new_title: title, p_tentative: tentative });
        clearCacheKey('trips_');
        return r;
    }
    /* Reise löschen (nur TravelBase-Admins), Bestätigung über die Kennung; Mitglieder, Abschnitte usw. löscht die DB mit */
    async function deleteTrip(tripId, confirmSlug) {
        const r = await rpc('travelbase_delete_trip', { p_trip_id: tripId, p_confirm_slug: confirmSlug });
        clearCacheKey('trips_');
        clearCacheKey('trip_' + r.slug);
        clearCacheKey('summaries_');
        return r;
    }
    /* Status (nur TravelBase-Admins): tentative = „Vielleicht“, archived = Archiv; null/undefined = unverändert */
    async function setTripStatus(tripId, o) {
        const r = await rpc('travelbase_admin_set_trip_status', { p_trip: tripId, p_tentative: o.tentative ?? null, p_archived: o.archived ?? null });
        clearCacheKey('trips_');
        return r;
    }
    /* Adresse einer Reise relativ zur Übersicht: alle Reisen laufen über die eine Seite reise/?r=<slug>,
       nur Reisen mit eigener Seite (OWN_PAGE) über ihren Ordner. Alte Ordner-Links leiten weiter. */
    const OWN_PAGE = ['thailand-2027'];
    const tripUrl = (slug, hash = '') => (OWN_PAGE.includes(slug) ? encodeURIComponent(slug) + '/' : 'reise/?r=' + encodeURIComponent(slug)) + hash;
    const inviteMember = (tripId, email, role) => rpc('travelbase_invite_member', { p_trip: tripId, p_email: email, p_role: role });
    /* Kennzahlen je Reise (Stopps, Unterkünfte, Storno-Fristen); ohne die RPC (SQL noch nicht eingespielt) → leer */
    async function tripSummaries() {
        const session = await getSession();
        if (!session) return [];
        const key = 'summaries_' + session.user.id;
        try { const l = await rpc('travelbase_trip_summaries', {}, 10000); cacheSet(key, l); return l; }
        catch (e) { return cacheGet(key) || []; }
    }
    function clearCacheKey(prefix) {
        try { Object.keys(localStorage).filter(k => k.startsWith(CACHE + prefix)).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    }

    /* ---------- Sicheres HTML für Inhalte, die Mitreisende schreiben ----------
       Erlaubt einfache Formatierung (b, i, br, a, Listen …) aus älteren Reisedaten, entfernt alles andere
       (Skripte, Event-Attribute, javascript:-Links). Reiner Text: Zeilenumbrüche werden <br>. */
    const OK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'BR', 'SMALL', 'SPAN', 'A', 'UL', 'OL', 'LI', 'P', 'DIV', 'SUB', 'SUP', 'CODE', 'MARK', 'svg', 'use']);
    const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'LINK', 'META', 'BASE', 'IMG', 'VIDEO', 'AUDIO', 'math', 'script', 'style', 'foreignObject', 'iframe']);
    const SAFE_STYLE = /^\s*((color|background|background-color|font-weight|font-style|text-decoration|white-space)\s*:\s*[#\w\s.,%()-]+;?\s*)*$/i;
    function clean(node) {
        [...node.childNodes].forEach(n => {
            if (n.nodeType === 3) return;
            if (n.nodeType !== 1) { n.remove(); return; }
            if (DROP_TAGS.has(n.tagName)) { n.remove(); return; }
            clean(n);
            if (!OK_TAGS.has(n.tagName)) { n.replaceWith(...n.childNodes); return; }
            [...n.attributes].forEach(a => {
                const name = a.name.toLowerCase(), v = a.value;
                const ok = name === 'class' ? /^[\w\s-]*$/.test(v)
                    : name === 'style' ? SAFE_STYLE.test(v) && !/url|expression|image/i.test(v)
                    : name === 'href' ? (n.tagName === 'use' ? /^#i-[\w-]+$/.test(v) : /^(https?:|mailto:|tel:|#)/i.test(v.trim()))
                    : n.tagName === 'A' && (name === 'target' || name === 'rel') || name === 'aria-hidden';
                if (!ok) n.removeAttribute(a.name);
            });
            if (n.tagName === 'A') { n.setAttribute('rel', 'noopener noreferrer'); if (!/^#/.test(n.getAttribute('href') || '')) n.setAttribute('target', '_blank'); }
        });
    }
    function safeHtml(s) {
        if (s == null || s === '') return '';
        s = String(s);
        if (!/[<>]/.test(s)) return s.replace(/\n/g, '<br>');
        const t = document.createElement('template');
        t.innerHTML = s;
        clean(t.content);
        return t.innerHTML;
    }
    /* Farben aus Reisedaten nur als #rgb/#rrggbb(aa) oder var(--…) durchlassen */
    const safeColor = (c, fallback = 'var(--p1)') => /^#[0-9a-f]{3,8}$/i.test(String(c || '').trim()) || /^var\(--[\w-]+\)$/.test(String(c || '').trim()) ? String(c).trim() : fallback;
    const safeUrl = u => /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '';

    /* In die Zwischenablage (Buchungscode, Befehle); gibt true/false zurück */
    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch (e) {
            const ta = Object.assign(document.createElement('textarea'), { value: text });
            ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
            document.body.appendChild(ta); ta.select();
            let ok = false; try { ok = document.execCommand('copy'); } catch (x) {}
            ta.remove();
            return ok;
        }
    }

    async function signIn(email, password) {
        if (!sb) throw new Error('Supabase ist noch nicht eingerichtet (shared/config.js).');
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
    }

    async function signOut() {
        clearCache();
        if (sb) { try { await sb.auth.signOut(); } catch (e) {} }
    }

    async function resetPassword(email) {
        if (!sb) throw new Error('Supabase ist noch nicht eingerichtet.');
        const redirectTo = location.origin + location.pathname.replace(/[^/]*$/, '');
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
    }

    async function updatePassword(password) {
        /* Aus Datenlecks bekannte Passwörter ablehnen (Prüfung im gemeinsamen Konto-Modul) */
        const leaks = window.OverallAccount ? await OverallAccount.pwnedCount(password) : 0;
        if (leaks) throw new Error(OverallAccount.pwnedText(leaks));
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
    }

    /* Backup (nur Admins): alle Tabellen der Reisen, in denen der Benutzer Admin ist, als ein JSON-Objekt.
       Läuft mit dem Login des Admins – die Zugriffsregeln der Datenbank gelten also wie sonst auch. */
    const BACKUP_TABLES = ['travelbase_trips', 'travelbase_trip_sections', 'travelbase_trip_members', 'travelbase_todos', 'travelbase_packlist_items', 'travelbase_activities'];
    async function exportBackup() {
        const session = await getSession();
        if (!session) throw new Error('Bitte zuerst anmelden.');
        const mine = check(await sb.rpc('travelbase_my_trips'));
        const ids = mine.filter(r => r.role === 'admin').map(r => r.id);
        if (!ids.length) throw new Error('Du bist bei keiner Reise Admin.');
        const tables = {}, errors = {};
        for (const t of BACKUP_TABLES) {
            try {
                const rows = [];
                for (let from = 0; ; from += 1000) {
                    const page = check(await sb.from(t).select('*').in(t === 'travelbase_trips' ? 'id' : 'trip_id', ids).range(from, from + 999));
                    rows.push(...page);
                    if (page.length < 1000) break;
                }
                tables[t] = rows;
            } catch (e) { errors[t] = String(e && (e.message || e)); }
        }
        return { app: 'TravelBase', version: 2, exportedAt: new Date().toISOString(), exportedBy: session.user.email, tables, errors };
    }

    /* Deutsche Fehlermeldungen für die häufigsten Fälle */
    function errorText(e) {
        const m = String(e && (e.message || e));
        if (/invalid login credentials/i.test(m)) return 'E-Mail oder Passwort ist falsch.';
        if (/email not confirmed/i.test(m)) return 'Diese E-Mail ist noch nicht bestätigt.';
        if (/password should be at least|weak password/i.test(m)) return 'Das Passwort ist zu kurz oder zu einfach (mind. 8 Zeichen empfohlen).';
        if (/rate limit|too many/i.test(m)) return 'Zu viele Versuche – bitte kurz warten.';
        if (isNetErr(e)) return 'Keine Verbindung zum Server. Bist du online?';
        if (/could not find the function|PGRST202/i.test(m)) return 'Diese Funktion ist in der Datenbank noch nicht eingerichtet (SQL-Update für supabase-core fehlt).';
        return m;
    }

    window.TB = { sb, configured, withTimeout, cacheGet, cacheSet, isNetErr, getSession, displayName, publicFlags, myTrips, tripMembers, setTripStart, loadTrip, signIn, signOut, resetPassword, updatePassword, clearCache, errorText, exportBackup,
        appRole, saveSection, updateTripCache, createTrip, duplicateTrip, deleteTrip, setTripStatus, tripUrl, inviteMember, tripSummaries, safeHtml, safeColor, safeUrl, copyText,
        onAuth: cb => sb && sb.auth.onAuthStateChange((ev, session) => cb(ev, session)) };
})();
