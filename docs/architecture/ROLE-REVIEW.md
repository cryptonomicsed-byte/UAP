# Role review: dedupe, conflict and the policy-override guard

Status: `server/src/roles/role-review.ts`, exposed at `POST /api/roles/review`.
Covers checklist `V6-03-05` (dedupe, conflict resolution, compatibility across overlapping
persona collections) and `V6-03-09` (a persona may not override system policy, source trust
or privacy limits). Inputs are built with C-17's `buildRoleTemplate`, so a reviewed role has
already passed the schema and digest checks.

## Two failures, one review step

Both failure modes end the same way — a role nobody approved gets installed.

### 1. Overlap (dedupe)

Collections from different publishers overlap. `reviewRoleTemplates(templates)` returns:

| Bucket | Meaning |
|---|---|
| `accepted` | Installable roles, one per id at its highest version |
| `rejected` | Failed the policy guard; carries the findings |
| `duplicates` | An exact copy at the same id+version+digest; `duplicate_of` names the kept one |
| `conflicts` | `digest_mismatch` (same id+version, different bodies) or `content_overlap` (same instructions under two ids) |
| `superseded` | An older version replaced by a newer one, recorded as `{id, version, superseded_by}` |

Rules that matter:

* **An ambiguous role is not installable.** Two different bodies at the same id+version put
  the id in `conflicts` and out of `accepted`; the platform never picks a winner by input
  order.
* **A newer version wins, but says so.** The old version is listed in `superseded` with the
  version that replaced it, so an upgrade diff has a referent.
* **Identical bodies under two ids** are still installable but flagged `content_overlap` —
  that is role explosion, not dedupe, and a human decides whether the two ids are one role.
* **Deterministic.** Shuffling the input produces a byte-identical result; every bucket is
  sorted by role reference.

### 2. Policy override (the guard)

A persona is untrusted text. `scanInstructions(text)` runs the documented rules over
normalised text (NFKC, zero-width stripped *and* zero-width-as-space, lowercased, whitespace
collapsed) and returns `{safe, findings[]}` with `rule`, `label`, `match` and `index`;
`assertPolicySafe(text)` throws a `PolicyOverrideError` carrying the same fields.

| Rule id | Refuses text that… |
|---|---|
| `ignore_instructions` | tells the agent to ignore/disregard previous instructions |
| `prompt_extraction` | asks for the system prompt or hidden instructions |
| `safety_disable` | disables safety checks, guardrails, filters or policy checks |
| `identity_hijack` | reassigns the assistant ("you are now…", "no restrictions") |
| `secret_read` | reads, prints or exfiltrates keys, tokens, secrets or `.env` |
| `privilege_escalation` | claims admin/root/owner authority it was not granted |
| `covert_action` | hides actions from the user/owner/operator |

Deliberately narrow: ordinary engineering prose — "never silently restart a worker", "do not
claim an interface works", "only test within an authorized scope" — is not flagged. That
property is asserted in the tests, because a guard that fires on real instructions gets
switched off and then guards nothing.

## What the guard is not

It is a deterministic review gate, not a classifier: novel phrasing will pass. It is an extra
refusal, not the defence — role instructions are treated as data everywhere else in the
platform, capability grants come from the policy kernel, and a template's `requestedTools` is
a request the kernel may refuse.

## API

`POST /api/roles/review` — session required. Body `{ "roles": [RoleTemplateInput, …] }`
(1–200 entries). Returns `uap-role-review/1`. Invalid input, a failed schema build or an
invalid collection returns 400 with `{error, message}`; nothing is persisted.

## Deliberately not here

* Markdown repository ingestion and source-SHA pinning (C-17 / `V6-03-02`).
* Fuzzy semantic duplicate detection across paraphrased personas — exact-body overlap is
  detected; paraphrase review remains human.
* Role preview UI, owner-authored roles and upgrade diffs (`V6-03-07`).
* Persistence of a reviewed catalog (the roster is `V6-03-06`).
