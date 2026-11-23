/**
 * Deletion / privacy requests (V6-04-10).
 *
 * A request is a plan over data holders, executed fail-closed:
 *  - every content holder must prove its target is gone (`purged`) or was already gone (`absent`);
 *  - audit evidence is retained only under a named rule in {@link EVIDENCE_RETENTION_RULES},
 *    and the retention is recorded and receipted — never a silent skip;
 *  - a holder that throws leaves the request `partial` with the error; nothing claims completion;
 *  - a completed request is idempotent, and its HMAC receipt chains to the previous receipt for
 *    the same agent, so rewriting a target row breaks verification.
 *
 * Receipts and tombstones are intentionally not foreign-keyed to agents or accounts: the proof
 * that erasure happened must outlive the subject.
 */
import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { isBotBusy } from '../agent/loop.js';
import { getLive } from '../store.js';
import { defaultHolders, type DeletionHolder, type DeletionSubject, type TargetDraft } from './holders.js';

export type DeletionBasis = 'user_request' | 'consent_withdrawal' | 'retention_expiry';
export type DeletionState = 'pending' | 'running' | 'partial' | 'completed';
export type TargetAction = 'purge' | 'retain_exception';
export type TargetState = 'planned' | 'done' | 'retained' | 'failed' | 'absent';

export const DELETION_BASES: readonly DeletionBasis[] = ['user_request', 'consent_withdrawal', 'retention_expiry'];

/** Rules that permit keeping content-free audit evidence after erasure. */
export const EVIDENCE_RETENTION_RULES: Readonly<Record<string, string>> = {
  'audit:approval_history': 'Privileged-tool approval decisions are audit evidence; they store the tool and outcome, not message text or arguments.',
};

export class PrivacyDeletionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PrivacyDeletionError';
  }
}

export interface DeletionTarget {
  holder: string;
  ref: string;
  contentHash: string | null;
  action: TargetAction;
  state: TargetState;
  exceptionRule: string | null;
  detail: string | null;
}

export interface DeletionRequest {
  id: string;
  tenantId: string;
  botId: string;
  basis: DeletionBasis;
  requestKey: string | null;
  state: DeletionState;
  requestedBy: string;
  requestedAt: number;
  completedAt: number | null;
  attempts: number;
  lastError: string | null;
  receiptHash: string | null;
  prevReceiptHash: string | null;
  targets: DeletionTarget[];
}

type RequestRow = {
  id: string; tenant_id: string; subject_bot_id: string; basis: DeletionBasis; request_key: string | null;
  state: DeletionState; requested_by: string; requested_at: number; completed_at: number | null;
  attempts: number; last_error: string | null; receipt_hash: string | null; prev_receipt_hash: string | null;
};
type TargetRow = {
  holder: string; target_ref: string; content_hash: string | null; action: TargetAction;
  state: TargetState; exception_rule: string | null; detail: string | null;
};

const toTarget = (row: TargetRow): DeletionTarget => ({
  holder: row.holder, ref: row.target_ref, contentHash: row.content_hash, action: row.action,
  state: row.state, exceptionRule: row.exception_rule, detail: row.detail,
});

const toRequest = (row: RequestRow, targets: DeletionTarget[]): DeletionRequest => ({
  id: row.id, tenantId: row.tenant_id, botId: row.subject_bot_id, basis: row.basis,
  requestKey: row.request_key, state: row.state, requestedBy: row.requested_by,
  requestedAt: row.requested_at, completedAt: row.completed_at, attempts: row.attempts,
  lastError: row.last_error, receiptHash: row.receipt_hash, prevReceiptHash: row.prev_receipt_hash,
  targets,
});

function targetsFor(requestId: string): DeletionTarget[] {
  return (db.prepare(`SELECT holder,target_ref,content_hash,action,state,exception_rule,detail
    FROM privacy_deletion_targets WHERE request_id=? ORDER BY holder,target_ref`).all(requestId) as TargetRow[]).map(toTarget);
}

export function getDeletionRequest(id: string): DeletionRequest | null {
  const row = db.prepare('SELECT * FROM privacy_deletion_requests WHERE id=?').get(id) as RequestRow | undefined;
  return row ? toRequest(row, targetsFor(id)) : null;
}

export function listDeletionRequests(tenantId: string, botId?: string): DeletionRequest[] {
  const rows = (botId
    ? db.prepare('SELECT * FROM privacy_deletion_requests WHERE tenant_id=? AND subject_bot_id=? ORDER BY requested_at DESC, rowid DESC').all(tenantId, botId)
    : db.prepare('SELECT * FROM privacy_deletion_requests WHERE tenant_id=? ORDER BY requested_at DESC, rowid DESC').all(tenantId)) as RequestRow[];
  return rows.map((row) => toRequest(row, targetsFor(row.id)));
}

