const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, '..', 'data', 'participants.json');

function loadAll(){
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveAll(items){ fs.mkdirSync(path.dirname(DB_FILE), {recursive:true}); fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2)); }

function getParticipant(id){
  const p = loadAll().find(p => p.id === id);
  if (!p) return null;
  if (!Array.isArray(p.players)) p.players = [];
  return p;
}
function upsertParticipant(p){
  const all = loadAll();
  const i = all.findIndex(x => x.id === p.id);
  if (i >= 0) all[i] = { ...all[i], ...p, players: Array.isArray(p.players) ? p.players : (all[i].players || []) };
  else all.push({ ...p, players: Array.isArray(p.players) ? p.players : [] });
  saveAll(all);
  return p;
}
function deleteParticipant(id){
  let all = loadAll();
  const len = all.length;
  all = all.filter(p => p.id !== id);
  if (all.length !== len) saveAll(all);
  return len !== all.length;
}
function listParticipants(){
  return loadAll().map(p => ({ ...p, players: Array.isArray(p.players) ? p.players : [] }));
}

function addPlayer(participantId, player){
  const raw = (player.fascia || player.role || '').toString().trim().toUpperCase();
  const fascia = raw ? raw[0] : '';
  if (!['P','D','C','A'].includes(fascia)) {
    throw new Error('addPlayer: invalid fascia');
  }
  const p = getParticipant(participantId) || { id: participantId, players: [] };
  const players = Array.isArray(p.players) ? p.players.slice() : [];
  const stored = { ...player, fascia };
  players.push(stored);
  upsertParticipant({ ...p, players });
  return stored;
}

function removePlayer(participantId, playerId){
  const p = getParticipant(participantId);
  if (!p) return null;
  const players = Array.isArray(p.players) ? p.players.slice() : [];
  const idx = players.findIndex(pl => pl.id === playerId);
  if (idx < 0) return null;
  const [removed] = players.splice(idx,1);
  upsertParticipant({ ...p, players });
  return removed;
}

function movePlayer(fromPid, toPid, playerId){
  const pl = removePlayer(fromPid, playerId);
  if (!pl) return null;
  addPlayer(toPid, pl);
  return pl;
}

module.exports = { getParticipant, upsertParticipant, deleteParticipant, listParticipants, addPlayer, removePlayer, movePlayer };
