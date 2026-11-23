//! # agentos-policy
//!
//! The authoritative permission kernel for the Universal Agent Platform.
//!
//! Architectural rule (see `docs/architecture/ARCHITECTURE-FREEZE.md`): **Rust owns
//! permission.** No role, persona, skill pack, model, UI surface or Hermes adapter may
//! widen what this crate allows. Everything else *asks*.
//!
//! The kernel is pure and deterministic: it takes an explicit `now_ms`, never reads a
//! clock, never performs I/O, and never consults a model. That is what makes a decision
//! replayable from an audit record — and what makes a "model suggestion" unable to
//! influence the outcome.
//!
//! Modules land in build order (V6-05-01..09): [`ids`] now; intent, resource, grant,
//! lease, budget, approval and the dispatch kernel follow as each contract is tested.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod ids;

/// Wire/protocol version of the policy contract set.
///
/// Bumping this is a breaking change to every language verifier (see
/// `docs/architecture/POLICY-KERNEL.md` § Canonical encoding).
pub const API_VERSION: &str = "uap-policy/0.1";
