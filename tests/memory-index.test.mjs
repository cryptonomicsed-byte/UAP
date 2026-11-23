// The derived memory index is a projection: it may never outlive or resurrect erased content.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-memory-index-'));
process.env.SESSION_SECRET = 'memory-index-test-secret';
process.env.DB_PATH = path.join(dir, 'app.sqlite');
process.env.ENGINES_DIR = path.join(dir, 'engines');
process.env.HERMES_HOME_PRIMARY = path.join(dir, 'primary');
process.env.DEV_LOGIN = '0';
process.env.ALLOWED_EMAILS = '';
process.env.UAP_NO_SCHEDULER = '1';
await mkdir(path.join(process.env.HERMES_HOME_PRIMARY, 'memories'), { recursive: true });

const { db } = await import('../server/src/db.ts');
const { syncMemoryIndex, searchMemory, removeMemoryFromIndex, rememberTombstone } = await import('../server/src/search/memory-index.ts');

after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

const seedBot = (id) => {
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('usr-index', 'index@example.test', 'Index', 1);
  db.prepare("INSERT OR IGNORE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, 'usr-index', id, 1, 1);
};

const memory = (botId, key, text) => ({
  id: `mem.${botId}.${key}.${'0'.repeat(16)}`,
  botId, text, createdAt: 1, source: key === 'u' ? 'chat' : 'learned',
});

test('sync indexes terms so a memory is found by any word, case-insensitively', () => {
  seedBot('bot-index-a');
  const entries = [
    memory('bot-index-a', 'm', 'Prefers Oat Milk in coffee'),
    memory('bot-index-a', 'u', 'Lives in Helsinki; speaks Suomi'),
  ];
  syncMemoryIndex('bot-index-a', entries);

  assert.deepEqual(searchMemory('bot-index-a', 'oat'), [entries[0].id]);
  assert.deepEqual(searchMemory('bot-index-a', 'SUOMI'), [entries[1].id]);
  assert.deepEqual(searchMemory('bot-index-a', 'coffee milk'), [entries[0].id]);
  assert.deepEqual(searchMemory('bot-index-a', 'coffee suomi'), [], 'all terms must match one memory');
  assert.deepEqual(searchMemory('bot-index-a', 'nothing-here'), []);
});

test('the index is scoped per bot and does not leak across agents', () => {
  seedBot('bot-index-b');
  const own = memory('bot-index-b', 'm', 'Only for bot b');
  syncMemoryIndex('bot-index-b', [own]);
  assert.deepEqual(searchMemory('bot-index-b', 'only'), [own.id]);
  assert.deepEqual(searchMemory('bot-index-a', 'only'), []);
});

test('removing a memory drops its terms and stale sources', () => {
  seedBot('bot-index-c');
  const entry = memory('bot-index-c', 'm', 'Ephemeral fact about a harbour');
  syncMemoryIndex('bot-index-c', [entry]);
  assert.deepEqual(searchMemory('bot-index-c', 'harbour'), [entry.id]);

  removeMemoryFromIndex(entry.id);
  assert.deepEqual(searchMemory('bot-index-c', 'harbour'), []);
  // A later sync with the same entry must not bring it back unless it is present in the source list.
  syncMemoryIndex('bot-index-c', []);
  assert.deepEqual(searchMemory('bot-index-c', 'harbour'), []);
});

test('a tombstone blocks an erased content hash from being re-indexed', () => {
  seedBot('bot-index-d');
  const entry = memory('bot-index-d', 'm', 'Sensitive detail that was erased');
  syncMemoryIndex('bot-index-d', [entry]);
  assert.deepEqual(searchMemory('bot-index-d', 'sensitive'), [entry.id]);

  rememberTombstone('bot-index-d', entry.text, { requestId: 'privacy_test', source: entry.id });
  removeMemoryFromIndex(entry.id);
  // Even if the same bytes are offered again, the erased content must stay out of the index.
  syncMemoryIndex('bot-index-d', [entry]);
  assert.deepEqual(searchMemory('bot-index-d', 'sensitive'), []);
});

test('an empty query is rejected rather than matching every memory', () => {
  seedBot('bot-index-e');
  syncMemoryIndex('bot-index-e', [memory('bot-index-e', 'm', 'Some text')]);
  assert.deepEqual(searchMemory('bot-index-e', ''), []);
  assert.deepEqual(searchMemory('bot-index-e', '   '), []);
});
