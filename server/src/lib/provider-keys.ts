/**
 * BYOK provider API keys: account-wide (not per-bot -- a key is a credential, a model
 * choice is per-bot). Write-only from every read-side API: callers get presence, never
 * the value. The engine (engine.ts writeHome) is the only consumer that reads the real key,
 * to put it into a managed bot's own private Hermes config.yaml.
 */
import type Database from 'better-sqlite3';
import { SUPPORTED_PROVIDERS, type SupportedProvider } from './model-catalog.js';

export function ensureProviderKeysSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_provider_keys (
    user_id TEXT NOT NULL, provider TEXT NOT NULL, api_key TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider)
  );`);
}

export class ProviderKeyError extends Error {}

export function setProviderKey(db: Database.Database, userId: string, provider: string, apiKey: string) {
  if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) throw new ProviderKeyError(`Unknown provider: ${provider}`);
  if (!apiKey.trim() || apiKey.length > 2000) throw new ProviderKeyError('Invalid API key');
  ensureProviderKeysSchema(db);
  db.prepare('INSERT INTO user_provider_keys(user_id, provider, api_key, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id, provider) DO UPDATE SET api_key = excluded.api_key, created_at = excluded.created_at')
    .run(userId, provider, apiKey.trim(), Date.now());
}

export function removeProviderKey(db: Database.Database, userId: string, provider: string) {
  ensureProviderKeysSchema(db);
  db.prepare('DELETE FROM user_provider_keys WHERE user_id = ? AND provider = ?').run(userId, provider);
}

/** Presence only -- booleans, never the key itself. Safe to return from any authed API. */
export function configuredProviders(db: Database.Database, userId: string): Record<string, boolean> {
  ensureProviderKeysSchema(db);
  const rows = db.prepare('SELECT provider FROM user_provider_keys WHERE user_id = ?').all(userId) as { provider: string }[];
  const have = new Set(rows.map((r) => r.provider));
  return Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [p, have.has(p)]));
}

/** The one real read path -- used only by engine.ts when materializing a bot's private
 *  config.yaml, never exposed over HTTP. */
export function providerKeyFor(db: Database.Database, userId: string, provider: string): string | null {
  ensureProviderKeysSchema(db);
  const row = db.prepare('SELECT api_key FROM user_provider_keys WHERE user_id = ? AND provider = ?').get(userId, provider) as { api_key: string } | undefined;
  return row?.api_key ?? null;
}
