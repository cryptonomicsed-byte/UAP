import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_MIGRATIONS, type PostgresMigration } from './schema.js';
import { validatePostgresMigrationSql } from './sql-validation.js';

export interface PostgresMigrationRecord {
  id: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export class PostgresMigrationError extends Error {
  constructor(message: string) { super(message); this.name = 'PostgresMigrationError'; }
}

export function postgresMigrationChecksum(migration: PostgresMigration): string {
  return crypto.createHash('sha256').update(`${migration.id}\0${migration.name}\0${migration.sql}`).digest('hex');
}

function validateDefinitions(migrations: readonly PostgresMigration[]): void {
  const names = new Set<string>();
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1 || !migration.name.trim() || names.has(migration.name) || !migration.sql.trim()) {
      throw new PostgresMigrationError('PostgreSQL migration definitions must have contiguous positive IDs, unique names and nonempty SQL.');
    }
    try { validatePostgresMigrationSql(migration.sql); }
    catch { throw new PostgresMigrationError('PostgreSQL migration SQL cannot control transactions/connection settings or contain unterminated literals.'); }
    names.add(migration.name);
  });
}

async function ledger(client: PoolClient): Promise<PostgresMigrationRecord[]> {
  return (await client.query<PostgresMigrationRecord>('SELECT id, name, checksum, applied_at FROM uap.schema_migrations ORDER BY id')).rows;
}

/** Operator-only migrations. One transaction and lock cover the entire pending batch. */
export async function migratePostgres(pool: Pool, migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS): Promise<{ applied: number[]; currentVersion: number }> {
  validateDefinitions(migrations);
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'; SET LOCAL standard_conforming_strings = on");
    await client.query('SELECT pg_advisory_xact_lock(21442, 1)');
    await client.query('CREATE SCHEMA IF NOT EXISTS uap');
    await client.query(`CREATE TABLE IF NOT EXISTS uap.schema_migrations (
      id integer PRIMARY KEY CHECK (id > 0),
      name text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await client.query('REVOKE ALL ON uap.schema_migrations FROM PUBLIC');
    const records = await ledger(client);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const expected = migrations[index];
      if (!expected || record.id !== expected.id || record.name !== expected.name || record.checksum !== postgresMigrationChecksum(expected)) {
        throw new PostgresMigrationError('PostgreSQL migration history is missing, unknown or has a changed checksum; no migration was applied.');
      }
    }
    if (!records.length) {
      const relations = await client.query<{ name: string }>(`SELECT class.relname AS name FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname='uap' AND class.relkind IN ('r','p','v','m','f') AND class.relname <> 'schema_migrations'`);
      if (relations.rowCount) throw new PostgresMigrationError('An unversioned uap schema already contains relations; explicit migration/recovery is required.');
    }
    const applied: number[] = [];
    for (const migration of migrations.slice(records.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO uap.schema_migrations(id,name,checksum) VALUES ($1,$2,$3)', [migration.id, migration.name, postgresMigrationChecksum(migration)]);
      applied.push(migration.id);
    }
    await client.query('COMMIT');
    return { applied, currentVersion: migrations.at(-1)?.id ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { discardClient = true; });
    throw error;
  } finally { client.release(discardClient); }
}

/** Read-only status; an absent ledger is reported as no applied migrations. */
export async function migrationStatus(pool: Pool): Promise<PostgresMigrationRecord[]> {
  const exists = await pool.query<{ name: string | null }>("SELECT to_regclass('uap.schema_migrations')::text AS name");
  if (!exists.rows[0]?.name) return [];
  return (await pool.query<PostgresMigrationRecord>('SELECT id,name,checksum,applied_at FROM uap.schema_migrations ORDER BY id')).rows;
}

function quoteRole(role: string): string {
  if (!role || role.includes('\0') || Buffer.byteLength(role, 'utf8') > 63) throw new PostgresMigrationError('Invalid PostgreSQL application role name.');
  return `"${role.replace(/"/g, '""')}"`;
}

