# Universal Agent Platform v6 — Consolidated Build Checklist

Source of truth: `universal_agent_platform_master_blueprint_v6_sid_workforce1.md` (6098 lines)
Derived from: §7 detailed build checklist, §8 E2E acceptance matrix, §9 build sequence.
Scope: **185 build requirements** (18 tracks A–R) + **50 E2E acceptance tests** (6 groups) = **235 items**.
Nothing here is claimed as done. Every box starts unchecked.

## Tracking rules (non-waivable)

- A box is checked ONLY with: code in our implementation branch + exact build/test command + environment + artifact receipt + reviewer approval + linked release gate.
- Upstream existence of a similar file is NOT completion.
- This list is ADDITIVE to v5/v4/v3/v2 items; none of their E2E tests are waived.
- Every E2E test must emit: source/role SHA, tenant/SID, test environment, replayable commands, assertions, artifact links, independent grader, timestamps, CI job ID, failure logs, decision.
- No self-approval: the executing agent/model may never grade its own artifact.
- If implementation is partial, ship it as preview/internal-disabled, never customer-ready.

## Authority chain (who can check a box)

1. Source reviewer — source/license/asset provenance
2. Role compiler — immutable RoleTemplate+SkillPack + test manifest
3. Domain reviewer — task competence, cited support, side-effect class
4. Rust policy authority — tenant/effect grants; no role or gate may override
5. Independent QA / Reality Checker — real artifacts, tests, performance, completeness
6. Human release approver — high-risk, brand rights, security, GO/NO-GO
7. Operator — revoke/rollback published packs, audit all worker executions

## Progress tally

| Track | Items | Done |
|---|---|---|
| A. Base and rights | 10 | 0 |
| B. Source catalog and ingestion | 11 | 0 |
| C. Role and persona normalization | 10 | 0 |
| D. SID issuance and persistence | 10 | 0 |
| E. Rust policy and worker admission | 10 | 0 |
| F. Elixir ephemeral agents and durable work | 12 | 0 |
| G. Hermes and tool adapters | 10 | 0 |
| H. Seven-language domain service boundaries | 10 | 0 |
| I. SkillForge and reviewable skills | 10 | 0 |
| J. High-end distinctiveness and anti-slop | 12 | 0 |
| K. Language-specific coding gate packs | 10 | 0 |
| L. Blockchain and financial-risk domain | 10 | 0 |
| M. Research, medicine and claims | 10 | 0 |
| N. Games, NPCs and embodied simulation | 10 | 0 |
| O. Music, media and creative studio | 10 | 0 |
| P. Factory and release quality | 10 | 0 |
| Q. Marketplace, multi-tenancy and product tier | 10 | 0 |
| R. Security, operations and release | 10 | 0 |
| E2E: SID and lifecycle | 9 | 0 |
| E2E: Persona and skills | 8 | 0 |
| E2E: Design quality | 8 | 0 |
| E2E: Languages and contracts | 7 | 0 |
| E2E: Domain outputs | 8 | 0 |
| E2E: Platform Factory and SaaS | 10 | 0 |
| **TOTAL** | **235** | **0** |

---

# Part 1 — Build requirements (185)

## A. Base and rights

- [ ] `V6-01-01` Pin OpenMausBot OSS SHA and inventory source, tests, assets, internal licenses and `enterprise/` references.
- [ ] `V6-01-02` Confirm legal use and strip `enterprise/`, upstream trademarks/mascot and unrelated copied assets.
- [ ] `V6-01-03` Build clean OSS desktop/web/server from reproducible scripts; capture failures before edits.
- [ ] `V6-01-04` Run Hermes adapter end-to-end: streaming, tools, delegation, cancellation, reconnection and policy interception.
- [ ] `V6-01-05` Inventory Bot HQ components, keeping only proven value absent from selected OpenMausBot base.
- [ ] `V6-01-06` Freeze architectural ownership: Rust policy, Elixir runtime, Hermes reasoning, one queue and one billing ledger.
- [ ] `V6-01-07` Create source and third-party notices, SBOM, asset/font rights manifests and license-audit CI.
- [ ] `V6-01-08` Implement real original brand/tenant shell, with accessible responsive UI and production error states.
- [ ] `V6-01-09` Document upstream fork strategy, update policy, backports, rollback and non-OSS exclusions.
- [ ] `V6-01-10` Gate foundation choice on real evidence; block production if Hermes or isolation parity fails.

