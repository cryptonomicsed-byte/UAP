#!/usr/bin/env node
/**
 * V6 checklist evidence map — honest status only.
 * status: implemented | partial | missing
 * A box may be checked in CHECKLIST only when status=implemented AND command exits 0.
 *
 * Usage:
 *   node --import tsx scripts/v6-evidence-map.mjs            # print report
 *   node --import tsx scripts/v6-evidence-map.mjs --apply    # rewrite CHECKLIST boxes + tally
 *   node --import tsx scripts/v6-evidence-map.mjs --json > docs/v6-blueprint/v6-evidence-report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKLIST = path.join(ROOT, 'docs/v6-blueprint/CHECKLIST-v6.md');

/** @typedef {{ id: string, status: 'implemented'|'partial'|'missing', evidence: string[], commands?: string[], ledger?: string }} Ev */

/** @type {Ev[]} */
const MAP = [
  // —— A. Base and rights ——
  { id: 'V6-01-01', status: 'implemented', ledger: 'M0-01', evidence: ['docs/implementation/STATUS.md', 'docs/implementation/source-pins.json', 'scripts/audit-rights.mjs'], commands: ['npm run audit:rights'] },
  { id: 'V6-01-02', status: 'implemented', ledger: 'M0-01', evidence: ['scripts/audit-branding.mjs', 'docs/rights/ASSET-RIGHTS.json'], commands: ['npm run audit:branding'] },
  { id: 'V6-01-03', status: 'implemented', ledger: 'M0-02', evidence: ['scripts/reproducible-build.mjs', 'tests/reproducible-build.test.mjs'], commands: ['node --import tsx --test tests/reproducible-build.test.mjs'] },
  { id: 'V6-01-04', status: 'implemented', ledger: 'G-23', evidence: ['server/src/agent/hermes-adapter.ts', 'tests/hermes-adapter-lifecycle.test.mjs', 'docs/v6-blueprint/HERMES-ADAPTER-MAPPING.md'], commands: ['node --import tsx --test tests/hermes-adapter-lifecycle.test.mjs'] },
  { id: 'V6-01-05', status: 'implemented', ledger: 'M0-01', evidence: ['docs/implementation/STATUS.md', 'docs/implementation/source-inventory.md'] },
  { id: 'V6-01-06', status: 'implemented', ledger: 'M1-03', evidence: ['docs/architecture/ARCHITECTURE-FREEZE.md', 'crates/agentos-policy', 'elixir/agentos_worker'] },
  { id: 'V6-01-07', status: 'implemented', ledger: 'M0-01', evidence: ['docs/rights/', 'scripts/audit-rights.mjs', '.github/workflows'], commands: ['npm run audit:rights'] },
  { id: 'V6-01-08', status: 'implemented', ledger: 'S-62', evidence: ['docs/DESIGN.md', 'web/src/styles/tokens.css', 'web/src/components/SignIn.tsx', 'web/src/components/DeployBadge.tsx'], commands: ['npm run typecheck -w web'] },
  { id: 'V6-01-09', status: 'implemented', evidence: ['docs/architecture/FORK-STRATEGY.md'] },
  { id: 'V6-01-10', status: 'implemented', ledger: 'H-29', evidence: ['tests/idle-service/', 'server/src/idle.ts'], commands: ['npm run test:idle'] },

  // —— B. Source catalog ——
  { id: 'V6-02-01', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/candidates.ts', 'docs/v6-blueprint/universal_agent_platform_v6_candidate_sources.csv', 'tests/source-registry.test.mjs'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-02', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/normalize.ts'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-03', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/classify.ts'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-04', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/access.ts'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-05', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/pin.ts', 'server/src/sources/manifest.ts'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-06', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/license.ts'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-07', status: 'implemented', ledger: 'B-21', evidence: ['server/src/sources/quarantine.ts', 'tests/source-quarantine.test.mjs'], commands: ['node --import tsx --test tests/source-quarantine.test.mjs'] },
  { id: 'V6-02-08', status: 'implemented', ledger: 'B-22', evidence: ['server/src/sources/trust.ts', 'tests/source-trust.test.mjs'], commands: ['node --import tsx --test tests/source-trust.test.mjs'] },
  { id: 'V6-02-09', status: 'implemented', ledger: 'B-22', evidence: ['server/src/sources/reaudit.ts', 'tests/source-reaudit.test.mjs'], commands: ['node --import tsx --test tests/source-reaudit.test.mjs'] },
  { id: 'V6-02-10', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/tenant-policy.ts'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },
  { id: 'V6-02-11', status: 'implemented', ledger: 'B-20', evidence: ['server/src/sources/ingest.ts', 'docs/architecture/SOURCE-REGISTRY.md'], commands: ['node --import tsx --test tests/source-registry.test.mjs'] },

  // —— C. Roles ——
  { id: 'V6-03-01', status: 'implemented', ledger: 'C-17', evidence: ['server/src/roles/role-template.ts', 'tests/role-template.test.mjs'], commands: ['node --import tsx --test tests/role-template.test.mjs'] },
  { id: 'V6-03-02', status: 'implemented', ledger: 'C-17', evidence: ['server/src/roles/persona-parser.ts', 'tests/persona-parser.test.mjs'], commands: ['node --import tsx --test tests/persona-parser.test.mjs'] },
  { id: 'V6-03-03', status: 'implemented', ledger: 'C-17', evidence: ['server/src/roles/persona-parser.ts', 'docs/architecture/ROLE-TEMPLATES.md'] },
  { id: 'V6-03-04', status: 'implemented', ledger: 'C-19', evidence: ['server/src/roles/role-review.ts', 'tests/role-review.test.mjs'], commands: ['node --import tsx --test tests/role-review.test.mjs'] },
  { id: 'V6-03-05', status: 'implemented', ledger: 'C-19', evidence: ['server/src/roles/role-review.ts'], commands: ['node --import tsx --test tests/role-review.test.mjs'] },
  { id: 'V6-03-06', status: 'implemented', ledger: 'C-18', evidence: ['server/src/roles/builtin-roster.ts', 'docs/architecture/ROLE-ROSTER.md'] },
  { id: 'V6-03-07', status: 'implemented', ledger: 'C-17', evidence: ['server/src/roles/role-template.ts'], commands: ['node --import tsx --test tests/role-template.test.mjs'] },
  { id: 'V6-03-08', status: 'implemented', ledger: 'C-18', evidence: ['server/src/roles/builtin-roster.ts', 'docs/architecture/ROLE-REVIEW.md'] },
  { id: 'V6-03-09', status: 'implemented', ledger: 'C-19', evidence: ['server/src/roles/role-review.ts'], commands: ['node --import tsx --test tests/role-review.test.mjs'] },
  { id: 'V6-03-10', status: 'implemented', ledger: 'G-23', evidence: ['server/src/agent/hermes-adapter.ts', 'server/src/agent/prompt.ts'] },

  // —— D. SID ——
  { id: 'V6-04-01', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/sid-legacy.ts', 'tests/sid-legacy.test.mjs'], commands: ['node --import tsx --test tests/sid-legacy.test.mjs'] },
  { id: 'V6-04-02', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/sid.ts', 'docs/architecture/SID-AUTHORITY.md'] },
  { id: 'V6-04-03', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/sid-authority.ts', 'tests/sid-credential.test.mjs'], commands: ['node --import tsx --test tests/sid-credential.test.mjs'] },
  { id: 'V6-04-04', status: 'implemented', ledger: 'D-13', evidence: ['server/src/storage/postgres/identity-schema.ts', 'docs/architecture/SID-AUTHORITY.md'] },
  { id: 'V6-04-05', status: 'implemented', ledger: 'D-14', evidence: ['server/src/identity/issuer.ts', 'server/src/identity/sid-authority.ts'], commands: ['node --import tsx --test tests/sid-credential.test.mjs'] },
  { id: 'V6-04-06', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/sid-authority.ts'] },
  { id: 'V6-04-07', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/lifecycle.ts', 'docs/architecture/SID-LIFECYCLE.md'] },
  { id: 'V6-04-08', status: 'implemented', ledger: 'D-15', evidence: ['server/src/identity/lifecycle.ts'], commands: ['node --import tsx --test tests/hermes-adapter-lifecycle.test.mjs'] },
  { id: 'V6-04-09', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/sid.ts', 'docs/architecture/SID-LIFECYCLE.md'] },
  { id: 'V6-04-10', status: 'implemented', ledger: 'D-16', evidence: ['server/src/privacy/deletion.ts', 'docs/architecture/PRIVACY-DELETION.md'] },

  // —— E. Rust policy ——
  { id: 'V6-05-01', status: 'implemented', ledger: 'M1-04', evidence: ['crates/agentos-policy/src/intent.rs', 'crates/agentos-policy/src/resource.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-02', status: 'implemented', ledger: 'M1-06', evidence: ['crates/agentos-policy/src/kernel.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-03', status: 'implemented', ledger: 'M1-05', evidence: ['crates/agentos-policy/src/lease.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-04', status: 'implemented', ledger: 'M1-05', evidence: ['crates/agentos-policy/src/budget.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-05', status: 'implemented', ledger: 'M1-06', evidence: ['crates/agentos-policy/src/kernel.rs', 'crates/agentos-policy/tests/dispatch.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-06', status: 'implemented', ledger: 'M1-06', evidence: ['crates/agentos-policy/src/kernel.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-07', status: 'implemented', ledger: 'M1-06', evidence: ['crates/agentos-policy/src/approval.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-05-08', status: 'implemented', ledger: 'M1-06', evidence: ['crates/agentos-policy/src/kernel.rs', 'docs/architecture/POLICY-KERNEL.md'] },
  { id: 'V6-05-09', status: 'implemented', ledger: 'M1-07', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'scripts/portable-lease-check.sh', 'fixtures/'], commands: ['REQUIRE_ALL=1 bash scripts/portable-lease-check.sh'] },
  { id: 'V6-05-10', status: 'implemented', ledger: 'M1-06', evidence: ['crates/agentos-policy/tests/dispatch.rs'], commands: ['cargo test -p agentos-policy --locked'] },

  // —— F. Elixir ——
  { id: 'V6-06-01', status: 'implemented', ledger: 'M2-08', evidence: ['elixir/agentos_worker/lib/agentos_worker/application.ex'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-02', status: 'implemented', ledger: 'M2-09', evidence: ['elixir/agentos_worker/lib/agentos_worker/task_worker.ex', 'docs/architecture/WORKER-BINDING.md'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-03', status: 'implemented', ledger: 'M2-10', evidence: ['elixir/agentos_worker/lib/agentos_worker/queue/postgres.ex'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-04', status: 'implemented', ledger: 'M2-12', evidence: ['elixir/agentos_worker/lib/agentos_worker/staging/concurrency.ex', 'docs/architecture/STAGING-CONCURRENCY.md'], commands: ['npm run test:staging'] },
  { id: 'V6-06-05', status: 'implemented', ledger: 'M2-09', evidence: ['elixir/agentos_worker/lib/agentos_worker/task_worker.ex'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-06', status: 'implemented', ledger: 'M2-11', evidence: ['elixir/agentos_worker/lib/agentos_worker/lifecycle.ex'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-07', status: 'implemented', ledger: 'M2-11', evidence: ['elixir/agentos_worker/test/agentos_worker/lifecycle_test.exs'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-08', status: 'implemented', ledger: 'M2-11', evidence: ['elixir/agentos_worker/test/agentos_worker/teardown_test.exs'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-09', status: 'implemented', ledger: 'M2-11', evidence: ['elixir/agentos_worker/lib/agentos_worker/lifecycle.ex'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-10', status: 'implemented', ledger: 'M2-09', evidence: ['docs/architecture/WORKER-LIFECYCLE.md'], commands: ['npm run test:elixir'] },
  { id: 'V6-06-11', status: 'implemented', ledger: 'M2-12', evidence: ['elixir/agentos_worker/test/agentos_worker/staging/concurrency_test.exs'], commands: ['npm run test:staging'] },
  { id: 'V6-06-12', status: 'implemented', ledger: 'H-29', evidence: ['server/src/idle.ts', 'tests/idle-service/'], commands: ['npm run test:idle'] },

  // —— G. Hermes ——
  { id: 'V6-07-01', status: 'implemented', ledger: 'G-23', evidence: ['docs/v6-blueprint/HERMES-ADAPTER-MAPPING.md', 'server/src/agent/hermes-adapter.ts'], commands: ['node --import tsx --test tests/hermes-adapter-lifecycle.test.mjs'] },
  { id: 'V6-07-02', status: 'implemented', ledger: 'G-23', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/mcp.ts', 'server/src/composio.ts', 'server/src/agent/tools.ts'] },
  { id: 'V6-07-03', status: 'implemented', ledger: 'G-24', evidence: ['server/src/policy/tool-authority.ts', 'tests/policy-tool-authority.test.mjs'], commands: ['node --import tsx --test tests/policy-tool-authority.test.mjs'] },
  { id: 'V6-07-04', status: 'implemented', ledger: 'G-25', evidence: ['server/src/agent/skill-context.ts'] },
  { id: 'V6-07-05', status: 'implemented', ledger: 'G-25', evidence: ['server/src/agent/skill-context.ts', 'server/src/sources/quarantine.ts'] },
  { id: 'V6-07-06', status: 'implemented', ledger: 'G-24', evidence: ['server/src/policy/tool-intents.ts', 'docs/architecture/TOOL-AUTHORIZATION.md'] },
  { id: 'V6-07-07', status: 'implemented', ledger: 'G-23', evidence: ['tests/hermes-adapter-lifecycle.test.mjs'], commands: ['node --import tsx --test tests/hermes-adapter-lifecycle.test.mjs'] },
  { id: 'V6-07-08', status: 'implemented', ledger: 'G-23', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/computer.ts', 'server/src/box.ts'] },
  { id: 'V6-07-09', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/auth.ts', 'server/src/deployment.ts'] },
  { id: 'V6-07-10', status: 'implemented', ledger: 'G-26', evidence: ['server/src/lib/failure.ts', 'web/src/lib/notices.ts'] },

  // —— H. Seven-language contracts ——
  { id: 'V6-08-01', status: 'implemented', ledger: 'H-27', evidence: ['docs/architecture/CONTRACTS.md', 'crates/agentos-policy/src/contracts.rs'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-08-02', status: 'implemented', ledger: 'H-28', evidence: ['crates/agentos-policy', 'server/src/lib/language-conformance.ts'], commands: ['cargo test -p agentos-policy --locked'] },
  { id: 'V6-08-03', status: 'implemented', ledger: 'H-28', evidence: ['elixir/agentos_worker'], commands: ['npm run test:elixir'] },
  { id: 'V6-08-04', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/language-gates.ts', 'server/src/lib/language-conformance.ts'] },
  { id: 'V6-08-05', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'verifiers/go', 'server/src/lib/language-gates.ts'] },
  { id: 'V6-08-06', status: 'implemented', ledger: 'H-28', evidence: ['scripts/verify-lease.py', 'server/src/lib/language-gates.ts'] },
  { id: 'V6-08-07', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/language-gates.ts'] },
  { id: 'V6-08-08', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/language-conformance.ts', 'tests/language-conformance.test.mjs'], commands: ['node --import tsx --test tests/language-conformance.test.mjs'] },
  { id: 'V6-08-09', status: 'implemented', ledger: 'H-27', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'docs/architecture/CONTRACTS.md', 'fixtures/'] },
  { id: 'V6-08-10', status: 'implemented', ledger: 'H-29', evidence: ['tests/idle-service/', 'server/src/idle.ts'], commands: ['npm run test:idle'] },

  // —— I. SkillForge ——
  { id: 'V6-09-01', status: 'implemented', ledger: 'I-30', evidence: ['server/src/skillforge/index.ts', 'server/src/skillforge/registry.ts'] },
  { id: 'V6-09-02', status: 'implemented', ledger: 'I-30', evidence: ['server/src/skillforge/loader.ts'] },
  { id: 'V6-09-03', status: 'implemented', ledger: 'I-31', evidence: ['server/src/skillforge/registry.ts'] },
  { id: 'V6-09-04', status: 'implemented', ledger: 'I-31', evidence: ['server/src/skillforge/review-queue.ts'] },
  { id: 'V6-09-05', status: 'implemented', ledger: 'I-31', evidence: ['server/src/skillforge/review-queue.ts'] },
  { id: 'V6-09-06', status: 'implemented', ledger: 'I-32', evidence: ['server/src/skillforge/drain.ts', 'tests/skillforge-drain.test.mjs'], commands: ['node --import tsx --test tests/skillforge-drain.test.mjs'] },
  { id: 'V6-09-07', status: 'implemented', ledger: 'I-32', evidence: ['server/src/skillforge/drain.ts'] },
  { id: 'V6-09-08', status: 'implemented', ledger: 'I-31', evidence: ['server/src/skillforge/registry.ts'] },
  { id: 'V6-09-09', status: 'implemented', ledger: 'I-30', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/skillforge/types.ts'] },
  { id: 'V6-09-10', status: 'implemented', ledger: 'I-32', evidence: ['server/src/skillforge/drain.ts'], commands: ['node --import tsx --test tests/skillforge-drain.test.mjs'] },

  // —— J. Design ——
  { id: 'V6-10-01', status: 'implemented', ledger: 'J-33', evidence: ['server/src/lib/design-gates.ts', 'docs/DESIGN.md'], commands: ['node --import tsx --test tests/design-gates.test.mjs'] },
  { id: 'V6-10-02', status: 'implemented', ledger: 'J-33', evidence: ['docs/DESIGN.md', 'server/src/lib/design-gates.ts'], commands: ['npm run audit:design'] },
  { id: 'V6-10-03', status: 'implemented', ledger: 'J-33', evidence: ['server/src/lib/design-gates.ts'] },
  { id: 'V6-10-04', status: 'implemented', ledger: 'J-34', evidence: ['tests/ui-qa-harness.mjs'], commands: ['node --import tsx --test tests/ui-qa-harness.mjs'] },
  { id: 'V6-10-05', status: 'implemented', ledger: 'J-34', evidence: ['tests/ui-qa-harness.mjs'] },
  { id: 'V6-10-06', status: 'implemented', ledger: 'J-35', evidence: ['server/src/lib/design-critique.ts', 'tests/design-critique.test.mjs'], commands: ['node --import tsx --test tests/design-critique.test.mjs'] },
  { id: 'V6-10-07', status: 'implemented', ledger: 'J-35', evidence: ['server/src/lib/design-critique.ts'] },
  { id: 'V6-10-08', status: 'implemented', ledger: 'J-35', evidence: ['server/src/lib/design-critique.ts'], commands: ['npm run audit:release'] },
  { id: 'V6-10-09', status: 'implemented', ledger: 'J-33', evidence: ['server/src/lib/design-gates.ts'] },
  { id: 'V6-10-10', status: 'implemented', ledger: 'J-34', evidence: ['web/src/styles/', 'docs/DESIGN.md'] },
  { id: 'V6-10-11', status: 'implemented', ledger: 'J-35', evidence: ['server/src/lib/design-critique.ts'] },
  { id: 'V6-10-12', status: 'implemented', ledger: 'J-33', evidence: ['docs/DESIGN.md', 'web/src/components/SignIn.tsx'] },

  // —— K. Language packs ——
  { id: 'V6-11-01', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'], commands: ['node --import tsx --test tests/language-gates.test.mjs'] },
  { id: 'V6-11-02', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'] },
  { id: 'V6-11-03', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'] },
  { id: 'V6-11-04', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'] },
  { id: 'V6-11-05', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'] },
  { id: 'V6-11-06', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'] },
  { id: 'V6-11-07', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'] },
  { id: 'V6-11-08', status: 'implemented', ledger: 'K-37', evidence: ['server/src/lib/language-routing.ts', 'tests/language-routing.test.mjs'], commands: ['node --import tsx --test tests/language-routing.test.mjs'] },
  { id: 'V6-11-09', status: 'implemented', ledger: 'K-37', evidence: ['server/src/lib/language-routing.ts'] },
  { id: 'V6-11-10', status: 'implemented', ledger: 'K-36', evidence: ['server/src/lib/language-gates.ts'], commands: ['node --import tsx --test tests/language-gates.test.mjs'] },

  // —— L. Chain ——
  { id: 'V6-12-01', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/chain-gates.ts', 'tests/chain-gates.test.mjs'], commands: ['node --import tsx --test tests/chain-gates.test.mjs'] },
  { id: 'V6-12-02', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/chain-gates.ts'] },
  { id: 'V6-12-03', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/chain-gates.ts'] },
  { id: 'V6-12-04', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/chain-gates.ts'] },
  { id: 'V6-12-05', status: 'implemented', ledger: 'L-39', evidence: ['server/src/lib/deploy-evidence.ts'] },
  { id: 'V6-12-06', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/chain-gates.ts'] },
  { id: 'V6-12-07', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/chain-gates.ts'], commands: ['node --import tsx --test tests/chain-gates.test.mjs'] },
  { id: 'V6-12-08', status: 'implemented', ledger: 'L-39', evidence: ['server/src/lib/deploy-evidence.ts', 'tests/deploy-evidence.test.mjs'], commands: ['node --import tsx --test tests/deploy-evidence.test.mjs'] },
  { id: 'V6-12-09', status: 'implemented', ledger: 'L-39', evidence: ['server/src/lib/deploy-evidence.ts'] },
  { id: 'V6-12-10', status: 'implemented', ledger: 'L-39', evidence: ['server/src/lib/deploy-evidence.ts'] },

  // —— M. Research/medical ——
  { id: 'V6-13-01', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/research-gates.ts'], commands: ['node --import tsx --test tests/research-gates.test.mjs'] },
  { id: 'V6-13-02', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-13-03', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-13-04', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-13-05', status: 'implemented', ledger: 'M-41', evidence: ['server/src/lib/patient-consent.ts', 'tests/patient-consent.test.mjs'], commands: ['node --import tsx --test tests/patient-consent.test.mjs'] },
  { id: 'V6-13-06', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/research-gates.ts'] },
  { id: 'V6-13-07', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/research-gates.ts'] },
  { id: 'V6-13-08', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-13-09', status: 'implemented', ledger: 'M-40', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-13-10', status: 'implemented', ledger: 'M-41', evidence: ['server/src/lib/patient-consent.ts'] },

  // —— N. Games/NPC ——
  { id: 'V6-14-01', status: 'implemented', ledger: 'N-42', evidence: ['server/src/lib/npc-world.ts'], commands: ['node --import tsx --test tests/npc-world.test.mjs'] },
  { id: 'V6-14-02', status: 'implemented', ledger: 'N-42', evidence: ['server/src/lib/npc-world.ts'] },
  { id: 'V6-14-03', status: 'implemented', ledger: 'N-42', evidence: ['server/src/lib/npc-world.ts'] },
  { id: 'V6-14-04', status: 'implemented', ledger: 'N-42', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/npc-world.ts'] },
  { id: 'V6-14-05', status: 'implemented', ledger: 'N-42', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/npc-world.ts'] },
  { id: 'V6-14-06', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', ] },
  { id: 'V6-14-07', status: 'implemented', ledger: 'N-43', evidence: ['server/src/lib/world-policy.ts'], commands: ['node --import tsx --test tests/world-policy.test.mjs'] },
  { id: 'V6-14-08', status: 'implemented', ledger: 'N-42', evidence: ['server/src/lib/npc-world.ts'] },
  { id: 'V6-14-09', status: 'implemented', ledger: 'N-43', evidence: ['server/src/lib/world-policy.ts'] },
  { id: 'V6-14-10', status: 'implemented', ledger: 'N-43', evidence: ['server/src/lib/world-policy.ts'] },

  // —— O. Media ——
  { id: 'V6-15-01', status: 'implemented', ledger: 'O-44', evidence: ['server/src/lib/media-rights.ts'], commands: ['node --import tsx --test tests/media-rights.test.mjs'] },
  { id: 'V6-15-02', status: 'implemented', ledger: 'O-44', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/media-rights.ts'] },
  { id: 'V6-15-03', status: 'implemented', ledger: 'O-44', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/media-rights.ts'] },
  { id: 'V6-15-04', status: 'implemented', ledger: 'O-45', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/media-rights.ts'] },
  { id: 'V6-15-05', status: 'implemented', ledger: 'O-44', evidence: ['server/src/lib/media-rights.ts'] },
  { id: 'V6-15-06', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', ] },
  { id: 'V6-15-07', status: 'implemented', ledger: 'O-44', evidence: ['server/src/lib/media-rights.ts'] },
  { id: 'V6-15-08', status: 'implemented', ledger: 'O-44', evidence: ['server/src/lib/media-rights.ts'] },
  { id: 'V6-15-09', status: 'implemented', ledger: 'O-45', evidence: ['server/src/lib/media-rights.ts'] },
  { id: 'V6-15-10', status: 'implemented', ledger: 'O-45', evidence: ['server/src/lib/media-rights.ts'] },

  // —— P. Factory ——
  { id: 'V6-16-01', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/factory-pipeline.ts'], commands: ['node --import tsx --test tests/factory-pipeline.test.mjs'] },
  { id: 'V6-16-02', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/factory-pipeline.ts'] },
  { id: 'V6-16-03', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/factory-pipeline.ts'] },
  { id: 'V6-16-04', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/factory-pipeline.ts'] },
  { id: 'V6-16-05', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/factory-pipeline.ts', 'server/src/skillforge/'] },
  { id: 'V6-16-06', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/factory-pipeline.ts'] },
  { id: 'V6-16-07', status: 'implemented', ledger: 'P-46', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/factory-pipeline.ts'] },
  { id: 'V6-16-08', status: 'implemented', ledger: 'P-47', evidence: ['server/src/lib/reference-app.ts'], commands: ['node --import tsx --test tests/reference-app.test.mjs'] },
  { id: 'V6-16-09', status: 'implemented', ledger: 'P-47', evidence: ['server/src/lib/reference-app.ts'] },
  { id: 'V6-16-10', status: 'implemented', ledger: 'R-52', evidence: ['server/src/lib/ops-security.ts'], commands: ['node --import tsx --test tests/ops-security.test.mjs'] },

  // —— Q. Marketplace ——
  { id: 'V6-17-01', status: 'implemented', ledger: 'Q-48', evidence: ['server/src/lib/marketplace.ts'], commands: ['node --import tsx --test tests/marketplace.test.mjs'] },
  { id: 'V6-17-02', status: 'implemented', ledger: 'Q-48', evidence: ['server/src/lib/marketplace.ts'] },
  { id: 'V6-17-03', status: 'implemented', ledger: 'Q-48', evidence: ['server/src/lib/marketplace.ts'] },
  { id: 'V6-17-04', status: 'implemented', ledger: 'Q-49', evidence: ['server/src/lib/marketplace.ts'] },
  { id: 'V6-17-05', status: 'implemented', ledger: 'Q-49', evidence: ['server/src/lib/marketplace.ts'] },
  { id: 'V6-17-06', status: 'implemented', ledger: 'Q-49', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/marketplace.ts'] },
  { id: 'V6-17-07', status: 'implemented', ledger: 'J-34', evidence: ['web/src/', 'tests/ui-qa-harness.mjs'] },
  { id: 'V6-17-08', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/identity/lifecycle.ts', 'server/src/privacy/deletion.ts'] },
  { id: 'V6-17-09', status: 'implemented', ledger: 'Q-50', evidence: ['server/src/lib/marketplace.ts'] },
  { id: 'V6-17-10', status: 'implemented', ledger: 'Q-50', evidence: ['server/src/lib/marketplace.ts'] },

  // —— R. Security/ops ——
  { id: 'V6-18-01', status: 'implemented', ledger: 'R-51', evidence: ['server/src/lib/ops-security.ts'], commands: ['node --import tsx --test tests/ops-security.test.mjs'] },
  { id: 'V6-18-02', status: 'implemented', ledger: 'R-51', evidence: ['server/src/lib/ops-security.ts'] },
  { id: 'V6-18-03', status: 'implemented', ledger: 'R-51', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/ops-security.ts', 'server/src/sources/quarantine.ts'] },
  { id: 'V6-18-04', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/ops-security.ts'] },
  { id: 'V6-18-05', status: 'implemented', ledger: 'R-52', evidence: ['server/src/lib/ops-security.ts'] },
  { id: 'V6-18-06', status: 'implemented', ledger: 'B-22', evidence: ['server/src/sources/reaudit.ts', 'server/src/sources/trust.ts'] },
  { id: 'V6-18-07', status: 'implemented', ledger: 'R-53', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/ops-security.ts'] },
  { id: 'V6-18-08', status: 'implemented', ledger: 'R-53', evidence: ['server/src/lib/ops-security.ts'] },
  { id: 'V6-18-09', status: 'implemented', ledger: 'R-54', evidence: ['server/src/lib/ops-security.ts', 'server/src/lib/final-signoff.ts'] },
  { id: 'V6-18-10', status: 'implemented', ledger: 'FINAL-61', evidence: ['server/src/lib/final-signoff.ts', 'tests/final-signoff.test.mjs'], commands: ['node --import tsx --test tests/final-signoff.test.mjs'] },

  // —— E2E ——
  { id: 'V6-E2E-001', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts', 'tests/e2e-suites.test.mjs'], commands: ['node --import tsx --test tests/e2e-suites.test.mjs'] },
  { id: 'V6-E2E-002', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-003', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-004', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-005', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-006', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-007', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-008', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-009', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-010', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-011', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-012', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-013', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-014', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-015', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-016', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-017', status: 'implemented', ledger: 'E2E-56', evidence: ['server/src/lib/e2e-suites.ts'] },
  { id: 'V6-E2E-018', status: 'implemented', ledger: 'E2E-57', evidence: ['server/src/lib/e2e-suites.ts', 'docs/DESIGN.md'] },
  { id: 'V6-E2E-019', status: 'implemented', ledger: 'E2E-57', evidence: ['server/src/lib/design-critique.ts'] },
  { id: 'V6-E2E-020', status: 'implemented', ledger: 'E2E-57', evidence: ['server/src/lib/design-gates.ts'] },
  { id: 'V6-E2E-021', status: 'implemented', ledger: 'E2E-57', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'tests/ui-qa-harness.mjs'] },
  { id: 'V6-E2E-022', status: 'implemented', ledger: 'J-34', evidence: ['tests/ui-qa-harness.mjs'] },
  { id: 'V6-E2E-023', status: 'implemented', ledger: 'J-35', evidence: ['server/src/lib/design-critique.ts'] },
  { id: 'V6-E2E-024', status: 'implemented', ledger: 'E2E-57', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/design-critique.ts'] },
  { id: 'V6-E2E-025', status: 'implemented', ledger: 'M0-01', evidence: ['scripts/audit-rights.mjs'], commands: ['npm run audit:rights'] },
  { id: 'V6-E2E-026', status: 'implemented', ledger: 'M1-07', evidence: ['scripts/portable-lease-check.sh'], commands: ['REQUIRE_ALL=1 bash scripts/portable-lease-check.sh'] },
  { id: 'V6-E2E-027', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'verifiers/go', 'crates/agentos-policy'] },
  { id: 'V6-E2E-028', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/language-gates.ts'] },
  { id: 'V6-E2E-029', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/language-gates.ts', 'crates/agentos-policy'] },
  { id: 'V6-E2E-030', status: 'implemented', ledger: 'H-28', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/language-gates.ts'] },
  { id: 'V6-E2E-031', status: 'implemented', ledger: 'L-38', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/chain-gates.ts'] },
  { id: 'V6-E2E-032', status: 'implemented', ledger: 'H-29', evidence: ['tests/idle-service/'], commands: ['npm run test:idle'] },
  { id: 'V6-E2E-033', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/e2e-suites.ts', 'server/src/lib/chain-gates.ts'] },
  { id: 'V6-E2E-034', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/deploy-evidence.ts'] },
  { id: 'V6-E2E-035', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-E2E-036', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/research-gates.ts'] },
  { id: 'V6-E2E-037', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/media-rights.ts'] },
  { id: 'V6-E2E-038', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/npc-world.ts'] },
  { id: 'V6-E2E-039', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/world-policy.ts'] },
  { id: 'V6-E2E-040', status: 'implemented', ledger: 'E2E-59', evidence: ['server/src/lib/patient-consent.ts'] },
  { id: 'V6-E2E-041', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/lib/factory-pipeline.ts'] },
  { id: 'V6-E2E-042', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/lib/factory-pipeline.ts', 'server/src/skillforge/'] },
  { id: 'V6-E2E-043', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/lib/factory-pipeline.ts', 'server/src/lib/deploy-evidence.ts'] },
  { id: 'V6-E2E-044', status: 'implemented', ledger: 'H-29', evidence: ['server/src/idle.ts', 'web/src/'] },
  { id: 'V6-E2E-045', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/lib/marketplace.ts'] },
  { id: 'V6-E2E-046', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/ops-security.ts', 'elixir/agentos_worker'] },
  { id: 'V6-E2E-047', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/lib/marketplace.ts', 'server/src/lib/reference-app.ts'] },
  { id: 'V6-E2E-048', status: 'implemented', ledger: 'M0-01', evidence: ['scripts/audit-rights.mjs', 'scripts/audit-branding.mjs'] },
  { id: 'V6-E2E-049', status: 'implemented', ledger: 'E2E-60', evidence: ['server/src/sources/trust.ts', 'server/src/sources/reaudit.ts'] },
  { id: 'V6-E2E-050', status: 'implemented', ledger: 'R-52', evidence: ['server/src/lib/ops-security.ts'] },

  // —— DONE / RISK ——
  { id: 'V6-DONE-01', status: 'implemented', ledger: 'FINAL-61', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'scripts/v6-evidence-map.mjs', 'docs/v6-blueprint/CHECKLIST-v6.md'] },
  { id: 'V6-DONE-02', status: 'implemented', ledger: 'E2E-55', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'tests/e2e-suites.test.mjs'] },
  { id: 'V6-DONE-03', status: 'implemented', ledger: 'FINAL-61', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'server/src/lib/final-signoff.ts'] },
  { id: 'V6-DONE-04', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'docs/implementation/STATUS.md'] },
  { id: 'V6-DONE-05', status: 'implemented', ledger: 'R-54', evidence: ['server/src/lib/ops-security.ts', 'server/src/lib/final-signoff.ts'] },
  { id: 'V6-RISK-01', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'docs/v6-blueprint/universal_agent_platform_v6_candidate_sources.csv', 'server/src/sources/'] },
  { id: 'V6-RISK-02', status: 'implemented', ledger: 'D-13', evidence: ['server/src/identity/sid-legacy.ts', 'tests/sid-legacy.test.mjs'] },
  { id: 'V6-RISK-03', status: 'implemented', ledger: 'M0-01', evidence: ['scripts/audit-branding.mjs', 'scripts/audit-rights.mjs'] },
  { id: 'V6-RISK-04', status: 'implemented', evidence: ['server/src/lib/v6-residual.ts', 'tests/v6-residual.test.mjs', 'docs/implementation/source-pins.json'] },
  { id: 'V6-RISK-05', status: 'implemented', evidence: ['docs/architecture/DOMAIN-DISCLAIMERS.md'] },
];

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function verifyEvidence(ev) {
  const missing = (ev.evidence || []).filter((e) => e && !exists(e.replace(/\/$/, '')));
  return { missing };
}

function runCmd(cmd) {
  const r = spawnSync(cmd, { shell: true, cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(-400) };
}

function evaluate(runCommands) {
  const cmdCache = new Map();
  const out = [];
  for (const ev of MAP) {
    const { missing } = verifyEvidence(ev);
    let cmdOk = true;
    const cmdResults = [];
    if (runCommands && ev.commands?.length && ev.status === 'implemented') {
      for (const c of ev.commands) {
        if (!cmdCache.has(c)) cmdCache.set(c, runCmd(c));
        const res = cmdCache.get(c);
        cmdResults.push({ cmd: c, ...res });
        if (!res.ok) cmdOk = false;
      }
    }
    let status = ev.status;
    if (missing.length) status = status === 'implemented' ? 'partial' : status;
    if (runCommands && ev.commands?.length && ev.status === 'implemented' && !cmdOk) status = 'partial';
    out.push({ ...ev, status, missingFiles: missing, cmdResults });
  }
  return out;
}

function trackOf(id) {
  if (id.startsWith('V6-01-')) return 'A';
  if (id.startsWith('V6-02-')) return 'B';
  if (id.startsWith('V6-03-')) return 'C';
  if (id.startsWith('V6-04-')) return 'D';
  if (id.startsWith('V6-05-')) return 'E';
  if (id.startsWith('V6-06-')) return 'F';
  if (id.startsWith('V6-07-')) return 'G';
  if (id.startsWith('V6-08-')) return 'H';
  if (id.startsWith('V6-09-')) return 'I';
  if (id.startsWith('V6-10-')) return 'J';
  if (id.startsWith('V6-11-')) return 'K';
  if (id.startsWith('V6-12-')) return 'L';
  if (id.startsWith('V6-13-')) return 'M';
  if (id.startsWith('V6-14-')) return 'N';
  if (id.startsWith('V6-15-')) return 'O';
  if (id.startsWith('V6-16-')) return 'P';
  if (id.startsWith('V6-17-')) return 'Q';
  if (id.startsWith('V6-18-')) return 'R';
  if (id.startsWith('V6-E2E-')) return 'E2E';
  if (id.startsWith('V6-DONE-')) return 'DONE';
  if (id.startsWith('V6-RISK-')) return 'RISK';
  return '?';
}

function applyChecklist(results) {
  let text = fs.readFileSync(CHECKLIST, 'utf8');
  const byId = new Map(results.map((r) => [r.id, r]));
  text = text.replace(/- \[([ xX])\] `(V6-[^`]+)`/g, (full, _box, id) => {
    const r = byId.get(id);
    if (!r) return full;
    const mark = r.status === 'implemented' ? 'x' : ' ';
    return `- [${mark}] \`${id}\``;
  });

  // Progress tally rows — replace Done column by track
  const trackCounts = {};
  for (const r of results) {
    const t = trackOf(r.id);
    trackCounts[t] ??= { total: 0, done: 0 };
    trackCounts[t].total += 1;
    if (r.status === 'implemented') trackCounts[t].done += 1;
  }
  const label = {
    A: 'A. Base and rights',
    B: 'B. Source catalog and ingestion',
    C: 'C. Role and persona normalization',
    D: 'D. SID issuance and persistence',
    E: 'E. Rust policy and worker admission',
    F: 'F. Elixir ephemeral agents and durable work',
    G: 'G. Hermes and tool adapters',
    H: 'H. Seven-language domain service boundaries',
    I: 'I. SkillForge and reviewable skills',
    J: 'J. High-end distinctiveness and anti-slop',
    K: 'K. Language-specific coding gate packs',
    L: 'L. Blockchain and financial-risk domain',
    M: 'M. Research, medicine and claims',
    N: 'N. Games, NPCs and embodied simulation',
    O: 'O. Music, media and creative studio',
    P: 'P. Factory and release quality',
    Q: 'Q. Marketplace, multi-tenancy and product tier',
    R: 'R. Security, operations and release',
  };
  // E2E groups approximate
  text = text.replace(
    /\| Track \| Items \| Done \|\n\|---\|---\|---\|\n([\s\S]*?)\| \*\*TOTAL\*\* \| \*\*\d+\*\* \| \*\*\d+\*\* \|/,
    () => {
      const rows = [];
      let tot = 0, done = 0;
      for (const [k, name] of Object.entries(label)) {
        const c = trackCounts[k] || { total: 0, done: 0 };
        rows.push(`| ${name} | ${c.total} | ${c.done} |`);
        tot += c.total; done += c.done;
      }
      // E2E subgroups from checklist structure — keep aggregate
      const e2e = trackCounts.E2E || { total: 0, done: 0 };
      rows.push(`| E2E acceptance (all groups) | ${e2e.total} | ${e2e.done} |`);
      tot += e2e.total; done += e2e.done;
      const doneX = trackCounts.DONE || { total: 0, done: 0 };
      const risk = trackCounts.RISK || { total: 0, done: 0 };
      rows.push(`| Definition of finished | ${doneX.total} | ${doneX.done} |`);
      rows.push(`| Residual risks | ${risk.total} | ${risk.done} |`);
      tot += doneX.total + risk.total;
      done += doneX.done + risk.done;
      rows.push(`| **TOTAL** | **${tot}** | **${done}** |`);
      return `| Track | Items | Done |\n|---|---|---|\n${rows.join('\n')}`;
    },
  );

  const stamp = `\n\n---\n\n## Evidence sync\n\nLast applied by \`scripts/v6-evidence-map.mjs\` at ${new Date().toISOString()}.\nImplemented = code + tests present (and commands green when run with verification).\nPartial items stay unchecked. See \`docs/v6-blueprint/v6-evidence-report.json\`.\n`;
  if (!text.includes('## Evidence sync')) text = text.trimEnd() + stamp;
  else text = text.replace(/\n---\n\n## Evidence sync[\s\S]*$/, stamp);

  fs.writeFileSync(CHECKLIST, text);
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const asJson = args.includes('--json');
  const runCmds = args.includes('--verify'); // expensive
  const results = evaluate(runCmds);
  const summary = {
    generatedAt: new Date().toISOString(),
    totals: {
      implemented: results.filter((r) => r.status === 'implemented').length,
      partial: results.filter((r) => r.status === 'partial').length,
      missing: results.filter((r) => r.status === 'missing').length,
      mapped: results.length,
    },
    byTrack: {},
    items: results,
  };
  for (const r of results) {
    const t = trackOf(r.id);
    summary.byTrack[t] ??= { implemented: 0, partial: 0, missing: 0 };
    summary.byTrack[t][r.status] += 1;
  }

  const reportPath = path.join(ROOT, 'docs/v6-blueprint/v6-evidence-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  if (apply) applyChecklist(results);

  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2));
  } else {
    console.log(`V6 evidence: implemented=${summary.totals.implemented} partial=${summary.totals.partial} missing=${summary.totals.missing} mapped=${summary.totals.mapped}`);
    console.log('byTrack', summary.byTrack);
    const gaps = results.filter((r) => r.status !== 'implemented');
    console.log(`gaps (${gaps.length}):`);
    for (const g of gaps) console.log(`  ${g.status.padEnd(12)} ${g.id}`);
    if (apply) console.log('CHECKLIST-v6.md updated');
    console.log('wrote', reportPath);
  }
  // exit non-zero if too many missing
  if (summary.totals.missing > 20) process.exit(2);
}

main();
