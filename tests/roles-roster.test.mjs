// Built-in launch roster (V6-03-06). The roster composes C-17's RoleTemplate
// schema (V6-03-01/02) rather than inventing a second one: each entry carries a
// template built by `buildRoleTemplate`, so a SID cites the same (id, version,
// digest) triple an imported persona would. What the roster adds is reviewed
// metadata — family, trial state, gates, expected artifacts, required reviewer
// and the explicit denial list a reviewer signs off on.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { roleTemplateDigest, verifyRoleTemplate } from '../server/src/roles/role-template.ts';
import {
  BUILTIN_ROSTER,
  HARD_DENIED_WORK,
  LAUNCH_FAMILIES,
  RosterError,
  builtinRosterSummary,
  getBuiltinRole,
  getBuiltinRoleBySlug,
  sidRoleRef,
  validateBuiltinRoster,
  validateRoster,
} from '../server/src/roles/builtin-roster.ts';

const ROSTER = BUILTIN_ROSTER;
const HEX64 = /^[0-9a-f]{64}$/;
const clone = value => JSON.parse(JSON.stringify(value));

test('the roster covers every launch family: engineering, QA, security, seven languages, creative and research', () => {
  const families = new Set(ROSTER.map(role => role.family));
  for (const family of LAUNCH_FAMILIES) assert.ok(families.has(family), `missing launch family: ${family}`);
  for (const language of ['rust', 'elixir', 'julia', 'move', 'go', 'python', 'clojure']) {
    assert.ok(families.has(language), `missing language role family: ${language}`);
  }
  assert.ok(!families.has('factory'), 'factory delivery roles are a later track, not the launch roster');
});

test('every role is a C-17 template: namespaced id, positive version, resolvable by id and slug', () => {
  const seen = new Set();
  for (const role of ROSTER) {
    const template = role.template;
    assert.match(template.id, /^rt_uap_[a-z0-9]+(-[a-z0-9]+)*$/, template.id);
    assert.ok(Number.isInteger(template.version) && template.version >= 1, template.id);
    const key = `${template.id}@${template.version}`;
    assert.ok(!seen.has(key), `duplicate template version ${key}`);
    seen.add(key);
    assert.equal(getBuiltinRole(template.id)?.template.id, template.id);
    assert.equal(getBuiltinRoleBySlug(role.slug)?.slug, role.slug);
  }
  assert.equal(getBuiltinRole('rt_uap_does-not-exist'), undefined);
  assert.equal(getBuiltinRole(ROSTER[0].template.id, 99), undefined);
});

test('every template passes the C-17 digest verification and matches a fresh recomputation', () => {
  for (const role of ROSTER) {
    const template = role.template;
    assert.match(template.digest, HEX64, template.id);
    assert.equal(verifyRoleTemplate(template), template.digest);
    const recomputed = roleTemplateDigest({
      id: template.id,
      version: template.version,
      sourceSha: template.sourceSha,
      sourcePath: template.sourcePath,
      title: template.title,
      riskClass: template.riskClass,
      rights: template.rights,
      instructions: template.instructions,
      requestedTools: template.requestedTools,
      evaluationSuite: template.evaluationSuite,
    });
    assert.equal(recomputed, template.digest, `stale digest on ${template.id}`);
  }
});

test('editing any reviewed field breaks the digest, so a pinned digest cannot be reused', () => {
  const original = ROSTER[0].template;
  for (const field of ['title', 'instructions', 'riskClass']) {
    const tampered = clone(original);
    tampered[field] = field === 'riskClass' ? (tampered.riskClass === 'low' ? 'medium' : 'low') : `${tampered[field]} (tampered)`;
    assert.notEqual(tampered.digest, roleTemplateDigest(tampered));
    assert.throws(() => verifyRoleTemplate(tampered), err => err.code === 'digest_mismatch');
  }
  const toolTampered = clone(original);
  toolTampered.requestedTools = [...toolTampered.requestedTools, 'payment.execute'].sort();
  assert.throws(() => verifyRoleTemplate(toolTampered), err => err.code === 'digest_mismatch');
});

test('shipped roles are deep-frozen: no caller can rewrite a role in place', () => {
  assert.ok(Object.isFrozen(ROSTER));
  for (const role of ROSTER) {
    assert.ok(Object.isFrozen(role), `${role.slug} is mutable`);
    assert.ok(Object.isFrozen(role.template), `${role.slug} template is mutable`);
    assert.ok(Object.isFrozen(role.template.requestedTools));
    assert.ok(Object.isFrozen(role.requestedGates));
    assert.ok(Object.isFrozen(role.expectedArtifacts));
    assert.ok(Object.isFrozen(role.reviewers));
    assert.ok(Object.isFrozen(role.deniedWork));
  }
  assert.throws(() => { ROSTER[0].template.title = 'rewritten'; }, TypeError);
});

