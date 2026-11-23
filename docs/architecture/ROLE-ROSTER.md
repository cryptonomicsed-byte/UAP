# Built-in role roster (V6-03-06)

The shipped launch workforce: 16 built-in `RoleTemplate`s composed by
`server/src/roles/builtin-roster.ts` out of C-17's schema (`role-template.ts`), so a
SID cites the same `(id, version, digest)` triple an imported persona would
(`sidRoleRef`). This is data, not running agents: an installation is a separate SID.

Catalog: **16 templates** across **14 families**; catalog digest
`5144510203df8af72ea17b3482cabfff67223c9769a3506883b0998701524ce9` (computed by a
test, never a hand-copied constant).

| Role id | Title | Family | Risk | Gates | Expected artifacts | Required reviewer |
|---|---|---|---|---|---|---|
| `rt_uap_solution-architect` | Solution Architect | architecture | medium | gate.contract-tests, gate.maintainability | ARCHITECTURE.md, docs/adr/*.md | rt_uap_code-reviewer |
| `rt_uap_backend-engineer` | Backend Engineer | backend | medium | gate.tests-ci, gate.security-checks | changes.patch, test-report.json | rt_uap_code-reviewer |
| `rt_uap_frontend-engineer` | Frontend Engineer | frontend | medium | gate.tests-ci, gate.a11y-ui | changes.patch, screenshots/*.png, a11y-report.json | rt_uap_brand-director |
| `rt_uap_code-reviewer` | Code Reviewer | qa | low | gate.review-completeness, gate.reproducible-evidence | review.json, REVIEW.md | rt_uap_reality-checker |
| `rt_uap_reality-checker` | QA Reality Checker | qa | low | gate.live-build, gate.no-mock-evidence | test-log.txt, verdict.json | rt_uap_code-reviewer |
| `rt_uap_security-reviewer` | Authorized Security Reviewer | security | high | gate.scope-authorization, gate.evidence-validation | SCOPE.md, findings.json | rt_uap_reality-checker |
| `rt_uap_rust-systems-engineer` | Rust Systems Engineer | rust | high | gate.rust-fmt-clippy, gate.rust-tests-fuzz | changes.patch, clippy.txt, test-report.json | rt_uap_security-reviewer |
| `rt_uap_elixir-otp-engineer` | Elixir OTP Engineer | elixir | medium | gate.elixir-tests, gate.otp-failure-recovery | changes.patch, test-report.json | rt_uap_code-reviewer |
| `rt_uap_julia-performance-engineer` | Julia Performance Engineer | julia | low | gate.julia-repro-fixtures, gate.julia-drift | changes.patch, profile-summary.md, fixtures/ | rt_uap_reality-checker |
| `rt_uap_move-sui-engineer` | Sui Move Engineer | move | high | gate.move-tests, gate.move-invariants | sources.patch, move-test-report.txt | rt_uap_security-reviewer |
| `rt_uap_go-networking-engineer` | Go Networking Engineer | go | medium | gate.go-race, gate.go-load | changes.patch, race-report.txt | rt_uap_code-reviewer |
| `rt_uap_python-integration-engineer` | Python Integration Engineer | python | medium | gate.python-typing, gate.python-pytest | changes.patch, pytest-report.json | rt_uap_code-reviewer |
| `rt_uap_clojure-domain-modeler` | Clojure Domain Modeler | clojure | low | gate.clojure-spec, gate.clojure-repl-ci | changes.patch, spec-report.edn | rt_uap_solution-architect |
| `rt_uap_brand-director` | Brand Director | creative | low | gate.design-brief, gate.a11y-ui | BRAND.md, design-brief.md | rt_uap_motion-director |
| `rt_uap_motion-director` | Motion Director | creative | low | gate.motion-intent, gate.a11y-motion | MOTION.md, recorded_demo.webm | rt_uap_brand-director |
| `rt_uap_evidence-analyst` | Evidence Research Analyst | research | low | gate.citations, gate.alternate-hypotheses | REPORT.md, sources.json | rt_uap_reality-checker |

## Where the persona text lives

The canonical instruction text is exported to `docs/roles/<slug>.md` by
`npm run roles:export` (from the roster module, which is the source of truth). A test
reads every export and fails if it is not byte-identical to the template
instructions, so a reviewer's copy cannot drift from the bytes the digest pins.

## Invariants enforced by `validateRoster` / `validateBuiltinRoster`

1. **One schema.** Every entry is built by `buildRoleTemplate`, passes
   `verifyRoleTemplate`, and cites `rt_uap_<slug>` — no parallel template shape and no
   second digest.
2. **Immutable identity.** `(id, version)` appears once; the schema's digest binds
   persona text, title, risk class, rights and requested tools. Editing any of them
   breaks `verifyRoleTemplate`.
3. **Deep-frozen.** Callers cannot rewrite a shipped role or template in place.
4. **Narrow requests.** `requestedTools` is an allow-list; no role may request
   `payment.execute`, `deployment.publish` or `secret.read`, and the roster refuses a
   role that requests something on its own denial list.
5. **Independent review.** At least two namespaced gates, at least one expected
   artifact, and a required reviewer that exists in the roster and is not the role.
6. **Trial provenance.** Roles ship `trial` on `LicenseRef-UAP-Internal` rights with
   `status: declared`. For owned roles the upstream fields are content pins:
   `sourceSha` is the sha256 of the persona bytes at `sourcePath`, and validation
   refuses an entry whose pin is not its own content hash. An imported persona must
   carry a real upstream commit SHA instead.

## Consuming it

```ts
import { BUILTIN_ROSTER, getBuiltinRole, sidRoleRef, validateBuiltinRoster } from '../server/src/roles/builtin-roster.ts';

validateBuiltinRoster();                                     // throws RosterError on drift
const role = getBuiltinRole('rt_uap_rust-systems-engineer'); // latest version
issueSid({ roleTemplate: sidRoleRef(role), ... });           // { id, version, digest }
```

## Deliberate non-claims

- Gate and artifact ids are **references**. The registry that evaluates gates and binds
  artifacts is V6-03-08's scope; this item authors the roster, not the evaluator.
- No external persona is imported, so no upstream SHA or licence is claimed. Rights
  review of imported collections is track B.
- `trial` is the honest state: the roster is unit-tested, but rights review and
  registry-backed gate evaluation are not complete, so nothing is `active`.
