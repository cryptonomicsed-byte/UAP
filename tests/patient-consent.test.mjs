import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConsentRegistry,
  evaluateExport,
  assertRevocationEffective,
  PATIENT_RETENTION_RULES,
} from '../server/src/lib/patient-consent.ts';

test('M-41 grant + access with matching purpose and scope', () => {
  const reg = new ConsentRegistry();
  const c = reg.grant({
    subjectId: 'pt-1',
    tenantId: 't1',
    purpose: 'research_secondary',
    scope: ['labs', 'notes'],
  });
  assert.equal(c.state, 'granted');
  assert.equal(c.encryption, 'required');
  const d = reg.evaluateAccess({
    subjectId: 'pt-1',
    tenantId: 't1',
    purpose: 'research_secondary',
    categories: ['labs'],
    actorId: 'researcher-1',
  });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresEncryption, true);
  assert.equal(d.consentId, c.id);
});

test('M-41 model training purpose always forbidden', () => {
  const reg = new ConsentRegistry();
  assert.throws(
    () => reg.grant({ subjectId: 'pt', tenantId: 't', purpose: 'model_training_excluded', scope: ['*'] }),
    (e) => e.code === 'consent_purpose_forbidden',
  );
  const d = reg.evaluateAccess({
    subjectId: 'pt',
    tenantId: 't',
    purpose: 'model_training_excluded',
    categories: ['notes'],
    actorId: 'model',
  });
  assert.equal(d.allowed, false);
  assert.ok(d.blockers.includes('purpose_forbidden_model_training'));
});

test('M-41 category outside scope denied', () => {
  const reg = new ConsentRegistry();
  reg.grant({ subjectId: 'pt', tenantId: 't', purpose: 'care_coordination', scope: ['labs'] });
  const d = reg.evaluateAccess({
    subjectId: 'pt',
    tenantId: 't',
    purpose: 'care_coordination',
    categories: ['imaging'],
    actorId: 'a',
  });
  assert.equal(d.allowed, false);
  assert.ok(d.blockers.includes('no_active_consent'));
});

test('M-41 revoke blocks subsequent access and export', () => {
  const reg = new ConsentRegistry();
  const c = reg.grant({
    subjectId: 'pt-2',
    tenantId: 't1',
    purpose: 'export_portability',
    scope: ['labs', 'notes'],
  });
  const before = evaluateExport(reg, { subjectId: 'pt-2', tenantId: 't1', categories: ['labs'] });
  assert.equal(before.allowed, true);
  assert.ok(before.payload?.encrypted);

  reg.revoke('pt-2', c.id);
  assertRevocationEffective(reg, 'pt-2', 't1', 'export_portability', ['labs']);
  const after = evaluateExport(reg, { subjectId: 'pt-2', tenantId: 't1', categories: ['labs'] });
  assert.equal(after.allowed, false);
});

test('M-41 expired consent denied', () => {
  const reg = new ConsentRegistry();
  reg.grant({
    subjectId: 'pt-3',
    tenantId: 't',
    purpose: 'analytics_deidentified',
    scope: ['*'],
    expiresAt: '2020-01-01T00:00:00.000Z',
  });
  const d = reg.evaluateAccess({
    subjectId: 'pt-3',
    tenantId: 't',
    purpose: 'analytics_deidentified',
    categories: ['labs'],
    actorId: 'a',
    at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(d.allowed, false);
});

test('M-41 retention rules are explicit named exceptions', () => {
  assert.ok(PATIENT_RETENTION_RULES.clinical_audit_meta);
});
