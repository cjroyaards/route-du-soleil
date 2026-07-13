# Eigen live-tracking — Signal K → GitHub → website

Vervangt het Saillogger-abonnement ($7,99/mnd). Kosten: **€0**.

**Hoe het werkt:** de plugin draait in Signal K op de Cerbo GX (Venus OS Large) en pusht elke 15 min (via Starlink) twee bestanden naar een GitHub-repo:

- `track.json` — elke 10 min positie, snelheid, koers → de live track op de Leaflet-kaart (index.html)
- `data.json` — elke minuut wind/vlagen/windrichting, SOG, diepte, COG (laatste 48 u) + uurgemiddelden van de hele reis → het live dashboard (dashboard.html) en straks het bemanningsklassement (max wind, topsnelheid per leg)

Geen internet? Alles wordt lokaal gebufferd en later alsnog gepusht — er valt geen gat in track of dashboard. De uurhistorie overleeft zelfs een verse herinstallatie (wordt teruggehaald uit GitHub).

## Stap 1 — GitHub-repo

1. Maak een account op [github.com](https://github.com) (gratis) als je dat nog niet hebt.
2. Maak een nieuwe **publieke** repo, b.v. `route-du-soleil`. Tip: zet meteen de hele website erin, dan kan GitHub Pages hem ook gratis hosten.
3. Maak in de repo alvast een leeg bestand `data/track.json` met inhoud: `{"points": []}` (data.json maakt de plugin zelf aan)

## Stap 2 — Token aanmaken

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. Naam: `signalk-tracker` · Expiration: kies een datum ná 5 nov 2028.
3. Repository access: **Only select repositories** → kies `route-du-soleil`.
4. Permissions → Repository permissions → **Contents: Read and write**. Verder niets.
5. Genereer en **kopieer het token** (begint met `github_pat_…`). Je ziet het maar één keer.

Dit token kan alléén bij die ene repo — als het ooit uitlekt kan iemand hooguit je track aanpassen.

## Stap 3 — Plugin op de Cerbo GX installeren

De Cerbo draait Venus OS; Signal K zit in de **Large**-versie van de firmware.

**3a. Venus OS Large + Signal K aanzetten** (eenmalig, op de Cerbo of via Remote Console):

1. Settings → Firmware → Online updates → Image type: **Large** → update installeren.
2. Settings → Venus OS Large features → **Signal K: aan**.
3. Settings → General → **Set root password** (nodig voor SSH) en **SSH on LAN: aan**.

**3b. Plugin kopiëren** (vanaf je laptop, Cerbo op hetzelfde netwerk):

```bash
scp -r signalk-github-tracker root@venus.local:/data/conf/signalk/node_modules/

# op de Cerbo (ssh root@venus.local): Signal K herstarten
svc -t /service/signalk-server
```

Let op: `/data` overleeft firmware-updates, dus de plugin blijft staan.

Daarna in de Signal K admin-UI (http://venus.local:3000):
Server → Plugin Config → **GitHub Tracker (Route du Soleil)** → invullen:

| Veld | Waarde |
|---|---|
| GitHub-token | `github_pat_…` uit stap 2 |
| Owner | je GitHub-gebruikersnaam |
| Repository | `route-du-soleil` |
| Branch | `main` |
| Pad trackbestand | `data/track.json` |
| Log-interval | 10 min (standaard) |
| Push-interval | 15 min (standaard) |
| Dashboard-data loggen | aan (standaard) |
| Pad dashboard-bestand | `data/data.json` |
| Uren minuutdata | 48 (standaard) |

**Windmeter:** de plugin gebruikt `environment.wind.speedTrue` (ware wind). Zie je in de Data Browser alleen `speedApparent`? Zet dan in Signal K de plugin **derived-data** aan (Appstore) — die rekent schijnbare wind om naar ware wind met de SOG erbij. Zonder dat valt de plugin terug op schijnbare wind.

Plugin **enablen** en opslaan. Onder de plugin verschijnt de status ("X punten online, laatste push …").

## Stap 4 — Website live zetten

Twee constanten invullen:

**index.html** — zoek `TRACK_URL` (onderin het script):

```js
const TRACK_URL = 'https://raw.githubusercontent.com/JOUWNAAM/route-du-soleil/main/data/track.json';
```

**dashboard.html** — zoek `DATA_URL` (bovenin het script):

```js
const DATA_URL = 'https://raw.githubusercontent.com/JOUWNAAM/route-du-soleil/main/data/data.json';
```

Klaar. De kaart toont de echte track + laatste positie en het dashboard de echte instrumenten (tegels + grafieken laatste 48 u), beide verversen elke 5 min. "Log vandaag" wordt uit de minuutdata berekend. Zolang de constanten leeg zijn, blijft de demo-weergave staan.

## Testen (kan nu al, thuis)

1. Doe stap 1–2.
2. Draai de plugin op een test-Signal K (op de Cerbo thuis, of een demo-databron in Signal K op je laptop). GPS-positie komt aan boord via NMEA2000 in de Cerbo; zonder GPS-bron logt de plugin niets.
3. Check of `data/track.json` en `data/data.json` in de repo groeien (elke push = een commit, dus je hebt meteen een reservekopie van alles).
4. Vul `TRACK_URL` en `DATA_URL` in en open index.html en dashboard.html.

## Bestandsformaten (v1.2 — zuinig voor Starlink)

**data/track.json** — archief-index + lopende maand:

```json
{
  "updated": "2028-07-01T14:20:00Z",
  "months": ["2028-05", "2028-06"],
  "points": [[38.70123, -9.41675, "2028-07-01T14:20:00Z", 5.8, 215], ...]
}
```

Per punt: `[lat, lon, tijd, snelheid kn, koers °]`. Afgesloten maanden staan in `data/track-YYYY-MM.json` (zelfde punts-formaat) en worden nooit opnieuw geüpload; de website plakt ze automatisch aan elkaar.

**data/data.json** — dashboard, laatste 48 u op 5-min-resolutie:

```json
{ "updated": "...", "recent": [["2028-07-01T14:20:00Z", 6.0, 16.2, 22.0, 359, 42.3, 215], ...] }
```

Per record: `[tijd, SOG kn, wind kn, vlaag kn, windrichting °, diepte m, COG °]`. Intern meet de plugin per minuut (vlagen via 10s-sampling); gepubliceerd wordt per 5 min. Geen meting = `null`; instrumenten uit = geen records.

**data/hourly.json** — uurgemiddelden hele reis, 1x per uur gepusht:

```json
{ "updated": "...", "hourly": [["2028-07-01T13:00:00Z", 6.0, 7.2, 16.2, 22.0, 359], ...] }
```

Per record: `[tijd, SOG gem, SOG max, wind gem, zwaarste vlaag, windrichting °]`. Databron voor het bemanningsklassement (filter op leg-datums).

**data/anker.json** — ankerwacht (v1.3). De plugin zet de wacht automatisch aan zodra de boot >10 min stilligt: ankerpunt vastgelegd, daarna elke 2 min positie/wind/diepte + zwaaigeschiedenis (6 u). Buiten de alarmradius (instelling, standaard 60 m) = alarm + optionele pushmelding via [ntfy](https://ntfy.sh) (app installeren, abonneren op je eigen topic uit de plugin-config). Vaart de boot echt weg, dan schakelt de wacht zichzelf uit. Bekijken: **anker.html** (bookmarken; toont ring, zwaaipatroon, wind, diepte en een "verse data"-bewaking — geen update in 6 min = waarschuwing). Let op: dit is monitoring op afstand, géén vervanging van het ankeralarm aan boord; het ankerpunt is de plek waar de boot tot rust kwam (niet exact waar het anker viel), dus houd de radius ruim.

**Dataverbruik:** de plugin cachet sha's (geen download vóór elke upload) en uploadt alleen wat veranderd is. Reken op ~10 MB/dag varend (worst case ~35 aan het eind van een drukke maand); met push-interval 30 min op zee de helft. Voor anker met instrumenten uit: vrijwel nul.

## Ankermodus

Beweegt de boot minder dan 75 m, dan wordt er maar één punt per uur gelogd ("heartbeat"). Zo blijft "laatst gezien" actueel zonder dat het bestand volloopt in de haven. Over de hele reis blijft track.json onder de ~1,5 MB.
