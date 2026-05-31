#!/usr/bin/env node
/**
 * track.mjs — Extraktions-Pipeline für Donald Trumps Periodic Transaction Reports.
 *
 *   1. whitehouse.gov/disclosures/ pollen  -> neue Trump-PTR-PDFs finden
 *   2. Transaktionen extrahieren:
 *        PRIMÄR: Gemini-Vision (sauber, inkl. Ticker)  — wenn GEMINI_API_KEY gesetzt
 *        FALLBACK: pdftotext/Tesseract + Regex-Parser
 *   3. in state/dataset.json einpflegen, Totals neu rechnen
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
const GEMINI_MODEL = 'gemini-2.5-flash';
const CHUNK_PAGES = 15; // Seiten je Gemini-Aufruf (begrenzt Request-Größe & Output)
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'state/dataset.json');
const SEEN  = join(HERE, 'state/seenFilings.json');
const TICKERS = join(HERE, 'tickers.json');

/* --- Helfer ------------------------------------------------------------- */
const readJSON  = (p, d) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d;
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1));
const norm      = s => (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const sha1      = s => createHash('sha1').update(s).digest('hex');
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const fixNum    = s => s.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');

function run(cmd, args, opts = {}) { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts }); }
function runQuiet(cmd, args) { try { return run(cmd, args); } catch { return null; } }
async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

/* --- Betrag auf Standard-OGE-Bänder einrasten --------------------------- */
const BANDS = [[1001,15000],[15001,50000],[50001,100000],[100001,250000],[250001,500000],
  [500001,1000000],[1000001,5000000],[5000001,25000000],[25000001,50000000],[50000001,100000000]];
