import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  openWorkforce, validateTeamPackage, validateComputerLease, validateVoiceSession,
  authorizeVoiceEffect, validateOauthBinding, driverCall, containsSecretMaterial,
} from '../server/src/lib/workforce-runtime.ts';

function db() {
  return openWorkforce(new Database(':memory:'));
}

const DIGEST = 'a'.repeat(64);

test('activation issues one SID; teardown kills the worker not the principal', () => {
  const rt = db();
  const sid = rt.activateRole({ tenantId: 'tenant_a', roleSlug: 'motion-director', roleDigest: DIGEST });
  assert.equal(sid.status, 'ACTIVE');
  assert.throws(() => rt.activateRole({ tenantId: 'tenant_a', roleSlug: 'motion-director', roleDigest: DIGEST, sid: sid.sid }));
  const task = rt.assignTask({ tenantId: 'tenant_a', sid: sid.sid, intent: 'review', riskClass: 'READ_DRAFT', idempotencyKey: 'k1' });
  assert.equal(task.status, 'RUNNING');
  assert.ok(task.leaseId);
  const again = rt.assignTask({ tenantId: 'tenant_a', sid: sid.sid, intent: 'review', riskClass: 'READ_DRAFT', idempotencyKey: 'k1' });
  assert.equal(again.taskId, task.taskId);
  const done = rt.teardown(task.taskId, 'SUCCEEDED');
  assert.equal(done.task.status, 'SUCCEEDED');
  assert.equal(done.sid.status, 'ACTIVE');
  assert.equal(done.sid.sid, sid.sid);
});

test('crash is UNCERTAIN and cannot be marked succeeded', () => {
  const rt = db();
  const sid = rt.activateRole({ tenantId: 'tenant_a', roleSlug: 'guardian', roleDigest: DIGEST });
  const task = rt.assignTask({ tenantId: 'tenant_a', sid: sid.sid, intent: 'post', riskClass: 'READ_DRAFT', idempotencyKey: 'k2', externalEffect: true });
  assert.equal(task.status, 'UNCERTAIN');
  assert.throws(() => rt.teardown(task.taskId, 'SUCCEEDED'));
  const crashed = rt.assignTask({ tenantId: 'tenant_a', sid: sid.sid, intent: 'draft', riskClass: 'READ_DRAFT', idempotencyKey: 'k3' });
  assert.equal(rt.crashWorker(crashed.taskId).status, 'UNCERTAIN');
});

test('contracts reject secrets, silent desktop control, and unbound oauth', () => {
  assert.equal(containsSecretMaterial({ api_key: 'x' }), true);
  assert.throws(() => validateTeamPackage({ schema: 'workforce.team-package/1.0', roles: [{}], bearer: 'secret' }));
  assert.equal(validateTeamPackage({ schema: 'workforce.team-package/1.0', roles: [{ name: 'a' }] }).ok, true);
  assert.throws(() => validateComputerLease({ provider: 'host-desktop', user_takeover_state: 'control' }));
  assert.equal(validateComputerLease({ user_takeover_state: 'preview' }).previewOnly, true);
  assert.equal(authorizeVoiceEffect({ highRisk: true, confirmed: false }).allowed, false);
  assert.equal(validateOauthBinding({ schema: 'provider.oauth-binding/1.0', sid_allowed: ['sid_a'] }, 'sid_b').allowed, false);
  assert.equal(driverCall({ protocol: 'hermes-native' }, 'teleport').code, 'UNSUPPORTED');
  assert.equal(validateVoiceSession({ schema: 'voice.session/1.0', recording_consent: false, provider_id: 'local' }).provider, 'local');
});
