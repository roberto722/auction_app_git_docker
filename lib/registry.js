const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, '..', 'data', 'participants.json');

function loadAll(){
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveAll(items){ fs.mkdirSync(path.dirname(DB_FILE), {recursive:true}); fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2)); }

function getParticipant(id){
  return loadAll().find(p => p.id === id) || null;
}
function upsertParticipant(p){
  const all = loadAll();
  const i = all.findIndex(x => x.id === p.id);
  if (i >= 0) all[i] = { ...all[i], ...p };
  else all.push(p);
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
  return loadAll();
}
module.exports = { getParticipant, upsertParticipant, deleteParticipant, listParticipants };