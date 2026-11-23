# AGENT-DECISIONS.md — UAP

Log of decisions made by agents working this repo. Read top-down; newest first.

## Progress log (newest first; evidence only — no checklist box is ticked by the implementer)

### 2026-11-23 — C-19 (track C): role dedupe/conflict + policy-override guard

Board: claimed `C-19`; implemented V6-03-05 and V6-03-09. No checklist box is ticked and
nothing is self-approved.

Built
  * `server/src/roles/role-review.ts` — one review step over C-17's built templates:
    `reviewRoleTemplates()` returns `accepted / rejected / duplicates / conflicts / superseded`
    and is deterministic (shuffled input gives a byte-identical result, every bucket sorted).
  * Dedupe: exact copies at the same id+version+digest collapse to one and the dropped copy is
    named; a newer version supersedes older ones and the upgrade is recorded
    (`{id, version, superseded_by}`); two different bodies at the same id+version is a
    `digest_mismatch` conflict and the id is **not installable** — the platform does not choose
    by input order; identical instruction bodies under two ids install but are flagged
    `content_overlap` (role explosion is a human decision).
  * Policy guard: seven documented override classes (`ignore_instructions`,
    `prompt_extraction`, `safety_disable`, `identity_hijack`, `secret_read`,
    `privilege_escalation`, `covert_action`) matched over normalised text — NFKC (fullwidth),
    zero-width stripped **and** zero-width-as-space (so `Ig<zw>nore` and `Ignore<zw>all` both
    fail), lowercased, whitespace collapsed. `scanInstructions()` returns findings with rule,
    label, match and offset; `assertPolicySafe()` throws `PolicyOverrideError`.
  * A rejected role is removed before dedupe, so one poisoned persona cannot block a clean
    collection; its findings are returned, not logged away.
  * `POST /api/roles/review` (session required) builds via C-17's `buildRoleTemplate`, then
    guards and dedupes. 400 with `{error, message}` on an empty/oversized collection, a failed
    schema build, or an invalid collection; nothing is persisted (preview only).
  * Docs: `docs/architecture/ROLE-REVIEW.md` (buckets, rule table, false-positive policy, and
    the explicit statement that the guard is a review gate, not the defence).

Tests (test-first: `tests/role-review.test.mjs` was written and watched fail with
`ERR_MODULE_NOT_FOUND`, then the normalisation case failed on the zero-width variant, then the
HTTP case failed until the route existed)
  * `node --import tsx --test tests/role-review.test.mjs` — 12 passed (seven override classes,
    four evasion variants, six benign strings that must not be flagged, typed refusal,
    duplicate collapse, digest_mismatch non-installability, supersede record, content overlap,
    determinism under reversal, typed invalid-input errors, HTTP 200/400/401).
  * `npm test` — 137 tests, 137 pass, 0 fail. `npm run typecheck` clean.
  * `cargo test --workspace --locked` — 69 passed, 0 failed (no Rust change in this item).

Not claimed
  * Markdown repository ingestion and source pinning remain C-17 / V6-03-02.
  * Paraphrased duplicates are not detected; only exact instruction bodies. That limitation is
    stated in the doc rather than papered over with a fuzzy score.
  * No catalog persistence, preview UI or owner-authored roles (V6-03-06/07).

Coordination note (not an item)
  * `scripts/claim.py` handed C-18 to worker-a although worker-b had claimed it eight minutes
    earlier. The C-18 work was not pushed to `main`: it is preserved on branch
    `wa/c18-roster-proposal` for comparison, and the ledger still shows C-18 claimed by
    worker-b. `claim.py` does not yet refuse an item claimed by another worker.

Next unclaimed item: whatever `scripts/claim.py` hands out next (C-19 was the last pending C
item at claim time).

### 2026-11-23 — C-18 (V6-03-06): built-in launch roster

Board: claimed `C-18`. Authored the 16-role launch roster in
`server/src/roles/builtin-roster.ts`, exported personas under `docs/roles/`, and
documented it in `docs/architecture/ROLE-ROSTER.md`; no checklist box is self-ticked.

  * The roster **composes C-17's schema** rather than a parallel one: every entry is
    built by `buildRoleTemplate` and cited as `rt_uap_<slug>`, so a SID uses the same
    `(id, version, digest)` triple as an imported persona (`sidRoleRef`), and
    `verifyRoleTemplate` re-checks each shipped digest.
  * Families shipped: architecture, backend, frontend, QA (code reviewer + reality
    checker), security, the seven launch languages (Rust, Elixir, Julia, Sui Move, Go,
    Python, Clojure), creative (brand + motion) and research — 16 roles, 14 families.
    `validateBuiltinRoster()` fails if any family loses its role.
  * Personas are real reviewed prose, exported byte-identically to `docs/roles/<slug>.md`
    (`npm run roles:export`; a test fails if an export drifts). For owned roles the
    provenance fields are content pins: `sourceSha` is the sha256 of the persona bytes at
    `sourcePath`, and validation refuses any other value. Nothing upstream is claimed.
  * Roles are deep-frozen and ship `trial` on `LicenseRef-UAP-Internal` rights. No role
    may request `payment.execute`, `deployment.publish` or `secret.read`; requests must
    not intersect the role's denial list; each role needs ≥2 namespaced gates, ≥1
    expected artifact and a required reviewer that exists in the roster and is not
    itself.

Tests (test-first: `tests/roles-roster.test.mjs` first failed with
`ERR_MODULE_NOT_FOUND`, then with the missing `docs/roles/` exports, then 12/12 pass):
family coverage, C-17 digest recomputation + tamper detection (title, instructions,
risk class, tools), deep-freeze, hard-denial disjointness, content-pin provenance,
export byte-equality, independent reviewer, SID triple, and negative cases
(`duplicate_template`, `reviewer_not_independent`, `requested_work_denied`,
`source_sha_mismatch`, `gates_missing`).

