# TravelBase

Übersicht über unsere Reiseplanungen. Die Seiten in diesem Repo sind nur „leere Hüllen“:
alle Inhalte liegen in Supabase und werden erst nach dem Login geladen.

## Aufbau

```
index.html            Login + Übersicht (ohne Login: nur Flaggen)
shared/config.js      Supabase-URL + Publishable Key (dürfen öffentlich sein)
shared/travelbase.js  Login, Datenzugriff, Offline-Zwischenspeicher
shared/flags.css      Flaggen-Schrift (Fix für Windows)
shared/trip.*         Reise-Vorlage (trip.js/trip.css/trip-template.html) für alle Reisen außer Thailand
sw.js, manifest.json  App/Offline für alle Reisen
<reise-slug>/         eine Reise pro Ordner, Ordnername = slug in Supabase
```

## Neue Reise hinzufügen

1. In Supabase eine Zeile in `trips` + Inhalte in `trip_sections` anlegen (Import-Skript).
   Abschnitt `guest` = Karte & Zeitraum; Abschnitt `details` mit `min_role` `member` oder `admin`.
2. Hier einen Ordner mit genau dem `slug` als Namen anlegen und `shared/trip-template.html`
   als `index.html` hineinkopieren – fertig, die Seite baut sich aus den Daten auf.
3. Mitglieder per `select add_trip_member('<slug>', '<email>', '<rolle>');` freischalten.

## Wichtig

- Niemals den `secret`/`service_role` Key in dieses Repo legen.
- Import-Skripte mit Reisedaten gehören **nicht** in dieses Repo.
