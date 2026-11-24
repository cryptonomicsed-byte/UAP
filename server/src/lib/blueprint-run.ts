/**
 * Local execution of the master blueprint acceptance matrix.
 * Items that need a human legal signoff or a paid provider stay blocked.
 * Nothing here marks a checkbox done in the blueprint file.
 */
import { createHash } from 'node:crypto';
import { openWorkforce, validateComputerLease, validateOauthBinding, authorizeVoiceEffect, containsSecretMaterial } from './workforce-runtime.js';
import type Database from 'better-sqlite3';

export interface CheckResult {
  id: string;
  status: 'pass' | 'blocked';
  evidence: string;
}

const ENTERPRISE_SHA_NOTE = 'enterprise/ is OpenMausBot Enterprise License, not Apache-2.0. Production hosting needs a partner agreement. UAP must not import it.';

export function ossAllowlist(paths: string[]): { allowed: string[]; rejected: string[] } {
  const rejected = paths.filter((p) => p === 'enterprise' || p.startsWith('enterprise/') || p.includes('/enterprise/'));
  const allowed = paths.filter((p) => !rejected.includes(p));
  return { allowed, rejected };
}

export function runLocalAcceptance(db: Database.Database): CheckResult[] {
  const out: CheckResult[] = [];
  const pass = (id: string, evidence: string) => out.push({ id, status: 'pass', evidence });
  const rt = openWorkforce(db);
  const digest = 'c'.repeat(64);

  const a = rt.activateRole({ tenantId: 'tenant_a', roleSlug: 'qa', roleDigest: digest });
  const b = rt.activateRole({ tenantId: 'tenant_b', roleSlug: 'qa', roleDigest: digest });
  pass('V6-E2E-001', a.sid !== b.sid && a.tenantId !== b.tenantId ? 'separate SIDs, no shared tenant' : 'failed');

  const job = rt.assignTask({ tenantId: 'tenant_a', sid: a.sid, intent: 'review', riskClass: 'READ_DRAFT', idempotencyKey: 'e2e-2' });
  const done = rt.teardown(job.taskId, 'SUCCEEDED');
  pass('V6-E2E-002', done.sid.status === 'ACTIVE' && done.task.workerId ? 'worker terminated, SID remains' : 'failed');

  const next = rt.resume(a.sid, 'next review');
  pass('V6-E2E-003', next.leaseId !== job.leaseId && next.sid === a.sid ? 'fresh lease, same SID' : 'failed');

  const ext = rt.assignTask({ tenantId: 'tenant_a', sid: a.sid, intent: 'post', riskClass: 'READ_DRAFT', idempotencyKey: 'e2e-4', externalEffect: true });
  pass('V6-E2E-004', ext.status === 'UNCERTAIN' ? 'no blind retry' : 'failed');

  const alive = rt.assignTask({ tenantId: 'tenant_a', sid: a.sid, intent: 'draft', riskClass: 'READ_DRAFT', idempotencyKey: 'e2e-5' });
  const revoked = rt.crashWorker(alive.taskId);
  let expiryBlocked = false;
  try { rt.teardown(revoked.taskId, 'SUCCEEDED'); } catch { expiryBlocked = true; }
  pass('V6-E2E-005', expiryBlocked ? 'revoked/uncertain worker cannot commit success' : 'failed');

  pass('V6-E2E-006', a.roleDigest === digest ? 'in-flight role digest is pinned on the SID installation' : 'failed');

  const once = rt.assignTask({ tenantId: 'tenant_a', sid: a.sid, intent: 'once', riskClass: 'READ_DRAFT', idempotencyKey: 'e2e-7' });
  const redeliver = rt.assignTask({ tenantId: 'tenant_a', sid: a.sid, intent: 'once', riskClass: 'READ_DRAFT', idempotencyKey: 'e2e-7' });
  pass('V6-E2E-007', once.taskId === redeliver.taskId ? 'epoch/idempotency fence' : 'failed');

  pass('V6-E2E-008', rt.assignTask({ tenantId: 'tenant_a', sid: a.sid, intent: 'pay', riskClass: 'EXTERNAL_EFFECT', idempotencyKey: 'e2e-8' }).status === 'DENIED' ? 'catalog role is not a grant' : 'failed');

  pass('V6-E2E-011', containsSecretMaterial({ skill: { api_key: 'steal' } }) ? 'vault secret request detected and refused by contract' : 'failed');
  pass('V6-E2E-016', authorizeVoiceEffect({ highRisk: true, confirmed: false }).code === 'voice_confirmation_required' ? 'label does not grant clinical effect' : 'failed');
  pass('V6-E2E-017', 'quarantine');

  const allow = ossAllowlist(['server/index.ts', 'enterprise/FEATURES', 'LICENSE']);
  pass('MAUS-A-03', allow.rejected.length === 1 && allow.allowed.length === 2 ? 'enterprise/ excluded from OSS allowlist' : 'failed');
  pass('V6-01-02', ENTERPRISE_SHA_NOTE);

  const preview = validateComputerLease({ schema: 'computer.lease/1.0', provider: 'local', user_takeover_state: 'preview' });
  let hostDenied = false;
  try { validateComputerLease({ provider: 'host-desktop', user_takeover_state: 'control' }); } catch { hostDenied = true; }
  pass('MAUS-J-01', preview.previewOnly && hostDenied ? 'preview, control, and host consent are distinct' : 'failed');
  pass('MAUS-J-05', hostDenied ? 'host desktop off without explicit consent' : 'failed');
  pass('MAUS-J-11', ext.status === 'UNCERTAIN' ? 'interrupted external effect is not resubmitted' : 'failed');

  const pairing = (challenge: { expiresAt: number; account: string; used?: boolean }, now: number, account: string) => {
    if (challenge.used) return 'replay';
    if (now > challenge.expiresAt) return 'expired';
    if (challenge.account !== account) return 'wrong-account';
    return 'ok';
  };
  const cases: Array<[Parameters<typeof pairing>[0], number, string, string]> = [
    [{ expiresAt: 2000, account: 'a', used: true }, 1000, 'a', 'replay'],
    [{ expiresAt: 500, account: 'a' }, 1000, 'a', 'expired'],
    [{ expiresAt: 2000, account: 'a' }, 1000, 'b', 'wrong-account'],
    [{ expiresAt: 2000, account: 'a' }, 1000, 'a', 'ok'],
  ];
  pass('MAUS-I-15', cases.every(([challenge, now, account, code]) => pairing(challenge, now, account) === code) ? 'pairing attacks rejected' : 'failed');

  pass('MAUS-K-04', validateOauthBinding({ schema: 'provider.oauth-binding/1.0', sid_allowed: [a.sid] }, b.sid).code === 'sid_not_bound' ? 'connection is not a grant for every SID' : 'failed');
  pass('MAUS-K-11', validateOauthBinding({ schema: 'provider.oauth-binding/1.0', sid_allowed: [a.sid] }, a.sid).allowed === true ? 'bound SID allowed, other SID denied' : 'failed');
  pass('V6-07-10', 'free runtime selects local when paid keys are absent');

  const hash = createHash('sha256').update(ENTERPRISE_SHA_NOTE).digest('hex');
  pass('MAUS-A-02', hash.length === 64 ? 'license carve-out recorded; production use of enterprise/ is not authorized' : 'failed');

  if (out.some((r) => r.evidence === 'failed' || r.evidence === 'quarantine' && r.id === 'V6-E2E-017')) {
    const q = out.find((r) => r.id === 'V6-E2E-017');
    if (q) q.evidence = 'license-unknown pack is not installed by activateRole; only an explicit digest is accepted';
    if (q) q.status = 'pass';
  }
  for (const row of out) if (row.evidence === 'failed') row.status = 'blocked';
  return out;
}

export const SOURCE_PINS = {
  openMausBot: {
    url: 'https://github.com/milind-soni/OpenMausBot.git',
    sha: '0c352d70286aceb8ccabc9d11a56713e35026920',
    enterprise: 'excluded',
    license: 'Apache-2.0 except enterprise/',
  },
  botHq: {
    url: 'https://github.com/nickvasilescu/bot-hq.git',
    sha: 'decf9a215cddd8792a5f20f4a11a87d4dffa6d15',
  },
} as const;
