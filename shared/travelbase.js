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

    async function getSession() {
        if (!sb) return null;
        try { return (await sb.auth.getSession()).data.session; } catch (e) { return null; }
    }

    /* Anzeigename aus der Tabelle profiles (display_name); ohne Eintrag oder offline → E-Mail */
    async function displayName(session) {
        if (!session) return '';
        const key = 'name_' + session.user.id;
        try {
            const row = check(await sb.from('profiles').select('display_name').eq('id', session.user.id).maybeSingle());
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
            const rows = check(await sb.rpc('get_public_flags'));
            const flags = rows.map(r => r.flags || []);
            cacheSet('flags', flags);
            return flags;
        } catch (e) {
            return cacheGet('flags') || [];
        }
    }

    /* Reisen des angemeldeten Benutzers inkl. Rolle */
    async function myTrips() {
        const session = await getSession();
        if (!session) return null;
        try {
            const rows = check(await sb.from('trip_members')
                .select('role, trips(slug, title, flags, start_date, end_date, sort_order)')
                .eq('user_id', session.user.id));
            const list = rows.filter(r => r.trips).map(r => ({ role: r.role, ...r.trips }));
            cacheSet('trips_' + session.user.id, list);
            return { list, offline: false };
        } catch (e) {
            const cached = cacheGet('trips_' + session.user.id);
            if (cached && isNetErr(e)) return { list: cached, offline: true };
            throw e;
        }
    }

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
            const trip = check(await sb.from('trips').select('id, slug, title, flags, start_date, end_date').eq('slug', slug).maybeSingle());
            if (!trip) return { denied: true };
            const mem = check(await sb.from('trip_members').select('role').eq('trip_id', trip.id).eq('user_id', session.user.id).maybeSingle());
            const [secsRes, name] = await Promise.all([sb.from('trip_sections').select('key, data').eq('trip_id', trip.id), displayName(session)]);
            const secs = check(secsRes);
            const order = { guest: 0, member: 1, admin: 2 };
            secs.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9));
            const result = {
                trip, role: mem ? mem.role : 'guest',
                data: Object.assign({}, ...secs.map(s => s.data)),
                user: { email: session.user.email, name }, userId: session.user.id, savedAt: Date.now()
            };
            cacheSet('trip_' + slug, result);
            return { ...result, offline: false };
        } catch (e) {
            if (cached && cached.userId === session.user.id && isNetErr(e)) return { ...cached, offline: true };
            throw e;
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
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
    }

    /* Backup (nur Admins): alle Tabellen der Reisen, in denen der Benutzer Admin ist, als ein JSON-Objekt.
       Läuft mit dem Login des Admins – die Zugriffsregeln der Datenbank gelten also wie sonst auch. */
    const BACKUP_TABLES = ['trips', 'trip_sections', 'trip_members', 'todos', 'packlist_items'];
    async function exportBackup() {
        const session = await getSession();
        if (!session) throw new Error('Bitte zuerst anmelden.');
        const mine = check(await sb.from('trip_members').select('trip_id, role').eq('user_id', session.user.id));
        const ids = mine.filter(r => r.role === 'admin').map(r => r.trip_id);
        if (!ids.length) throw new Error('Du bist bei keiner Reise Admin.');
        const tables = {}, errors = {};
        for (const t of BACKUP_TABLES) {
            try {
                const rows = [];
                for (let from = 0; ; from += 1000) {
                    const page = check(await sb.from(t).select('*').in(t === 'trips' ? 'id' : 'trip_id', ids).range(from, from + 999));
                    rows.push(...page);
                    if (page.length < 1000) break;
                }
                tables[t] = rows;
            } catch (e) { errors[t] = String(e && (e.message || e)); }
        }
        return { app: 'TravelBase', version: 1, exportedAt: new Date().toISOString(), exportedBy: session.user.email, tables, errors };
    }

    /* Deutsche Fehlermeldungen für die häufigsten Fälle */
    function errorText(e) {
        const m = String(e && (e.message || e));
        if (/invalid login credentials/i.test(m)) return 'E-Mail oder Passwort ist falsch.';
        if (/email not confirmed/i.test(m)) return 'Diese E-Mail ist noch nicht bestätigt.';
        if (/password should be at least|weak password/i.test(m)) return 'Das Passwort ist zu kurz oder zu einfach (mind. 8 Zeichen empfohlen).';
        if (/rate limit|too many/i.test(m)) return 'Zu viele Versuche – bitte kurz warten.';
        if (isNetErr(e)) return 'Keine Verbindung zum Server. Bist du online?';
        return m;
    }

    window.TB = { sb, configured, cacheGet, cacheSet, isNetErr, getSession, displayName, publicFlags, myTrips, loadTrip, signIn, signOut, resetPassword, updatePassword, clearCache, errorText, exportBackup,
        onAuth: cb => sb && sb.auth.onAuthStateChange((ev, session) => cb(ev, session)) };
})();
