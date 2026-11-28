/**
 * Turn a SID template into a bot the workspace can see.
 * A sub-agent is a new SID with parent set. It does not copy the parent's grants.
 * Its autonomy level flows down from the parent (only ever rises — duskbot's pattern).
 */
import type Database from 'better-sqlite3';
import { newId } from '../lib/ids.js';
import { SidTemplateError, SidTemplateRuntime, SID_TEMPLATES, superviseSpawn } from '../lib/sid-templates.js';
import { delegateAutonomy } from '../lib/autonomy.js';
import { installPacksForSpecialists } from '../lib/pack-install.js';
import { ensureNostrIdentity } from '../lib/nostr-identity.js';

export interface MaterializedSid {
  botId: string;
  sid: string;
  kind: 'full' | 'sub';
  parentSid: string | null;
  parentBotId: string | null;
  template: string;
  supervised: { backend: 'elixir' | 'unavailable'; lines: string[] };
  packsInstalled: string[];
  npub: string | null;
}

function templateOf(slug: string) {
  const template = SID_TEMPLATES.find((row) => row.slug === slug);
  if (!template) throw new SidTemplateError('template', 'unknown template');
  return template;
}

function ensureParentSid(db: Database.Database, rt: SidTemplateRuntime, parentBotId: string, tenantId: string): string {
  const parent = db.prepare('SELECT id, user_id, sid FROM bots WHERE id=?').get(parentBotId) as { id: string; user_id: string; sid: string | null } | undefined;
  if (!parent) throw new SidTemplateError('parent', 'parent bot not found');
  if (parent.user_id !== tenantId) throw new SidTemplateError('tenant', 'parent bot is not in this tenant');
  if (parent.sid) return parent.sid;
  const minted = rt.install({ tenantId, template: 'rakazo-delegator' });
  db.prepare('UPDATE bots SET sid=?, updated_at=? WHERE id=?').run(minted.sid, Date.now(), parent.id);
  return minted.sid;
}

export function materializeSidBot(db: Database.Database, input: { userId: string; template: string; parentBotId?: string | null; omokodaBirthHash?: string }): MaterializedSid {
  const template = templateOf(input.template);
  const rt = new SidTemplateRuntime(db);
  const parentBotId = input.parentBotId || null;
  const minted = parentBotId
    ? rt.spawnSubAgent({ tenantId: input.userId, parentSid: ensureParentSid(db, rt, parentBotId, input.userId), template: template.slug })
    : rt.install({ tenantId: input.userId, template: template.slug, omokodaBirthHash: input.omokodaBirthHash });
  const botId = newId(parentBotId ? 'sub' : 'bot');
  const now = Date.now();
  const instructions = [
    `You are the SID agent ${minted.sid}.`,
    `Template: ${template.title} (${template.source.repo}@${template.source.sha.slice(0, 12)}).`,
    template.source.take,
    'You have no grants. A tool lease is required before any side effect. Ask before an irreversible act.',
    parentBotId ? 'You are a sub-agent. Report the result to your parent. Do not message the user as if you were the parent.' : 'You are a full agent. Your parent field is null.',
  ].join('\n');
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,effort,parent_bot_id,hidden,sid,kind,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
  ).run(
    botId,
    input.userId,
    template.title,
    template.family,
    template.source.take,
    instructions,
    'hex',
    'black',
    'teammate',
    'medium',
    parentBotId,
    parentBotId ? 1 : 0,
    minted.sid,
    'agent',
    now,
    now,
  );
  if (parentBotId) delegateAutonomy(db, botId, parentBotId);
  const packs = installPacksForSpecialists(db, botId, template.specialistIds);
  let npub: string | null = null;
  try {
    npub = ensureNostrIdentity(db, botId, new URL(`../../../data/nostr-secrets/${botId}`, import.meta.url).pathname).npub;
  } catch (e) {
    console.warn(`[sid] no Nostr identity minted for ${botId}: ${(e as Error).message}`);
  }
  return {
    botId,
    sid: minted.sid,
    kind: minted.kind,
    parentSid: minted.parentSid,
    parentBotId,
    template: template.slug,
    supervised: superviseSpawn(minted.sid, minted.parentSid),
    packsInstalled: packs.installedSkillIds,
    npub,
  };
}