test('no role requests a hard-denied effect and denials never overlap requested work', () => {
  for (const role of ROSTER) {
    for (const denied of HARD_DENIED_WORK) {
      assert.ok(role.deniedWork.includes(denied), `${role.slug} does not deny ${denied}`);
      assert.ok(!role.template.requestedTools.includes(denied), `${role.slug} requests denied work ${denied}`);
    }
    for (const tool of role.template.requestedTools) {
      assert.ok(!role.deniedWork.includes(tool), `${role.slug} both requests and denies ${tool}`);
      assert.match(tool, /^[a-z0-9][a-z0-9_.:-]*$/, `${role.slug} tool ${tool} is not normalised`);
    }
  }
});

test('owned provenance is a content pin: sourceSha is the sha256 of the shipped persona bytes', () => {
  for (const role of ROSTER) {
    const template = role.template;
    assert.equal(template.rights.license, 'LicenseRef-UAP-Internal');
    assert.equal(template.rights.status, 'declared');
    assert.match(template.rights.sourceUrl, /^https:\/\//);
    assert.equal(template.sourcePath, `docs/roles/${role.slug}.md`);
    const sha = createHash('sha256').update(template.instructions, 'utf8').digest('hex');
    assert.equal(template.sourceSha, sha, `${role.slug} sourceSha is not the content pin`);
    assert.match(template.instructions, /^# /, `${role.slug} persona must start with an H1`);
  }
});

test('templates ship in trial state with gates, artifacts and an independent required reviewer', () => {
  const ids = new Set(ROSTER.map(role => role.template.id));
  for (const role of ROSTER) {
    assert.equal(role.state, 'trial', `${role.slug} must not ship active`);
    assert.ok(role.requestedGates.length >= 2, `${role.slug} needs independent gates`);
    for (const gate of role.requestedGates) assert.match(gate, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
    assert.ok(role.expectedArtifacts.length >= 1, `${role.slug} needs expected artifacts`);
    assert.ok(role.reviewers.length >= 1, `${role.slug} needs a reviewer role`);
    assert.ok(!role.reviewers.includes(role.template.id), `${role.slug} cannot review itself`);
    for (const reviewer of role.reviewers) {
      assert.ok(ids.has(reviewer), `${role.slug} reviewer ${reviewer} is not in the roster`);
    }
    assert.ok(['low', 'medium', 'high'].includes(role.template.riskClass), `${role.slug} risk class`);
  }
});

test('a SID cites the roster template by its immutable triple', () => {
  for (const role of ROSTER) {
    const ref = sidRoleRef(role);
    assert.deepEqual(Object.keys(ref).sort(), ['digest', 'id', 'version']);
    assert.equal(ref.id, role.template.id);
    assert.equal(ref.version, role.template.version);
    assert.equal(ref.digest, role.template.digest);
  }
});

test('validation rejects a duplicate version, a self reviewer, a denied request and a wrong source pin', () => {
  const base = clone(ROSTER[0]);

  const duplicate = [...ROSTER.map(role => clone(role)), clone(base)];
  assert.throws(() => validateRoster(duplicate), err => err instanceof RosterError && err.code === 'duplicate_template');

  const selfReview = clone(base);
  selfReview.reviewers = [selfReview.template.id];
  assert.throws(() => validateRoster([...ROSTER.slice(1), selfReview]), err => err instanceof RosterError && err.code === 'reviewer_not_independent');

  const deniedRequest = clone(base);
  deniedRequest.template.requestedTools = [...deniedRequest.template.requestedTools, 'secret.read'].sort();
  assert.throws(() => validateRoster([...ROSTER.slice(1), deniedRequest]), err => err.code === 'requested_work_denied');

  const wrongPin = clone(base);
  wrongPin.template.sourceSha = 'f'.repeat(64);
  assert.throws(() => validateRoster([...ROSTER.slice(1), wrongPin]), err => err.code === 'source_sha_mismatch' || err.code === 'template_invalid');

  const noGates = clone(base);
  noGates.requestedGates = [];
  assert.throws(() => validateRoster([...ROSTER.slice(1), noGates]), err => err.code === 'gates_missing');
});

test('the exported persona files are byte-identical to the roster instructions', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const role of ROSTER) {
    const text = await readFile(new URL(`../${role.template.sourcePath}`, import.meta.url), 'utf8');
    assert.equal(text, role.template.instructions, `${role.slug} export drifted from the roster`);
  }
});

test('the roster summary is computed, ordered and stable across calls', () => {
  const first = builtinRosterSummary();
  const second = builtinRosterSummary();
  assert.equal(first.count, ROSTER.length);
  assert.deepEqual(first.families, [...first.families].sort());
  assert.equal(first.catalogDigest, second.catalogDigest);
  assert.match(first.catalogDigest, HEX64);
  assert.doesNotThrow(() => validateBuiltinRoster());
});
