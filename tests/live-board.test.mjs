import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { liveSnapshot } from '../server/src/lib/live.ts';

test('live snapshot does not return row bodies', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pending_turns (bot_id TEXT, state TEXT);
    CREATE TABLE approvals (id TEXT, bot_id TEXT, tool TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE rows (bot_id TEXT, kind TEXT, created_at INTEGER, body TEXT);`);
  db.prepare('INSERT INTO rows VALUES (?,?,?,?)').run('bot_a', 'text', 1, 'secret note');
  db.prepare('INSERT INTO pending_turns VALUES (?,?)').run('bot_a', 'running');
  const snap = liveSnapshot(db);
  assert.equal(snap.running, 1);
  assert.equal(JSON.stringify(snap).includes('secret note'), false);
  assert.equal(snap.recent[0].kind, 'text');
});
