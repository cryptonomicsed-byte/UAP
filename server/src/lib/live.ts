import type Database from 'better-sqlite3';

export function liveSnapshot(db: Database.Database) {
  const pending = db.prepare('SELECT bot_id, state FROM pending_turns').all();
  const approvals = db.prepare('SELECT id, bot_id, tool, status, created_at FROM approvals ORDER BY created_at DESC LIMIT 20').all();
  const recent = db.prepare('SELECT bot_id, kind, created_at FROM rows ORDER BY created_at DESC LIMIT 20').all();
  return {
    pending,
    approvals,
    recent,
    running: pending.length,
    note: 'A pending turn is a lease, not proof the worker is healthy.',
  };
}
