# Privacy deletion: propagation and evidence retention

Scope: V6-04-10. Code: `server/src/privacy/deletion.ts` (plan/execute/receipts),
`server/src/privacy/holders.ts` (where data actually lives), `server/src/search/memory-index.ts`
(the derived memory index), migration 7 (`privacy-deletion-and-memory-index`).

A deletion request is a **plan over holders**, not a single `DELETE`. Each holder owns one
place an agent's data lives; a request names every target that exists at plan time, and the
request is only `completed` when each target is proven gone (`done`/`absent`) or retained
under a named evidence rule (`retained`).

## Holders

| Holder | Data | Action | Proof |
|---|---|---|---|
| `memory` | `MEMORY.md` + `USER.md` entries in the agent's Hermes home | purge each entry | the memory id is absent from `listMemories` after `deleteMemory` |
| `conversation` | `rows`, `llm_items`, `pending_turns` for **every** generation | purge | all three counts are 0; generation is advanced |
| `cache` | cached live state (`live` map: running/activity/awaiting) | purge | the cache entry is deleted |
| `index` | derived `memory_index` / `memory_index_sources` | purge + tombstone | no terms remain for the source and a `privacy_tombstones` row exists |
| `evidence` | `approvals` (privileged-tool decisions) | retain under rule | the row still exists; the rule is on the target and in the receipt |

Adding a new place that stores agent data means adding a holder. There is no
"delete everything" fallback that could silently miss one; an unregistered holder makes the
request `partial`.

## States

`pending → running → completed | partial`. `completed` means every target reached
`done`, `absent` or `retained`. `partial` means at least one holder threw or a target never
reached a terminal state; `last_error` carries the holder, reference and message, and
`POST /api/privacy/deletions/:id/retry` resumes only the unfinished targets. A failed purge
leaves the bytes in place and says so — completion is never assumed.

Running a `completed` request is a no-op that returns the same receipt and `completedAt`.
A repeated `requestKey` returns the same request; reusing it for a different agent or basis
is a 409, never a silent redirect.

## Evidence-retention exceptions

Audit evidence is retained only under a rule in `EVIDENCE_RETENTION_RULES`, currently:

- `audit:approval_history` — approval rows record a tool and outcome, never message text or
  arguments. Deleting them would destroy the audit trail while erasing nothing personal.

An evidence holder that does not name a known rule fails planning (`retention_rule_missing` /
`retention_rule_unknown`); a retained target must carry its rule and appears as `retained` in
the receipt. Content holders may not retain targets (`invalid_plan`).

## Tombstones and the derived index

The memory index is a projection and can be rebuilt at any time, so erasure must survive a
rebuild: every purged index source records `(bot_id, content_hash)` in `privacy_tombstones`
and `syncMemoryIndex` refuses to index tombstoned bytes. This is deliberately per-agent and
hash-based: the same text offered again for the same agent stays out of the index. Memory
search (`GET /api/bots/:id/memories?q=`) is served from this index and single-entry deletion
(`DELETE /api/memories/:id`) removes the entry from it immediately.

## Receipt chain

On completion the engine writes a receipt:
`HMAC-SHA256(session secret, canonical{ request, targets[holder,ref,contentHash,action,state,rule] , prev })`,
where `prev` is the previous completed request's receipt for the same agent. `GET
/api/privacy/deletions/:id` returns `receiptVerified`, recomputed from the stored rows; editing
any target (state, rule, hash), the basis or the completion time breaks it. Receipts and
tombstones deliberately have **no foreign keys** to `bots` or `users`: deleting the agent (or
the account) must not destroy proof that erasure happened.

## Deliberately not claimed

- Object storage/artifacts, Postgres SID-tenant rows, external provider data, backups and
  logs are not reached from the SQLite application store. Account-wide erasure across those
  systems is E2E-156 / V3-Z-07, not this item.
- Legal-hold expiry is a rule label here; there is no scheduler that later releases a
  retained approval row.

## Verification

```bash
node --import tsx --test tests/memory-index.test.mjs tests/privacy-deletion.test.mjs tests/privacy-api.test.mjs
npm run typecheck
```
