/* TravelBase – Flugkarten (Thailand-Seite und Reise-Vorlage)
   Ein Flug in den Reisedaten (Abschnitt "flights") kann strukturiert angelegt werden:
     {
       "label":   "Hinflug Thailand",                                         Art des Flugs
       "from":    { "code": "VIE", "city": "Wien",    "date": "2027-01-01", "time": "15:30" },
       "to":      { "code": "BKK", "city": "Bangkok", "date": "2027-01-02", "time": "13:40" },
       "stops":   [{ "code": "RUH", "city": "Riad", "time": "15:45–17:15" }], Zwischenstopps (time optional)
       "dur":     "16 Std. 10 Min.",                                           Reisezeit (optional, auch "ca. 14–17 Std.")
       "airline": "Saudia Airlines", "flightNos": ["SV152", "SV846"],
       "who":     ["Ines", "Stefan"],
       "cost":    "349,90 € p.P.",
       "status":  "https://…",                                                 Link zur Flugstatus-Seite der Airline
       "planned": true,                                                        noch nicht gebucht → Hinweis „Geplant“
       "note":    "Nachtflug, …"                                               freie Zusatzinfo
     }
   Fehlende Angaben werden einfach weggelassen (z. B. Uhrzeiten bei noch nicht gebuchten Flügen).
   Ältere Einträge (date/route/details/price als Text) zeigt die Seite weiter wie bisher an.
   Im JS: tbFlights.isCard(f) → strukturiert?  tbFlights.card(f) → <li>…</li> als Text */
(function () {
    'use strict';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = n => window.tbIcon ? tbIcon(n) : '';
    const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const utc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    const fmtDate = iso => ISO.test(iso || '') ? `${DAYS[new Date(utc(iso)).getUTCDay()]}, ${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : esc(iso || '');
    const fmtShort = iso => ISO.test(iso || '') ? `${DAYS[new Date(utc(iso)).getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : esc(iso || '');
    const dayDiff = (a, b) => ISO.test(a || '') && ISO.test(b || '') ? Math.round((utc(b) - utc(a)) / 864e5) : 0;
    const list = v => Array.isArray(v) ? v : (v ? [v] : []);

    function end(p, side, other) {
        p = p || {};
        const code = p.code || p.city || '?';
        const long = code.length > 4;
        let when = '';
        if (p.time) {
            const plus = side === 'to' ? dayDiff(other && other.date, p.date) : 0;
            when = `<span class="flc-time">${esc(p.time)}${plus > 0 ? `<sup>+${plus}</sup>` : ''}</span>`;
        }
        const city = p.code && p.city ? `<span class="flc-city">${esc(p.city)}</span>` : '';
        /* ohne Uhrzeit (noch nicht gebucht) steht das Datum unter dem Ort, sofern es vom Abflugtag abweicht */
        const date = !p.time && side === 'to' && dayDiff(other && other.date, p.date) > 0 ? `<span class="flc-city">${fmtShort(p.date)}</span>` : '';
        return `<div class="flc-end flc-${side}">${when}<span class="flc-code${long ? ' is-long' : ''}">${esc(code)}</span>${city}${date}</div>`;
    }

    function card(f) {
        const stops = list(f.stops);
        /* bei geplanten Flügen ohne bekannte Stopps nicht „Direkt“ behaupten */
        const stopText = stops.length ? `${stops.length} Stopp${stops.length > 1 ? 's' : ''} · ${stops.map(s => esc(s.code || s.city)).join(', ')}` : (f.planned ? '' : 'Direkt');
        const stopDetail = stops.filter(s => s.time).map(s => `Stopp ${esc(s.city || s.code)}: ${esc(s.time)}`).join(' · ');
        const nos = list(f.flightNos);
        const who = list(f.who);
        const head = [fmtDate(f.from && f.from.date), f.label ? esc(f.label) : ''].filter(Boolean).join(' · ');
        const status = f.status ? `<a class="flc-status" href="${esc(f.status)}" target="_blank" rel="noopener">${ic('external')}Flugstatus</a>` : '';
        return `
            <li class="flc${f.planned ? ' is-planned' : ''}">
                <div class="flc-head">
                    <span class="flc-day">${ic('calendar')}${head}</span>
                    ${f.planned ? '<span class="flc-tag">Geplant</span>' : ''}
                </div>
                <div class="flc-route">
                    ${end(f.from, 'from')}
                    <div class="flc-mid">
                        ${f.dur ? `<span class="flc-dur">${esc(f.dur)}</span>` : ''}
                        <span class="flc-line${stops.length ? ' has-stops' : ''}" aria-hidden="true">${stops.map(() => '<i></i>').join('')}${ic('plane')}</span>
                        ${stopText ? `<span class="flc-stops${stops.length ? '' : ' is-direct'}">${stopText}</span>` : ''}
                    </div>
                    ${end(f.to, 'to', f.from)}
                </div>
                ${stopDetail ? `<div class="flc-note">${ic('clock')}${stopDetail}</div>` : ''}
                ${f.note ? `<div class="flc-note">${ic('info')}${esc(f.note)}</div>` : ''}
                ${f.airline || nos.length ? `<div class="flc-airline">${ic('plane')}<span>${esc(f.airline || '')}</span>${nos.map(n => `<span class="flc-no">${esc(n)}</span>`).join('')}</div>` : ''}
                ${who.length || f.cost || status ? `<div class="flc-foot">
                    ${who.length ? `<span class="flc-who">${ic('users')}${who.map(esc).join(', ')}</span>` : ''}
                    ${f.cost ? `<span class="flc-cost">${esc(f.cost)}</span>` : ''}
                    ${status}
                </div>` : ''}
            </li>`;
    }

    window.tbFlights = { isCard: f => !!(f && f.from && f.to), card };
})();
