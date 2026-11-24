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
index.html            Login + Übersicht „Alle Reisen“ (ohne Login nur Flaggen); eigenes <style> mit denselben Tokens;
                      ab 1100 px Seitenleiste `.li-side` (Kennzahlen `#deskStats`, „Neue Reise“, Konto), nächste Reise als große Kachel
verwaltung.html       nur Weiterleitung auf /admin.html (Dashboard-Root-Repo)
<slug>/index.html     eine Reise pro Ordner; Ordnername = travelbase_trips.slug (TRIP_SLUG wird aus dem Pfad gelesen)
shared/trip-template.html  Vorlage für alle Reisen außer Thailand
thailand-2027/        Sonderfall: eigene, große Seite mit Inline-JS (eigene To-Do-, Packlisten- und Aktivitäten-Logik), nutzt aber trip.css und die shared-Module
sw.js, manifest.json  ein Service Worker / eine PWA für Übersicht und alle Reisen (Scope ./)
icons/                PWA-Icons
```

Neue Reise: in der Übersicht (`index.html`, nur TravelBase-App-Admins) über **„Neue Reise“** bzw. **„Variante klonen“**
(RPCs `travelbase_create_trip` / `travelbase_duplicate_trip`, Mitreisende per `travelbase_invite_member`). Danach Ordner `<slug>/` mit einer
**unveränderten Kopie** von `shared/trip-template.html` als `index.html` anlegen (der Dialog zeigt den Befehl zum Kopieren).
Reise löschen (z. B. Testreisen): „Mehr“ auf der Kachel → **„Reise löschen“** (nur TravelBase-App-Admins, Kennung zur Bestätigung eintippen,
RPC `travelbase_delete_trip`; Mitglieder, Abschnitte, To-Dos, Packliste, Aktivitäten löscht die DB mit, Varianten bleiben erhalten, nur ohne Verweis).
Danach den Ordner `<slug>/` aus dem Repo entfernen (der Dialog zeigt den Befehl).
Änderungen an der Vorlage in **alle** Vorlagen-Ordner kopieren (alle Ordner außer `thailand-2027/` sind identische Kopien).
Import-Skripte mit Reisedaten gehören **nicht** ins Repo.

## Module unter `shared/`

| Datei | Aufgabe |
|---|---|
| `config.js` | `window.TB_CONFIG = { url, key }` – Project-URL + **Publishable Key**. Öffentlich. |
| `travelbase.js` | `window.TB`: Supabase-Client (`TB.sb`), Login/Logout/Passwort, `loadTrip(slug)`, `myTrips()`, `publicFlags()`, `tripMembers()`, `setTripStart()`, `exportBackup()`, `errorText()`, `withTimeout()`, `isNetErr()`, Offline-Cache `cacheGet/cacheSet/clearCache/clearCacheKey`, Live-Planung `saveSection()`, `createTrip()`, `duplicateTrip()`, `deleteTrip()`, `inviteMember()`, `tripSummaries()`, `appRole()`, Sanitizer `safeHtml()/safeColor()/safeUrl()`, `copyText()`. |
| `trip.js` | Reise-Vorlage: baut die ganze Seite aus `data` (Karte/Leaflet, Tagespläne, Kalender, Flüge, Infos, To-Dos, Klima …), Tabs/Hash-Navigation, Theme-Umschalter, SW-Registrierung. Lädt `activities.js` und `planner.js` bei Bedarf nach. Hält `RAW` (DB-Stand, wird bearbeitet) und `DATA` (abgeleitet, z. B. verschobene Daten) getrennt. |
| `planner.js` | `TBPlanner.init(host)`: Live-Planung für Vorlage **und** Thailand (die Seite liefert über `host` ihre Daten-Zugriffe). Etappen im eigenen Bereich `#stops` als Zeitstrahl wie Polarsteps (Reise beginnt · Stopp-Karten · „+“ zum Einfügen dazwischen (oben rechts per Knopf `.pl-ins-tg` ein-/ausblendbar, je Gerät in `localStorage['tb_stops_ins']`, `body.pl-noins`); daneben Schalter `.pl-legs-tg` für die Verkehrsmittel-Pillen, `localStorage['tb_stops_legs']`, `body.pl-nolegs`; links davon `.pl-drag-tg` für die Ziehgriffe, `localStorage['tb_stops_drag']`, `body.pl-nodrag` = Ziehen gesperrt, Vorgabe am Touch-Gerät aus · Verkehrsmittel-Pille mit km und grober Zeit, eingetragene Transporte zwischen den Orten bestimmen das Symbol · Reiseende; sonst Split-View neben der Karte), Stopp antippen = Detail-Sheet (Zeitraum, Nächte, Reisende; darunter einklappbare Bereiche Notizen · Unterkünfte · Transporte (`.pl-d-sec`, standardmäßig zu, Transporte als kompakte Zeilen `.pl-d-tr`); „Auf der Karte“ / „Aktivitäten“ und rechts unten groß und gelb „Etappe bearbeiten“ (`.pl-d-editbtn`, Token `--yellow`/`--on-yellow`); „Keine Unterkunft nötig“ nur im Bearbeiten-Sheet unter „Anzeigen bei“), „Reise beginnt“ antippen = Reisezeitraum (nur Admins, speichert `meta.start`/`meta.end`; die RPC zieht `travelbase_trips.start_date` mit), „Neuer Stopp“ mit Kartenauswahl (Tippen setzt lat/lng, Nominatim-Reverse für den Namen) und eingeklapptem „Ort erneut besuchen“, Plus-Knopf `.pl-fab` mit Menü, Nominatim-Suche, Reihenfolge per Ziehen am Griff `.pl-handle` oder Pfeiltasten, Reisende & Farben (`persons`, nur Admins), Tagesplan-Zeilen + „leere Tage anlegen“, Unterkünfte (`stations`, Storno-Wächter, Lücken), Flüge & Transporte (`flights` mit `mode`). Bottom-Sheet `<dialog class="pl-sheet">`, Speichern über `TB.saveSection`. |
| `trip.css` | Design-System + Layout für Vorlage **und** Thailand, inkl. Mobile-Ansicht (< 768 px). |
| `trip-mobile.js` | `TBTripMobile`: Handy-Ansicht im iOS-Einstellungen-Stil (Start-Übersicht, Route-Zeitstrahl, Zurück-Button) + schwebende Tabbar *Start · Karte · (Etappen) · Route · Infos* (Etappen nur, wenn die Seite `.pop-btn[data-t="stops"]` hat). Daten kommen per `setData()/setTile()` von der Seite. Braucht `.pop-btn[data-t]` und `.pane`. Desktop unverändert. |
| `activities.js` | `TBActivities.init({ tripId, slug, stops })` / `open(name, num, el)`: mögliche Aktivitäten pro Ort (Unterseite `#activities` + Modal), Tabelle `travelbase_activities`, verknüpft über `trip_id + location_name`. Kategorien (`tags`, farbige Chips mit Symbol über `data-tag`/`TAG_IC`), `done`, „In Ablauf übernehmen“ (`planned_day`, über `TBPlanner.addToDay`); ohne die neuen Spalten läuft es im alten Umfang. `setStops()` nach Änderungen. |
| `flights.js` | `tbFlights.isCard(f)` / `card(f)`: strukturierte Karten für Flug/Zug/Fähre/Bus/Mietwagen (`mode`, Schema im Dateikopf); alte Text-Einträge bleiben kompatibel. |
| `icons.js` | SVG-Sprite + `tbIcon(name, cls)`. |
| `profile.js` | Profil-Button `#tbProfileBtn` + Menü (Name, Rolle, Cloud-Sync-Status, Dashboard, `/konto.html`, `/admin.html`, Abmelden). Liest `overall_profiles` und RPC `overall_app_role`. |
| `overall-account.js` | **Kopie** – Original in `supabase-core`. Gemeinsames Konto-Modul (Profilbild, Passwort inkl. Pwned-Check). Hier nicht ändern, sondern im Original und dann kopieren. |
| `ios-nav.js` | **Kopie** – Original in `mvs2-bot.github.io`. Zurück/Neu-laden-Leiste nur für installierte iOS-Web-Apps (`navigator.standalone`), Test mit `?iosnav=1`. |
| `flags.css` | Flaggen-Emoji-Schrift (Windows-Fix). |

