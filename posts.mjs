#!/usr/bin/env node
/**
 * posts.mjs — erkennt Trumps Truth-Social-Posts mit Aktien-Bezug.
 *
 *   1. trumpstruth.org/feed (RSS) pollen -> neue Posts
 *   2. Gemini klassifiziert: erwähnte börsennotierte Firma(en) + Sentiment + Marktrelevanz
 *   3. Posts mit Ticker -> state/posts.json (Push macht der Webspace, nur 'relevant')
 *
 * Nutzt denselben GEMINI_API_KEY wie track.mjs (nur Text, kein Vision).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const FEED = 'https://trumpstruth.org/feed';
const GEMINI_MODEL = 'gemini-2.5-flash';
const BATCH = 15;       // Posts pro Gemini-Aufruf
const KEEP = 250;       // wie viele Ticker-Posts in posts.json behalten
const HERE = dirname(fileURLToPath(import.meta.url));
const POSTS = join(HERE, 'state/posts.json');
const SEEN  = join(HERE, 'state/seenPosts.json');

const readJSON  = (p, d) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d;
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1));
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

function parseFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const b = m[1];
    const g = re => { const x = re.exec(b); return x ? x[1] : ''; };
    return {
      id: (g(/<guid[^>]*>([\s\S]*?)<\/guid>/).match(/\d+/) || [''])[0],
      text: strip(g(/<description>([\s\S]*?)<\/description>/)),
      date: g(/<pubDate>([\s\S]*?)<\/pubDate>/).trim(),
      url: g(/<link>([\s\S]*?)<\/link>/).trim(),
    };
  }).filter(p => p.id && p.text);
}

async function classify(posts) {
  const numbered = posts.map((p, i) => `[${i}] ${p.text.slice(0, 500)}`).join('\n\n');
  const prompt = "Diese nummerierten Posts stammen von Donald Trump (Truth Social). Erkenne erwähnte BÖRSENNOTIERTE Unternehmen.\n"
    + "tickers = Array von {ticker, company, sentiment: positive|negative|neutral} (auch wenn nicht relevant — nur fürs Listing).\n"
    + "relevant = true NUR wenn ALLE Punkte zutreffen:\n"
    + "  1) Ein konkretes, eindeutig börsennotiertes Unternehmen ist das HAUPTTHEMA des Posts (nicht beiläufig erwähnt).\n"
    + "  2) Der Post macht eine SUBSTANZIELLE, potenziell kursbewegende Aussage dazu: Lob/Kritik am Geschäft/Produkten/Management; angekündigte oder angedrohte Maßnahme (Zoll, Sanktion, Auftrag, Deal, Regulierung, Untersuchung, Subvention); konkrete Geschäfts-/Finanz-/Investitionsnachricht.\n"
    + "relevant = false (AUCH wenn ein Ticker vorkommt) bei:\n"
    + "  - Medienunternehmen (New York Times/NYT, CNN, Fox/FOXA, MSNBC, ABC, NBC, CBS, Washington Post, Politico, …), wenn sie nur als Nachrichtenquelle, Zitatgeber oder Ziel allgemeiner 'Fake News'-Kritik genannt werden;\n"
    + "  - Hinweisen auf TV-/Interview-Auftritte ('watch tonight …');\n"
    + "  - allgemeiner Politik, Wahlen, Migration, Personalien ohne konkrete Unternehmens-Aussage;\n"
    + "  - bloßer/beiläufiger Erwähnung ohne kursrelevante Aussage.\n"
    + "Im Zweifel relevant = false. Posts ohne Unternehmen: leeres tickers-Array und relevant=false.\n\nPosts:\n\n" + numbered;
  const body = { contents:[{ parts:[{ text: prompt }] }],
    generationConfig:{ responseMimeType:'application/json', responseSchema:{ type:'OBJECT', properties:{ results:{ type:'ARRAY', items:{ type:'OBJECT',
      properties:{ index:{type:'INTEGER'}, relevant:{type:'BOOLEAN'},
        tickers:{ type:'ARRAY', items:{ type:'OBJECT', properties:{ ticker:{type:'STRING'}, company:{type:'STRING'}, sentiment:{type:'STRING'} }, required:['ticker'] } } },
      required:['index','relevant'] } } }, required:['results'] } } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  if (r.status === 429) { await sleep(20000); return classify(posts); }
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0,150)}`);
  const j = await r.json();
  return JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text || '{"results":[]}').results || [];
}

/* --- Hauptlauf ---------------------------------------------------------- */
if (!process.env.GEMINI_API_KEY) { console.log('posts.mjs: kein GEMINI_API_KEY — übersprungen.'); process.exit(0); }

const posts = readJSON(POSTS, []);
const seen  = readJSON(SEEN, {});
const known = new Set(posts.map(p => p.id));

const xml = await (await fetch(FEED, { headers: { 'User-Agent': UA } })).text();
const items = parseFeed(xml);
console.log(`Feed: ${items.length} Posts.`);

const fresh = items.filter(p => !seen[p.id]);
console.log(`Neu (noch nicht klassifiziert): ${fresh.length}`);

let addedTicker = 0;
for (let i = 0; i < fresh.length; i += BATCH) {
  const batch = fresh.slice(i, i + BATCH);
  let results = [];
  try { results = await classify(batch); }
  catch (e) { console.log(`  ! Gemini-Fehler: ${e.message} — Batch übersprungen.`); continue; }
  for (const r of results) {
    const p = batch[r.index];
    if (!p) continue;
    seen[p.id] = 1;
    const tickers = (r.tickers || []).filter(t => t.ticker && t.ticker.trim());
    if (tickers.length && !known.has(p.id)) {
      posts.push({ id:p.id, date:p.date, url:p.url, text:p.text.slice(0, 400),
        tickers: tickers.map(t => ({ ticker:t.ticker.toUpperCase().replace(/[^A-Z0-9.]/g,''), company:t.company||'', sentiment:t.sentiment||'neutral' })),
        relevant: !!r.relevant });
      known.add(p.id); addedTicker++;
    }
  }
  // restliche der Batch ohne Treffer ebenfalls als gesehen markieren
  for (const p of batch) seen[p.id] = seen[p.id] || 1;
  if (i + BATCH < fresh.length) await sleep(5000);
}

// nach Datum sortieren (neueste zuerst) + begrenzen
posts.sort((a, b) => new Date(b.date) - new Date(a.date));
const trimmed = posts.slice(0, KEEP);

writeJSON(POSTS, trimmed);
writeJSON(SEEN, seen);
console.log(`Fertig: ${addedTicker} neue Ticker-Posts, ${trimmed.length} gesamt in posts.json.`);
