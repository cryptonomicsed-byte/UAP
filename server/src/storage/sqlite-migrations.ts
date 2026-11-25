import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export interface SqliteColumnMigration { table: string; name: string; definition: string }
export interface SqliteMigration {
  id: number;
  name: string;
  sql: string;
  columns?: readonly SqliteColumnMigration[];
}

/** Append migrations; never edit a manifest that has been applied to an installation. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  { id: 1, name: 'baseline', sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  provisional_user_id TEXT NOT NULL,
  connected_account_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  orgo_id TEXT,
  status TEXT NOT NULL DEFAULT 'absent',
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL DEFAULT 'blob',
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  mode TEXT NOT NULL DEFAULT 'personal',
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT 'medium',
  generation INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
CREATE TABLE IF NOT EXISTS llm_items (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation, idx)
);
CREATE TABLE IF NOT EXISTS pending_turns (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  row_seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS policies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, tool)
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS composio_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL
);
` },
  { id: 2, name: 'agent-runtime-and-screen-metadata', sql: '', columns: [
    { table: 'bots', name: 'voice', definition: "TEXT NOT NULL DEFAULT 'luna'" },
    { table: 'bots', name: 'voice_speed', definition: 'REAL NOT NULL DEFAULT 1' },
    { table: 'bots', name: 'voice_language', definition: "TEXT NOT NULL DEFAULT 'auto'" },
    { table: 'bots', name: 'model', definition: 'TEXT' },
    { table: 'bots', name: 'provider', definition: 'TEXT' },
    { table: 'bots', name: 'engine', definition: 'TEXT' },
    { table: 'bots', name: 'engine_port', definition: 'INTEGER' },
    { table: 'bots', name: 'handback_at', definition: 'INTEGER' },
    { table: 'screens', name: 'width', definition: 'INTEGER' },
    { table: 'screens', name: 'height', definition: 'INTEGER' },
  ] },
  { id: 3, name: 'settings-and-memory-history', columns: [
    { table: 'skills', name: 'description', definition: "TEXT NOT NULL DEFAULT ''" },
    { table: 'skills', name: 'updated_at', definition: 'INTEGER' },
    { table: 'memories', name: 'source', definition: "TEXT NOT NULL DEFAULT 'chat'" },
  ], sql: `
CREATE TABLE IF NOT EXISTS memory_jobs (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_consolidated_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  method TEXT NOT NULL,
  items_before INTEGER NOT NULL,
  items_after INTEGER NOT NULL,
  chars_before INTEGER NOT NULL,
  chars_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);` },
  { id: 4, name: 'rooms-and-subagents', sql: '', columns: [
    { table: 'bots', name: 'kind', definition: "TEXT NOT NULL DEFAULT 'agent'" },
    { table: 'bots', name: 'members', definition: 'TEXT' },
    { table: 'bots', name: 'parent_bot_id', definition: 'TEXT' },
    { table: 'bots', name: 'hidden', definition: 'INTEGER NOT NULL DEFAULT 0' },
  ] },
  { id: 5, name: 'proactive-checkins-and-event-triggers', columns: [
    { table: 'routines', name: 'trigger_id', definition: 'TEXT' },
    { table: 'routines', name: 'trigger_config', definition: 'TEXT' },
  ], sql: `
CREATE TABLE IF NOT EXISTS proactivity (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  times TEXT NOT NULL DEFAULT '["09:00","16:30"]',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  last_fired TEXT,
  silent_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);` },
  { id: 6, name: 'single-owner-and-primary-binding', sql: `
CREATE TABLE IF NOT EXISTS deployment_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_user_id TEXT UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  primary_bot_id TEXT UNIQUE
);` },
  // Privacy erasure propagates into the derived memory index and leaves content-free proof.
  // Receipts carry no foreign keys: deleting an agent (or an account) must not destroy the
  // evidence that a deletion was requested and carried out.
  { id: 7, name: 'privacy-deletion-and-memory-index', sql: `
CREATE TABLE IF NOT EXISTS privacy_deletion_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_bot_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('user_request','consent_withdrawal','retention_expiry')),
  request_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','partial','completed')),
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  receipt_hash TEXT,
  prev_receipt_hash TEXT,
  UNIQUE (tenant_id, request_key)
);
CREATE INDEX IF NOT EXISTS privacy_requests_subject
  ON privacy_deletion_requests(tenant_id, subject_bot_id, state);
CREATE TABLE IF NOT EXISTS privacy_deletion_targets (
  request_id TEXT NOT NULL REFERENCES privacy_deletion_requests(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  content_hash TEXT,
  action TEXT NOT NULL CHECK (action IN ('purge','retain_exception')),
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','done','retained','failed','absent')),
  exception_rule TEXT,
  detail TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, holder, target_ref),
  CHECK ((action = 'retain_exception') = (exception_rule IS NOT NULL)),
  CHECK (state <> 'retained' OR action = 'retain_exception')
);
CREATE TABLE IF NOT EXISTS privacy_tombstones (
  bot_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, content_hash)
);
CREATE TABLE IF NOT EXISTS memory_index_sources (
  memory_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_index_sources_bot ON memory_index_sources(bot_id);
CREATE TABLE IF NOT EXISTS memory_index (
  memory_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  term TEXT NOT NULL,
  PRIMARY KEY (memory_id, term)
);
CREATE INDEX IF NOT EXISTS memory_index_lookup ON memory_index(bot_id, term);
` },
  // Hermes adapter lifecycle (V6-07-07): a conversation thread belongs to the issued SID
  // that owns the agent. Nullable: an agent bound before SID issuance keeps its legacy
  // bot-id thread until an operator binds it (server/src/agent/hermes-adapter.ts).
  { id: 8, name: 'hermes-adapter-sid-binding', sql: '', columns: [
    { table: 'bots', name: 'sid', definition: 'TEXT' },
  ] },
  // One SID is one agent instance: two live agents may not claim the same identity.
  { id: 9, name: 'hermes-adapter-sid-unique', sql: `
CREATE UNIQUE INDEX IF NOT EXISTS bots_sid_unique ON bots(sid) WHERE sid IS NOT NULL;` },
  // Policy authorization (V6-07-03): one row per model-proposed tool intent, allowed or
  // refused, with the kernel's stable reason code. Nullable digests stay null when the
  // bundle never reached the kernel (policy-unavailable): a missing digest must not look
  // like a verified one.
  { id: 10, name: 'policy-tool-intent-decisions', sql: `
CREATE TABLE IF NOT EXISTS policy_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  sid TEXT NOT NULL,
  tool TEXT NOT NULL,
  effect TEXT NOT NULL,
  risk TEXT NOT NULL,
  decision TEXT NOT NULL,
  code TEXT NOT NULL,
  intent_digest TEXT,
  params_digest TEXT,
  permit_id TEXT,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_decisions_bot ON policy_decisions(bot_id, at_ms);
CREATE INDEX IF NOT EXISTS policy_decisions_code ON policy_decisions(code);` },
  { id: 11, name: 'sid-workforce-ledger', sql: `
CREATE TABLE IF NOT EXISTS workforce_installations (
  sid TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role_slug TEXT NOT NULL,
  role_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workforce_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sid TEXT NOT NULL,
  status TEXT NOT NULL,
  intent TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  lease_id TEXT,
  lease_epoch INTEGER,
  worker_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  uncertain_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workforce_workers (
  worker_id TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  backend TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  terminated_at INTEGER
);` },
  { id: 12, name: 'tickets-and-fallback-and-grants', sql: `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  owner_bot_id TEXT, status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'normal',
  comments TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);
CREATE TABLE IF NOT EXISTS agent_fallback_chain (
  bot_id TEXT NOT NULL, step INTEGER NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, login_key TEXT NOT NULL,
  PRIMARY KEY (bot_id, step)
);
CREATE TABLE IF NOT EXISTS agent_login_rest (
  login_key TEXT PRIMARY KEY, reason TEXT NOT NULL, until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_fallback_ledger (
  bot_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS standing_grants (
  bot_id TEXT NOT NULL, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, config_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, server_id, tool_name)
);` },
  { id: 13, name: 'bot-theme', sql: `
CREATE TABLE IF NOT EXISTS bot_theme (bot_id TEXT PRIMARY KEY, css TEXT NOT NULL, updated_at INTEGER NOT NULL);` },
  { id: 14, name: 'channel-turn-events', sql: `
CREATE TABLE IF NOT EXISTS channel_turn_events (channel_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS channel_turn_events_channel ON channel_turn_events(channel_id, at);` },
  { id: 15, name: 'pack-installs', sql: `
CREATE TABLE IF NOT EXISTS pack_installs (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL,
  specialist_id TEXT NOT NULL, skill_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_installs_bot ON pack_installs(bot_id);` },
  { id: 16, name: 'bot-mcp-servers', sql: `
CREATE TABLE IF NOT EXISTS bot_mcp_servers (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_mcp_servers_bot ON bot_mcp_servers(bot_id);` },
  { id: 17, name: 'nostr-identities', sql: `
CREATE TABLE IF NOT EXISTS nostr_identities (
  bot_id TEXT PRIMARY KEY, npub TEXT NOT NULL UNIQUE, pubkey_hex TEXT NOT NULL,
  nsec_path TEXT NOT NULL, created_at INTEGER NOT NULL
);` },
];

export class SqliteMigrationError extends Error {
  constructor(message: string) { super(message); this.name = 'SqliteMigrationError'; }
}

type ColumnInfo = { name: string; type: string; notnull: number; pk: number; dflt_value: string | null };
type ForeignKeyInfo = { table: string; from: string; to: string; on_update: string; on_delete: string; match: string; seq: number };
type IndexInfo = { name: string; unique: number; partial: number };
type IndexColumn = { seqno: number; cid: number; name: string | null };
type LedgerRow = { id: number; name: string; checksum: string; applied_at: number };
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const defaultValue = (value: string | null) => value === null ? null : value.trim();

function indexes(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as IndexInfo[]).map(index => {
    const columns = db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as IndexColumn[];
    return JSON.stringify([index.unique, index.partial, columns.map(column => column.name)]);
  });
}

function checksum(migration: SqliteMigration): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: migration.id, name: migration.name, sql: migration.sql, columns: migration.columns ?? [],
  })).digest('hex');
}

/** Keep transaction/connection control with the runner, never an individual manifest. */
function validateSql(sql: string): void {
  let bare = '';
  for (let i = 0; i < sql.length; i++) {
    const current = sql[i];
    if (current === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      bare += ' ';
    } else if (current === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      bare += ' ';
    } else if (current === "'" || current === '"' || current === '`' || current === '[') {
      const end = current === '[' ? ']' : current;
      for (i++; i < sql.length; i++) {
        if (sql[i] !== end) continue;
        if (current !== '[' && sql[i + 1] === end) { i++; continue; }
        break;
      }
      bare += ' ';
    } else bare += current;
  }
  // Trigger bodies require separate migration support: their BEGIN/END blocks are
  // intentionally outside this runner's plain transactional DDL/DML contract.
  if (bare.split(';').some(statement => /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM|PRAGMA)\b/i.test(statement))) {
    throw new SqliteMigrationError('SQLite migration SQL cannot control transactions or connection settings.');
  }
}