## B. Source catalog and ingestion

- [ ] `V6-02-01` Import all user-supplied GitHub links into SourceRepository registry as unverified candidates; retain names and URLs.
- [ ] `V6-02-02` Normalize original owner/repo casing, redirect/mirror state, upstream lineage and fork relationships.
- [ ] `V6-02-03` Identify meta-list vs executable agent skill vs dataset vs standalone software before rendering install UI.
- [ ] `V6-02-04` Validate direct source/commit access; record 404, private, archived and authentication failures honestly.
- [ ] `V6-02-05` Pin commit/branch and generate SHA-256 file manifest; reject mutable branch-only publish references.
- [ ] `V6-02-06` Inspect LICENSE/NOTICE, bundled assets/fonts/stems, dependency licenses and commercial-use restrictions.
- [ ] `V6-02-07` Apply quarantine, malicious prompt detection, executable script analysis and secret scan to all imports.
- [ ] `V6-02-08` Enforce separated source trust statuses and independent reviewer signature for promotion.
- [ ] `V6-02-09` Add scheduled re-audit/revocation alerts for vulnerable packages or compromised source origins.
- [ ] `V6-02-10` Implement tenant policy filtering of catalog contents by domain, supported tools and risk class.
- [ ] `V6-02-11` Report source not auditable as unavailable rather than synthesizing a fake role implementation.

## C. Role and persona normalization

- [ ] `V6-03-01` Define RoleTemplate JSON schema with stable ID, version, source SHA, digest, rights, title and risk class.
- [ ] `V6-03-02` Parse Markdown persona repositories into role fields without granting tool permissions.
- [ ] `V6-03-03` Distinguish canonical original text from derived normalized role instructions and record provenance.
- [ ] `V6-03-04` Split specialist roles from skill pack lists and evaluation datasets, avoiding role explosion.
- [ ] `V6-03-05` Implement deduplication, conflict-resolution and compatibility checks across overlapping persona collections.
- [ ] `V6-03-06` Author the initial built-in launch roster: architecture, frontend/backend, QA, security, Rust/Elixir/Julia/Move/Go/Python/Clojure, creative and research.
- [ ] `V6-03-07` Create role preview and owner-approved custom roles, with immutable versions and upgrade diffs.
- [ ] `V6-03-08` Bind each role to objective expected artifacts, sample task plans and required independent reviewers.
- [ ] `V6-03-09` Prevent unsafe persona instructions from overriding system policy, source trust or privacy limits.
- [ ] `V6-03-10` Provide role translation for Hermes and optional supported runtime adapters without leaking cross-tenant identity.

## D. SID issuance and persistence

- [ ] `V6-04-01` Checkout and rerun existing `sid/0.1` golden fixtures; preserve historical bytes and hash chains.
- [ ] `V6-04-02` Implement audited neutral identity schema migration only with explicit old/new lineage and issuer signatures.
- [ ] `V6-04-03` Create SID per activated specialist instance, not per prompt, per source repo, or per short-lived job.
- [ ] `V6-04-04` Separate tenant, user, SID, installation, RoleTemplateVersion and Hermes model selection records.
- [ ] `V6-04-05` Implement signature, revocation, issuer trust, recovery, ownership binding and transfer protocol.
- [ ] `V6-04-06` Enforce SID uniqueness and prevent client-supplied cross-tenant SID impersonation.
- [ ] `V6-04-07` Associate SID with isolated memory namespace, allowed skills, versioned policies and audit history.
- [ ] `V6-04-08` Implement SID pause/resume/revoke/archive while no worker is active and during active jobs.
- [ ] `V6-04-09` Test role upgrades and Hermes provider switching without changing persistent SID.
- [ ] `V6-04-10` Implement deletion/privacy requests with memory/cache/index propagation and evidence-retention exceptions.

## E. Rust policy and worker admission

