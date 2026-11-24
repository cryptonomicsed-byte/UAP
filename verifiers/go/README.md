# Go lease / stream verifier

Cross-language portable lease and stream-backpressure checks are implemented in
`server/src/lib/v6-residual.ts` (`GoStreamAdapter`, `verifyPortableLease`) and
covered by `tests/v6-residual.test.mjs`. Native Go binaries may be added under
this tree; the TypeScript adapter is the CI-gated contract.
