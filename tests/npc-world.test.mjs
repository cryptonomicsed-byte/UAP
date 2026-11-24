import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shouldIssueSid,
  createWorldEntity,
  normalizeNpcPersona,
  loadScene,
  acceptGameSkillPack,
  entitySeparationDigest,
} from '../server/src/lib/npc-world.ts';

test('N-42 only persistent NPC and player get SID eligibility', () => {
  assert.equal(shouldIssueSid('world_prop'), false);
  assert.equal(shouldIssueSid('npc_decorative'), false);
  assert.equal(shouldIssueSid('npc_persistent'), true);
  assert.equal(shouldIssueSid('player_avatar'), true);
});

test('N-42 decorative NPC persona from world entity, no SID', () => {
  const e = createWorldEntity({
    kind: 'npc_decorative',
    sceneId: 'sc1',
    displayName: 'Shopkeep',
    persona: 'friendly merchant',
  });
  assert.equal(e.sidRef, undefined);
  const n = normalizeNpcPersona(e);
  assert.equal(n.personaSource, 'world_entity');
  assert.equal(n.sidBound, false);
});

test('N-42 persistent NPC issues SID by default', () => {
  const e = createWorldEntity({
    kind: 'npc_persistent',
    sceneId: 'sc1',
    displayName: 'Quest Giver',
    persona: 'solemn',
  });
  assert.ok(e.sidRef);
  assert.equal(normalizeNpcPersona(e).personaSource, 'sid');
});

test('N-42 cannot force SID onto decorative or prop', () => {
  assert.throws(
    () => createWorldEntity({ kind: 'npc_decorative', sceneId: 's', displayName: 'x', issueSid: true }),
    (e) => e.code === 'npc_sid_not_allowed',
  );
  assert.throws(
    () => createWorldEntity({ kind: 'world_prop', sceneId: 's', displayName: 'rock', issueSid: true }),
    (e) => e.code === 'npc_sid_not_allowed',
  );
});

test('N-42 loadScene rejects decorative with SID smuggled', () => {
  const dec = createWorldEntity({ kind: 'npc_decorative', sceneId: 'sc', displayName: 'd' });
  const smuggled = { ...dec, sidRef: 'sid_bad' };
  assert.throws(() => loadScene('sc', [smuggled]), (e) => e.code === 'decorative_sid_forbidden');
});

test('N-42 scene load + separation digest', () => {
  const prop = createWorldEntity({ kind: 'world_prop', sceneId: 'town', displayName: 'lamp' });
  const npc = createWorldEntity({ kind: 'npc_persistent', sceneId: 'town', displayName: 'mayor', persona: 'p' });
  const scene = loadScene('town', [prop, npc]);
  assert.equal(scene.entities.length, 2);
  assert.equal(entitySeparationDigest(scene).length, 64);
});

test('N-42 game skill pack needs engine version + asset licenses', () => {
  const bad = acceptGameSkillPack({ engine: 'godot', engineVersion: '', license: 'MIT', assetLicenses: ['unknown'] });
  assert.equal(bad.ok, false);
  const good = acceptGameSkillPack({
    engine: 'godot',
    engineVersion: '4.3',
    license: 'MIT',
    assetLicenses: ['CC0', 'MIT'],
  });
  assert.equal(good.ok, true);
});
