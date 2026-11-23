//! `TaskLease`: this worker, at this epoch, may act on this task — until it expires.
//!
//! Three properties make a lease safe to hand to an isolated executor:
//!
//! 1. **Signed** by the issuer over canonical bytes (with its own domain tag).
//! 2. **Short-lived**: [`MAX_LEASE_MS`] is a hard ceiling, checked at validation, so a
//!    stolen lease cannot become a long-lived credential.
//! 3. **Epoch-bound**: the kernel records the highest epoch it has seen per task; any
//!    lease at a lower epoch is a dead worker and is refused (V6-05-10). The
//!    revocation reference is inside the signed bytes, so "this lease was issued before
//!    list version 12" cannot be edited out.

use core::fmt;

use crate::canonical::{signing_bytes, CanonicalWriter};
use crate::ids::{Digest, RefId, Sid, TenantId};
use crate::signature::{verify, IssuerId, SigError, Signature, SigningKeyPair, VerifyingKey};

/// Signature domain for leases.
pub const LEASE_DOMAIN: &str = "uap-lease/1";

/// Hard ceiling on how long any lease may live.
pub const MAX_LEASE_MS: u64 = 24 * 60 * 60 * 1000;

/// Which revocation list this lease was issued against, and at what version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationRef {
    pub list: RefId,
    pub version: u64,
}

/// Why a lease is not internally valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseError {
    EmptyOrInvertedWindow,
    /// Epoch 0 is reserved for "no lease issued yet".
    ZeroEpoch,
    /// The window exceeds [`MAX_LEASE_MS`].
    TooLongLived,
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            LeaseError::EmptyOrInvertedWindow => "lease window must be non-empty and forward",
            LeaseError::ZeroEpoch => "lease epoch must be >= 1",
            LeaseError::TooLongLived => "lease lifetime exceeds MAX_LEASE_MS (24h)",
        })
    }
}

impl std::error::Error for LeaseError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLease {
    pub lease_id: RefId,
    pub task_id: RefId,
    pub tenant: TenantId,
    pub sid: Sid,
    pub role_digest: Digest,
    pub grant_id: RefId,
    pub epoch: u64,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub revocation: RevocationRef,
    /// Random per-lease nonce: two leases with identical fields are still distinct.
    pub nonce: Digest,
}

impl TaskLease {
    pub fn validate(&self) -> Result<(), LeaseError> {
        if self.expires_at_ms <= self.issued_at_ms {
            return Err(LeaseError::EmptyOrInvertedWindow);
        }
        if self.epoch == 0 {
            return Err(LeaseError::ZeroEpoch);
        }
        if self.expires_at_ms - self.issued_at_ms > MAX_LEASE_MS {
            return Err(LeaseError::TooLongLived);
        }
        Ok(())
    }

    /// Half-open window: valid at `issued_at_ms`, invalid at `expires_at_ms`.
    pub fn is_valid_at(&self, now_ms: u64) -> bool {
        self.issued_at_ms <= now_ms && now_ms < self.expires_at_ms
    }

    pub fn canonical_json(&self) -> String {
        let mut w = CanonicalWriter::new();
        w.field_str("v", LEASE_DOMAIN);
        w.field_str("lease_id", self.lease_id.as_str());
        w.field_str("task_id", self.task_id.as_str());
        w.field_str("tenant", self.tenant.as_str());
        w.field_str("sid", self.sid.as_str());
        w.field_str("role_digest", &self.role_digest.to_hex());
        w.field_str("grant_id", self.grant_id.as_str());
        w.field_int("epoch", self.epoch);
        w.field_int("issued_at_ms", self.issued_at_ms);
        w.field_int("expires_at_ms", self.expires_at_ms);
        w.begin_object("revocation");
        w.field_str("list", self.revocation.list.as_str());
        w.field_int("version", self.revocation.version);
        w.end_object();
        w.field_str("nonce", &self.nonce.to_hex());
        w.finish()
    }

    pub fn signing_payload(&self) -> Vec<u8> {
        signing_bytes(LEASE_DOMAIN, &self.canonical_json())
    }
}

/// A lease plus issuer and signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedLease {
    pub lease: TaskLease,
    pub issuer: IssuerId,
    pub signature: Signature,
}

impl SignedLease {
    /// Sign a lease. Panics on an invalid lease (see [`SignedGrant::sign`]).
    pub fn sign(lease: TaskLease, issuer: IssuerId, key: &SigningKeyPair) -> Self {
        assert_eq!(
            lease.validate(),
            Ok(()),
            "refusing to sign an invalid lease: {:?}",
            lease.validate()
        );
        let signature = key.sign(&lease.signing_payload());
        Self {
            lease,
            issuer,
            signature,
        }
    }

    pub fn verify(&self, vk: &VerifyingKey) -> Result<(), SigError> {
        verify(vk, &self.lease.signing_payload(), &self.signature)
    }
}
