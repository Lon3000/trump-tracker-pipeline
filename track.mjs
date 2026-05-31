#!/usr/bin/env node
/**
 * track.mjs — Extraktions-Pipeline für Donald Trumps Periodic Transaction Reports.
 *
 *   1. whitehouse.gov/disclosures/ pollen  -> neue Trump-PTR-PDFs finden
 *   2. PDF laden, Text extrahieren (pdftotext; Fallback Tesseract-OCR)
 *   3. Transaktionen parsen (zeilennummer-/spaltenbasiert) + Ticker auflösen
 *   4. in state/dataset.json einpflegen, Totals neu rechnen
 *
 * Kein Telegram hier — das macht der Webspace-Tracker, der dataset.json liest.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'Trump-Trade-Tracker (personal project)';
const DISCLOSURES_URL = 'https://www.whitehouse.gov/disclosures/';
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'state/dataset.json');
const SEEN  = join(HERE, 'state/seenFilings.json');
const TICKERS = join(HERE, 'tickers.json');

/* --- Helfer ------------------------------------------------------------- */
const readJSON  = (p, d) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d;
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1));
const norm      = s => (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const sha1      = s => createHash('sha1').update(s).digest('hex');
// OCR-Ziffernkorrektur nur in Zahlen-Token
const fixNum    = s => s.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');

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
  const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
  run('pdftoppm', ['-r', '300', '-png', pdfPath, join(dir, 'p')]);
  let out = '';
  for (const f of readdirSync(dir).filter(f => f.endsWith('.png')).sort()) {
    try { out += run('tesseract', [join(dir, f), '-', '--psm', '6']) + '\n'; } catch {}
  }
  return { text: out, via: 'tesseract' };
}

/* --- Ticker-Auflösung (exakt -> Namens-Präfix -> Fuzzy erste 2 Worte) --- */
function buildResolver(tickers) {
  const fw = {}; // erste 2 signifikante Namensworte -> Ticker
  for (const [nm, tk] of Object.entries(tickers.byName || {})) {
    const k = nm.replace(/[^A-Z0-9 ]/g, '').split(' ').filter(w => w.length > 1).slice(0, 2).join(' ');
    if (k.length >= 6 && !fw[k]) fw[k] = tk;
  }
  return desc => {
    const n = norm(desc);
    if (tickers.byDescription?.[n]) return tickers.byDescription[n];
    for (const [nm, tk] of Object.entries(tickers.byName || {})) {
      if (nm.length > 4 && n.startsWith(nm)) return tk;
    }
    const k = n.replace(/[^A-Z0-9 ]/g, '').split(' ').filter(w => w.length > 1).slice(0, 2).join(' ');
    return fw[k] || null;
  };
}

/* --- Betrag: auf Standard-OGE-Bänder einrasten -------------------------- */
const BANDS = [[1001,15000],[15001,50000],[50001,100000],[100001,250000],[250001,500000],
  [500001,1000000],[1000001,5000000],[5000001,25000000],[25000001,50000000],[50000001,100000000]];
const fmtUSD = n => '$' + n.toLocaleString('en-US');
function snapAmount(tail) {
  const re = /\$\s*([0-9OoSlI.,\s]{3,})\s*[-–—�]\s*\$?\s*([0-9OoSlI.,\s]{3,})/g;
  let m, last = null;
  while ((m = re.exec(tail))) last = m;
  if (!last) return null;
  const low = parseInt(fixNum(last[1]).replace(/[.,\s]/g, ''), 10);
  if (!low) return null;
  let best = BANDS[0], bd = Infinity;
  for (const b of BANDS) { const d = Math.abs(Math.log10(b[0]) - Math.log10(low)); if (d < bd) { bd = d; best = b; } }
  return { amount: `${fmtUSD(best[0])} - ${fmtUSD(best[1])}`, low: best[0], high: best[1], mid: (best[0] + best[1]) / 2 };
}