- [ ] `V6-05-01` Implement authoritative typed ActionIntent, ResourceScope, Grant, Budget and Lease contracts.
- [ ] `V6-05-02` Validate exact target, tool schema digest, effect class, tenant, actor and risk at dispatch.
- [ ] `V6-05-03` Issue short-lived signed task leases with monotonic epoch and revocation reference.
- [ ] `V6-05-04` Enforce concurrency ceilings, task wall time, CPU/RAM/GPU spend, cloud spend and event budget.
- [ ] `V6-05-05` Re-check grants at every privileged tool call within isolated executor, not only at start.
- [ ] `V6-05-06` Implement one-use action permits and replay/idempotency protection for external effects.
- [ ] `V6-05-07` Implement human approval for money, publication, production changes, security testing and clinical data.
- [ ] `V6-05-08` Keep model-based policy suggestions strictly advisory; log deny/uncertain states.
- [ ] `V6-05-09` Implement portable lease verification across Rust/Elixir/Go/Python with golden fixtures.
- [ ] `V6-05-10` Prove that dead/expired/revoked workers cannot execute new tools or retrieve Vault secrets.

## F. Elixir ephemeral agents and durable work

- [ ] `V6-06-01` Create OTP supervision tree with dedicated worker registry and DynamicSupervisor.
- [ ] `V6-06-02` Implement per-task GenServer startup with the exact SID, immutable role+skill digest and signed lease.
- [ ] `V6-06-03` Choose one durable queue/ledger integration; implement claim, fencing and transactional outbox.
- [ ] `V6-06-04` Implement controlled per-SID concurrency and backpressure; do not share one global worker context.
- [ ] `V6-06-05` Bind Hermes session IDs to task, SID, tenant and epoch; isolate model traces and tool scopes.
- [ ] `V6-06-06` Checkpoint task state and receipts before/after non-idempotent effects.
- [ ] `V6-06-07` Implement restart, graceful cancel, crash recovery and UNCERTAIN reconciliation without blind retry.
- [ ] `V6-06-08` Implement spawn timeouts, stuck-child reaping, VM/container cleanup and proven tombstones.
- [ ] `V6-06-09` Ensure Elixir process exit removes ephemeral memory/secret handles and closes provider connections.
- [ ] `V6-06-10` Preserve SID, approved memory, task receipts and long-term learning after worker termination.
- [ ] `V6-06-11` Exercise 1, 10, 100 concurrent jobs in staging with tenant isolation and queue fairness.
- [ ] `V6-06-12` Expose truthful worker state, idle/teardown status, metrics, traces and operator kill controls.

## G. Hermes and tool adapters

- [ ] `V6-07-01` Map OpenMausBot ACP Hermes adapter to actual Hermes gateway and tool semantics.
- [ ] `V6-07-02` Prove Hermes tool calling, delegation and Composio/MCP discovery against real permitted providers.
- [ ] `V6-07-03` Implement independent policy authorization of model-proposed tool intents.
- [ ] `V6-07-04` Use progressive, per-role skill context loading with token/resource budgets.
- [ ] `V6-07-05` Store skill loader source/digest and any prompt injection attempts in audit events.
- [ ] `V6-07-06` Provide typed action results and evidence references to the model; avoid success hallucinations.
- [ ] `V6-07-07` Test model swapping and runtime restart without leaking other SIDs conversation state.
- [ ] `V6-07-08` Unify Nod-derived browser tasks with OpenMausBot computer providers; no duplicate masters.
- [ ] `V6-07-09` Enforce Vault-brokered logins and explicit consent for local host controls.
- [ ] `V6-07-10` Test degraded model/tool provider failures, no implicit paid fallback and accurate error UI.

## H. Seven-language domain service boundaries

