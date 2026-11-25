/** Per-bot autonomy. Risky tools ask unless the owner set the bot to act. */
import type Database from 'better-sqlite3';

export type Autonomy = 'ask' | 'draft' | 'act';

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
    updated_at INTEGER NOT NULL
  )`);
}

export function getAutonomy(db: Database.Database, botId: string): Autonomy {
  ensureAutonomySchema(db);
  const row = db.prepare('SELECT mode FROM bot_autonomy WHERE bot_id=?').get(botId) as { mode?: string } | undefined;
  return row?.mode === 'draft' || row?.mode === 'act' ? row.mode : 'ask';
}

export function setAutonomy(db: Database.Database, botId: string, mode: Autonomy) {
  ensureAutonomySchema(db);
  db.prepare('INSERT INTO bot_autonomy(bot_id, mode, updated_at) VALUES (?,?,?) ON CONFLICT(bot_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at')
    .run(botId, mode, Date.now());
  return getAutonomy(db, botId);
}

export function autonomyDecision(mode: Autonomy, toolName: string): 'allow' | 'ask' {
  if (!RISKY.has(toolName)) return 'allow';
  if (mode === 'act') return 'allow';
  if (mode === 'draft' && toolName === 'save_file') return 'allow';
  return 'ask';
}
