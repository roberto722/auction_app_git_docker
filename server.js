// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

require('dotenv').config();

const HOST_PIN = process.env.HOST_PIN || '1234';

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// === STATIC ===
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: '2mb' }));

// === LOGGING ===
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
let logEntries = [];

function now() { return Date.now(); }
function logFileForToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return path.join(LOG_DIR, `${yyyy}-${mm}-${dd}.log`);
}

function pushLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > 5000) logEntries.shift();
  appendLogToFile(entry);
  broadcast({ type: 'log-update', entries: logEntries });
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

// --- Admin/status ---
app.get('/status', (req,res)=>{
  if (!isHostReq(req)) return res.status(403).json({ ok:false });
  const nowTs = Date.now();
  res.json({
    ok:true,
    clients: Array.from(presence, ([id,p])=>({ id, name:p.name||'Anonimo', participantId:p.participantId||null, isHost:!!p.isHost, online: nowTs - (p.lastSeen||0) < STALE_CLIENT_MS, lastSeen: p.lastSeen||0 })),
    auction: { paused: auctionPaused, reason: auctionPauseReason, currentItem: currentItem ? currentItem.name || currentItem.id || true : null, currentPrice }
  });
});
app.get('/healthz', (_req,res)=>res.json({ ok:true, ts:Date.now(), wsClients: wss.clients.size }));

// --- Scarica il log di oggi ---
app.get('/logs/today', (req, res) => {
  try {
    const file = logFileForToday();
    if (!fs.existsSync(file)) return res.status(404).type('text').send('Nessun log per oggi.');
    res.download(file, path.basename(file));
  } catch (e) {
    res.status(500).type('text').send(e.message || 'Errore');
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

// === UPLOAD CSV ===
const upload = multer({ dest: path.join(__dirname, 'uploads') });
app.post('/upload-players', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, error:'Nessun file' });
  const rows = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (raw) => {
      const row = normalizeKeys(raw);
      rows.push(row);
    })
    .on('end', () => {
      try {
        const list = rows.map((r) => ({
          name: (r[Object.keys(r)[1]] || '').trim(),        // colonna 2
          role: (r[Object.keys(r)[3]] || '').trim(),        // colonna 4 (P/D/C/A)
          team: (r[Object.keys(r)[9]] || '').trim(),        // colonna 10
          image: (r[Object.keys(r)[15]] || '').trim() || null // colonna 16
        })).filter(x => x.name);
        players = list;
        broadcast({ type:'players-list', players });
        pushLog({ type:'players-uploaded', time: now(), count: players.length });
		
		fs.unlink(req.file.path, () => {});
		
        res.json({ success:true, count: players.length, players });
      } catch (e) {
		fs.unlink(req.file.path, () => {});
        res.status(500).json({ success:false, error: e.message });
      }
    })
	.on('error', (err) => {
      try { fs.unlink(req.file.path, () => {}); } catch {}
      res.status(400).json({ success:false, error:String(err) });
    });
});

// === INVITES (semplici) ===
const INVITES_FILE = path.join(__dirname, 'data', 'invites.json');
fs.mkdirSync(path.dirname(INVITES_FILE), { recursive: true });
function loadInvites(){ try{ return JSON.parse(fs.readFileSync(INVITES_FILE,'utf-8')); }catch{ return []; } }
function saveInvites(arr){ fs.writeFileSync(INVITES_FILE, JSON.stringify(arr, null, 2)); }

function isHostReq(req) {
  const ip = req.ip || '';
  const host = (req.hostname || '').toLowerCase();
  const loop = ['127.0.0.1','::1','localhost'];
  return loop.includes(host) || loop.includes(ip);
}

app.get('/join/by-token/:token', (req, res) => {
  const { token } = req.params;
  const inv = loadInvites().find(x => x.token === String(token) && !x.revoked);
  if (!inv) return res.status(404).type('text').send('Token non valido o revocato.');
  const html = `<!doctype html>
  <meta charset="utf-8">
  <title>Join</title>
  <script>
    localStorage.setItem('inviteToken', ${JSON.stringify(inv.token)});
    location.href = '/';
  </script>`;
  res.type('html').send(html);
});