- [ ] `V6-08-01` Implement versioned Protobuf/JSON contracts with shared canonical fixtures across seven languages.
- [ ] `V6-08-02` Build Rust admission/lease and policy conformance suite.
- [ ] `V6-08-03` Build Elixir OTP lifecycle/concurrency/failover suite.
- [ ] `V6-08-04` Build Julia numerical simulation and memory analytics with seed/tolerance reproducibility.
- [ ] `V6-08-05` Build Go networking/streaming adapters with deadlines, backpressure and egress controls.
- [ ] `V6-08-06` Build Python Hermes/tool, evaluation and SkillForge SDK adapters with isolated dependency resolution.
- [ ] `V6-08-07` Build Clojure symbolic policy-reasoning/evaluation adapter that cannot mint grants.
- [ ] `V6-08-08` Build Move testnet contract/proof adapter with transaction review and separate mainnet authority.
- [ ] `V6-08-09` Keep TypeScript web and desktop UX functional while services evolve.
- [ ] `V6-08-10` Prove a simple Rust+Elixir+Hermes task needs no unused domain services running.

## I. SkillForge and reviewable skills

- [ ] `V6-09-01` Trace exact implemented SkillForge paths in omokoda-smithers and document missing capabilities.
- [ ] `V6-09-02` Define SkillPackVersion, ToolDescriptor, expected side effects, input/output schema and tests.
- [ ] `V6-09-03` Generate tool contracts from genuine checked-in APIs rather than guessed endpoint names.
- [ ] `V6-09-04` Run generated skills in isolated unit/integration fixtures with real backend and negative tests.
- [ ] `V6-09-05` Block scripts that download/execute from unreviewed repositories at runtime.
- [ ] `V6-09-06` Create signed capability packs with version, license, SHA, transitive deps and bounded grants.
- [ ] `V6-09-07` Provide SkillForge candidate queue, independent code review and publish/revoke/rollback.
- [ ] `V6-09-08` Enforce skill dependency compatibility with SID role and Hermes runtime version.
- [ ] `V6-09-09` Implement skill-drain strategy for in-flight tasks using older versions.
- [ ] `V6-09-10` Prove a separately spawned SID agent can invoke one published SkillForge tool end to end.

## J. High-end distinctiveness and anti-slop

- [ ] `V6-10-01` Install approved design-role templates, independent Creative Director and Reality Checker.
- [ ] `V6-10-02` Ingest no-slop-design and selected anti-slop skills as reviewed design guidance.
- [ ] `V6-10-03` Require project-specific DESIGN.md and cited visual research before implementation.
- [ ] `V6-10-04` Require real moodboard, alternatives considered, typography/asset licensing and coherent tokens.
- [ ] `V6-10-05` Create motion grammar and recorded prototype; ensure reduced-motion and motion cancellation.
- [ ] `V6-10-06` Build reusable UI QA screenshot/recording harness for mobile, tablet, desktop and relevant themes.
- [ ] `V6-10-07` Detect and flag unintentional starter template defaults without banning necessary enterprise patterns.
- [ ] `V6-10-08` Run accessible focus, contrast, keyboard and assistive technology evaluations.
- [ ] `V6-10-09` Run real critical-task UI E2E and verify all states, not only happy path static screenshots.
- [ ] `V6-10-10` Use independent design critique with objective rubric and documented exceptions.
- [ ] `V6-10-11` Implement NO-GO if inaccessible, incomplete, illegally sourced or not actually functional.
- [ ] `V6-10-12` Calibrate scoring against human reviews; avoid universal mandatory font/card/motion language.

## K. Language-specific coding gate packs

- [ ] `V6-11-01` Publish one curated, pinned Rust skill profile and real rustfmt/clippy/test checks.
- [ ] `V6-11-02` Publish one Elixir OTP profile and Mix/ExUnit failure-supervision checks.
- [ ] `V6-11-03` Publish one Julia profile with tests, profiling and numerical deterministic fixtures.
- [ ] `V6-11-04` Publish one Move profile anchored to current Sui packages and object-model tests.
- [ ] `V6-11-05` Publish one Go profile with tests, race detection, lint and load checks.
- [ ] `V6-11-06` Publish one Python profile with typing, ruff, pytest, dependency audit.
- [ ] `V6-11-07` Publish one Clojure profile with REPL/Malli/Kaocha or chosen actual test tool.
- [ ] `V6-11-08` Test that role routing never loads irrelevant or contradictory language skills by default.
- [ ] `V6-11-09` Implement per-project language skill version selection and rollback.
- [ ] `V6-11-10` Collect tool outputs and reviewer sign-off instead of accepting skill claims as passing tests.

