// tools/ingest-images.js
// Uso: node tools/ingest-images.js input.csv public/players output.csv
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, inCsv, outDir, outCsv] = process.argv;
if (!inCsv || !outDir || !outCsv) {
  console.error('Uso: node tools/ingest-images.js input.csv public/players output.csv');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

function normalizeKeys(obj) {
  const out = {};
  for (const k in obj) out[k.replace(/^\uFEFF/, '').trim()] = obj[k];
  return out;
}
function driveViewToDirect(url) {
  if (!url) return '';
  if (!/drive\.google\.com/i.test(url)) return url;
  const m1 = url.match(/\/d\/([-\w]{25,})/);
  const m2 = url.match(/[?&]id=([-\w]{25,})/);
  const id = (m1 && m1[1]) || (m2 && m2[1]);
  return id ? `https://drive.google.com/uc?export=view&id=${id}` : url;
}
function dropboxToDirect(url) {
  if (!url) return '';
  if (!/dropbox\.com/i.test(url)) return url;
  return url.replace('www.dropbox.com','dl.dropboxusercontent.com').replace('?dl=0','');
}
function normalizeImageUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = driveViewToDirect(u);
  u = dropboxToDirect(u);
  if (!/^https?:\/\//i.test(u)) return '';
  return u;
}
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function guessExt(ct) {
  if (!ct) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  return 'jpg';
}

async function downloadImage(url, destBase) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) throw new Error(`not image: ${ct}`);
  const ext = guessExt(ct);
  const dest = `${destBase}.${ext}`;
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return path.basename(dest); // filename.ext
}

function canonicalRow(raw) {
  const r = normalizeKeys(raw);
  const Nome = (r.Nome ?? r.nome ?? r.NOME ?? r.Player ?? r.Giocatore ?? '').toString().trim();
  const Ruolo = (r.Ruolo ?? r.ruolo ?? r.Role ?? '').toString().trim();
  const Squadra = (r.Squadra ?? r.squadra ?? r.Team ?? '').toString().trim();
  const VBraw = (r.ValoreBase ?? r['Valore Base'] ?? r.Base ?? r.base ?? 0);
  const ValoreBase = Number.parseInt(String(VBraw).replace(',', '.'), 10) || 0;
  const Immagine = (r.Immagine ?? r.Image ?? r.Foto ?? r.Photo ?? r.img ?? r.image ?? '').toString().trim();
  return { Nome, Ruolo, Squadra, ValoreBase, Immagine };
}

async function run() {
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(inCsv)
      .pipe(csv())
      .on('data', (row) => rows.push(canonicalRow(row)))
      .on('end', resolve)
      .on('error', reject);
  });

  for (const p of rows) {
    if (!p.Nome) continue;
    const url = normalizeImageUrl(p.Immagine);
    if (!url) { p.Immagine = ''; continue; }
    const base = path.join(outDir, slugify(p.Nome) || 'player');
    try {
      const filename = await downloadImage(url, base);
      // Salvi nel CSV un path web relativo alla root "public"
      p.Immagine = `/${path.relative(path.join(__dirname, '..', 'public'), path.join(outDir, filename)).replace(/\\/g,'/')}`;
      console.log('OK', p.Nome, '→', p.Immagine);
    } catch (e) {
      console.warn('SKIP', p.Nome, e.message);
      p.Immagine = ''; // userai il placeholder
    }
  }

  // Scrivi CSV di output (stessa intestazione)
  const header = 'Nome,Ruolo,Squadra,ValoreBase,Immagine\n';
  const lines = rows
    .filter(p => p.Nome)
    .map(p => [
      p.Nome.replace(/"/g,'""'),
      p.Ruolo.replace(/"/g,'""'),
      p.Squadra.replace(/"/g,'""'),
      p.ValoreBase,
      p.Immagine.replace(/"/g,'""')
    ].map(v => `"${v}"`).join(','));
  fs.writeFileSync(outCsv, header + lines.join('\n'), 'utf8');
  console.log('Scritto', outCsv);
}

run().catch(e => { console.error(e); process.exit(1); });
