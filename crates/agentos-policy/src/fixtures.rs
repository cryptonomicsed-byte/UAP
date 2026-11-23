//! Golden-fixture support for V6-05-09 (portable lease verification).
//!
//! A fixture directory contains:
//!
//! | File | Meaning |
//! |---|---|
//! | `fields.json` | the lease document fields, strict schema (unknown keys are an error) |
//! | `canonical.sha256` | SHA-256 of the canonical bytes **rebuilt from those fields** |
//! | `sig.hex` | the Ed25519 signature over `uap-lease/1\n<canonical>` |
//! | `issuer.pub.hex` | the issuer's public key |
//! | `expect.txt` | `valid` or `invalid` — what a correct verifier must conclude |
//!
//! Committing `canonical.sha256` instead of the canonical text avoids the trailing
//! newline ambiguity that makes JSON fixtures rot. A verifier must *rebuild* the bytes
//! from the fields, hash them, compare, then verify — so a serializer that differs in
//! key order, spacing or integer formatting fails at the hash, and a verifier that only
//! checks the hash fails at the signature.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::ids::{Digest, RefId, Sid, TenantId};
use crate::lease::{RevocationRef, TaskLease, LEASE_DOMAIN};
use crate::signature::{verify, verifying_key_from_hex, Signature, VerifyingKey};

#[derive(Debug)]
pub enum FixtureError {
    Io(String),
    Json(String),
    Field(String),
}

impl core::fmt::Display for FixtureError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            FixtureError::Io(m) => write!(f, "io: {m}"),
            FixtureError::Json(m) => write!(f, "json: {m}"),
            FixtureError::Field(m) => write!(f, "field: {m}"),
        }
    }
}

impl std::error::Error for FixtureError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLease {
    v: String,
    lease_id: String,
    task_id: String,
    tenant: String,
    sid: String,
    role_digest: String,
    grant_id: String,
    epoch: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    revocation: RawRevocation,
    nonce: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRevocation {
    list: String,
    version: u64,
}

/// Build the typed lease from the strict JSON schema. Rejects unknown keys, wrong
/// types, non-canonical digests and any id outside the identifier grammar.
pub fn parse_fields(json: &str) -> Result<TaskLease, FixtureError> {
    let raw: RawLease =
        serde_json::from_str(json).map_err(|e| FixtureError::Json(e.to_string()))?;
    if raw.v != LEASE_DOMAIN {
        return Err(FixtureError::Field(format!("v is {:?}", raw.v)));
    }
    Ok(TaskLease {
        lease_id: RefId::parse(&raw.lease_id).map_err(|e| FixtureError::Field(e.to_string()))?,
        task_id: RefId::parse(&raw.task_id).map_err(|e| FixtureError::Field(e.to_string()))?,
        tenant: TenantId::parse(&raw.tenant).map_err(|e| FixtureError::Field(e.to_string()))?,
        sid: Sid::parse(&raw.sid).map_err(|e| FixtureError::Field(e.to_string()))?,
        role_digest: Digest::parse_hex(&raw.role_digest)
            .map_err(|e| FixtureError::Field(e.to_string()))?,
        grant_id: RefId::parse(&raw.grant_id).map_err(|e| FixtureError::Field(e.to_string()))?,
        epoch: raw.epoch,
        issued_at_ms: raw.issued_at_ms,
        expires_at_ms: raw.expires_at_ms,
        revocation: RevocationRef {
            list: RefId::parse(&raw.revocation.list)
                .map_err(|e| FixtureError::Field(e.to_string()))?,
            version: raw.revocation.version,
        },
        nonce: Digest::parse_hex(&raw.nonce).map_err(|e| FixtureError::Field(e.to_string()))?,
    })
}

/// What a fixture says a correct verifier must conclude.
pub fn expected(dir: &Path) -> Result<bool, FixtureError> {
    let s =
        fs::read_to_string(dir.join("expect.txt")).map_err(|e| FixtureError::Io(e.to_string()))?;
    match s.trim() {
        "valid" => Ok(true),
        "invalid" => Ok(false),
        other => Err(FixtureError::Field(format!("expect.txt is {other:?}"))),
    }
}

/// The result of verifying one fixture directory.
#[derive(Debug)]
pub struct Outcome {
    pub verified: bool,
    pub reason: String,
    /// SHA-256 of the canonical bytes rebuilt from the fields, when they parsed.
    pub canonical_sha256: Option<String>,
}

/// Verify one fixture directory. Never panics: every failure becomes a reason string.
pub fn verify_dir(dir: &Path) -> Outcome {
    let fields = match fs::read_to_string(dir.join("fields.json")) {
        Ok(s) => s,
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("fields.json: {e}"),
                canonical_sha256: None,
            }
        }
    };
    let lease = match parse_fields(&fields) {
        Ok(l) => l,
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("schema: {e}"),
                canonical_sha256: None,
            }
        }
    };
    let canonical = lease.canonical_json();
    let canonical_sha = Digest::of(canonical.as_bytes()).to_hex();

    let expected_sha = match fs::read_to_string(dir.join("canonical.sha256")) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("canonical.sha256: {e}"),
                canonical_sha256: Some(canonical_sha),
            }
        }
    };
    if canonical_sha != expected_sha {
        return Outcome {
            verified: false,
            reason: format!(
                "canonical bytes differ (built {canonical_sha}, expected {expected_sha})"
            ),
            canonical_sha256: Some(canonical_sha),
        };
    }

    let sig_hex = match fs::read_to_string(dir.join("sig.hex")) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("sig.hex: {e}"),
                canonical_sha256: Some(canonical_sha),
            }
        }
    };
    let sig = match Signature::parse_hex(&sig_hex) {
        Ok(s) => s,
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("sig.hex: {e}"),
                canonical_sha256: Some(canonical_sha),
            }
        }
    };
    let key_hex = match fs::read_to_string(dir.join("issuer.pub.hex")) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("issuer.pub.hex: {e}"),
                canonical_sha256: Some(canonical_sha),
            }
        }
    };
    let key: VerifyingKey = match verifying_key_from_hex(&key_hex) {
        Ok(k) => k,
        Err(e) => {
            return Outcome {
                verified: false,
                reason: format!("issuer.pub.hex: {e}"),
                canonical_sha256: Some(canonical_sha),
            }
        }
    };
    if let Err(e) = verify(&key, &lease.signing_payload(), &sig) {
        return Outcome {
            verified: false,
            reason: format!("signature: {e}"),
            canonical_sha256: Some(canonical_sha),
        };
    }
    Outcome {
        verified: true,
        reason: "ok".to_string(),
        canonical_sha256: Some(canonical_sha),
    }
}

/// Full check: the verifier's conclusion must equal `expect.txt`.
pub fn check_dir(dir: &Path) -> Result<Outcome, FixtureError> {
    let want = expected(dir)?;
    let outcome = verify_dir(dir);
    if outcome.verified != want {
        return Err(FixtureError::Field(format!(
            "expected {} but verifier concluded {} ({})",
            if want { "valid" } else { "invalid" },
            if outcome.verified { "valid" } else { "invalid" },
            outcome.reason
        )));
    }
    Ok(outcome)
}
