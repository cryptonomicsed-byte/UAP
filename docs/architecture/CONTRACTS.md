# Shared wire contracts and canonical fixtures (track H, V6-08-01)

Status: **implemented, in-tree, checked**. Owner: Rust (`crates/agentos-policy`).
This document is the index and the adoption protocol for the wire documents the
platform signs, emits and enforces. The machine-readable source of truth is
`contracts/v1/manifest.json`; `contracts::Registry` checks it against the code, and a
document that is not in the manifest is not a contract.

Run it:

```bash
cargo test -p agentos-policy --test contracts          # 13 tests, incl. 8 negative cases
cargo run -p agentos-policy --bin contract-check -- .  # JSON report + exit 1 on drift
npm run audit:contracts                                # same, wired into `npm run check`
```

## 1. The contract set

| Contract | Domain | Kind | Producer | Fixtures |
|---|---|---|---|---|
| `intent` | `uap-intent/1` | unsigned request | `src/intent.rs` | `contracts/v1/fixtures/intent` (3) |
| `grant` | `uap-grant/1` | signed | `src/grant.rs` | `contracts/v1/fixtures/grant` (3) |
| `lease` | `uap-lease/1` | signed | `src/lease.rs` | `crates/agentos-policy/fixtures` (5, frozen by M1-07) |
| `approval` | `uap-approval/1` | signed | `src/approval.rs` | `contracts/v1/fixtures/approval` (2) |
| `decision` | `uap-authorize/1` | kernel output | `src/authorize.rs` | output-only, covered by `tests/authorize_bundle.rs` |
| `mint` | `uap-mint/1` | admin request | `src/authorize.rs` | output-only, covered by `tests/authorize_bundle.rs` |

`ActionPermit` is **not** a contract of its own: it has no wire version, it only ever
appears inside a decision, and it is documented as `$defs.permit` in
`decision.schema.json`. Inventing `uap-permit/1` would be a version tag no producer
emits.

### Why JSON and not Protobuf

The requirement is "Protobuf/JSON contracts"; JSON is the deliberate choice:

1. **Signatures are over canonical bytes.** A signature must cover exactly one byte
   string. Protobuf field order is not stable across implementations, so either way a
   canonical form is required — and a canonical JSON form is one this repository
   already ships, tests in four languages, and can diff in a fixture file.
2. **No codegen in eight languages.** Protobuf adds `protoc` plus a runtime to every
   language and couples the build to a generated artefact that cannot be reviewed as
   bytes. The policy kernel forbids generated authority code from being the only copy
   of the schema.
3. **A fixture is a byte string.** Any language can compare `canonical.txt` without a
   library, which is what makes "did our serializers diverge?" answerable in a shell.

A future Protobuf encoding would be a *new* domain (`uap-lease/2`), never a
reinterpretation of `/1`.

## 2. Versioning rules

* **Field order is the protocol.** Adding, removing or reordering a field is a new
  domain version (`/2`) and a new fixture set. `required` in each schema is ordered and
  is checked against the canonical bytes the producer emits.
* **No floats, ever.** Numbers are non-negative decimal integers. `cloud_micros` exists
  so money is an integer.
* **Unknown fields are refused**, not ignored (`deny_unknown_fields` on every raw
  struct, `additionalProperties: false` in every schema). Lenient parsing is how two
  languages end up with two documents that share a name.
* **Signatures cover `domain || 0x0A || canonical_json`**, which is why a lease
  signature cannot verify as a grant.
* **`revision` in the manifest** only tracks registry bookkeeping (adding a verifier,
  fixing a description). It never changes a wire format.

## 3. Fixture format

Every case directory is self-describing:

| File | Required | Meaning |
|---|---|---|
| `fields.json` | always | the document fields, strict schema |
| `canonical.txt` | contracts added after H-27 | the exact canonical bytes, no trailing newline |
| `canonical.sha256` | always | SHA-256 of the canonical bytes rebuilt from the fields |
| `sig.hex` | signed kinds | Ed25519 over `domain\n` + canonical bytes |
| `issuer.pub.hex` | signed kinds | the public key a verifier must trust |
| `expect.txt` | always | `valid` or `invalid` |
| `reason.txt` | invalid cases | token the refusal must mention (`signature`, `unknown field`, …) |

