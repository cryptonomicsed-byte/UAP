//! `ActionIntent`: what a model proposes.
//!
//! An intent is a *request*, never an authority. It carries no signature of its own —
//! the kernel decides, and the decision (not the intent) is what gets audited. The
//! intent is tamper-evident via [`ActionIntent::digest`]: every field is inside the
//! canonical bytes, so an executor that re-checks the digest knows the arguments it is
//! about to run are the arguments the kernel approved.

use core::fmt;

use crate::budget::Spend;
use crate::canonical::CanonicalWriter;
use crate::effect::{EffectClass, RiskTier};
use crate::ids::{Digest, RefId, Sid, TenantId, ToolName};
use crate::resource::ResourceScope;

/// Wire domain for intent digests. Also the `v` field of the canonical document.
pub const INTENT_DOMAIN: &str = "uap-intent/1";

/// A model's suggested verdict. Advisory only: the kernel records it and ignores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisoryVerdict {
    Allow,
    Deny,
    Uncertain,
}

impl AdvisoryVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            AdvisoryVerdict::Allow => "allow",
            AdvisoryVerdict::Deny => "deny",
            AdvisoryVerdict::Uncertain => "uncertain",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "allow" => AdvisoryVerdict::Allow,
            "deny" => AdvisoryVerdict::Deny,
            "uncertain" => AdvisoryVerdict::Uncertain,
            _ => return None,
        })
    }
}

/// V6-05-08: a model-based policy suggestion. Never authoritative, always audited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advisory {
    pub model: String,
    pub verdict: AdvisoryVerdict,
    /// Confidence in basis points (0..=10_000). An out-of-range value is a bug.
    pub confidence_bp: u16,
}

/// Why an intent is malformed. Malformed is a refusal, not a retry hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentError {
    /// `expires_at_ms` must be strictly greater than `issued_at_ms`.
    EmptyOrInvertedWindow,
    /// `EffectClass::is_external()` requires an idempotency key (V6-05-06).
    ExternalEffectNeedsIdempotencyKey,
    /// Advisory confidence is basis points, so `0..=10_000`.
    AdvisoryConfidenceOutOfRange,
    /// Advisory model name must be 1..=128 printable ASCII characters.
    AdvisoryModelInvalid,
}

impl fmt::Display for IntentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IntentError::EmptyOrInvertedWindow => {
                write!(f, "intent window must satisfy issued_at_ms < expires_at_ms")
            }
            IntentError::ExternalEffectNeedsIdempotencyKey => {
                write!(f, "external effect requires an idempotency key (V6-05-06)")
            }
            IntentError::AdvisoryConfidenceOutOfRange => {
                write!(f, "advisory confidence must be 0..=10000 basis points")
            }
            IntentError::AdvisoryModelInvalid => {
                write!(
                    f,
                    "advisory model must be 1..=128 printable ASCII characters"
                )
            }
        }
    }
}

impl std::error::Error for IntentError {}

/// One proposed action, fully specified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionIntent {
    pub intent_id: RefId,
    pub tenant: TenantId,
    pub sid: Sid,
    pub task_id: RefId,
    /// Digest of the role+skill pack the SID is running under.
    pub role_digest: Digest,
    pub tool: ToolName,
    /// Digest of the tool's registered JSON schema/descriptor. Pinned in the grant;
    /// a mismatch at dispatch means the tool changed after it was authorised.
    pub tool_schema_digest: Digest,
    pub effect: EffectClass,
    pub risk: RiskTier,
    pub target: ResourceScope,
    /// Digest of the exact arguments. Approvals bind to this, so an approval cannot be
    /// replayed against different arguments.
    pub params_digest: Digest,
    pub idempotency_key: Option<RefId>,
    pub spend: Spend,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub advisory: Option<Advisory>,
}

impl ActionIntent {
    pub fn validate(&self) -> Result<(), IntentError> {
        if self.expires_at_ms <= self.issued_at_ms {
            return Err(IntentError::EmptyOrInvertedWindow);
        }
        if self.effect.is_external() && self.idempotency_key.is_none() {
            return Err(IntentError::ExternalEffectNeedsIdempotencyKey);
        }
        if let Some(a) = &self.advisory {
            if a.confidence_bp > 10_000 {
                return Err(IntentError::AdvisoryConfidenceOutOfRange);
            }
            if a.model.is_empty()
                || a.model.len() > 128
                || !a.model.bytes().all(|b| (0x20..=0x7e).contains(&b))
            {
                return Err(IntentError::AdvisoryModelInvalid);
            }
        }
        Ok(())
    }

    /// Canonical JSON, field order fixed by the protocol (see `POLICY-KERNEL.md`).
    pub fn canonical_json(&self) -> String {
        let mut w = CanonicalWriter::new();
        w.field_str("v", INTENT_DOMAIN);
        w.field_str("intent_id", self.intent_id.as_str());
        w.field_str("tenant", self.tenant.as_str());
        w.field_str("sid", self.sid.as_str());
        w.field_str("task_id", self.task_id.as_str());
        w.field_str("role_digest", &self.role_digest.to_hex());
        w.field_str("tool", self.tool.as_str());
        w.field_str("tool_schema", &self.tool_schema_digest.to_hex());
        w.field_str("effect", self.effect.as_str());
        w.field_str("risk", self.risk.as_str());
        w.field_str("target", &self.target.to_string());
        w.field_str("params", &self.params_digest.to_hex());
        w.field_opt_str(
            "idempotency",
            self.idempotency_key.as_ref().map(RefId::as_str),
        );
        self.spend.write_into(&mut w);
        w.field_int("issued_at_ms", self.issued_at_ms);
        w.field_int("expires_at_ms", self.expires_at_ms);
        match &self.advisory {
            None => {
                w.field_null("advisory");
            }
            Some(a) => {
                w.begin_object("advisory");
                w.field_str("model", &a.model);
                w.field_str("verdict", a.verdict.as_str());
                w.field_int("confidence_bp", u64::from(a.confidence_bp));
                w.end_object();
            }
        }
        w.finish()
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        self.canonical_json().into_bytes()
    }

    /// SHA-256 over the canonical bytes. Stable across processes and languages.
    pub fn digest(&self) -> Digest {
        Digest::of(&self.canonical_bytes())
    }
}
