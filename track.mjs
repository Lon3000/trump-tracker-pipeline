#!/usr/bin/env node
/**
 * track.mjs — Extraktions-Pipeline für Donald Trumps Periodic Transaction Reports.
 *
 * Ablauf:
 *   1. whitehouse.gov/disclosures/ pollen  -> neue Trump-PTR-PDFs finden
 *   2. PDF laden, Text extrahieren (pdftotext; Fallback Tesseract-OCR)
 *   3. Transaktionen parsen + Ticker auflösen (tickers.json)
 *   4. in state/dataset.json einpflegen, Totals neu rechnen, state speichern
 *
 * Kein Telegram hier — das übernimmt der Webspace-Tracker, der dataset.json liest.
 * Läuft in GitHub Actions (Node 20+, mit poppler-utils + tesseract-ocr).
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'Trump-Trade-Tracker (personal project)';
const DISCLOSURES_URL = 'https://www.whitehouse.gov/disclosures/';
// Pfade relativ zum Skript-Ordner (funktioniert unabhängig vom Arbeitsverzeichnis)
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'state/dataset.json');
const SEEN  = join(HERE, 'state/seenFilings.json');
const TICKERS = join(HERE, 'tickers.json');

/* --- Helfer ------------------------------------------------------------- */
const readJSON  = (p, d) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d;
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1));
const norm      = s => (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const sha1      = s => createHash('sha1').update(s).digest('hex');
// OCR-Ziffernkorrektur NUR in Zahlen-Token
const fixNum    = s => s.replace(/[SOlIDB|]/g, c => ({ S:'5', O:'0', l:'1', I:'1', D:'0', B:'8', '|':'1' }[c] || c));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
}

async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

/* --- Text-Extraktion: pdftotext, sonst OCR ------------------------------ */
function extractText(pdfPath) {
  let txt = '';
  try { txt = run('pdftotext', ['-layout', pdfPath, '-']); } catch {}
  if (txt.replace(/\s/g, '').length > 800) return { text: txt, via: 'pdftotext' };

  // Fallback: Seiten rendern + Tesseract-OCR
  const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
  run('pdftoppm', ['-r', '200', '-png', pdfPath, join(dir, 'p')]);
  let out = '';
  for (const f of readdirSync(dir).filter(f => f.endsWith('.png')).sort()) {
    try { out += run('tesseract', [join(dir, f), '-', '--psm', '6']) + '\n'; } catch {}
  }
  return { text: out, via: 'tesseract' };
}

/* --- Parser: Textzeilen -> Transaktionen -------------------------------- */
function parseTransactions(text) {
  const out = [];
  for (const ln of text.split('\n')) {
    const m = /\b(purchase|sale)\b/i.exec(ln);
    if (!m) continue;
    const after = ln.slice(m.index);
    const dm = /(\d{1,2}\/\d{1,2}\/[0-9SOlIB]{2,4})/.exec(after);
    const am = /\$[0-9SOlIDB,]+\s*[-–]\s*\$?[0-9SOlIDB,]+/.exec(ln);
    let desc = ln.slice(0, m.index).replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim();
    if (desc.length < 3) continue;
    out.push({
      type: m[1].toLowerCase(),
      date: dm ? normalizeDate(fixNum(dm[1])) : '',
      amount: am ? fixNum(am[0]).replace(/\s+/g, ' ').replace('–', '-') : '',
      rawDescription: desc,
    });
  }
  return out;
}