Non-claims: gate/artifact ids are references — their registry and evaluation are
V6-03-08; C-19 owns dedupe/policy-override/Hermes translation. The roster is `trial`,
not active, because rights review and registry-backed gate evaluation are open.

### 2026-11-23 — C-17 (track C): RoleTemplate schema + Markdown persona parser

Board: claimed `C-17`. Checklist boxes are not self-ticked.

Built
  * `server/src/roles/role-template.ts` — the V6-03-01 schema: `id` derived from
    publisher + slug (stable across versions, another source gets another id),
    `version`, `sourceSha` (40/64 lower-case hex git commit), `sourcePath`
    (relative `.md`), `title`, `riskClass` (low|medium|high|critical), `rights`
    (SPDX licence or NOASSERTION, http(s) source URL, attribution; derived
    `status: declared|unverified`, never silently "cleared"), `instructions`,
    `requestedTools` (sorted, deduplicated, names only) and a sha256 `digest`
    over canonical JSON of every bound field. `verifyRoleTemplate` recomputes
    the digest from the stored object, so a template is never trusted on the
    strength of the store. `assertVersionImmutable` refuses a changed digest at
    an existing version (`version_immutable`), an older version
    (`version_regression`) and a cross-id write (`id_mismatch`).
  * `server/src/roles/persona-parser.ts` — the V6-03-02 parser: YAML
    frontmatter + H1 fallback title, byte-exact `body` and `canonicalMarkdown`
    for provenance, tool declarations split/unwrapped/normalised into
    `requestedTools`, non-name declarations kept in
    `unparsedToolDeclarations` instead of dropped, and `permissions` / `grants`
    / `capabilities` / `authorization` / `allow` recorded in
    `ignoredAuthorityFields` — visible, never applied. Repository digest is
    sha256 over `path\0content\0` in path order; duplicate paths, traversal,
    absolute/non-`.md` paths, NUL bytes, invalid YAML and >1 MiB files are
    refused with named codes.
  * `roleTemplateRef` projects a template to the `SidRoleTemplate` shape that
    D-13/D-14 already persist — id, version, digest only; instructions and
    requested tools never travel into the identity record.
  * `docs/architecture/ROLE-TEMPLATES.md` — schema table, digest rules, parser
    guarantees and the explicit non-claims (no registry write, no dedupe, no
    policy-override guard, no grants).

Decisions taken without asking
  * A slug that looks like a path (`../etc/passwd`) is refused, not normalised
    into a different role id: the id is the handle grantees cite.
  * Reviewed text is trimmed before binding, so surrounding whitespace cannot
    mint a second digest for the same reviewed value; a real edit still does.
  * Template input drops unknown properties and always recomputes the digest,
    so an over-posted `grants` cannot ride along, and a caller cannot supply a
    digest that does not match the fields.

Tests (test-first, negative paths first: both files were watched failing with
`ERR_MODULE_NOT_FOUND` before `server/src/roles/` existed; two expectations
were corrected in GREEN — a title-with-trailing-space variant is a
normalisation, not a new binding, and a higher version is an upgrade, not a
regression)
  * `tests/role-template.test.mjs` 8/8 — id stability/fork isolation, digest
    key-order independence and coverage of every field, tamper refusal,
    14 invalid-input codes, no authority fields, honest rights status, version
    immutability, SID reference projection.
  * `tests/persona-parser.test.mjs` 6/6 — byte-exact body, H1/title refusal,
    tool requests vs ignored authority fields, path/digest determinism,
    traversal/NUL/size/YAML refusals, parser → template round-trip.
  * Full: `npm test` 109 passed (0 failed); `npm run typecheck` clean;
    `npm run build`, `audit:branding`, `audit:rights` pass;
    `cargo test --workspace --locked` 69 passed; `mix test` 61 tests, 0
    failures (12 excluded).

Not claimed
  * No persistence: a registry writer into `uap.role_template_versions` that
    calls `assertVersionImmutable` first belongs to C-18/C-19.
  * Dedupe/conflict resolution, policy-override guard and Hermes role
    translation (V6-03-05/09/10) remain open (C-19).

Next unclaimed item: C-18 (launch roster) per the board.
### 2026-11-23 — D-16 (track D): deletion/privacy propagation with evidence retention

Board: claimed `D-16`; implemented V6-04-10. No checklist box is ticked and nothing is
self-approved.

Built
  * **Plan over holders, not one DELETE.** `server/src/privacy/holders.ts` names where agent
    data lives: memory files (each entry), conversation history (every generation of `rows`,
    `llm_items`, `pending_turns`), the cached live state, the derived memory index and audit
    evidence. A holder that throws makes the request `partial`; the failed bytes stay and the
    error is recorded. Completion requires every target `done`/`absent`/`retained`.
  * **Evidence retention is explicit, not a skip.** Approval rows are content-free audit
    evidence; they are retained under `audit:approval_history`, recorded on the target and
    committed to in the receipt. An unknown or missing rule fails planning. Content holders
    may not retain.
  * **Index propagation is real.** Migration 7 adds the derived `memory_index` /
    `memory_index_sources`; `GET /api/bots/:id/memories?q=` searches it, single-memory delete
    drops it, and erasure writes a `(bot_id, content_hash)` tombstone that blocks a rebuild
    from resurrecting the bytes.
  * **Receipt chain.** Completion writes an HMAC-SHA256 receipt over the request, its targets
    and the previous receipt for the agent; `verifyDeletionReceipt` recomputes it. Receipts and
    tombstones have no FK to agents/accounts, so erasing a subject cannot erase the proof.
  * **Idempotency.** Same `requestKey` → same request; reusing it for another agent/basis →
    409; a completed request reruns as a no-op with unchanged receipt and completion time.
  * API: `POST /api/privacy/deletions`, `GET /api/privacy/deletions[?botId=]`,
    `GET /api/privacy/deletions/:id` (with `receiptVerified`),
    `POST /api/privacy/deletions/:id/retry`, owner-scoped with 400/404/409 error states.
  * Docs: `docs/architecture/PRIVACY-DELETION.md` (holders, states, receipt format, what is
    deliberately not reached: object storage, Postgres SID rows, backups — E2E-156/V3-Z-07).

