# Source registry and ingestion (V6-02-01..06, V6-02-10, V6-02-11)

The catalog answers one question honestly: *what did we observe about this
source, at which commit, and what is still unknown?* It is not an install
manifest, a role template or a licence approval.

## Pipeline

`server/src/sources/` is a pure pipeline; `tests/source-registry.test.mjs`
exercises it without a network or database.

| Stage | Module | Output |
|---|---|---|
| Import | `candidates.ts` | 103 user-supplied rows, original `repository`/`url`/`group`/`proposed_use`/`status` retained |
| Normalize | `normalize.ts` | lower-case `owner/repo` identity, authored casing kept, redirects replace identity but keep `originalUrl` |
| Access | `access.ts` | `ok`, `not-found` (404 = **not found or private** without credentials), `auth-required`, `forbidden`, `rate-limited`, `moved`, `network-error` |
| Pin | `pin.ts` | full commit SHA; branch-only publication refused (`mutable_branch_reference`) |
| Manifest | `manifest.ts` | deterministic SHA-256 over sorted `path\0sha256\0size` rows; unsafe/duplicate paths refused |
| Licence | `license.ts` | SPDX detected from declared text (or API label), notices listed, obligations derived, `approval: 'not-reviewed'` always |
| Classify | `classify.ts` | `meta-list`, `agent-skill`, `dataset`, `standalone-software`, `documentation`, `unknown` with evidence |
| Tenant filter | `tenant-policy.ts` | closed-by-default filtering by domains, supported tools and max risk; every hidden entry carries a reason |
| Orchestrate | `ingest.ts` | records + duplicates + unavailable list + counts; no fabricated role fields |

Unavailable reasons are explicit: `not_found_or_private`, `auth_required`,
`forbidden`, `rate_limited`, `relocated`, `network_error`, `unpinned_default_branch`,
`invalid_pin`, `invalid_tree_listing`, `source_tree_unreadable`, `no_files`,
`unsupported_provider`.

## Trust

`trust_status` defaults to `USER_SUPPLIED_UNVERIFIED`. The migration's CHECK
constraint refuses any other status without `reviewer_signature`, so promotion
cannot be written as an accident. `requireAuditableSource()` throws
`source_not_auditable` (or `reviewer_signature_required`) for anything not
promoted; `catalogView()` returns `installable: false` with the first blocker.
This is V6-02-11: an unaudited source is reported unavailable, never synthesized
into a role.

## Database

Migration 12 (`source_registry_and_ingest_runs`):

* `uap.source_repositories` — public source metadata only. No instruction, grant
  or role columns exist.
* `uap.source_ingest_runs` — append-only run ledger (UPDATE/DELETE/TRUNCATE
  refused by trigger, including for its owner).
* Both tables are RLS-enabled and FORCE RLS. The application login gets
  `SELECT` only; ingestion runs through the operator connection
  (`UAP_POSTGRES_ADMIN_URL`). Re-ingestion refreshes observations and never
  overwrites `trust_status` or `reviewer_signature`.

## Commands

```bash
# Observe every candidate and print the report (no writes)
npm run sources:ingest

# Optional subset
npm run sources:ingest -- --limit 5

# Write catalog + run ledger through the operator connection
UAP_POSTGRES_ADMIN_URL=... npm run sources:ingest -- --apply

# Verification
node --import tsx --test tests/source-registry.test.mjs
npm run test:postgres -- source-registry.test.mjs
```

`GITHUB_TOKEN` raises rate limits and allows private repositories the operator
already has access to. Without it, 404 is recorded as *not found or private*.

## Not claimed here

* Quarantine, prompt-injection/secret scanning and script analysis — **B-21**.
* Trust promotion, independent reviewer workflow, scheduled re-audit/revocation
  alerts — **B-22**.
* No install UI, no role derivation and no source execution. A source is data
  until a later item binds it to a reviewed role template.