Ladereihenfolge in jeder Seite: supabase-js → `icons.js` → `config.js` → `travelbase.js` → `overall-account.js` → (`trip-mobile.js`, `flights.js`, `planner.js`) → `profile.js` → `trip.js`/Inline-Code; `ios-nav.js` mit `defer`.
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
- **Live-Planung speichern:** nie direkt in `travelbase_trip_sections` schreiben, sondern `TB.saveSection(tripId, key, patch, minRole, expectedUpdatedAt)`
  → RPC `travelbase_save_trip_section`: ersetzt die genannten Top-Level-Schlüssel (`null` löscht), Konfliktschutz über `updated_at`.
  Mitglieder dürfen nur `places, routes, plans, stations, flights, days`; alles andere nur Admins. `planner.js` bearbeitet nur `RAW`
  und schreibt jeden Schlüssel in den Abschnitt, aus dem er kam (sonst `guest` für `places/routes`, `member` für den Rest).
- **Von Mitgliedern geschriebene Inhalte gelten als unsicher:** HTML-Felder nur über `rich()`/`TB.safeHtml`, Farben über `TB.safeColor`, Links über `TB.safeUrl`.
- **Unterkünfte-Ansicht** (`renderAcc`): je Etappe ein Abschnitt mit „x/y Nächte gebucht“ und kompakten Karten (`.bk-sec`, `.bk-card` in `.bk-items`; ab 900 px eine Etappe pro Zeile: links Etappe + Fortschritt, rechts die Unterkünfte, keine zwei Spalten), fehlende als „Unterkunft fehlt“ (Zähler „n fehlt“ oben, Filter „Fehlt“; Details per Knopf `.bk-det` rechts unter dem Stift; kein Adressfeld mehr – Adressen stehen in der Notiz); Unterkünfte ohne Etappe darunter (Gruppen, z. B. Thailand/Sri Lanka). Keine Tabelle mehr.
- **Etappen stehen überall ganz oben und hervorgehoben** (Reiter `.tab-main`, Menü `.pop-main`, Seitenleiste `.d-main` mit „Hier planst du die Reise“ und danach Karte · Route (Zeitstrahl `#tripRoute` wie am Handy, `body.m-route`), Handy-Start: Karte `.m-main` über den Gruppen, Tabbar Start · Etappen · Karte · Route · Infos). Ohne Hash startet die Seite weiter auf der Karte.
- **Bereiche der Vorlage** (wie Thailand): Etappen (`#stops`) · Karte · Tagespläne · **Unterkünfte** (`#acc`, eigener Bereich, sobald es Unterkünfte gibt
  oder man sie anlegen darf; `stations` als Array oder Gruppen `{ "Peru": [...] }`) · … · Flüge & Transporte (`#flights`); alter Link `#bookings` öffnet `#acc`.
  Symbol der Tagespläne ist immer `calendar` (ein Emoji in `plans[].icon` wird ignoriert). Thailand hat Etappen und getrennte Unterkünfte/Flüge; dort ist **„Ablauf“** (`#ablauf`) **eine** Liste aus `days.th` und `days.sl`
  nach Datum (alte Links `#thailand`/`#srilanka` öffnen sie; neue Tage landen per `planFor(iso)` im passenden Teil) mit kompakter Filterleiste.
