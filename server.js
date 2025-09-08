// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const HOST_PIN = process.env.HOST_PIN;
const INVITE_SECRET = process.env.INVITE_SECRET;
if (!HOST_PIN || !INVITE_SECRET) {
  console.error('Missing required env vars HOST_PIN and/or INVITE_SECRET');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.type('text').send('ok'));

// --- Proxy per immagini esterne (es. content.fantacalcio.it) ---
const ALLOWED_IMG_HOSTS = ['content.fantacalcio.it'];
const MAX_IMG_SIZE = 5 * 1024 * 1024; // 5 MB

// Mapping dei ruoli da lettera a nome esteso
const ROLE_MAP = { A: 'Attaccante', D: 'Difensore', C: 'Centrocampista', P: 'Portiere' };
// Mappa per gli slot disponibili per ruolo
const FASCIA_TO_ROLE = { P:'por', D:'dif', C:'cen', A:'att' };

app.get('/img-proxy', async (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).type('text').send('missing url');

  let url;
  try {
    url = new URL(u);
  } catch {
    return res.status(400).type('text').send('invalid url');
  }

  if (!/^https?:$/.test(url.protocol)) {
    return res.status(400).type('text').send('invalid protocol');
  }
  if (ALLOWED_IMG_HOSTS.length && !ALLOWED_IMG_HOSTS.includes(url.hostname)) {
    return res.status(400).type('text').send('domain not allowed');
  }

  try {
    const upstream = await fetch(url.href, { size: MAX_IMG_SIZE });
    if (!upstream.ok) {
      return res.status(500).type('text').send('upstream error');
    }

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.set('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.set('Content-Length', cl);

    upstream.body.on('error', () => {
      if (!res.headersSent) res.status(500).type('text').send('stream error');
    });
    upstream.body.pipe(res);
  } catch (err) {
    console.error('/img-proxy error:', err);
    res.status(500).type('text').send('fetch error');
  }
});


// === Upload CSV (HTTP) — versione robusta ===
const upload = multer({ dest: 'uploads/' });
let players = []; // [{ Nome, Ruolo?, Squadra?, ValoreBase?, Immagine? }]

// === Log file (rotazione giornaliera) ===
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs'); // ← usa CWD per sicurezza
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log('[log] Using LOG_DIR =', LOG_DIR);
} catch (e) {
  console.error('[log] mkdir error:', e);
}

function addToRoundIfEligible(participantId) {
  if (!roundMode) return false;
  const c = getClientByParticipantId(participantId);
  if (!eligibleBidder(c)) return false;

  if (!nominationOrder.includes(participantId)) {
    nominationOrder.push(participantId);           // accoda al giro corrente
    // se non c’è nominatore attivo (o era invalido) scegli il primo valido
    if (!currentNominatorId || !eligibleBidder(getClientByParticipantId(currentNominatorId))) {
      pickFirstEligible();
    }
    broadcastRoundState();
    return true;
  }
  return false;
}

function logFileForToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `auction-${yyyy}${mm}${dd}.log`);
}

function appendLogToFile(entry) {
  const line = JSON.stringify({
    ...entry,
    timeISO: new Date(entry.time ?? Date.now()).toISOString()
  }) + '\n';
  fs.appendFile(logFileForToday(), line, (err) => {
    if (err) console.error('[log] append error:', err);
  });
}

// --- Scarica il log di oggi ---
app.get('/logs/today', (req, res) => {
  try {
    const file = logFileForToday();
    if (!fs.existsSync(file)) return res.status(404).type('text').send('Nessun log per oggi');
    res.download(file, path.basename(file)); // forza download
  } catch (e) {
    res.status(500).type('text').send('Errore download log: ' + e.message);
  }
});

// --- Elenco dei log disponibili (opzione avanzata) ---
app.get('/logs/list', (req, res) => {
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) return res.status(500).json({ success:false, error: err.message });
    const list = (files || [])
      .filter(f => f.endsWith('.log'))
      .sort((a,b) => b.localeCompare(a)); // più recenti prima
    res.json({ success:true, files:list });
  });
});

// --- Download log per nome (opzione avanzata) ---
app.get('/logs/file/:name', (req, res) => {
  const name = req.params.name;
  // piccola sanitizzazione: niente path traversal, solo .log
  if (!/^[\w.-]+\.log$/.test(name)) return res.status(400).type('text').send('Nome file non valido');
  const file = path.join(LOG_DIR, name);
  if (!file.startsWith(LOG_DIR)) return res.status(400).type('text').send('Percorso non valido');
  if (!fs.existsSync(file)) return res.status(404).type('text').send('File non trovato');
  res.download(file, name);
});

// Rimuove BOM/spazi dagli header
function normalizeKeys(obj) {
  const out = {};
  for (const k in obj) out[k.replace(/^\uFEFF/, '').trim()] = obj[k];
  return out;
}

// Rende omogenea una riga del CSV (accetta varianti di header o indici numerici)
function canonicalRow(row) {
  // Se la riga è un array o ha chiavi numeriche, mappa gli indici
  if (Array.isArray(row) || Object.keys(row).some(k => /^\d+$/.test(k))) {
    const arr = Array.isArray(row)
      ? row
      : Object.keys(row).sort((a, b) => a - b).map(k => row[k]);
    const Nome    = (arr[1]  ?? '').toString().trim();
    const rawRole = (arr[3]  ?? '').toString().trim();
    const Ruolo   = ROLE_MAP[(rawRole || '').toUpperCase()] || rawRole;
    const Squadra = (arr[9]  ?? '').toString().trim();
    const Immagine = (arr[15] ?? '').toString().trim();
    return { Nome, Ruolo, Squadra, ValoreBase: 0, Immagine };
  }

  // Caso standard: usa gli header
  const r = normalizeKeys(row);

  const Nome    = (r.Nome ?? r.nome ?? r.NOME ?? r.Player ?? r.Giocatore ?? '').toString().trim();
  const rawRole = (r.Ruolo ?? r.ruolo ?? r.Role ?? '').toString().trim();
  const Ruolo   = ROLE_MAP[(rawRole || '').toUpperCase()] || rawRole;
  const Squadra = (r.Squadra ?? r.squadra ?? r.Team ?? '').toString().trim();
  const VBraw   = (r.ValoreBase ?? r['Valore Base'] ?? r.Base ?? r.base ?? 0);
  const ValoreBase = Number.parseInt(String(VBraw).replace(',', '.'), 10) || 0;

  // 👇 prende la colonna immagine così com’è (può essere /players/xxx.jpg o http/https)
  const Immagine = (r.Immagine ?? r.Image ?? r.Foto ?? r.Photo ?? r.img ?? r.image ?? '').toString().trim();

  return { Nome, Ruolo, Squadra, ValoreBase, Immagine };
}


