// O-44/O-45 Music/media roles, rights review, provenance, game-audio sync (V6 media track)
import { createHash, randomBytes } from 'node:crypto';

export type MediaRoleId = 'music-supervisor' | 'rights-reviewer' | 'game-audio-mixer' | 'media-librarian';

export interface MediaRole {
  id: MediaRoleId;
  title: string;
  canApproveCommercial: boolean;
  deniedActions: string[];
}

export const MEDIA_ROLES: Record<MediaRoleId, MediaRole> = {
  'music-supervisor': {
    id: 'music-supervisor',
    title: 'Music Supervisor',
    canApproveCommercial: false, // proposes only
    deniedActions: ['bypass_rights_review', 'strip_provenance'],
  },
  'rights-reviewer': {
    id: 'rights-reviewer',
    title: 'Rights Reviewer',
    canApproveCommercial: true,
    deniedActions: ['generate_unlicensed_clone', 'ignore_territory_holdbacks'],
  },
  'game-audio-mixer': {
    id: 'game-audio-mixer',
    title: 'Game Audio Mixer',
    canApproveCommercial: false,
    deniedActions: ['replace_master_without_stem_hash'],
  },
  'media-librarian': {
    id: 'media-librarian',
    title: 'Media Librarian',
    canApproveCommercial: false,
    deniedActions: ['delete_provenance', 'orphan_asset'],
  },
};

export type RightsStatus = 'cleared' | 'pending' | 'denied' | 'unknown';

export interface MediaAsset {
  id: string;
  title: string;
  contentHash: string;
  license: string;
  licensor: string;
  territory: string[];
  commercialOk: boolean;
  rightsStatus: RightsStatus;
  provenanceChain: string[]; // prior content hashes
  stemHash?: string;
}

export interface RightsReview {
  assetId: string;
  reviewerRole: MediaRoleId;
  decision: RightsStatus;
  notes: string;
  at: string;
}

export function createMediaAsset(input: {
  title: string;
  bytes: string;
  license: string;
  licensor: string;
  territory?: string[];
  commercialOk?: boolean;
  parentHash?: string;
  stemHash?: string;
}): MediaAsset {
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');
  const provenanceChain = input.parentHash ? [input.parentHash, contentHash] : [contentHash];
  return {
    id: `media_${randomBytes(6).toString('hex')}`,
    title: input.title,
    contentHash,
    license: input.license,
    licensor: input.licensor,
    territory: input.territory ?? ['WW'],
    commercialOk: input.commercialOk ?? false,
    rightsStatus: 'pending',
    provenanceChain,
    stemHash: input.stemHash,
  };
}

export function reviewRights(asset: MediaAsset, role: MediaRoleId, approve: boolean, notes = ''): RightsReview {
  const r = MEDIA_ROLES[role];
  if (approve && !r.canApproveCommercial && asset.commercialOk) {
    throw Object.assign(new Error(`${role} cannot approve commercial rights`), {
      code: 'media_rights_role_denied',
    });
  }
  if (approve && (!asset.license || asset.license.toLowerCase() === 'unknown')) {
    throw Object.assign(new Error('cannot clear unknown license'), { code: 'media_license_unknown' });
  }
  if (approve && asset.provenanceChain.length === 0) {
    throw Object.assign(new Error('cannot clear without provenance'), { code: 'media_provenance_missing' });
  }
  const decision: RightsStatus = approve ? 'cleared' : 'denied';
  asset.rightsStatus = decision;
  return {
    assetId: asset.id,
    reviewerRole: role,
    decision,
    notes,
    at: new Date().toISOString(),
  };
}

export function assertProvenanceIntact(asset: MediaAsset): void {
  if (!asset.provenanceChain.length) {
    throw Object.assign(new Error('empty provenance'), { code: 'media_provenance_empty' });
  }
  const last = asset.provenanceChain[asset.provenanceChain.length - 1];
  if (last !== asset.contentHash) {
    throw Object.assign(new Error('provenance tip mismatch'), { code: 'media_provenance_mismatch' });
  }
}

/** Game-audio sync: stem hash must match before master replace (O-45). */
export function syncGameAudio(input: {
  master: MediaAsset;
  stemHash: string;
  sceneId: string;
  beatMarkerMs: number;
}): { ok: boolean; blockers: string[]; syncId: string } {
  const blockers: string[] = [];
  assertProvenanceIntact(input.master);
  if (input.master.rightsStatus !== 'cleared') blockers.push('rights_not_cleared');
  if (!input.master.stemHash) blockers.push('master_missing_stem_hash');
  else if (input.master.stemHash !== input.stemHash) blockers.push('stem_hash_mismatch');
  if (!input.sceneId) blockers.push('scene_required');
  if (!Number.isFinite(input.beatMarkerMs) || input.beatMarkerMs < 0) blockers.push('invalid_beat_marker');
  const syncId = createHash('sha256')
    .update([input.master.contentHash, input.stemHash, input.sceneId, String(input.beatMarkerMs)].join('|'))
    .digest('hex')
    .slice(0, 24);
  return { ok: blockers.length === 0, blockers, syncId };
}

export function roleMay(role: MediaRoleId, action: string): boolean {
  return !MEDIA_ROLES[role].deniedActions.includes(action);
}
