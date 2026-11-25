/**
 * Agent fallback chain, adapted from Codync's design (not its code):
 * a chain of AGENTS, not models. Rests belong to the login, not the bot, so one
 * rate-limited login rests for every bot on it. Bounded: each agent tried at most
 * once per turn, at most 3 fallback steps. A handover ledger is cheap — paths and
 * command lines only, never a diff or output, no model call to build it.
 */
import type Database from 'better-sqlite3';

export type FallbackReason = 'usageLimit' | 'outOfCredits' | 'rateLimited' | 'signedOut' | 'notStarting' | 'modelMissing';

export interface FallbackStep { agent: string; model: string; loginKey: string }

const REST_MS: Record<FallbackReason, number> = {
  usageLimit: 60 * 60 * 1000,
  outOfCredits: 6 * 60 * 60 * 1000,
  rateLimited: 5 * 60 * 1000,
  signedOut: 60 * 60 * 1000,
  notStarting: 5 * 60 * 1000,
  modelMissing: 0, // the bot's own setup, not the login's — no rest, just skip this step forever until config changes
};

/** Classify a provider failure the way Codync reads it: text first, category second. */
export function classifyFailure(message: string): FallbackReason {
  const m = message.toLowerCase();
  if (m.includes('usage limit') || m.includes('usage_limit') || m.includes("you've hit")) return 'usageLimit';
  if (m.includes('billing') || m.includes('out of credit') || m.includes('account_on_hold')) return 'outOfCredits';
  if (m.includes('no live kernel') || m.includes('not started') || m.includes('timeout') || m.includes('exited')) return 'notStarting';
  if (m.includes('signed out') || m.includes('authentication') || m.includes('unauthorized')) return 'signedOut';
  if (m.includes('model_not_found') || m.includes('no model') || m.includes('model not found')) return 'modelMissing';
  return 'rateLimited';
}

export function ensureFallbackSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_fallback_chain (
    bot_id TEXT NOT NULL, step INTEGER NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, login_key TEXT NOT NULL,
    PRIMARY KEY (bot_id, step)
  );
  CREATE TABLE IF NOT EXISTS agent_login_rest (
    login_key TEXT PRIMARY KEY, reason TEXT NOT NULL, until INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_fallback_ledger (
    bot_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
  )`);
}

export function setFallbackChain(db: Database.Database, botId: string, steps: FallbackStep[]) {
  ensureFallbackSchema(db);
  if (steps.length > 3) throw new Error('at most 3 fallback steps');
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.loginKey)) throw new Error(`login ${s.loginKey} already in this chain`);
    seen.add(s.loginKey);
  }
  db.prepare('DELETE FROM agent_fallback_chain WHERE bot_id=?').run(botId);
  steps.forEach((s, i) => db.prepare('INSERT INTO agent_fallback_chain(bot_id,step,agent,model,login_key) VALUES (?,?,?,?,?)').run(botId, i, s.agent, s.model, s.loginKey));
}

export function getFallbackChain(db: Database.Database, botId: string): FallbackStep[] {
  ensureFallbackSchema(db);
  return (db.prepare('SELECT agent, model, login_key as loginKey FROM agent_fallback_chain WHERE bot_id=? ORDER BY step').all(botId) as FallbackStep[]);
}

/** A login's rest is shared by every bot on it — the login is resting, not the bot. */
export function restLogin(db: Database.Database, loginKey: string, reason: FallbackReason) {
  ensureFallbackSchema(db);
  const ms = REST_MS[reason];
  if (ms === 0) return; // modelMissing: the bot's own setup, nothing to rest
  db.prepare('INSERT INTO agent_login_rest(login_key,reason,until) VALUES (?,?,?) ON CONFLICT(login_key) DO UPDATE SET reason=excluded.reason, until=excluded.until')
    .run(loginKey, reason, Date.now() + ms);
}

export function loginResting(db: Database.Database, loginKey: string): { resting: boolean; reason?: FallbackReason; until?: number } {
  ensureFallbackSchema(db);
  const row = db.prepare('SELECT reason, until FROM agent_login_rest WHERE login_key=?').get(loginKey) as { reason: FallbackReason; until: number } | undefined;
  if (!row || row.until <= Date.now()) return { resting: false };
  return { resting: true, reason: row.reason, until: row.until };
}

export function switchBack(db: Database.Database, loginKey: string) {
  ensureFallbackSchema(db);
  db.prepare('DELETE FROM agent_login_rest WHERE login_key=?').run(loginKey);
}

/** First step (in order) whose login is not resting. null = every agent in the chain is resting. */
export function nextStep(db: Database.Database, botId: string): { step: FallbackStep; index: number } | null {
  const chain = getFallbackChain(db, botId);
  for (let i = 0; i < chain.length; i++) {
    if (!loginResting(db, chain[i].loginKey).resting) return { step: chain[i], index: i };
  }
  return null;
}

/** Record a ledger entry: a path or command line, never a diff or output. Capped by the caller. */
export function ledgerEntry(db: Database.Database, botId: string, kind: 'file' | 'command' | 'server', detail: string) {
  ensureFallbackSchema(db);
  db.prepare('INSERT INTO agent_fallback_ledger(bot_id,kind,detail,at) VALUES (?,?,?,?)').run(botId, kind, detail.slice(0, 400), Date.now());
}

/** The handover ledger: at most 10 files, 6 commands, 6 servers, newest first, the rest counted. No model call. */
export function handoverLedger(db: Database.Database, botId: string): { files: string[]; commands: string[]; servers: string[]; moreFiles: number; moreCommands: number } {
  ensureFallbackSchema(db);
  const rows = (db.prepare('SELECT kind, detail FROM agent_fallback_ledger WHERE bot_id=? ORDER BY rowid DESC').all(botId) as { kind: string; detail: string }[]);
  const files = [...new Set(rows.filter((r) => r.kind === 'file').map((r) => r.detail))];
  const commands = [...new Set(rows.filter((r) => r.kind === 'command').map((r) => r.detail))];
  const servers = [...new Set(rows.filter((r) => r.kind === 'server').map((r) => r.detail))];
  return {
    files: files.slice(0, 10), moreFiles: Math.max(0, files.length - 10),
    commands: commands.slice(0, 6), moreCommands: Math.max(0, commands.length - 6),
    servers: servers.slice(0, 6),
  };
}