app.post('/upload', upload.single('csv'), async (req, res) => {
  const parseCsv = (opts) => new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(req.file.path)
      .pipe(csv(opts))
      .on('data', (rawRow) => {
        try {
          const p = canonicalRow(rawRow);
          if (p.Nome) rows.push(p);
        } catch { /* ignora */ }
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });

  try {
    let list = await parseCsv();

    const isNumeric = (v) => /^\d+$/.test(String(v || ''));
    let first = list[0];

    if (!list.length || (first && (isNumeric(first.Nome) || isNumeric(first.Ruolo)))) {
      // possibile assenza di header: riparsiamo con indici numerici
      list = await parseCsv({ headers: false });
      first = list[0];
    }

    if (!first || !first.Nome || !first.Ruolo || isNumeric(first.Nome) || isNumeric(first.Ruolo)) {
      console.warn('[CSV] nessuna intestazione valida (Nome/Ruolo)');
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ success: false, error: 'CSV senza intestazioni valide (Nome/Ruolo)' });
    }

    try { fs.unlinkSync(req.file.path); } catch {}
    players = list;
    if (players[0]) console.log('[CSV] Prima riga normalizzata:', players[0]);
    broadcast({ type: 'players-list', players });
    res.json({ success: true, players });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ success: false, error: String(err) });
  }
});

// === Round Robin (1 nomina per turno) ===
let roundMode = false;
let nominationOrder = [];      // array di participantId
let nominationIndex = 0;       // indice corrente dentro nominationOrder
let currentNominatorId = null; // participantId a cui "tocca"

const participantClients = new Map(); // participantId -> clientId

function getClientByParticipantId(pid) {
  const cid = participantClients.get(pid);
  return cid ? clients.get(cid) || null : null;
}

function eligibleBidder(c){
  if (!c) return false;
  ensureBudgetFields(c);
  return !c.isHost && c.role !== 'monitor' && totalSlotsRemaining(c.slotsByRole) > 0;
}

function buildNominationOrder(strategy='random'){
  const arr = [];
  const regs = listParticipants();
  for (const p of regs) {
    if (!p.isHost && p.role !== 'monitor') {
      arr.push({ id: p.id, name: p.name || 'Anonimo' });
    }
  }
  // include any connected participants not yet persisted
  for (const [pid, cid] of participantClients) {
    if (!arr.some(x => x.id === pid)) {
      const c = clients.get(cid);
      if (c && !c.isHost && c.role !== 'monitor') {
        arr.push({ id: pid, name: c.name || 'Anonimo' });
      }
    }
  }
  if (strategy === 'name') {
    arr.sort((a,b)=> (a.name||'').localeCompare(b.name||'', 'it', {sensitivity:'base'}));
  } else {
    for (let i=arr.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  }
  return arr.map(x=>x.id);
}

// scegli il primo eleggibile nell’ordine
function pickFirstEligible(){
  if (!roundMode || nominationOrder.length===0) { currentNominatorId=null; return null; }
  for (let k=0; k<nominationOrder.length; k++){
    const pid = nominationOrder[k];
    if (eligibleBidder(getClientByParticipantId(pid))) { nominationIndex = k; currentNominatorId = pid; return pid; }
  }
  currentNominatorId = null; return null;
}

// passa al prossimo eleggibile (una nomina per turno)
function advanceNominatorNext(){
  if (!roundMode || nominationOrder.length===0) { currentNominatorId=null; return null; }
  const N = nominationOrder.length;
  for (let step=1; step<=N; step++){
    nominationIndex = (nominationIndex + 1) % N;
    const pid = nominationOrder[nominationIndex];
    if (eligibleBidder(getClientByParticipantId(pid))) { currentNominatorId = pid; return pid; }
  }
  currentNominatorId = null; return null;
}

function broadcastRoundState(){
  const names = {};
  const online = {};
  const regs = listParticipants();
  for (const p of regs) {
    names[p.id] = p.name || 'Anonimo';
    online[p.id] = false;
  }
  for (const [pid, cid] of participantClients) {
    const c = clients.get(cid);
    if (c) {
      names[pid] = c.name || names[pid] || 'Anonimo';
      online[pid] = true;
    }
  }
  broadcast({
    type: 'round-state',
    roundMode,
    order: nominationOrder,
    current: currentNominatorId,            // alias storico
    currentNominatorId: currentNominatorId, // alias esplicito per la UI
    names,
    online
  });
}

function skipCurrentNominator() {
  if (!roundMode || nominationOrder.length === 0) {
    currentNominatorId = null;
    return { prev: null, next: null, changed: false, reason: 'round-inactive-or-empty' };
  }

  const prev = currentNominatorId || null;

  // Riallinea l'indice al current se presente
  const idx = prev ? nominationOrder.indexOf(prev) : -1;
  if (idx >= 0) nominationIndex = idx;

  const N = nominationOrder.length;
  if (N === 0) {
    currentNominatorId = null;
    return { prev, next: null, changed: false, reason: 'empty-after-clean' };
  }

  // Avanza finché trovi un eleggibile diverso dal precedente (max N tentativi)
  let nextId = prev;
  for (let step = 1; step <= N; step++) {
    nominationIndex = (nominationIndex + 1) % N;
    const candidate = nominationOrder[nominationIndex];
    if (eligibleBidder(getClientByParticipantId(candidate))) {
      nextId = candidate;
      break;
    }
  }

  // Se nessuno è eleggibile, azzera
  if (!eligibleBidder(getClientByParticipantId(nextId))) {
    currentNominatorId = null;
    return { prev, next: null, changed: prev !== null, reason: 'no-eligible' };
  }

  currentNominatorId = nextId;
  return { prev, next: nextId, changed: prev !== nextId, reason: 'ok' };
}


// === Stato asta (single room) ===
const clients = new Map(); // id -> { ws, name, role: 'host'|'bidder'|'monitor', isHost, credits, slots }
let currentItem = null;   // { id, name, startPrice, role?, fascia?, team?, image? }
let currentPrice = 0;
let currentBidder = null; // nome
let minIncrement = 1;
let timerHandle = null;
let logEntries = [];      // [{type,time,...}]
let bidHistory = [];      // [{t, name, amount}]

let baseCountdownSeconds = 12; // impostazione del gestore (esposta in UI)
let showBidderDetails = false; // se i bidder vedono dettagli completi dell'item
let showRosterToBidders = false;

function dynamicSecondsFor(price) {
  const b = Math.max(5, baseCountdownSeconds); // difesa minima
  let factor = 1.0;
  if (price >= 200)      factor = 0.60; // -40%
  else if (price >= 150) factor = 0.70; // -30%
  else if (price >= 100) factor = 0.80; // -20%
  const secs = Math.max(3, Math.round(b * factor)); // non scendere mai sotto 3s
  return secs;
}


// Budget/slot configurabili dal gestore
let defaultCredits = 0;
let defaultSlotsByRole = { por: 3, dif: 8, cen: 8, att: 6 }; // POR, DIF, CEN, ATT

function cloneSlots(o){ return { por:o.por||0, dif:o.dif||0, cen:o.cen||0, att:o.att||0 }; }
function ensureBudgetFields(c) {
  if (c.credits == null) c.credits = defaultCredits;
  if (!c.slotsByRole)        c.slotsByRole        = cloneSlots(defaultSlotsByRole);
  if (c.initialCredits == null) c.initialCredits  = defaultCredits;
  if (!c.initialSlotsByRole)    c.initialSlotsByRole = cloneSlots(defaultSlotsByRole);
}

function roleKeyFromText(t=''){
  const r = String(t).toLowerCase();
  if (r.includes('port') || r.startsWith('por')) return 'por';
  if (r.includes('dif')  || r.startsWith('dif')) return 'dif';
  if (r.includes('cent') || r.startsWith('cen')) return 'cen';
  if (r.includes('att')  || r.startsWith('att')) return 'att';
  return null;
}
function totalSlotsRemaining(slotsByRole){
  const s = slotsByRole || {};
  return (s.por||0)+(s.dif||0)+(s.cen||0)+(s.att||0);
}

function now() { return Date.now(); }
function lastNBids(n=3){ return bidHistory.slice(-n); }

function pushLog(entry) {
	console.log('[LOG]', entry);  
  logEntries.push(entry);
  appendLogToFile(entry);
  for (const [, c] of clients) {
    if (c.isHost && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'log-update', entries: logEntries }));
    }
  }
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const [, c] of clients) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
  }
}

