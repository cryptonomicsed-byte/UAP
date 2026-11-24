import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH_ROLES,
  auditCitations,
  evaluateResearchOutput,
  independentScienceGate,
  registerCitationFixture,
  roleDigest,
} from '../server/src/lib/research-gates.ts';

test('M-40 four research/medical roles published', () => {
  assert.equal(Object.keys(RESEARCH_ROLES).length, 4);
  assert.ok(RESEARCH_ROLES['evidence-investigator']);
  assert.ok(RESEARCH_ROLES['hypothesis-challenger']);
  assert.ok(RESEARCH_ROLES['citation-auditor']);
  assert.ok(RESEARCH_ROLES['medical-research-librarian']);
  assert.equal(RESEARCH_ROLES['medical-research-librarian'].riskClass, 'critical');
  assert.equal(roleDigest('citation-auditor').length, 64);
});

test('M-40 hallucinated citation rejected', () => {
  const r = auditCitations([
    { id: 'c1', title: 'Made Up', locator: '10.9999/not-real' },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => b.includes('unverified')));
});

test('M-40 fixture citation with matching support verifies', () => {
  registerCitationFixture('10.1000/m40', 'M40 Paper', ['exact span here']);
  const r = auditCitations([
    { id: 'c2', title: 'M40 Paper', locator: '10.1000/m40', supportSpan: 'exact span here' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.verified, ['c2']);
});

test('M-40 contested claim requires uncertainty + alternatives + citations', () => {
  const bad = evaluateResearchOutput({
    claim: 'X causes Y always',
    contested: true,
    citations: [],
    roleId: 'evidence-investigator',
  });
  assert.equal(bad.allowed, false);
  assert.ok(bad.blockers.includes('contested_requires_citations'));
  assert.ok(bad.blockers.includes('contested_requires_uncertainty'));
  assert.ok(bad.blockers.includes('contested_requires_alternatives'));

  registerCitationFixture('https://example.org/m40-ok', 'OK', ['s']);
  const good = evaluateResearchOutput({
    claim: 'X may associate with Y under Z',
    contested: true,
    citations: [{ id: 'c', title: 'OK', locator: 'https://example.org/m40-ok', supportSpan: 's' }],
    uncertainty: 'observational only; confounding likely',
    alternatives: ['reverse causation', 'common cause'],
    roleId: 'evidence-investigator',
  });
  assert.equal(good.allowed, true);
});

test('M-40 medical librarian refuses clinician credentials and diagnosis', () => {
  const id = evaluateResearchOutput({
    claim: "I'm a doctor and I diagnose you with X",
    contested: false,
    citations: [],
    roleId: 'medical-research-librarian',
  });
  assert.equal(id.allowed, false);
  assert.ok(id.blockers.some((b) => b.includes('clinician') || b.includes('clinical')));
});

test('M-40 model self-score cannot overwrite independent science gate', () => {
  const fail = independentScienceGate({
    citationAuditOk: false,
    researchEvalAllowed: true,
    modelSelfScore: 0.99,
  });
  assert.equal(fail.pass, false);
  assert.ok(fail.blockers.includes('citation_audit_failed'));

  const pass = independentScienceGate({
    citationAuditOk: true,
    researchEvalAllowed: true,
    modelSelfScore: 0.1,
  });
  assert.equal(pass.pass, true);
});

test('M-40 invented support phrase blocked', () => {
  const r = evaluateResearchOutput({
    claim: 'As proven in the nonexistent 2024 mega-trial',
    contested: false,
    citations: [],
    roleId: 'hypothesis-challenger',
  });
  assert.ok(r.blockers.includes('invented_support'));
});