Tests (test-first: all three files were written and watched fail — module missing, then 404s —
before the modules/routes existed)
  * `tests/memory-index.test.mjs` — 5 passed (scoping, AND-terms, removal, tombstone, empty query).
  * `tests/privacy-deletion.test.mjs` — 6 passed (planning/ownership/basis, every holder planned,
    real file+DB+cache+index erasure, evidence retained, idempotency, partial→retry, tamper
    detection and receipt survival).
  * `tests/privacy-api.test.mjs` — 3 passed against a real server + owner session (search→delete
    propagation, POST run + verified GET, repeated key, 400/404/409).
  * `npm run typecheck` clean.

Not claimed
  * Account-wide erasure across object storage/artifacts, Postgres SID tenant rows, external
    providers and backups is E2E-156 / V3-Z-07, not this item.
  * No scheduler releases retained evidence after a legal-hold period.
  * Next unclaimed item: whatever `scripts/claim.py` hands out next.

### 2026-11-23 — D-15 (track D): SID pause / resume / archive

Board: claimed `D-15` (pause/resume/archive). Implemented and tested in one commit;
the checklist box is not self-ticked.

Built (`server/src/storage/postgres/lifecycle-schema.ts`, migration 11; service
`server/src/identity/lifecycle.ts`; doc `docs/architecture/SID-LIFECYCLE.md`)
  * State machine lives in the database (`uap.apply_sid_lifecycle` behind
    `pause_sid_instance` / `resume_sid_instance` / `archive_sid_instance`), so the
    API, the worker and an operator on psql cannot disagree about what a transition
    means. Pause keeps the SID, its identity hash and its installations; resume only
    accepts `paused`; archive retires live installations (`removed`) and is terminal.
  * A revoked SID is final: lifecycle refuses it rather than resurrecting it, so
    revocation authority (D-14) stays the last word.
  * `uap.sid_lifecycle_events` is an append-only log (one row per transition, `seq`
    per SID, reason 3–500 chars, actor, epoch ms). `UPDATE`/`DELETE`/`TRUNCATE` raise
    `42501` for every role including the owner; the app login holds `SELECT` only.
  * Roles: pause/resume owner|admin|member; archive owner|admin only.
  * Migration renumbered to **11** during the rebase onto D-14's migration 10.
    `grantApplicationRole` and `assertApplicationRole` allowlists now carry the
    three new function names (count 14); `SELECT` added on the log table.

Reasoning (design choices)
  * Pause is not deletion and not cancellation: an in-flight lease may still settle,
    because the installation row is untouched. Archive is the destructive act and is
    the one that removes installations.
  * A foreign SID returns `sid_missing`, not "forbidden": confirming existence across
    tenants is itself a leak.

Tests (test-first: the 10 lifecycle tests were written and watched fail —
`ERR_MODULE_NOT_FOUND` for `server/src/identity/lifecycle.ts` — before the service and
migration existed)
  * `node scripts/test-postgres.mjs sid-lifecycle.test.mjs` → **10/10 pass** on real
    PostgreSQL 16 (disposable harness).
  * Full `node scripts/test-postgres.mjs` → **15 files, all exit 0**.
  * `npm test` 96/96; `npm run typecheck` clean (server + web); `cargo test
    --workspace --locked` 69 passed; `mix check` 61 tests, 0 failures (12 excluded).

Not claimed
  * Work admission is **not yet wired** to SID status in the queue, worker or tool
    dispatch (track F/G); until then pause is a state change with audit evidence, not
    an enforced quota. Stated the same way in the doc.
  * No UI/route surface (`agents.pause`), no delete/privacy propagation (D-16).

### 2026-11-23 — M1 (track E): Rust policy kernel, M1-03..M1-07

Board: claimed and closed `M1-03`, `M1-04`, `M1-05`, `M1-06`, `M1-07` in order, each with
its own commit and evidence string. One item per claim; no item was marked verified.

Built (`crates/agentos-policy`, new Rust workspace member — the permission authority)
  * **M1-03** scaffold + canonical identifiers (`ids`): TenantId/Sid/ToolName/RefId are
    charset- and length-validated at construction; Digest has exactly one spelling
    (64 lowercase hex). Rationale: the kernel compares ids with `==`, so a second
    spelling of a tenant or a `*` inside a target makes every exact-match check a lie.
  * **M1-04** `ActionIntent`, `ResourceScope`, `ResourcePattern`, `EffectClass`,
    `RiskTier`, `Spend`, `canonical` writer. A dispatch target can never hold a
    wildcard (unrepresentable, not merely rejected); a grant pattern is exact,
    `prefix/*` (boundary-aware) or `*`. Intent digest covers all 16 fields, so any
    swap is tamper-evident. External effects require an idempotency key.
  * **M1-05** signed `Grant` and `TaskLease` (Ed25519 over canonical bytes, separate
    domain tags), `Budget` ceilings, 24 h hard lease cap, epoch ≥ 1, revocation
    reference inside the signed bytes.
  * **M1-06** `PolicyKernel`: 26 ordered dispatch checks each returning a stable
    reason code, one-use permits bound to the intent digest, replay protection
    (intent id per tenant; idempotency key across leases), human approvals bound to
    the argument digest + approver clearance, admission ledger with concurrency
    ceiling and sweep, advisory verdicts recorded and never consulted, per-decision
    audit trail. `docs/architecture/POLICY-KERNEL.md` is the contract doc.
  * **M1-07** golden fixtures + four independent verifiers
    (Rust `verify-lease` bin, `scripts/verify-lease.py`, `verifiers/go/`,
    `verifiers/verify_lease.exs`) + `scripts/portable-lease-check.sh` harness.
    Fixtures are generated by the checked-in `mint-fixtures` tool from the published
    seed `[7u8; 32]`; a test re-mints and byte-compares so the "golden" set cannot be
    hand-edited.

