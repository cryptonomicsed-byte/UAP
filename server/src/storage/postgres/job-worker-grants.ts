import type { Pool, PoolClient } from 'pg';

const WORKER_FUNCTION_NAMES = [
  'claim_task_job',
  'heartbeat_task_job',
  'settle_task_job',
  'request_task_approval',
  'consume_task_approval',
  'claim_job_outbox',
  'mark_job_outbox_published',
  'release_job_outbox',
  'job_outbox_state',
] as const;

interface WorkerFunction {
  oid: number;
  name: string;
  identity: string;
  security_definer: boolean;
  owner_oid: number;
  configuration: string[] | null;
  volatility: string;
}
export class UnsafeJobWorkerRoleError extends Error {
  readonly code = 'unsafe_job_worker_role';

  constructor() {
    super('Job execution requires a separate direct login with only the approved durable-transition functions and no table, ownership, session, metadata, or elevated privileges.');
    this.name = 'UnsafeJobWorkerRoleError';
  }
}
function quoteRole(role: string): string {
  if (typeof role !== 'string' || !role || role.includes('\0') || Buffer.byteLength(role, 'utf8') > 63) {
    throw new UnsafeJobWorkerRoleError();
  }
  return `"${role.replaceAll('"', '""')}"`;
}

async function workerFunctions(client: PoolClient): Promise<WorkerFunction[]> {
  const result = await client.query<WorkerFunction>(`
    SELECT function.oid::int AS oid,
      function.proname AS name,
      format('%I.%I(%s)', namespace.nspname, function.proname, pg_get_function_identity_arguments(function.oid)) AS identity,
      function.prosecdef AS security_definer,
      function.proowner::int AS owner_oid,
      function.proconfig AS configuration,
      function.provolatile AS volatility
    FROM pg_proc AS function
    JOIN pg_namespace AS namespace ON namespace.oid=function.pronamespace
    WHERE namespace.nspname='uap' AND function.proname=ANY($1::text[])
    ORDER BY function.proname,function.oid`, [WORKER_FUNCTION_NAMES]);
  if (result.rows.length !== WORKER_FUNCTION_NAMES.length ||
      new Set(result.rows.map(row => row.name)).size !== WORKER_FUNCTION_NAMES.length ||
      result.rows.some(row => !WORKER_FUNCTION_NAMES.includes(row.name as typeof WORKER_FUNCTION_NAMES[number]) ||
        !row.security_definer || row.volatility !== 'v' ||
        !row.configuration?.includes('row_security=on') ||
        !row.configuration?.includes('search_path=pg_catalog, uap'))) {
    throw new UnsafeJobWorkerRoleError();
  }
  return result.rows;
}

async function roleIsUnsafe(
  client: PoolClient,
  roleName: string,
  allowedFunctions: readonly WorkerFunction[],
  requireWorkerGrants: boolean,
): Promise<boolean> {
  const functionOids = allowedFunctions.map(fn => fn.oid);
  const result = await client.query<{ unsafe: boolean }>(`
    SELECT (
      NOT role.rolcanlogin OR role.rolinherit OR role.rolsuper OR role.rolbypassrls
      OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication
      OR EXISTS (
        SELECT 1 FROM pg_roles AS candidate
        WHERE pg_has_role(role.oid,candidate.oid,'MEMBER') AND (
          candidate.rolsuper OR candidate.rolbypassrls OR candidate.rolcreaterole
          OR candidate.rolcreatedb OR candidate.rolreplication
          OR has_schema_privilege(candidate.oid,'uap','CREATE')
          OR EXISTS (
            SELECT 1 FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='uap' AND relation.relkind IN ('r','p','v','m','f')
              AND has_table_privilege(candidate.oid,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          )
          OR EXISTS (
            SELECT 1 FROM pg_class AS sequence
            JOIN pg_namespace AS namespace ON namespace.oid=sequence.relnamespace
            WHERE namespace.nspname='uap' AND sequence.relkind='S'
              AND CASE WHEN sequence.relkind='S'
                THEN has_sequence_privilege(candidate.oid,sequence.oid,'USAGE,SELECT,UPDATE') ELSE false END
          )
          OR EXISTS (
            SELECT 1 FROM pg_proc AS function
            JOIN pg_namespace AS namespace ON namespace.oid=function.pronamespace
            WHERE namespace.nspname='uap' AND function.oid <> ALL($2::oid[])
              AND has_function_privilege(candidate.oid,function.oid,'EXECUTE')
          )
        )
      )
      OR EXISTS (
        SELECT 1 FROM pg_database
        WHERE datname=current_database() AND pg_has_role(role.oid,datdba,'MEMBER')
      )
      OR EXISTS (
        SELECT 1 FROM pg_namespace
        WHERE nspname='uap' AND pg_has_role(role.oid,nspowner,'MEMBER')
      )
      OR EXISTS (
        SELECT 1 FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='uap' AND pg_has_role(role.oid,relation.relowner,'MEMBER')
      )
      OR EXISTS (
        SELECT 1 FROM pg_proc AS function
        JOIN pg_namespace AS namespace ON namespace.oid=function.pronamespace
        WHERE namespace.nspname='uap' AND pg_has_role(role.oid,function.proowner,'MEMBER')
      )
      OR ($3::boolean AND (
        NOT has_schema_privilege(role.oid,'uap','USAGE')
        OR EXISTS (
          SELECT 1 FROM unnest($2::oid[]) AS allowed(oid)
          WHERE NOT has_function_privilege(role.oid,allowed.oid,'EXECUTE')
        )
      ))
    ) AS unsafe
    FROM pg_roles AS role WHERE role.rolname=$1`, [roleName, functionOids, requireWorkerGrants]);
  return result.rows.length !== 1 || result.rows[0].unsafe !== false;
}

/** Recheck every worker operation so privilege drift cannot broaden execution authority. */
export async function assertJobWorkerRole(client: PoolClient): Promise<void> {
  const identity = await client.query<{ name: string; direct: boolean }>(
    'SELECT current_user AS name,current_user=session_user AS direct',
  );
  if (identity.rows.length !== 1 || !identity.rows[0].direct) throw new UnsafeJobWorkerRoleError();
  const functions = await workerFunctions(client);
  if (await roleIsUnsafe(client, identity.rows[0].name, functions, true)) throw new UnsafeJobWorkerRoleError();
}

/** Operator-only grant to an existing isolated worker login. It never creates identities. */
export async function grantJobWorkerRole(pool: Pool, role: string): Promise<void> {
  const quoted = quoteRole(role);
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET LOCAL standard_conforming_strings=on");
    const functions = await workerFunctions(client);
    // Reject inherited/direct authority before revoking anything. Provisioning is
    // not a privilege-cleanup mechanism for a previously broad service account.
    if (await roleIsUnsafe(client, role, functions, false)) throw new UnsafeJobWorkerRoleError();
    await client.query(`REVOKE ALL ON SCHEMA uap FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA uap FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA uap FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA uap FROM ${quoted}`);
    await client.query(`GRANT USAGE ON SCHEMA uap TO ${quoted}`);
    for (const fn of functions) await client.query(`GRANT EXECUTE ON FUNCTION ${fn.identity} TO ${quoted}`);
    if (await roleIsUnsafe(client, role, functions, true)) throw new UnsafeJobWorkerRoleError();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { discard = true; });
    throw error;
  } finally {
    client.release(discard);
  }
}
// End of worker grant implementation.
