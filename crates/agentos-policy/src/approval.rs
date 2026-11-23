//! Human approvals (V6-05-07).
//!
//! An approval is a signed human decision about *one exact intent*: it names the
//! intent id, the argument digest the human saw, the effect class, and the risk the
//! human accepted. It expires, and it is consumed by the authorisation that uses it.
//!
//! Why the argument digest and not just the intent id: the blueprint's
//! `ApprovalRecord` requires "displayed exact arguments and consequences". Binding the
//! digest means an approval for `$12.50` cannot authorise `$9,999.00` even if the
//! intent id is reused.

use core::fmt;

use crate::canonical::{signing_bytes, CanonicalWriter};
use crate::effect::{EffectClass, RiskTier};
use crate::ids::{Digest, RefId, Sid, TenantId};
use crate::signature::{verify, IssuerId, SigError, Signature, SigningKeyPair, VerifyingKey};

/// Signature domain for approvals.
pub const APPROVAL_DOMAIN: &str = "uap-approval/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalError {
    EmptyOrInvertedWindow,
}

impl fmt::Display for ApprovalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("approval window must be non-empty and forward")
    }
}

impl std::error::Error for ApprovalError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub approval_id: RefId,
    pub tenant: TenantId,
    pub sid: Sid,
    pub intent_id: RefId,
    /// Digest of the exact arguments shown to the human.
    pub params_digest: Digest,
    pub effect: EffectClass,
    /// The highest risk tier this human accepted for this action.
    pub max_risk: RiskTier,
    pub approved_at_ms: u64,
    pub expires_at_ms: u64,
}

impl ApprovalRecord {
    pub fn validate(&self) -> Result<(), ApprovalError> {
        if self.expires_at_ms <= self.approved_at_ms {
            return Err(ApprovalError::EmptyOrInvertedWindow);
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> String {
        let mut w = CanonicalWriter::new();
        w.field_str("v", APPROVAL_DOMAIN);
        w.field_str("approval_id", self.approval_id.as_str());
        w.field_str("tenant", self.tenant.as_str());
        w.field_str("sid", self.sid.as_str());
        w.field_str("intent_id", self.intent_id.as_str());
        w.field_str("params", &self.params_digest.to_hex());
        w.field_str("effect", self.effect.as_str());
        w.field_str("max_risk", self.max_risk.as_str());
        w.field_int("approved_at_ms", self.approved_at_ms);
        w.field_int("expires_at_ms", self.expires_at_ms);
        w.finish()
    }

    pub fn signing_payload(&self) -> Vec<u8> {
        signing_bytes(APPROVAL_DOMAIN, &self.canonical_json())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedApproval {
    pub record: ApprovalRecord,
    pub approver: IssuerId,
    pub signature: Signature,
}

impl SignedApproval {
    pub fn sign(record: ApprovalRecord, approver: IssuerId, key: &SigningKeyPair) -> Self {
        assert_eq!(
            record.validate(),
            Ok(()),
            "refusing to sign an invalid approval"
        );
        let signature = key.sign(&record.signing_payload());
        Self {
            record,
            approver,
            signature,
        }
    }

    pub fn verify(&self, vk: &VerifyingKey) -> Result<(), SigError> {
        verify(vk, &self.record.signing_payload(), &self.signature)
    }
}