function broadcastUsers() {
  const users = [];
  for (const [id, c] of clients) {
    ensureBudgetFields(c);
    users.push({
      id,
      participantId: c.participantId || null,
      name: c.name,
      isHost: c.isHost,
      role: c.role || 'bidder',
      credits: c.credits ?? 0,
      initialCredits: c.initialCredits ?? 0,
      slotsByRole: cloneSlots(c.slotsByRole || {}),
      initialSlotsByRole: cloneSlots(c.initialSlotsByRole || {}),
      online: true
    });
  }
  broadcast({ type: 'user-list', users });
}

function broadcastRoster() {
  const roster = {};
  for (const p of listParticipants()) {
    if (p.role === 'host' || p.role === 'monitor') continue;
    roster[p.id] = Array.isArray(p.players) ? p.players : [];
  }
  const s = JSON.stringify({ type: 'roster-update', roster });
  for (const [, c] of clients) {
    if ((c.isHost || c.role === 'monitor' || (showRosterToBidders && c.role === 'bidder')) &&
        c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(s);
    }
  }
}

function startTimer(secs) {
  if (timerHandle) clearTimeout(timerHandle);
  const s = Math.max(1, Math.floor(secs || baseCountdownSeconds));
  timerHandle = setTimeout(() => endAuction('timeout'), s * 1000);
}

function resetTimer(secs) {
  // ricalcola in base al prezzo corrente (o usa override)
  const s = Number.isFinite(secs)
    ? Math.max(1, Math.floor(secs))
    : dynamicSecondsFor(currentPrice || Number(currentItem?.startPrice || 0) || 0);
  startTimer(s);
  broadcast({ type: 'reset-timer', seconds: s });
  return s;
}


function endAuction(reason = 'manual') {
  if (!currentItem) return;

  // 1) Risolviamo winnerId PRIMA di qualsiasi detrazione
  let winnerId = null;

  // Se abbiamo salvato l'ID con i bid, usiamo quello se esiste ancora
  if (currentBidderId && clients.has(currentBidderId)) {
    winnerId = currentBidderId;
  } else if (currentBidder) {
    // fallback legacy: cerca per nome (non affidabile con omonimi, ma compat)
    for (const [id, c] of clients) {
      if (c.name === currentBidder) { winnerId = id; break; }
    }
  }

  const winnerName = winnerId ? (clients.get(winnerId)?.name || 'Nessuno') : 'Nessuno';
  const amount = currentPrice || Number(currentItem.startPrice || 0) || 0;
  const wClient = winnerId ? clients.get(winnerId) : undefined;
  const winnerPid = wClient?.participantId;

  if (winnerPid) {
    addPlayer(winnerPid, {
      id: currentItem.id,
      name: currentItem.name,
      img: currentItem.image,
      fascia: currentItem.fascia,
      price: amount
    });
    broadcastRoster();
  }

  // 2) Detrae budget/slot se abbiamo un vincitore e il ruolo è valido
  const rkey = roleKeyFromText(currentItem?.role || '');
  if (wClient && rkey) {
    ensureBudgetFields(wClient);
    wClient.credits = Math.max(0, (wClient.credits || 0) - amount);
    wClient.slotsByRole[rkey] = Math.max(0, (wClient.slotsByRole[rkey] || 0) - 1);
  }

  // 3) Notifica esito asta
  broadcast({
    type: 'auction-ended',
    item: currentItem,
    winner: winnerName,
    amount,
    last3: lastNBids(3)
    // bidderId: winnerId, // <-- opzionale se vuoi inviarlo alla UI
  });
  pushLog({ type: 'auction-end', time: now(), item: currentItem, winner: winnerName, amount, reason });

  // 4) Reset stato asta
  currentItem = null;
  currentPrice = 0;
  currentBidder = null;
  currentBidderId = null;  // <-- importante se usi l'ID
  bidHistory = [];
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }

  // 5) Aggiorna UI utenti e (se attivo) stato round
  broadcastUsers();
  if (roundMode) {
    broadcastRoundState();
  }
}




function sendStateToClient(client, wsRef) {
  ensureBudgetFields(client);
  const secondsEstimate = currentItem
    ? dynamicSecondsFor(currentPrice || Number(currentItem?.startPrice || 0) || 0)
    : null;

  const payloadCommon = {
    type: 'state',
    countdownSeconds: baseCountdownSeconds,
    seconds: secondsEstimate,
    price: currentPrice,
    bidder: currentBidder,
    last3: lastNBids ? lastNBids(3) : [],
    roundMode, nominationOrder, currentNominatorId,
    showBidderDetails
  };

  if (client.role === 'host' || client.role === 'monitor') {
    wsRef.send(JSON.stringify({ ...payloadCommon, item: currentItem || null }));
  } else {
    if (showBidderDetails) {
      wsRef.send(JSON.stringify({ ...payloadCommon, item: currentItem || null }));
    } else {
      wsRef.send(JSON.stringify({ ...payloadCommon, playerName: currentItem ? currentItem.name : null }));
    }
  }
}

function broadcastAuctionStartedTailoredWithSeconds(secs){
  for (const [, c] of clients) {
    if (c.ws.readyState !== 1) continue;
    if (c.role === 'host' || c.role === 'monitor') {
      c.ws.send(JSON.stringify({
        type: 'auction-started',
        item: currentItem,
        seconds: secs,
        price: currentPrice,
        bidder: currentBidder,
        last3: [],
        showBidderDetails
      }));
    } else {
      if (showBidderDetails) {
        c.ws.send(JSON.stringify({
          type: 'auction-started',
          item: currentItem,
          seconds: secs,
          price: currentPrice,
          bidder: currentBidder,
          last3: [],
          showBidderDetails
        }));
      } else {
        c.ws.send(JSON.stringify({
          type: 'auction-started',
          playerName: currentItem?.name || '—',
          seconds: secs,
          price: currentPrice,
          bidder: currentBidder,
          last3: [],
          showBidderDetails
        }));
      }
    }
  }
}

// Heartbeat globale: gira una volta ogni 30s per tutti i client
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

let currentBidderId = null;

