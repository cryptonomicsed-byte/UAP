// Real SQLite migration/upgrade tests. Synthetic migration SQL is confined to these fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function fixture(script) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-sqlite-migrations-'));
  const preamble = `
    import assert from 'node:assert/strict';
    import Database from 'better-sqlite3';
    import path from 'node:path';
    import { applySqliteMigrations, SQLITE_MIGRATIONS } from './server/src/storage/sqlite-migrations.ts';
    const file = path.join(process.env.FIXTURE_ROOT, 'database.sqlite');
    let db = new Database(file);
    db.pragma('foreign_keys = ON');
    const ledger = () => db.prepare('SELECT * FROM application_schema_migrations ORDER BY id').all();
    const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  `;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', preamble + script], {
      cwd: root,
      env: { ...process.env, FIXTURE_ROOT: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('connector cleanup removes only entries whose agent no longer exists', async () => {
  await fixture(`
    applySqliteMigrations(db, SQLITE_MIGRATIONS.slice(0, 20));
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner','owner@example.test','Owner',1);
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('kept','owner','Kept',1,1);
    const add = db.prepare("INSERT INTO bot_mcp_servers(id,bot_id,name,url,headers_json,created_at,updated_at) VALUES (?,?,'example','https://example.invalid/mcp','{}',1,1)");
    add.run('retained','kept');
    add.run('orphaned','gone');
    applySqliteMigrations(db);
    assert.deepEqual(db.prepare('SELECT id FROM bot_mcp_servers').all(), [{ id: 'retained' }]);
    db.close();
  `);
});

test('fresh SQLite migrations create the full application schema and remain unchanged on restart', { timeout: 15000 }, async () => {
  await fixture(`
    applySqliteMigrations(db);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ['users','auth_sessions','login_attempts','computers','screens','bots','rows','llm_items','pending_turns','approvals','policies','routines','tasks','memories','skills','composio_sessions','memory_jobs','compactions','proactivity','deployment_binding']) assert.ok(tables.has(name), 'missing table ' + name);
    const botColumns = new Set(db.prepare('PRAGMA table_info(bots)').all().map(row => row.name));
    for (const column of ['voice','voice_speed','voice_language','model','provider','engine','engine_port','handback_at','kind','members','parent_bot_id','hidden']) assert.ok(botColumns.has(column), 'missing agent column ' + column);
    const routineColumns = new Set(db.prepare('PRAGMA table_info(routines)').all().map(row => row.name));
    assert.ok(routineColumns.has('trigger_id'));
    assert.ok(routineColumns.has('trigger_config'));
    const before = ledger();
    assert.equal(before.length, SQLITE_MIGRATIONS.length);
    for (const row of before) assert.match(row.checksum, /^[a-f0-9]{64}$/);
    const beforeSchema = schema();
    db.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    applySqliteMigrations(db);
    assert.deepEqual(ledger(), before, 'rerunning migrations must not rewrite version/checksum/time evidence');
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
  `);
});

test('legacy accounts, agents, and transcript bytes survive the versioned SQLite upgrade', { timeout: 15000 }, async () => {
  await fixture(`
    db.exec(\`CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,avatar_url TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE bots (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',instructions TEXT NOT NULL DEFAULT '',avatar_shape TEXT NOT NULL DEFAULT 'blob',avatar_color TEXT NOT NULL DEFAULT 'blue',mode TEXT NOT NULL DEFAULT 'personal',is_primary INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,effort TEXT NOT NULL DEFAULT 'medium',generation INTEGER NOT NULL DEFAULT 1,next_seq INTEGER NOT NULL DEFAULT 1,rev INTEGER NOT NULL DEFAULT 0,unread INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE rows (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,generation INTEGER NOT NULL,seq INTEGER NOT NULL,updated_seq INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,generation,seq));\`);
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('legacy-user','owner@example.test','Náme',123);
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('legacy-agent','legacy-user','Legacy',124,125);
    const transcript = '{"type":"message","role":"user","text":"Preserve § and diacritics: țâé"}';
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run('legacy-agent',1,1,1,'message',transcript,126);
    const beforeUser = db.prepare('SELECT * FROM users').get();
    const beforeRows = db.prepare('SELECT * FROM rows').all();
    applySqliteMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(), beforeUser);
    assert.deepEqual(db.prepare('SELECT * FROM rows').all(), beforeRows);
    const agent = db.prepare('SELECT * FROM bots').get();
    assert.equal(agent.id, 'legacy-agent');
    assert.equal(agent.user_id, 'legacy-user');
    assert.equal(agent.created_at, 124);
    assert.equal(agent.voice, 'luna');
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.hidden, 0);
    assert.equal(ledger().length, SQLITE_MIGRATIONS.length);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
  `);
});

test('changing an applied SQLite migration fails without rewriting its evidence or data', { timeout: 15000 }, async () => {
  await fixture(`
    applySqliteMigrations(db);
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('keep','keep@example.test','Keep',1);
    const before = ledger();
    const beforeSchema = schema();
    const changed = SQLITE_MIGRATIONS.map((migration, index) => index === 0 ? { ...migration, sql: migration.sql + '\\n-- changed applied SQL' } : migration);
    assert.throws(() => applySqliteMigrations(db, changed), /checksum|changed|modified|mismatch/i);
    assert.deepEqual(ledger(), before);
    assert.deepEqual(schema(), beforeSchema);
    assert.equal(db.prepare('SELECT id FROM users').get().id, 'keep');
    db.close();
  `);
});

test('unknown newer SQLite migration evidence blocks an older application', { timeout: 15000 }, async () => {
  await fixture(`
    applySqliteMigrations(db);
    const future = SQLITE_MIGRATIONS.at(-1).id + 99;
    db.prepare('INSERT INTO application_schema_migrations(id,name,checksum,applied_at) VALUES (?,?,?,?)').run(future,'future release','0'.repeat(64),Date.now());
    const before = ledger();
    const beforeSchema = schema();
    assert.throws(() => applySqliteMigrations(db), /unknown|newer|unrecognized|unsupported|not present|not available/i);
    assert.deepEqual(ledger(), before);
    assert.deepEqual(schema(), beforeSchema);
    db.close();
  `);
});

test('out-of-order and duplicate SQLite migration definitions are rejected before application', { timeout: 15000 }, async () => {
  await fixture(`
    const definitions = [
      { id: 2, name: 'two', sql: 'CREATE TABLE should_not_exist(id INTEGER)' },
      { id: 1, name: 'one', sql: 'CREATE TABLE also_absent(id INTEGER)' },
    ];
    assert.throws(() => applySqliteMigrations(db, definitions), /order|ascending|sequence|migration/i);
    assert.deepEqual(schema(), []);
    assert.throws(() => applySqliteMigrations(db, [definitions[1], definitions[1]]), /duplicate|order|ascending|sequence|migration/i);
    assert.deepEqual(schema(), []);
    db.close();
  `);
});

test('a failed later migration rolls back the full pending batch including schema and ledger writes', { timeout: 15000 }, async () => {
  await fixture(`
    db.exec('CREATE TABLE retained(id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO retained VALUES (?,?)').run('original','unchanged');
    const beforeSchema = schema();
    const definitions = [
      { id: 1, name: 'first successful step', sql: "CREATE TABLE pending(id INTEGER); INSERT INTO retained VALUES ('pending', 'must rollback');" },
      { id: 2, name: 'interrupted step', sql: 'ALTER TABLE missing_table ADD COLUMN value TEXT' },
    ];
    assert.throws(() => applySqliteMigrations(db, definitions), /missing_table|no such table/i);
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(db.prepare('SELECT * FROM retained').all(), [{ id: 'original', value: 'unchanged' }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='application_schema_migrations'").get().count, 0);
    db.close();
  `);
});

test('a malformed legacy schema is not falsely marked as a successful migration', { timeout: 15000 }, async () => {
  await fixture(`
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL)');
    db.prepare('INSERT INTO users(id,email,name) VALUES (?,?,?)').run('keep','keep@example.test','Keep');
    const beforeSchema = schema();
    assert.throws(() => applySqliteMigrations(db), /users|schema|column|created_at/i);
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), [{id:'keep',email:'keep@example.test',name:'Keep'}]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='application_schema_migrations'").get().count, 0);
    db.close();
  `);
});

test('a failed upgrade preserves previously committed migrations and rolls back only its pending batch', { timeout: 15000 }, async () => {
  await fixture(`
    const first = { id: 1, name: 'installed release', sql: 'CREATE TABLE retained(id TEXT PRIMARY KEY, value TEXT NOT NULL)' };
    applySqliteMigrations(db, [first]);
    db.prepare('INSERT INTO retained VALUES (?,?)').run('original','unchanged');
    const beforeLedger = ledger();
    const beforeSchema = schema();
    const upgrade = [first,
      { id: 2, name: 'new release column', sql: "ALTER TABLE retained ADD COLUMN extra TEXT; INSERT INTO retained(id,value) VALUES ('pending','must rollback');" },
      { id: 3, name: 'broken release step', sql: 'INSERT INTO absent_table VALUES (1)' },
    ];
    assert.throws(() => applySqliteMigrations(db, upgrade), /absent_table|no such table/i);
    assert.deepEqual(ledger(), beforeLedger);
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(db.prepare('SELECT * FROM retained').all(), [{id:'original',value:'unchanged'}]);
    db.close();
  `);
});

test('a legacy schema missing required email uniqueness is rejected without changing its rows', { timeout: 15000 }, async () => {
  await fixture(`
    const baseline = SQLITE_MIGRATIONS[0].sql.replace('email TEXT UNIQUE NOT NULL', 'email TEXT NOT NULL');
    assert.notEqual(baseline, SQLITE_MIGRATIONS[0].sql);
    db.exec(baseline);
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner','owner@example.test','Owner',1);
    const beforeSchema = schema();
    const beforeUsers = db.prepare('SELECT * FROM users').all();
    assert.throws(() => applySqliteMigrations(db), /schema|unique|index|users/i);
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), beforeUsers);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='application_schema_migrations'").get().count, 0);
    db.close();
  `);
});

test('a changed legacy agent visibility default is rejected rather than recorded as a compatible upgrade', { timeout: 15000 }, async () => {
  await fixture(`
    let changed = false;
    // This legacy snapshot predates migration 19, whose raw ADD COLUMN cannot be replayed.
    const legacy = SQLITE_MIGRATIONS.slice(0, 18).map(migration => ({
      ...migration,
      columns: migration.columns?.map(column => {
        if (column.table !== 'bots' || column.name !== 'hidden') return column;
        changed = true;
        return { ...column, definition: column.definition.replace('DEFAULT 0', 'DEFAULT 1') };
      }),
    }));
    assert.equal(changed, true);
    applySqliteMigrations(db, legacy);
    db.exec('DROP TABLE application_schema_migrations');
    const beforeSchema = schema();
    assert.throws(() => applySqliteMigrations(db), /schema|default|hidden/i);
    assert.deepEqual(schema(), beforeSchema);
    assert.equal(db.prepare('PRAGMA table_info(bots)').all().find(column => column.name === 'hidden').dflt_value, '1');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='application_schema_migrations'").get().count, 0);
    db.close();
  `);
});


test('a migration cannot escape the runner transaction or attach another database', { timeout: 15000 }, async () => {
  await fixture(`
    db.exec('CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO retained VALUES (?,?)').run(1,'keep');
    const beforeSchema = schema();
    for (const sql of [
      "INSERT INTO retained VALUES (2,'must not persist'); COMMIT;",
      "-- comment\\n END TRANSACTION; DELETE FROM retained;",
      "ATTACH DATABASE ':memory:' AS extra;",
      "PRAGMA writable_schema = ON;",
    ]) {
      assert.throws(() => applySqliteMigrations(db, [{id:1,name:'unsafe',sql}]), /transaction|connection/i);
      assert.deepEqual(schema(), beforeSchema);
      assert.deepEqual(db.prepare('SELECT * FROM retained').all(), [{id:1,value:'keep'}]);
    }
    // Keywords and semicolons inside actual SQL values/quoted identifiers are data.
    applySqliteMigrations(db, [{id:1,name:'quoted data',sql: "CREATE TABLE quoted(\\"commit\\" TEXT); INSERT INTO quoted VALUES ('text; COMMIT; it''s data');"}]);
    assert.equal(db.prepare('SELECT * FROM quoted').get().commit, "text; COMMIT; it's data");
    db.close();
  `);
});


test('a legacy foreign-key violation blocks migration without repairing or dropping its rows', { timeout: 15000 }, async () => {
  await fixture(`
    db.pragma('foreign_keys = OFF');
    db.exec(SQLITE_MIGRATIONS[0].sql);
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('orphan-agent','missing-owner','Keep for repair',1,1);
    db.pragma('foreign_keys = ON');
    const beforeSchema = schema();
    const beforeAgents = db.prepare('SELECT * FROM bots').all();
    assert.throws(() => applySqliteMigrations(db), /foreign key|legacy data/i);
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(db.prepare('SELECT * FROM bots').all(), beforeAgents);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='application_schema_migrations'").get().count, 0);
    db.close();
  `);
});