- **Ablauf aus den Etappen** (Vorlage und Thailand): `TBPlanner.legDays()` liefert jeden Reisetag mit seinen Orten; Tage ohne Eintrag erscheinen
  als gestrichelte Zeile „Tag planen“ (legt den Tag mit Datum/Ort an, `editRow(plan, null, preset)`), daher füllt sich der Ablauf einer neuen Reise
  allein durch die Etappen. Ideen aus „Mögliche Aktivitäten“ (`TBActivities.ideas(name)`, Ereignis `tb:activities`) stehen am ersten Tag eines Orts;
  „In Ablauf übernehmen“ geht auch auf Etappen-Tage ohne Eintrag (`<plan>:@YYYY-MM-DD`, `addToDay` gibt die echte Referenz zurück).
- **Route (Handy) und Aktivitäten-Orte** = Etappen (gleiche Nummern/Farben); ohne Nächte wie bisher (Vorlage: Tagesplan, Thailand: Unterkünfte).
- **Art der Etappe** `places[k].kind`: `arrive` (Anreise) / `depart` (Abreise), z. B. lange Flüge mit Nächten; brauchen keine Unterkunft.
  `places[k].parallel: true` + `places[k].day0` (Tage ab Reisebeginn; im Stopp-Sheet Abschnitt „Zeitraum“ → „Parallel – eigener Beginn“ mit Datum „Beginnt am“,
  für jede Etappe): verbraucht keine Reisezeit, die Nächte zählen ab diesem Tag (z. B. eine Person reist über zwei Tage an, während die anderen unterwegs sind).
  Ältere Einträge ohne `day0` (nur mit `kind`): Anreise endet am Beginn der nächsten Etappe, Abreise beginnt am Ende der vorigen. Auch erneute Besuche (`same`) können Anreise/Abreise sein; erneut besuchen geht für alle Orte, auch unnummerierte.
  **Anwesenheitskalender** (`#cal`, Vorlage und Thailand) entsteht aus den Etappen: `TBPlanner.presence()` / `renderPresence({title, body, month})`
  je Person aus `who` der Etappen; Anreise-/Abreise-Etappen = Reisetage (gestrichelt), ohne eigene Anreise ist der erste, ohne eigene Abreise der Tag
  nach der letzten Nacht ein Reisetag; Lücken (Etappen nur anderer Personen) zählen als vor Ort. Vorlage: Tab erscheint automatisch, sobald Etappen
  Nächte und Reisende haben (alte Reisen mit `calendar` + `persons.start/end/home` ohne Etappen-Nächte wie bisher).