/** Strict, order-stable JSON so a receipt commits to exactly what happened. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function receiptFor(request: Pick<DeletionRequest, 'id' | 'tenantId' | 'botId' | 'basis' | 'requestedAt' | 'completedAt' | 'prevReceiptHash'>, targets: DeletionTarget[]): string {
  const payload = {
    v: 1,
    request: {
      id: request.id, tenantId: request.tenantId, botId: request.botId, basis: request.basis,
      requestedAt: request.requestedAt, completedAt: request.completedAt,
    },
    prev: request.prevReceiptHash ?? null,
    targets: targets.map((target) => ({
      holder: target.holder, ref: target.ref, contentHash: target.contentHash, action: target.action,
      state: target.state, exceptionRule: target.exceptionRule,
    })),
  };
  return crypto.createHmac('sha256', env.sessionSecret).update(canonical(payload)).digest('hex');
}

export interface DeletionRequestInput {
  tenantId: string;
  botId: string;
  basis: string;
  requestedBy: string;
  /** Idempotency key: the same key returns the same request and never a different subject's. */
  requestKey?: string;
}

/**
 * Plan a deletion: validate the subject, discover every holder's targets and persist the plan.
 * Discovery failing means no request is created — a request is a promise the engine can keep.
 */
export async function requestDeletion(
  input: DeletionRequestInput,
  options: { holders?: readonly DeletionHolder[] } = {},
): Promise<DeletionRequest> {
  if (!DELETION_BASES.includes(input.basis as DeletionBasis)) {
    throw new PrivacyDeletionError('invalid_basis', `Unknown deletion basis: ${input.basis}`);
  }
  const subject: DeletionSubject = { tenantId: input.tenantId, botId: input.botId };
  const bot = db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').get(input.botId, input.tenantId);
  if (!bot) throw new PrivacyDeletionError('subject_not_found', 'No agent with that id belongs to this tenant.');

  if (input.requestKey) {
    const existing = db.prepare('SELECT * FROM privacy_deletion_requests WHERE tenant_id=? AND request_key=?')
      .get(input.tenantId, input.requestKey) as RequestRow | undefined;
    if (existing) {
      if (existing.subject_bot_id !== input.botId || existing.basis !== input.basis) {
        throw new PrivacyDeletionError('request_key_conflict', 'That request key already belongs to a different deletion request.');
      }
      return toRequest(existing, targetsFor(existing.id));
    }
  }

  const holders = options.holders ?? defaultHolders;
  const plans: { holder: DeletionHolder; draft: TargetDraft }[] = [];
  const seen = new Set<string>();
  for (const holder of holders) {
    for (const draft of await holder.discover(subject)) {
      if (draft.exceptionRule) {
        if (!EVIDENCE_RETENTION_RULES[draft.exceptionRule]) {
          throw new PrivacyDeletionError('retention_rule_unknown', `Holder ${holder.name} cited an unknown retention rule: ${draft.exceptionRule}`);
        }
        if (holder.kind !== 'evidence') {
          throw new PrivacyDeletionError('invalid_plan', `Content holder ${holder.name} may not retain a target.`);
        }
      } else if (holder.kind === 'evidence') {
        throw new PrivacyDeletionError('retention_rule_missing', `Evidence holder ${holder.name} did not name a retention rule.`);
      }
      const key = `${holder.name}\u0000${draft.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push({ holder, draft });
    }
  }

  const id = newId('privacy');
  const requestedAt = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO privacy_deletion_requests
      (id,tenant_id,subject_bot_id,basis,request_key,state,requested_by,requested_at)
      VALUES (?,?,?,?,?, 'pending',?,?)`)
      .run(id, input.tenantId, input.botId, input.basis, input.requestKey ?? null, input.requestedBy, requestedAt);
    const insert = db.prepare(`INSERT INTO privacy_deletion_targets
      (request_id,holder,target_ref,content_hash,action,state,exception_rule,detail,updated_at)
      VALUES (?,?,?,?,?,'planned',?,?,?)`);
    for (const { holder, draft } of plans) {
      insert.run(id, holder.name, draft.ref, draft.contentHash ?? null,
        draft.exceptionRule ? 'retain_exception' : 'purge', draft.exceptionRule ?? null, draft.detail ?? null, requestedAt);
    }
  })();
  return getDeletionRequest(id)!;
}

