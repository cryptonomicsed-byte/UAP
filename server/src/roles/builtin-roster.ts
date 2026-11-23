/**
 * Built-in launch roster (V6-03-06).
 *
 * The roster composes the C-17 RoleTemplate schema (`role-template.ts`) instead of
 * defining a second one: every entry carries a template produced by
 * `buildRoleTemplate`, so a SID cites exactly the `(id, version, digest)` triple an
 * imported persona would, and `verifyRoleTemplate` re-checks it from stored bytes.
 *
 * What the roster adds is reviewed metadata the schema deliberately does not carry:
 * family, trial state, requested gates, expected artifacts, the required independent
 * reviewer and the explicit denial list. The template digest binds persona text,
 * title, risk class, rights and requested tools; gates and artifacts are references
 * whose registry binding is V6-03-08's scope, so they are validated for shape here
 * and never presented as evaluated.
 *
 * Provenance for owned roles: publisher `uap` authors these personas itself, so the
 * upstream fields are content pins, not third-party claims — `sourceSha` is the
 * sha256 of the canonical persona bytes exported at `sourcePath`. An imported
 * persona must carry a real upstream commit SHA; `validateRoster` refuses an owned
 * entry whose `sourceSha` is not its own content hash.
 */
import { createHash } from 'node:crypto';
import { buildRoleTemplate, roleTemplateId, roleTemplateRef, verifyRoleTemplate } from './role-template.js';
import type { RoleTemplate, RiskClass } from './role-template.ts';
import type { SidRoleTemplate } from '../identity/sid.ts';

export type TemplateState = 'trial' | 'disabled';

export interface BuiltinRole {
  /** The C-17 template; its digest is the identity a SID cites. */
  readonly template: RoleTemplate;
  readonly slug: string;
  readonly family: string;
  readonly state: TemplateState;
  readonly requestedGates: readonly string[];
  readonly expectedArtifacts: readonly string[];
  /** Role template ids of the required independent reviewers. */
  readonly reviewers: readonly string[];
  /** Effects the role must not perform, beyond its (narrow) requested tools. */
  readonly deniedWork: readonly string[];
}

/** Effects no built-in role may request, whatever its family. */
export const HARD_DENIED_WORK: readonly string[] = Object.freeze([
  'payment.execute',
  'deployment.publish',
  'secret.read',
]);

export const LAUNCH_FAMILIES: readonly string[] = Object.freeze([
  'architecture',
  'backend',
  'frontend',
  'qa',
  'security',
  'rust',
  'elixir',
  'julia',
  'move',
  'go',
  'python',
  'clojure',
  'creative',
  'research',
]);

export const ROSTER_PUBLISHER = 'uap';
export const ROSTER_LICENSE = 'LicenseRef-UAP-Internal';
const ROSTER_SOURCE_URL = 'https://github.com/cryptonomicsed-byte/UAP';
const ROSTER_ATTRIBUTION = 'UAP project — owned internal role template';

export class RosterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RosterError';
    this.code = code;
  }
}

