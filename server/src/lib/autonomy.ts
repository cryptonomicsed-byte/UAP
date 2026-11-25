/** Per-bot autonomy. Risky tools ask unless the owner set the bot to act.
 *  Delegation (duskbot pattern): a parent's level flows down to a spawned
 *  sub-agent, but only ever raises it, never lowers a sub-agent that was
 *  already set higher, and never raises a bot nobody delegated to. */
import type Database from 'better-sqlite3';

export type Autonomy = 'ask' | 'draft' | 'act';

const RANK: Record<Autonomy, number> = { ask: 0, draft: 1, act: 2 };

const RISKY = new Set([
  'spawn_sid_subagent',
  'install_sid_template',
  'save_file',
  'send_to_bot',
  'create_routine',
  'create_group',
]);

export function ensureAutonomySchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_autonomy (
    bot_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    delegated_from TEXT,
    updated_at INTEGER NOT NULL
  )`);
  const cols = db.prepare("PRAGMA table_info(bot_autonomy)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'delegated_from')) db.exec('ALTER TABLE bot_autonomy ADD COLUMN delegated_from TEXT');
}

export function getAutonomy(db: Database.Database, botId: string): Autonomy {
  ensureAutonomySchema(db);
  const row = db.prepare('SELECT mode FROM bot_autonomy WHERE bot_id=?').get(botId) as { mode?: string } | undefined;
  return row?.mode === 'draft' || row?.mode === 'act' ? row.mode : 'ask';
}

export function setAutonomy(db: Database.Database, botId: string, mode: Autonomy, delegatedFrom: string | null = null) {
  ensureAutonomySchema(db);
  db.prepare(`INSERT INTO bot_autonomy(bot_id, mode, delegated_from, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(bot_id) DO UPDATE SET mode=excluded.mode, delegated_from=excluded.delegated_from, updated_at=excluded.updated_at`)
    .run(botId, mode, delegatedFrom, Date.now());
  return getAutonomy(db, botId);
}

/** A spawned sub-agent's level only ever rises to its parent's, never falls. A bot with no
 *  delegation keeps whatever it had (default ask). Called once at spawn, not on every turn. */
export function delegateAutonomy(db: Database.Database, childBotId: string, parentBotId: string): Autonomy {
  const parentMode = getAutonomy(db, parentBotId);
  const childMode = getAutonomy(db, childBotId);
  const risen = RANK[parentMode] > RANK[childMode] ? parentMode : childMode;
  return setAutonomy(db, childBotId, risen, parentBotId);
}

export function autonomyDecision(mode: Autonomy, toolName: string): 'allow' | 'ask' {
  if (!RISKY.has(toolName)) return 'allow';
  if (mode === 'act') return 'allow';
  if (mode === 'draft' && toolName === 'save_file') return 'allow';
  return 'ask';
}

/** A scoped standing grant (duskbot's "Always allow"): exact bot, server, tool and server
 *  config. Invalidated the moment the server's command/url/headers change. Never offered
 *  for anything that writes, sends or deletes — read-shaped tools only. */
export interface StandingGrant { botId: string; serverId: string; toolName: string; configHash: string }

export function ensureGrantSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS standing_grants (
    bot_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, server_id, tool_name)
  )`);
}

export function rememberGrant(db: Database.Database, grant: StandingGrant) {
  ensureGrantSchema(db);
  db.prepare(`INSERT INTO standing_grants(bot_id,server_id,tool_name,config_hash,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(bot_id,server_id,tool_name) DO UPDATE SET config_hash=excluded.config_hash, created_at=excluded.created_at`)
    .run(grant.botId, grant.serverId, grant.toolName, grant.configHash, Date.now());
}

export function grantHolds(db: Database.Database, grant: StandingGrant): boolean {
  ensureGrantSchema(db);
  const row = db.prepare('SELECT config_hash FROM standing_grants WHERE bot_id=? AND server_id=? AND tool_name=?')
    .get(grant.botId, grant.serverId, grant.toolName) as { config_hash: string } | undefined;
  return !!row && row.config_hash === grant.configHash;
}

export function revokeGrant(db: Database.Database, botId: string, serverId: string, toolName: string) {
  ensureGrantSchema(db);
  db.prepare('DELETE FROM standing_grants WHERE bot_id=? AND server_id=? AND tool_name=?').run(botId, serverId, toolName);
}

export function listGrants(db: Database.Database, botId: string): StandingGrant[] {
  ensureGrantSchema(db);
  return (db.prepare('SELECT bot_id as botId, server_id as serverId, tool_name as toolName, config_hash as configHash FROM standing_grants WHERE bot_id=?').all(botId) as StandingGrant[]);
}