export interface DeletionRunOptions {
  holders?: readonly DeletionHolder[];
  /** Override the quiescence check (defaults to the agent's serial queue + live state). */
  isBusy?: (botId: string) => boolean;
}

/** Execute (or resume) a request. Safe on a completed request; never marks partial work complete. */
export async function runDeletion(requestId: string, options: DeletionRunOptions = {}): Promise<DeletionRequest> {
  const request = getDeletionRequest(requestId);
  if (!request) throw new PrivacyDeletionError('request_not_found', 'No deletion request with that id.');
  if (request.state === 'completed') return request;
  // Erasing files while a turn is writing them would either lose the erasure or corrupt the turn.
  const busy = options.isBusy ?? ((botId: string) => isBotBusy(botId) || getLive(botId).isRunning);
  if (busy(request.botId)) {
    throw new PrivacyDeletionError('agent_busy', 'The agent is running. Stop it, then retry the deletion request.');
  }

  db.prepare("UPDATE privacy_deletion_requests SET state='running', attempts=attempts+1, last_error=NULL WHERE id=?").run(requestId);
  const holders = new Map((options.holders ?? defaultHolders).map((holder) => [holder.name, holder]));
  const subject: DeletionSubject = { tenantId: request.tenantId, botId: request.botId };
  const setState = db.prepare('UPDATE privacy_deletion_targets SET state=?, updated_at=? WHERE request_id=? AND holder=? AND target_ref=?');
  const failures: string[] = [];

  for (const target of targetsFor(requestId)) {
    if (target.state === 'done' || target.state === 'retained' || target.state === 'absent') continue;
    const holder = holders.get(target.holder);
    try {
      if (!holder) throw new Error(`no holder registered for ${target.holder}`);
      if (target.action === 'retain_exception') {
        if (!holder.retain) throw new Error(`holder ${holder.name} cannot retain evidence`);
        const outcome = await holder.retain(target, subject);
        if (outcome !== 'retained' && outcome !== 'absent') throw new Error(`holder ${holder.name} returned an unknown retention outcome`);
        setState.run(outcome, now(), requestId, target.holder, target.ref);
      } else {
        if (!holder.purge) throw new Error(`holder ${holder.name} cannot purge`);
        const outcome = await holder.purge(target, subject, { requestId });
        if (outcome !== 'purged' && outcome !== 'absent') throw new Error(`holder ${holder.name} returned an unknown purge outcome`);
        setState.run(outcome === 'purged' ? 'done' : 'absent', now(), requestId, target.holder, target.ref);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${target.holder}:${target.ref}: ${message}`);
      setState.run('failed', now(), requestId, target.holder, target.ref);
    }
  }

  const targets = targetsFor(requestId);
  if (failures.length) {
    db.prepare("UPDATE privacy_deletion_requests SET state='partial', last_error=? WHERE id=?").run(failures.join('; ').slice(0, 2000), requestId);
    return getDeletionRequest(requestId)!;
  }
  if (targets.some((target) => target.state === 'planned' || target.state === 'failed')) {
    db.prepare("UPDATE privacy_deletion_requests SET state='partial', last_error=? WHERE id=?")
      .run('Not every target reached a terminal state.', requestId);
    return getDeletionRequest(requestId)!;
  }

  const completedAt = request.completedAt ?? now();
  const previous = db.prepare(`SELECT receipt_hash FROM privacy_deletion_requests
    WHERE tenant_id=? AND subject_bot_id=? AND state='completed' AND receipt_hash IS NOT NULL AND id<>?
    ORDER BY completed_at DESC, rowid DESC LIMIT 1`).get(request.tenantId, request.botId, requestId) as { receipt_hash: string } | undefined;
  const final = { ...request, completedAt, prevReceiptHash: previous?.receipt_hash ?? null };
  const receipt = receiptFor(final, targets);
  db.prepare("UPDATE privacy_deletion_requests SET state='completed', completed_at=?, prev_receipt_hash=?, receipt_hash=?, last_error=NULL WHERE id=?")
    .run(completedAt, final.prevReceiptHash, receipt, requestId);
  return getDeletionRequest(requestId)!;
}

/** Recompute the HMAC receipt from the stored request and targets; any rewrite breaks it. */
export function verifyDeletionReceipt(requestId: string): boolean {
  const request = getDeletionRequest(requestId);
  if (!request || request.state !== 'completed' || !request.receiptHash || request.completedAt === null) return false;
  const expected = receiptFor(request, request.targets);
  const stored = Buffer.from(request.receiptHash, 'hex');
  const computed = Buffer.from(expected, 'hex');
  return stored.length === computed.length && crypto.timingSafeEqual(stored, computed);
}