/* --- Datum (best-effort; OCR macht aus "/" teils Leerzeichen) ----------- */
function parseDate(tail) {
  const m = /(\d{1,2})[\/\s]{1,3}(\d{1,2})[\/\s]{1,3}(\d{2,4})/.exec(tail);
  if (!m) return '';
  let mo = +m[1], d = +m[2], y = ('' + m[3]).slice(-2); y = 2000 + +y;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  if (y > 2026 || y < 2024) y = 2026; // OCR-Jahr plausibilisieren
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/* --- Typ-Spalte finden (Kauf/Verkauf, OCR-tolerant) --------------------- */
const SELL_RE = /sa[1li][eo]|so[1li]d|\bse[1li][1li]/i;
const BUY_RE  = /urc[hl]|rcha|p[uo]r|0urch/i;
function findType(text) {
  const s = text.search(SELL_RE), b = text.search(BUY_RE);
  const c = [];
  if (s > 2) c.push([s, 'sale']);
  if (b > 2) c.push([b, 'purchase']);
  if (!c.length) return null;
  c.sort((x, y) => x[0] - y[0]);
  return { idx: c[0][0], type: c[0][1] };
}

/* --- Records per fortlaufender Zeilennummer (toleriert Umbrüche) -------- */
function parseRecords(text) {
  const lines = text.split(/\r?\n/);
  const recs = []; let cur = null, expect = 1;
  for (const ln of lines) {
    const m = /^\s{0,5}(\d{1,4})\s{2,}(\S.*)$/.exec(ln);
    if (m && +m[1] >= expect && +m[1] <= expect + 3) { if (cur) recs.push(cur); cur = m[2]; expect = +m[1] + 1; }
    else if (m && +m[1] === 1 && expect > 50) { if (cur) recs.push(cur); cur = m[2]; expect = 2; }
    else if (cur != null) cur += ' ' + ln.trim();
  }
  if (cur != null) recs.push(cur);
  return recs;
}

function parseTransactions(text) {
  const out = [];
  for (const rec of parseRecords(text)) {
    const ft = findType(rec);
    const idx = ft ? ft.idx : Math.min(rec.length, 80);
    const desc = rec.slice(0, idx).replace(/[^A-Za-z0-9&.\s-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (desc.length < 3) continue;
    const tail = ft ? rec.slice(ft.idx) : rec;
    const amt = snapAmount(tail);
    out.push({
      type: ft ? ft.type : 'purchase', // Default: Kauf (dominiert; Verkäufe sind OCR-seitig schwerer)
      date: parseDate(tail),
      amount: amt ? amt.amount : '',
      low: amt ? amt.low : 0, high: amt ? amt.high : 0, mid: amt ? amt.mid : 0,
      rawDescription: desc,
    });
  }
  return out;
}

/* --- Hauptlauf ---------------------------------------------------------- */
const dataset = readJSON(STATE, { generatedAt: '', totals: {}, stocks: {} });
const seen    = readJSON(SEEN, {});
const resolve = buildResolver(readJSON(TICKERS, { byDescription: {}, byName: {} }));

const txId = t => sha1([t.type, t.date, t.amount, norm(t.rawDescription)].join('|'));
const existing = new Set();
for (const st of Object.values(dataset.stocks)) for (const t of (st.transactions || [])) existing.add(txId(t));

const html = await (await fetch(DISCLOSURES_URL, { headers: { 'User-Agent': UA } })).text();
const re = /<a[^>]*?(?:id="([^"]*)")?[^>]*?href="([^"]+\.pdf)"[^>]*?>\s*([^<]*Donald J\. Trump Periodic Transaction Report[^<]*)<\/a>/gi;
const filings = [];
let m;
while ((m = re.exec(html))) filings.push({ key: m[1] || m[2], url: m[2], title: m[3].replace(/\s+/g, ' ').trim() });
console.log(`WH-Seite: ${filings.length} Trump-PTR-Einträge.`);

const fresh = filings.filter(f => !seen[f.key]);
console.log(`Davon neu: ${fresh.length}`);

let added = 0;
for (const f of fresh) {
  console.log(`\n→ ${f.title}`);
  const pdf = join(mkdtempSync(join(tmpdir(), 'ptr-')), 'r.pdf');
  try {
    await download(f.url, pdf);
    const { text, via } = extractText(pdf);
    const parsed = parseTransactions(text);
    console.log(`  Text via ${via}, ${parsed.length} Transaktionen erkannt.`);
    let n = 0;
    for (const t of parsed) {
      const id = txId(t);
      if (existing.has(id)) continue;
      existing.add(id);
      const tk = resolve(t.rawDescription) || '_UNRESOLVED';
      dataset.stocks[tk] = dataset.stocks[tk] || {
        ticker: tk, name: tk === '_UNRESOLVED' ? 'Nicht aufgelöst' : tk, sector: '', transactions: [],
      };
      dataset.stocks[tk].transactions.push({
        date: t.date, type: t.type, amount: t.amount, mid: t.mid, low: t.low, high: t.high, rawDescription: t.rawDescription,
      });
      n++; added++;
    }
    console.log(`  ${n} neue Transaktionen übernommen.`);
    seen[f.key] = { title: f.title, url: f.url, count: n, processedAt: new Date().toISOString() };
  } catch (e) {
    console.log(`  ! Fehler: ${e.message} — wird nächstes Mal erneut versucht.`);
  }
}

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
