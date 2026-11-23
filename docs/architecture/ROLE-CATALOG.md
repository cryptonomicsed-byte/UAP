# Built-in role catalog: the launch roster

Status: implemented in `server/src/roles/launch-roster.ts`, served at
`GET /api/roles/roster` (and `GET /api/roles/roster/:roleId`). Covers checklist
`V6-03-06`; the template **schema** and Markdown ingestion are `V6-03-01/02` (C-17),
dedupe/conflict and policy-override hardening are `V6-03-05/09` (C-19).

## What ships

Fifteen immutable role templates (`platform.roles/v1`), one per family the checklist names:

| Domain | Roles |
|---|---|
| architecture | `architecture.solution-architect` |
| engineering | `engineering.frontend-engineer`, `engineering.backend-engineer` |
| qa | `qa.reality-checker` |
| security | `security.authorized-security-analyst` |
| rust | `rust.systems-engineer` |
| elixir | `elixir.otp-supervisor-engineer` |
| julia | `julia.performance-engineer` |
| move | `move.sui-engineer` |
| go | `go.networking-engineer` |
| python | `python.integration-engineer` |
| clojure | `clojure.domain-modeler` |
| creative | `creative.brand-director`, `creative.editorial-ui-designer` |
| research | `research.evidence-researcher` |

## Manifest shape

The published `RoleTemplate` contract (blueprint §23.3) plus the three fields a roster
entry is useless without (`V6-03-08`):

```
role_id, publisher_id, name, domain, version, source_repo, source_commit, license,
content_digest, instructions, skills[], expected_artifacts[], evaluation_suite[],
requested_capabilities[], risk_class, compatible_runtime_versions[], deprecation,
quality_gates[], required_reviewers[], sample_task_plan[{step, artifact}],
approval_required
```

* `requested_capabilities` uses the Rust kernel's `EffectClass` vocabulary
  (`crates/agentos-policy/src/effect.rs`): `read, compute, write, external_message,
  money, publish, production_change, security_testing, clinical_data`.
* `risk_class` uses the kernel's `RiskTier`: `low | medium | high | critical`.
* `sample_task_plan` steps may only name artifacts from the role's own
  `expected_artifacts` — a plan that produces something else is a plan for a different role.
* `required_reviewers` never contains the role itself: a role cannot sign off its own work.

## Invariants enforced by tests, not prose

1. **Templates request, the kernel grants.** There is no `grants`, `tools`,
   `allowed_tools` or `capabilities` field. A manifest cannot carry authority.
2. **No launch role reaches an elevated effect.** `money`, `publish`, `production_change`
   and `clinical_data` appear in no launch role's requests. Reaching one requires an
   approved grant at execution time, not a catalog entry.
3. **Security testing is gated.** Only `security.authorized-security-analyst` requests
   `security_testing`, its `approval_required` is `true`, and its instructions state the
   authorized-engagement precondition. Every other role carries `approval_required: false`.
4. **Artifacts and gates are objective.** Each role names ≥2 expected artifacts, an
   evaluation suite and ≥1 quality gate with at least one independent reviewer.
5. **Versions are immutable.** The roster, every manifest and every nested list are frozen;
   mutation throws.
6. **Digests are derived.** `content_digest = sha256:` over the manifest JSON with the
   digest field absent, so an edit without a version bump is detectable by recomputation.
   `rosterDigest()` is sha256 over the ordered list of role digests and is served with the
   catalog, so a client can tell which catalog it is looking at.

## Adding or changing a role

1. Add/adjust the seed in `server/src/roles/launch-roster.ts`. Built-in text keeps
   `source_repo: 'builtin'` and `source_commit: null`; ingested text must pin both (C-17).
2. Bump `version` when behaviour changes — the digest changes with the text, so a version
   bump is the only honest way to publish a different role under the same id.
3. Run `node --import tsx --test tests/launch-roster.test.mjs`. The suite fails on a missing
   family, an unknown capability string, an elevated request, a self-review, a plan artifact
   outside `expected_artifacts`, or a digest that does not match the content.

## Deliberately not here

* Markdown/repo ingestion of third-party personas and the JSON-Schema validator (C-17).
* Dedupe/conflict resolution across persona collections and the guard that stops persona
  instructions overriding system policy (C-19).
* Role preview UI, owner-authored custom roles and upgrade diffs (`V6-03-07`).
* Any grant, tool binding or execution wiring: this catalog describes work, it does not
  authorise it.