// === WebSocket ===
wss.on('connection', (ws) => {
  const clientId = now() + '-' + Math.random().toString(36).slice(2);
  clients.set(clientId, {
    ws,
    participantId: null,

    name: 'Anonimo',
    role: 'bidder',
    isHost: false,

    credits: null, initialCredits: null,
    slotsByRole: null, initialSlotsByRole: null
  });

  // Ogni client: inizializza flag e aggiorna su pong
  ws.isAlive = true;
  ws.on('pong', function() { this.isAlive = true; });

  ws.on('message', (raw) => {
	  let msg; try { msg = JSON.parse(raw); } catch { return; }
	  if (msg && msg.type === 'ping') {
		ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
		return;
	  }
		
	if (msg.type === 'join' && msg.token) {
      try {
        const payload = verify(msg.token, INVITE_SECRET); // { pid, role, iat, exp }
        const p = getParticipant(payload.pid);
        if (!p) throw new Error('participant-not-found');

        const c = clients.get(clientId);
        c.participantId = p.id;
        participantClients.set(p.id, clientId);
        c.name = p.name || 'Anonimo';
        c.role = p.role || 'bidder';
        c.isHost = !!p.isHost;

        // Idrata budget/slot dai dati persistiti (o fallback ai default)
        ensureBudgetFields(c); // mantiene la tua logica, ma prima proviamo con i valori del participant
        if (Number.isFinite(p.credits)) {
          c.credits = p.credits;
          c.initialCredits = Number.isFinite(p.initialCredits) ? p.initialCredits : p.credits;
        }
        if (p.slotsByRole && typeof p.slotsByRole === 'object') {
          c.slotsByRole = cloneSlots(p.slotsByRole);
          c.initialSlotsByRole = cloneSlots(p.initialSlotsByRole || p.slotsByRole);
        }
        ensureBudgetFields(c); // garantisce che nulla resti null

        // Rispondi come al solito (+ participantId)
        ws.send(JSON.stringify({
          type: 'joined',
          success: true,
          name: c.name,
          role: c.role,
          clientId,                 // id sessione
          participantId: c.participantId  // id stabile
        }));
        ws.send(JSON.stringify({ type: 'players-list', players }));
        sendStateToClient(c, ws);
        broadcastUsers();
        addToRoundIfEligible(c.participantId);
        broadcastRoundState();
        if (showRosterToBidders) {
          broadcast({ type: 'show-roster-bidders', enabled: true });
        }
        broadcastRoster();
      } catch (e) {
        try { ws.send(JSON.stringify({ type:'error', message: `Join fallita: ${e.message}` })); } catch {}
        try { ws.close(); } catch {}
      }
      return;
    }

	// === Join tramite invito "semplice" (invites.json) ===
	if (msg.type === 'join-by-invite' && msg.token) {
	  const token = String(msg.token);
	  const list = loadInvites();
	  const inv = list.find(x => x.token === token && !x.revoked);
	  if (!inv) {
		try { ws.send(JSON.stringify({ type:'error', message:'Invito non valido o revocato.' })); } catch {}
		return;
	  }

	  // 👇 AUTO-FIX: se l’invito non ha participantId, assegnane uno ora e persistilo
	  if (!inv.participantId) {
		inv.participantId = 'p_' + Math.random().toString(36).slice(2, 10);
		saveInvites(list);
	  }

	  // Recupera (o crea) il participant con quell’ID
	  let p = getParticipant(inv.participantId);
	  if (!p) {
		p = upsertParticipant({
		  id: inv.participantId,
		  name: inv.name || 'Ospite',
		  role: inv.role || 'bidder',
		  isHost: inv.role === 'host',
		  credits: defaultCredits ?? 0,
		  initialCredits: defaultCredits ?? 0,
		  slotsByRole: cloneSlots(defaultSlotsByRole),
		  initialSlotsByRole: cloneSlots(defaultSlotsByRole),
		});
	  }
	  
	  // idrata la sessione
          const c = clients.get(clientId);
          c.participantId = p.id;
          participantClients.set(p.id, clientId);
          c.name = p.name || 'Anonimo';
	  c.role = p.role || 'bidder';
	  c.isHost = !!p.isHost;

	  // porta dentro i budget/slot persistiti (se presenti)
	  ensureBudgetFields(c);
	  if (Number.isFinite(p.credits)) {
		c.credits = p.credits;
		c.initialCredits = Number.isFinite(p.initialCredits) ? p.initialCredits : p.credits;
	  }
	  if (p.slotsByRole && typeof p.slotsByRole === 'object') {
		c.slotsByRole = cloneSlots(p.slotsByRole);
		c.initialSlotsByRole = cloneSlots(p.initialSlotsByRole || p.slotsByRole);
	  }
	  ensureBudgetFields(c);

          ws.send(JSON.stringify({
                type: 'joined',
                success: true,
                name: c.name,
                role: c.role,
                clientId,
                participantId: c.participantId
          }));
          ws.send(JSON.stringify({ type: 'players-list', players }));
        sendStateToClient(c, ws);
        if (showRosterToBidders) {
          broadcast({ type: 'show-roster-bidders', enabled: true });
        }
        broadcastRoster();
        broadcastUsers();
        addToRoundIfEligible(c.participantId);
        broadcastRoundState();
        return;
      }


    // Accesso diretto senza invito: consentito solo ai monitor con PIN
    if (msg.type === 'join') {
      const name = (msg.name || 'Anonimo').trim();
      const role = msg.role;

      if (role === 'bidder') {
        ws.send(JSON.stringify({ type: 'error', message: 'I partecipanti devono usare un link d\'invito.' }));
        return;
      }

      if (role !== 'monitor') {
        ws.send(JSON.stringify({ type: 'error', message: 'Ruolo non valido.' }));
        return;
      }

      if (String(msg.pin) !== HOST_PIN) {
        ws.send(JSON.stringify({ type: 'error', message: 'PIN errato' }));
        return;
      }

      const c = clients.get(clientId);
      c.name = name;
      c.role = 'monitor';
      ensureBudgetFields(c);

      ws.send(JSON.stringify({ type: 'joined', success: true, name, role: 'monitor', clientId }));
      ws.send(JSON.stringify({ type: 'players-list', players }));
      sendStateToClient(c, ws);
      if (showRosterToBidders) {
        ws.send(JSON.stringify({ type: 'show-roster-bidders', enabled: true }));
      }
      broadcastRoster();
      broadcastUsers();
      // monitor non vengono aggiunti al giro nominatori
      return;
    }

    // Gestore (con PIN)
    if (msg.type === 'host-login') {
	  const ok = String(msg.pin) === HOST_PIN;
	  const c = clients.get(clientId);

	  if (ok) { 
		c.isHost = true; 
		c.role = 'host'; 
                ws.send(JSON.stringify({ type: 'host-auth', success: true, clientId }));
                ws.send(JSON.stringify({ type: 'log-update', entries: logEntries }));
                ws.send(JSON.stringify({ type: 'players-list', players }));
                sendStateToClient(c, ws);
                ws.send(JSON.stringify({ type: 'show-roster-bidders', enabled: showRosterToBidders }));
                broadcastRoster();
          } else {
                ws.send(JSON.stringify({ type: 'host-auth', success: false }));
          }

	  broadcastUsers();
	  return;
	}


    // === Controlli gestore: budget/slot ===
    // Imposta defaults per tutti (e per i futuri)
	// === Host: skippa nominatore corrente (passa al prossimo eleggibile) ===
	if (msg.type === 'host:skip-nominator') {
	  const me = clients.get(clientId);
	  if (!me || !me.isHost) { 
		ws.send(JSON.stringify({ type:'error', message:'Non autorizzato' })); 
		console.log('[WS] host:skip-nominator rifiutato: client non host', { clientId });
		return; 
	  }

	  if (!roundMode) {
		ws.send(JSON.stringify({ type:'host:skip-ack', ok:false, reason:'round-not-active' }));
		console.log('[WS] host:skip-nominator ignorato: round non attivo');
		return;
	  }

          console.log('[WS] host:skip-nominator ricevuto. Prima di skip:', {
                currentNominatorId,
                currentName: currentNominatorId ? participantName(currentNominatorId) : null,
                nominationOrder: nominationOrder.map(id => participantName(id))
          });

	  const result = skipCurrentNominator();
	  broadcastRoundState();

	  ws.send(JSON.stringify({
		type: 'host:skip-ack',
		ok: result.changed || result.next !== null,
		reason: result.reason,
		prev: result.prev,
		next: result.next,
                prevName: result.prev ? (participantName(result.prev) || '—') : null,
                nextName: result.next ? (participantName(result.next) || '—') : null
          }));

          console.log('[WS] host:skip-nominator esito:', result, {
                newCurrent: currentNominatorId,
                newName: currentNominatorId ? participantName(currentNominatorId) : null
          });

	  pushLog({
		type: 'round-skip',
		time: now(),
                prev: result.prev ? (participantName(result.prev) || result.prev) : null,
                next: result.next ? (participantName(result.next) || result.next) : null,
                reason: result.reason
          });
          return;
        }

	
    if (msg.type === 'host:set-budgets' && clients.get(clientId).isHost) {
	  const cr = Math.max(0, Math.floor(Number(msg.credits) || 0));
	  const slotsPor = Math.max(0, Math.floor(Number(msg.slotsPor ?? 3)));
	  const slotsDif = Math.max(0, Math.floor(Number(msg.slotsDif ?? 8)));
	  const slotsCen = Math.max(0, Math.floor(Number(msg.slotsCen ?? 8)));
	  const slotsAtt = Math.max(0, Math.floor(Number(msg.slotsAtt ?? 6)));

	  defaultCredits = cr;
	  defaultSlotsByRole = { por: slotsPor, dif: slotsDif, cen: slotsCen, att: slotsAtt };

	  for (const [, c] of clients) if (!c.isHost) {
		c.credits = cr; c.initialCredits = cr;
		c.slotsByRole = cloneSlots(defaultSlotsByRole);
		c.initialSlotsByRole = cloneSlots(defaultSlotsByRole);
	  }

          pushLog({ type: 'budgets-set', time: now(), credits: cr, slotsByRole: defaultSlotsByRole });
          broadcastUsers();
          if (roundMode) { if (!eligibleBidder(getClientByParticipantId(currentNominatorId))) pickFirstEligible(); broadcastRoundState(); }
          return;
        }


    // Aggiorna singolo bidder (delta o set)
    if (msg.type === 'host:update-bidder' && clients.get(clientId).isHost) {
	  const t = clients.get(String(msg.clientId));
	  if (!t) { ws.send(JSON.stringify({ type:'error', message:'Utente non trovato' })); return; }
	  ensureBudgetFields(t);

	  if (Object.prototype.hasOwnProperty.call(msg, 'setCredits'))
		t.credits = Math.max(0, Math.floor(Number(msg.setCredits) || 0));
	  if (Object.prototype.hasOwnProperty.call(msg, 'creditsDelta'))
		t.credits = Math.max(0, (t.credits||0) + Math.floor(Number(msg.creditsDelta)||0));

	  // set/delta per ruolo, es: { setSlotsByRole: {por:2} } oppure { slotsDeltaRole: {role:'dif', delta:+1} }
	  if (msg.setSlotsByRole && typeof msg.setSlotsByRole === 'object') {
		const obj = msg.setSlotsByRole;
		['por','dif','cen','att'].forEach(k=>{
		  if (obj[k] != null) t.slotsByRole[k] = Math.max(0, Math.floor(Number(obj[k])||0));
		});
	  }
	  if (msg.slotsDeltaRole && typeof msg.slotsDeltaRole === 'object') {
		const { role, delta } = msg.slotsDeltaRole;
		if (['por','dif','cen','att'].includes(role)) {
		  t.slotsByRole[role] = Math.max(0, (t.slotsByRole[role]||0) + Math.floor(Number(delta)||0));
		}
	  }

          pushLog({ type:'bidder-update', time: now(), target: t.name, credits: t.credits, slotsByRole: t.slotsByRole });
          broadcastUsers();
          if (roundMode) { if (!eligibleBidder(getClientByParticipantId(currentNominatorId))) pickFirstEligible(); broadcastRoundState(); }
          return;
        }


    // Solo host
    if (msg.type === 'host:set-timer' && clients.get(clientId).isHost) {
      const sec = Math.max(5, Math.floor(Number(msg.seconds) || 30));
      baseCountdownSeconds = sec;
      pushLog({ type: 'timer-set', time: now(), seconds: sec });
      // l'UI (host) mostra il "predefinito" impostato; i reset effettivi possono essere più bassi
      broadcast({ type: 'timer-updated', seconds: sec });
      return;
    }

    if (msg.type === 'host:set-bidder-details' && clients.get(clientId).isHost) {
      showBidderDetails = !!msg.enabled;
      broadcast({ type: 'show-bidder-details', enabled: showBidderDetails });
      for (const [, c] of clients) {
        if (c.ws.readyState === WebSocket.OPEN) {
          sendStateToClient(c, c.ws);
        }
      }
      return;
    }

    if (msg.type === 'host:set-roster-visibility' && clients.get(clientId).isHost) {
      showRosterToBidders = !!msg.enabled;
      broadcast({ type: 'show-roster-bidders', enabled: showRosterToBidders });
      broadcastRoster();
      return;
    }

    if (msg.type === 'host:start-item' && clients.get(clientId).isHost) {
      const name = (msg.name || '').trim() || 'Senza titolo';
      const startPrice = Math.max(0, Math.floor(Number(msg.startPrice) || 0));
      const role = msg.role || '';
      const team = msg.team || '';
      const image = (msg.image || '').trim();
      const id = msg.id || `pl_${Date.now()}`;

      currentItem = { id, name, startPrice, role, fascia: role, team, image };
      currentPrice = startPrice;
      currentBidder = null;
      bidHistory = [];

      pushLog({ type: 'auction-start', time: now(), item: currentItem, timer: baseCountdownSeconds });

	  const secs = dynamicSecondsFor(currentPrice);
	  broadcastAuctionStartedTailoredWithSeconds(secs);
	  startTimer(secs);
      return;
    }

    // Start da CSV
    if (msg.type === 'host:start-player' && clients.get(clientId).isHost) {
      const p = msg.player || {};
      const name = String(p.Nome || p.name || 'Senza titolo');
      const startPrice = Math.max(0, Math.floor(Number(p.ValoreBase || p.startPrice || 0)));
      const role = p.Ruolo || '';
      const team = p.Squadra || '';

      const image = (p.Immagine || p.Image || p.Foto || p.Photo || p.img || p.image || '').toString().trim();
      const id = p.id || `pl_${Date.now()}`;

      currentItem = { id, name, startPrice, role, fascia: role, team, image };
      currentPrice = startPrice;
      currentBidder = null;
      bidHistory = [];

	  pushLog({ type: 'auction-start', time: now(), item: currentItem, timer: baseCountdownSeconds, source: 'csv'  });

	  const secs = dynamicSecondsFor(currentPrice);
	  broadcastAuctionStartedTailoredWithSeconds(secs);

      startTimer(secs);
      return;
    }

    if (msg.type === 'host:end-item' && clients.get(clientId).isHost) {
      endAuction('manual');
      return;
    }

    if (msg.type === 'host:expel' && clients.get(clientId).isHost) {
      const targetId = msg.clientId;
      const target = clients.get(targetId);
      if (target) {
        try { target.ws.send(JSON.stringify({ type: 'expelled' })); } catch {}
        try { target.ws.close(); } catch {}
        if (target.participantId) {
          if (participantClients.get(target.participantId) === targetId) {
            participantClients.delete(target.participantId);
          }
          upsertParticipant({
            id: target.participantId,
            name: target.name,
            role: target.role,
            isHost: !!target.isHost,
            credits: Number(target.credits || 0),
            initialCredits: Number(target.initialCredits || 0),
            slotsByRole: cloneSlots(target.slotsByRole || {}),
            initialSlotsByRole: cloneSlots(target.initialSlotsByRole || {})
          });
        }
        clients.delete(targetId);
        pushLog({ type: 'kick', time: now(), target: targetId });
        broadcastUsers();
        if (roundMode) {
          if (!eligibleBidder(getClientByParticipantId(currentNominatorId))) pickFirstEligible();
          broadcastRoundState();
        }
      }
      return;
    }
	
	// === Host: elimina tutti gli anonimi (senza participantId) ===
	if (msg.type === 'host:kick-anon' && clients.get(clientId).isHost) {
	  const kicked = [];
	  for (const [id, c] of [...clients]) {
		if (!c.isHost && !c.participantId) {
		  try { c.ws.send(JSON.stringify({ type:'expelled' })); } catch {}
		  try { c.ws.close(); } catch {}
		  clients.delete(id);
		  kicked.push(id);
		}
	  }
          if (kicked.length) pushLog({ type:'kick-anon', time: now(), ids: kicked });
          if (roundMode) {
                if (!eligibleBidder(getClientByParticipantId(currentNominatorId))) pickFirstEligible();
                broadcastRoundState();
          }
          broadcastUsers();
          return;
        }


	// Il gestore chiede la lista utenti corrente (sync immediato)
        if (msg.type === 'host:get-users') {
          const me = clients.get(clientId);
          if (!me || !me.isHost) {
                ws.send(JSON.stringify({ type: 'error', message: 'Non autorizzato' }));
                return;
          }

	  const users = [];
	  for (const [id, c] of clients) {
		ensureBudgetFields(c);
		users.push({
		  id, // sessione
		  participantId: c.participantId || null, // NEW
		  name: c.name,
		  isHost: !!c.isHost,
		  role: c.role || 'bidder',
		  credits: c.credits ?? 0,
		  initialCredits: c.initialCredits ?? 0,
		  slotsByRole: cloneSlots(c.slotsByRole || {}),
		  initialSlotsByRole: cloneSlots(c.initialSlotsByRole || {})
		});
	  }
          try { ws.send(JSON.stringify({ type: 'user-list', users })); } catch {}
          return;
        }

        if (msg.type === 'host:get-rosters') {
          const me = clients.get(clientId);
          if (!me || !me.isHost) {
                ws.send(JSON.stringify({ type: 'error', message: 'Non autorizzato' }));
                return;
          }
          broadcastRoster();
          return;
        }

        if (msg.type === 'host:remove-player' && clients.get(clientId).isHost) {
          const pid = String(msg.participantId);
          const removed = removePlayer(pid, String(msg.playerId));
          if (removed) {
            const roleKey = FASCIA_TO_ROLE[removed.fascia];
            const c = getClientByParticipantId(pid);
            if (c) {
              ensureBudgetFields(c);
              c.credits = (c.credits || 0) + (removed.price || 0);
              if (roleKey) {
                c.slotsByRole[roleKey] = (c.slotsByRole[roleKey] || 0) + 1;
              }
              pushLog({ type:'bidder-update', time: now(), target: c.name, credits: c.credits, slotsByRole: c.slotsByRole });
            }
            broadcastUsers();
          }
          broadcastRoster();
          return;
        }

        if (msg.type === 'host:reassign-player' && clients.get(clientId).isHost) {
          const from = String(msg.fromPid ?? msg.fromId ?? '');
          const to = String(msg.toPid ?? msg.toId ?? '');
          const moved = movePlayer(from, to, String(msg.playerId));
          if (moved) {
            const roleKey = FASCIA_TO_ROLE[moved.fascia];
            const oldClient = getClientByParticipantId(from);
            if (oldClient) {
              ensureBudgetFields(oldClient);
              oldClient.credits = (oldClient.credits || 0) + (moved.price || 0);
              if (roleKey) {
                oldClient.slotsByRole[roleKey] = (oldClient.slotsByRole[roleKey] || 0) + 1;
              }
              pushLog({ type:'bidder-update', time: now(), target: oldClient.name, credits: oldClient.credits, slotsByRole: oldClient.slotsByRole });
            }
            const newClient = getClientByParticipantId(to);
            if (newClient) {
              ensureBudgetFields(newClient);
              newClient.credits = Math.max(0, (newClient.credits || 0) - (moved.price || 0));
              if (roleKey) {
                newClient.slotsByRole[roleKey] = Math.max(0, (newClient.slotsByRole[roleKey] || 0) - 1);
              }
              pushLog({ type:'bidder-update', time: now(), target: newClient.name, credits: newClient.credits, slotsByRole: newClient.slotsByRole });
            }
            broadcastUsers();
          }
          broadcastRoster();
          return;
        }

        // === Host: avvia/stop round robin (una nomina per turno) ===
        if (msg.type === 'host:start-round' && clients.get(clientId).isHost) {
          const strategy = (msg.strategy === 'name') ? 'name' : 'random';
          nominationOrder = buildNominationOrder(strategy);
          roundMode = true;
          nominationIndex = 0;
          pickFirstEligible(); // sceglie il primo con slot
          pushLog({ type:'round-start', time: now(), strategy, order: nominationOrder.map(id=>participantName(id)) });
          broadcastRoundState();
          return;
        }

	if (msg.type === 'host:stop-round' && clients.get(clientId).isHost) {
	  roundMode = false;
	  nominationOrder = [];
	  nominationIndex = 0;
	  currentNominatorId = null;
	  pushLog({ type:'round-stop', time: now() });
	  broadcastRoundState();
	  return;
	}

	// === Bidder: nomina un giocatore (solo se è il suo turno) ===
        if (msg.type === 'bidder:nominate') {
          if (!roundMode) { ws.send(JSON.stringify({ type:'error', message:'Round Robin non attivo.' })); return; }
          const caller = clients.get(clientId);
          const callerPid = caller?.participantId;
          if (callerPid !== currentNominatorId) { ws.send(JSON.stringify({ type:'error', message:'Non è il tuo turno per nominare.' })); return; }
          if (currentItem) { ws.send(JSON.stringify({ type:'error', message:'C’è già un’asta in corso.' })); return; }

          if (!eligibleBidder(caller)) {
                // niente slot → salta al prossimo
                advanceNominatorNext();
                broadcastRoundState();
		ws.send(JSON.stringify({ type:'error', message:'Nessuno slot rimanente.' }));
		return;
	  }

          const p = msg.player || {};
          const name = String(p.Nome || p.name || '').trim();
          if (!name) { ws.send(JSON.stringify({ type:'error', message:'Giocatore non valido.' })); return; }

          const startPrice = Math.max(0, Math.floor(Number(p.ValoreBase || p.startPrice || 0)));
          const role  = p.Ruolo   || '';
          const team  = p.Squadra || '';
          const image = (p.Immagine || p.Image || p.Foto || p.Photo || p.img || p.image || '').toString().trim();
          const id = p.id || `pl_${Date.now()}`;

          currentItem   = { id, name, startPrice, role, fascia: role, team, image };
          currentPrice  = startPrice;
          currentBidder = null;
          bidHistory    = [];

	  // Nel log teniamo il "predefinito" impostato dal gestore
	  pushLog({ type:'auction-start', time: now(), item: currentItem, timer: baseCountdownSeconds, source:'round', by: caller.name });

	  // Passa SUBITO il turno al prossimo eleggibile (una nomina per giro)
	  advanceNominatorNext();
	  broadcastRoundState();

	  // ⬇️ Timer dinamico all'avvio in base al prezzo corrente
	  const secs = dynamicSecondsFor(currentPrice);
	  broadcastAuctionStartedTailoredWithSeconds(secs);
	  startTimer(secs);
	  return;
	}



    // Offerte
    if (msg.type === 'bid') {
      if (!currentItem) { ws.send(JSON.stringify({ type: 'error', message: 'Nessun oggetto in asta.' })); return; }
      const c = clients.get(clientId);
      if (c.role === 'monitor') { ws.send(JSON.stringify({ type: 'error', message: 'Il monitor non può fare offerte.' })); return; }

      const next = Math.floor(Number(msg.amount));
      const min = currentPrice + minIncrement;
      if (!Number.isFinite(next) || next < min) {
        ws.send(JSON.stringify({ type: 'error', message: `Offerta minima ${min}` }));
        return;
      }
	  
	  // ruolo del giocatore in corso
	  const rkey = roleKeyFromText(currentItem?.role || '');
	  if (!rkey) { ws.send(JSON.stringify({ type:'error', message:'Ruolo non valido per il giocatore.' })); return; }

      // deve avere slot disponibili per quel ruolo
	  ensureBudgetFields(c);
	  if ((c.slotsByRole[rkey] || 0) <= 0) {
	    ws.send(JSON.stringify({ type:'error', message:`Nessuno slot disponibile per il ruolo ${currentItem.role || rkey.toUpperCase()}` }));
	    return;
	  } 

	  // max offerta in base a TUTTI gli slot rimanenti
	  const slotsRimTot = totalSlotsRemaining(c.slotsByRole);
	  const maxAllowed = Math.max(0, Number(c.credits || 0) - Math.max(0, slotsRimTot - 1));
	  if (next > maxAllowed) {
	    ws.send(JSON.stringify({ type:'error', message:`Budget insufficiente. Max puntata: ${maxAllowed}` }));
	    return;
	  }

      currentPrice = next;
      currentBidder = c.name;
	  currentBidderId = clientId;
      const entry = { t: now(), name: currentBidder, amount: currentPrice };
      bidHistory.push(entry);
      pushLog({ type: 'bid', time: entry.t, item: currentItem, name: currentBidder, amount: currentPrice });

        const secs = dynamicSecondsFor(currentPrice);
        broadcast({
          type: 'new-bid',
          amount: currentPrice,
          name: currentBidder,
          last3: lastNBids(3),
          seconds: secs,
        });
        resetTimer(secs);
        return;
      }
  });

  ws.on('close', () => {
          const c = clients.get(clientId);
          if (c && c.participantId) {
                // salva lo stato “vivo” del participant
                upsertParticipant({
                  id: c.participantId,
                  name: c.name,
                  role: c.role,
                  isHost: !!c.isHost,
                  credits: Number(c.credits || 0),
                  initialCredits: Number(c.initialCredits || 0),
                  slotsByRole: cloneSlots(c.slotsByRole || {}),
                  initialSlotsByRole: cloneSlots(c.initialSlotsByRole || {})
                });
                if (participantClients.get(c.participantId) === clientId) {
                  participantClients.delete(c.participantId);
                }
          }

          clients.delete(clientId);
          broadcastUsers();

          if (roundMode) {
                if (!eligibleBidder(getClientByParticipantId(currentNominatorId))) pickFirstEligible();
                broadcastRoundState();
          }
        });
});

