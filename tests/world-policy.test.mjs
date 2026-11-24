import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorldEntity, loadScene } from '../server/src/lib/npc-world.ts';
import {
  evaluateWorldPolicy,
  unloadScene,
  assertSceneEmpty,
} from '../server/src/lib/world-policy.ts';

test('N-43 policy blocks SID persist on decorative', () => {
  const dec = createWorldEntity({ kind: 'npc_decorative', sceneId: 's', displayName: 'd' });
  const d = evaluateWorldPolicy({
    sceneId: 's',
    actorId: 'sys',
    action: 'persist_sid',
    target: dec,
    sceneLoaded: true,
  });
  assert.equal(d.allowed, false);
  assert.ok(d.blockers.includes('sid_persist_denied_for_kind'));
});

test('N-43 policy blocks actions when scene unloaded', () => {
  const d = evaluateWorldPolicy({
    sceneId: 's',
    actorId: 'a',
    action: 'spawn',
    sceneLoaded: false,
  });
  assert.ok(d.blockers.includes('scene_not_loaded'));
});

test('N-43 unload retains persistent SIDs and clears decorative', () => {
  const scene = loadScene('town', [
    createWorldEntity({ kind: 'world_prop', sceneId: 'town', displayName: 'crate' }),
    createWorldEntity({ kind: 'npc_decorative', sceneId: 'town', displayName: 'crowd' }),
    createWorldEntity({ kind: 'npc_persistent', sceneId: 'town', displayName: 'mayor', persona: 'm' }),
  ]);
  const report = unloadScene(scene);
  assert.equal(report.ok, true);
  assert.equal(report.clearedDecorative, 1);
  assert.equal(report.retainedSidRefs.length, 1);
  assert.equal(report.releasedEntityIds.length, 3);
  assert.doesNotThrow(() => assertSceneEmpty([]));
  assert.throws(() => assertSceneEmpty(scene.entities), (e) => e.code === 'scene_teardown_incomplete');
});

test('N-43 props cannot exec scripts', () => {
  const prop = createWorldEntity({ kind: 'world_prop', sceneId: 's', displayName: 'door' });
  const d = evaluateWorldPolicy({
    sceneId: 's',
    actorId: 'a',
    action: 'script_exec',
    target: prop,
    sceneLoaded: true,
  });
  assert.ok(d.blockers.includes('props_cannot_exec_scripts'));
});