app.post('/host/invite/create', (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false });

  const { name, role, participantId, clientId } = req.body || {};
  const list = loadInvites();

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const inv = {
    id: 'inv_' + Math.random().toString(36).slice(2, 10),
    token,
    name: (name || '').trim() || null,
    role: role || 'bidder',
    participantId: participantId || null,
    clientId: clientId || null,
    createdAt: now(),
    revoked: false
  };

  list.push(inv);
  saveInvites(list);
  // mantieni il vecchio 'token' per retrocompatibilità, ma aggiungi anche 'invite'
  res.json({ success: true, token, invite: inv });
});


app.get('/host/invite/list', (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false });
  res.json({ success:true, invites: loadInvites() });
});

app.post('/host/invite/rotate', (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false });
  const { id, token } = req.body || {};
  const list = loadInvites();
  const inv = list.find(x => x.token === token || x.id === id);
  if (!inv) return res.json({ success:false, error:'not-found' });

  inv.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  saveInvites(list);
  res.json({ success:true, token: inv.token, invite: inv });
});


app.post('/host/invite/revoke', (req, res) => {
  if (!isHostReq(req)) return res.status(403).json({ success:false });
  const { token } = req.body || {};
  const list = loadInvites();
  const inv = list.find(x => x.token === token);
  if (!inv) return res.json({ success:false, error:'not-found' });
  inv.revoked = true; saveInvites(list);
  res.json({ success:true });
});

// === REGISTRY (persistenza partecipanti) ===
const { v4: uuid } = require('uuid');
const { sign, verify } = require('./lib/token');
const { getParticipant, upsertParticipant, deleteParticipant, listParticipants } = require('./lib/registry');

const INVITE_SECRET = process.env.INVITE_SECRET || 'change-me';

// Stato utente/asta runtime
const clients = new Map(); // id -> { ws, name, role: 'host'|'bidder'|'monitor', isHost, credits, slotsByRole, ... }

// === Presence / Heartbeat / Rate-limit / Pause ===
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_CLIENT_MS = 30_000;
const RATE_WINDOW_MS = 3_000;
const MAX_OFFERS_PER_WINDOW = 5;

const presence = new Map(); // clientId -> { lastSeen, name, participantId, isHost }
const offerHistory = new Map(); // participantId -> [timestamps]

function markPresence(clientId, patch = {}) {
  const cur = presence.get(clientId) || {};
  const next = { lastSeen: Date.now(), ...cur, ...patch };
  presence.set(clientId, next);
  broadcastPresence();
}

function broadcastPresence() {
  const nowTs = Date.now();
  const list = Array.from(presence, ([id, p]) => ({
    id,
    name: p.name || 'Anonimo',
    isHost: !!p.isHost,
    participantId: p.participantId || null,
    online: nowTs - (p.lastSeen || 0) < STALE_CLIENT_MS
  }));
  try { broadcast({ type: 'presence:update', list }); } catch {}
}

function onlineParticipants() {
  const nowTs = Date.now();
  return Array.from(presence.values())
    .filter(p => p.participantId && (nowTs - (p.lastSeen || 0) < STALE_CLIENT_MS))
    .map(p => p.participantId);
}

function allowOffer(participantId, currentAmount, amount) {
  const nowTs = Date.now();
  const arr = (offerHistory.get(participantId) || []).filter(t => nowTs - t < RATE_WINDOW_MS);
  if (arr.length >= MAX_OFFERS_PER_WINDOW) return { ok:false, reason:'rate_limited' };
  if (amount === currentAmount && arr.length && nowTs - arr[arr.length-1] < 1000)
    return { ok:false, reason:'duplicate_amount' };
  arr.push(nowTs);
  offerHistory.set(participantId, arr);
  return { ok:true };
}

// Pausa automatica
let auctionPaused = false;
let auctionPauseReason = null;
function setPaused(flag, reason=null) {
  if (auctionPaused === flag && auctionPauseReason === reason) return;
  auctionPaused = flag; auctionPauseReason = reason;
  broadcast({ type:'auction:pause', paused: flag, reason });
}
function reevaluatePause() {
  if (!currentItem) { setPaused(false, null); return; }
  const online = onlineParticipants();
  if (currentBidderId && !online.includes(currentBidderId)) {
    setPaused(true, 'highest_bidder_offline'); return;
  }
  if (currentNominatorId && !online.includes(currentNominatorId)) {
    setPaused(true, 'nominator_offline'); return;
  }
  setPaused(false, null);
}

