# CLAUDE.md – TravelBase

Reiseplanungs-PWA (Repo `mvs2-bot/TravelBase`, ausgeliefert über GitHub Pages). Die Seiten sind **leere Hüllen**:
alle Reiseinhalte liegen in Supabase und werden erst nach dem Login geladen. UI-Texte, Kommentare und
Fehlermeldungen sind **deutsch**.

## Tech-Stack

- **Vanilla HTML/CSS/JS, kein Build-Tool, kein npm, kein Framework.** Jede Datei wird so ausgeliefert, wie sie im Repo liegt.
  Module sind IIFEs, die ein globales Objekt auf `window` setzen (`TB`, `tbIcon`, `tbFlights`, `TBActivities`, `TBTripMobile`, `OverallAccount`).
- Bibliotheken nur per CDN mit fester Version: `@supabase/supabase-js@2.45.4`, `leaflet@1.9.4`, `chart.js@4.4.1`, Flaggen-Polyfill.
  Eine Versionsänderung muss auch in `sw.js` (`EXTRA`) nachgezogen werden.
- **Supabase** (zentrales Projekt, Schema im Repo `supabase-core`): Auth (E-Mail/Passwort), Postgres mit RLS, RPCs, Storage-Bucket `avatars` (privat).
  Tabellen mit Präfix `travelbase_`, Profile in `overall_profiles`, App-Zugang über `overall_app_access`.
  Schema-/RLS-Änderungen gehören nach `supabase-core`, nicht hierher.
- GitHub Action `.github/workflows/supabase-keepalive.yml` pingt alle 3 Tage `travelbase_get_public_flags`, damit das Free-Projekt nicht pausiert.

## Struktur

```
index.html            Login + Übersicht „Alle Reisen“ (ohne Login nur Flaggen); eigenes <style> mit denselben Tokens
verwaltung.html       nur Weiterleitung auf /admin.html (Dashboard-Root-Repo)
<slug>/index.html     eine Reise pro Ordner; Ordnername = travelbase_trips.slug (TRIP_SLUG wird aus dem Pfad gelesen)
shared/trip-template.html  Vorlage für alle Reisen außer Thailand
thailand-2027/        Sonderfall: eigene, große Seite mit Inline-JS (eigene To-Do-, Packlisten- und Aktivitäten-Logik), nutzt aber trip.css und die shared-Module
sw.js, manifest.json  ein Service Worker / eine PWA für Übersicht und alle Reisen (Scope ./)
icons/                PWA-Icons
```

Neue Reise: Zeile in `travelbase_trips` + `travelbase_trip_sections` anlegen, Ordner `<slug>/` mit einer **unveränderten Kopie**
von `shared/trip-template.html` als `index.html`, Mitglieder per `travelbase_add_trip_member('<slug>', '<email>', '<rolle>')`.
Änderungen an der Vorlage in alle Vorlagen-Ordner kopieren (`suedamerika-2027*` sind derzeit ältere Kopien, z. B. fehlt `#calMonth`).
Import-Skripte mit Reisedaten gehören **nicht** ins Repo.

## Module unter `shared/`

| Datei | Aufgabe |
|---|---|
| `config.js` | `window.TB_CONFIG = { url, key }` – Project-URL + **Publishable Key**. Öffentlich. |
| `travelbase.js` | `window.TB`: Supabase-Client (`TB.sb`), Login/Logout/Passwort, `loadTrip(slug)`, `myTrips()`, `publicFlags()`, `tripMembers()`, `setTripStart()`, `exportBackup()`, `errorText()`, `withTimeout()`, `isNetErr()`, Offline-Cache `cacheGet/cacheSet/clearCache`. |
| `trip.js` | Reise-Vorlage: baut die ganze Seite aus `data` (Karte/Leaflet, Tagespläne, Kalender, Flüge, Infos, To-Dos, Klima …), Tabs/Hash-Navigation, Theme-Umschalter, SW-Registrierung. Lädt `activities.js` bei Bedarf nach. |
| `trip.css` | Design-System + Layout für Vorlage **und** Thailand, inkl. Mobile-Ansicht (< 768 px). |
| `trip-mobile.js` | `TBTripMobile`: Handy-Ansicht im iOS-Einstellungen-Stil (Start-Übersicht, Route-Zeitstrahl, Zurück-Button) + schwebende Tabbar *Start · Karte · Route · Infos*. Daten kommen per `setData()/setTile()` von der Seite. Braucht `.pop-btn[data-t]` und `.pane`. Desktop unverändert. |
| `activities.js` | `TBActivities.init({ tripId, slug, stops })` / `open(name, num, el)`: mögliche Aktivitäten pro Ort (Unterseite `#activities` + Modal), Tabelle `travelbase_activities`, verknüpft über `trip_id + location_name`. |
| `flights.js` | `tbFlights.isCard(f)` / `card(f)`: strukturierte Flugkarten (Schema im Dateikopf); alte Text-Einträge bleiben kompatibel. |
| `icons.js` | SVG-Sprite + `tbIcon(name, cls)`. |
| `profile.js` | Profil-Button `#tbProfileBtn` + Menü (Name, Rolle, Cloud-Sync-Status, Dashboard, `/konto.html`, `/admin.html`, Abmelden). Liest `overall_profiles` und RPC `overall_app_role`. |
| `overall-account.js` | **Kopie** – Original in `supabase-core`. Gemeinsames Konto-Modul (Profilbild, Passwort inkl. Pwned-Check). Hier nicht ändern, sondern im Original und dann kopieren. |
| `ios-nav.js` | **Kopie** – Original in `mvs2-bot.github.io`. Zurück/Neu-laden-Leiste nur für installierte iOS-Web-Apps (`navigator.standalone`), Test mit `?iosnav=1`. |
| `flags.css` | Flaggen-Emoji-Schrift (Windows-Fix). |