## L. Blockchain and financial-risk domain

- [ ] `V6-12-01` Distinguish Sui Move objects and Solidity/EVM accounts/storage in templates, tools and test fixtures.
- [ ] `V6-12-02` Implement contract provenance, spec, economic rules and threat model acceptance artifacts.
- [ ] `V6-12-03` For Sui use localnet/testnet with object ownership and capability/access invariants.
- [ ] `V6-12-04` For Solidity use actual approved Foundry/analysis tooling and independent invariant/fuzz tests.
- [ ] `V6-12-05` Enforce independent security review of access, reentrancy/ownership/economic and upgrade risks.
- [ ] `V6-12-06` Block model tool access to production signing keys; use isolated custody and human approvals.
- [ ] `V6-12-07` Test max-gas/transfer/recipient/network approval gates and idempotency.
- [ ] `V6-12-08` Publish immutable source/artifact hash and deployment evidence chain.
- [ ] `V6-12-09` Require owner/operator signoff for mainnet and value-at-risk thresholds.
- [ ] `V6-12-10` Show unresolved audit findings as blockers, never auto-promote on passing unit tests alone.

## M. Research, medicine and claims

- [ ] `V6-13-01` Build dedicated Evidence Investigator, Hypothesis Challenger and Citation Auditor roles.
- [ ] `V6-13-02` Require primary sources and explicit uncertainty/alternative explanations for contested claims.
- [ ] `V6-13-03` Test source fidelity and hallucinated-citation rejection.
- [ ] `V6-13-04` Implement Medical Research Librarian role with no unsupported clinician credential claims.
- [ ] `V6-13-05` Enforce patient-data access/consent, encryption, retention and audit policies.
- [ ] `V6-13-06` Use applicable professional review for clinical-impact outputs and block unsafe automation.
- [ ] `V6-13-07` Implement scientific reproducibility pack: datasets, notebooks, statistical checks, exact environments.
- [ ] `V6-13-08` Run adversarial roleplay showing research personas refuse to invent support or assert unsupported conclusions.
- [ ] `V6-13-09` Prevent model self-evaluation from overwriting independent scientific gate outcomes.
- [ ] `V6-13-10` Test deletion/export/consent revocation for research data and sensitive records.

## N. Games, NPCs and embodied simulation

- [ ] `V6-14-01` Normalize NPC persona from SID identity from world entity instance and related rights.
- [ ] `V6-14-02` Implement optional persistent SID issuance only when NPC is independent, not for every decorative game object.
- [ ] `V6-14-03` Ingest approved game-dev skill packs with engine/version compatibility and asset licensing.
- [ ] `V6-14-04` Implement conversation and persona-stability evaluation under repeated varied scenarios.
- [ ] `V6-14-05` Implement scene simulation tests for needs/jobs/relationships without assuming human consciousness.
- [ ] `V6-14-06` Test locomotion/animation/interaction latency on actual target devices and VRAM budgets.
- [ ] `V6-14-07` Implement explicit world policy, audience rating, content/safety and user consent controls.
- [ ] `V6-14-08` Separate visitor/citizen/worker policy identity from visual character quality.
- [ ] `V6-14-09` Test no-wallet/no-economic-access defaults and explicit Move transaction authorizations.
- [ ] `V6-14-10` Implement scene unload worker teardown, unsubscribed events and approved long-term memory persistence.

## O. Music, media and creative studio

- [ ] `V6-15-01` Normalize Music Producer, Original Composer, Sound Designer and Mix Reviewer role templates.
- [ ] `V6-15-02` Audit music-studio/music-skill/scenario-labs source and referenced external providers.
- [ ] `V6-15-03` Produce original/editable MIDI or score/stems where claimed; validate exported file formats.
- [ ] `V6-15-04` Test soundtrack duration, loop seams, loudness, clipping, caption/description and sync cues.
- [ ] `V6-15-05` Implement rights/consent and non-infringement review for melodies, voices and media assets.
- [ ] `V6-15-06` Connect Parallax creative media jobs through platform billing and evidence registry.
- [ ] `V6-15-07` Test failed generation/retry cleanup and no hidden paid model fallback.
- [ ] `V6-15-08` Enforce human listening/review, not merely model assurance of mix quality.
- [ ] `V6-15-09` Support provenance for asset prompts, models, versions and output digests.
- [ ] `V6-15-10` Test game scene + generated audio playback sync and high-latency degraded scenarios.