// Sweep offline clients from presence map and reevaluate pause
setInterval(() => {
  const nowTs = Date.now();
  for (const [id, p] of presence) {
    if (nowTs - (p.lastSeen || 0) >= STALE_CLIENT_MS) {
      // keep presence entry but mark as offline via broadcastPresence()
    }
  }
  broadcastPresence();
  reevaluatePause();
}, 5000);

let players = [];

// === Round robin & asta state ===
let roundMode = false; // false|'random'|'name'
let nominationOrder = [];
let nominationIndex = -1;
let currentNominatorId = null; // id a cui “tocca”

function eligibleBidder(c){
  if (!c) return false;
  ensureBudgetFields(c);
  return !c.isHost && c.role !== 'monitor' && totalSlotsRemaining(c.slotsByRole) > 0;
}

function buildNominationOrder(strategy='random'){
  const arr = [];
  for (const [id, c] of clients) if (!c.isHost && c.role !== 'monitor') {
    arr.push({ id, name: c.name || 'Anonimo' });
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
    const id = nominationOrder[k];
    if (eligibleBidder(clients.get(id))) { nominationIndex = k; currentNominatorId = id; return id; }
  }
  currentNominatorId = null; return null;
}

function advanceNominator(){
  if (!roundMode || nominationOrder.length===0) { currentNominatorId = null; return { prev:null, next:null, changed:false, reason:'wrong-state' }; }
  const prev = currentNominatorId;
  const N = nominationOrder.length;
  if (N === 0) {
    currentNominatorId = null;
    return { prev, next: null, changed: false, reason: 'empty-order' };
  }
  let nextId = prev;
  for (let step = 1; step <= N; step++) {
    nominationIndex = (nominationIndex + 1) % N;
    const candidate = nominationOrder[nominationIndex];
    if (eligibleBidder(clients.get(candidate))) {
      nextId = candidate;
      break;
    }
  }
  if (nextId === prev) return { prev, next: prev, changed: false, reason:'no-eligible' };
  currentNominatorId = nextId;
  return { prev, next: nextId, changed:true };
}

function broadcastRoundState(){
  const names = {};
  for (const [id,c] of clients) names[id] = c.name || 'Anonimo';
  broadcast({
    type: 'round-state',
    roundMode,
    order: nominationOrder,
    current: currentNominatorId,
    currentNominatorId,
    names
  });
}

// === Asta ===
let baseCountdownSeconds = 20;
let currentItem = null;
let currentPrice = 0;
let currentBidder = null;   // nome (legacy)
let currentBidderId = null; // id client
let bidHistory = [];
let timerHandle = null;

function lastNBids(n=3){
  return bidHistory.slice(-n).map(x=>({ name:x.name, amount:x.amount }));
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
      name: c.name || 'Anonimo',
      role: c.role || 'bidder',
      isHost: !!c.isHost,
      credits: Number(c.credits || 0),
      initialCredits: Number(c.initialCredits || 0),
      slotsByRole: { ...(c.slotsByRole||{}) },
      initialSlotsByRole: { ...(c.initialSlotsByRole||{}) }
    });
  }
  broadcast({ type: 'user-list', users });
}

function startTimer(secs) {
  if (timerHandle) clearTimeout(timerHandle);
  const s = Math.max(1, Math.floor(secs || baseCountdownSeconds));
  timerHandle = setTimeout(() => endAuction('timeout'), s * 1000);
}

function resetTimer() {
  const secs = dynamicSecondsFor(currentPrice || Number(currentItem?.startPrice || 0) || 0);
  startTimer(secs);
  broadcast({ type: 'reset-timer', seconds: secs });
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
      if ((c.name||'').trim() === (currentBidder||'').trim()) { winnerId = id; break; }
    }
  }

  // 2) Se abbiamo un vincitore rispetta budget/slot
  let winnerName = null;
  const amount = currentPrice;
  if (winnerId && clients.has(winnerId)) {
    const w = clients.get(winnerId);
    winnerName = w.name || '—';

    // decurtazione budget e slot solo se c'è un item con ruolo
    const rkey = roleKeyFromText(currentItem?.role || '');
    if (rkey) {
      ensureBudgetFields(w);
      w.credits = Math.max(0, (w.credits || 0) - amount);
      w.slotsByRole[rkey] = Math.max(0, (w.slotsByRole[rkey] || 0) - 1);
    }
  }

  // 3) Notifica esito asta
  broadcast({
    type: 'auction-ended',
    item: currentItem,
    winner: winnerName,
    amount,
    last3: lastNBids(3)
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
    const namesMap = Object.fromEntries([...clients].map(([id, c]) => [id, c.name || 'Anonimo']));
    broadcast({ type: 'round-state', roundMode, order: nominationOrder || [], current: currentNominatorId || null, names: namesMap });
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
    players,

    // round
    round: { mode: roundMode, order: nominationOrder, current: currentNominatorId },

    // asta
    currentItem, currentPrice,
    currentBidder, last3: lastNBids(3),
    secondsEstimate
  };

  wsRef.send(JSON.stringify({
    ...payloadCommon,
    you: {
      id: [...clients].find(([k,v]) => v === client)?.[0] || null,

      participantId: client.participantId || null,

      name: client.name || 'Anonimo',
      role: client.role || 'bidder',
      isHost: !!client.isHost,

      credits: Number(client.credits || 0),
      initialCredits: Number(client.initialCredits || 0),
      slotsByRole: { ...(client.slotsByRole||{}) },
      initialSlotsByRole: { ...(client.initialSlotsByRole||{}) }
    }
  }));
}