- **Etappe „Anzeigen bei“** (Stopp-Sheet): `places[k].noStay` (Unterkünfte), `noRoute` (Route am Handy), `noActs` (mögliche Aktivitäten, bei erneuten
  Besuchen gilt der erste Besuch; die Seite übergibt solche Orte mit `hide: true` an `TBActivities.setStops`).
- **Aktivitäten-Orte:** Orte ohne passende Etappe bleiben als eigener Abschnitt sichtbar; eindeutige alte Namen („2. Chiang Mai“, „Bangkok Stadtzentrum“)
  hängt `activities.js` beim Laden still an die Etappe um (`location_name`-Update, nur mit Schreibrecht).
- **Wischen:** Zeilen mit `.sw-row` + `.sw-acts` (To-Dos, Packliste, mögliche Aktivitäten, Flüge & Transporte, Infos, Ablauf-Karten) zeigen auf dem Handy per Wischen nach links Bearbeiten/Löschen
  (`shared/trip-mobile.js`); Bearbeiten über `TBPlanner.sheet` / `TBPlanner.ui`.
  Ablauf-Karten bekommen das automatisch (`swipeCards()` in `planner.js` per MutationObserver: jede `.card` mit `.row-edit` erhält `.sw-acts` mit `row-edit`/`row-del`).
- **Transporte in den Etappen:** Etappen sind Aufenthalte (`places`) oder Transporte (`flights`-Einträge mit ISO-`from.date`). Im Zeitstrahl
  steht ein Transport nach dem Stopp, an dem er startet (`trPos`: Flughafen-Code wie „(VIE)“ bzw. Ortsname über `endScore`, Datum in der Etappe),
  sonst vor dem Stopp, an dem er ankommt, sonst nach dem letzten Aufenthalt vor seinem Datum (`.pl-stop.pl-tr`); das „+“ zwischen zwei Stopps fragt
  „Aufenthalt“ oder „Transport“ (`addAt`, Transport mit Von/Nach/Datum vorbelegt). Transporte dürfen Aufenthalte überlappen und zählen in
  `presence()` als Reisetag (`'fl'`) der Personen aus `who` (leer = alle). „Flüge & Transporte“ und die Route am Handy sind nur Anzeige mit Hinweis
  „Aus den Etappen“ (Knopf `go-stops`); „Transport hinzufügen“ dort nur ohne `#stops`. `places[k].kind` (Anreise/Abreise) ist abgelöst,
  die Auswahl erscheint nur noch bei Etappen, die sie schon haben.