The lease set predates the registry and commits the digest without `canonical.txt`;
the checker rebuilds its bytes from `fields.json` rather than rewriting a byte-frozen
M1-07 artefact. New fixtures commit both, so a second language can compare bytes and
not only hashes.

Negative cases are the point of the set. Today they cover: a re-canonicalised field
edit with a replayed signature (`grant-0002-tampered`), a corrupted signature
(`lease-0004-badsig`), lenient JSON (`grant-0003-unknown-field`,
`approval-0002-unknown-field`), a tampered field against a committed digest
(`lease-0002-tampered`), a foreign tenant (`lease-0003-foreign`) and an external
effect with no idempotency key (`intent-0002-missing-idempotency`).

## 4. Verifier status per language

The manifest is the source of truth; this table is a rendered view.

| Language | Implemented | Planned (with target path) |
|---|---|---|
| Rust | all six contracts (reference implementation, fixture verifier) | — |
| Go | `lease` (`verifiers/go/verify_lease.go`) | — |
| Python | `lease` (`scripts/verify-lease.py`) | `intent`, `decision` (tool SDK) |
| Elixir | `lease` (`verifiers/verify_lease.exs`) | — |
| Clojure | — | `intent`, `grant` (symbolic reasoning, cannot mint) |
| TypeScript | — | `decision` (server reads it today without schema validation) |
| Julia | — | `decision` (analytics, never re-authorizes) |
| Move | — | `decision` receipt (no contract exists yet) |

`implemented` requires a file on disk that the tests or
`scripts/portable-lease-check.sh` actually run. `planned` requires `expected_path`, and
the checker **fails if that path appears**, so coverage cannot be under-reported after
H-28 lands a verifier.

An honest gap, stated rather than hidden: the JSON Schemas are checked structurally in
Rust (version const, `$id`, `required` order, hex/id patterns) but are **not** yet
executed by a JSON Schema validator. That arrives with the per-language conformance
suites (H-28), where the TypeScript verifier can run `ajv` against the same files.

## 5. What `contract-check` enforces

Codes are stable for CI grep:

| Code | Fires when |
|---|---|
| `manifest` | bad version, duplicate id/domain, unknown kind or status, missing `expected_path` |
| `missing-file` | a declared producer or schema does not exist |
| `schema-invalid` | unparsable schema, wrong `$id`, wrong `x-uap-domain`, empty `required`, unpinned hex/version field |
| `schema-fields-differ` | `required` order ≠ top-level key order of the producer's canonical bytes |
| `domain-unregistered` | a `*_DOMAIN` const in `src/` names a wire format no contract declares |
| `domain-unused` | a contract declares a domain no kernel const emits |
| `fixture-missing` | fixture root absent, no cases, or a case is missing a required file |
| `fixture-broken` | a fixture marked valid is refused by the producer (with the reason) |
| `fixture-expectation` | a fixture marked invalid now verifies, or fails for a different reason than `reason.txt` |
| `consumer-missing` | an `implemented` verifier path does not exist |
| `consumer-status-stale` | a `planned` verifier already exists at `expected_path` |
| `covered-by-missing` | an output contract names no existing covering test |

## 6. Adding a contract

1. Write the failing test first: extend `crates/agentos-policy/tests/contracts.rs`
   (a new valid fixture, at least one negative, and the new id in the declared order).
2. Implement the type and its `canonical_json` in the kernel; add a `*_DOMAIN` const.
3. Add `contracts/v1/schemas/<id>.schema.json` (`$id`, `x-uap-domain`, ordered
   `required`, `additionalProperties: false`).
4. Extend `mint-contract-fixtures` so the fixture set is generated, not hand-written;
   run it and commit the output. `git status` after a second run must be empty.
5. Add the manifest entry with at least the Rust consumer; add a `planned` entry with
   `expected_path` for any other language that must eventually verify it.
6. `cargo test --workspace --locked` and `npm run audit:contracts` must both pass.
