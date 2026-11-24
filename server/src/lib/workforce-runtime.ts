/**
 * SID workforce runtime — blueprint §1 and §6.
 * A catalog role is a template. Activation issues one SID. Work spawns a
 * disposable worker under that SID. Teardown destroys the worker, never the SID.
 * Client-supplied grant refs are not authority.
 */
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export type InstallationStatus = 'CREATED' | 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'ARCHIVED';
export type TaskStatus =
  | 'CREATED' | 'AUTHORIZED' | 'QUEUED' | 'LEASED' | 'RUNNING'
  | 'WAITING_APPROVAL' | 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'CANCELLED' | 'DENIED';
export type WorkerStatus = 'NOT_RUNNING' | 'SPAWNING' | 'ALIVE' | 'DRAINING' | 'TERMINATED' | 'CRASHED';

const SECRET_KEYS = ['bearer', 'token', 'private_key', 'cookie', 'api_key', 'client_secret', 'password'];

export class WorkforceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkforceError';
  }
}

export interface Installation {
  sid: string;
  tenantId: string;
  roleSlug: string;
  roleDigest: string;
  status: InstallationStatus;
}

export interface WorkforceTask {
  taskId: string;
  tenantId: string;
  sid: string;
  status: TaskStatus;
  intent: string;
  riskClass: string;
  leaseId: string | null;
  leaseEpoch: number | null;
  workerId: string | null;
  idempotencyKey: string;
  uncertainReason: string | null;
}

function id(prefix: string) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function containsSecretMaterial(value: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_KEYS.some((needle) => key.toLowerCase().includes(needle)) && child) return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(value);
}

export function validateTeamPackage(pkg: Record<string, unknown>) {
  if (pkg.schema !== 'workforce.team-package/1.0') throw new WorkforceError('schema', 'team package schema mismatch');
  if (containsSecretMaterial(pkg)) throw new WorkforceError('secrets_forbidden', 'team package must not carry secrets or grants');
  if (!Array.isArray(pkg.roles) || pkg.roles.length === 0) throw new WorkforceError('roles', 'team package needs roles');
  return { ok: true as const, schema: pkg.schema };
}

export function validateComputerLease(lease: Record<string, unknown>) {
  if (lease.schema && lease.schema !== 'computer.lease/1.0') throw new WorkforceError('schema', 'computer lease schema mismatch');
  const control = lease.user_takeover_state;
  if (control !== 'preview' && control !== 'control' && control !== 'consent-required') {
    throw new WorkforceError('takeover', 'computer lease must distinguish preview from control');
  }
  if (lease.provider === 'host-desktop' && control !== 'consent-required') {
    throw new WorkforceError('consent', 'host desktop requires explicit local consent');
  }
  return { ok: true as const, previewOnly: control === 'preview' };
}

export function validateVoiceSession(session: Record<string, unknown>) {
  if (session.schema !== 'voice.session/1.0') throw new WorkforceError('schema', 'voice session schema mismatch');
  if (session.recording_consent !== true && session.recording_consent !== false) {
    throw new WorkforceError('consent', 'recording consent must be explicit');
  }
  return {
    ok: true as const,
    highRiskNeedsConfirm: true,
    provider: String(session.provider_id ?? 'local'),
  };
}

export function authorizeVoiceEffect(session: { highRisk?: boolean; confirmed?: boolean }) {
  if (session.highRisk && !session.confirmed) {
    return { allowed: false, code: 'voice_confirmation_required' as const };
  }
  return { allowed: true, code: 'ok' as const };
}

export function validateOauthBinding(binding: Record<string, unknown>, actingSid: string) {
  if (binding.schema !== 'provider.oauth-binding/1.0') throw new WorkforceError('schema', 'oauth binding schema mismatch');
  const allowed = Array.isArray(binding.sid_allowed) ? binding.sid_allowed.map(String) : [];
  if (!allowed.includes(actingSid)) {
    return { allowed: false, code: 'sid_not_bound' as const };
  }
  if (binding.revocation_status === 'revoked') return { allowed: false, code: 'revoked' as const };
  return { allowed: true, code: 'ok' as const };
}

export function driverCall(driver: { protocol?: string }, method: string) {
  const supported = new Set(['probe', 'createSession', 'startTurn', 'interrupt', 'closeSession']);
  if (driver.protocol !== 'hermes-native' && driver.protocol !== 'acp') {
    return { ok: false, code: 'UNSUPPORTED', method };
  }
  if (!supported.has(method)) return { ok: false, code: 'UNSUPPORTED', method };
  return { ok: true, code: 'ok', method };
}

export class WorkforceRuntime {
  constructor(private readonly db: Database.Database) {}

