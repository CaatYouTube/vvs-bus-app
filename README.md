# VVS Bus

Web-App (PWA) für alle Buslinien im VVS-Gebiet rund um Stuttgart. Läuft im Handybrowser, lässt sich
auf den Homescreen legen, funktioniert danach auch ohne Netz (Fahrplan und Linienlisten).

## Was die App kann

- **Linien:** alle Buslinien, gruppiert nach **Landkreis** (Rems-Murr-Kreis, Landkreis Ludwigsburg,
  Stuttgart, Esslingen, Böblingen, Göppingen …), mit Suche und Streckenverlauf auf der Karte.
- **Abhaken:** bei jeder Linie ✓ antippen = „schon gefahren“. Fortschrittsbalken je Landkreis
  („12 von 54 Linien gefahren“), Filter „noch nicht gefahren / schon gefahren“.
  Gespeichert wird auf dem Gerät. Mit **„Gefahrene Linien sichern“** und **„Sicherung laden“** könnt ihr
  den Stand sichern oder auf ein anderes Handy übertragen.
- **Halte:** Haltestellensuche, „In meiner Nähe“, nächste Abfahrten.
- **Verbindung:** Von/Nach, Datum und Uhrzeit, bis zu 4 Umstiege, Fußwege bis 250 m, Anzeige auf der Karte.
- **Karte:** OpenStreetMap, Haltestellen ab Zoomstufe 14.

**Grenzen (bitte ehrlich nehmen):**

- Es ist der **Soll-Fahrplan, keine Echtzeit.** Verspätungen und Ausfälle sind nicht enthalten.
  Echtzeitdaten gibt es bei MobiData BW über die TRIAS-/EFA-Schnittstelle, das wäre ein späterer Ausbau.
- Nur **Busse** (keine S-Bahn/Stadtbahn), und Verbindungen nur mit Bus.
- Die Fahrplandaten stammen aus dem **Gesamtfeed von Baden-Württemberg**, gefiltert auf ein Rechteck um
  das VVS-Gebiet (`--bbox`). Am Rand können deshalb auch Linien aus Nachbarverbünden auftauchen.

## Schnellstart auf dem eigenen Rechner

Benötigt Python 3 (keine weiteren Pakete) und zum Testen Node.js.

```bash
python3 scripts/build_data.py        # lädt den Fahrplan und erzeugt web/data/ (dauert einige Minuten)
cd web && python3 -m http.server 8000
# dann im Browser: http://localhost:8000
```

Tests (mit einem winzigen Beispiel-Fahrplan, ohne Internet): `bash tests/run_tests.sh`

## Auf GitHub hochladen (kostenlos veröffentlichen)

1. Auf github.com ein neues Repository anlegen und diesen Ordner hochladen (oder `git push`).
2. Im Repository: **Settings → Pages → Source: „GitHub Actions“** auswählen.
3. Unter **Actions → „Fahrplandaten bauen und App veröffentlichen“ → Run workflow** starten.
   Das lädt die echten Fahrplandaten, baut `web/data/` und veröffentlicht die App unter
   `https://<euer-name>.github.io/<repo-name>/`.
4. Den Link auf dem Handy öffnen → Browsermenü → **„Zum Startbildschirm hinzufügen“**. Fertig, ihr beide
   habt die App, ganz ohne Play Store.

Der Workflow läuft danach automatisch **jeden Montag**, damit die Fahrplandaten aktuell bleiben.

> **Wichtig, noch nicht mit den echten Daten ausprobiert:** Beim Bauen der Anleitung konnte ich den
> Fahrplan-Download nicht ausführen. Pipeline, Suche, Verbindungen, Landkreis-Listen und das Abhaken
> sind mit einem Beispiel-Fahrplan getestet, der erste Lauf mit den echten Daten steht noch aus.
> Falls der Lauf scheitert, bitte die Fehlermeldung aus dem Actions-Protokoll schicken.
> Mögliche Stolpersteine: Speicherbedarf beim Gesamtfeed (dann `--bbox` kleiner wählen) oder ein
> geänderter Download-Link (dann `--url` anpassen).

### Landkreis-Zuordnung

