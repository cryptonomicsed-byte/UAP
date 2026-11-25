/** MAUS-F-11: per-channel rate/usage caps so a message storm cannot launch unlimited paid
 *  agent turns. Independent of autonomy level — autonomy controls whether a tool asks for
 *  approval; this controls whether a channel is allowed to START new turns at all right now.
 *  A sliding window per channel, not per message: bursts are fine, a sustained storm is not. */
import type Database from 'better-sqlite3';

export interface ChannelCapConfig { windowMs: number; maxTurnsPerWindow: number }

export const DEFAULT_CHANNEL_CAP: ChannelCapConfig = { windowMs: 60_000, maxTurnsPerWindow: 20 };

export function ensureChannelCapSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_turn_events (channel_id TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS channel_turn_events_channel ON channel_turn_events(channel_id, at)`);
}

/** Record that a turn is about to start for this channel. Call this, not a separate check,
 *  so the record and the decision never drift apart under concurrent requests. */
export function recordAndCheckChannelCap(
  db: Database.Database,
  channelId: string,
  config: ChannelCapConfig = DEFAULT_CHANNEL_CAP,
): { allowed: boolean; countInWindow: number; retryAfterMs: number } {
  ensureChannelCapSchema(db);
  const now = Date.now();
  const windowStart = now - config.windowMs;
  db.prepare('DELETE FROM channel_turn_events WHERE channel_id=? AND at < ?').run(channelId, windowStart);
  const countInWindow = (db.prepare('SELECT COUNT(*) as c FROM channel_turn_events WHERE channel_id=? AND at >= ?').get(channelId, windowStart) as { c: number }).c;
  if (countInWindow >= config.maxTurnsPerWindow) {
    const oldest = db.prepare('SELECT MIN(at) as m FROM channel_turn_events WHERE channel_id=? AND at >= ?').get(channelId, windowStart) as { m: number | null };
    const retryAfterMs = oldest.m ? Math.max(0, oldest.m + config.windowMs - now) : config.windowMs;
    return { allowed: false, countInWindow, retryAfterMs };
  }
  db.prepare('INSERT INTO channel_turn_events(channel_id, at) VALUES (?, ?)').run(channelId, now);
  return { allowed: true, countInWindow: countInWindow + 1, retryAfterMs: 0 };
}

export function channelCapStatus(db: Database.Database, channelId: string, config: ChannelCapConfig = DEFAULT_CHANNEL_CAP) {
  ensureChannelCapSchema(db);
  const windowStart = Date.now() - config.windowMs;
  const countInWindow = (db.prepare('SELECT COUNT(*) as c FROM channel_turn_events WHERE channel_id=? AND at >= ?').get(channelId, windowStart) as { c: number }).c;
  return { countInWindow, max: config.maxTurnsPerWindow, windowMs: config.windowMs };
}