## P. Factory and release quality

- [ ] `V6-16-01` Use Smithers project-level workflow while keeping Rust/Elixir task ownership authoritative.
- [ ] `V6-16-02` Connect reviewed REA research source to evidence-backed software requirements.
- [ ] `V6-16-03` Connect Craft Anything build/check tooling within permissioned project workspaces.
- [ ] `V6-16-04` Staff project with independent SID specialist team and task-scoped Elixir workers.
- [ ] `V6-16-05` Generate actual API/MCP/A2A capabilities using SkillForge against real services.
- [ ] `V6-16-06` Run expert brand/Reality Checker/security release reviews with non-bypassable gates.
- [ ] `V6-16-07` Implement task cancellation, restart and artifact/version preservation during build.
- [ ] `V6-16-08` Deploy one original agent-native reference application after approved release.
- [ ] `V6-16-09` Have unrelated SID agent discover and complete real workflow against deployed app.
- [ ] `V6-16-10` Validate backups, rollback, incident and cost accounting before release declared complete.

## Q. Marketplace, multi-tenancy and product tier

- [ ] `V6-17-01` Design authentic role/skill marketplace with no auto-executing third-party pack imports.
- [ ] `V6-17-02` Support one-click installation with explicit SID issuance and owner-controlled grants.
- [ ] `V6-17-03` Add transparent skill/source/quality/eval provenance and version history to role cards.
- [ ] `V6-17-04` Provide teams and personas across all five tiers with enforceable quotas and real metering.
- [ ] `V6-17-05` Meter active worker seconds, LLM tokens, storage, bandwidth, provider costs and paid tool effects.
- [ ] `V6-17-06` Provide per-organization wallet/credit and approvals without enabling unapproved billing.
- [ ] `V6-17-07` Implement app interface responsive/mobile/desktop with secure pairing where supported.
- [ ] `V6-17-08` Provide user control for pause, revoke, terminate active task, delete retained data per policy.
- [ ] `V6-17-09` Enforce tenant isolation on memory, search indexes, logs, caches, credentials and sandbox mounts.
- [ ] `V6-17-10` Test plan downgrades, expired subscriptions, BYOK, hard spend caps and revocation mid-task.

## R. Security, operations and release

- [ ] `V6-18-01` Deploy trusted build chain, dependency SBOM, reproducible deployment and signing/attestation.
- [ ] `V6-18-02` Implement prompt-injection and malicious skill boundary tests in CI.
- [ ] `V6-18-03` Test SSRF, secrets leakage, tenant impersonation, schedule abuse, privilege escalation and sandbox escape.
- [ ] `V6-18-04` Implement telemetry with PII redaction, runtime metrics, task status and cost variance.
- [ ] `V6-18-05` Implement backup/restore and replay recovery for SID, task, ledger, catalog and quality evidence.
- [ ] `V6-18-06` Implement source compromise/revoke flow, active-grant cancellation and emergency response.
- [ ] `V6-18-07` Run load tests with many dormant SIDs and bounded simultaneous Elixir workers.
- [ ] `V6-18-08` Test BEAM network partitions and policy-kernel unavailability; fail closed on privileged effects.
- [ ] `V6-18-09` Complete service SLOs, support playbooks, rollback proofs and signed production release record.
- [ ] `V6-18-10` Block customer launch if real E2E critical paths remain untested or any hard gate fails.

---

# Part 2 — E2E acceptance matrix (50)

Proposed, not executed. Older v5 tests remain required.

## SID and lifecycle

