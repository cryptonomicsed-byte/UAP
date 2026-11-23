/**
 * SID lifecycle service (V6-04-09): pause, resume, archive.
 *
 * The database owns the state machine (`uap.apply_sid_lifecycle` behind
 * `uap.pause_sid_instance` / `uap.resume_sid_instance` / `uap.archive_sid_instance`)
 * so that the same rules apply to the HTTP API, the worker and an operator on
 * psql. This module validates the call shape, names the refusals and reads the
 * append-only lifecycle log back.
 *
 * There is no "delete" path here: archive is the end of service and a
 * replacement is a new SID with a lineage parent.
 */
import type { PoolClient } from 'pg';

export type SidStatus = 'active' | 'paused' | 'revoked' | 'archived';

export interface SidLifecycleScope {
  actorId: string;
  organizationId: string;
}

export interface SidLifecycleResult {
  sid: string;
  status: Extract<SidStatus, 'active' | 'paused' | 'archived'>;
  affectedInstallations: number;
}

export interface SidLifecycleEvent {
  seq: number;
  eventType: 'paused' | 'resumed' | 'archived';
  fromStatus: 'active' | 'paused' | 'archived';
  toStatus: 'active' | 'paused' | 'archived';
  reason: string;
  actorId: string;
  occurredAt: number;
}

export type SidLifecycleFailure =
  | 'tenant_forbidden'
  | 'sid_missing'
  | 'sid_revoked'
  | 'sid_archived'
  | 'sid_already_archived'
  | 'sid_not_active'
  | 'sid_not_paused'
  | 'input_invalid'
  | 'unknown';

export class SidLifecycleError extends Error {
  readonly code: SidLifecycleFailure;

  constructor(code: SidLifecycleFailure, message: string) {
    super(message);
    this.name = 'SidLifecycleError';
    this.code = code;
  }
}

const SID_RE = /^sid_[a-z0-9][a-z0-9_-]{0,62}$/;

const FAILURES: readonly SidLifecycleFailure[] = [
  'tenant_forbidden', 'sid_missing', 'sid_revoked', 'sid_archived', 'sid_already_archived',
  'sid_not_active', 'sid_not_paused', 'input_invalid',
];

function requireSid(value: unknown): string {
  if (typeof value !== 'string' || !SID_RE.test(value)) {
    throw new SidLifecycleError('input_invalid', 'sid must match sid_<slug>');
  }
  return value;
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 500) {
    throw new SidLifecycleError('input_invalid', 'reason must be between 3 and 500 characters');
  }
  return value;
}

/** Names a database refusal. An unrecognised error is rethrown, never flattened. */
function translate(error: unknown): never {
  if (error instanceof SidLifecycleError) throw error;
  const message = String((error as { message?: string } | null)?.message ?? '');
  const named = FAILURES.find(failure => message.includes(failure));
  if (named) throw new SidLifecycleError(named, message);
  const code = (error as { code?: string } | null)?.code;
  if (code === '42501') throw new SidLifecycleError('tenant_forbidden', 'lifecycle change is not permitted for this tenant');
  if (code === 'P0003') throw new SidLifecycleError('input_invalid', 'lifecycle input is invalid');
  if (code === 'P0002') throw new SidLifecycleError('sid_missing', 'no such SID in this tenant');
  throw error;
}

function mapResult(row: { sid: string; status: string; affected_installations: number }): SidLifecycleResult {
  return {
    sid: row.sid,
    status: row.status as SidLifecycleResult['status'],
    affectedInstallations: row.affected_installations,
  };
}

async function transition(
  client: PoolClient,
  organizationId: string,
  call: string,
  params: string[],
): Promise<SidLifecycleResult> {
  try {
    const result = await client.query<{ sid: string; status: string; affected_installations: number }>(call, params);
    const row = result.rows[0];
    if (!row) throw new SidLifecycleError('unknown', 'lifecycle transition returned no row');
    return mapResult(row);
  } catch (error) {
    translate(error);
  }
}

/** Stops new work for one agent. The SID, its hash and its installations stay. */
export async function pauseSid(
  client: PoolClient,
  scope: SidLifecycleScope,
  input: { sid: string; reason: string },
): Promise<SidLifecycleResult> {
  const sid = requireSid(input.sid);
  const reason = requireReason(input.reason);
  return transition(client, scope.organizationId, 'SELECT * FROM uap.pause_sid_instance($1,$2,$3)',
    [scope.organizationId, sid, reason]);
}

/** Returns a paused agent to service. Only a paused SID may resume. */
export async function resumeSid(
  client: PoolClient,
  scope: SidLifecycleScope,
  input: { sid: string },
): Promise<SidLifecycleResult> {
  const sid = requireSid(input.sid);
  return transition(client, scope.organizationId, 'SELECT * FROM uap.resume_sid_instance($1,$2)',
    [scope.organizationId, sid]);
}

/** Ends service for good: archived SIDs never resume, and live installations are retired. */
export async function archiveSid(
  client: PoolClient,
  scope: SidLifecycleScope,
  input: { sid: string; reason: string },
): Promise<SidLifecycleResult> {
  const sid = requireSid(input.sid);
  const reason = requireReason(input.reason);
  return transition(client, scope.organizationId, 'SELECT * FROM uap.archive_sid_instance($1,$2,$3)',
    [scope.organizationId, sid, reason]);
}

/** Reads the append-only transitions for one SID in the caller's tenant. */
export async function readSidLifecycle(
  client: PoolClient,
  scope: SidLifecycleScope,
  sid: string,
): Promise<SidLifecycleEvent[]> {
  const result = await client.query<{
    seq: number; event_type: SidLifecycleEvent['eventType']; from_status: SidLifecycleEvent['fromStatus'];
    to_status: SidLifecycleEvent['toStatus']; reason: string; actor_id: string; occurred_at: number;
  }>(
    `SELECT seq, event_type, from_status, to_status, reason, actor_id, occurred_at
     FROM uap.sid_lifecycle_events WHERE organization_id=$1 AND sid=$2 ORDER BY seq`,
    [scope.organizationId, requireSid(sid)],
  );
  return result.rows.map(row => ({
    seq: row.seq,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorId: row.actor_id,
    // int8 comes back as a string from pg; epoch milliseconds are exact in a JS number.
    occurredAt: Number(row.occurred_at),
  }));
}