- **Kartenlinien:** sobald die Etappen Nächte haben, zeichnet `TBPlanner.drawRoute(map, places)` (`routeSegments()`) Linien zwischen aufeinanderfolgenden
  Stopps (ohne `noRoute`, gleiche Koordinaten übersprungen; keine geschätzte Strecke, wenn eingetragene Transporte etwas anderes sagen: Transport von a woandershin
  bzw. Ankunft in b von woanders – außer jemand aus `who` von a und b reist nicht mit diesem Transport –, a Abreise/b Anreise, oder ab 800 km zu einem reinen
  Abflugort bzw. von einem reinen Ankunftsort). Stil nach eingetragenem Transport dazwischen (`transportBetween`), sonst ab 800 km Flug,
  darunter Straße (`SEG_STYLE`). Zusätzlich eine Linie je eingetragenem Transport zwischen den passenden Orten (`transportSegments`, Code/Name; passt ein Ende zu keinem Ort, z. B. „GUA“ bei
  der Etappe „Antigua“, gilt die Etappe, an der die Reisenden des Transports am Abflug- bzw. Ankunftstag sind). Flüge von/nach zu Hause: Heimat-Flughäfen ohne Etappe (MUC, VIE, FRA … in `AIRPORTS`, per Code oder Stadtname) bekommen eine dezente Linie (`SEG_STYLE.home`) mit kleinem Punkt, der Kartenausschnitt reicht bis dorthin (`TBPlanner.homePoints()`, Weltansicht); „Europa“ ohne Code bleibt ohne Linie. Je Transport abschaltbar: Häkchen „Linie auf der Karte“ im Transport-Sheet (`f.noMap: true`). Doppelte Strecken einmal. Ohne Etappen-Nächte wie bisher gespeicherte `routes` (`{via:[Schlüssel], style}`) bzw. automatische Linie.
- **Ablauf-Tag bearbeiten** (`editRow`): Auswahl „Etappe / Ort auf der Karte“ (Dropdown; setzt `focus`/`locName`, verschiebt das Datum in den
  Zeitraum der Etappe und die Tag-Nummer), Datum, „Mögliche Aktivität übernehmen“ (`TBActivities.forLocation`, füllt Titel bzw. hängt an Details an).
  Thailand: Klick auf eine Zeile springt über `data-focus` + `focusMap(name, iso)` (Schlüssel → Name → Präfix → Etappe am Datum) zur Karte.
- **Listen:** `TBPlanner.enhanceLists()` macht aus den Eingabezeilen von To-Dos und Packliste ein rundes „+“ neben der Suche (`plusAdd`, Formular im Sheet)
  und ergänzt die Suche der Packliste (`packSearch`). Packlisten-Personen am Handy unten über der Tabbar.
- **Infos & Hinweise** = `infos` in der Datenbank (Admins): `TBPlanner.renderInfos(ul)`, „+“ in der Überschrift, Wischen bzw. Stift/Papierkorb (`editInfo`).
  Reisezeiträume und Arbeitstage entstehen automatisch (Etappen bzw. `workdays`; Thailand: Region ↔ Person optional über `workdays.people`).
