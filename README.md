# TravelBase

Übersicht über unsere Reiseplanungen. Die Seiten in diesem Repo sind nur „leere Hüllen“:
alle Inhalte liegen in Supabase und werden erst nach dem Login geladen.

## Aufbau

```
index.html            Login + Übersicht (ohne Login: nur Flaggen)
verwaltung.html       Weiterleitung auf die gemeinsamen Admin-Einstellungen im Dashboard (/admin.html)
shared/config.js      Supabase-URL + Publishable Key (dürfen öffentlich sein)
shared/travelbase.js  Login, Datenzugriff, Offline-Zwischenspeicher
shared/overall-account.js  gemeinsames Konto-Modul aller Apps (Name, Bild, Geburtsdatum, Geschlecht, Größe, Gewicht, Passwort);
                      Original im Repo supabase-core, hier nur eine Kopie
shared/profile.js     Profil-Button oben rechts mit Menü (nutzt overall-account.js)
shared/flags.css      Flaggen-Schrift (Fix für Windows)
shared/activities.js  Mögliche Aktivitäten pro Ort (Unterseite + Modal aus der Route), Tabelle travelbase_activities
shared/trip.*         Reise-Vorlage (trip.js/trip.css/trip-template.html) für alle Reisen außer Thailand
sw.js, manifest.json  App/Offline für alle Reisen
<reise-slug>/         eine Reise pro Ordner, Ordnername = slug in Supabase
```

## Neue Reise hinzufügen

1. In Supabase eine Zeile in `travelbase_trips` + Inhalte in `travelbase_trip_sections` anlegen (Import-Skript).
   Abschnitt `guest` = Karte & Zeitraum; Abschnitt `details` mit `min_role` `member` oder `admin`.
2. Hier einen Ordner mit genau dem `slug` als Namen anlegen und `shared/trip-template.html`
   als `index.html` hineinkopieren – fertig, die Seite baut sich aus den Daten auf.
3. Mitglieder per `select travelbase_add_trip_member('<slug>', '<email>', '<rolle>');` freischalten.

## Wichtig

- Niemals den `secret`/`service_role` Key in dieses Repo legen.
- Import-Skripte mit Reisedaten gehören **nicht** in dieses Repo.

## Datenbank

TravelBase nutzt das zentrale Supabase-Projekt. Das Schema liegt im Repo
[`supabase-core`](https://github.com/mvs2-bot/supabase-core): Tabellen mit Präfix `travelbase_`,
Profile in `overall_profiles`, Zugang zur App über `overall_app_access`.
Admins von TravelBase sehen jede Reise als Admin.
Admins sehen in der Übersicht unter jeder Reise, wer mit welcher Rolle freigeschaltet ist
(RPC `travelbase_trip_members_overview()`, liefert nur Reisen, auf denen man selbst Admin ist).

Bei Vielleicht-Reisen können Admins auf der Übersicht das Startdatum wählen (RPC `travelbase_set_trip_start`).
Das Ende rechnet sich aus der Zahl der Tage im Tagesplan, die Reise-Seite macht aus „Tag 1, Tag 2 …“ echte Daten.

Mögliche Aktivitäten: in der Reise-Vorlage per `"activities": true` in einem Abschnitt mit `min_role` `member` einschalten
(Thailand hat sie fest eingebaut). Gespeichert in `travelbase_activities`, verknüpft über `trip_id` + `location_name`
(= Ortsname der Route); kommt ein Ort mehrfach in der Route vor, teilen sich beide Stopps die Aktivitäten.
Wird ein Ort in den Reisedaten umbenannt, müssen die Zeilen mit dem alten `location_name` mitgezogen werden.
