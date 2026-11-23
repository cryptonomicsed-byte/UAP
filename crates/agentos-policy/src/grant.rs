//! `Grant`: a signed statement of what one SID may do, for how long, with what budget.
//!
//! A grant is the only source of authority in the system. It is issued by a named
//! issuer, signed over canonical bytes, scoped to a tenant + SID, and expires. The
//! kernel refuses to honour a grant whose signature does not verify under a trusted
//! issuer key — there is no "unsigned but trusted" path.

use core::fmt;

use crate::budget::Budget;
use crate::canonical::{signing_bytes, CanonicalWriter};
use crate::effect::{EffectClass, RiskTier};
use crate::ids::{Digest, RefId, Sid, TenantId, ToolName};
use crate::resource::{ResourcePattern, ResourceScope};
use crate::signature::{verify, IssuerId, SigError, Signature, SigningKeyPair, VerifyingKey};

/// Signature domain for grants. Prevents cross-type signature reuse.
pub const GRANT_DOMAIN: &str = "uap-grant/1";

/// Result of comparing an intent's tool against the grant's pinned tool list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolVerdict {
    Allowed,
    /// The grant does not name this tool at all.
    NotGranted,
    /// The tool is granted, but its schema changed since the grant was issued.
    SchemaMismatch,
}

/// A tool the grant permits, pinned to the schema digest it was reviewed at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolGrant {
    pub tool: ToolName,
    pub schema_digest: Digest,
}

/// Why a grant is not internally valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantError {
    EmptyOrInvertedWindow,
    NoEffects,
    NoResources,
    NoTools,
    DuplicateEffect,
    ZeroConcurrency,
    ZeroWallTime,
}

impl fmt::Display for GrantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            GrantError::EmptyOrInvertedWindow => "grant window must be non-empty and forward",
            GrantError::NoEffects => "grant must confer at least one effect class",
            GrantError::NoResources => "grant must name at least one resource pattern",
            GrantError::NoTools => "grant must name at least one tool",
            GrantError::DuplicateEffect => "grant lists an effect class twice",
            GrantError::ZeroConcurrency => "grant concurrency ceiling must be >= 1",
            GrantError::ZeroWallTime => "grant wall-time ceiling must be >= 1 ms",
        })
    }
}

impl std::error::Error for GrantError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub grant_id: RefId,
    pub tenant: TenantId,
    pub sid: Sid,
    /// Effect classes conferred. Order is preserved into the signed document.
    pub effects: Vec<EffectClass>,
    pub resources: Vec<ResourcePattern>,
    pub tools: Vec<ToolGrant>,
    pub max_risk: RiskTier,
    pub budget: Budget,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub epoch: u64,
}

impl Grant {
    pub fn validate(&self) -> Result<(), GrantError> {
        if self.expires_at_ms <= self.issued_at_ms {
            return Err(GrantError::EmptyOrInvertedWindow);
        }
        if self.effects.is_empty() {
            return Err(GrantError::NoEffects);
        }
        if self.resources.is_empty() {
            return Err(GrantError::NoResources);
        }
        if self.tools.is_empty() {
            return Err(GrantError::NoTools);
        }
        for (i, a) in self.effects.iter().enumerate() {
            if self.effects[i + 1..].contains(a) {
                return Err(GrantError::DuplicateEffect);
            }
        }
        if self.budget.concurrency == 0 {
            return Err(GrantError::ZeroConcurrency);
        }
        if self.budget.wall_ms == 0 {
            return Err(GrantError::ZeroWallTime);
        }
        Ok(())
    }

    pub fn covers_effect(&self, effect: EffectClass) -> bool {
        self.effects.contains(&effect)
    }

    pub fn allows_target(&self, scope: &ResourceScope) -> bool {
        self.resources.iter().any(|p| p.matches(scope))
    }

    pub fn tool_verdict(&self, tool: &ToolName, schema_digest: &Digest) -> ToolVerdict {
        match self.tools.iter().find(|t| &t.tool == tool) {
            None => ToolVerdict::NotGranted,
            Some(t) if &t.schema_digest == schema_digest => ToolVerdict::Allowed,
            Some(_) => ToolVerdict::SchemaMismatch,
        }
    }

    pub fn canonical_json(&self) -> String {
        let mut w = CanonicalWriter::new();
        w.field_str("v", GRANT_DOMAIN);
        w.field_str("grant_id", self.grant_id.as_str());
        w.field_str("tenant", self.tenant.as_str());
        w.field_str("sid", self.sid.as_str());
        w.begin_array("effects");
        for e in &self.effects {
            w.array_str(e.as_str());
        }
        w.end_array();
        w.begin_array("resources");
        for r in &self.resources {
            w.array_str(&r.to_string());
        }
        w.end_array();
        w.begin_array("tools");
        for t in &self.tools {
            w.begin_object_element();
            w.field_str("tool", t.tool.as_str());
            w.field_str("schema", &t.schema_digest.to_hex());
            w.end_object();
        }
        w.end_array();
        w.field_str("max_risk", self.max_risk.as_str());
        self.budget.write_into(&mut w);
        w.field_int("issued_at_ms", self.issued_at_ms);
        w.field_int("expires_at_ms", self.expires_at_ms);
        w.field_int("epoch", self.epoch);
        w.finish()
    }

    pub fn signing_payload(&self) -> Vec<u8> {
        signing_bytes(GRANT_DOMAIN, &self.canonical_json())
    }
}

/// A grant plus the issuer and signature that makes it authoritative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedGrant {
    pub grant: Grant,
    pub issuer: IssuerId,
    pub signature: Signature,
}

impl SignedGrant {
    /// Sign a grant. Panics on an internally invalid grant: signing one is a bug in the
    /// issuer service, not a runtime condition to paper over.
    pub fn sign(grant: Grant, issuer: IssuerId, key: &SigningKeyPair) -> Self {
        assert_eq!(
            grant.validate(),
            Ok(()),
            "refusing to sign an invalid grant: {:?}",
            grant.validate()
        );
        let signature = key.sign(&grant.signing_payload());
        Self {
            grant,
            issuer,
            signature,
        }
    }

    pub fn verify(&self, vk: &VerifyingKey) -> Result<(), SigError> {
        verify(vk, &self.grant.signing_payload(), &self.signature)
    }
}