Ladereihenfolge in jeder Seite: supabase-js → `icons.js` → `config.js` → `travelbase.js` → `overall-account.js` → (`trip-mobile.js`, `flights.js`) → `profile.js` → `trip.js`/Inline-Code; `ios-nav.js` mit `defer`.
Module greifen defensiv aufeinander zu (`window.tbIcon ? tbIcon(n) : ''`), weil ältere Seiten aus dem Cache Teile evtl. nicht haben.

## Daten & Offline

- `TB.loadTrip(slug)` → `null` (nicht angemeldet) | `{ denied: true }` | `{ trip, role, data, user, offline }`.
  `data` = Merge aller `travelbase_trip_sections`, die RLS der Rolle liefert (Reihenfolge guest → member → admin).
  Welche Bereiche erscheinen, entscheidet allein, welche Daten ankommen.
- **Offline-Cache:** `TB.cacheSet(key, v)` / `TB.cacheGet(key)` (localStorage, Präfix `tb_cache_v1_`, pro Benutzer-ID geschlüsselt).
  Muster: online laden → `cacheSet`; bei `TB.isNetErr(e)` → `cacheGet` + Offline-Banner. Schreiben nur online (`editable()`-Prüfung), sonst Hinweis.
  `signOut()` und Benutzerwechsel leeren den Cache.
- Netzaufrufe immer mit `TB.withTimeout(...)` (hängende Requests gelten als Netzfehler).
- **Service Worker `sw.js`:** eigene Dateien network-first (4 s, `no-cache`) mit Cache-Fallback; CDN/Schriften cache-first;
  Kartenkacheln gecacht (max. 500); **Supabase-Requests werden nie gecacht**. Bei neuen/umbenannten shared-Dateien `CORE` anpassen
  und die Version `V` (`travelbase-vNN`) hochzählen.
- `exportBackup()` (nur Admins): JSON aller `BACKUP_TABLES` der Reisen, auf denen man Admin ist – läuft mit dem Login des Admins, RLS gilt.
  Neue `travelbase_`-Tabellen dort ergänzen.
- Test-Hilfe: `?heute=YYYY-MM-DD` überschreibt „heute“ in der Vorlage.

## Design-System

- Apple-inspiriert (wie Dashboard und „Zuhause“): Systemschrift, Basis 14 px, weiße Karten auf grauem Grund, Radius 18/12 px, dezente Schatten.
  Akzent TravelBase: Ozeanblau `#1f6fb2` (hell) / `#6cb4f0` (dunkel).
- **Nur CSS-Variablen verwenden**, keine Hartfarben: `--bg --card --well --hover --line --sep --ink --text --mute --p1 --p1-soft --p1-line --on-p1
  --ok --warn --danger (+ -soft) --radius --radius-s --shadow --font`; Aliase `--accent --border --card-hover` für geteilte Module.
- Dark Mode über `data-theme="dark"` auf `<html>` (`:root[data-theme="dark"]` überschreibt die Tokens). Gesetzt per Inline-Script im `<head>` vor dem Rendern,
  gespeichert in `localStorage['overall-theme']` (gemeinsam mit den anderen Apps; Altschlüssel `tb_theme_v1`). `meta[name=theme-color]` mitziehen.
- Mobil (< 768 px, Media Query in `trip.css`): schwebende Tabbar `.m-tabbar` mit aktiver Seite als Pille, Safe-Area-Insets beachten.
- **Icons ausschließlich über `tbIcon('name')`** (JS) bzw. `<svg class="ic"><use href="#i-name"></use></svg>` (HTML) aus `shared/icons.js`.
  Neue Symbole dort in `P` ergänzen (24er viewBox, Linienstil, kein fill). Keine Emojis als UI-Symbole – Flaggen/Emojis in Reisedaten sind Inhalt.
- Nutzerdaten vor dem Einfügen in HTML immer mit `esc()` escapen.

## Rollen & Sicherheit

- Rollen pro Reise: **`admin`** (alles, Startdatum bei Vielleicht-Reisen setzen, Mitgliederübersicht, Backup), **`member`** (Mitreisende: Details, To-Dos,
  Packliste, Aktivitäten bearbeiten), **`guest`** (nur Karte & Zeitraum, Abschnitt `guest`). Abschnitte tragen `min_role`.
  TravelBase-Admins (`overall_app_access`) sehen jede Reise als Admin.
- Die Rolle im Frontend (`res.role`) steuert **nur die Anzeige**. Die eigentliche Absicherung macht RLS in Supabase
  (`travelbase_trip_role`, `travelbase_my_trips`, `travelbase_trip_members_overview` …). Nie Rechte nur im JS prüfen.
- **Keine Secrets im Repo.** `shared/config.js` ist auf GitHub Pages öffentlich: dort steht nur URL + Publishable Key (`sb_publishable_…`).
  Niemals `secret`/`service_role`-Keys, Passwörter, Tokens oder echte Reise-/Personendaten in Dateien, Kommentare oder Workflows schreiben.
  Für die Action ggf. Repo-Secrets `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`.
- Seiten tragen `noindex, nofollow`.
