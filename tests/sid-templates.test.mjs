import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { FEATURE_SOURCES, SID_TEMPLATES, SidTemplateRuntime, superviseSpawn } from '../server/src/lib/sid-templates.ts';
import { verifySidLegacy } from '../server/src/identity/sid-legacy.ts';

test('persona packs become SID templates with no grants', () => {
  const slugs = SID_TEMPLATES.map((row) => row.slug);
  for (const slug of ['anti-slop-reviewer', 'blockchain-coder', 'game-dev', 'video-creator']) {
    assert.ok(slugs.includes(slug), slug);
  }
  assert.ok(SID_TEMPLATES.every((row) => row.grants.length === 0));
  assert.ok(FEATURE_SOURCES.some((row) => row.repo === 'n8n-io/nod'));
  assert.ok(FEATURE_SOURCES.some((row) => row.repo === 'elie222/rakazo'));
  assert.ok(FEATURE_SOURCES.some((row) => row.repo === 'leepokai/Codync'));
  assert.ok(FEATURE_SOURCES.every((row) => row.sha.length === 40));
});

test('a full agent and a spawned sub-agent are different SIDs', () => {
  const rt = new SidTemplateRuntime(new Database(':memory:'));
  const parent = rt.install({ tenantId: 'tenant-a', template: 'rakazo-delegator' });
  const child = rt.spawnSubAgent({ tenantId: 'tenant-a', parentSid: parent.sid, template: 'blockchain-coder' });
  assert.notEqual(child.sid, parent.sid);
  assert.equal(parent.parentSid, null);
  assert.equal(child.parentSid, parent.sid);
  assert.equal(child.kind, 'sub');
  assert.equal(child.grants.length, 0);
  assert.equal(verifySidLegacy(parent.document).ok, true);
  assert.equal(verifySidLegacy(child.document).ok, true);
  assert.equal(child.document.identity.parent, parent.sid);
  assert.throws(() => rt.spawnSubAgent({ tenantId: 'tenant-b', parentSid: parent.sid, template: 'game-dev' }));
  const supervised = superviseSpawn(child.sid, parent.sid);
  assert.equal(supervised.backend, 'elixir');
  assert.match(supervised.lines[0], new RegExp(`SPAWN ${child.sid}`));
  assert.match(supervised.lines[1], new RegExp(`TERMINATED ${child.sid}`));
});
