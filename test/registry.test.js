const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'participants.json');

test('loadAll removes duplicates and keeps last record', (t) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const sample = [
    { id: '1', name: 'alpha' },
    { id: '2', name: 'beta' },
    { id: '1', name: 'gamma' },
    { id: '2', name: 'delta' }
  ];
  fs.writeFileSync(dbFile, JSON.stringify(sample));

  const registry = require('../lib/registry');
  const all = registry.listParticipants();

  assert.strictEqual(all.length, 2);
  const p1 = all.find(p => p.id === '1');
  const p2 = all.find(p => p.id === '2');
  assert.strictEqual(p1.name, 'gamma');
  assert.strictEqual(p2.name, 'delta');

  const persisted = JSON.parse(fs.readFileSync(dbFile));
  assert.strictEqual(persisted.length, 2);

  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
});
