# Tool authorization — model-proposed intents and the policy kernel (track G)

Status: **implemented, in-tree, tested**. Owner: `server/src/policy/` asks; `crates/agentos-policy` decides.
Contract reference: [`POLICY-KERNEL.md`](./POLICY-KERNEL.md). Blueprint: V6-07-03.

## 1. The problem this closes

Hermes (the engine) proposes tool calls. Before this bridge, the app's own tools were
executed unconditionally (`policyFor` returns `allow` for every tool in its registry),
and Composio tools were gated by a per-user `policies` row that the *app* consulted —
so the only thing standing between a model's proposal and a side effect was the app's
own opinion, assembled in the same process that would run the tool.

Now every `tools/call` over MCP passes through the kernel first. The kernel is a
separate process, re-verifies signatures over canonical bytes, and has no field in its
input that a model can write.

## 2. The flow

```
Hermes ──tools/call──▶ server/src/mcp.ts ──▶ server/src/policy/tool-authority.ts
                                                     │  build intent from the registry
                                                     │  + the exact arguments
                                                     ▼
                                        target/debug/auth… (stdin bundle)
                                                     │  grant ⇒ lease ⇒ approval ⇒ intent
                                                     ▼
                                     agentos-policy::authorize_bundle
                                                     │
                              allow (one-use permit) │ deny (stable reason code)
                                                     ▼
                                     mcp.ts runs the tool — or refuses
```

The bundle (`uap-authorize/1`) carries the signed grant, the signed lease, the intent
and — when the effect class requires one — a signed human approval. Every `fields`
object is parsed with `deny_unknown_fields`; anything the contract does not define is
`invalid-request`, because a kernel that silently ignores part of a grant cannot explain
its own verdict later.

## 3. What is authority, and what is not

| Thing | Authority? |
|---|---|
| The model's proposal, its arguments, any `effect`/`risk` field it embeds | **No.** Effect and risk come from the tool's row in `server/src/policy/tool-intents.ts`; unknown tools default to `write`/`medium`. |
| The owner's `policies` rows (`mode = 'blocked'`) | **Yes** — a blocked tool is removed from the grant, so the kernel refuses with `tool-not-granted`. |
| The tool's declared schema | **Yes, pinned.** The grant pins the schema digest at issuance; a schema that changes afterwards refuses with `tool-schema-changed` until the grant is re-issued. |
| The exact arguments | **Yes, pinned.** `params_digest` is inside the signed intent; an approval binds to it, so an approval for `$12.50` cannot authorise `$9,999.00`. |
| The local issuer/approver keys | The installation's own Ed25519 keys, generated on first use under `POLICY_AUTHORITY_DIR` (mode 0600). A hosted deployment puts them in the operator's KMS; this app is a single-owner install, so it is also the local issuer. |

Grant scope, fixed in code: effects `read`, `compute`, `write`, `external_message`;
`max_risk` `medium`; resources `tool:*`; 12 h lifetime; budget 4 concurrent / 600 s wall
/ 2 000 000 µUSD. The five classes that always need a human (`money`, `publish`,
`production_change`, `security_testing`, `clinical_data`) are **never** conferred, so an
intent in one of them refuses with `effect-not-granted` (or `approval-required` when a
grant did confer it and no signed approval is present). There is no code path in this
bridge that mints an approval: a human decision flow that signs one is future work
(item L-38), and until it exists those effects are refused rather than silently allowed.

Leases are turn-scoped: 60 s, epoch 1, task id random per call, signed by the same
issuer. In the hosted topology the Elixir worker's task lease replaces this turn lease.

## 4. Failure codes the app records

Every decision — allow or refuse — is one row in `policy_decisions` (SQLite migration
10) with the kernel's stable code, the tool, the effect, the risk and both digests.

| Code | Meaning |
|---|---|
| `allow` | a one-use permit was minted for this exact intent |
| `tool-not-granted` | the tool is unknown to the catalogue, or blocked by the owner |
| `tool-schema-changed` | the call's schema is not the one the grant pinned |
| `role-mismatch` / `actor-mismatch` | the intent does not belong to this SID/role |
| `intent-expired` | the proposal arrived after its window |
| `effect-not-granted` | the effect class is outside the grant (all five human-approval classes) |
| `approval-required` / `approval-invalid` | the effect needs a human, and none (or one bound to other arguments) was presented |
| `policy-unavailable` | the kernel binary is missing, timed out or answered non-JSON — **refused**, never allowed |

The model is told `Policy refused this action (<code>). It did not run.` — no retry
hint, no partial-success wording.

## 5. Verified vs not claimed

Verified by `tests/policy-tool-authority.test.mjs` (8 cases, real binaries, child
processes with their own SQLite file and key directory) and
`crates/agentos-policy/tests/authorize_bundle.rs` (22 cases):

* a granted read is allowed and leaves an audit row whose `params_digest` is
  `sha256(canonical args)`;
* a model's `allow` advisory cannot grant an ungranted tool, and its `deny` advisory
  cannot block a granted one (the kernel records the advisory and ignores it);
* blocked tool → `tool-not-granted` at the kernel, and the tool's side effect is absent;
* changed schema → `tool-schema-changed`;
* missing/timed-out kernel → `policy-unavailable`;
* tampered lease signature, foreign issuer, role mismatch, expired intent, missing
  approval, approval bound to other arguments, money effect not granted — each refused
  with its own code;
* strict wire format: unknown field anywhere, wrong `v`, missing section, non-JSON input
  → `invalid-request`, no panic, exit 20;
* mint → authorize round trip; a lease signed with another seed does not verify.

Not claimed:

* **No stateful enforcement in this bridge.** Each authorization runs in a fresh kernel
  process, so replay keys, concurrency reservations and spend accumulation are per-call.
  Those ceilings are the worker's job (track F, `elixir/agentos_worker`), and the ledger
  row here is an audit trail, not a quota.
* **No signed human approval path yet.** Money/publish/production/security/clinical
  effects refuse; the approval flow that signs an `ApprovalRecord` after a human click is
  item L-38.
* **No live Composio catalogue test.** Composio tools are catalogued lazily (10 min
  cache) and classified by slug; without a configured Composio key the catalogue is the
  app's own tools only, and a Composio call refuses `tool-not-granted`.