function roleKeyFromText(t=''){
  const r = String(t).toLowerCase();
  if (r.includes('port') || r.startsWith('por')) return 'por';
  if (r.includes('dif')  || r.startsWith('dif')) return 'dif';
  if (r.includes('cent') || r.startsWith('cen')) return 'cen';
  if (r.includes('att')  || r.startsWith('att')) return 'att';
  return null;
}
function cloneSlots(o){ return { por:o.por||0, dif:o.dif||0, cen:o.cen||0, att:o.att||0 }; }
function ensureBudgetFields(c) {
  if (c.credits == null) c.credits = defaultCredits;
  if (!c.slotsByRole)        c.slotsByRole        = cloneSlots(defaultSlotsByRole);
  if (c.initialCredits == null) c.initialCredits  = defaultCredits;
  if (!c.initialSlotsByRole)    c.initialSlotsByRole = cloneSlots(defaultSlotsByRole);
}
function totalSlotsRemaining(slotsByRole){
  const s = slotsByRole || {};
  return (s.por||0)+(s.dif||0)+(s.cen||0)+(s.att||0);
}

let defaultCredits = 0;
let defaultSlotsByRole = { por: 3, dif: 8, cen: 8, att: 6 };

function dynamicSecondsFor(price){
  const b = baseCountdownSeconds;
  let factor = 1.0;
  if (price >= 200) factor = 0.60; // -40%
  else if (price >= 150) factor = 0.70; // -30%
  else if (price >= 100) factor = 0.80; // -20%
  const secs = Math.max(3, Math.round(b * factor));
  return secs;
}

