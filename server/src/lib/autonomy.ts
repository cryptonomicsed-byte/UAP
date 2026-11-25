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
  'create_skill',
  'send_email',
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
