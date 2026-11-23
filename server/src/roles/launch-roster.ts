// C-18 (V6-03-06): the built-in launch roster.
//
// These are the roles the product ships with on day one: architecture, frontend/backend,
// QA, security, and one engineer per language the platform actually runs (Rust kernel,
// Elixir runtime, Julia compute, Sui Move, Go gateway, Python tools, Clojure symbolic),
// plus creative and research.
//
// Shape: the published RoleTemplate contract (blueprint §23.3), plus the three fields the
// roster is useless without (V6-03-08): objective expected artifacts, a sample task plan
// that only produces those artifacts, and the independent reviewers who gate the work.
//
// Two invariants this module enforces rather than documents:
//   * a template *requests* capabilities and never carries a grant — there is no `grants`,
//     `tools` or `allowed_tools` field, and capability strings come from the Rust kernel's
//     EffectClass vocabulary (`crates/agentos-policy/src/effect.rs`);
//   * `risk_class` uses the kernel's RiskTier vocabulary, so a roster entry can be compared
//     against a grant ceiling without translation.
//
// `content_digest` is derived from the manifest itself (sha256 over the JSON without the
// digest field), and the whole roster is frozen: a role version is immutable once shipped.

import crypto from 'node:crypto';

export const ROSTER_SCHEMA = 'platform.roles/v1';

/** EffectClass::ALL as strings — the only capability vocabulary a template may use. */
export const EFFECT_CLASSES: readonly string[] = Object.freeze([
  'read', 'compute', 'write', 'external_message', 'money', 'publish', 'production_change',
  'security_testing', 'clinical_data',
]);

/** RiskTier::ALL as strings — a role's assessed blast radius. */
export const RISK_TIERS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'critical']);

export interface RosterTaskStep {
  readonly step: string;
  /** Must name one of the role's own `expected_artifacts`. */
  readonly artifact: string;
}

export interface RoleTemplateManifest {
  readonly role_id: string;
  readonly publisher_id: string;
  readonly name: string;
  readonly domain: string;
  readonly version: string;
  readonly source_repo: string;
  /** null only for built-in text authored in this repository (nothing upstream to pin). */
  readonly source_commit: string | null;
  readonly license: string;
  readonly content_digest: string;
  readonly instructions: string;
  readonly skills: readonly string[];
  readonly expected_artifacts: readonly string[];
  readonly evaluation_suite: readonly string[];
  /** Requests, never grants. The policy kernel decides what a SID actually receives. */
  readonly requested_capabilities: readonly string[];
  readonly risk_class: string;
  readonly compatible_runtime_versions: readonly string[];
  readonly deprecation: string | null;
  readonly quality_gates: readonly string[];
  /** Independent roles that must review this role's output. Never the role itself. */
  readonly required_reviewers: readonly string[];
  readonly sample_task_plan: readonly RosterTaskStep[];
  /** True when the work needs an owner-approved engagement before any execution. */
  readonly approval_required: boolean;
}

type RosterSeed = Omit<RoleTemplateManifest, 'content_digest' | 'publisher_id' | 'source_repo' | 'source_commit' | 'license' | 'deprecation' | 'compatible_runtime_versions'> & {
  readonly source_repo?: string;
  readonly source_commit?: string | null;
  readonly license?: string;
  readonly deprecation?: string | null;
  readonly compatible_runtime_versions?: readonly string[];
};

const sha256 = (value: unknown): string =>
  'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Digest of a manifest's content: sha256 over its JSON with the digest field absent. */
export function roleDigest(manifest: Record<string, unknown>): string {
  return sha256(manifest);
}