const { v4: uuid } = require('uuid');
const { sign, verify } = require('./lib/token');
const { getParticipant, upsertParticipant, deleteParticipant, listParticipants, addPlayer, removePlayer, movePlayer } = require('./lib/registry');

function listParticipantsWithOnline() {
  const regs = listParticipants();
  const out = [];
  const used = new Set();

  for (const [id, c] of clients) {
    ensureBudgetFields(c);
    out.push({
      id,
      participantId: c.participantId || null,
      name: c.name,
      isHost: !!c.isHost,
      role: c.role || 'bidder',
      credits: c.credits ?? 0,
      initialCredits: c.initialCredits ?? 0,
      slotsByRole: cloneSlots(c.slotsByRole || {}),
      initialSlotsByRole: cloneSlots(c.initialSlotsByRole || {}),
      online: true
    });
    if (c.participantId) used.add(c.participantId);
  }

  for (const p of regs) {
    if (used.has(p.id)) continue;
    out.push({
      id: p.id,
      participantId: p.id,
      name: p.name,
      isHost: !!p.isHost,
      role: p.role || 'bidder',
      credits: Number.isFinite(p.credits) ? p.credits : 0,
      initialCredits: Number.isFinite(p.initialCredits)
        ? p.initialCredits
        : (Number.isFinite(p.credits) ? p.credits : 0),
      slotsByRole: cloneSlots(p.slotsByRole || {}),
      initialSlotsByRole: cloneSlots(p.initialSlotsByRole || p.slotsByRole || {}),
      online: false
    });
  }

  return out;
}