function normalizeDate(s) {
  const p = s.split('/');
  if (p.length === 3) {
    let [mo, d, y] = p;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return s;
}

/* --- Ticker auflösen ---------------------------------------------------- */
function resolveTicker(desc, tickers) {
  const n = norm(desc);
  if (tickers.byDescription[n]) return tickers.byDescription[n];
  for (const [nm, tk] of Object.entries(tickers.byName)) {
    if (nm.length > 4 && n.startsWith(nm)) return tk;
  }
  return null;
}

function amountToRange(a) {
  const nums = (a.match(/[0-9,]+/g) || []).map(x => Number(x.replace(/,/g, '')));
  const low = nums[0] || 0, high = nums[1] || low;
  return { low, high, mid: (low + high) / 2 };
}

/* --- Hauptlauf ---------------------------------------------------------- */
const dataset = readJSON(STATE, { generatedAt: '', totals: {}, stocks: {} });
const seen    = readJSON(SEEN, {});
const tickers = readJSON(TICKERS, { byDescription: {}, byName: {} });

// Vorhandene Transaktions-IDs (quellseitig stabil: Typ|Datum|Betrag|Beschreibung)
const txId = t => sha1([t.type, t.date, t.amount, norm(t.rawDescription)].join('|'));
const existing = new Set();
for (const st of Object.values(dataset.stocks)) for (const t of (st.transactions || [])) existing.add(txId(t));

// 1) WH-Disclosures pollen
const html = await (await fetch(DISCLOSURES_URL, { headers: { 'User-Agent': UA } })).text();
const re = /<a[^>]*?(?:id="([^"]*)")?[^>]*?href="([^"]+\.pdf)"[^>]*?>\s*([^<]*Donald J\. Trump Periodic Transaction Report[^<]*)<\/a>/gi;
const filings = [];
let m;
while ((m = re.exec(html))) {
  const url = m[2];
  filings.push({ key: m[1] || url, url, title: m[3].replace(/\s+/g, ' ').trim() });
}
console.log(`WH-Seite: ${filings.length} Trump-PTR-Einträge gefunden.`);

const fresh = filings.filter(f => !seen[f.key]);
console.log(`Davon neu: ${fresh.length}`);

let added = 0;
for (const f of fresh) {
  console.log(`\n→ Neues Filing: ${f.title}`);
  const pdf = join(mkdtempSync(join(tmpdir(), 'ptr-')), 'r.pdf');
  try {
    await download(f.url, pdf);
    const { text, via } = extractText(pdf);
    const parsed = parseTransactions(text);
    console.log(`  Text via ${via}, ${parsed.length} Transaktionszeilen erkannt.`);

    let newInFiling = 0;
    for (const t of parsed) {
      const id = txId(t);
      if (existing.has(id)) continue;
      existing.add(id);
      const tk = resolveTicker(t.rawDescription, tickers) || '_UNRESOLVED';
      const { low, high, mid } = amountToRange(t.amount);
      dataset.stocks[tk] = dataset.stocks[tk] || {
        ticker: tk, name: tk === '_UNRESOLVED' ? 'Nicht aufgelöst' : tk, sector: '', transactions: [],
      };
      dataset.stocks[tk].transactions.push({ date: t.date, type: t.type, amount: t.amount, mid, low, high, rawDescription: t.rawDescription });
      newInFiling++; added++;
    }
    console.log(`  ${newInFiling} neue Transaktionen übernommen.`);
    seen[f.key] = { title: f.title, url: f.url, count: newInFiling, processedAt: new Date().toISOString() };
  } catch (e) {
    console.log(`  ! Fehler: ${e.message} — Filing übersprungen (wird nächstes Mal erneut versucht).`);
  }
}

// Totals neu berechnen
if (added > 0) {
  let buy = 0, sell = 0, n = 0;
  for (const st of Object.values(dataset.stocks)) for (const t of st.transactions) {
    n++; if (t.type === 'purchase') buy++; else if (t.type === 'sale') sell++;
  }
  dataset.totals = { txCount: n, buyCount: buy, sellCount: sell, uniqueTickers: Object.keys(dataset.stocks).length };
  dataset.generatedAt = new Date().toISOString();
}

writeJSON(STATE, dataset);
writeJSON(SEEN, seen);
console.log(`\nFertig: ${added} neue Transaktionen, ${fresh.length} Filings verarbeitet.`);
// Exit-Code 0; die Action committet nur bei Änderungen.