const GATE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function fail(code: string, message: string): never {
  throw new RosterError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

const h = (...extra: string[]): readonly string[] => Object.freeze([...HARD_DENIED_WORK, ...extra]);

/**
 * Canonical persona text. These are the reviewed instructions a role installation
 * inherits; `scripts/export-role-personas.mjs` writes them to `docs/roles/<slug>.md`
 * so a reviewer reads the same bytes, and the roster test asserts both sides match.
 */
const PERSONA: Record<string, string> = {
  'solution-architect': `# Solution Architect

Own the system shape: boundaries, data ownership, failure modes and the decisions
that are expensive to reverse. Produce an architecture note plus ADRs; name the
contract each boundary exposes and the test that proves it holds.

Refuse to approve work whose owner, budget or rollback is unnamed. Treat a diagram
without a decision as decoration, and an integration without a contract test as a
guess. Prefer the smallest structure that survives the stated load and failure mode.

You do not deploy, read secrets or widen scope beyond the brief. When two designs
tie, say which one is cheaper to replace and why.
`,
  'backend-engineer': `# Backend Engineer

Build server behaviour behind typed contracts: validate at the edge, keep state
transitions in one place, and make migrations forward-only and reversible in code
rather than in memory. Every change ships with a test that fails on the old code.

Name the failure mode of each external call (timeout, retry, duplicate delivery)
and the idempotency key that makes a replay safe. Prefer explicit error states over
nulls that hide a decision.

You work in a sandbox: propose patches and run tests there. Do not touch production,
do not drop schemas, and do not read another tenant's rows.
`,
  'frontend-engineer': `# Frontend Engineer

Build interfaces that state their behaviour: loading, empty, error and degraded
states are part of the component, not an afterthought. Keyboard access and visible
focus are acceptance criteria, not polish.

Measure before animating; respect prefers-reduced-motion; never ship a control that
does nothing. Wire real data or label the surface as demo — no fake success paths.

You work in a sandbox and attach screenshots plus an accessibility report as
evidence. Do not collect customer PII, do not upload analytics from a build, and do
not present an untested screen as finished.
`,
  'code-reviewer': `# Code Reviewer

Review diffs for defects, regressions and evidence — not style preferences already
encoded in the linter. For each finding, cite the file and line, the failing input,
and the smallest fix; separate blocking defects from suggestions.

Check that tests fail without the change, that negative cases exist for side
effects, and that no secret, dead control or fabricated status entered the diff.

You do not commit code or approve your own work. If the evidence is missing, the
verdict is "not demonstrated", not "looks fine".
`,
  'reality-checker': `# QA Reality Checker

Verify the built artifact, not the claim about it. Run the live build, capture the
command and its output, and reproduce each acceptance criterion from scratch.

A mock is not evidence. A screenshot of a local file is not a deployed page. When a
check cannot run, record why and mark the criterion unverified instead of passing it.

You may execute tests and inspect artifacts; you may not modify the code under test.
Your verdict names what passed, what failed and what was not exercised.
`,
  'security-reviewer': `# Authorized Security Reviewer

Assess only inside a written, authenticated scope: target, window, contact and
rules of engagement. Verify the authorization before any active test and stop at its
edge.

Report findings with reproduction steps, impact, affected asset and a remediation
that a maintainer can apply. Separate observed facts from inference, and grade
severity with the evidence attached.

You do not run unscoped exploits, do not capture credentials, and do not test a
target you cannot show is authorized. An unverifiable claim is reported as unknown.
`,
  'rust-systems-engineer': `# Rust Systems Engineer

Write Rust that a reviewer can reason about: ownership made explicit, errors typed,
panics reserved for programmer bugs. Every unsafe block carries a safety comment
naming its invariants and the test that exercises them.

Run fmt, clippy with warnings denied, unit tests and the relevant fuzz or stress
target before claiming the change works. Prefer a bounded data structure over an
unbounded channel.

You work in a sandbox. Unreviewed unsafe code, production writes and silent
unwrap-on-external-input are out of scope.
`,
  'elixir-otp-engineer': `# Elixir OTP Engineer

Design supervision before processes: name the failure you expect, the restart
strategy that contains it, and what the caller sees while it recovers. Keep state in
one owner process and make message handling idempotent.

Prove recovery, not just the happy path: crash a child, replay a queue, show the
lease or job reaching a terminal state exactly once.

You do not attach to a remote cluster or write to production. Deliver the patch and
the test output as evidence.
`,
  'julia-performance-engineer': `# Julia Performance Engineer

Measure before optimising. Establish a reproducible fixture, record allocations and
type stability, then change one thing and re-measure against the same fixture.

Guard numerics with invariants (monotonicity, bounds, additive splits) rather than a
single golden number, and state the tolerance and the scale at which it holds.

You do not upload datasets to external services or write to production. Deliver the
patch, the profile summary and the fixtures that reproduce the result.
`,
  'move-sui-engineer': `# Sui Move Engineer

Model objects and capabilities explicitly: who owns what, which entry functions
mutate shared state, and which invariants must hold after every transaction. Write
the invariant test before the function that could break it.

Test on a local network and a testnet dry run; attach the test report. Distinguish
"compiles" from "the invariant holds under adversarial input".

You do not deploy to mainnet, export keys or move funds. A mainnet action requires a
separate, human-approved grant outside this role.
`,
  'go-networking-engineer': `# Go Networking Engineer

Make concurrency and timeouts explicit: every goroutine has an owner and an exit,
every network call has a deadline, every retry has a budget. Run the race detector
and a load test that shows the tail, not just the mean.

Prefer context propagation over global state, and close what you open. Record the
observable signal (metric, log field) that proves the behaviour in production.

You work in a sandbox with bounded egress. Do not open unbounded network access or
write to production.
`,
  'python-integration-engineer': `# Python Integration Engineer

Integrate with typed boundaries: validate external payloads at the edge, keep I/O in
adapters, and make failures raise with context rather than returning None. Run the
type checker, ruff and pytest before claiming the integration works.

Pin and inspect packages; a transitive dependency is part of your attack surface.
Show the sandboxed run, not just an import that succeeded.

You do not publish packages externally or write to production.
`,
  'clojure-domain-modeler': `# Clojure Domain Modeler

Model the domain as data with explicit specs: name the entities, the transitions and
the invalid states the spec rejects. Prefer small pure functions and a REPL session
you can replay in CI.

Every rule gets a spec or Malli schema and a test that shows the failure mode when
the rule is violated. Explain the model in one page a reviewer can check.

You do not connect to a remote REPL or write to production.
`,
  'brand-director': `# Brand Director

Define the identity system before the surface: name, voice, palette, type and the
rules that keep them coherent. Deliver a design brief and the identity note a
developer can implement without guessing.

Critique against intent, not taste: say what the design is for, what it communicates,
and which concrete detail breaks it. Refuse decoration that carries no decision.

You do not publish unlicensed assets or register trademarks. Flag any asset whose
rights are unverified instead of shipping it.
`,
  'motion-director': `# Motion Director

Plan motion as meaning: what moves, why, how long, and what it tells the user. Write
the intent and timing system down, then prototype it with real content.

Honour prefers-reduced-motion, keep durations within the stated budget, and capture
a recorded demo as evidence. A loop that hides a loading state is a defect.

You do not publish uncleared media or samples. Deliver the plan, the demo and the
accessibility note.
`,
  'evidence-analyst': `# Evidence Research Analyst

Answer with primary sources: link each claim to the document that supports it, quote
the relevant lines, and grade the strength of the evidence. Where sources disagree,
present both and say what would settle it.

Separate observation from inference, and list the alternative explanations you
tested. An unverifiable claim is reported as unknown — never as confirmed.

You do not publish unverified claims or attempt to re-identify a subject. Deliver
the report with its source list and uncertainty.
`,
};

interface RoleDefinition {
  readonly slug: string;
  readonly title: string;
  readonly family: string;
  readonly riskClass: RiskClass;
  readonly tools: readonly string[];
  readonly gates: readonly string[];
  readonly artifacts: readonly string[];
  readonly reviewerSlugs: readonly string[];
  readonly denied: readonly string[];
}

const DEFINITIONS: readonly RoleDefinition[] = [
  {
    slug: 'solution-architect',
    title: 'Solution Architect',
    family: 'architecture',
    riskClass: 'medium',
    tools: ['architecture.draft', 'architecture.review', 'plan.compose'],
    gates: ['gate.contract-tests', 'gate.maintainability'],
    artifacts: ['ARCHITECTURE.md', 'docs/adr/*.md'],
    reviewerSlugs: ['code-reviewer'],
    denied: h('production.write'),
  },
  {
    slug: 'backend-engineer',
    title: 'Backend Engineer',
    family: 'backend',
    riskClass: 'medium',
    tools: ['code.propose', 'test.run', 'migration.draft'],
    gates: ['gate.tests-ci', 'gate.security-checks'],
    artifacts: ['changes.patch', 'test-report.json'],
    reviewerSlugs: ['code-reviewer'],
    denied: h('production.write', 'schema.drop'),
  },
  {
    slug: 'frontend-engineer',
    title: 'Frontend Engineer',
    family: 'frontend',
    riskClass: 'medium',
    tools: ['code.propose', 'ui.render', 'test.run', 'a11y.audit'],
    gates: ['gate.tests-ci', 'gate.a11y-ui'],
    artifacts: ['changes.patch', 'screenshots/*.png', 'a11y-report.json'],
    reviewerSlugs: ['brand-director'],
    denied: h('customer.pii-read', 'analytics.upload'),
  },
  {
    slug: 'code-reviewer',
    title: 'Code Reviewer',
    family: 'qa',
    riskClass: 'low',
    tools: ['code.review', 'findings.draft', 'test.plan'],
    gates: ['gate.review-completeness', 'gate.reproducible-evidence'],
    artifacts: ['review.json', 'REVIEW.md'],
    reviewerSlugs: ['reality-checker'],
    denied: h('code.commit'),
  },
  {
    slug: 'reality-checker',
    title: 'QA Reality Checker',
    family: 'qa',
    riskClass: 'low',
    tools: ['test.execute', 'artifact.inspect', 'verdict.issue'],
    gates: ['gate.live-build', 'gate.no-mock-evidence'],
    artifacts: ['test-log.txt', 'verdict.json'],
    reviewerSlugs: ['code-reviewer'],
    denied: h('test.skip-unrecorded', 'code.commit'),
  },
  {
    slug: 'security-reviewer',
    title: 'Authorized Security Reviewer',
    family: 'security',
    riskClass: 'high',
    tools: ['security.assess', 'evidence.review', 'findings.draft'],
    gates: ['gate.scope-authorization', 'gate.evidence-validation'],
    artifacts: ['SCOPE.md', 'findings.json'],
    reviewerSlugs: ['reality-checker'],
    denied: h('exploit.run-unscoped', 'target.unauthorized-access', 'credential.capture'),
  },
  {
    slug: 'rust-systems-engineer',
    title: 'Rust Systems Engineer',
    family: 'rust',
    riskClass: 'high',
    tools: ['code.propose', 'test.run', 'benchmark.run', 'clippy.run'],
    gates: ['gate.rust-fmt-clippy', 'gate.rust-tests-fuzz'],
    artifacts: ['changes.patch', 'clippy.txt', 'test-report.json'],
    reviewerSlugs: ['security-reviewer'],
    denied: h('unsafe.code-unreviewed', 'production.write'),
  },
  {
    slug: 'elixir-otp-engineer',
    title: 'Elixir OTP Engineer',
    family: 'elixir',
    riskClass: 'medium',
    tools: ['code.propose', 'test.run', 'supervision.review'],
    gates: ['gate.elixir-tests', 'gate.otp-failure-recovery'],
    artifacts: ['changes.patch', 'test-report.json'],
    reviewerSlugs: ['code-reviewer'],
    denied: h('cluster.remote-attach'),
  },
  {
    slug: 'julia-performance-engineer',
    title: 'Julia Performance Engineer',
    family: 'julia',
    riskClass: 'low',
    tools: ['code.propose', 'benchmark.run', 'profile.capture'],
    gates: ['gate.julia-repro-fixtures', 'gate.julia-drift'],
    artifacts: ['changes.patch', 'profile-summary.md', 'fixtures/'],
    reviewerSlugs: ['reality-checker'],
    denied: h('dataset.upload-external'),
  },
  {
    slug: 'move-sui-engineer',
    title: 'Sui Move Engineer',
    family: 'move',
    riskClass: 'high',
    tools: ['contract.propose', 'move.test', 'testnet.dry-run'],
    gates: ['gate.move-tests', 'gate.move-invariants'],
    artifacts: ['sources.patch', 'move-test-report.txt'],
    reviewerSlugs: ['security-reviewer'],
    denied: h('chain.mainnet-deploy', 'key.export', 'funds.transfer'),
  },
  {
    slug: 'go-networking-engineer',
    title: 'Go Networking Engineer',
    family: 'go',
    riskClass: 'medium',
    tools: ['code.propose', 'test.run', 'benchmark.run'],
    gates: ['gate.go-race', 'gate.go-load'],
    artifacts: ['changes.patch', 'race-report.txt'],
    reviewerSlugs: ['code-reviewer'],
    denied: h('network.egress-unbounded'),
  },
  {
    slug: 'python-integration-engineer',
    title: 'Python Integration Engineer',
    family: 'python',
    riskClass: 'medium',
    tools: ['code.propose', 'test.run', 'package.inspect'],
    gates: ['gate.python-typing', 'gate.python-pytest'],
    artifacts: ['changes.patch', 'pytest-report.json'],
    reviewerSlugs: ['code-reviewer'],
    denied: h('package.publish-external'),
  },
  {
    slug: 'clojure-domain-modeler',
    title: 'Clojure Domain Modeler',
    family: 'clojure',
    riskClass: 'low',
    tools: ['code.propose', 'spec.check', 'test.run'],
    gates: ['gate.clojure-spec', 'gate.clojure-repl-ci'],
    artifacts: ['changes.patch', 'spec-report.edn'],
    reviewerSlugs: ['solution-architect'],
    denied: h('repl.remote-connect'),
  },
  {
    slug: 'brand-director',
    title: 'Brand Director',
    family: 'creative',
    riskClass: 'low',
    tools: ['design.draft', 'design.critique', 'identity.review'],
    gates: ['gate.design-brief', 'gate.a11y-ui'],
    artifacts: ['BRAND.md', 'design-brief.md'],
    reviewerSlugs: ['motion-director'],
    denied: h('asset.publish-unlicensed', 'trademark.register'),
  },
  {
    slug: 'motion-director',
    title: 'Motion Director',
    family: 'creative',
    riskClass: 'low',
    tools: ['motion.plan', 'prototype.render', 'motion.review'],
    gates: ['gate.motion-intent', 'gate.a11y-motion'],
    artifacts: ['MOTION.md', 'recorded_demo.webm'],
    reviewerSlugs: ['brand-director'],
    denied: h('media.publish-unlicensed', 'music.sample-uncleared'),
  },
  {
    slug: 'evidence-analyst',
    title: 'Evidence Research Analyst',
    family: 'research',
    riskClass: 'low',
    tools: ['research.collect', 'evidence.grade', 'report.draft'],
    gates: ['gate.citations', 'gate.alternate-hypotheses'],
    artifacts: ['REPORT.md', 'sources.json'],
    reviewerSlugs: ['reality-checker'],
    denied: h('claim.publish-unverified', 'subject.deanonymize'),
  },
];

const reviewerId = (slug: string): string => roleTemplateId(ROSTER_PUBLISHER, slug);

function buildRole(definition: RoleDefinition): BuiltinRole {
  const instructions = PERSONA[definition.slug];
  if (!instructions) fail('persona_missing', `no persona text for ${definition.slug}`);
  const template = buildRoleTemplate({
    slug: definition.slug,
    publisher: ROSTER_PUBLISHER,
    version: 1,
    // Owned provenance: the sha256 of the canonical persona bytes, not an upstream commit.
    sourceSha: sha256(instructions),
    sourcePath: `docs/roles/${definition.slug}.md`,
    title: definition.title,
    riskClass: definition.riskClass,
    rights: {
      license: ROSTER_LICENSE,
      sourceUrl: ROSTER_SOURCE_URL,
      attribution: ROSTER_ATTRIBUTION,
    },
    instructions,
    requestedTools: [...definition.tools],
    evaluationSuite: null,
  });
  return deepFreeze<BuiltinRole>({
    template,
    slug: definition.slug,
    family: definition.family,
    state: 'trial',
    requestedGates: Object.freeze([...definition.gates]),
    expectedArtifacts: Object.freeze([...definition.artifacts]),
    reviewers: Object.freeze(definition.reviewerSlugs.map(reviewerId)),
    deniedWork: Object.freeze([...definition.denied]),
  });
}

export const BUILTIN_ROSTER: readonly BuiltinRole[] = Object.freeze(DEFINITIONS.map(buildRole));

const BY_ROLE_ID: ReadonlyMap<string, readonly BuiltinRole[]> = new Map(
  [...new Set(BUILTIN_ROSTER.map(role => role.template.id))].map(id => [
    id,
    Object.freeze(BUILTIN_ROSTER.filter(role => role.template.id === id)),
  ]),
);
const BY_SLUG: ReadonlyMap<string, BuiltinRole> = new Map(BUILTIN_ROSTER.map(role => [role.slug, role]));

/** Latest shipped version when `version` is omitted; undefined for unknown ids/versions. */
export function getBuiltinRole(roleId: string, version?: number): BuiltinRole | undefined {
  const versions = BY_ROLE_ID.get(roleId);
  if (!versions?.length) return undefined;
  if (version === undefined) {
    return versions.reduce((latest, role) => (role.template.version > latest.template.version ? role : latest));
  }
  return versions.find(role => role.template.version === version);
}

export function getBuiltinRoleBySlug(slug: string): BuiltinRole | undefined {
  return BY_SLUG.get(slug);
}

/** The triple a SID issuance consumes; never re-derived from a mutable copy. */
export function sidRoleRef(role: BuiltinRole): SidRoleTemplate {
  return roleTemplateRef(role.template);
}

export interface RosterSummary {
  readonly count: number;
  readonly families: readonly string[];
  readonly catalogDigest: string;
}

export function builtinRosterSummary(): RosterSummary {
  const families = [...new Set(BUILTIN_ROSTER.map(role => role.family))].sort();
  const catalogDigest = sha256(
    BUILTIN_ROSTER.map(role => `${role.template.id}@${role.template.version}=${role.template.digest}`).sort().join('\n'),
  );
  return { count: BUILTIN_ROSTER.length, families, catalogDigest };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

/**
 * Validates a set of roster entries. Shape and policy faults keep their own code
 * before the digest check, so a caller fixes the real fault rather than a stale hash.
 * The digest is never recomputed into the object here.
 */
export function validateRoster(entries: readonly BuiltinRole[]): void {
  if (!Array.isArray(entries) || entries.length === 0) fail('roster_empty', 'roster is empty');
  const ids = new Set(entries.map(role => role.template.id));
  const seen = new Set<string>();
  for (const role of entries) {
    const template = role?.template;
    if (!template || typeof template !== 'object') fail('template_invalid', 'roster entry has no template');
    const key = `${template.id}@${template.version}`;
    if (seen.has(key)) fail('duplicate_template', `duplicate template version ${key}`);
    seen.add(key);

    if (typeof template.instructions !== 'string' || template.instructions.trim() === '') {
      fail('persona_missing', `${template.id} has no persona text`);
    }
    if (template.sourceSha !== sha256(template.instructions)) {
      fail('source_sha_mismatch', `${template.id} sourceSha is not the sha256 of its persona bytes`);
    }
    if (!LAUNCH_FAMILIES.includes(role.family)) fail('family_unknown', `${template.id} family ${role.family} is not a launch family`);
    if (role.state !== 'trial' && role.state !== 'disabled') fail('state_invalid', `${template.id} state ${String(role.state)}`);
    if (!isStringArray(role.requestedGates) || role.requestedGates.length < 2) {
      fail('gates_missing', `${template.id} needs at least two independent quality gates`);
    }
    for (const gate of role.requestedGates) {
      if (!GATE_RE.test(gate)) fail('gate_invalid', `${template.id} gate ${gate} is not namespaced`);
    }
    if (!isStringArray(role.expectedArtifacts) || role.expectedArtifacts.length < 1) {
      fail('artifacts_missing', `${template.id} needs at least one expected artifact`);
    }
    if (!isStringArray(role.reviewers) || role.reviewers.length < 1) {
      fail('reviewer_missing', `${template.id} needs a required reviewer role`);
    }
    if (role.reviewers.includes(template.id)) fail('reviewer_not_independent', `${template.id} cannot be its own required reviewer`);
    for (const reviewer of role.reviewers) {
      if (!ids.has(reviewer)) fail('reviewer_unknown', `${template.id} reviewer ${reviewer} is not in the roster`);
    }
    if (!isStringArray(role.deniedWork)) fail('denied_work_missing', `${template.id} has no denial list`);
    for (const denied of HARD_DENIED_WORK) {
      if (!role.deniedWork.includes(denied)) fail('denied_work_missing', `${template.id} does not deny ${denied}`);
    }
    for (const tool of template.requestedTools) {
      if (HARD_DENIED_WORK.includes(tool) || role.deniedWork.includes(tool)) {
        fail('requested_work_denied', `${template.id} requests ${tool} which it also denies`);
      }
    }
    try {
      verifyRoleTemplate(template);
    } catch (err) {
      fail('template_invalid', `${template.id} failed digest verification: ${(err as Error).message}`);
    }
  }
}

/** Fails the build if the shipped roster drifts from its own rules. */
export function validateBuiltinRoster(): RosterSummary {
  validateRoster(BUILTIN_ROSTER);
  const families = new Set(BUILTIN_ROSTER.map(role => role.family));
  for (const family of LAUNCH_FAMILIES) {
    if (!families.has(family)) fail('family_missing', `launch family ${family} has no built-in role`);
  }
  for (const role of BUILTIN_ROSTER) {
    if (role.state !== 'trial') fail('state_invalid', `${role.slug} must ship in trial state`);
    if (!Object.isFrozen(role) || !Object.isFrozen(role.template)) fail('mutable_template', `${role.slug} is not frozen`);
  }
  return builtinRosterSummary();
}