/** Grant only the implemented metadata operations. Enrollment/team administration remain operator-only. */
export async function grantApplicationRole(pool: Pool, role: string): Promise<void> {
  const quoted = quoteRole(role);
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'; SET LOCAL standard_conforming_strings = on");
    const roles = await client.query<{ oid: number; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>(
      'SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=$1', [role]);
    const application = roles.rows[0];
    if (!application || application.rolsuper || application.rolbypassrls || application.rolcreaterole || application.rolcreatedb || application.rolreplication) {
      throw new PostgresMigrationError('Application role must exist and must not have elevated database privileges.');
    }
    const privilegedMembership = await client.query(`SELECT 1 FROM pg_roles AS candidate
      WHERE (candidate.rolsuper OR candidate.rolbypassrls OR candidate.rolcreaterole OR candidate.rolcreatedb OR candidate.rolreplication)
        AND pg_has_role($1::oid,candidate.oid,'MEMBER') LIMIT 1`, [application.oid]);
    const ownership = await client.query(`SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='uap' AND pg_has_role($1::oid,relation.relowner,'MEMBER')
      UNION ALL SELECT 1 FROM pg_namespace WHERE nspname='uap' AND pg_has_role($1::oid,nspowner,'MEMBER')
      UNION ALL SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role($1::oid,datdba,'MEMBER') LIMIT 1`, [application.oid]);
    if (privilegedMembership.rowCount || ownership.rowCount) throw new PostgresMigrationError('Application role must not inherit an elevated role or own the database or uap schema/tables.');
    const issuerRights = await client.query(`SELECT 1 FROM pg_roles candidate
      WHERE pg_has_role($1::oid,candidate.oid,'MEMBER') AND
        has_table_privilege(candidate.oid,'uap.auth_sessions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') LIMIT 1`, [application.oid]);
    if (issuerRights.rowCount) throw new PostgresMigrationError('Application role inherits unsupported schema/table privileges or session issuance rights; separate credentials are required.');
    const workerRights = await client.query(`SELECT 1 FROM pg_roles candidate
      WHERE pg_has_role($1::oid,candidate.oid,'MEMBER') AND EXISTS (
        SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
        WHERE namespace.nspname='uap'
          AND function.proname<>ALL(ARRAY['has_org_role','authenticate_session','revoke_session','enqueue_task_job','request_task_job_cancellation','resolve_task_approval','issue_sid_instance','record_sid_model_selection','register_sid_issuer','set_sid_issuer_status','record_sid_credential','revoke_sid_identity','request_sid_transfer','accept_sid_transfer'])
          AND has_function_privilege(candidate.oid,function.oid,'EXECUTE')
      ) LIMIT 1`, [application.oid]);
    if (workerRights.rowCount) throw new PostgresMigrationError('Application role must not inherit job-worker execution authority; separate credentials are required.');
    const applicationFunctions = await client.query<{ identity: string; secure: boolean }>(`SELECT
        format('%I.%I(%s)',namespace.nspname,function.proname,pg_get_function_identity_arguments(function.oid)) AS identity,
        function.prosecdef AND function.provolatile='v'
          AND function.proconfig @> ARRAY['search_path=pg_catalog, uap','row_security=on']::text[] AS secure
      FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
      WHERE namespace.nspname='uap'
        AND function.proname=ANY(ARRAY['enqueue_task_job','request_task_job_cancellation','resolve_task_approval','issue_sid_instance','record_sid_model_selection','register_sid_issuer','set_sid_issuer_status','record_sid_credential','revoke_sid_identity','request_sid_transfer','accept_sid_transfer'])
      ORDER BY function.proname,function.oid`);
    if (applicationFunctions.rows.length !== 11 || applicationFunctions.rows.some(fn => !fn.secure)) {
      throw new PostgresMigrationError('Durable task transition functions are missing or unsafe; apply verified migrations before granting the application role.');
    }
    await client.query(`REVOKE ALL ON SCHEMA uap FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA uap FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA uap FROM ${quoted}`);
    await client.query(`GRANT USAGE ON SCHEMA uap TO ${quoted}`);
    await client.query(`GRANT SELECT ON uap.users,uap.organizations,uap.memberships,uap.workspaces,uap.agents,uap.import_receipts,uap.history_import_receipts TO ${quoted}`);
    await client.query(`GRANT INSERT,UPDATE,DELETE ON uap.workspaces,uap.agents TO ${quoted}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON uap.conversations,uap.message_rows TO ${quoted}`);
    await client.query(`GRANT SELECT,INSERT ON uap.llm_items TO ${quoted}`);
    await client.query(`GRANT SELECT ON uap.tasks,uap.task_jobs,uap.agent_runs,uap.approvals,uap.job_events TO ${quoted}`);
    await client.query(`GRANT SELECT ON uap.sid_identities,uap.agent_installations,uap.hermes_model_selections,uap.role_template_versions,uap.sid_issuers,uap.sid_credentials,uap.sid_revocations,uap.sid_transfers TO ${quoted}`);
    await client.query(`GRANT EXECUTE ON FUNCTION uap.has_org_role(text,text[]),uap.authenticate_session(text),uap.revoke_session(text) TO ${quoted}`);
    for (const fn of applicationFunctions.rows) await client.query(`GRANT EXECUTE ON FUNCTION ${fn.identity} TO ${quoted}`);
    // Direct revocation does not remove privileges inherited from another role.
    // Reject such a configuration instead of pretending least privilege was set.
    const forbidden = await client.query(`SELECT 1 FROM pg_roles AS candidate
      WHERE pg_has_role($1::oid,candidate.oid,'MEMBER') AND (
      has_table_privilege(candidate.oid,'uap.schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.users','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.organizations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.memberships','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.import_receipts','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.workspaces','TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.agents','TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.conversations','DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.message_rows','DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.llm_items','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.auth_sessions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.history_import_receipts','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.tasks','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.task_jobs','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.agent_runs','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.approvals','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.job_events','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.sid_identities','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.agent_installations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.hermes_model_selections','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege(candidate.oid,'uap.role_template_versions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      EXISTS (
        SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
        WHERE namespace.nspname='uap'
          AND function.proname<>ALL(ARRAY['has_org_role','authenticate_session','revoke_session','enqueue_task_job','request_task_job_cancellation','resolve_task_approval','issue_sid_instance','record_sid_model_selection','register_sid_issuer','set_sid_issuer_status','record_sid_credential','revoke_sid_identity','request_sid_transfer','accept_sid_transfer'])
          AND has_function_privilege(candidate.oid,function.oid,'EXECUTE')
      ) OR
      has_schema_privilege(candidate.oid,'uap','CREATE')) LIMIT 1`, [application.oid]);
    if (forbidden.rowCount) throw new PostgresMigrationError('Application role inherits unsupported schema/table privileges; isolate it before granting access.');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { discardClient = true; });
    throw error;
  } finally { client.release(discardClient); }
}