function validateManifests(migrations: readonly SqliteMigration[]) {
  const names = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    if (migration.id !== index + 1 || !migration.name || names.has(migration.name) || typeof migration.sql !== 'string') {
      throw new SqliteMigrationError('SQLite migrations must have consecutive ordered IDs starting at 1 and unique names.');
    }
    names.add(migration.name);
    validateSql(migration.sql);
    for (const column of migration.columns ?? []) {
      validateSql(column.definition);
      if (!identifier.test(column.table) || !identifier.test(column.name) || !column.definition.trim()) {
        throw new SqliteMigrationError('Invalid SQLite column migration manifest.');
      }
    }
  }
}

function applyManifest(db: Database.Database, migration: SqliteMigration) {
  if (migration.sql) db.exec(migration.sql);
  for (const column of migration.columns ?? []) {
    const existing = db.prepare(`PRAGMA table_info("${column.table}")`).all() as ColumnInfo[];
    if (!existing.length) throw new SqliteMigrationError(`SQLite schema table ${column.table} is missing.`);
    if (!existing.some(item => item.name === column.name)) {
      db.exec(`ALTER TABLE "${column.table}" ADD COLUMN "${column.name}" ${column.definition}`);
    }
  }
}

/** Verify required tables/columns/foreign keys, while retaining extension tables and columns. */
function validateSchema(db: Database.Database, migrations: readonly SqliteMigration[]) {
  const reference = new Database(':memory:');
  try {
    reference.pragma('foreign_keys = ON');
    for (const migration of migrations) applyManifest(reference, migration);
    const tables = reference.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      const expected = reference.prepare(`PRAGMA table_info("${name}")`).all() as ColumnInfo[];
      const actual = db.prepare(`PRAGMA table_info("${name}")`).all() as ColumnInfo[];
      for (const column of expected) {
        const found = actual.find(item => item.name === column.name);
        if (!found || found.type.toUpperCase() !== column.type.toUpperCase() || found.pk !== column.pk || found.notnull !== column.notnull || defaultValue(found.dflt_value) !== defaultValue(column.dflt_value)) {
          throw new SqliteMigrationError(`SQLite schema mismatch at ${name}.${column.name}; restore or review the legacy schema before retrying.`);
        }
      }
      const actualIndexes = indexes(db, name);
      for (const requiredIndex of indexes(reference, name)) {
        if (!actualIndexes.includes(requiredIndex)) throw new SqliteMigrationError(`SQLite schema index/uniqueness mismatch in ${name}; migration is blocked.`);
      }
      const requiredKeys = reference.prepare(`PRAGMA foreign_key_list("${name}")`).all() as ForeignKeyInfo[];
      const actualKeys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as ForeignKeyInfo[];
      const signature = (key: ForeignKeyInfo) => JSON.stringify([key.table, key.from, key.to, key.on_update, key.on_delete, key.match, key.seq]);
      for (const key of requiredKeys) {
        if (!actualKeys.some(candidate => signature(candidate) === signature(key))) {
          throw new SqliteMigrationError(`SQLite schema foreign key mismatch in ${name}; migration is blocked.`);
        }
      }
    }
  } finally { reference.close(); }
}