function participantName(pid) {
  const c = getClientByParticipantId(pid);
  if (c) return c.name || 'Anonimo';
  const p = getParticipant(pid);
  return p?.name || 'Anonimo';
}

app.use(express.json());

// (facoltativo) middleware minimo per proteggere endpoint inviti
function ensureHostWeak(req, res, next){
  // più semplice: accetta tutto; per hardened, usa una sessione/cookie
  next();
}

const INV_DB = path.join(__dirname, 'data', 'invites.json');

function loadInvites() {
  try { return JSON.parse(fs.readFileSync(INV_DB, 'utf8')); } catch { return []; }
}
function saveInvites(list) {
  fs.mkdirSync(path.dirname(INV_DB), { recursive: true });
  fs.writeFileSync(INV_DB, JSON.stringify(list, null, 2));
}
function randomToken(n = 32) {
  return require('crypto').randomBytes(n).toString('base64url');
}

app.get('/host/participants/list', (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false, error:'forbidden' });
  res.json({ success: true, participants: listParticipantsWithOnline() });
});

// POST crea/ottieni (idempotente)
app.post('/host/invite/create', express.json(), (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false, error:'forbidden' });

  const { participantId = null, clientId = null, name = '', role = 'bidder' } = req.body || {};
  const safeName = String(name || '').trim();
  const safeRole = (role === 'monitor') ? 'monitor' : (role === 'host') ? 'host' : 'bidder';

  const list = loadInvites();

  // Helper: crea o aggiorna invito idempotente per un dato participantId
  function upsertInviteForParticipant(pid, pname, prole) {
    // se esiste un invito non revocato per questo participant → riusa
    let inv = list.find(x => x.participantId === pid && !x.revoked);
    if (!inv) {
      inv = {
        id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        participantId: pid,
        name: pname || '',
        role: prole || 'bidder',
        token: randomToken(24),
        createdAt: Date.now(),
        revoked: false
      };
      list.push(inv);
      saveInvites(list);
    }
    return inv;
  }

  // Caso A: mi è stato passato un participantId valido → bind diretto
  if (participantId) {
    const p = getParticipant(participantId);
    // Compat: se participantId in realtà è un clientId (utente connesso senza participant)
    if (!p && clients.has(participantId)) {
      const c = clients.get(participantId);
      ensureBudgetFields(c);
      const newP = upsertParticipant({
        id: 'p_' + Math.random().toString(36).slice(2),
        name: c.name || safeName || 'Ospite',
        role: c.role || 'bidder',
        isHost: !!c.isHost,
        credits: Number(c.credits || 0),
        initialCredits: Number(c.initialCredits ?? c.credits ?? 0),
        slotsByRole: cloneSlots(c.slotsByRole || defaultSlotsByRole),
        initialSlotsByRole: cloneSlots(c.initialSlotsByRole || c.slotsByRole || defaultSlotsByRole),
      });
      c.participantId = newP.id; // ↔️ linka la sessione corrente
      participantClients.set(newP.id, participantId);
      const inv = upsertInviteForParticipant(newP.id, newP.name, newP.role);
      return res.json({ success:true, invite: inv });
    }

    if (!p) return res.json({ success:false, error:'participant-not-found' });
    const inv = upsertInviteForParticipant(p.id, p.name, p.role);
    return res.json({ success:true, invite: inv });
  }

  // Caso B: niente participantId ma ho clientId (utente connesso senza participant)
  if (clientId && clients.has(clientId)) {
    const c = clients.get(clientId);
    ensureBudgetFields(c);

    // Se la sessione ha già participantId, usalo; altrimenti crealo ora
    let pid = c.participantId;
    if (!pid) {
      const newP = upsertParticipant({
        id: 'p_' + Math.random().toString(36).slice(2),
        name: c.name || safeName || 'Ospite',
        role: c.role || 'bidder',
        isHost: !!c.isHost,
        credits: Number(c.credits || 0),
        initialCredits: Number(c.initialCredits ?? c.credits ?? 0),
        slotsByRole: cloneSlots(c.slotsByRole || defaultSlotsByRole),
        initialSlotsByRole: cloneSlots(c.initialSlotsByRole || c.slotsByRole || defaultSlotsByRole),
      });
      pid = newP.id;
      c.participantId = pid;
    }

    participantClients.set(pid, clientId);
    const p = getParticipant(pid);
    const inv = upsertInviteForParticipant(p.id, p.name, p.role);
    return res.json({ success:true, invite: inv });
  }

  // Caso C: invito standalone “da nome” (utente non connesso)
  if (!safeName) return res.json({ success:false, error:'name-required' });

  // dedup inviti standalone non revocati per stesso name+role e participantId null
  const byStandalone = (x) => !x.revoked &&
    (x.participantId == null) &&
    (String(x.name || '').trim().toLowerCase() === safeName.toLowerCase()) &&
    (String(x.role || 'bidder') === safeRole);

  let inv = list.find(byStandalone);
  if (!inv) {
    inv = {
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      participantId: null,
      name: safeName,
      role: safeRole,
      token: randomToken(24),
      createdAt: Date.now(),
      revoked: false
    };
    list.push(inv);
    saveInvites(list);
  }

  return res.json({ success:true, invite: inv });
});