Die Fahrplandaten enthalten keinen Landkreis. Die Pipeline liest ihn aus den Haltestellen-IDs
(`de:08119:…`, 08119 = Rems-Murr-Kreis, 08118 = Ludwigsburg, 08111 = Stuttgart). Am Ende des Baulaufs steht im
Protokoll z. B. `Landkreis-Zuordnung: 97 % der Haltestellen`. Liegt der Wert unter 50 %, erscheint eine Warnung.
Dann könnt ihr eine Grenzdatei im GeoJSON-Format übergeben:

```bash
python3 scripts/build_data.py --kreise-geojson landkreise.geojson
```

(Amtliche Grenzen gibt es kostenlos beim BKG, „VG250“. Das Skript liest den Namen aus dem Feld `GEN`.)
Ohne Landkreisdaten funktioniert die App weiter, die Linien stehen dann unter „Alle Linien“.

## Play Store (Android)

Das geht, ist aber ein eigener Aufwand. Die Web-App wird dafür als „Trusted Web Activity“ verpackt.
Ich habe das **nicht** für euch gebaut oder hochgeladen. Dafür braucht ihr ein eigenes Entwicklerkonto.

1. **Google-Play-Entwicklerkonto** anlegen (einmalig 25 US-Dollar, mit Identitätsprüfung).
   Für neue private Konten verlangt Google aktuell einen geschlossenen Test mit mehreren Testern über
   mehrere Wochen, bevor die App öffentlich geht. Die aktuellen Regeln stehen in der Play Console.
2. Die App muss unter einer **HTTPS-Adresse** laufen (siehe GitHub Pages oben).
3. Verpacken, am einfachsten mit [PWABuilder](https://www.pwabuilder.com) (Adresse eingeben,
   „Package for stores → Android“) oder per Kommandozeile mit
   [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap):
   ```bash
   npm i -g @bubblewrap/cli
   bubblewrap init --manifest=https://<euer-name>.github.io/<repo-name>/manifest.webmanifest
   bubblewrap build        # erzeugt die .aab-Datei für die Play Console
   ```
4. **Digital Asset Links:** Damit die App ohne Adressleiste startet, muss die Datei
   `/.well-known/assetlinks.json` im **Wurzelverzeichnis der Domain** liegen. Bei einem GitHub-Pages-
   Projekt (`name.github.io/repo/`) geht das nicht. Nennt das Repository deshalb
   `<euer-name>.github.io` oder nutzt eine eigene Domain.
5. Datenschutzerklärung und Store-Eintrag ausfüllen, Bundle in der Play Console hochladen.

Die App speichert nur auf dem Gerät („gefahren“-Häkchen, gewählter Landkreis) und sendet keine
persönlichen Daten. Kartenkacheln lädt der Browser von OpenStreetMap.

## Daten und Lizenzen

- Fahrplandaten: NVBW / MobiData BW. Die VVS-Soll-Fahrplandaten stehen laut MobiData BW unter CC BY;
  für den Gesamtfeed gilt die NVBW-Lizenz (<https://www.nvbw.de/open-data/lizenz>). Die Quellenangabe
  steht in der App. Bitte vor einer öffentlichen Veröffentlichung die aktuellen Bedingungen prüfen.
- Karte: © OpenStreetMap-Mitwirkende. Kartenbibliothek: Leaflet (BSD-2, Lizenz in `web/vendor/`).
- Der eigene Code hat noch keine Lizenzdatei. Legt eine fest, bevor ihr das Repository öffentlich macht.

## Aufbau

```
web/                 die App (HTML, CSS, JavaScript, Service Worker, Manifest, Icons)
  js/core.js         Suche, Abfahrten, Verbindungssuche (RAPTOR), Landkreis-Gruppierung
  js/app.js          Oberfläche
  data/              wird erzeugt (nicht im Repository)
scripts/build_data.py  GTFS-Download → kompakte JSON-Dateien
scripts/make_icons.py  App-Icons erzeugen (Pillow)
tests/               Beispiel-Fahrplan und Tests
.github/workflows/   automatischer Bau und Veröffentlichung auf GitHub Pages
```