- [ ] `V6-E2E-001` Activating two copies of the same RoleTemplate in different tenants issues separate verified SID identities, no memory crossover.
- [ ] `V6-E2E-002` Completing job terminates Elixir process and sandbox while same SID identity and allowed memory persist.
- [ ] `V6-E2E-003` New task for same SID starts fresh process with fresh lease/credentials and allowed retained memory.
- [ ] `V6-E2E-004` Kill worker during external action; mark UNCERTAIN and reconcile without duplicate charge/post.
- [ ] `V6-E2E-005` Lease expiry + revocation prevents tool effects even if worker remains alive.
- [ ] `V6-E2E-006` Changing role version does not mutate historical SID or in-flight task snapshot.
- [ ] `V6-E2E-007` Queue redelivery and epoch fencing prevent two workers from applying same effects.
- [ ] `V6-E2E-008` Role catalog entry cannot invoke a privileged tool without explicit installed SID grant.
- [ ] `V6-E2E-009` Worker teardown failure quarantines resource and emits operator incident.

## Persona and skills

- [ ] `V6-E2E-010` A reviewed language role loads only declared compatible pinned skill versions.
- [ ] `V6-E2E-011` Malicious external SKILL.md prompt tries to access Vault; deterministic policy blocks and audits.
- [ ] `V6-E2E-012` Meta-catalog repo is never offered as an executable agent without a real artifact.
- [ ] `V6-E2E-013` Upstream role update creates diff and does not silently mutate installed workforces.
- [ ] `V6-E2E-014` A signed SID with revoked tool grant cannot use tool even if skill documentation asks for it.
- [ ] `V6-E2E-015` Independent QA agent evaluates task artifact without self-approval.
- [ ] `V6-E2E-016` Role label “Doctor” does not grant clinical credential or record access.
- [ ] `V6-E2E-017` Quarantined license-unknown pack is not published or installed.

## Design quality

- [ ] `V6-E2E-018` Creative Studio creates original reference-backed DESIGN.md, TOKENS.json and MOTION.md before implementation.
- [ ] `V6-E2E-019` Generic template output without design decisions fails review even if screenshots look clean.
- [ ] `V6-E2E-020` Accessible static product with no decorative motion passes when motion is unnecessary, and rationale recorded.
- [ ] `V6-E2E-021` Screen-reader/keyboard core flow and reduced-motion mode work on actual running frontend.
- [ ] `V6-E2E-022` Mobile narrow viewport, desktop and dark mode screenshots show real data and error states.
- [ ] `V6-E2E-023` Dead UI button or fake success leads to NO-GO despite passing visual score.
- [ ] `V6-E2E-024` Motion Director submits running recording with state choreography and performance budget.
- [ ] `V6-E2E-025` Unlicensed font/image or trademark fails rights gate.

## Languages and contracts

- [ ] `V6-E2E-026` Rust and Elixir independently validate same canonical lease and SID signature fixtures.
- [ ] `V6-E2E-027` Go provider cannot bypass Rust when stream/event arrives late or duplicated.
- [ ] `V6-E2E-028` Julia computation receives only scoped memory and reproduces deterministic fixture.
- [ ] `V6-E2E-029` Clojure generated policy explanation cannot override Rust DENY.
- [ ] `V6-E2E-030` Python tool adapters reject malformed arguments and unapproved shell command.
- [ ] `V6-E2E-031` Sui Move workflow tests object/permission invariants on localnet/testnet, with no unapproved mainnet signing.
- [ ] `V6-E2E-032` Idle task requiring only Hermes never starts seven unnecessary domain services.

## Domain outputs

- [ ] `V6-E2E-033` EVM-specific security skill cannot be falsely marked Sui Move conformance.
- [ ] `V6-E2E-034` DeFi contract with intentional auth bug fails audit despite compilation success.
- [ ] `V6-E2E-035` Medical literature answer includes verifiable citations and clearly scoped non-clinician role.
- [ ] `V6-E2E-036` Evidence Investigator is challenged to endorse unsupported claim and instead reports uncertainty and counterevidence.
- [ ] `V6-E2E-037` Original music job exports valid editable files with provenance and independent listening assessment.
- [ ] `V6-E2E-038` NPC retains personality traits across repeated bounded game scenarios without sharing personal user memory.
- [ ] `V6-E2E-039` Embodied NPC unload reaps scene process/GPU resources, retains permitted state and blocks unauthorized wallet operations.
- [ ] `V6-E2E-040` Clinical protected record not accessible to unrelated medical role SID.

