# BUILD-MAP.md — UAP v6 full-build gap list

Authoritative inventory of everything the v6 blueprint/checklist/docs demand, what UAP
already has, what must be added, and which repo supplies it. The checklist
(docs/v6-blueprint/CHECKLIST-v6.md, 235 items) is the tracking authority; this file is
the sourcing map. Nothing here may be self-ticked; evidence = code + test command +
artifact + independent reviewer per the tracking rules.

## 1. What UAP already has (verified in-tree)

* server/src (56 TS modules): engine, agent loop/subagents/tools/prompt/rooms, providers,
  composio bridge, computer (VNC/desk), routines + proactive triggers, idle, deployment,
  routes (auth via lib/auth, ids, hub, des).
* storage/postgres/: connections, runtime schema + transitions, sessions, conversations,
  jobs + job-worker-grants, session-grants, read-api, migrations, history import.
  -> covers parts of tracks D (persistence), E (job-worker grants), F (durable work).
* web/ (vite) + server/box (HQ shell python). tests/*.mjs incl. postgres + e2e.
* Repo has THIRD_PARTY_NOTICES.md, LICENSE, scripts (audit:branding, db:postgres, test).

## 2. Everything that must be ADDED (track-by-track gap list)

### A. Base and rights (V6-01-01..10) — repurposed by the foundation decision
* KEEP: V6-01-03 reproducible build scripts (scripts/ has dev/build/test — prove on a
  clean checkout), V6-01-04 Hermes adapter E2E (streaming, tools, cancellation, reconn).
* ADD: V6-01-06 architecture freeze doc (Rust policy / Elixir runtime / Hermes reasoning
  / one queue / one billing ledger — currently there is NO Rust policy kernel and NO
  Elixir runtime in UAP: build both, tracks E/F).
* ADD: V6-01-07 SBOM + license-audit CI (audit:branding exists; add SBOM gen).
* ADD: V6-01-08 brand/tenant shell polish + error states (web/ exists; audit against
  no-slop rules, track J).
* DROP-BY-DECISION: OpenMausBot stripping items (V6-01-01/02/05) — see AGENT-DECISIONS.md.

### B. Source catalog & ingestion (V6-02-01..11) — MISSING ENTIRELY
* ADD: SourceRepository registry (Postgres table: URL, owner, casing, fork lineage, pin
  SHA, SHA-256 manifest, LICENSE/NOTICE scan, quarantine + secret scan, trust status,
  reviewer signature, re-audit cron, tenant policy filter).
* SOURCE of candidate data: docs/v6-blueprint/universal_agent_platform_v6_candidate_sources.csv
  + blueprint §3 registry (~60 repos incl. OpenMausBot, Bot HQ, anti-slop, language
  skills, medical/research, game/music).
* INGEST BEFORE: agent/prompt.ts must refuse non-auditable sources (V6-02-11).

### C. Role & persona normalization (V6-03-01..10) — MISSING
* ADD: RoleTemplate JSON schema (id, version, source SHA, digest, rights, title, risk),
  MD persona parser, canonical-vs-derived provenance, dedupe/conflict, launch roster
  (architecture, frontend, backend, QA, security, 7 languages, creative, research),
  preview + owner-approved custom roles, artifact binding, policy-override guard,
  Hermes role translation.
* SOURCE: blueprint §2 roster + registry personas (agency-agents, RoleLLM, persona
  repos); anti-slop personas from Mo-Awadalla/anti-slop + agshinrajabov/no-slop-design
  for tracks J/K.

### D. SID issuance & persistence (V6-04-01..10) — PARTIAL
* HAS: postgres sessions/tenants (ids.ts, session-grants).
* ADD: SID as per-instance identity (NOT per prompt/repo/job) with signature, issuer
  trust, revocation, transfer, uniqueness, memory-namespace binding, pause/resume/
  archive, role-upgrade stability, deletion/privacy propagation.
* SOURCE: estate sid/0.1 golden fixtures (preserve historical bytes; lineage-preserving
  migration) — repo: cryptonomicsed-byte (sid history) + identity-document-protocols skill.

### E. Rust policy & worker admission (V6-05-01..10) — MISSING ENTIRELY
* ADD: new crate agentos-policy (workspace member): ActionIntent, ResourceScope, Grant,
  Budget, Lease (signed, short-lived, monotonic epoch, revocation ref); dispatch
  validation (target/tool-digest/effect-class/tenant/actor/risk); concurrency + spend
  ceilings; re-check at every privileged call; one-use permits + replay protection;
  human approval for money/publish/prod/security/clinical; advisory-only model policy;
  portable lease verify (Rust/Elixir/Go/Python) + golden fixtures; dead-worker proofs.
* This is the security core — build FIRST after M0, test negative paths hard.

### F. Elixir ephemeral agents & durable work (V6-06-01..12) — MISSING
* ADD: agentos-worker OTP app: DynamicSupervisor registry, per-task GenServer (SID +
  role digest + signed lease), one queue/ledger (Postgres jobs tables already exist —
  formalize claim/fencing/outbox), per-SID concurrency + backpressure, Hermes session
  binding, checkpoint before/after non-idempotent effects, restart/cancel/UNCERTAIN
  reconciliation, spawn timeouts + tombstone reaping, secret wipe on exit, 1/10/100 job
  staging test, truthful status + kill controls.
* SOURCE patterns: /opt/ares yemoja-ledger (ledger semantics), ECC gate fencing.

### G. Hermes & tool adapters (V6-07-01..10) — PARTIAL
* HAS: composio.ts, providers.ts, agent/tools.ts, engine.ts.
* ADD: Hermes gateway mapping (streaming/tools/delegation/cancellation/reconnect),
  policy-authorized tool intents (calls Rust policy), progressive per-role skill context
  with token budgets, skill-loader source/digest + injection-attempt audit, typed action
  results (anti-success-hallucination), model swap without SID leakage, browser tasks
  unified (computer.ts + VNC), Vault-brokered logins, degraded-provider tests + honest
  error UI (no implicit paid fallback).
* SOURCE: OpenMausBot ACP Hermes adapter (reference only), NousResearch/hermes-agent.

### H. Seven-language domain services (V6-08-01..10) — MISSING
* ADD: versioned protobuf/JSON contracts + shared fixtures across Rust, Elixir, Julia,
  Go, Python, Clojure, Move, TypeScript; per-language conformance suites; prove a
  Rust+Elixir+Hermes task needs no unused service running.
* SOURCE: blueprint §3 language skill repos; estate osovm-chain/If-Script patterns for Move.

### I. SkillForge & reviewable skills (V6-09-01..10) — MISSING
* ADD: SkillPackVersion, ToolDescriptor (side effects, schemas, tests), contracts from
  real checked-in APIs, isolated fixtures + negative tests, runtime-download block,
  signed capability packs, candidate queue + independent review + publish/revoke/
  rollback, SID/Hermes version compat, skill-drain for in-flight tasks, end-to-end
  invocation proof.
* SOURCE: cryptonomicsed-byte/omokoda-smithers (SkillForge), ECC gate review loop.

### J. High-end distinctiveness & anti-slop (V6-10-01..12) — MISSING
* ADD: Creative Director + Reality Checker roles, no-slop guidance ingestion,
  per-project DESIGN.md requirement, moodboard/typography/token evidence, motion
  grammar + recorded prototype + reduced-motion, UI QA screenshot harness
  (mobile/tablet/desktop/themes), starter-template detection, accessibility (focus/
  contrast/keyboard/AT), critical-task E2E, independent design critique with rubric,
  NO-GO enforcement, human-calibrated scoring.
* SOURCE: Mo-Awadalla/anti-slop, agshinrajabov/no-slop-design, LottieFiles/motion-design-skill,
  Moai-Team-LLC/agentic-product-standard, design-md + claude-design skills.

### K. Language-specific coding gate packs (V6-11-01..10) — MISSING
* ADD: pinned profiles per language with REAL checks — Rust (rustfmt/clippy/test),
  Elixir (Mix/ExUnit supervision), Julia (tests/profiling/deterministic fixtures),
  Move (Sui packages/object-model), Go (tests/race/lint/load), Python (typing/ruff/
  pytest/audit), Clojure (REPL/Malli/Kaocha), role-routing isolation, per-project
  version selection + rollback, tool-output evidence not claims.
* SOURCE: blueprint §3 language repos (rust-skills, clojure-skills, MystenLabs/sui-dev-skills, ...).

### L. Blockchain & financial-risk (V6-12-01..10) — MISSING
* ADD: Sui-vs-EVM template/test separation, provenance/spec/econ/threat artifacts,
  Sui localnet + EVM Foundry fuzzing, independent security review gates, NO production
  signing keys to models, approval gates + idempotency, immutable deployment evidence
  chain, mainnet owner signoff, audit findings as blockers.
* SOURCE: MystenLabs/sui-dev-skills, DarkNavySecurity/web3-skills, cryptoskills, osovm-chain.

### M. Research/medicine/claims (V6-13-01..10) — MISSING
* ADD: Evidence Investigator / Hypothesis Challenger / Citation Auditor / Medical
  Research Librarian roles (no clinician claims), primary-source + uncertainty
  enforcement, hallucinated-citation rejection tests, patient-data policies, scientific
  reproducibility packs, adversarial no-invention tests, independent-gate protection,
  deletion/export/consent.
* SOURCE: AQ-MedAI/MedResearcher-R1, aipoch/medical-research-skills, awslabs/hcls-agent-skills.

### N. Games/NPC/embodied (V6-14-01..10) — MISSING
* ADD: NPC persona vs SID vs world-entity separation, persistent-SID only for
  independent NPCs, game skill packs w/ engine pins, persona-stability tests, scene
  sims (needs/jobs/relations), device/VRAM latency tests, world policy + audience
  rating + consent, visitor/citizen/worker split, no-wallet defaults, scene-unload
  teardown.
* SOURCE: LISK819129/OpenNPC, SnapdragonGameStudios/mindsand-engine, abagames/agentic-gamedev-skills.

### O. Music/media/creative (V6-15-01..10) — MISSING
* ADD: Music Producer/Composer/Sound Designer/Mix Reviewer roles, source audit,
  original editable MIDI/stems validation, duration/loop/loudness/sync tests, rights +
  non-infringement review, billing + evidence registry, retry cleanup + no hidden paid
  fallback, human listening review, provenance, game-audio sync tests.
* SOURCE: blueprint §3 music repos + Parallax billing patterns.

### P. Factory & release quality (V6-16-01..10) — MISSING
* ADD: Smithers workflow (Rust/Elixir task ownership authoritative), REA evidence link,
  Craft Anything check tooling, SID team staffing, SkillForge API/MCP/A2A against real
  services, non-bypassable release gates, cancel/restart/artifact preservation, one
  reference app deployed, unrelated-SID discovery test, backup/rollback/incident/cost.
* SOURCE: omokoda-smithers, ECC gate + yemoja-ledger patterns.

### Q. Marketplace/tenancy/tiers (V6-17-01..10) — MISSING
* ADD: role/skill marketplace (no auto-exec imports), one-click install w/ SID +
  grants, provenance + version history on cards, 5 tiers with quotas + real metering
  (worker seconds, tokens, storage, bandwidth, provider costs, paid effects), org
  wallet/credits + approvals, responsive app + secure pairing, user controls (pause/
  revoke/terminate/delete), full tenant isolation, downgrade/expiry/BYOK/hard-cap tests.

### R. Security/ops/release (V6-18-01..10) — MISSING
* ADD: trusted build + SBOM + signing/attestation, prompt-injection + malicious-skill
  CI, SSRF/secrets/impersonation/escalation/sandbox-escape tests, PII-redacting
  telemetry, backup/restore/replay (SID/task/ledger/catalog/evidence), source-compromise
  revocation + emergency response, dormant-SID load tests, BEAM partition + policy-kernel
  unavailability fail-closed tests, SLOs/playbooks/rollback proofs, launch blocker gate.

### E2E matrix (50) + milestone gates M0-M7
* Executed last per track, by an INDEPENDENT grader with CI job IDs; no self-approval.
* M0 must include: own-tree license/SBOM, sid/0.1 fixtures, launch roster, first 7
  language skill packs, source catalog seeded from the CSV.

## 3. Bring-in list from other repos (ordered by value)

1. milind-soni/OpenMausBot — desktop/web UI shell, ACP Hermes adapter patterns,
   computer-provider unification, agents catalog. ADAPTER REFERENCE ONLY per decision.
2. cryptonomicsed-byte/omokoda-smithers — SkillForge implementation.
3. ECC gate (eco-control-center) — claim/fencing/ledger + reviewer loop semantics for F/I.
4. yemoja-ledger — durable queue/ledger semantics for F.
5. osovm-chain + If-Script — Move testnet adapter patterns for H/L.
6. estate sid/0.1 fixtures — identity history for D.
7. Blueprint §3 registry (~60 repos) — skills/personas/evals for C/I/J/K/L/M/N/O.
8. anti-slop stack (Mo-Awadalla/anti-slop, agshinrajabov/no-slop-design,
   Moai-Team-LLC/agentic-product-standard) — tracks J/K gates + personas.

## 4. Build order (execution plan)

M0 own-tree audit -> M1 Rust policy crate (agentos-policy, track E) -> M2 Elixir worker
(track F) -> D SID -> C roles -> B catalog -> G Hermes adapter hardening -> H contracts
-> I SkillForge -> J/K anti-slop + gates -> L/M/N/O domains -> P/Q factory + marketplace
-> R security -> E2E by independent grader. Test at every commit; negative tests first
for anything with effects. This file + AGENT-DECISIONS.md updated at every milestone.