// Ping server → chiudi zombie, ogni 30s per tutti i client
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

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

  // Presence initial mark
  const c0 = clients.get(clientId);
  markPresence(clientId, { name: c0?.name, participantId: c0?.participantId, isHost: !!c0?.isHost });

  ws.on('message', (raw) => {
	  let msg; try { msg = JSON.parse(raw); } catch { return; }
	  if (msg && msg.type === 'ping') {
		ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
		return;
	  }
	  
  if (msg.type === 'hb') {
    markPresence(clientId);
    try { ws.send(JSON.stringify({ type:'hb:ack', t: Date.now() })); } catch {}
    return;
  }
  if (msg.type === 'client:hello') {
    const { name, participantId, isHost } = msg;
    const c = clients.get(clientId);
    if (c) { c.name = name || c.name; c.participantId = participantId || c.participantId; c.isHost = !!isHost; }
    markPresence(clientId, { name: c?.name, participantId: c?.participantId, isHost: !!c?.isHost });
    return;
  }
  if (msg.type === 'resume' && msg.sessionToken) {
    // Bind token to client session (no persistent store here; extend as needed)
    const c = clients.get(clientId);
    if (c) c.sessionToken = String(msg.sessionToken);
    // Re-send full state
    try { sendStateToClient(c, ws); } catch {}
    markPresence(clientId, { name: c?.name, participantId: c?.participantId, isHost: !!c?.isHost });
    return;
  }
  if (msg.type === 'host:rollcall') {
    const online = onlineParticipants();
    const all = (listParticipants && typeof listParticipants==='function') ? listParticipants().map(p=>p.id) : online;
    const missing = all.filter(id => !online.includes(id));
    try { ws.send(JSON.stringify({ type:'rollcall:result', online, missing })); } catch {}
    return;
  }
		
	
  // === Join "semplice" senza token (name + role) ===
  if (msg.type === 'join' && !msg.token) {
    const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : 'Anonimo';
    const role = (msg.role === 'monitor') ? 'monitor' : 'bidder';
    const c = clients.get(clientId);
    if (c) {
      c.name = name;
      c.role = role;
      c.isHost = false;
      ensureBudgetFields(c);
    }
    try { ws.send(JSON.stringify({ type:'joined', success:true, name: name, role: role, clientId })); } catch {}
    try { ws.send(JSON.stringify({ type:'players-list', players })); } catch {}
    try { sendStateToClient(c, ws); } catch {}
    broadcastUsers();
    markPresence(clientId, { name, participantId: c?.participantId, isHost: !!c?.isHost });
    if (role === 'bidder') addToRoundIfEligible(clientId);
    return;
  }
if (msg.type === 'join' && msg.token) {
      try {
        const payload = verify(msg.token, INVITE_SECRET); // { pid, role, iat, exp }
        const p = getParticipant(payload.pid);
        if (!p) throw new Error('participant-not-found');

        const c = clients.get(clientId);
        c.participantId = p.id;
        c.name = p.name || 'Anonimo';
        c.role = p.role || 'bidder';
        c.isHost = !!p.isHost;
  const sessionToken = Math.random().toString(36).slice(2)+Date.now().toString(36);
  c.sessionToken = sessionToken;
  try { ws.send(JSON.stringify({ type:'resume:token', sessionToken, participantId: c.participantId, name: c.name })); } catch {}
  markPresence(clientId, { name: c.name, participantId: c.participantId, isHost: !!c.isHost });

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

        ws.send(JSON.stringify({ type:'joined', success:true, name:c.name, role:c.role, clientId }));
        ws.send(JSON.stringify({ type:'players-list', players }));
        sendStateToClient(c, ws);
        broadcastUsers(); markPresence(clientId, { name: c.name, participantId: c.participantId, isHost: !!c.isHost });
		addToRoundIfEligible(clientId);
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
		  role: 'bidder',
		  isHost: false,
		  credits: defaultCredits ?? 0,
		  initialCredits: defaultCredits ?? 0,
		  slotsByRole: cloneSlots(defaultSlotsByRole),
		  initialSlotsByRole: cloneSlots(defaultSlotsByRole),
		});
	  }
	  
	  // idrata la sessione
	  const c = clients.get(clientId);
	  c.participantId = p.id;
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

// ---- resume token for reconnection ----
	  const sessionToken = Math.random().toString(36).slice(2)+Date.now().toString(36);
	  const cc = clients.get(clientId); if (cc) cc.sessionToken = sessionToken;
	  try { ws.send(JSON.stringify({ type:'resume:token', sessionToken, participantId: cc?.participantId, name: cc?.name })); } catch {}

	  ws.send(JSON.stringify({
			type: 'joined',
			success: true,
			name: c.name,
			role: c.role,
			clientId
	  }));
	  ws.send(JSON.stringify({ type:'players-list', players }));
	  sendStateToClient(c, ws);
	  broadcastUsers(); markPresence(clientId, { name: c.name, participantId: c.participantId, isHost: !!c.isHost });
	  addToRoundIfEligible(clientId);
	  return;
	}

    // Join “semplice” con nome/ruolo
    if (msg.type === 'join-simple') {
      const { name, role } = msg;
      if (!name || !role) { ws.send(JSON.stringify({ type:'error', message:'Nome/ruolo mancanti' })); return; }
      const c = clients.get(clientId);
      c.name = name;
      c.role = role;
      ensureBudgetFields(c);

      ws.send(JSON.stringify({ type: 'joined', success: true, name, role, clientId }));
      { const sessionToken = Math.random().toString(36).slice(2)+Date.now().toString(36); const cc=clients.get(clientId); if (cc) cc.sessionToken=sessionToken; try{ ws.send(JSON.stringify({ type:'resume:token', sessionToken, participantId: cc?.participantId, name: cc?.name||name })); }catch{} }
      ws.send(JSON.stringify({ type: 'players-list', players }));
      sendStateToClient(c, ws);
      broadcastUsers(); markPresence(clientId, { name: c.name, participantId: c.participantId, isHost: !!c.isHost });
	  addToRoundIfEligible(clientId);
      return;
    }

    // Gestore (con PIN)
	if (msg.type === 'host-login') {
	  if (String(msg.pin) !== String(HOST_PIN)) {
		// Notifica specifica per la UI dell'host
		try { ws.send(JSON.stringify({ type: 'host-auth', success: false })); } catch {}
		return;
	  }

	  const c = clients.get(clientId);
	  c.isHost = true;
	  c.role = 'host';
	  c.name = 'Gestore';

	  // Messaggio atteso dal frontend per chiudere la login e mostrare la UI host
	  try { ws.send(JSON.stringify({ type: 'host-auth', success: true, clientId })); } catch {}

	  // Invariato: idrata subito la UI con dati utili
	  try { ws.send(JSON.stringify({ type: 'players-list', players })); } catch {}
	  try { sendStateToClient(c, ws); } catch {}

	  broadcastUsers();
	  markPresence(clientId, { name: c.name, participantId: c.participantId, isHost: !!c.isHost });
	  return;
	}


    // Configurazione budget/slot (host)
    if (msg.type === 'host:set-budget') {
      const { credits, slots } = msg;
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      if (!Number.isFinite(credits)) { ws.send(JSON.stringify({ type:'error', message:'credits non valido' })); return; }
      defaultCredits = Math.max(0, Math.floor(credits));
      if (slots && typeof slots === 'object') {
        defaultSlotsByRole = {
          por: Math.max(0, Math.floor(slots.por||0)),
          dif: Math.max(0, Math.floor(slots.dif||0)),
          cen: Math.max(0, Math.floor(slots.cen||0)),
          att: Math.max(0, Math.floor(slots.att||0))
        };
      }
      broadcast({ type:'config-updated', credits: defaultCredits, slots: defaultSlotsByRole });
      pushLog({ type:'config-updated', time: now(), credits: defaultCredits, slots: defaultSlotsByRole });
      // aggiorna tutti
      for (const [,c] of clients) ensureBudgetFields(c);
      broadcastUsers();
      return;
    }

    // Avvio asta da giocatore (host)
    if (msg.type === 'host:start') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      const { item } = msg;
      if (!item || !item.name) { ws.send(JSON.stringify({ type:'error', message:'Item invalido' })); return; }
      currentItem = item;
      currentPrice = Math.max(0, Math.floor(Number(item.startPrice || 0)));
      currentBidder = null; currentBidderId = null; bidHistory = [];
      const secs = dynamicSecondsFor(currentPrice || Number(currentItem?.startPrice || 0) || 0);
      broadcast({ type:'auction-started', item: currentItem, currentPrice, seconds: secs });
      pushLog({ type:'auction-start', time: now(), item });
      startTimer(secs);
      setPaused(false, null);
      return;
    }

    // Avvio round-robin
    if (msg.type === 'host:round-start') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      roundMode = msg.strategy === 'name' ? 'name' : 'random';
      nominationOrder = buildNominationOrder(roundMode);
      nominationIndex = -1; pickFirstEligible();
      broadcastRoundState();
      pushLog({ type:'round-start', time: now(), strategy: roundMode, order: nominationOrder.slice() });
      return;
    }

    if (msg.type === 'host:round-stop') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      roundMode = false; nominationOrder = []; nominationIndex = -1; currentNominatorId = null;
      broadcastRoundState();
      pushLog({ type:'round-stop', time: now() });
      return;
    }

    if (msg.type === 'host:skip-nominator') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      const prev = currentNominatorId;
      const result = advanceNominator();
      broadcastRoundState();
      pushLog({ type:'round-skip', time: now(), prev, result });
      reevaluatePause();
      return;
    }

    // Nomina da bidder durante round
    if (msg.type === 'bidder:nominate') {
      const c = clients.get(clientId);
      if (!roundMode) { ws.send(JSON.stringify({ type:'error', message:'Round non attivo' })); return; }
      if (clientId !== currentNominatorId) { ws.send(JSON.stringify({ type:'error', message:'Non è il tuo turno di nominare' })); return; }
      const { item } = msg;
      if (!item || !item.name) { ws.send(JSON.stringify({ type:'error', message:'Item invalido' })); return; }
      currentItem = item; currentPrice = Math.max(0, Math.floor(Number(item.startPrice || 0))); currentBidder = null; currentBidderId = null; bidHistory = [];
      const secs = dynamicSecondsFor(currentPrice || Number(currentItem?.startPrice || 0) || 0);
      broadcast({ type:'auction-started', item: currentItem, currentPrice, seconds: secs });
      pushLog({ type:'auction-start', time: now(), item, by: c?.name||'—' });
      startTimer(secs);
      setPaused(false, null);
      return;
    }

    // Offerte
    if (msg.type === 'bid') {
      if (auctionPaused) { try{ ws.send(JSON.stringify({ type:'error', message:'Asta in pausa.' })); }catch{} return; }
      if (!currentItem) { ws.send(JSON.stringify({ type: 'error', message: 'Nessun oggetto in asta.' })); return; }
      const c = clients.get(clientId);
      if (c && c.participantId) { const chk = allowOffer(c.participantId, currentPrice, Number(msg.amount)); if (!chk.ok) { try{ ws.send(JSON.stringify({ type:'error', message: `Offerta rifiutata: ${chk.reason}` })); }catch{} return; } }
      if (c.role === 'monitor') { ws.send(JSON.stringify({ type:'error', message: 'Il monitor non può fare offerte.' })); return; }

      const next = Math.floor(Number(msg.amount));
      const min = currentPrice + minIncrement;
      if (!Number.isFinite(next) || next < min) {
        ws.send(JSON.stringify({ type: 'error', message: `Offerta minima: ${min}` }));
        return;
      }

      // il bidder deve essere “eleggibile”
      if (!eligibleBidder(c)) { ws.send(JSON.stringify({ type:'error', message:'Slot/budget non eleggibili' })); return; }

      // Scatta il reset timer e aggiorna stato
      currentPrice = next;
      currentBidder = c.name || '—';
      currentBidderId = clientId;
      try{ reevaluatePause(); }catch{}
      bidHistory.push({ time: now(), name: currentBidder, amount: currentPrice });

      broadcast({ type:'bid-accepted', by: currentBidder, amount: currentPrice, last3: lastNBids(3) });
      resetTimer();
      return;
    }

    if (msg.type === 'host:end') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      endAuction('host-end');
      return;
    }

    if (msg.type === 'host:pause') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      setPaused(true, 'host_pause');
      return;
    }

    if (msg.type === 'host:resume') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      setPaused(false, null);
      return;
    }

    if (msg.type === 'host:set-countdown') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      const v = Math.max(3, Math.floor(Number(msg.seconds || baseCountdownSeconds)));
      baseCountdownSeconds = v;
      broadcast({ type:'countdown-updated', seconds: v });
      return;
    }

    if (msg.type === 'host:set-increment') {
      if (!clients.get(clientId)?.isHost) { ws.send(JSON.stringify({ type:'error', message:'Solo host' })); return; }
      const v = Math.max(1, Math.floor(Number(msg.minIncrement || minIncrement)));
      minIncrement = v;
      broadcast({ type:'increment-updated', minIncrement: v });
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
	  }

	  clients.delete(clientId);
	  presence.set(clientId, { ...(presence.get(clientId)||{}), lastSeen: Date.now() - STALE_CLIENT_MS - 1 });
	  broadcastUsers();
	  if (roundMode) {
		const prevLen = nominationOrder.length;
		nominationOrder = nominationOrder.filter(id => clients.has(id));
		// se abbiamo rimosso il corrente, scegli il primo eleggibile
		if (clientId === currentNominatorId || nominationOrder.length !== prevLen) {
		  if (!eligibleBidder(clients.get(currentNominatorId))) pickFirstEligible();
		  broadcastRoundState();
		}
	  }
	});
});

// === Minimo indispensabile non mostrato sopra ===
let minIncrement = 1;

function addToRoundIfEligible(id){
  if (!roundMode) return;
  if (!clients.has(id)) return;
  if (!eligibleBidder(clients.get(id))) return;
  const inOrder = nominationOrder.includes(id);
  if (!inOrder) {
    nominationOrder.push(id);
    if (currentNominatorId == null) pickFirstEligible();
    broadcastRoundState();
  }
}

// Avvio server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log('[HTTP] listening on :%s', PORT);
    console.log('[ENV] HOST_PIN set? %s', process.env.HOST_PIN ? 'yes' : 'no');
    console.log('[ENV] INVITE_SECRET set? %s', process.env.INVITE_SECRET ? 'yes' : 'no');
    console.log('[DIR] LOG_DIR =', LOG_DIR);
  } catch (e) {
    console.error('[log] mkdir error', e);
  }
});