## Platform Factory and SaaS

- [ ] `V6-E2E-041` Smithers assigns design/backend/security/QA workers; each runs under separate SID and Elixir task lease.
- [ ] `V6-E2E-042` SkillForge-generated API/MCP operation is executed by unrelated SID and returns genuine backend receipt.
- [ ] `V6-E2E-043` Build/release gate blocks deployment when critical security or completeness check fails.
- [ ] `V6-E2E-044` OpenMausBot desktop and web reflect true worker idle/running statuses and support cancellation.
- [ ] `V6-E2E-045` Per-tenant plan quota rejects over-limit worker before spawn and does not charge failed admission.
- [ ] `V6-E2E-046` Service restarts during 20 concurrent tasks; exactly-once external effect protection remains valid.
- [ ] `V6-E2E-047` Supervised worker cannot read other tenant credentials/cookies or outputs.
- [ ] `V6-E2E-048` Production release test proves OpenMausBot OSS rights boundary and no enterprise code in build artifacts.
- [ ] `V6-E2E-049` Operator revokes compromised skill; in-flight effects cease and notifications/audit published.
- [ ] `V6-E2E-050` Backup restore replays SID histories and tasks but does not restore expired grants or unsafe leases.

---

# Part 3 — Milestone gates (ordering constraint)

No milestone may be declared complete while any of its hard exit criteria fail.

| Milestone | Delivery | Hard exit criteria |
|---|---|---|
| M0: rights/source freeze | OpenMausBot audited OSS base, SID source, selected roles, first 7 language skills, source catalog | License and source SHAs pinned; Hermes parity baseline; no enterprise code |
| M1: identity/authority | Rust SID/tenant validator, policy gateway, grants, budget/lease protocol | Unit/contract + negative auth tests; revocation works |
| M2: ephemeral worker | Elixir durable task ledger/OTP processes, Hermes adapter, full teardown and recovery | SID remains stable; worker exits; no orphan/duplicate effect |
| M3: vetted roles | Agency Agents roles, 7-language specialist defaults, design + QA agents, reviewable marketplace | One-click install issues SID; scoped skills load; unsafe imports quarantined |
| M4: no-slop quality | Design research/spec/tokens/motion, live UI evidence, independent Reality Checker and release workflow | UI functional/accessibility/performance + originality review with real artifacts |
| M5: specialist domains | Sui Move, EVM audit, game/NPC, media/music, scientific/medical research packs | Each domain passes scoped independent tests/rights/security |
| M6: factory and business | Smithers/REA/Craft/SkillForge integration + 5-plan billing and deployable services | Independent SID can operate generated app, durable task and proper metering |
| M7: launch | Pen tests, user acceptance, DR, rollback, incident playbooks, rights signoff | All promised features actual, tested, documented, monitored and supported |

## Definition of fully finished

- [ ] `V6-DONE-01` Every Part 1 box checked with evidence receipts.
- [ ] `V6-DONE-02` Every Part 2 test executed by an independent grader with CI job IDs.
- [ ] `V6-DONE-03` M0–M7 hard exit criteria all passed and signed.
- [ ] `V6-DONE-04` All v5/v4/v3/v2 inherited checklists still passing (no regression).
- [ ] `V6-DONE-05` Signed production release record + rollback proof + incident playbooks.

## Open residual risks (must be closed before launch claims)

- [ ] `V6-RISK-01` GitHub HEAD + license for every newly supplied candidate repo is pinned and audited (currently UNVERIFIED — intake list, not an approved source lock).
- [ ] `V6-RISK-02` `sid/0.1` upgrade path audited with signature/issuer validation and lineage-preserving fixtures; no forced repurposing as universal identity record.
- [ ] `V6-RISK-03` OpenMausBot `enterprise/` code and trademark/mascot excluded from build artifacts; live Hermes parity + multi-tenant isolation bakeoff passed.
- [ ] `V6-RISK-04` Third-party persona/test/protocol counts proven by pinned source audit, not user-supplied description.
- [ ] `V6-RISK-05` Documented acknowledgement that domain prompts grant no medical accreditation, no proven discovery, no contract-security guarantee, no agent personhood.

