// N-42 NPC / SID / world-entity separation + scene simulation hooks (V6-14-01..03 partial)
import { createHash, randomBytes } from 'node:crypto';

export type EntityKind = 'world_prop' | 'npc_decorative' | 'npc_persistent' | 'player_avatar';

export interface WorldEntity {
  id: string;
  kind: EntityKind;
  sceneId: string;
  displayName: string;
  /** Persona text for NPCs — never confuses with SID identity */
  persona?: string;
  /** Only set when independent persistent agent */
  sidRef?: string;
  rights?: { license: string; attribution: string };
}

export interface SceneSim {
  sceneId: string;
  entities: WorldEntity[];
  loadedAt: string;
}

export function shouldIssueSid(kind: EntityKind): boolean {
  // V6-14-02: optional persistent SID only when NPC is independent, not every decorative object
  return kind === 'npc_persistent' || kind === 'player_avatar';
}

export function normalizeNpcPersona(entity: WorldEntity): {
  personaSource: 'sid' | 'world_entity' | 'none';
  persona: string;
  sidBound: boolean;
} {
  if (entity.kind === 'world_prop') {
    return { personaSource: 'none', persona: '', sidBound: false };
  }
  if (entity.sidRef && shouldIssueSid(entity.kind)) {
    return {
      personaSource: 'sid',
      persona: entity.persona ?? '',
      sidBound: true,
    };
  }
  // Decorative NPC: persona from world entity instance only
  return {
    personaSource: entity.persona ? 'world_entity' : 'none',
    persona: entity.persona ?? '',
    sidBound: false,
  };
}

export function createWorldEntity(input: {
  kind: EntityKind;
  sceneId: string;
  displayName: string;
  persona?: string;
  issueSid?: boolean;
  rights?: { license: string; attribution: string };
}): WorldEntity {
  const id = `ent_${randomBytes(6).toString('hex')}`;
  let sidRef: string | undefined;
  if (input.issueSid) {
    if (!shouldIssueSid(input.kind)) {
      throw Object.assign(new Error(`kind ${input.kind} cannot receive SID`), {
        code: 'npc_sid_not_allowed',
      });
    }
    sidRef = `sid_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
  }
  if (input.kind === 'npc_persistent' && !sidRef && input.issueSid !== false) {
    // persistent NPCs default to SID issuance when not explicitly refused
    sidRef = `sid_${createHash('sha256').update(id + 'p').digest('hex').slice(0, 16)}`;
  }
  return {
    id,
    kind: input.kind,
    sceneId: input.sceneId,
    displayName: input.displayName,
    persona: input.persona,
    sidRef,
    rights: input.rights,
  };
}

export function loadScene(sceneId: string, entities: WorldEntity[]): SceneSim {
  for (const e of entities) {
    if (e.sceneId !== sceneId) {
      throw Object.assign(new Error(`entity ${e.id} scene mismatch`), { code: 'scene_entity_mismatch' });
    }
    // Decorative must not carry SID
    if (e.kind === 'npc_decorative' && e.sidRef) {
      throw Object.assign(new Error('decorative NPC must not carry SID'), { code: 'decorative_sid_forbidden' });
    }
    if (e.kind === 'world_prop' && e.sidRef) {
      throw Object.assign(new Error('world prop must not carry SID'), { code: 'prop_sid_forbidden' });
    }
  }
  return { sceneId, entities: [...entities], loadedAt: new Date().toISOString() };
}

/** Skill pack compatibility stub for game-dev packs (V6-14-03). */
export function acceptGameSkillPack(pack: {
  engine: string;
  engineVersion: string;
  license: string;
  assetLicenses: string[];
}): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!pack.engine || !pack.engineVersion) blockers.push('engine_version_required');
  if (!pack.license) blockers.push('pack_license_required');
  if (pack.assetLicenses.some((l) => !l || l.toLowerCase() === 'unknown')) {
    blockers.push('asset_license_unknown');
  }
  const banned = ['all-rights-reserved-no-game-use', 'stolen'];
  for (const l of pack.assetLicenses) {
    if (banned.includes(l.toLowerCase())) blockers.push(`asset_license_banned:${l}`);
  }
  return { ok: blockers.length === 0, blockers };
}

export function entitySeparationDigest(scene: SceneSim): string {
  const rows = scene.entities.map((e) => ({
    id: e.id,
    kind: e.kind,
    sid: e.sidRef ?? null,
    personaSource: normalizeNpcPersona(e).personaSource,
  }));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