- **Punktfarben = Reisende** (wie Südamerika): ohne `mapColors` färben `persons` (`{key,name,color}`, gepflegt über „Reisende“ in den Etappen)
  die Punkte auf Karte, Etappen und Route; `places[k].who` schränkt ein (fehlt = alle, `[]` = bewusst niemand → Gelb `#eab308`). Ohne Reisende Blau. Stopps haben keine eigene Farbauswahl mehr.
  Alte Reisen mit `mapColors: "persons"` + `who` in Tagesplan-Zeilen bleiben unverändert.
  Thailand: Reisebeginn ohne `meta.start` = frühestes Datum aus `persons`, Unterkünften oder Ablauf-Tagen (`firstDate()`).
  Thailand: `thPlaceColor()` – `who` am Ort gilt fest; sonst färben die alten `persons.start/end` nach Zeitraum der Etappe (Vorgabe).
  Überall (Karte, Etappen, Route, Aktivitäten) dieselbe Funktion. Reisezeiträume der Personen kommen aus den Etappen (`TBPlanner.personRanges()`).
  Thailand-Arbeitstage: ab heute (zählt mit) bis zum Tag vor dem eigenen Reisebeginn, minus gesetzliche Feiertage und `workdays.vacation` (`{ bayern, wien }`, Admins tragen ein).
  Feiertage für `bayern`/`wien` berechnet die Seite selbst (`HOLIDAYS` + Ostern, `holidayMap`); `workdays.holidays` gilt nur noch für andere Regionen.
- **Desktop:** ab 1200 px Seitenleiste `.d-side` mit allen Bereichen statt Reitern + Menü (`desktopNav()` in `trip-mobile.js`, spiegelt die `.pop-btn`,
  `body.d-sidebar`). Ab 1100 px im Bereich Etappen eine Karte rechts neben dem Zeitstrahl (`sideMap`/`drawSide` in `planner.js`, `#stops.pl-split`):
  Punkt anklicken markiert den Stopp in der Liste, „Auf der Karte“ fliegt dorthin, ohne den Bereich zu wechseln. To-Do- und Packlisten-Eingabe
  bleiben am Desktop als Zeile sichtbar (`plusAdd` mit `.add-inline`), am Handy „+“ mit Sheet.
- **Reihenfolge der Stopps** (`stopList`): Daten-Reihenfolge von `places`; nummerierte Stopps untereinander nach `num`, nicht nummerierte behalten ihren Platz
  dazwischen (Ziehen schreibt die Reihenfolge neu). Route am Handy: Zeitstrahl mit Nächten als Chip am Namen (`.m-n`), Zeitraum darunter.
- **Etappen** (zentrale Planung, wie Stippl): `places[k].nights` je nummeriertem Stopp (− / + in der Stoppliste). Ankunft = Reisebeginn + Nächte davor.
  Unterkünfte mit `place` (Vorlage) bzw. `focus` (Thailand) übernehmen die Daten der Etappe, fehlende erscheinen als „Unterkunft fehlt“;
  ein Ablauf mit `legs: true` (nach „Tage aus den Etappen anlegen“) wird bei jeder Änderung neu angeordnet (Zeilen mit `auto: true` tragen
  den Ortsnamen als Titel, eigene Inhalte bleiben). Ohne festes Reiseende ergibt die Summe der Nächte das Ende (nur Anzeige).
  `places[k].noStay: true` (Häkchen „Keine Unterkunft nötig“ im Stopp-Sheet, z. B. Flug/Nachtzug): Etappe erscheint nicht bei den Unterkünften
  und zählt nicht zu „x/y Nächte gebucht“. Eingetragene Transporte zeigen in ihrer Transport-Zeile im Zeitstrahl und im Detail-Sheet
  farbig ihren Status (die Verkehrsmittel-Pille zwischen zwei Etappen zeigt keinen; antippen = immer Verkehrsmittel wählen (`pickLeg`; die Wahl hat Vorrang vor einem automatisch per Name zugeordneten Transport, eingetragene Transporte bearbeitet man über ihre eigene Zeile: Automatisch · Auto · Zug · Bus · Fähre · Flug · Zu Fuß · Platzhalter,
  gespeichert als `places[k].next` am Ausgangsort, `none` = gestrichelte Pille „Weg offen“; bestimmt Symbol, grobe Zeit und Linienstil auf der Karte). Gebuchte Transporte über „+“ → „Transport“) (`trSt`: „gebucht“ grün, „offen“ orange über `f.planned`); kein Status-Link mehr. „Parallel“ gibt es nur beim Bearbeiten einer Etappe.
