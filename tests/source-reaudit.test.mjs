// B-22 (V6-02-09): scheduled re-audit and revocation alerts.
// Cadence is a function of trust rung and risk class; advisories are matched against the
// pinned dependency set and origin, and produce deterministic, deduplicable alerts that
// demote or revoke the source instead of leaving a stale "audited" badge in place.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

const { satisfies, dueReaudits, matchAdvisories, applyAdvisory, REAUDIT_POLICY } = await import('../server/src/sources/reaudit.ts');

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

const src = (over = {}) => ({
  sourceId: 'src_' + 'a'.repeat(16),
  canonicalSlug: 'example/agent-skills',
  owner: 'example',
  trustStatus: 'STATIC_AUDITED',
  riskClass: 'medium',
  observedAt: NOW - 200 * DAY,
  lastAuditedAt: NOW - 10 * DAY,
  revokedAt: null,
  dependencies: [
    { name: 'left-pad', version: '1.4.9' },
    { name: 'old-http', version: '0.2.5' },
  ],
  ...over,
});

// ---------- semver ----------

test('range matching handles caret, tilde, comparator chains and exact pins', () => {
  assert.equal(satisfies('1.4.9', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('0.2.5', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('1.4.9', '~1.4.2'), true);
  assert.equal(satisfies('1.5.0', '~1.4.2'), false);
  assert.equal(satisfies('2.4.0', '>=2.0.0 <2.5.0'), true);
  assert.equal(satisfies('2.5.0', '>=2.0.0 <2.5.0'), false);
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('3.1.0', '^1.0.0 || ^3.0.0'), true);
  assert.equal(satisfies('garbage', '^1.0.0'), false);
  assert.equal(satisfies('1.2.3', 'not-a-range'), false);
});

// ---------- cadence ----------

test('re-audit cadence follows the trust rung and compresses for risk', () => {
  assert.equal(REAUDIT_POLICY.cadenceDays.STATIC_AUDITED, 90);
  assert.equal(REAUDIT_POLICY.cadenceDays.PUBLISHED, 30);
  assert.equal(REAUDIT_POLICY.riskMultiplier.critical < REAUDIT_POLICY.riskMultiplier.medium, true);

  const onTime = dueReaudits([src({ lastAuditedAt: NOW - 89 * DAY })], { now: NOW });
  assert.equal(onTime.due.length, 0);
  assert.equal(onTime.notDue, 1);

  const late = dueReaudits([src({ lastAuditedAt: NOW - 100 * DAY })], { now: NOW });
  assert.equal(late.due.length, 1);
  assert.equal(late.due[0].overdue, true);
  assert.equal(late.due[0].daysOverdue, 10);
  assert.equal(late.due[0].reason, 'cadence');

  const critical = dueReaudits([src({ riskClass: 'critical', lastAuditedAt: NOW - 30 * DAY })], { now: NOW });
  assert.equal(critical.due.length, 1, 'critical risk re-audits four times as often');
  assert.equal(critical.due[0].dueAt, NOW - 30 * DAY + Math.round(90 * 0.25) * DAY);
});

test('never-audited and revoked-pending-reaudit sources surface with their own reason', () => {
  const never = dueReaudits([src({ trustStatus: 'PUBLISHED', lastAuditedAt: null })], { now: NOW });
  assert.equal(never.due[0].reason, 'never_audited');

  const revoked = dueReaudits([src({ trustStatus: 'USER_SUPPLIED_UNVERIFIED', lastAuditedAt: NOW - 40 * DAY, revokedAt: NOW - 2 * DAY })], { now: NOW });
  assert.equal(revoked.due[0].reason, 'revoked_pending_reaudit');
  assert.equal(revoked.due[0].sourceId, 'src_' + 'a'.repeat(16));
});

test('the due list is ordered and stable regardless of input order', () => {
  const b = src({ sourceId: 'src_' + 'b'.repeat(16), lastAuditedAt: NOW - 95 * DAY });
  const c = src({ sourceId: 'src_' + 'c'.repeat(16), lastAuditedAt: NOW - 200 * DAY });
  const one = dueReaudits([src(), b, c], { now: NOW });
  const two = dueReaudits([c, src(), b], { now: NOW });
  assert.deepEqual(one.due.map((d) => d.sourceId), two.due.map((d) => d.sourceId));
  assert.equal(one.due[0].sourceId, 'src_' + 'c'.repeat(16));
});

// ---------- advisories ----------

const advisory = (over = {}) => ({ id: 'GHSA-xxxx-1', kind: 'vulnerable-package', package: 'old-http', affectedRange: '^0.2.0', severity: 'high', publishedAt: NOW - DAY, ...over });

test('a vulnerable dependency alert matches only the affected versions', () => {
  const hit = matchAdvisories([src()], [advisory()], { now: NOW });
  assert.equal(hit.alerts.length, 1);
  assert.equal(hit.alerts[0].sourceId, 'src_' + 'a'.repeat(16));
  assert.equal(hit.alerts[0].action, 'quarantine');
  assert.equal(hit.alerts[0].severity, 'high');
  assert.equal(hit.alerts[0].matched.version, '0.2.5');

  const miss = matchAdvisories([src({ dependencies: [{ name: 'old-http', version: '1.0.0' }] })], [advisory()], { now: NOW });
  assert.equal(miss.alerts.length, 0);

  const packageMiss = matchAdvisories([src()], [advisory({ package: 'left-pad' })], { now: NOW });
  assert.equal(packageMiss.alerts.length, 0, 'left-pad 1.4.9 is outside ^0.2.0');
});

test('a compromised origin is critical and demands revocation, archived upstream is informational', () => {
  const compromised = matchAdvisories([src()], [{ id: 'ADV-9', kind: 'compromised-origin', owner: 'example', publishedAt: NOW }], { now: NOW });
  assert.equal(compromised.alerts[0].severity, 'critical');
  assert.equal(compromised.alerts[0].action, 'revoke_now');

  const otherOwner = matchAdvisories([src()], [{ id: 'ADV-9', kind: 'compromised-origin', owner: 'unrelated', publishedAt: NOW }], { now: NOW });
  assert.equal(otherOwner.alerts.length, 0);

  const archived = matchAdvisories([src()], [{ id: 'ADV-10', kind: 'archived-upstream', owner: 'example', repo: 'agent-skills', publishedAt: NOW }], { now: NOW });
  assert.equal(archived.alerts[0].severity, 'info');
  assert.equal(archived.alerts[0].action, 'note');
});

test('alert ids are deterministic and duplicate advisories collapse', () => {
  const a = matchAdvisories([src()], [advisory()], { now: NOW });
  const b = matchAdvisories([src()], [advisory(), advisory()], { now: NOW + 5000 });
  assert.equal(a.alerts.length, 1);
  assert.equal(b.alerts.length, 1);
  assert.equal(a.alerts[0].id, b.alerts[0].id);
  assert.match(a.alerts[0].id, /^alert_[a-f0-9]{16}$/);
});

// ---------- applying an alert ----------

test('critical alerts revoke, high alerts quarantine, informational alerts leave trust alone', () => {
  const live = src({ trustStatus: 'PUBLISHED', reviewerSignature: { reviewerId: 'rev-bob', signature: 'zz', signedAt: NOW - DAY } });
  const critical = matchAdvisories([live], [{ id: 'ADV-9', kind: 'compromised-origin', owner: 'example', publishedAt: NOW }], { now: NOW }).alerts[0];
  const revoked = applyAdvisory(live, critical, NOW);
  assert.equal(revoked.trustStatus, 'USER_SUPPLIED_UNVERIFIED');
  assert.equal(revoked.reviewerSignature, null);
  assert.equal(revoked.revocations[0].advisoryId, 'ADV-9');

  const high = matchAdvisories([live], [advisory()], { now: NOW }).alerts[0];
  const quarantined = applyAdvisory(live, high, NOW);
  assert.equal(quarantined.trustStatus, 'PUBLIC_LOCATED');
  assert.equal(quarantined.quarantinedBy.length, 1);
  assert.equal(quarantined.reviewerSignature, live.reviewerSignature, 'quarantine does not fabricate a new approval');

  const info = matchAdvisories([live], [{ id: 'ADV-10', kind: 'archived-upstream', owner: 'example', repo: 'agent-skills', publishedAt: NOW }], { now: NOW }).alerts[0];
  const untouched = applyAdvisory(live, info, NOW);
  assert.equal(untouched.trustStatus, 'PUBLISHED');
  assert.equal(untouched, live);
});

test('re-applying an alert is idempotent', () => {
  const highSource = src({ trustStatus: 'STATIC_AUDITED' });
  const alert = matchAdvisories([highSource], [advisory()], { now: NOW }).alerts[0];
  const once = applyAdvisory(highSource, alert, NOW);
  const twice = applyAdvisory(once, alert, NOW + 1000);
  assert.equal(twice.trustStatus, once.trustStatus);
  assert.equal(twice.quarantinedBy.length, 1);
});
