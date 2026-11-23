# RoleTemplate: schema, digest and the Markdown persona parser

Scope: V6-03-01 (schema) and V6-03-02 (Markdown parser). Code:
`server/src/roles/role-template.ts`, `server/src/roles/persona-parser.ts`.
Tests: `tests/role-template.test.mjs`, `tests/persona-parser.test.mjs`.

A role template is a **versioned configuration object**: prose instructions plus
review metadata. It is not an identity, not a process, and not a grant. A SID
cites a template by `(id, version, digest)`; the template never cites a SID.

## Schema

| Field | Rule |
|---|---|
| `id` | Derived from the publishing source and the role slug (`rt_<publisher>_<slug>`), so an upgrade keeps the role's handle and a fork gets another. Max 200 chars, `[a-z0-9_.-]`. |
| `version` | Positive integer. `(id, version)` is immutable once published. |
| `sourceSha` | 40- or 64-character lower-case hex git commit of the source repository. |
| `sourcePath` | Relative `.md` path inside that repository. Absolute paths, `..` and backslashes are refused. |
| `title` | 1–200 chars, trimmed. |
| `riskClass` | `low` \| `medium` \| `high` \| `critical`. Drives review depth, not authority. |
| `rights` | `license` (SPDX-style or `NOASSERTION`), `sourceUrl` (http/https), `attribution`; derived `status` is `declared` unless the licence is `NOASSERTION`, which is recorded as `unverified`. |
| `instructions` | Canonical persona text, non-empty, ≤ 1 MiB. |
| `requestedTools` | Normalised tool names (`[a-z0-9][a-z0-9_.:-]*`), sorted and deduplicated. A request the policy kernel may refuse. |
| `evaluationSuite` | Optional suite id; the suite itself lives with the evaluator. |
| `digest` | sha256 over canonical JSON of every field above. |

`digest` is computed, never accepted: `buildRoleTemplate` ignores a caller's
`digest` and drops unknown properties, so `grants` cannot ride along on an
input object. `verifyRoleTemplate` recomputes the digest from the stored object
and throws `digest_mismatch` on any drift — a template read from any store is
only trusted after that check.

Canonical JSON sorts object keys and keeps array order, so key order cannot
change the digest while `requestedTools` order is normalised before hashing.

## Version rules

`assertVersionImmutable(previous, next)`:

- different `id` → `id_mismatch`;
- `next.version < previous.version` → `version_regression`;
- same version, different digest → `version_immutable`;
- same version, same digest, or a strictly newer version → accepted.

This is the check a registry write must call before publishing; it does not
itself persist anything (C-18/C-19 own the registry and roster).

## Markdown parser

`parsePersonaFile({ path, content })` returns:

| Field | Meaning |
|---|---|
| `title` | Frontmatter `title`/`name`, else the first H1. No title → `title_missing`. |
| `description` | Frontmatter `description`, or `null`. |
| `body` | Markdown after the frontmatter, byte-exact. |
| `canonicalMarkdown` | The source bytes, kept for provenance (V6-03-03 compares canonical vs derived). |
| `requestedTools` | `tools` / `allowed-tools` / `allowedTools` declarations, split on commas, quoted forms unwrapped, `Bash(git:*)` reduced to `bash`, sorted and deduplicated. |
| `unparsedToolDeclarations` | Declarations that are not tool names (free text). Kept, not dropped. |
| `ignoredAuthorityFields` | Any of `permissions`, `grants`, `capabilities`, `authorization`, `allow` found in frontmatter. Recorded so the attempt is visible; never applied. |

The parsed document has no `grants`, `permissions`, `capabilities`,
`grantedTools` or `authorization` property at all — authority is not merely
defaulted off, the shape cannot carry it.

`parsePersonaRepository(files)` orders documents by path and digests
`path\0content\0` in that order, so the same bytes always produce the same
source digest regardless of list order. Duplicate paths, absolute paths,
traversal, non-`.md` paths, NUL bytes, invalid YAML and files over 1 MiB are
refused with named codes.

`composeInstructions(documents)` joins bodies in path order; the resulting text
is what a template's `instructions` field carries.

## What this does not do

- No persistence: `uap.role_template_versions` stores
  `(organization_id, role_template_id, version, source_digest)`; a registry
  writer that calls `assertVersionImmutable` before insert is C-18's scope.
- No dedupe/conflict resolution across persona collections, no policy-override
  guard and no Hermes translation — those are C-19 (V6-03-05/09/10).
- No grants. A role template and a capability grant are separate objects with
  separate owners; nothing in this module mints, widens or implies one.
