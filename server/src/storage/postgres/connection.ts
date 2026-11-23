import type { Pool, PoolClient } from 'pg';

export interface TenantScope { actorId: string; organizationId: string }

export class TenantAccessError extends Error {
  readonly code = 'tenant_access_denied';
  constructor() {
    super('An active membership with permission for this action is required.');
    this.name = 'TenantAccessError';
  }
}

export class UnsafeDatabaseRoleError extends Error {
  readonly code = 'unsafe_database_role';
  constructor() {
    super('Tenant queries require a direct application login without superuser, BYPASSRLS, schema creation, or migration-owner privileges.');
    this.name = 'UnsafeDatabaseRoleError';
  }
}

function validateScope(scope: TenantScope): void {
  if (!scope || ![scope.actorId, scope.organizationId].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !value.includes('\0'))) {
    throw new TenantAccessError();
  }
}

/** Do not let an administrative connection accidentally execute a tenant request. */
export async function assertApplicationRole(client: PoolClient): Promise<void> {
  const result = await client.query<{ unsafe: boolean }>(`
    SELECT (
      current_user <> session_user OR r.rolsuper OR r.rolbypassrls
      OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
      OR EXISTS (
        SELECT 1 FROM pg_roles candidate
        WHERE pg_has_role(current_user,candidate.oid,'MEMBER')
          AND (candidate.rolsuper OR candidate.rolbypassrls OR candidate.rolcreaterole OR candidate.rolcreatedb OR candidate.rolreplication
            OR has_table_privilege(candidate.oid,'uap.schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.users','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.organizations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.memberships','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.import_receipts','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.workspaces','TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.agents','TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.conversations','DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.message_rows','DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.llm_items','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.auth_sessions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.history_import_receipts','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.tasks','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.task_jobs','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.agent_runs','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.approvals','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.job_events','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.sid_identities','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.agent_installations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.hermes_model_selections','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_table_privilege(candidate.oid,'uap.role_template_versions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (
              SELECT 1 FROM pg_proc function
              JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
              WHERE namespace.nspname='uap'
                AND function.proname<>ALL(ARRAY['has_org_role','authenticate_session','revoke_session','enqueue_task_job','request_task_job_cancellation','resolve_task_approval','issue_sid_instance','record_sid_model_selection'])
                AND has_function_privilege(candidate.oid,function.oid,'EXECUTE')
            ))
      )
      OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'MEMBER'))
      OR has_schema_privilege(current_user, 'uap', 'CREATE')
      OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='uap' AND c.relkind IN ('r','p')
          AND pg_has_role(current_user, c.relowner, 'MEMBER')
      )
    ) AS unsafe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (result.rows.length !== 1 || result.rows[0].unsafe !== false) throw new UnsafeDatabaseRoleError();
}

/** Authentication uses a blank context until a valid opaque token resolves the actor. */
export async function withIdentity<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withContext(pool, null, work);
}

/** Scope comes from authenticated server identity, never from an object ID alone. */
export async function withTenant<T>(pool: Pool, scope: TenantScope, work: (client: PoolClient) => Promise<T>): Promise<T> {
  validateScope(scope);
  return withContext(pool, scope, work);
}

async function withContext<T>(pool: Pool, scope: TenantScope | null, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  let transaction = false;
  try {
    await client.query("SELECT set_config('uap.actor_id','',false), set_config('uap.organization_id','',false)");
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL search_path=pg_catalog,uap");
    await assertApplicationRole(client);
    if (scope) {
      await client.query("SELECT set_config('uap.actor_id',$1,true), set_config('uap.organization_id',$2,true)", [scope.actorId, scope.organizationId]);
      const membership = await client.query('SELECT role FROM uap.memberships WHERE organization_id=$1 AND user_id=$2 AND state=$3', [scope.organizationId, scope.actorId, 'active']);
      if (membership.rows.length !== 1) throw new TenantAccessError();
    }
    const result = await work(client);
    await client.query('COMMIT');
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === '42501') throw new TenantAccessError();
    throw error;
  } finally {
    if (!discard) {
      try { await client.query("SELECT set_config('uap.actor_id','',false), set_config('uap.organization_id','',false)"); }
      catch { discard = true; }
    }
    client.release(discard);
  }
}