const SEEDS: readonly RosterSeed[] = [
  {
    role_id: 'architecture.solution-architect',
    name: 'Solution Architect',
    domain: 'architecture',
    version: '1.0.0',
    instructions:
      'Turn a product requirement into a buildable architecture: name the components, the trust boundaries, the data flow and the failure modes. Prefer the smallest design that meets the requirement, and record every rejected alternative with the reason. Do not claim an interface works until it has been exercised by someone other than you.',
    skills: ['architecture.decomposition/v1', 'architecture.adr/v1'],
    expected_artifacts: ['ARCHITECTURE.md', 'adr/', 'trust-boundary-diagram.svg'],
    evaluation_suite: ['architecture.requirement-coverage/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'medium',
    quality_gates: ['architecture.interface-contract-tested', 'architecture.security-review'],
    required_reviewers: ['security.authorized-security-analyst', 'engineering.backend-engineer'],
    sample_task_plan: [
      { step: 'Map each requirement to a component and a trust boundary', artifact: 'ARCHITECTURE.md' },
      { step: 'Record the decisions and the alternatives that were rejected', artifact: 'adr/' },
      { step: 'Draw the data flow across every trust boundary', artifact: 'trust-boundary-diagram.svg' },
    ],
    approval_required: false,
  },
  {
    role_id: 'engineering.frontend-engineer',
    name: 'Frontend Engineer',
    domain: 'engineering',
    version: '1.0.0',
    instructions:
      'Build the interface that ships: real states for empty, loading, error and success; no dead controls and no placeholder text in a delivered screen. Capture the rendered result, check keyboard and screen-reader paths, and report what still fails instead of hiding it.',
    skills: ['web.ui-implementation/v1', 'web.accessibility/v1'],
    expected_artifacts: ['ui-build/', 'screenshots/', 'a11y-report.json'],
    evaluation_suite: ['web.visual-and-a11y/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'medium',
    quality_gates: ['ui.typecheck-and-build', 'ui.a11y-and-responsive-check', 'ui.artifact-captured'],
    required_reviewers: ['qa.reality-checker', 'creative.editorial-ui-designer'],
    sample_task_plan: [
      { step: 'Implement the screens including empty, loading and error states', artifact: 'ui-build/' },
      { step: 'Capture each state at phone and desktop widths', artifact: 'screenshots/' },
      { step: 'Run the accessibility checks and record the failures', artifact: 'a11y-report.json' },
    ],
    approval_required: false,
  },
  {
    role_id: 'engineering.backend-engineer',
    name: 'Backend Engineer',
    domain: 'engineering',
    version: '1.0.0',
    instructions:
      'Own the contract, the storage and the failure path. Every endpoint states its errors, every migration is provable forward and back, and every authorization rule is tested from the wrong side first. Publish the contract document; do not let the client infer it.',
    skills: ['server.api-design/v1', 'server.persistence/v1'],
    expected_artifacts: ['api-contract.openapi.json', 'migrations/', 'integration-test-report.txt'],
    evaluation_suite: ['server.contract-and-authz/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'medium',
    quality_gates: ['api.contract-tests', 'api.authz-negative-tests', 'db.migration-forward-and-back'],
    required_reviewers: ['security.authorized-security-analyst', 'qa.reality-checker'],
    sample_task_plan: [
      { step: 'Write the endpoint contract including its error states', artifact: 'api-contract.openapi.json' },
      { step: 'Ship the schema change with a reversible path', artifact: 'migrations/' },
      { step: 'Prove it with contract and negative authorization tests', artifact: 'integration-test-report.txt' },
    ],
    approval_required: false,
  },
  {
    role_id: 'qa.reality-checker',
    name: 'QA Reality Checker',
    domain: 'qa',
    version: '1.0.0',
    instructions:
      'Test what the user receives, not what the author says. Run the built artifact, record the exact command and its output, and file defects with reproduction steps. A test you did not watch fail proves nothing; say so when you could not watch it.',
    skills: ['qa.behaviour-testing/v1', 'qa.defect-reporting/v1'],
    expected_artifacts: ['TEST-REPORT.md', 'defects.md'],
    evaluation_suite: ['qa.independent-verification/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'low',
    quality_gates: ['qa.commands-and-output-recorded', 'qa.negative-cases-present', 'qa.reproduces-on-clean-checkout'],
    required_reviewers: ['architecture.solution-architect'],
    sample_task_plan: [
      { step: 'Run the built artifact and record each command with its output', artifact: 'TEST-REPORT.md' },
      { step: 'Exercise the negative and boundary cases the author skipped', artifact: 'TEST-REPORT.md' },
      { step: 'File each defect with reproduction steps and observed-versus-expected', artifact: 'defects.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'security.authorized-security-analyst',
    name: 'Authorized Security Analyst',
    domain: 'security',
    version: '1.0.0',
    instructions:
      'Test only assets inside a written, authorized engagement scope, and stop when scope is unclear. Prefer the least invasive proof of a weakness. Every finding needs a reproduction, an impact statement and a remediation; never publish an unverified exploit, and never claim a test you did not run.',
    skills: ['security.scoped-assessment/v1', 'security.finding-writeup/v1'],
    expected_artifacts: ['SCOPE-AUTHORIZATION.md', 'findings/', 'remediation-plan.md'],
    evaluation_suite: ['security.independent-findings-review/v1'],
    requested_capabilities: ['read', 'compute', 'security_testing'],
    risk_class: 'high',
    quality_gates: ['security.scope-authorized', 'security.isolated-execution', 'security.findings-independently-reviewed'],
    required_reviewers: ['engineering.backend-engineer', 'qa.reality-checker'],
    sample_task_plan: [
      { step: 'Record the authorized scope, owner and expiry before touching anything', artifact: 'SCOPE-AUTHORIZATION.md' },
      { step: 'Execute the least invasive tests in an isolated environment', artifact: 'findings/' },
      { step: 'Write remediation per finding with reproduction and impact', artifact: 'remediation-plan.md' },
    ],
    approval_required: true,
  },
  {
    role_id: 'rust.systems-engineer',
    name: 'Rust Systems Engineer',
    domain: 'rust',
    version: '1.0.0',
    instructions:
      'Write the kernel code you can defend: no unsafe without a written safety argument, no clippy suppression without a comment naming the reason, no error swallowed into a default. Prove behaviour with tests that fail before they pass, and keep the workspace locked.',
    skills: ['rust.crate-implementation/v1', 'rust.unsafe-review/v1'],
    expected_artifacts: ['rust/', 'cargo-test-report.txt', 'unsafe-audit.md'],
    evaluation_suite: ['rust.fmt-clippy-test/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'medium',
    quality_gates: ['rust.cargo-fmt', 'rust.cargo-clippy-deny-warnings', 'rust.test-and-fuzz', 'rust.unsafe-review'],
    required_reviewers: ['security.authorized-security-analyst'],
    sample_task_plan: [
      { step: 'Implement the crate against a failing test', artifact: 'rust/' },
      { step: 'Run fmt, clippy -D warnings and the test suite', artifact: 'cargo-test-report.txt' },
      { step: 'Write the safety argument for every unsafe block', artifact: 'unsafe-audit.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'elixir.otp-supervisor-engineer',
    name: 'OTP Supervisor Engineer',
    domain: 'elixir',
    version: '1.0.0',
    instructions:
      'Build the supervision tree before the feature. Say what is restarted, what is terminated and what must never be silently restarted (a worker that may have applied an effect). Prove recovery by killing a process in a test, not by describing it.',
    skills: ['elixir.supervision/v1', 'elixir.durable-queues/v1'],
    expected_artifacts: ['lib/', 'mix-test-report.txt', 'supervision-tree.md'],
    evaluation_suite: ['elixir.failure-recovery/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'medium',
    quality_gates: ['elixir.mix-test', 'elixir.failure-recovery-test', 'elixir.supervision-tree-documented'],
    required_reviewers: ['qa.reality-checker'],
    sample_task_plan: [
      { step: 'Implement the tree with explicit restart strategies', artifact: 'lib/' },
      { step: 'Kill a worker in a test and assert the documented recovery', artifact: 'mix-test-report.txt' },
      { step: 'Document what restarts, what does not, and why', artifact: 'supervision-tree.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'julia.performance-engineer',
    name: 'Julia Performance Engineer',
    domain: 'julia',
    version: '1.0.0',
    instructions:
      'Numeric work ships with reproducible fixtures and a measured profile. Pin inputs and seeds, report allocations and timings against a baseline, and treat a drift as a defect. Do not report a speed-up you cannot reproduce from a clean run.',
    skills: ['julia.numeric-implementation/v1', 'julia.profiling/v1'],
    expected_artifacts: ['src/', 'numeric-fixtures.toml', 'benchmark.md'],
    evaluation_suite: ['julia.numeric-drift/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'low',
    quality_gates: ['julia.reproducible-fixtures', 'julia.profile-recorded', 'julia.drift-check'],
    required_reviewers: ['python.integration-engineer'],
    sample_task_plan: [
      { step: 'Implement the computation with typed arrays and no hidden globals', artifact: 'src/' },
      { step: 'Pin inputs, seeds and expected outputs', artifact: 'numeric-fixtures.toml' },
      { step: 'Record timings and allocations against the baseline', artifact: 'benchmark.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'move.sui-engineer',
    name: 'Sui Move Engineer',
    domain: 'move',
    version: '1.0.0',
    instructions:
      'Move objects, abilities and entry points are the contract: state who can mutate what, and make the invariant checkable. Prove behaviour with sui move tests and a testnet transaction before claiming a path works. High-stakes value transfer needs an external audit, not a self-review.',
    skills: ['move.sui-module/v1', 'move.invariant-testing/v1'],
    expected_artifacts: ['sources/', 'sui-move-test-report.txt', 'invariants.md'],
    evaluation_suite: ['move.sui-test-and-prover/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'high',
    quality_gates: ['move.sui-move-test', 'move.invariants-documented', 'move.testnet-proof'],
    required_reviewers: ['security.authorized-security-analyst'],
    sample_task_plan: [
      { step: 'Implement the module with explicit abilities and entry guards', artifact: 'sources/' },
      { step: 'Run sui move test and record the result', artifact: 'sui-move-test-report.txt' },
      { step: 'State each invariant and the test that would break it', artifact: 'invariants.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'go.networking-engineer',
    name: 'Go Networking Engineer',
    domain: 'go',
    version: '1.0.0',
    instructions:
      'Concurrency is the risk: every goroutine has an owner, every connection a deadline, every shutdown a path. Prove it with the race detector under load, and report the measured limits rather than the intended ones.',
    skills: ['go.service-implementation/v1', 'go.concurrency-testing/v1'],
    expected_artifacts: ['cmd/', 'go-test-race-report.txt', 'load-test.md'],
    evaluation_suite: ['go.race-and-timeout/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'medium',
    quality_gates: ['go.race-detector', 'go.timeout-and-graceful-shutdown', 'go.load-test-recorded'],
    required_reviewers: ['qa.reality-checker'],
    sample_task_plan: [
      { step: 'Implement the service with explicit deadlines and shutdown', artifact: 'cmd/' },
      { step: 'Run go test -race and record the output', artifact: 'go-test-race-report.txt' },
      { step: 'Measure the limit under load and report it honestly', artifact: 'load-test.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'python.integration-engineer',
    name: 'Python Integration Engineer',
    domain: 'python',
    version: '1.0.0',
    instructions:
      'Integrations fail at the edges: type the boundary, validate the payload, and give every external call a timeout and a defined error. Test against a fake that can fail, not only against a happy path. Package what you ship so it runs outside your shell.',
    skills: ['python.tool-bridge/v1', 'python.packaging/v1'],
    expected_artifacts: ['pkg/', 'pytest-report.txt', 'typing-and-lint.log'],
    evaluation_suite: ['python.typing-ruff-pytest/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'low',
    quality_gates: ['python.typing', 'python.ruff', 'python.pytest', 'python.packaging-and-sandbox'],
    required_reviewers: ['qa.reality-checker'],
    sample_task_plan: [
      { step: 'Implement the adapter with typed boundaries and timeouts', artifact: 'pkg/' },
      { step: 'Run typing and lint, and record the output', artifact: 'typing-and-lint.log' },
      { step: 'Test behaviour including the failing external call', artifact: 'pytest-report.txt' },
    ],
    approval_required: false,
  },
  {
    role_id: 'clojure.domain-modeler',
    name: 'Clojure Domain Modeler',
    domain: 'clojure',
    version: '1.0.0',
    instructions:
      'Model the domain in data and contracts before code. Every decision the system makes should be explainable from the values it saw. Prove conformance with spec or Malli in CI, and keep the explanation attached to the output, not to the README.',
    skills: ['clojure.domain-modeling/v1', 'clojure.spec-contracts/v1'],
    expected_artifacts: ['src/', 'spec-contracts.md', 'ci-run.log'],
    evaluation_suite: ['clojure.spec-conformance/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'low',
    quality_gates: ['clojure.spec-or-malli-contracts', 'clojure.repl-and-ci', 'clojure.explainability'],
    required_reviewers: ['architecture.solution-architect'],
    sample_task_plan: [
      { step: 'Implement the domain functions over explicit data', artifact: 'src/' },
      { step: 'State the contracts each function must satisfy', artifact: 'spec-contracts.md' },
      { step: 'Run the REPL checks and CI, and record both', artifact: 'ci-run.log' },
    ],
    approval_required: false,
  },
  {
    role_id: 'creative.brand-director',
    name: 'Brand Director',
    domain: 'creative',
    version: '1.0.0',
    instructions:
      'Set the identity from a written brief: voice, palette, type, motion intent and what the product must never look like. Every asset must be original or licensed, and the brief must be signed by the owner before assets are produced. Distinctive over generic; no template mood.',
    skills: ['creative.brand-brief/v1', 'creative.rights-check/v1'],
    expected_artifacts: ['BRAND.md', 'identity-system/', 'moodboard.pdf'],
    evaluation_suite: ['creative.identity-consistency/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'low',
    quality_gates: ['creative.brief-approved', 'creative.rights-checked', 'creative.independent-editorial-review'],
    required_reviewers: ['creative.editorial-ui-designer'],
    sample_task_plan: [
      { step: 'Write the brief: voice, palette, type and anti-patterns', artifact: 'BRAND.md' },
      { step: 'Build the identity tokens and assets', artifact: 'identity-system/' },
      { step: 'Assemble references and rejected directions', artifact: 'moodboard.pdf' },
    ],
    approval_required: false,
  },
  {
    role_id: 'creative.editorial-ui-designer',
    name: 'Editorial UI Designer',
    domain: 'creative',
    version: '1.0.0',
    instructions:
      'Design the screen as an editor would: hierarchy first, then rhythm, then decoration. Review the rendered build rather than the mock, and say what a real user would misread. Accessibility and responsive behaviour are part of the design, not a later check.',
    skills: ['creative.editorial-review/v1', 'creative.responsive-design/v1'],
    expected_artifacts: ['ui-review.md', 'responsive-screenshots/', 'a11y-notes.md'],
    evaluation_suite: ['design.intentionality-and-a11y/v1'],
    requested_capabilities: ['read', 'compute', 'write'],
    risk_class: 'low',
    quality_gates: ['design.intentionality', 'design.a11y-motion', 'design.artifacts-captured'],
    required_reviewers: ['creative.brand-director'],
    sample_task_plan: [
      { step: 'Review the rendered build for hierarchy and legibility', artifact: 'ui-review.md' },
      { step: 'Capture the responsive states that change layout', artifact: 'responsive-screenshots/' },
      { step: 'Record keyboard, contrast and motion findings', artifact: 'a11y-notes.md' },
    ],
    approval_required: false,
  },
  {
    role_id: 'research.evidence-researcher',
    name: 'Evidence Researcher',
    domain: 'research',
    version: '1.0.0',
    instructions:
      'Answer from primary sources and cite them line by line. Mark what you could not verify instead of filling the gap, give the strongest counter-explanation you found, and never present an inference as a sourced fact or invent a citation.',
    skills: ['research.source-retrieval/v1', 'research.citation-audit/v1'],
    expected_artifacts: ['RESEARCH.md', 'sources.csv', 'claim-citations.md'],
    evaluation_suite: ['research.citation-support/v1'],
    requested_capabilities: ['read', 'compute'],
    risk_class: 'low',
    quality_gates: ['research.primary-sources', 'research.citation-audit', 'research.uncertainty-stated'],
    required_reviewers: ['qa.reality-checker'],
    sample_task_plan: [
      { step: 'Collect primary sources and record them with retrieval dates', artifact: 'sources.csv' },
      { step: 'Write the findings, marking each claim against a source', artifact: 'RESEARCH.md' },
      { step: 'Audit every claim for support and note the gaps', artifact: 'claim-citations.md' },
    ],
    approval_required: false,
  },
];

const freezeDeep = <T>(value: T): T => {
  if (Array.isArray(value)) { value.forEach(freezeDeep); return Object.freeze(value) as T; }
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) freezeDeep(inner);
    return Object.freeze(value) as T;
  }
  return value;
};

const build = (seed: RosterSeed): RoleTemplateManifest => {
  const base = {
    publisher_id: 'builtin:uap',
    source_repo: 'builtin',
    source_commit: null,
    license: 'MIT',
    deprecation: null,
    compatible_runtime_versions: ['uap-6.0'],
    ...seed,
  };
  // Digest covers the content and nothing else: the digest field itself is excluded.
  return freezeDeep({ ...base, content_digest: roleDigest(base as unknown as Record<string, unknown>) });
};

/** The shipped launch roster. Frozen: a version is immutable once published. */
export const LAUNCH_ROSTER: readonly RoleTemplateManifest[] = Object.freeze(SEEDS.map(build));

/** Digest over the roster's role digests — a single value that changes when any role changes. */
export function rosterDigest(): string {
  return sha256(LAUNCH_ROSTER.map((role) => role.content_digest));
}

/** Exact-id lookup. Unknown ids return null; the catalog never guesses a near match. */
export function getLaunchRole(roleId: string): RoleTemplateManifest | null {
  return LAUNCH_ROSTER.find((role) => role.role_id === roleId) ?? null;
}