app.get('/host/invite/list', (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false, error:'forbidden' });
  const list = loadInvites().map(x => ({ ...x, role: x.role || 'bidder' }));
  res.json({ success:true, invites: list });
});


// POST rotate (genera nuovo token, opzionale)
app.post('/host/invite/rotate', express.json(), (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false, error:'forbidden' });
  const { id } = req.body || {};
  if (!id) return res.json({ success:false, error:'bad-input' });

  const list = loadInvites();
  const inv = list.find(x => x.id === id);
  if (!inv || inv.revoked) return res.json({ success:false, error:'not-found-or-revoked' });

  inv.token = randomToken(24);
  inv.updatedAt = Date.now();
  saveInvites(list);

  res.json({ success:true, invite: inv });
});


// POST revoke (non cancella, marca revoked)
app.post('/host/invite/revoke', express.json(), (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false, error:'forbidden' });
  const { id } = req.body || {};
  if (!id) return res.json({ success:false, error:'bad-input' });

  const list = loadInvites();
  const inv = list.find(x => x.id === id);
  if (!inv) return res.json({ success:false, error:'not-found' });

  inv.revoked = true;
  inv.revokedAt = Date.now();
  saveInvites(list);

  res.json({ success:true });
});


function isHostReq(req) {
  // Usa la tua auth host (es. cookie di sessione del PIN host)
  // oppure consenti solo da localhost/loopback nel tuo setup attuale.
  return true;
}


