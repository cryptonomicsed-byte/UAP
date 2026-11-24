# AgentOS — Comprehensive System Architecture and Repository Reuse Atlas

**Edition:** AgentOS architecture report based on Master Blueprint v6 (2026-11-18), user-supplied candidate registry, earlier v4/v5 source maps; prepared 2026-11-24.

**Status:** Architecture, intended reuse and audit plan. **Not evidence that AgentOS has been implemented or that any candidate repository has passed a fresh source/licensing audit.**

**Audit:** Summary | Threat Model | Tests | Invariants | Diacritics
- **Summary:** Build one original agent-native commercial operating platform with permanent SID agents, disposable Elixir workers, Rust enforcement, Hermes reasoning, a reviewed workforce catalog, a Smithers/SkillForge factory, Nod-inspired automation, specialized products, and quality gates.
- **Threat Model:** Unauthorized tools and writes, privilege escalation, model prompt injection, poisoned role/skill sources, private data or secret leakage, cross-tenant identity confusion, sandbox escape, unstable long-running tasks, false completion/evidence, uncontrolled cost, unsafe cyber tests, faulty chain transactions, media IP violations and misleading professional claims.
- **Tests:** Reuse v6 acceptance criteria; independent integration, model+tool parity, cross-SID isolation, job recovery, release-quality, production licensing and domain-specific end-to-end tests.
- **Invariants:** SID != worker != persona != model session != authorization grant. Hermes reasons; Rust enforces; Elixir supervises short-lived work. One durable task ledger. One credential Vault. No production feature is marked ready based solely on a README or a prompt.
- **Diacritics:** External AgentOS service names are neutral. Existing Unicode source identifiers and any signed artifacts remain byte-preserving.

## 1. The target product

AgentOS is a platform where human and authorized machine principals can register independently addressable AI agents, assign roles and reviewed skills, run work through scoped computer/API tools, preserve permitted memory, form temporary teams, and verify real outcomes. Agents can build, operate and test agent-native applications. This is *not* a new from-scratch kernel replacing Linux: the term **AgentOS** refers to the platform runtime/control-plane stack that uses supported host operating systems, containers or VMs.

**Three public product pillars:**
1. **Workspace:** conversations, agent management, computer, browser, voice, apps, scheduled tasks, outputs and audit.
2. **Workforce:** builtin roles, scoped SID installations, agency templates, team assignments, review and budget policies.
3. **Platform Factory:** governed REA research, Craft build tools, Smithers workflow, SkillForge action generation, independent QA and deployment of complete agent-native apps.

**Specialist products** are modular: Security & Evidence; Creative Studio; Cloud Simulation & Benchmarks; Game/NPC Worlds; Research/Science; Blockchain/DeFi; Media/Music. Enterprise SaaS capabilities are centrally owned, not borrowed from a separately licensed upstream `enterprise/` directory.

### 1.1 What must be true before launch

A full production product needs real auth, team and billing state, isolated execution, connected provider handling, secrets/approvals, durable persistence and recovery, working docs, privacy controls, backup/restore, monitoring, incident response, release gates and audited source rights. Template collections do not substitute for these services. No AI model or skill markdown alone guarantees output quality, professional expertise, or valid access authority.

## 2. Architecture: final ownership map

| Layer / system of record | Chosen implementation boundary | Specific responsibility | What it must not become |
|---|---|---|---|
| App and desktop | Select permitted OpenMausBot OSS components and original UI | Agent dashboard, collaboration, computers, voice, desktop; customer UX | Tenant authorization database or separate master planner |
| Agent reasoning | Hermes via a versioned authenticated gateway | LLM/model sessions, planning, tool proposals, streaming | Permission source, credential custodian or billing ledger |
| Identity | SID registry and AgentInstallation | Stable principal, issuer history, revocation, role binding | Automatically trusted tool grant |
| Enforcement | Rust kernel | Real policy, signed/bounded grants, spend, lease fencing, action audit | LLM model-only intent checker |
| Worker supervisor | Elixir/OTP | Spawn/recover/retire per-task agents; cooperative team scheduling | Long-term identity store or secret vault |
| Work ledger | PostgreSQL + durable queue/outbox | Task/attempt state, checkpoints, idempotency and reconciliation | In-memory-only BEAM queue or duplicated Smithers store |
| Model/tool integrators | Python | Hermes adaptors, typed tools, REA/SkillForge runners | Privileged bypass to shell or production keys |
| Numerical computation | Julia | Simulation, numeric memory features, model/evaluation analytics | Universal persistence or mandatory per-turn service |
| Symbolic reasoning | Clojure | Versioned rule language, logic/evaluation explanations | Independent overriding policy authority |
| Network/I/O | Go | Protocol transport, signaling, gateway and streaming | Separate agent identity namespace |
| Settlement | Sui Move (optional per product) | On-chain objects, escrow/transactions with chain-specific proof | Off-chain tenant privileges or secret custody |
| Role and skill registry | Agency Agents + reviewed external packs | Immutable roles, skill versions, domain gates, workflow templates | Automatic shell/tool entitlement |
| Platform Factory | Smithers + SkillForge + REA + Craft adapters | Program planning, builds, skill outputs, QA and handoff | Alternate billing, grant or production-deploy bypass |
| Trust/Vault/automation | Original shared services informed by Nod | Per-tenant credentials, actions, approved browser work, memory, schedules | One-owner Nod state or independent Pi master |
| Security verification | Pentest Copilot + OKF and optional labs | Authorized scans, findings, verifiable artifacts, safe simulations | Global administrator tools for all agents |
| Product billing and operations | Original SaaS control plane | Free/Basic/Pro/Teams/Enterprise, BYOK, credits, uptime, legal | Copied upstream restricted enterprise components |

**Only one truth for each object:** task states are persisted once, SID is checked everywhere, grants exist only at the authority boundary, and third-party runtimes are adapters. A person can select multiple reasoning models through Hermes but switching provider does not create a new SID or implicit grant.

### 2.1 Flow diagrams

```text
User / approved schedule / verified event / A2A request
  -> authenticate principal + tenant + project + SID
  -> resolve AgentInstallation + reviewed role/skill digest
  -> create durable TaskIntent with acceptance criteria
  -> Rust kernel: entitlements + scope + budget + risk
  -> lease/fence the task; allocate isolated computer/worker
  -> Elixir DynamicSupervisor: start per-task worker
  -> Hermes: plan + generate typed ToolIntents
  -> Rust: enforce every effect against exact grants/args
  -> Python/Go/Julia/Clojure/Move/services execute only approved actions
  -> durable receipts, event outbox and task checkpoints
  -> independent CI/QA/security/quality review
  -> settle usage + archive allowed artifacts + update scoped memory
  -> stop Elixir child; destroy sandbox; revoke lease and transient secrets
  -> SID and durable evidence persist for next task
```

**Task lifecycle:** CREATED -> AUTHORIZED/REJECTED -> QUEUED -> LEASED -> RUNNING -> WAITING_APPROVAL/CHECKPOINTED -> SUCCEEDED/FAILED/UNCERTAIN/CANCELLED. No blind retry after an external effect. Completion of a GenServer is not proof the real-world action succeeded.

### 2.2 SID agent instance versus template versus worker

- `RoleTemplateVersion`: reusable developer/artist/security/medical-research professional role; not a person or runnable process.
- `SkillPackVersion`: vetted and versioned instructions, declarative tool manifests and tests; not authorization.
- `AgentIdentity` SID: stable principal, provenance and lifecycle; survives machine changes and job completion.
- `AgentInstallation`: binds SID to one tenant's memory, role/skill versions, runtime/model choices, budgets and approved grants.
- `AgentWorkerLease`: one signed/exact task capability with epoch, TTL, allowed resources, budget and revocation status.
- `ElixirAgentProcess`: disposable worker supervising a Hermes task and its sandbox resources.
- `Task`, `Attempt`, `WorkReceipt`: independently persisted truth of work and its evidence.
- `NPCEmbodiment`: optional world object and animated appearance; may reference a SID but visual existence alone confers no personhood, passport or economic privilege.