/** One exclusive writer transaction covers ledger validation and the entire pending upgrade. */
export function applySqliteMigrations(db: Database.Database, migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS): void {
  validateManifests(migrations);
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS application_schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`);
      const applied = db.prepare('SELECT id, name, checksum, applied_at FROM application_schema_migrations ORDER BY id').all() as LedgerRow[];
      if (applied.length > migrations.length) throw new SqliteMigrationError('SQLite schema has newer migrations than this application.');
      for (const [index, row] of applied.entries()) {
        const manifest = migrations[index];
        if (!manifest || row.id !== manifest.id) throw new SqliteMigrationError('SQLite migration order is inconsistent or newer than this application.');
        if (row.name !== manifest.name || row.checksum !== checksum(manifest)) {
          throw new SqliteMigrationError(`SQLite migration ${row.id} name/checksum mismatch; applied migrations must never be edited.`);
        }
      }
      const insert = db.prepare('INSERT INTO application_schema_migrations(id,name,checksum,applied_at) VALUES (?,?,?,?)');
      for (const migration of migrations.slice(applied.length)) {
        applyManifest(db, migration);
        insert.run(migration.id, migration.name, checksum(migration), Date.now());
      }
      validateSchema(db, migrations);
      if ((db.pragma('foreign_key_check') as unknown[]).length) {
        throw new SqliteMigrationError('SQLite legacy data violates foreign keys; migration is blocked without deleting or repairing rows.');
      }
    }).immediate();
  } catch (error) {
    if (error instanceof SqliteMigrationError) throw error;
    throw new SqliteMigrationError(`SQLite migration failed; the pending upgrade was rolled back: ${error instanceof Error ? error.message : 'unknown database error'}`);
  }
}