const fmtUSD = n => '$' + n.toLocaleString('en-US');
function snapAmount(text) {
  const re = /\$\s*([0-9OoSlI.,\s]{3,})\s*[-–—�]\s*\$?\s*([0-9OoSlI.,\s]{3,})/g;
  let m, last = null;
  while ((m = re.exec(text || ''))) last = m;
  if (!last) return null;
  const low = parseInt(fixNum(last[1]).replace(/[.,\s]/g, ''), 10);
  if (!low) return null;
  let best = BANDS[0], bd = Infinity;
  for (const b of BANDS) { const d = Math.abs(Math.log10(b[0]) - Math.log10(low)); if (d < bd) { bd = d; best = b; } }
  return { amount: `${fmtUSD(best[0])} - ${fmtUSD(best[1])}`, low: best[0], high: best[1], mid: (best[0] + best[1]) / 2 };
}
function normalizeDate(s) {
  s = (s || '').trim();
  let m = /(\d{1,2})[\/\s.-]{1,3}(\d{1,2})[\/\s.-]{1,3}(\d{2,4})/.exec(s);
  if (m) { let mo=+m[1], d=+m[2], y=(''+m[3]).slice(-2); y=2000+ +y;
    if (mo<1||mo>12||d<1||d>31) return ''; if (y>2026||y<2024) y=2026;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/* --- PRIMÄR: Gemini-Vision ---------------------------------------------- */
function pdfPageCount(pdf) { const o = runQuiet('pdfinfo', [pdf]); const m = o && /Pages:\s*(\d+)/.exec(o); return m ? +m[1] : 1; }
function splitPdf(pdf, s, e) {
  const out = join(mkdtempSync(join(tmpdir(), 'chunk-')), 'c.pdf');
  return runQuiet('qpdf', ['--pages', pdf, `${s}-${e}`, '--', out]) !== null ? out : null;
}
const GEM_PROMPT = "This is Donald Trump's OGE Form 278-T periodic transaction report (a scanned filing). "
  + "Extract EVERY transaction row across all pages. For each row return: "
  + "company = the asset/security name exactly as printed; "
  + "ticker = the US stock/ETF ticker symbol if it is a publicly traded equity or ETF, otherwise empty string (e.g. for municipal/corporate bonds, notes, money-market or unknown); "
  + "type = 'purchase' or 'sale'; date = the transaction date; amount = the disclosed dollar range as printed. Do not invent rows.";
const GEM_SCHEMA = { type:'OBJECT', properties:{ transactions:{ type:'ARRAY', items:{ type:'OBJECT',
  properties:{ company:{type:'STRING'}, ticker:{type:'STRING'}, type:{type:'STRING'}, date:{type:'STRING'}, amount:{type:'STRING'} },
  required:['company','type'] } } }, required:['transactions'] };

async function geminiCallPdf(pdfPath) {
  const b64 = readFileSync(pdfPath).toString('base64');
  const body = { contents:[{ parts:[ { inline_data:{ mime_type:'application/pdf', data:b64 } }, { text:GEM_PROMPT } ] }],
    generationConfig:{ responseMimeType:'application/json', responseSchema:GEM_SCHEMA } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  if (r.status === 429) { await sleep(25000); return geminiCallPdf(pdfPath); } // Rate-Limit: kurz warten, 1 Retry
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('Gemini: leere/abgelehnte Antwort');
  return JSON.parse(txt).transactions || [];
}

async function geminiExtract(pdfPath) {
  const pages = pdfPageCount(pdfPath);
  const ranges = [];
  if (pages <= CHUNK_PAGES) ranges.push([1, pages]);
  else for (let s = 1; s <= pages; s += CHUNK_PAGES) ranges.push([s, Math.min(pages, s + CHUNK_PAGES - 1)]);

  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    const chunk = ranges.length === 1 ? pdfPath : (splitPdf(pdfPath, s, e) || pdfPath);
    const raw = await geminiCallPdf(chunk);
    for (const g of raw) {
      const amt = snapAmount(g.amount || '');
      out.push({
        ticker: (g.ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '') || null,
        type: /sale|sold/i.test(g.type || '') ? 'sale' : 'purchase',
        date: normalizeDate(g.date || ''),
        amount: amt ? amt.amount : (g.amount || ''),
        low: amt ? amt.low : 0, high: amt ? amt.high : 0, mid: amt ? amt.mid : 0,
        rawDescription: (g.company || '').trim(),
      });
    }
    if (ranges.length > 1 && i < ranges.length - 1) await sleep(4000); // Free-Tier-RPM schonen
  }
  return out;
}

/* --- FALLBACK: pdftotext/Tesseract + Regex ------------------------------ */
function extractText(pdfPath) {
  let txt = '';
  try { txt = run('pdftotext', ['-layout', pdfPath, '-']); } catch {}
  if (txt.replace(/\s/g, '').length > 800) return txt;
  const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
  runQuiet('pdftoppm', ['-r', '300', '-png', pdfPath, join(dir, 'p')]);
  let out = '';
  for (const f of readdirSync(dir).filter(f => f.endsWith('.png')).sort()) out += (runQuiet('tesseract', [join(dir, f), '-', '--psm', '6']) || '') + '\n';
  return out;
}
const SELL_RE = /sa[1li][eo]|so[1li]d|\bse[1li][1li]/i, BUY_RE = /urc[hl]|rcha|p[uo]r|0urch/i;
function findType(t){ const s=t.search(SELL_RE), b=t.search(BUY_RE); const c=[]; if(s>2)c.push([s,'sale']); if(b>2)c.push([b,'purchase']); if(!c.length)return null; c.sort((x,y)=>x[0]-y[0]); return {idx:c[0][0],type:c[0][1]}; }
function parseTextFallback(text) {
  const lines = text.split(/\r?\n/); const recs = []; let cur = null, expect = 1;
  for (const ln of lines) { const m=/^\s{0,5}(\d{1,4})\s{2,}(\S.*)$/.exec(ln);
    if (m && +m[1]>=expect && +m[1]<=expect+3) { if(cur)recs.push(cur); cur=m[2]; expect=+m[1]+1; }
    else if (m && +m[1]===1 && expect>50) { if(cur)recs.push(cur); cur=m[2]; expect=2; }
    else if (cur!=null) cur+=' '+ln.trim(); }
  if (cur!=null) recs.push(cur);
  const out = [];
  for (const rec of recs) { const ft=findType(rec); const idx=ft?ft.idx:Math.min(rec.length,80);
    const desc=rec.slice(0,idx).replace(/[^A-Za-z0-9&.\s-]+/g,' ').replace(/\s+/g,' ').trim();
    if (desc.length<3) continue; const tail=ft?rec.slice(ft.idx):rec; const amt=snapAmount(tail);
    out.push({ ticker:null, type:ft?ft.type:'purchase', date:normalizeDate(tail),
      amount:amt?amt.amount:'', low:amt?amt.low:0, high:amt?amt.high:0, mid:amt?amt.mid:0, rawDescription:desc }); }
  return out;
}

/* --- Ticker-Resolver (für Fallback / leere Gemini-Ticker) --------------- */
function buildResolver(tickers) {
  const fw = {};
  for (const [nm, tk] of Object.entries(tickers.byName || {})) {
    const k = nm.replace(/[^A-Z0-9 ]/g,'').split(' ').filter(w=>w.length>1).slice(0,2).join(' ');
    if (k.length>=6 && !fw[k]) fw[k]=tk;
  }
  return desc => { const n=norm(desc); if(tickers.byDescription?.[n])return tickers.byDescription[n];
    for(const[nm,tk]of Object.entries(tickers.byName||{})) if(nm.length>4&&n.startsWith(nm))return tk;
    const k=n.replace(/[^A-Z0-9 ]/g,'').split(' ').filter(w=>w.length>1).slice(0,2).join(' '); return fw[k]||null; };
}

/* --- Hauptlauf ---------------------------------------------------------- */
const dataset = readJSON(STATE, { generatedAt:'', totals:{}, stocks:{} });
const seen    = readJSON(SEEN, {});
const resolve = buildResolver(readJSON(TICKERS, { byDescription:{}, byName:{} }));
const useGemini = !!process.env.GEMINI_API_KEY;
console.log(useGemini ? 'Extraktion: Gemini-Vision (primär)' : 'Extraktion: OCR/Regex (kein GEMINI_API_KEY gesetzt)');

const txId = t => sha1([t.type, t.date, t.amount, norm(t.rawDescription)].join('|'));
const existing = new Set();
for (const st of Object.values(dataset.stocks)) for (const t of (st.transactions || [])) existing.add(txId(t));

const html = await (await fetch(DISCLOSURES_URL, { headers: { 'User-Agent': UA } })).text();
const re = /<a[^>]*?(?:id="([^"]*)")?[^>]*?href="([^"]+\.pdf)"[^>]*?>\s*([^<]*Donald J\. Trump Periodic Transaction Report[^<]*)<\/a>/gi;
const filings = []; let m;
while ((m = re.exec(html))) filings.push({ key:m[1]||m[2], url:m[2], title:m[3].replace(/\s+/g,' ').trim() });
console.log(`WH-Seite: ${filings.length} Trump-PTR-Einträge.`);
const fresh = filings.filter(f => !seen[f.key]);
console.log(`Davon neu: ${fresh.length}`);

let added = 0;
for (const f of fresh) {
  console.log(`\n→ ${f.title}`);
  const pdf = join(mkdtempSync(join(tmpdir(), 'ptr-')), 'r.pdf');
  try {
    await download(f.url, pdf);
    let parsed = null;
    if (useGemini) {
      try { parsed = await geminiExtract(pdf); console.log(`  Gemini: ${parsed.length} Transaktionen.`); }
      catch (e) { console.log(`  ! Gemini-Fehler: ${e.message} — Fallback auf OCR.`); parsed = null; }
    }
    if (!parsed) { parsed = parseTextFallback(extractText(pdf)); console.log(`  Fallback (OCR/Regex): ${parsed.length} Transaktionen.`); }

    let n = 0;
    for (const t of parsed) {
      const id = txId(t);
      if (existing.has(id)) continue;
      existing.add(id);
      const tk = t.ticker || resolve(t.rawDescription) || '_UNRESOLVED';
      dataset.stocks[tk] = dataset.stocks[tk] || { ticker:tk, name:tk==='_UNRESOLVED'?'Nicht aufgelöst':tk, sector:'', transactions:[] };
      dataset.stocks[tk].transactions.push({ date:t.date, type:t.type, amount:t.amount, mid:t.mid, low:t.low, high:t.high, rawDescription:t.rawDescription });
      n++; added++;
    }
    console.log(`  ${n} neue Transaktionen übernommen.`);
    seen[f.key] = { title:f.title, url:f.url, count:n, processedAt:new Date().toISOString() };
  } catch (e) {
    console.log(`  ! Fehler: ${e.message} — wird nächstes Mal erneut versucht.`);
  }
}

if (added > 0) {
  let buy=0, sell=0, n=0;
  for (const st of Object.values(dataset.stocks)) for (const t of st.transactions) { n++; if(t.type==='purchase')buy++; else if(t.type==='sale')sell++; }
  dataset.totals = { txCount:n, buyCount:buy, sellCount:sell, uniqueTickers:Object.keys(dataset.stocks).length };
  dataset.generatedAt = new Date().toISOString();
}
writeJSON(STATE, dataset);
writeJSON(SEEN, seen);
console.log(`\nFertig: ${added} neue Transaktionen, ${fresh.length} Filings verarbeitet.`);
