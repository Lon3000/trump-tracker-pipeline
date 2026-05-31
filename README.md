# Trump-PTR Extraktions-Pipeline (GitHub Actions)

Hält `state/dataset.json` mit Donald Trumps offengelegten Trades **automatisch frisch** —
unabhängig von fremden Repos. Läuft kostenlos in GitHub Actions.

## Wie es funktioniert
1. **Discovery:** pollt `whitehouse.gov/disclosures/` nach neuen
   „Donald J. Trump Periodic Transaction Report"-PDFs.
2. **Extraktion:** lädt jedes neue PDF, zieht Text via `pdftotext`; hat das PDF
   keine Textebene (WH-Scans), wird **Tesseract-OCR** als Fallback genutzt.
3. **Parsen + Ticker:** erkennt Transaktionen (Typ, Datum, Betrag, Beschreibung)
   und löst die Firma über `tickers.json` auf einen Ticker auf.
4. **Speichern:** pflegt neue Transaktionen in `state/dataset.json` ein und
   committet die Datei. Die Action sendet **kein** Telegram.

Die **Telegram-Pushes macht dein Webspace-Tracker** (`djt-tracker/`): Er liest
`state/dataset.json` aus diesem Repo und benachrichtigt dich bei neuen Trades.
→ So bleibt die bereits funktionierende Push-Logik unverändert.

## Dateien
| Datei | Zweck |
|-------|-------|
| `track.mjs` | die Pipeline (Node, keine npm-Abhängigkeiten) |
| `tickers.json` | Mapping Beschreibung/Name → Ticker (Seed aus 3.642 Trades) |
| `state/dataset.json` | akkumulierte Trades (Start: bestehende Historie) |
| `state/seenFilings.json` | bereits verarbeitete Filings (Start: alle aktuellen) |
| `.github/workflows/track.yml` | Cron alle 6 h + manueller Start |

## Einrichtung (einmalig)
1. **Neues GitHub-Repo** anlegen (öffentlich → unbegrenzte Action-Minuten),
   z. B. `trump-tracker-pipeline`.
2. **Inhalt dieses Ordners** ins Repo hochladen/pushen (inkl. `state/` und
   `.github/`).
3. In den Repo-**Settings → Actions → General**: „Workflow permissions" auf
   **Read and write** stellen (damit der Job `state/` committen darf).
4. Tab **Actions** öffnen → Workflow „Track Trump PTRs" → **Run workflow**
   (erster manueller Lauf). Da alle aktuellen Filings als „gesehen" gelten,
   passiert beim ersten Mal nichts — ab dem nächsten neuen OGE/WH-Report
   wird automatisch extrahiert.
5. Im Webspace-Tracker `djt-tracker/config.php` `dataset_url` auf **dein** Repo
   umstellen:
   ```php
   'dataset_url' => 'https://raw.githubusercontent.com/DEIN-USER/trump-tracker-pipeline/main/state/dataset.json',
   ```

## Ehrliche Grenzen
- **Genauigkeit:** Trumps PTRs sind eingescannt. Firmenname/Ticker werden gut
  erkannt (~77 % automatisch aufgelöst, Rest landet unter `_UNRESOLVED`),
  Datum/Betrag sind best-effort. Reicht fürs Ziel „welche Aktie gekauft/verkauft",
  ist aber nicht so sauber wie eine KI-Vision-Extraktion.
- **Frische:** Du bist nur noch an die OGE/WH-Veröffentlichung gebunden (gesetzlich
  bis 45 Tage nach dem Trade) — nicht mehr an einen fremden Maintainer.
- **Verbesserbar:** `tickers.json` wächst, je mehr Beschreibungen auftauchen;
  unaufgelöste Einträge können nachträglich ergänzt werden.
