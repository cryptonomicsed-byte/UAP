# sid/0.1 conformance fixtures — provenance

Vendored unchanged from `cryptonomicsed-byte/sid` @ `756d8d8` (MIT, see the
upstream `LICENSE`; copyright 2026 card-protocol contributors).

| file | upstream path |
|---|---|
| `vectors.json` | `conformance/vectors.json` |
| `minimal-sid.json` | `conformance/fixtures/minimal-sid.json` |
| `full-sid.json` | `conformance/fixtures/full-sid.json` |

These are the historical `sid/0.1` bytes. They must never be edited: the
certificates carry their own canonical `hash`/`acting_hash`, and V6-04-01
requires the in-repo verifier to reproduce the upstream verdicts for every
vector. A vector that starts failing means the neutral `sid/0.2` work has
changed legacy verification, not that the fixture is wrong.

`server/src/identity/sid-legacy.ts` is the ported verifier (canonical JSON,
`hash`, `acting_hash`, chain/lifecycle/time/secret rules). It is used to verify
a legacy certificate before its lineage is recorded, and by
`tests/sid-legacy.test.mjs` against these vectors.