  activateRole(input: { tenantId: string; roleSlug: string; roleDigest: string; sid?: string }): Installation {
    if (!/^[a-f0-9]{64}$/.test(input.roleDigest)) throw new WorkforceError('digest', 'role digest must be sha256 hex');
    const sid = input.sid ?? `sid_${input.roleSlug.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${randomBytes(3).toString('hex')}`;
    const existing = this.db.prepare('SELECT sid, status FROM workforce_installations WHERE sid=?').get(sid) as { sid: string; status: string } | undefined;
    if (existing) throw new WorkforceError('sid_exists', 'activating a template must not mint a second SID for the same principal');
    this.db.prepare('INSERT INTO workforce_installations(sid,tenant_id,role_slug,role_digest,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(sid, input.tenantId, input.roleSlug, input.roleDigest, 'ACTIVE', Date.now());
    return this.installation(sid);
  }

  installation(sid: string): Installation {
    const row = this.db.prepare('SELECT sid, tenant_id, role_slug, role_digest, status FROM workforce_installations WHERE sid=?').get(sid) as any;
    if (!row) throw new WorkforceError('sid_missing', 'SID not found');
    return { sid: row.sid, tenantId: row.tenant_id, roleSlug: row.role_slug, roleDigest: row.role_digest, status: row.status };
  }

  assignTask(input: { tenantId: string; sid: string; intent: string; riskClass: string; idempotencyKey: string; externalEffect?: boolean }): WorkforceTask {
    const inst = this.installation(input.sid);
    if (inst.tenantId !== input.tenantId) throw new WorkforceError('tenant', 'SID tenant mismatch');
    if (inst.status !== 'ACTIVE') throw new WorkforceError('sid_inactive', `SID is ${inst.status}`);
    const prior = this.db.prepare('SELECT task_id FROM workforce_tasks WHERE idempotency_key=?').get(input.idempotencyKey) as { task_id: string } | undefined;
    if (prior) return this.task(prior.task_id);
    const taskId = id('task');
    const status: TaskStatus = input.riskClass === 'EXTERNAL_EFFECT' ? 'DENIED' : 'AUTHORIZED';
    this.db.prepare(`INSERT INTO workforce_tasks(task_id,tenant_id,sid,status,intent,risk_class,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(taskId, input.tenantId, input.sid, status, input.intent, input.riskClass, input.idempotencyKey, Date.now(), Date.now());
    if (status === 'DENIED') return this.task(taskId);
    return this.leaseAndSpawn(taskId, Boolean(input.externalEffect));
  }

  private leaseAndSpawn(taskId: string, externalEffect: boolean): WorkforceTask {
    const leaseId = id('lease');
    const workerId = id('worker');
    const now = Date.now();
    this.db.prepare(`UPDATE workforce_tasks SET status='RUNNING', lease_id=?, lease_epoch=1, worker_id=?, updated_at=? WHERE task_id=?`)
      .run(leaseId, workerId, now, taskId);
    this.db.prepare('INSERT INTO workforce_workers(worker_id,sid,task_id,status,backend,created_at) VALUES (?,?,?,?,?,?)')
      .run(workerId, this.task(taskId).sid, taskId, 'ALIVE', 'in-process', now);
    if (externalEffect) return this.markUncertain(taskId, 'external effect has no provider receipt');
    return this.task(taskId);
  }

  task(taskId: string): WorkforceTask {
    const row = this.db.prepare('SELECT * FROM workforce_tasks WHERE task_id=?').get(taskId) as any;
    if (!row) throw new WorkforceError('task_missing', 'task not found');
    return {
      taskId: row.task_id, tenantId: row.tenant_id, sid: row.sid, status: row.status, intent: row.intent,
      riskClass: row.risk_class, leaseId: row.lease_id, leaseEpoch: row.lease_epoch, workerId: row.worker_id,
      idempotencyKey: row.idempotency_key, uncertainReason: row.uncertain_reason,
    };
  }

  markUncertain(taskId: string, reason: string): WorkforceTask {
    this.db.prepare(`UPDATE workforce_tasks SET status='UNCERTAIN', uncertain_reason=?, updated_at=? WHERE task_id=?`).run(reason, Date.now(), taskId);
    const task = this.task(taskId);
    if (task.workerId) this.db.prepare(`UPDATE workforce_workers SET status='CRASHED' WHERE worker_id=?`).run(task.workerId);
    return this.task(taskId);
  }

  crashWorker(taskId: string): WorkforceTask {
    return this.markUncertain(taskId, 'beam crash: lease expired, no blind retry');
  }

  teardown(taskId: string, outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' = 'SUCCEEDED'): { task: WorkforceTask; sid: Installation } {
    const before = this.task(taskId);
    if (before.status === 'UNCERTAIN') throw new WorkforceError('uncertain', 'uncertain external effect cannot be marked succeeded');
    const now = Date.now();
    this.db.prepare(`UPDATE workforce_tasks SET status=?, updated_at=? WHERE task_id=?`).run(outcome, now, taskId);
    if (before.workerId) {
      this.db.prepare(`UPDATE workforce_workers SET status='TERMINATED', terminated_at=? WHERE worker_id=?`).run(now, before.workerId);
    }
    const sid = this.installation(before.sid);
    if (sid.status !== 'ACTIVE') throw new WorkforceError('sid_destroyed', 'teardown must not destroy the SID');
    return { task: this.task(taskId), sid };
  }

  resume(sid: string, intent: string): WorkforceTask {
    const inst = this.installation(sid);
    if (inst.status !== 'ACTIVE') throw new WorkforceError('sid_inactive', 'cannot resume a revoked SID');
    return this.assignTask({ tenantId: inst.tenantId, sid, intent, riskClass: 'READ_DRAFT', idempotencyKey: digest(`${sid}:${intent}:${Date.now()}`) });
  }
}

export function ensureWorkforceSchema(db: Database.Database) {
  db.exec(`
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
);`);
}

export function openWorkforce(db: Database.Database) {
  ensureWorkforceSchema(db);
  return new WorkforceRuntime(db);
}
