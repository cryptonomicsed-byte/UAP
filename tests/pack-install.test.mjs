import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.SESSION_SECRET ??= 'pack-install-test-secret';
const { installPacksForSpecialists, installedPacksFor, ensurePackInstallSchema } = await import('../server/src/lib/pack-install.ts');

function db() {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE skills (id TEXT PRIMARY KEY, bot_id TEXT, name TEXT, body TEXT, description TEXT, created_at INTEGER, updated_at INTEGER)');
  return d;
}

test('installing a known-clear specialist writes real skill rows, not just a flag', () => {
  const d = db();
  const r = installPacksForSpecialists(d, 'bot_1', ['review', 'qa']);
  assert.ok(r.installedSkillIds.length > 0);
  const skillCount = (d.prepare('SELECT COUNT(*) as c FROM skills WHERE bot_id=?').get('bot_1')).c;
  assert.equal(skillCount, r.installedSkillIds.length);
});

test('a NOASSERTION (no-SPDX) source is refused, never silently installed', () => {
  const d = db();
  const r = installPacksForSpecialists(d, 'bot_1', ['clojure']); // clojure-skills is NOASSERTION
  assert.equal(r.installedSkillIds.length, 0);
  assert.ok(r.skippedRefused.some((s) => s.repo === 'iwillig/clojure-skills'));
});

test('installing the same specialist twice is idempotent — no duplicate skills', () => {
  const d = db();
  installPacksForSpecialists(d, 'bot_1', ['qa']);
  const after1 = installedPacksFor(d, 'bot_1').length;
  const r2 = installPacksForSpecialists(d, 'bot_1', ['qa']);
  assert.equal(r2.installedSkillIds.length, 0);
  assert.ok(r2.alreadyInstalled.length > 0);
  assert.equal(installedPacksFor(d, 'bot_1').length, after1);
});

test('installed packs are tracked per-bot and checkable, not a hardcoded constant', () => {
  const d = db();
  ensurePackInstallSchema(d);
  installPacksForSpecialists(d, 'bot_a', ['architect']);
  installPacksForSpecialists(d, 'bot_b', ['rust']);
  assert.ok(installedPacksFor(d, 'bot_a').length > 0);
  assert.ok(installedPacksFor(d, 'bot_b').length > 0);
  assert.notDeepEqual(installedPacksFor(d, 'bot_a').map((p) => p.repo), installedPacksFor(d, 'bot_b').map((p) => p.repo));
});