app.get('/join/by-token/:token', (req, res) => {
  const { token } = req.params;
  const inv = loadInvites().find(x => x.token === token && !x.revoked);
  if (!inv) return res.status(400).send('Invito non valido o revocato');

  // pagina inline per fare auto-join via websocket
  res.type('html').send(`<!doctype html>
<html lang="it"><meta charset="utf-8"><title>Entra nell'asta</title>
<body style="font-family:system-ui; padding:24px">
<h1>Connessione in corso…</h1>
<p>Stiamo collegandoti come <b>${inv.name ? String(inv.name).replace(/</g,'&lt;') : 'partecipante'}</b>.</p>
<script>
  (function(){
    var token = ${JSON.stringify(token)};
    var proto = (location.protocol === 'https:') ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host);
    ws.onopen = function(){
      ws.send(JSON.stringify({ type:'join-by-invite', token: token }));
    };
    ws.onmessage = function(ev){
      try{
        var d = JSON.parse(ev.data);
        if (d.type === 'joined' && d.success) {
          // reindirizza all'app "normale"
          location.href = '/';
        } else if (d.type === 'error') {
          document.body.innerHTML = '<h1>Errore</h1><p>'+ (d.message||'Join fallita') +'</p>';
        }
      }catch(e){}
    };
    ws.onerror = function(){ document.body.innerHTML = '<h1>Errore</h1><p>Connessione non riuscita.</p>'; };
  })();
</script>
</body></html>`);
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
