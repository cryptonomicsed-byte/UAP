# AGENT-DECISIONS.md — UAP

Log of decisions made by agents working this repo. Read top-down; newest first.

## Progress log (newest first; evidence only — no checklist box is ticked by the implementer)

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
