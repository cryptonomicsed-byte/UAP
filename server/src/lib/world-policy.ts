// N-43 World policy + scene-unload teardown (V6-14 related)
import type { SceneSim, WorldEntity } from './npc-world.js';
import { shouldIssueSid } from './npc-world.js';

export type WorldPolicyAction = 'spawn' | 'despawn' | 'grant_item' | 'damage' | 'persist_sid' | 'script_exec';

export interface WorldPolicyContext {
  sceneId: string;
  actorId: string;
  action: WorldPolicyAction;
  target?: WorldEntity;
  /** scene still loaded */
  sceneLoaded: boolean;
}

export interface WorldPolicyDecision {
  allowed: boolean;
  blockers: string[];
}

export function evaluateWorldPolicy(ctx: WorldPolicyContext): WorldPolicyDecision {
  const blockers: string[] = [];
  if (!ctx.sceneLoaded && ctx.action !== 'despawn') {
    blockers.push('scene_not_loaded');
  }
  if (ctx.action === 'persist_sid' && ctx.target && !shouldIssueSid(ctx.target.kind)) {
    blockers.push('sid_persist_denied_for_kind');
  }
  if (ctx.action === 'script_exec' && ctx.target?.kind === 'world_prop') {
    blockers.push('props_cannot_exec_scripts');
  }
  if (ctx.action === 'damage' && ctx.target?.kind === 'npc_decorative') {
    // decorative may be damaged as scenery but cannot escalate to SID death
    if (ctx.target.sidRef) blockers.push('decorative_sid_invariant');
  }
  return { allowed: blockers.length === 0, blockers };
}

export interface TeardownReport {
  sceneId: string;
  releasedEntityIds: string[];
  retainedSidRefs: string[];
  clearedDecorative: number;
  ok: boolean;
  blockers: string[];
}

/**
 * Scene unload: drop decorative + props from live memory; retain only persistent SID refs.
 * Must not leak decorative persona sessions.
 */
export function unloadScene(scene: SceneSim): TeardownReport {
  const blockers: string[] = [];
  const released: string[] = [];
  const retained: string[] = [];
  let clearedDecorative = 0;

  for (const e of scene.entities) {
    if (e.kind === 'npc_persistent' || e.kind === 'player_avatar') {
      if (e.sidRef) retained.push(e.sidRef);
      else blockers.push(`persistent_without_sid:${e.id}`);
      released.push(e.id); // remove from scene graph but SID vault retains
    } else {
      if (e.sidRef) blockers.push(`teardown_sid_leak:${e.id}`);
      if (e.kind === 'npc_decorative') clearedDecorative += 1;
      released.push(e.id);
    }
  }

  return {
    sceneId: scene.sceneId,
    releasedEntityIds: released,
    retainedSidRefs: retained,
    clearedDecorative,
    ok: blockers.length === 0,
    blockers,
  };
}

/** After unload, live scene entity count must be zero from caller's store. */
export function assertSceneEmpty(liveEntities: WorldEntity[]): void {
  if (liveEntities.length > 0) {
    throw Object.assign(new Error('scene not empty after unload'), {
      code: 'scene_teardown_incomplete',
      remaining: liveEntities.length,
    });
  }
}