Tests (test-first throughout; each item's RED output is in its commit body)
  * `cargo test --workspace` → **69 passed, 0 failed** (dispatch 30, lease 12,
    intent 12, portability 8, scaffold 5, unit 2); same in `--release --locked`
    (release profile has `overflow-checks = true`).
  * `cargo clippy --workspace --all-targets -- -D warnings` → clean;
    `cargo fmt --all -- --check` → clean.
  * `REQUIRE_ALL=1 bash scripts/portable-lease-check.sh` → **5 fixtures × 4
    languages = 20 verifier runs, all agree**, and all four rebuild identical
    canonical bytes (sha256 equal per fixture). Receipt:
    `docs/evidence/policy/portable-lease-report-2026-11-23.txt`.
  * Negative fixtures proven, not asserted: one changed field after signing →
    invalid; corrupted signature → invalid; unknown field → rejected by the schema
    before any crypto; a validly signed foreign tenant/SID fixture still verifies
    (no hardcoding).

CI: new jobs `rust` (fmt + clippy + debug/release tests) and `policy-portability`
(Rust+Go+Elixir+Python, `REQUIRE_ALL=1`, so a missing toolchain fails rather than
skips) in `.github/workflows/foundation.yml`.

Not claimed (honest gaps, next owners)
  * **V6-05-05** is implemented as a kernel capability (`authorize` is cheap and
    stateless enough to call per privileged call, and the tests prove a mid-task
    revocation denies the next call), but *wiring it into the isolated executor* is
    track F: the Elixir worker must call it before every tool invocation.
  * **V6-05-04** enforces reserved ceilings and concurrency; real metering of
    CPU/RAM/GPU/cloud/event spend (against actual usage) is track F/Q.
  * **V6-05-07** implements approval verification and binding; the human review UI
    that displays exact arguments is track Q.
  * Kernel state is in-memory by design; persistence, single-writer discipline and
    the transactional outbox are track F (`uap.task_jobs`).
  * No checklist box is ticked and no item is self-verified: an independent grader
    still has to re-run the suites at the recorded SHAs.


### 2026-11-23 — M0: reproducible build + test baseline (M0-02)

Board: claimed `M0-02` via `scripts/claim.py` before completion (claim 5332437).

Built
  * `scripts/lib/reproducible.mjs` — `hashTree()` (sorted, content-hash manifest of a
    build output tree) and `compareTrees()` (names every changed/added/removed file;
    a boolean would hide the drift).
  * `scripts/reproducible-build.mjs` — materializes the tracked tree with
    `git archive <rev>` into N isolated dirs, runs optional install + build commands,
    hashes the output dir and compares runs file by file. Exit 0 identical, 1 divergence
    (paths listed), 2 the check could not run (build failed / output missing / empty
    output dir) — an empty or missing output tree is never counted as reproducible.
    Receipts: `manifest-runN.json` + `reproducibility-report.json`
    (`source.sha` binds the run to the built revision).
  * `npm run repro:build` — the full check for `web/dist` and `server/dist`.

Tests (test-first, watched fail with ERR_MODULE_NOT_FOUND)
  * `node --import tsx --test tests/reproducible-build.test.mjs` → 6/6 pass.
    Negative paths proven: a build that writes `Date.now()+Math.random()` → exit 1 with
    `changed: ["dist/app.js"]`; a build command that exits 3 → exit 2 naming the build;
    a build that produces no output dir → exit 2 naming the output.

Real runs (two clean `npm ci` + `npm run build` per artifact, isolated git-archive copies)
  * web/dist → PASS, 2 builds byte-identical, 5 files.
  * server/dist → PASS, 2 builds byte-identical, 112 files.
  * Reports committed: `docs/rights/evidence/2026-11-23/reproducible-{web,server}-report.json`.
  * Test baseline: `npm test` → 76/76 pass (36.1 s) at node v24.22.1,
    `docs/rights/evidence/2026-11-23/test-baseline.txt`.

Not claimed
  * Reproducibility is proven for this host/toolchain (node v24.22.1, npm 11.19.1). A
    cross-host/cross-OS proof and a locked toolchain digest are still track R work.

Next: **M1-03 — `agentos-policy` Rust crate scaffold** (workspace member with a real
test target; then M1-04 ActionIntent/ResourceScope, M1-05 Grant/Budget/Lease, M1-06
dispatch validation with negative tests, M1-07 portable lease fixtures).

### 2026-11-23 — M0: rights/supply-chain gate + architecture freeze

Track: **A (V6-01-06, V6-01-07)** — the first two M0 items.

Built
  * `scripts/lib/sbom.mjs` — CycloneDX 1.5 SBOM from `package-lock.json` (workspace link
    records and the root record are first-party, not components), SPDX expression
    evaluator (OR = any branch, AND = all, WITH = base verdict, unknown/pointer/missing
    = false) and a fail-closed license verdict.
  * `scripts/lib/asset-rights.mjs` + `docs/rights/ASSET-RIGHTS.json|.md` — every bundled
    image/font/audio/video/model asset must have a rights row (sha256 + origin +
    license); unregistered, tampered, incomplete and vanished-registry rows all fail.
  * `scripts/audit-rights.mjs` — CLI writing `sbom.cdx.json`, `license-report.json`,
    `asset-manifest.json`, `rights-report.json`; exit 0 clean / 1 violations / 2 cannot
    audit (unreadable lock or policy without an allow list). The report binds itself to
    the lockfile bytes via `lockSha256`.
  * `docs/rights/LICENSE-POLICY.json` — allow list (MIT, Apache-2.0, ISC, BSD, MPL-2.0,
    Unlicense, …) and explicit deny list (GPL/AGPL/SSPL/BUSL/Elastic) so a copyleft
    dependency cannot slip in by being "not mentioned".
  * `docs/architecture/ARCHITECTURE-FREEZE.md` — V6-01-06: Rust policy owns permission,
    Elixir owns ephemeral execution, Hermes owns reasoning, Postgres owns truth, one
    queue (`uap.task_jobs` + `uap.job_worker_grants`), one ledger (absent today, stated
    as absent on purpose).
  * CI: new `rights` job in `.github/workflows/foundation.yml` runs the audit, runs the
    audit's own negative-path tests, and uploads `artifacts/rights/` as
    `rights-sbom-evidence` (fails if the artifact is missing). `npm run check` now ends
    with `audit:rights`.

Tests (test-first; `tests/rights-audit.test.mjs` was written and watched fail with
ERR_MODULE_NOT_FOUND before any implementation existed)
  * `node --import tsx --test tests/rights-audit.test.mjs` → 9/9 pass.
    Negative paths proven: GPL-3.0-only dependency → exit 1 with `not-allowed`;
    malformed lockfile → exit 2 (never a silent pass); policy without allow list →
    exit 2; unregistered asset, hash mismatch, registry row whose file is gone → exit 1.
  * `npm run audit:rights` → PASS, 246 third-party components (MIT 193, Apache-2.0 27,
    MPL-2.0 13, ISC 11, BSD-3-Clause 1, Unlicense 1), 1 bundled asset registered.
  * `npm test` → 70/70 pass (was 69/70: the owner-setup server test flaked under full-suite
    load at a 10 s startup budget while passing in isolation; both its startup budget
    (→30 s) and test timeout (→45 s) were raised, no startup behaviour changed).

Evidence artifacts
  * `docs/rights/evidence/2026-11-23/sbom.cdx.json` + `rights-report.json` committed as
    the run receipt (lockSha256 50fa26cf…).

Not claimed
  * V6-01-07 also asks for *asset/font rights manifests* completion across all future
    imports and a reviewer-signed promotion step — that reviewer/registry lifecycle is
    track B/R work, not ticked here.
  * No checklist box is checked; an independent grader is still required.

Next: **M1 — create the Rust `agentos-policy` workspace crate** (`ActionIntent`,
`ResourceScope`, `Grant`, `Budget`, `Lease`, dispatch validation, one-use permits,
replay protection, portable lease verification + golden fixtures). Negative tests first.

## 2026-11-23 — Foundation = UAP itself (supersedes blueprint's OpenMausBot seed)

Context
  The v6 master blueprint (now archived in docs/v6-blueprint/) locked decision #7:
  "Start the authorized Apache-licensed subset of milind-soni/OpenMausBot as the
  preferred application/desktop seed." AgentOS contained only that spec; UAP is the
  implementation the spec describes and is already running in production at
  uap.omokoda.duckdns.org.

Decision (owner-directed, yolo mode)
  UAP is the build foundation. The v6 checklist and blueprint are merged into this repo
  as docs/v6-blueprint/ and govern the build from here. AgentOS stays as the spec
  archive, not the implementation home.

Rationale
  * UAP is our own code: no enterprise/ stripping, trademark/mascot removal, or fork
    update policy — the whole M0 rights risk the OpenMausBot seed carried
    (V6-01-01..V6-01-10) collapses to "audit our own tree".
  * Hermes-native and live: the blueprint's locked decision that "Hermes remains primary
    reasoning engine" is already true here, not a parity gate to prove.
  * PostgreSQL sessions, tenant metadata, fenced durable executor and a fail-closed
    durable boundary already exist — tracks D/E/F/G start from real code instead of zero.

Consequences
  * Blueprint locked decisions are historical; this log is authoritative where they
    conflict (foundation seed only — all other locked decisions stand).
  * OpenMausBot/Bot HQ are referenced only for adapter patterns (track G), never as the
    shell or a second reasoning master.
  * The checklist is ADDITIVE and none of its 235 items may be auto-ticked; the
    no-self-approval rule stays.

Next
  Execute the checklist against this repo, M0 first (own-tree rights audit + SID
  fixtures), then M1 (Rust policy/lease contracts), recording evidence in this file.

## 2026-11-23 — M2-08 agentos_worker OTP scaffold (worker-b)

Decision
  The Elixir worker lives at `elixir/agentos_worker` (mix app `:agentos_worker`,
  target `~> 1.14`, CI on OTP 27 / Elixir 1.17). Scaffold only: one root supervisor
  owning a unique `Registry` and a `:one_for_one` `DynamicSupervisor`, plus a
  `status/0` read-out taken from the live supervisors.

Why this shape
  * Architecture freeze authority #2 gives task lifecycle to this app; keeping the
    tree to two long-lived children leaves queue claiming/fencing (M2-10), the
    per-task GenServer + SID/lease binding (M2-09) and reconciliation (M2-11) to
    the items that own them — the scaffold does not pre-empt their semantics.
  * Ephemeral tasks are `:temporary` children: a crashed task is not silently
    restarted by the supervisor; `UNCERTAIN` reconciliation must be explicit.
  * `status/0` reports `tasks: nil` when the task supervisor is down. An idle
    worker (0) and a dead worker (`nil`) must not look alike.

Tests (test-first: scaffold/status/teardown suites were written and watched fail
to compile with `AgentosWorker.Registry.via/1 is undefined` before lib/ existed)
  * `mix test` → 8/8 pass. Negative paths: duplicate registry key →
    `{:error, {:already_started, pid}}`; terminating a dead pid →
    `{:error, :not_found}` (never a silent ok); status with the task supervisor
    stopped → `task_supervisor: nil, tasks: nil`.
  * Teardown: terminated task → `:shutdown` DOWN, registry key reclaimed,
    `active: 0`.
  * `bash scripts/test-elixir.sh` → `mix check` (format --check-formatted,
    warnings-as-errors compile, tests) passes; CI job `elixir-worker` added.
  * Root suites after the change: `npm test` 76/76 pass; `cargo test
    --workspace --locked` all pass.

Not claimed
  * No checklist box is checked; M2 gate still needs M2-09..M2-12 and an
    independent grader.

Next unclaimed item: **M2-11 restart/cancel/UNCERTAIN reconciliation** (M2-09 and
M2-10 were claimed by other workers).

## 2026-11-23 — M2-12 1/10/100 concurrency staging drill (worker-b)

Decision
  The queue's concurrency claim is proven by a repeatable drill, not a load-test
  opinion: `AgentosWorker.Staging.Concurrency` runs 1, 10 and 100 concurrent
  worker processes against a real PostgreSQL queue and returns a report whose
  every check is a counted fact plus a violation string. The ExUnit test fails on
  any violation; CI job `elixir-staging` uploads the report.

Why this shape
  * The drill drives the **worker login** for every privileged transition and
    uses the **admin login** only to seed tenant fixtures — the same authority
    split as production, so a passing drill cannot be an artefact of superuser
    table access.
  * Exactly-once is checked in the ledger, not inferred: `N` succeeded runs for
    `N` jobs, one claimed/succeeded event per job, no duplicated
    `(job_id, event_type)` pair, `3N` outbox rows, and every job still on lease
    generation 1 / attempt 1 (nothing was silently reclaimed or retried).
  * Every lease is settled twice. The second settlement must be refused with
    `StaleLeaseError`; an accepted repeat is a violation.
  * The claim phase ends with one drain on the test process: a worker may see an
    empty queue while another claim still holds the last row's lock, so "empty"
    is only final after the fleet and the drain have both stopped.
  * Database connections are capped at 20 for the 100-process level. 100 worker
    processes contending for a realistic pool is the shape being stressed; 100
    raw connections would only test `max_connections`.

Tests (test-first: `AgentosWorker.Staging.Concurrency.run/1` was written as a
call in the staging test and watched fail with `UndefinedFunctionError` before
`lib/agentos_worker/staging/concurrency.ex` existed)
  * `mix test.staging` (disposable PostgreSQL, admin + worker logins, real
    migrations): 1 → 1 job, 10 → 10, 100 → 100; claimed/unique/settled all equal
    the level, repeat refusals equal the level, states `%{"succeeded" => N}`,
    violations `[]`. Observed 302–562 ms (1), 541–719 ms (10), 3.2–3.9 s (100).
  * Same drill via `TEST_DATABASE_URL`/`TEST_WORKER_DATABASE_URL` against a
    persistent database, twice, with unique per-run tenants: violations `[]`.
  * `mix check` in a clean HEAD tree: 37 tests, 0 failures, format clean,
    warnings-as-errors. `mix test` excludes `:postgres`/`:staging`, so neither
    the default suite nor `npm run test:elixir` needs a database.
  * CI: new `elixir-staging` job (PostgreSQL 16 service, provisioned worker
    login, `mix test --only staging`).

Not claimed / limits
  * No worker is killed mid-lease: crash recovery, lease expiry and `UNCERTAIN`
    reconciliation remain M2-11. The outbox relay is not run here; delivery
    semantics stay with the queue contract tests. Elapsed times are completion
    evidence, not a capacity benchmark. No checklist box is self-ticked; the
    drill awaits independent verification.

Next unclaimed item: **D-14 SID signature/revocation/issuer/transfer** (M2-11
restart/cancel/`UNCERTAIN` reconciliation remains claimed by worker-a).

## 2026-11-23 — M2-11 restart, graceful cancel, crash recovery, UNCERTAIN reconciliation (worker-a)

Decision
  Reconciliation splits by authority. The **database** decides what an expired
  lease becomes (`uap.claim_task_job` recovery loop: `queued` when idempotent and
  attempts remain, `incomplete` for `cancelling`/`reconcile_only`/consumed
  approval, `dead_letter` at the ceiling). The **app** decides only what a living
  worker asks for when it stops, in `AgentosWorker.Lifecycle`: prove → `succeeded`,
  unproven on non-idempotent work → `incomplete`, unproven on idempotent work →
  retry with the uncertainty recorded, cancellation → `cancelled` unless the
  effect already landed (then `incomplete`). `uap.settle_task_job` validates the
  plan again, so an app-side bug cannot cause a blind retry.

Why this shape
  * A crashed process took its lease token with it; it cannot settle, so
    "restart" must never mean "run it again". `TaskWorker` children stay
    `:temporary` (a test kills one and asserts it is not restarted) and
    `Lifecycle.crash_recovery/2` only states how long the queue must wait.
  * `reconcile_only` work is never re-queued, not even before the first effect:
    the contract says a repeat is not provable, so the honest terminal state is
    `incomplete` with `reconcile_only` recorded.
  * Effect state moves forward only (`:none → :applied | :uncertain`,
    `:uncertain → :applied` on proof) so a worker cannot downgrade proof to
    justify a retry.
  * A settlement refusal (`StaleLeaseError`/`TransitionError`) leaves the worker
    running with its lease; no settlement channel is `:settlement_not_wired`, not
    a silent stop.
  * Cancellation has two halves by design: the operator's request lands in
    `uap.request_task_job_cancellation` (recorded as `cancel_requested_at`), and
    the worker mirrors it (`cancel/1`). `settle("cancelled")` without the
    operator row is refused by the database — tested against real PostgreSQL.

Tests (test-first: the 11 lifecycle tests and 9 worker tests were written and
watched fail with `Lifecycle is undefined` / `TaskWorker.cancel/1 is undefined`
before lib/ existed)
  * `mix check` → 61 tests, 0 failures (49 run locally, 12 db-tagged excluded).
  * `mix test.postgres` → 11 tests, 0 failures on a disposable real PostgreSQL,
    including: crashed `reconcile_only` lease → `incomplete` and never re-offered;
    crashed idempotent lease → re-queued once with a new generation and the old
    lease stale; `cancelled` refused without an operator request, accepted after
    it; `incomplete` settlement is never claimable again.
  * Root suites: `cargo test --workspace --locked` 69 passed. `npm test`: the two
    `oauth-cleanup` child-process tests hit their own 15 s spawn timeout under
    concurrent build load and pass in isolation (10.3 s / 7.6 s); no Node change
    in this item.

Not claimed
  * No checklist box is checked; no self-approval.
  * Checkpointing (V6-06-06), spawn timeouts/tombstones (V6-06-08), secret wipe
    (V6-06-09), per-SID concurrency (V6-06-04) remain open.

Next unclaimed item: whatever `scripts/claim.py` hands out next (M2-12 was
claimed by worker-b).

## 2026-11-23 — B-21 (track B): quarantine, prompt-injection, executable + secret scan (worker-b)

Board: claimed `B-21`; implemented V6-02-07. No checklist box is ticked and nothing is
self-approved.

Built
  * `server/src/sources/quarantine.ts` — one scan over an imported bundle, three decisions
    (`clean` / `needs-review` / `quarantined`), `importAllowed` true only when there are no
    findings, and `assertImportAllowed()` as the hard gate for the ingest pipeline
    (`SourceQuarantineError` carries `source_quarantined` / `source_needs_review` + rule ids).
  * Secrets (line-scoped): private key blocks, AWS access key ids, GitHub/Slack/Stripe/OpenAI/
    Google keys block; JWTs and generic credential assignments warn. Findings carry a
    **redacted** excerpt (`AKIA...(20 chars)`) and a test asserts the raw value never appears
    in the JSON. Placeholders (`YOUR_API_KEY`, `changeme`, `<redacted>`, runs of one char)
    are not reported.
  * Prompt injection: the seven override classes are **not re-declared** — the scan delegates
    to C-19's `scanInstructions` (NFKC/zero-width-resistant, one vocabulary). This item adds
    only what that scan lacks: credential-path exfiltration (`~/.ssh`, `id_rsa`,
    `.aws/credentials`, `.netrc`, `.npmrc` sent outbound or posted to a URL), encoded blobs
    (warn), and invisible characters (bidi overrides and Unicode tags block, zero-width warn).
    `credential_exfiltration` suppresses the generic `secret_read` it supersedes.
  * Executable analysis: `curl|bash`, `curl|python`, recursive delete at filesystem root,
    block-device writes, `nc -e` and `/dev/tcp/`, encoded PowerShell, base64-decode-then-eval
    block; `os.system`, `shell=True`, `child_process.exec`, `chmod 777` warn. `package.json`
    install hooks warn. Files analysed are counted in `counts.executableFiles`.
  * Honesty: binary files (`unscannable_binary`) and files over the byte budget
    (`file_too_large`) force review instead of passing; findings are sorted by path/line/rule
    and two runs on one bundle are deep-equal. `declaredSize` lets a caller report an
    oversized file without loading it.
  * `scripts/source-quarantine.mjs` + `npm run scan:source` — scans a checkout, skips
    `.git`/`node_modules`/`dist`/`target`, prints `{roots, truncated, assessment}` and exits
    0/2/3/1. A capped walk can never exit 0 (`truncated` forces 2).
  * `assessmentDigest()` — SHA-256 over decision/blockers/counts/findings, printed by the CLI
    so a reviewer can cite one hash as the promotion evidence. B-22's `QuarantineRecord`
    (advisory id + severity) is an external-advisory quarantine; this verdict is separate and
    is not dressed up as one.
  * `docs/architecture/SOURCE-QUARANTINE.md` — rule inventory, decision ladder, honesty rules
    and explicit non-claims (review gate, not a sandbox or antivirus).

Tests (test-first: `tests/source-quarantine.test.mjs` was written and watched fail with
`ERR_MODULE_NOT_FOUND`, then the "api keys" phrase failed on the singular-only pattern, then
the CLI cases failed until the script existed; the digest tests failed until the helper and
CLI field existed — 26 tests)
  * `node --import tsx --test tests/source-quarantine.test.mjs` -> 26 passed.
  * Root `npm test` -> 173 passed, 0 failed. `npm run typecheck` clean (no TS5097).
  * `cargo test --workspace --locked` -> all crates ok, 0 failed. `mix check` -> 61 tests,
    0 failures, 12 excluded.

Not claimed
  * No checklist box is checked; `verified` stays null for the checker.
  * B-20's `ingestCandidates` (merged while this item was in review) fetches metadata only —
    paths, sizes and SHA-256 manifest rows, no file bodies — so there is no content to scan
    inside it. The gate therefore runs on the fetched checkout (`npm run scan:source -- <dir>`)
    or on bodies a caller passes to `assessSourceBundle`; `assertImportAllowed` is the refusal
    B-22 must call before recording promotion. No schema field was added to B-20's registry:
    persisting the verdict is B-22's migration, not this item's.

Next unclaimed item: whatever `scripts/claim.py` hands out next (see run report).

## 2026-11-23 — B-20 source registry + ingestion pipeline (worker-c)

Decision
  A source is metadata until an independent audit says otherwise. The catalog
  (`uap.source_repositories`, migration 12) stores what was observed — supplied
  URL, canonical owner/repo, access answer, pinned commit, SHA-256 manifest,
  declared licence, kind — and nothing role-shaped. Trust defaults to
  `USER_SUPPLIED_UNVERIFIED`; a database CHECK refuses every other value without
  a `reviewer_signature`, so B-22's promotion cannot be written as an accident.
  Ingestion runs are append-only evidence in `uap.source_ingest_runs`.

Why this shape
  * GitHub returns 404 for both a missing and a private repository without
    credentials, so the record says `not_found_or_private_without_credentials`
    instead of inventing one answer. Moved/archived/rate-limited/auth states are
    stored as observed; nothing is retried into a cleaner story.
  * A branch is a moving reference: the pipeline resolves the default branch to a
    full commit and `assertPublishablePin` refuses branch-only publication.
  * The manifest is SHA-256 of sorted `path\0sha256\0size` rows; listing order
    cannot move the digest and unsafe/duplicate paths are refused, not repaired.
  * The licence reader records the declared SPDX, notices and derived obligations
    with `approval: 'not-reviewed'`. Recognising MIT is not approving it.
  * `requireAuditableSource()` throws for any unpromoted or signature-less source;
    `catalogView()` returns `installable: false` with the first blocker. This is
    V6-02-11: no fake role implementation is synthesized for an unaudited source.
  * The catalog is global public metadata (RLS read for every application
    session); the application login has SELECT only. Ingestion writes run through
    the operator connection, and re-ingestion refreshes observations without
    overwriting trust or reviewer proof.
  * Tenant filtering is closed by default: no domain match, no tool match, risk
    above policy or still `unclassified` hides an entry with an explicit reason.

Tests (test-first: `tests/source-registry.test.mjs` was watched fail with
`ERR_MODULE_NOT_FOUND` before `server/src/sources/` existed; two expectations
were corrected in GREEN — Apache-2.0 carries a patent-grant obligation, and a
`classification.kind` read is the single source of truth on the record)
  * `tests/source-registry.test.mjs` → 21/21: 103-row CSV import with original
    names/URLs, casing/redirect normalization, 404/private/auth/rate-limit/moved
    honesty, branch-pin refusal, order-independent manifest, licence detection,
    tenant filtering, dedupe without a second fetch, unavailable reasons,
    no synthesized role fields, RLS/signature migration invariants.
  * `npm run test:postgres -- source-registry.test.mjs` → passed on disposable
    PostgreSQL 16: app login can read the catalog but cannot write it or runs;
    promotion without a signature violates the CHECK; re-ingest preserves
    `STATIC_AUDITED` + reviewer signature and `last_audited_at`; ingest runs
    refuse UPDATE/DELETE/TRUNCATE.
  * Full `npm run test:postgres` → every file exit 0 (16 files incl. migrations).
  * Live smoke on `octocat/Hello-World`: pinned
    `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, manifest digest
    `65edeac6…b92b`, independently recomputed from the raw tree (identical).
  * `npm test` → 169/170; the one failure is the known `oauth-cleanup`
    child-process 15 s spawn timeout under load and passes 6/6 in isolation.
  * `npm run typecheck` clean; `npm run build` + `audit:branding` +
    `audit:rights` pass; `cargo test --workspace --locked` 5 passed;
    `mix test` 61 tests, 0 failures (12 excluded).

Not claimed
  * No trust promotion, reviewer workflow or scheduled re-audit (B-22).
  * No quarantine, prompt-injection/secret scan or executable-script analysis
    (B-21).
  * No install UI, role derivation, source execution or checklist box self-tick.

Next unclaimed item: **B-21 quarantine/secret-scan/injection scan** (B-22
follows it).

## G-23 — Hermes adapter mapping + conversation lifecycle (worker-c)

Claimed after B-20; G-23 had been claimed and released once by worker-b without code.
Scope read from CHECKLIST-v6.md track G and BUILD-MAP.md §G: V6-07-01 (map the
OpenMausBot ACP Hermes adapter onto the real gateway/tool semantics) and V6-07-07
(model swap and runtime restart must not leak another SID's conversation).

What changed
  * `server/src/agent/hermes-adapter.ts` — the adapter surface as data
    (`HERMES_GATEWAY_SURFACE`): one row per ACP/adapter concept, each with the Hermes
    endpoint/field, a verdict (`mapped` / `partial` / `unsupported`) and the file +
    literal that prove the call. The test re-reads those files, so a row cannot
    outlive its code, and `unsupported` rows carry a limitation instead of parity.
    Notably: session creation is `partial` (we name the conversation; the gateway
    mints no id), cancellation is `partial` (client abort only; the gateway may still
    finish the run because `store: true`), gateway-side MCP discovery is `unsupported`.
  * Conversation threads are now owned by the issued SID:
    `hq-<sid>-g<generation>` when bound, `hq-<botId>-g<generation>` for agents not yet
    bound. No model, clock or process state enters the name, so a model swap and a
    restart both resume the thread, and two SIDs cannot collide on one thread.
  * `bindConversationSid` records the operator binding and refuses `sid_in_use` and
    `sid_rebind_requires_new_generation` (rows already exist in this generation).
  * SQLite migrations 8/9: `bots.sid` (nullable) + unique partial index. Agents bound
    before issuance keep the legacy thread; no SID is invented for them.
  * `docs/v6-blueprint/HERMES-ADAPTER-MAPPING.md`: the human table and the
    not-claimed list (no live-gateway proof of resume/cancel; V6-07-02 needs real
    provider credentials).

Tests (test-first: `tests/hermes-adapter-lifecycle.test.mjs` was watched fail with
`ERR_MODULE_NOT_FOUND` before `server/src/agent/hermes-adapter.ts` existed; the
restart case then ran the same SQLite file in two separate node processes)
  * 4/4 — mapping evidence re-check; SID/legacy thread derivation and refusals;
    two-process model-swap + restart isolation against a fixture gateway (request log
    exactly `hq-sid_alpha-g1`, `hq-sid_beta-g1`, `hq-sid_alpha-g1`, each under its own
    engine key, no transcript row crossing agents); binding refusals.
  * `npm test` → 223/223 (includes the new file).
  * `node --import tsx --test tests/sqlite-migrations.test.mjs` → 12/12.
  * `npm run typecheck` clean; `npm run build` + `audit:branding` + `audit:rights` pass;
    `cargo test --workspace --locked` all suites ok; `mix test` 61 tests, 0 failures
    (12 excluded).

Not claimed
  * No live-Hermes-gateway run: resume and cancellation stay `partial` until one is
    recorded; V6-07-02 (tool/delegation/MCP discovery against permitted providers) is
    untouched.
  * No checklist box self-ticked; checker verifies.

Next unclaimed item: **G-24 policy-authorized tool intents**.
