import { CHAIN_TEMPLATES } from './chain-gates.js';
import { RESEARCH_ROLES } from './research-gates.js';
import { MEDIA_ROLES } from './media-rights.js';
import { listLanguageGatePacks } from './language-gates.js';
import { shouldIssueSid, type EntityKind } from './npc-world.js';

const KINDS: EntityKind[] = ['npc_decorative', 'npc_persistent', 'player_avatar', 'world_prop'];

/** Domain catalog. Templates and roles, not a signer and not a clinical approval. */
export function domainSurface() {
  return {
    chain: Object.values(CHAIN_TEMPLATES).map((row) => ({
      family: row.family,
      accountModel: row.accountModel,
      signer: false,
    })),
    research: Object.values(RESEARCH_ROLES).map((row) => ({ id: row.id, title: row.title, riskClass: row.riskClass })),
    media: Object.values(MEDIA_ROLES).map((row) => ({ id: row.id, title: row.title, canApproveCommercial: row.canApproveCommercial })),
    npc: Object.fromEntries(KINDS.map((kind) => [kind, shouldIssueSid(kind)])),
    languages: listLanguageGatePacks().map((row) => ({ id: row.id, title: row.title, version: row.version })),
  };
}