**Concrete event model:** `agent.created`, `role.installed`, `task.queued`, `lease.issued`, `agent.spawned`, `tool.proposed`, `policy.denied`, `approval.requested`, `tool.completed`, `evidence.issued`, `task.uncertain`, `task.completed`, `worker.destroyed`, `agent.paused`, `agent.revoked`. Each carries correlation ID, scope, timestamps and versioned payload; secrets remain by reference behind ACL.

## 3. Repo-by-repo: platform/services/factory/foundation (complete core inventory)

Read this table as **intended extraction and compatibility contracts**, not proof that code can be copied unchanged. `REQUIRED` means a capability is required, not necessarily that the entire upstream repo is a binary dependency. Several sources require new audits at pinned commits.

| Repository (full GitHub name) | Selection | What we take / implement from it | What we do not inherit |
|---|---|---|---|
| [`milind-soni/OpenMausBot`](https://github.com/milind-soni/OpenMausBot) | FOUNDATION | Permitted OSS app/harness, desktop client, teams/packages, ACP and runtime drivers, computer-use, channels, headless/MCP. Fork source selectively; remove owner-global state and restricted enterprise/ branding. | Hard license boundary: `enterprise/` and trademarks; full source/build/Hermes tool parity and hosted tenant isolation still require verification. |
| [`nickvasilescu/bot-hq`](https://github.com/nickvasilescu/bot-hq) | REFERENCE | Reuse specific Hermes streaming/agent-management and UI patterns where legally and technically compatible. Do not operate as a second shell, independent task store, or competing model orchestrator. | Superseded as preferred foundation by v6; validate actual reusable components. |
| [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) | REQUIRED RUNTIME | Single primary agent reasoning engine; configurable models; tool use, sessions, delegation, streaming via a tenant/SID-bound gateway. | Do not equate model selection or agent tool decisions with authorization; verify exact integration and model/provider terms. |
| [`n8n-io/nod`](https://github.com/n8n-io/nod) | ADAPT SERVICES | Extract/adapt Trust architecture ideas, browser+workspace isolation, Vault patterns, durable task sessions, scheduler, learned skills, provenance memory, observers, messaging channels. | One-owner assumptions and Pi-based runtime cannot be imported unchanged; adapt to Hermes and multi-tenancy. |
| [`cryptonomicsed-byte/sid`](https://github.com/cryptonomicsed-byte/sid) | REQUIRED IDENTITY | Canonical persistent agent identity, hash-chain history, signatures/issuer trust after versioned migration, revocation and agent lifecycle; bind to one installation per customer scope. | Preserve signed sid/0.1 bytes; propose neutral sid/0.2 contract; identity is not a capability grant. |
| [`cryptonomicsed-byte/card-protocol`](https://github.com/cryptonomicsed-byte/card-protocol) | PROTOCOL REFERENCE | Canonicalization and signed/hash-linked record patterns for interoperable business cards, which remain distinct from agent identity cards. | Do not change existing business-card hashes or treat business information as agent authority. |
| [`cryptonomicsed-byte/helixmain`](https://github.com/cryptonomicsed-byte/helixmain) | OPTIONAL BRIDGE | Existing business CARD publication, tenant business profiles, voice/contact and MCP/business-service linkage where required. | Separate business identity from agent SID and commercial platform accounts. |
| [`cryptonomicsed-byte/agency-agents`](https://github.com/cryptonomicsed-byte/agency-agents) | WORKFORCE CATALOG | Prefer the user-owned fork as the source of specialist role definitions, role practices, deliverables and review metrics; compile into immutable RoleTemplate versions. | Verify fork SHA, upstream lineage, license; Markdown personas are not running agents. |
| [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents) | UPSTREAM REFERENCE | Provenance and updates for specialist personas and divisions; compare upstream against the owned fork. | Do not duplicate roles; template imports need attribution, review and permission previews. |
| [`msitarzewski/agency-agents-app`](https://github.com/msitarzewski/agency-agents-app) | UX REFERENCE | Catalog browsing/role installer and role-card user experience patterns. | Do not import its app wholesale or create a second agent manager. |
| [`adamoutler/gemini-agency-agents`](https://github.com/adamoutler/gemini-agency-agents) | FORMAT REFERENCE | Example tool-specific adaptation of agency personas; use to validate adapter-neutral schema and format conversion. | Not a required runtime, may duplicate existing persona content. |
| [`Arlandaren/proagents`](https://github.com/Arlandaren/proagents) | PERSONA CANDIDATE | Additional professional role and checklist sources; select complementary practices and measurable reviews. | Do not blindly install hundreds of agents or treat claimed role counts as quality proof. |
| [`cryptonomicsed-byte/omokoda-smithers`](https://github.com/cryptonomicsed-byte/omokoda-smithers) | FACTORY ORCHESTRATION | Smithers workflow packs for requirements, task DAG, engineering stages, review, SkillForge forge flow, acceptance and recovery. | Exact source audit required; one canonical Task/Attempt ledger, no alternate authority for billing/deployments. |
| [`storytold/craft-anything`](https://github.com/storytold/craft-anything) | FACTORY BUILD ADAPTER | Candidate Rust CLI/MCP investigation/build/check abilities inside secured development sandboxes with pinned inputs and evidence. | Verify headless, legal, scale and build capabilities; not presumed a universal website copier. |
| [`morluto/rea`](https://github.com/morluto/rea) | INVESTIGATION CANDIDATE | Potential investigation/reverse-engineering adapter for authorized feature observation and evidence-backed technical research. | Exact REA lineage unresolved; do not claim this repo is the user-intended REA without confirmation. |
| [`milind-soni/openmausbot-teams`](https://github.com/milind-soni/openmausbot-teams) | TEAM FORMAT | Candidate portable team manifest/role export convention. | Scan imports; never serialize credentials, live grants, private memory or SID signing keys. |
| [`bugbasesecurity/pentest-copilot`](https://github.com/bugbasesecurity/pentest-copilot) | SECURITY TOOL SERVICE | Bounded authorized security workspace, Kali/SSH, browser, security tool connectors, finding workflows via a scoped MCP wrapper. | No broad admin MCP token, forbidden high-risk toggles, and no tests outside verified scope. |
| [`cryptonomicsed-byte/okf-security-pipeline`](https://github.com/cryptonomicsed-byte/okf-security-pipeline) | SECURITY EVIDENCE | Scanning, STIX/Strix processing, finding fingerprints/history, receipt hash chains, Merkle evidence, OTS/Bitcoin proof verification paths. | Uploaded snapshot was audited; historical artifact mismatches and missing refs must be shown, not silently rewritten. |
| [`bugbasesecurity/PayloadsAllTheThings`](https://github.com/bugbasesecurity/PayloadsAllTheThings) | SECURITY KNOWLEDGE | Versioned retrieval of security tests and references with provenance, content filtering and approved engagement linking. | Retrieved payload text is untrusted; never execute it by default. |
| [`swisskyrepo/PayloadsAllTheThings`](https://github.com/swisskyrepo/PayloadsAllTheThings) | DATASET UPSTREAM | Track upstream provenance/updates for the BugBase fork; reconcile licenses and source attribution. | Not a second installed runtime. |
| [`bugbasesecurity/cloud-attack-range`](https://github.com/bugbasesecurity/cloud-attack-range) | ISOLATED LAB | Cloud security training/benchmarking scenario candidates with objective validation and teardown evidence. | Cloud IAM, written target scope, strict quotas, TTL, spend ceiling and teardown proof mandatory. |
| [`nickvasilescu/parallax`](https://github.com/nickvasilescu/parallax) | CREATIVE CANDIDATE | Media studio workflow patterns for original image, video and audio generation; scene jobs, project assets and provider adapters. | Actual source providers, licenses and API must be audited; no claims of production capability before tests. |
| [`agentsea/agentdesk`](https://github.com/agentsea/agentdesk) | COMPUTER PROVIDER | Optional virtual desktop/computer provider contract and view/control adapter. | Compare isolation, deployment, cost and supported platforms. |
| [`trycua/cua`](https://github.com/trycua/cua) | COMPUTER PROVIDER | Candidate host-local CUA and automation driver with explicit device consent. | Do not permit host control as an implicit consequence of having an SID. |
| [`firecracker-microvm/firecracker`](https://github.com/firecracker-microvm/firecracker) | ISOLATION OPTION | MicroVM backend for selected untrusted execution workloads. | Requires compatible Linux/KVM hosts and operations; not portable to every device. |
| [`google/gvisor`](https://github.com/google/gvisor) | ISOLATION OPTION | Additional container sandboxing backend, selected per environment risk and performance. | Validate kernel/host compatibility; not a substitute for tenant policy. |
| [`microsoft/playwright`](https://github.com/microsoft/playwright) | BROWSER PROVIDER | Deterministic browser automation and E2E test automation. | Persistent cookies and browsing state must be per-SID isolated and secured. |
| [`ComposioHQ/composio`](https://github.com/ComposioHQ/composio) | CONNECTED-APP ADAPTER | Optional MCP/connected application catalog, OAuth account linking and tool adapters. | Managed and OSS licensing/pricing/scope verification; platform authorizes tools separately. |
| [`n8n-io/n8n`](https://github.com/n8n-io/n8n) | OPTIONAL WORKFLOW CONNECTOR | Customer-connected third-party workflow engine, triggered or called through controlled action contracts. | Distinct product from Nod; separate license; never second canonical job ledger. |
| [`pipecat-ai/pipecat`](https://github.com/pipecat-ai/pipecat) | VOICE ENGINE CANDIDATE | Real-time turn handling, speech pipeline and interruption control. | Verify actual provider support/latency and licensing. |
| [`SYSTRAN/faster-whisper`](https://github.com/SYSTRAN/faster-whisper) | LOCAL STT | Optional self-hosted speech-to-text adapter. | Quality and CPU/GPU limits, model licenses and consent. |
| [`hexgrad/kokoro`](https://github.com/hexgrad/kokoro) | LOCAL TTS | Candidate local/offline text-to-speech engine. | Review model voices and redistribution licenses. |
| [`OHF-Voice/piper1-gpl`](https://github.com/OHF-Voice/piper1-gpl) | LICENSED TTS OPTION | Alternative offline TTS subject to GPL and model voice licensing. | Keep optional and isolated if redistribution creates obligations. |
| [`nickvasilescu/grokbot-clone`](https://github.com/nickvasilescu/grokbot-clone) | HISTORICAL REFERENCE | Older UI/runtime patterns only if independently useful. | Avoid protected names/voices/art and no redundant agent stack. |

### 3.1 Foundation allocation (not a three-way platform merge)

**OpenMausBot** is the preferred app/desktop seed: start from the permitted OSS subset only. Test its Hermes ACP driver end to end, accessible UI, multi-bot channels, teams, local desktop safety, computer instances, replay and cancellation. Route ALL actions through the new Rust enforcement boundary and shared API/ledger. Replace owner-global SQLite/filesystem/session/secret assumptions with tenant/project/SID authorization and scoped storage. A failed Hermes or license parity gate makes the original hybrid UI viable; no hard gate can be offset by more features.

**Bot HQ** is a source for useful Hermes-specific streaming/gateway and targeted UX patterns, but not a separate live SaaS or planning master. **Nod** provides proven design inspiration and (after code audit) selected browser/Vault/scheduler/memory building blocks, but its one-owner Pi agent runner must not be an alternate required reasoning brain.

### 3.2 Smithers and SkillForge are not the same product

**Smithers** owns development workflow stages: intake, break down tasks, allocate specialists, trigger investigation/build/test tools, create branches/artifacts, request peer reviews, preserve checkpoints and present GO/NO-GO evidence. **SkillForge** owns the signed/verified lifecycle of an agent capability: draft -> compile -> evaluate -> approve -> publish -> install -> revoke. A Markdown skill is not a functioning MCP server. The factory must publish concrete APIs, typed inputs/outputs, permissions, errors and tests, and verify an independent agent can invoke the tool.

**REA** is a scoped investigation adapter with source provenance and lawful observation boundaries. Its exact source lineage remains unconfirmed. **Craft Anything** is a build/check adapter, not a promise to reproduce any proprietary product perfectly or a replacement for original engineering.

### 3.3 Security family and evidence semantics

Security agents may use Pentest Copilot for approved engagements, OKF to perform repeatable scanning/finding-delta and issue canonical receipts, the PayloadsAllTheThings fork for *retrieval only*, and Cloud Attack Range for scoped disposable labs. A scan finding is not a validated vulnerability; a hash receipt is not proof of correctness; a claimed Bitcoin timestamp must pass actual proof verification. The uploaded OKF snapshot passed receipt-ID and adjacent-ledger internal checks but had 8 mismatched artifact hashes and 4 absent file references; ship a verifier that reports these states without changing historical bytes.

### 3.4 Media and specialist families

Parallax is a Creative Studio candidate pending source-level verification: implement provider-neutral image/video/audio job contracts, original asset rights, generated output digests, credits, real previews and exports. Music packs and game/NPC packs add reviewed expertise and domain gates; they do not provide production-ready audiovisual engines or clinical credentials merely by being imported.

## 4. Repo-by-repo: all 103 additional role, skill, data, motion, quality and evaluation candidate sources

**Universal intake status:** All entries in the v6 CSV are `USER_SUPPLIED / REQUIRES SOURCE+LICENSE AUDIT`. The roles below describe intended *use after approval*, not feature claims. Most should be **knowledge/skill/evaluation assets**, not installed services. Priority P0 means essential for the early release acceptance process; P1 is a near-term useful candidate; P2 is specialist/advanced optional. A collection of links is a discovery index and must never automatically execute its content.

### Identity & general workforce (5 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`cryptonomicsed-byte/card-protocol`](https://github.com/cryptonomicsed-byte/card-protocol) | TEMPLATE/REFERENCE | Canonical business-card record hashing, chain history and schema compatibility references; identity remains separate. | P1 |
| [`cryptonomicsed-byte/helixmain`](https://github.com/cryptonomicsed-byte/helixmain) | TEMPLATE/REFERENCE | Optional business operations CARD and voice/MCP integration patterns; separate authority and license audit. | P1 |
| [`msitarzewski/agency-agents-app`](https://github.com/msitarzewski/agency-agents-app) | TEMPLATE/REFERENCE | Specialist role catalog gallery and installation UX reference only. | P1 |
| [`adamoutler/gemini-agency-agents`](https://github.com/adamoutler/gemini-agency-agents) | TEMPLATE/REFERENCE | Cross-harness packaging format reference for role templates. | P1 |
| [`Arlandaren/proagents`](https://github.com/Arlandaren/proagents) | TEMPLATE/REFERENCE | Additional expert roles and process checklists selected by objective evaluation. | P1 |

### Anti-slop & design (14 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`agshinrajabov/no-slop-design`](https://github.com/agshinrajabov/no-slop-design) | GATE/SKILL | Design research, real references/moodboards, purpose-made tokens and intentionality review before UI implementation. | P1 |
| [`miqdadbadjuber/anti-slop`](https://github.com/miqdadbadjuber/anti-slop) | GATE/SKILL | Hard filters for generic prose/UI/code and an explicit final delivery gate. | P1 |
| [`soheilmomeniii/no-slop`](https://github.com/soheilmomeniii/no-slop) | GATE/SKILL | Grounded editorial writing review, source fidelity and language distinctiveness. | P1 |
| [`Mo-Awadalla/anti-slop`](https://github.com/Mo-Awadalla/anti-slop) | GATE/SKILL | Evidence-driven code diagnosis and anti-redundancy/refactoring review. | P1 |
| [`iCodeCraft/anti-slop`](https://github.com/iCodeCraft/anti-slop) | GATE/SKILL | Review prompts for compact diffs, security considerations and pull-request hygiene. | P1 |
| [`misbahsy/anti-ai-slop`](https://github.com/misbahsy/anti-ai-slop) | GATE/SKILL | Additional writing cleanup and multi-stage text review. | P1 |
| [`the-hooman-loop/anti-slop-kit`](https://github.com/the-hooman-loop/anti-slop-kit) | GATE/SKILL | Portable anti-slop, evidence checking and small-slice execution checks. | P1 |
| [`drunkrhin0/antislop`](https://github.com/drunkrhin0/antislop) | GATE/SKILL | Prose and copy editing to reduce repetitive generic language. | P1 |
| [`jhuse25/anti-slop-design-skills`](https://github.com/jhuse25/anti-slop-design-skills) | GATE/SKILL | High-finish UI, presentation and document quality critique templates. | P1 |
| [`kjmagnan1s/anti-slop`](https://github.com/kjmagnan1s/anti-slop) | GATE/SKILL | Negative-pattern detection and preservation of intentionally chosen voice. | P1 |
| [`dkneeland/agentic-guardrails`](https://github.com/dkneeland/agentic-guardrails) | GATE/SKILL | Modular process reviews for excess code, duplication, incomplete output and slop. | P1 |
| [`Nutlope/hallmark`](https://github.com/Nutlope/hallmark) | GATE/SKILL | A design review lens for default-looking generative frontend output. | P1 |
| [`Leonxlnx/taste-skill`](https://github.com/Leonxlnx/taste-skill) | GATE/SKILL | Subjective design taste prompts; calibrate against real expert visual reviews. | P1 |
| [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) | GATE/SKILL | Design vocabulary, hierarchy and critique vocabulary for front-end polish. | P1 |

### Motion & creative tooling (5 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`greensock/gsap-skills`](https://github.com/greensock/gsap-skills) | SKILL/REFERENCE | GSAP animation/timeline/scroll choreography guidance for web experiences. | P1 |
| [`frankxai/awesome-motion-design-agent-skills`](https://github.com/frankxai/awesome-motion-design-agent-skills) | SKILL/REFERENCE | Motion skill discovery; index only vetted individual tools. | P1 |
| [`emilkowalski/skills`](https://github.com/emilkowalski/skills) | SKILL/REFERENCE | Timing, easing, gesture and responsive interaction critique. | P1 |
| [`remotion-dev/skills`](https://github.com/remotion-dev/skills) | SKILL/REFERENCE | Programmable video timelines/rendering conventions for creative projects. | P1 |
| [`LottieFiles/motion-design-skill`](https://github.com/LottieFiles/motion-design-skill) | SKILL/REFERENCE | Lottie animation specification, state animations and export checklists. | P1 |

### Product quality & release gates (3 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`thedaviddias/Front-End-Checklist`](https://github.com/thedaviddias/Front-End-Checklist) | GATE | Cross-browser, performance, accessibility, SEO and frontend release checks. | P0 |
| [`fractal-nyc/software-engineering-go-launch-checklist`](https://github.com/fractal-nyc/software-engineering-go-launch-checklist) | GATE | Operations/readiness checklist and signed GO/NO-GO release record. | P0 |
| [`Moai-Team-LLC/agentic-product-standard`](https://github.com/Moai-Team-LLC/agentic-product-standard) | GATE | Agent-product-specific Definition of Done and behavior checks. | P0 |

### Smart contracts & Web3 (15 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`andresdefi/cryptoskills`](https://github.com/andresdefi/cryptoskills) | DOMAIN SKILL | Protocol-specific research and contract development references; ingest per compatible chain and license. | P2 |
| [`0xlayerghost/solidity-agent-kit`](https://github.com/0xlayerghost/solidity-agent-kit) | DOMAIN SKILL | Solidity/Foundry unit, fuzz, invariant, audit and deployment methodology. | P2 |
| [`mystic0xx/awesome-solidity-smart-contracts-skills`](https://github.com/mystic0xx/awesome-solidity-smart-contracts-skills) | DOMAIN SKILL | Reference security patterns and pre-ship contract checklists. | P2 |
| [`giladHaimov/Smart-Contract-AI-Audit-Skill`](https://github.com/giladHaimov/Smart-Contract-AI-Audit-Skill) | DOMAIN SKILL | Structured vulnerability-class review prompts; validate against independent tools. | P2 |
| [`DarkNavySecurity/web3-skills`](https://github.com/DarkNavySecurity/web3-skills) | DOMAIN SKILL | Contract/client security and on-chain incident-analysis review practices. | P2 |
| [`sanbir/solidity-auditor-skills`](https://github.com/sanbir/solidity-auditor-skills) | DOMAIN SKILL | Specialized EVM risk lenses: access, math, bridges, proxy, economy. | P2 |
| [`pashov/ai-web3-security`](https://github.com/pashov/ai-web3-security) | DOMAIN SKILL | Curated Web3 auditing methodology and research links. | P2 |
| [`pashov/skills`](https://github.com/pashov/skills) | DOMAIN SKILL | Candidate individual audit skills selected after license/static checks. | P2 |
| [`marchev/awesome-ai-web3-security`](https://github.com/marchev/awesome-ai-web3-security) | DOMAIN SKILL | Discovery index for audit skill sets and benchmark resources. | P2 |
| [`daoism-systems/solidity-audit-skills`](https://github.com/daoism-systems/solidity-audit-skills) | DOMAIN SKILL | Candidate audit-role orchestration/aggregation; avoid running duplicate unreviewed packs. | P2 |
| [`nuwrldnf8r/smart-contract-audit-skill`](https://github.com/nuwrldnf8r/smart-contract-audit-skill) | DOMAIN SKILL | Cross-chain audit methodology with ecosystem-specific adaptation. | P2 |
| [`dilukangelosl/web3-ai-skills`](https://github.com/dilukangelosl/web3-ai-skills) | DOMAIN SKILL | Smart-contract, infrastructure and web3 frontend role templates. | P2 |
| [`jiayaoqijia/cryptoskill`](https://github.com/jiayaoqijia/cryptoskill) | DOMAIN SKILL | Candidate crypto skill discovery and versioning patterns. | P2 |
| [`LollyTim/solidity-evm-skill`](https://github.com/LollyTim/solidity-evm-skill) | DOMAIN SKILL | Focused EVM/Solidity engineering rules and review criteria. | P2 |
| [`mrheyday/agentic-solidity-foundry-skill`](https://github.com/mrheyday/agentic-solidity-foundry-skill) | DOMAIN SKILL | Foundry development, test and safety workflow prompts. | P2 |

### Personas, roles & NPC (13 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`NPC-Worldwide/npcsh`](https://github.com/NPC-Worldwide/npcsh) | DATA/ROLE/EVAL | Composable persona/agent-shell patterns, not a second mandatory runtime. | P2 |
| [`Neph0s/awesome-llm-role-playing-with-persona`](https://github.com/Neph0s/awesome-llm-role-playing-with-persona) | DATA/ROLE/EVAL | Roleplay and persona research bibliography, not executable agents. | P2 |
| [`tencent-ailab/persona-hub`](https://github.com/tencent-ailab/persona-hub) | DATA/ROLE/EVAL | Synthetic persona data candidate for diversity/evaluation, with dataset rights checks. | P2 |
| [`anthropics/evals`](https://github.com/anthropics/evals) | DATA/ROLE/EVAL | Model/persona evaluations and measurement examples; dataset review only. | P2 |
| [`InteractiveNLP-Team/RoleLLM-public`](https://github.com/InteractiveNLP-Team/RoleLLM-public) | DATA/ROLE/EVAL | Role consistency evaluation and RoleBench-style test design. | P2 |
| [`choosewhatulike/trainable-agents`](https://github.com/choosewhatulike/trainable-agents) | DATA/ROLE/EVAL | Character-style role adaptation research, not authorization to impersonate real people. | P2 |
| [`LISK819129/OpenNPC`](https://github.com/LISK819129/OpenNPC) | DATA/ROLE/EVAL | NPC personality/dialogue architecture patterns for games and simulations. | P2 |
| [`agent-persona/personas-pipeline`](https://github.com/agent-persona/personas-pipeline) | DATA/ROLE/EVAL | Provenance-aware extraction of persona traits from authorized input data. | P2 |
| [`jvanheerikhuize/Agent-Roles`](https://github.com/jvanheerikhuize/Agent-Roles) | DATA/ROLE/EVAL | Small curated role definitions and format crosswalks. | P2 |
| [`wonsukchoi/domain-experts`](https://github.com/wonsukchoi/domain-experts) | DATA/ROLE/EVAL | Occupation-based decision frameworks and task checklists. | P2 |
| [`tkr520521/ai-persona-skills`](https://github.com/tkr520521/ai-persona-skills) | DATA/ROLE/EVAL | Reasoning-framework templates; avoid impersonation or unsupported named authority. | P2 |
| [`aivrar/ai-character-engine`](https://github.com/aivrar/ai-character-engine) | DATA/ROLE/EVAL | Layered NPC memory, dialogue and social mechanics research. | P2 |
| [`ChiefGyk3D/department-of-internal-arguments`](https://github.com/ChiefGyk3D/department-of-internal-arguments) | DATA/ROLE/EVAL | Adversarial review and constructive disagreement between specialists. | P2 |

### Game development & simulation (6 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`gamedev-skills/awesome-gamedev-agent-skills`](https://github.com/gamedev-skills/awesome-gamedev-agent-skills) | DOMAIN SKILL | Game-engine capability discovery, select one engine-specific skill pack per project. | P2 |
| [`MengTo/Skills`](https://github.com/MengTo/Skills) | DOMAIN SKILL | Candidate Three.js/VFX/game-design workflows and prototype examples. | P2 |
| [`abagames/agentic-gamedev-skills`](https://github.com/abagames/agentic-gamedev-skills) | DOMAIN SKILL | Gameplay prototyping, procedural sound and reproducible verification. | P2 |
| [`ThiagoFdaSLopes/game-dev-skills`](https://github.com/ThiagoFdaSLopes/game-dev-skills) | DOMAIN SKILL | Game build-debug-review-test-performance process gates. | P2 |
| [`jammaru/jev-lab`](https://github.com/jammaru/jev-lab) | DOMAIN SKILL | Simulation of NPC social behavior for evaluation, distinct from Jev trust checker. | P2 |
| [`SnapdragonGameStudios/mindsand-engine`](https://github.com/SnapdragonGameStudios/mindsand-engine) | DOMAIN SKILL | NPC team and behavior-engine architecture candidate; hardware/license compatibility gate. | P2 |

### Music & media (3 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`ghsau/music-studio`](https://github.com/ghsau/music-studio) | DOMAIN SKILL | Music production team roles, briefs and repeatable creative handoffs. | P2 |
| [`owoevan-dev/music-skill`](https://github.com/owoevan-dev/music-skill) | DOMAIN SKILL | Original editable score/MIDI/stems creation candidates and audio QA. | P2 |
| [`scenario-labs/skills`](https://github.com/scenario-labs/skills) | DOMAIN SKILL | Audio/video/image/3D media workflow guidance and asset-consistency checks. | P2 |

### Medical & scientific research (5 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`aipoch/medical-research-skills`](https://github.com/aipoch/medical-research-skills) | DOMAIN SKILL/EVAL | Biomedical literature review, research design and evidence grading skill candidates. | P2 |
| [`awslabs/hcls-agent-skills`](https://github.com/awslabs/hcls-agent-skills) | DOMAIN SKILL/EVAL | Clinical/life-science analysis templates, genomics and research workflows subject to privacy. | P2 |
| [`JuneYaooo/awesome-medical-ai-skills`](https://github.com/JuneYaooo/awesome-medical-ai-skills) | DOMAIN SKILL/EVAL | Medical skill and compliant tooling discovery index. | P2 |
| [`AQ-MedAI/MedResearcher-R1`](https://github.com/AQ-MedAI/MedResearcher-R1) | DOMAIN SKILL/EVAL | Research agent evaluation/design ideas, not licensed doctor functions. | P2 |
| [`JarvisUSTC/DoctorAgent-RL`](https://github.com/JarvisUSTC/DoctorAgent-RL) | DOMAIN SKILL/EVAL | Clinical conversation evaluation research, not autonomous patient care. | P2 |

### Rust language skills (10 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`rewrite-rs/skills`](https://github.com/rewrite-rs/skills) | LANGUAGE SKILL | Rust ownership, type design, async and unsafe review skills. | P1 |
| [`leonardomso/rust-skills`](https://github.com/leonardomso/rust-skills) | LANGUAGE SKILL | Comprehensive Rust code-style and correctness rules. | P1 |
| [`morganlinton/BeautifulRust`](https://github.com/morganlinton/BeautifulRust) | LANGUAGE SKILL | Focused Rust implementation/review/porting gate and lint profile. | P1 |
| [`huiali/rust-skills`](https://github.com/huiali/rust-skills) | LANGUAGE SKILL | Specialized Rust practices selected per job. | P1 |
| [`udapy/rust-agentic-skills`](https://github.com/udapy/rust-agentic-skills) | LANGUAGE SKILL | Agent-centric Rust task and tool practice candidates. | P1 |
| [`Newmcpe/rust-coding-skill`](https://github.com/Newmcpe/rust-coding-skill) | LANGUAGE SKILL | Type-first Rust modeling and mandatory fmt/clippy/tests. | P1 |
| [`po4yka/rust-skills`](https://github.com/po4yka/rust-skills) | LANGUAGE SKILL | Unsafe/FFI/atomics/performance audit skill candidates. | P1 |
| [`full-stack-skills/rust-skills`](https://github.com/full-stack-skills/rust-skills) | LANGUAGE SKILL | Progressive Rust library/API/embedded subject guides. | P1 |
| [`Jeffallan/claude-skills`](https://github.com/Jeffallan/claude-skills) | LANGUAGE SKILL | Rust engineer profile; isolate exact relevant subskill. | P1 |
| [`actionbook/rust-skills`](https://github.com/actionbook/rust-skills) | LANGUAGE SKILL | Dynamic and domain-specific Rust guidance; audit supply chain. | P1 |

### Elixir language skills (1 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`georgeguimaraes/elixir-agent-tools`](https://github.com/georgeguimaraes/elixir-agent-tools) | LANGUAGE SKILL | OTP supervisors, Ecto/Phoenix/Oban and reliability practices. | P0 |

### Julia language skills (2 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`JuliaGenAI/julia-agent-skills`](https://github.com/JuliaGenAI/julia-agent-skills) | LANGUAGE SKILL | Julia package/documentation/data-science workflow guidance. | P1 |
| [`Krastanov/JuliaLLMAgentSkills`](https://github.com/Krastanov/JuliaLLMAgentSkills) | LANGUAGE SKILL | Julia numerical optimization, interface and scientific computing workflows. | P1 |

### Sui Move skills (2 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`MystenLabs/skills`](https://github.com/MystenLabs/skills) | LANGUAGE SKILL | Sui Move object semantics, package setup, testing and security guidance. | P1 |
| [`MystenLabs/sui-dev-skills`](https://github.com/MystenLabs/sui-dev-skills) | LANGUAGE SKILL | Sui Move development workflow alternative; deduplicate with other official pack. | P1 |

### Go language skills (5 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`mythicalhacker/go-mastery`](https://github.com/mythicalhacker/go-mastery) | LANGUAGE SKILL | Modern Go style, concurrency, race/error handling and performance checks. | P1 |
| [`spf13/go-skills`](https://github.com/spf13/go-skills) | LANGUAGE SKILL | Go CLI/service idioms and maintainability practices. | P1 |
| [`saisudhir14/claude-skills`](https://github.com/saisudhir14/claude-skills) | LANGUAGE SKILL | Focused Go tests, lint, errors, concurrency and security gates. | P1 |
| [`samber/cc-skills-golang`](https://github.com/samber/cc-skills-golang) | LANGUAGE SKILL | Production Go observability, architecture and testing patterns. | P1 |
| [`madflojo/go-style-agent-skill`](https://github.com/madflojo/go-style-agent-skill) | LANGUAGE SKILL | Go review and architecture style references. | P1 |

### Python language skills (2 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`polyglotdev/best-practice-skills`](https://github.com/polyglotdev/best-practice-skills) | LANGUAGE SKILL | Python typing, FastAPI/Pydantic, ruff and packaging practices. | P1 |
| [`fgmacedo/agent-skills`](https://github.com/fgmacedo/agent-skills) | LANGUAGE SKILL | Python profiling, refactoring and migration skills. | P1 |

### Clojure language skills (4 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`iwillig/clojure-skills`](https://github.com/iwillig/clojure-skills) | LANGUAGE SKILL | Clojure REPL, Malli/spec, concurrent and database practices. | P1 |
| [`iwillig/agentic-engineering-with-clojure`](https://github.com/iwillig/agentic-engineering-with-clojure) | LANGUAGE SKILL | Agent-assisted Clojure development process and REPL workflow. | P1 |
| [`chaploud/clojure-skills`](https://github.com/chaploud/clojure-skills) | LANGUAGE SKILL | Structural editing, nREPL and clojure-lsp skills. | P1 |
| [`nWave-ai/nWave`](https://github.com/nWave-ai/nWave) | LANGUAGE SKILL | Functional Clojure patterns and testing conventions when exact files are audited. | P1 |

### Multi-language & process collections (8 entries)

| Repository | Target asset | What we specifically extract or evaluate | Priority |
|---|---|---|---|
| [`jscraik/Agent-Skills`](https://github.com/jscraik/Agent-Skills) | DISCOVERY/PROCESS | Multi-language role discovery and extraction of relevant subskills. | P2 |
| [`VoltAgent/awesome-agent-skills`](https://github.com/VoltAgent/awesome-agent-skills) | DISCOVERY/PROCESS | Source discovery only; choose vetted individual skills rather than importing catalog. | P2 |
| [`sickn33/agentic-awesome-skills`](https://github.com/sickn33/agentic-awesome-skills) | DISCOVERY/PROCESS | Broad skill discovery index, no wholesale installation. | P2 |
| [`obra/superpowers`](https://github.com/obra/superpowers) | DISCOVERY/PROCESS | Planning, TDD, review and evidence-first engineering practices. | P2 |
| [`mattpocock/skills`](https://github.com/mattpocock/skills) | DISCOVERY/PROCESS | Modern engineering/problem-framing practice templates. | P2 |
| [`kodustech/awesome-agent-skills`](https://github.com/kodustech/awesome-agent-skills) | DISCOVERY/PROCESS | Curated source discovery and attribution registry. | P2 |
| [`JackyST0/awesome-agent-skills`](https://github.com/JackyST0/awesome-agent-skills) | DISCOVERY/PROCESS | Curated source discovery and attribution registry. | P2 |
| [`Mindrally/skills`](https://github.com/Mindrally/skills) | DISCOVERY/PROCESS | Select individual language/process skills after tests and rights review. | P2 |

## 5. What AgentOS itself must build — not present as a complete merged upstream service

| Component to build | Required implementation details | Validation evidence |
|---|---|---|
| Rust authority kernel | Authenticate principal; verify SID/issuer, tenant ACL, scope, risk, quotas, approval state and exact typed arguments; issue signed/short-lived lease epochs; defend TOCTOU and revocation | Cross-tenant denial, altered-args rejection, replay and revoked lease tests |
| SID `sid/0.2` identity issuer and migration | Preserve legacy sid/0.1 hashes; neutral interoperable profile; signature trust, key rotation, revocation, transfer; installation ledger | Golden vector hashes, signature vectors, revoke/transfer tests |
| Elixir workforce scheduler | Durable queue, `DynamicSupervisor`, per-task GenServer, lease fencing, concurrency caps, checkpoint, crash reaper, teardown inspection | Crash/restart, task replay, duplicate prevention, leaked-session checks |
| Original SaaS control plane | Organizations, SSO where offered, RBAC, Free/Basic/Pro/Teams/Enterprise, billing, quotas, BYOK, usage ledger, abuse support and data retention | Two-tenant isolation, overage/payment correction, rollback tests |
| Unified event/task database | PostgreSQL models, transactions/outbox, idempotency records, task attempts, workspace/event histories, artifact ACL, optimistic versioning | DB migration/rollback, consumer replay and integrity proofs |
| Typed skills registry | Scan upstream content; license and source pin; sandbox evaluation; publish signed role/skill packages; per-SID permission diff; revocation | Malicious prompt/script rejection, altered package SHA, rollback |
| A2A/MCP gateway | Discover tools, expose typed operations, avoid key disclosure, enforce exact grants, support cancellation/rate limits and per-team visibility | True round-trip from an independent SID agent and negative auth cases |
| Vault/browser/computer | Encrypt secrets under platform KMS, opaque credential injection, per-SID browser profile, isolated VM/container, egress rules, device takeover grants | Secret exfiltration, cookie bleed, wrong-site login, kill switch tests |
| Model and runtime adapter | Hermes native + ACP bridging, streaming, tool proposals/receipts, sessions, resumability, cost accounting, provider model controls | Hermes parity on model switching, delegation, tool use, replay, cancellation |
| Memory service | SID/tenant namespace ACL, source provenance, observational vs approved facts, learned skill proposals, retention/delete/export, cache/embedding invalidation | Memory leak and injected website-data-as-instruction tests |
| Job/scheduler/observers | Cron/event tasks with timezones, budget and missed-run rules, verified webhook signatures, proactive draft-only prework policy | DST, duplicate event, crash, rate limit, stale approval tests |
| Smithers/SkillForge factory | Project specification, evidence-backed REA, secure Craft build tools, task DAG, role teams, skill compiler, CI, independent QA, release and handoff | Complete video app (below) plus separate SID agent executing new MCP tools |
| High-end design gate service | `DESIGN.md`, reference moodboard, design tokens, original licensed assets, motion grammar, screenshot/video QA, a11y, performance, reality check | Actual device screenshots, keyboard/screen reader test, reduced motion, end-to-end functionality |
| Security pipeline | Restricted Pentest MCP, OKF scan/finding schemas, signed evidence verifier, controlled cloud labs and remediation | Authorized target proof, integrity mismatch display, lab TTL cleanup, exploit negatives |
| Creative / game / music modules | Typed media jobs, providers/renderers, rights manifests, exported editable assets, NPC world bindings, simulation score traces | Playback/exports, source rights, scene recovery and behavior consistency |
| Blockchain settlement (only if enabled) | Sui Move packages, capability object model, anti-replay, gas caps, wallet/signer approvals, testnet evidence and human authorizations | Property/invariant tests, independent reviewer, real testnet receipt, denial tests |

### 5.1 Versioned data model / important object boundaries

Implement `Tenant`, `User`, `OrganizationMembership`, `RoleTemplate`, `RoleVersion`, `SkillPackVersion`, `SourceManifest`, `QualityGatePack`, `AgentIdentity`, `AgentInstallation`, `RuntimeBinding`, `CapabilityGrant`, `ActionIntent`, `PolicyDecision`, `Approval`, `Task`, `TaskAttempt`, `ExecutionLease`, `Checkpoint`, `Artifact`, `WorkReceipt`, `MemoryFact`, `MemoryNamespace`, `ConnectedAccount`, `ComputerLease`, `UsageReservation`, `UsageSettlement`, `FactoryProject`, `BuildJob`, `ReleaseDecision`, `NPCEmbodiment`, `LabRun`, `CreativeJob`, `EvidenceReceipt`, `AuditEvent`.

**Critical identities:** `sid` identifies a principal, `role_template_digest` identifies instruction content, `installation_id` binds it to a customer and permission set, `worker_id` identifies a temporary process, `lease_id + epoch` authorizes one bounded attempt, `task_id` is durable work, `receipt_id` is evidence. Never treat one identifier as a substitute for another.

### 5.2 Seven-language architecture

| Runtime | Service(s) | Interface and operational contract | Why it is separate |
|---|---|---|---|
| Rust | `identity-policy-kernel`, `capability-broker`, `sandbox-admission` | Signed policy/lease APIs, immutable audit, strictly typed grants | One small trustworthy security boundary independent of LLM |
| Elixir/OTP | `workforce-orchestrator`, `task-supervisors` | Durable queue+leases; authenticated Hermes calls; worker termination receipts | Fault-tolerant high-concurrency worker lifecycle, not a global identity store |
| Julia | `numeric-memory`, `simulation-analytics` | Versioned request, bounded computation, deterministic fixtures when necessary | Efficient numerical/simulation and analytics execution; opt-in per task |
| Clojure | `symbolic-review`, `decision-DSL` | Declarative rule proposals and transparent explanations | Functional/symbolic interpretations; Rust alone enforces |
| Python | `hermes-tool-bridge`, `skillforge`, `research-providers` | Versioned typed tool calls, sandbox subprocesses | Wide tool, AI and research integration library |
| Go | `network-gateway`, `voice/mesh transport`, `event-bridge` | mTLS/service identity, retry/timeout/stream contracts | High-concurrency networking and protocol gateways |
| Sui Move | `chain-settlement` | Audited on-chain packages, testnet/mainnet gating, no private keys in model | Tamper-evident chain objects for configured markets/economy |
| TypeScript | `apps/web`, `apps/desktop` | Responsive UI and command/query API, not trusted for authorization | Reuses selected app foundation; developer productivity |

**Polyglot principle:** Launch the stable path through existing working languages/frameworks; do not require 7 languages to execute every task. Add a language service when its ownership and measured benefit justify it. Use shared protobuf/OpenAPI/JSON Schema and cross-language golden fixtures to prevent serializer and hash drift.

## 6. Built-in specialist workforce: concrete launch teams

### 6.1 Initial enabled roles

1. **Systems Engineering:** Rust Kernel Engineer, Elixir OTP Engineer, Go Gateway Engineer, Python Tool Engineer, Julia Compute Engineer, Clojure Logic Engineer, Sui Move Engineer. Each loads reviewed **one** specialist role plus the minimum language-specific skills.
2. **Factory:** Product/Delivery Lead, Software Architect, Backend Engineer, Frontend Engineer, QA Reality Checker, Security Reviewer, DevOps Release Engineer and SkillForge Engineer.
3. **Design:** Creative Director, Brand Guardian, UX Architect, UI Designer, Motion Director, Accessibility Reviewer, Content Editor.
4. **Security:** Scoped Security Analyst, Finding Reviewer, Evidence/Receipt Verifier, Remediation Engineer and Authorized Lab Evaluator.
5. **Research:** Evidence Researcher, Hypothesis Challenger, Citation Auditor. Separately reviewed medical-literature and bioinformatics research roles are restricted to non-autonomous clinical use.
6. **Creative:** Video Producer, Sound Designer, Media Editor, Original Composer; NPC World Designer, Dialogue Writer and Game QA are optional modules.
7. **Smart contracts:** Sui Move Developer, Economic Model Reviewer and independent Contract Auditor. EVM/Solidity roles separate from Move because toolchains and failure models differ.

### 6.2 Example: creating and using a real agent

- Customer clicks **Install Rust Kernel Engineer**.
- Catalog displays version, source attribution, risk class, skills, permissions requested, tests, cost and known limits.
- Platform issues/signs SID (or binds pre-existing tenant-controlled SID) and makes a separate `AgentInstallation` with namespace and zero implied shell/production grants.
- Project defines a task and acceptance tests; policy allocates tools/budget; Rust issues expiring execution lease.
- Elixir starts one worker. Hermes uses the selected model and reviewed role to plan a code change; an isolated build sandbox compiles/tests the change.
- Independent reviewer checks compiler/lint/unit/integration/security and source provenance. Smithers records accepted/rework decision.
- Task finishes, sandbox and Elixir worker stop; SID persists and can be rehydrated for another task with a fresh lease.

**Elixir process creation doesn't create a new person; temporary workers are executions of a persistent principal.** If the user expects an autonomous persistent agent, continuity comes from SID + authorized persistent state, not from keeping every BEAM process running forever.

### 6.3 Role/persona intake pipeline

`Discover -> Fetch pinned SHA -> Capture exact license+content hashes -> Quarantine -> Parse metadata -> Reject untrusted scripts/secrets -> Convert to RoleTemplate/SkillPack/GatePack -> Human+static review -> Sandbox evaluate -> Package signed version -> Publish -> Install to SID -> Re-evaluate on every upgrade.`

**Research datasets** such as synthetic personas are not automatically converted into trusted production agents. **Profession-specific content** only represents structured instructions; it does not confer professional licenses, accuracy guarantees, or allowed actions. **Cloning a role template doesn't transfer its author or provider's credentials.**

## 7. Design and product quality: anti-slop as a real quality program

High-end output requires a set of *reviewable artifacts*, not just prompt wording. Apply Agency Agents design roles; selectively import no-slop/anti-slop rules; use a design/research brief and specific motion tools when they improve usability; enforce a factual functional Definition of Done.

**Every design-focused project produces:**
- `RESEARCH.md` with cited references, project audience and alternatives.
- `MOODBOARD.md` with licensed references and interpretation, not copied sites.
- `DESIGN.md` with goals, discarded directions, tokens, type hierarchy, layout rhythm, component states, responsive breakpoints and signature details.
- `TOKENS.json` semantic variables (including state and contrast).
- `MOTION.md` stating interactions, choreography, durations, easing, interruption, reduced-motion and accessibility fallbacks.
- `COMPONENT_INVENTORY.md` with every feature, empty/loading/failure/permission states.
- `UI_QA/` screenshots and recordings from a running site at chosen device sizes.
- `ACCESSIBILITY_REPORT.md` manually/automatically checked critical flows.
- `AUDIT_DESIGN.json` with chosen reviewer, scores, critiques and evidence.
- `RELEASE_EVIDENCE/` CI, perf, security and rollback proof.

**Blocking gates:** actual functionality; role/tenant isolation; security; usable accessibility; licensed assets; correctness of live connections; responsiveness; measurable performance; real error handling; source provenance. Subjective distinctiveness is evaluated by an independent reviewer against a project-specific rubric; never enforce a single aesthetic formula, large animation library or arbitrary novelty score for every enterprise interface.

### 7.1 Motion design

GSAP, Lottie, Remotion and motion-specific skills are provider/tool options; do not force them into a static admin dashboard or an Unreal 3D engine. Explicitly distinguish web motion, rendered video animation, 3D character rigs and interactive world movement. Respect reduced motion and CPU/GPU budgets.

## 8. Platform Factory: complete business pipeline

**Inputs:** approved customer spec or authorized observed reference; target platform, budget, licensing, acceptance tests, environment and explicit build/deploy ownership.

1. **Intake:** Smithers collects scope/risks/cost and freezes a versioned FactoryProject manifest; Rust checks who may initiate work.
2. **Research:** REA and researchers gather evidence and compare public/documented features. Inferences are marked; protected code/assets are not copied into an original product.
3. **Team assembly:** Agency Agents templates become SID installations; temporary Elixir workers take planned tasks.
4. **Architecture:** Technical agents create API, DB, event, security, media/storage, model and UX schemas with design and quality packs.
5. **Build:** Craft Anything and coding agents operate approved git/build tools inside isolated environments; branch workflows record digests and tests.
6. **Capabilities:** SkillForge generates *real* typed operations plus published MCP endpoints/A2A cards, docs, test fixtures and negative cases.
7. **Verification:** Independent QA and security roles run tests; Reality Checker checks completeness; OKF can issue evidence receipts for security-related artifacts.
8. **Human release gate:** Customer/authorized approver reviews exact changes, costs, domains, effects, legal rights and rollout plan.
9. **Deployment:** Signed CI/CD deploys authorized infrastructure; monitoring, backups and rollback are configured.
10. **Independent operation:** A different SID agent discovers new capabilities, authenticates, completes a production-like task, gets a verifiable result and demonstrates clean recovery.

### 8.1 First acceptance product: agent-native video platform

Build a truly functional original video-sharing service (not a copy of a competitor's protected code). Minimum: upload, object storage, transcoding, streaming formats, thumbnails, channels, comments, search, moderation/reporting, tenant/authz, metrics and sensible billing if offered. Expose real typed `channel.create`, `video.upload`, `video.publish`, `video.search` and `video.comment` APIs through MCP. A separate SID agent must operate the deployed service with proper denial/error cases. Run load, security, persistence, disaster recovery and streaming/browser tests, then independent release signoff.

## 9. Product experience and commercialization

**Primary screens:** workspace chat, agents/SIDs, roles catalog, team board, task inspector, event stream, computer viewer and operator takeover, connected apps, memory/skill provenance, approvals, scheduled tasks, Voice, Factory board, Design Studio, Security workspace, Evidence verifier, Lab console, Creative Studio, usage/billing, organization/admin, platform settings.

**Commercial plans (initial structural proposal, not prices):**
- **Free:** BYO credentials and local permitted execution, small agent/team caps, essential chat and reviewed starter roles; hard usage limits.
- **Basic:** Additional specialist installations, moderate managed task quota and scheduled jobs.
- **Pro:** Advanced automation, memory/skills, larger teams, creative or security modules subject to safety and credits.
- **Teams:** Shared tenant roles and channels, approvals, usage pools, audit, internal app/role catalogs.
- **Enterprise:** Stronger SSO, dedicated workers/infrastructure, advanced retention, SLA/security controls and custom providers.

**Meter separately:** model tokens, cloud computer minutes, GPU/voice/video generation, outbound connectors, cloud labs, storage/egress, third-party managed services, and on-chain costs where used. Each external effect requires a spend reservation, authoritative result and settlement/refund record. Never silently choose a paid fallback after a free provider fails.

## 10. Production security, supply-chain and professional safeguards

1. **Zero trust by role name:** Developer / Auditor / Doctor / Admin is only a template title; the Rust policy decision must bind user, tenant, SID, target, exact action, data policy, risk and budget.
2. **Secret isolation:** Vault encryption and opaque credential injectors; no keys in LLM contexts, prompts, role files, build logs or browser profiles shared across SIDs.
3. **Tool mediation:** Only tool broker can invoke side-effect tools; sandbox executors revalidate bound grants; fail-closed on model uncertainty for high-risk work.
4. **No alternate execution path:** Block raw shell/MCP/CLI/desktop shortcuts that bypass the Rust gateway; all sanctioned activity has a receipt and ledger state.
5. **Scoped pentesting:** Ownership/authorization proof and scope/egress controls; never global unreviewed security tooling.
6. **Clinical boundary:** Research assistance only until separately compliant supervised clinical service exists; no diagnosis by persona name.
7. **Sui/EVM boundary:** Independent smart contract and chain-specific audits, wallet approval, gas cap, robust transaction reconciliation. Never claim an EVM checklist proves Move safety.
8. **Privacy and identity:** SID may be stable, but owned tenant resources and encrypted memories remain under ACL/retention; no hidden cross-company learning.
9. **Quality governance:** Reviewers must be independently configured from producer, with documented conflicts, false-positive reconciliation and real test artifacts.
10. **IP and content:** Audit source license, generated media rights, dataset terms, attribution, original app source and copyrighted character/music usage.
11. **Rollback:** Pinned roles, source SHA and schema version; snapshots/backups; signed deploy artifacts and actual rollback rehearsal.
12. **Audit truth:** Receipt hash verifies evidence integrity, not underlying factual truth or legal authority. Undecided external effects remain UNCERTAIN.

## 11. Detailed implementation phases and release gates

| Phase | Required deliverable | Hard acceptance |
|---|---|---|
| P0 — Source baseline and legal | Clone/pin selected repos, manifest source+licenses; test OSS-only OpenMaus build | Reproducible build; no restricted code or protected brand imported |
| P1 — Core tenant and identity | Original auth/RBAC, SID migration, Rust grants and tenant storage | Tenant boundaries, signatures and revoke operations pass |
| P2 — Worker lifecycle | Elixir OTP worker creation and teardown + leases + durable queue | Restart/cancel/duplicate-effect tests pass; worker leak test |
| P3 — Hermes and tools | Hermes ACP/gateway streaming, typed tools, computer/browser isolation | True tool parity, no alternate permission bypass |
| P4 — Catalog and skills | Reviewed roles, language/domain packs, signed templates and SkillForge prototype | Real SID installation; unauthorized skill denied |
| P5 — Nod automation | Vault, browser, memory, durable schedules, observers, approvals | Cross-SID secrets and memory tests; missed cron/recovery |
| P6 — Factory | Smithers orchestration, REA, Craft, independent QA, generated MCP | Complete prototype project task from spec to real tool |
| P7 — Specialist products | Security+OKF evidence, Parallax creative, optional lab and blockchain | Each advertised module meets real provider E2E+negative tests |
| P8 — Commercial operations | Payments, credits, telemetry, support, backups, recovery and pricing margins | Controlled pilot and paid usage reconciles without silent charges |
| P9 — Release | First original agent-native video platform and independent SID operation | All hard security/design/ops gates and release evidence |

## 12. End-to-end test obligations

- Issue a SID for a specialist and verify it retains identity after job completion/restart/model/provider switch.
- Spawn separate Elixir workers for two tenants with the same role; prove no memory, cookie, file, event or secret crossing.
- Kill the worker mid-task; verify lease fencing and exact effect reconciliation without duplicate publication or payment.
- Revoke a grant during execution and show tool denial and sandbox kill behavior.
- Upgrade a role/skill version without changing an existing SID or in-flight pinned work.
- Validate authentic Hermes tool/delegation/MCP behavior inside the selected OpenMaus/ACP path.
- Verify an untrusted persona/skill import cannot alter system prompt, issue grants, or execute shell scripts.
- Use Nod-derived browser service to log in with opaque secrets for a specifically approved domain; demonstrate failure for another site or SID.
- Verify `DESIGN.md`, live screenshots/video, reduced motion, accessibility, typography choices and real backend functionality.
- Generate a video API skill and have a different SID agent discover, invoke, verify and recover from an error.
- Run authorized security scan and record a finding/verified artifact receipt; show mismatched evidence as invalid.
- Start/stop cloud laboratory with strict budget/TTL and independent teardown proof.
- Produce and export original editable creative media with licenses and real output playback.
- Execute a Move testnet operation with correct chain/object/grant/gas limits; verify unauthorized actions are blocked.
- Prepare medical research output with reproducible references and no fabricated clinical authority.
- Exercise full backup/restore, key rotation, account deletion policy, provider outage and billing disputes.

## 13. Key constraints and open audits

**Unverified source assertions remain unverified:** The v6 candidate registry labels every new persona/skills repository as USER_SUPPLIED / REQUIRES SOURCE+LICENSE AUDIT. The current Smithers fork, REA lineage, exact Parallax media providers and Cloud Attack Range internals still need a pinned checkout, license read and test. OpenMausBot's OSS vs enterprise license separation must be kept in build packaging. Source counts or star counts do not demonstrate performance or safety. `Jev` as a checker is separate from `jammaru/jev-lab` as an NPC simulation repo. `n8n-io/nod` is not `n8n-io/n8n`.

**Priority engineering decision:** Build the **Rust lease-enforcement ↔ Elixir spawned-worker ↔ Hermes typed-tool ↔ signed SID ↔ durable ledger** vertical slice before trying to ingest hundreds of role packs. This proves AgentOS's unique operational rule instead of building a very large but inert catalog.

## 14. Source provenance and interpretation notes

- Main design basis: `/mnt/data/universal_agent_platform_master_blueprint_v6_sid_workforce.md` (v6 Part I, retaining v5/v4/v3/v2); `/mnt/data/universal_agent_platform_v6_candidate_sources.csv` (103 candidates).
- The user supplied many links and descriptive claims. Entries are documented as proposed adoption; no current public GitHub source trees or licenses have been independently fetched in this report, and the design must honor per-source rights.
- Core repo inventory is taken from v5 and v6. Source choices such as `morluto/rea` are noted with unresolved lineage; non-repository vendor/services are omitted from clone commands.
- Some entries appear both in the v5 supporting list and v6 new registry (e.g., card-protocol, agency-agents-app, proagents), and are retained only once per conceptual responsibility.
- No upstream repository has been modified. No agent runtime, security scanner or chain transaction has been executed for this design document.
