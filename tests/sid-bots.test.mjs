import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { materializeSidBot } from '../server/src/lib/sid-bots.ts';

function db() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      label TEXT,
      description TEXT,
      instructions TEXT,
      avatar_shape TEXT,
      avatar_color TEXT,
      mode TEXT,
      is_primary INTEGER,
      effort TEXT,
      parent_bot_id TEXT,
      hidden INTEGER,
      sid TEXT,
      kind TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('bot_parent', 'tenant-a', 'Doug', 1, 1);
  return database;
}

test('installing a template creates a visible bot and a cast SID', () => {
  const database = db();
  const made = materializeSidBot(database, { userId: 'tenant-a', template: 'video-creator' });
  const row = database.prepare('SELECT hidden, sid, parent_bot_id FROM bots WHERE id=?').get(made.botId);
  assert.equal(row.hidden, 0);
  assert.equal(row.sid, made.sid);
  assert.equal(row.parent_bot_id, null);
  assert.equal(made.kind, 'full');
  assert.equal(made.supervised.backend, 'elixir');
});

test('spawning a sub-agent does not reuse the parent SID', () => {
  const database = db();
  const child = materializeSidBot(database, { userId: 'tenant-a', template: 'blockchain-coder', parentBotId: 'bot_parent' });
  const parent = database.prepare('SELECT sid FROM bots WHERE id=?').get('bot_parent');
  assert.notEqual(child.sid, parent.sid);
  assert.equal(child.kind, 'sub');
  assert.equal(child.parentSid, parent.sid);
  const row = database.prepare('SELECT hidden, parent_bot_id FROM bots WHERE id=?').get(child.botId);
  assert.equal(row.hidden, 1);
  assert.equal(row.parent_bot_id, 'bot_parent');
});