- **Ort erneut besuchen:** eigener `places`-Eintrag mit `same: "<Schlüssel des ersten Besuchs>"` (Name/`lat`/`lng` werden mitgeführt,
  eigene `num`-Position, `nights`, `who`, `desc`, Unterkunft). Angezeigt wird die Nummer des ersten Besuchs (`TBPlanner.labels()`,
  in `DATA.places[k].label`); auf der Karte kein eigener Punkt (der erste Besuch zeigt alle Zeiträume). Anlegen über „Neuer Stopp“ →
  „erneut besuchen“ oder „Erneut besuchen“ im Stopp-Sheet. Löschen des ersten Besuchs entfernt die erneuten Besuche.
- Unterkunft ↔ Etappe: `place` (Vorlage) bzw. `focus` (Thailand) enthält den **Schlüssel** des Stopps (Formularfeld „Etappe“; Name und Daten kommen aus der Etappe,
  ein Feld „Ort“ erscheint nur bei „– keine Etappe –“ bzw. ohne nummerierte Etappen); ältere Einträge
  mit Ortsnamen werden über den Namen (bei mehreren Besuchen nach Datum, sonst Präfix wie „Bangkok Stadtzentrum“ → „Bangkok“) zugeordnet.
  Umbenennen eines Stopps zieht Unterkünfte, Thailand-Tage (`locName`) und Aktivitäten (`location_name`) mit. Offene Unterkünfte sind rot markiert.
- Unterkünfte `stations`: Array (Vorlage) oder Objekt aus Arrays (Thailand: `th`/`sl`). Felder u. a. `name|title`, `checkin|from`, `checkout|to`,
  `hotel`, `status` (`booked`/`open`), `code`, `price`+`currency`, `address`, `maps`, `cancel_until`, `cancel_checked`, `transfer`, `note`.
  Alte Import-Angaben `stations[].bookings` (`name`, `room`, `by`, `cancel`, `maps`) sind nicht editierbar: Beim Bearbeiten stehen sie in der Notiz
  und werden beim Speichern entfernt (`maps` → `s.maps`, falls leer); Admins sehen sonst ein Banner „In Notizen übernehmen“ für alle. Bereits in der Notiz enthaltene Angaben werden nicht doppelt angezeigt.
  `TB.tripSummaries()` (RPC `travelbase_trip_summaries`) liefert Stopps/Unterkünfte/Storno-Warnungen für die Übersicht; „x/y Unterkünfte gebucht“ zählt wie die Unterkünfte-Seite (`stays_booked` / `stays_booked + stays_open + stays_missing`, ohne „Keine nötig“ und Etappen ohne Unterkunftsbedarf).
- `exportBackup()` (nur Admins): JSON aller `BACKUP_TABLES` der Reisen, auf denen man Admin ist – läuft mit dem Login des Admins, RLS gilt.
  Neue `travelbase_`-Tabellen dort ergänzen.
- **Alte Reisen (Import, ohne Nummern/Nächte, Daten bleiben unverändert):** `stopList` ordnet die Etappen nach dem ersten Datum des Orts
  (`byDate`: Tagesplan-Zeilen `focus` + `from`/`date`, sonst Datumstext des Orts wie „14.12. - 16.12.2025 / 2 Nächte“; dann kein Ziehen).
  Verkehrsmittel zwischen zwei Stopps kommt ohne eingetragenen Transport aus den gespeicherten `routes` (`legacyMode`: `via` bzw. `path`
  durch beide Orte, Stilname walk/ferry/flight/bus/train/drive → Symbol, Zeit, Linienstil `SEG_STYLE.walk`), auch für Kartenlinien aus den Etappen.
  Die Karte neben den Etappen zeigt ohne Etappen-Nächte die gespeicherten Strecken (`H.drawStored`). Ohne Reisende färbt `places[k].color` die Punkte
  (passt zur Legende alter Reisen), sonst Blau. Abgeschlossene Reisen bieten leere Bereiche Unterkünfte / Flüge & Transporte nicht mehr an.
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
