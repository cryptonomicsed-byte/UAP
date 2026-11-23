//! Effect classes and risk tiers.
//!
//! The effect class is what the *tool does*, declared by the tool descriptor and
//! pinned at grant time. It is not a hint from the model: an intent that claims
//! `read` for a tool whose descriptor says `money` fails schema-digest pinning in
//! the kernel before the effect is even compared.

use core::fmt;

/// What an action does to the world. Ordered roughly by blast radius.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EffectClass {
    /// Reads data the tenant already owns.
    Read,
    /// Burns compute without external mutation (inference, indexing, sandboxed runs).
    Compute,
    /// Mutates tenant-owned state.
    Write,
    /// Sends something to a third party (email, webhook, DM).
    ExternalMessage,
    /// Moves money or creates a financial obligation.
    Money,
    /// Publishes to an audience (site, store, social, marketplace listing).
    Publish,
    /// Changes a production system (deploy, migration, infra mutation).
    ProductionChange,
    /// Runs offensive security tooling against scoped assets.
    SecurityTesting,
    /// Touches clinical or patient data.
    ClinicalData,
}

impl EffectClass {
    pub const ALL: [EffectClass; 9] = [
        EffectClass::Read,
        EffectClass::Compute,
        EffectClass::Write,
        EffectClass::ExternalMessage,
        EffectClass::Money,
        EffectClass::Publish,
        EffectClass::ProductionChange,
        EffectClass::SecurityTesting,
        EffectClass::ClinicalData,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EffectClass::Read => "read",
            EffectClass::Compute => "compute",
            EffectClass::Write => "write",
            EffectClass::ExternalMessage => "external_message",
            EffectClass::Money => "money",
            EffectClass::Publish => "publish",
            EffectClass::ProductionChange => "production_change",
            EffectClass::SecurityTesting => "security_testing",
            EffectClass::ClinicalData => "clinical_data",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "read" => EffectClass::Read,
            "compute" => EffectClass::Compute,
            "write" => EffectClass::Write,
            "external_message" => EffectClass::ExternalMessage,
            "money" => EffectClass::Money,
            "publish" => EffectClass::Publish,
            "production_change" => EffectClass::ProductionChange,
            "security_testing" => EffectClass::SecurityTesting,
            "clinical_data" => EffectClass::ClinicalData,
            _ => return None,
        })
    }

    /// V6-05-07: these five classes require a signed human approval, every time.
    pub fn requires_human_approval(self) -> bool {
        matches!(
            self,
            EffectClass::Money
                | EffectClass::Publish
                | EffectClass::ProductionChange
                | EffectClass::SecurityTesting
                | EffectClass::ClinicalData
        )
    }

    /// Effects that leave the tenant's boundary and therefore require an
    /// idempotency key (V6-05-06). Reads and compute do not.
    pub fn is_external(self) -> bool {
        matches!(
            self,
            EffectClass::ExternalMessage
                | EffectClass::Money
                | EffectClass::Publish
                | EffectClass::ProductionChange
                | EffectClass::SecurityTesting
                | EffectClass::ClinicalData
        )
    }
}

impl fmt::Display for EffectClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Assessed blast radius of one action. `Ord` is deliberate: a grant has a ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RiskTier {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskTier {
    pub const ALL: [RiskTier; 4] = [
        RiskTier::Low,
        RiskTier::Medium,
        RiskTier::High,
        RiskTier::Critical,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RiskTier::Low => "low",
            RiskTier::Medium => "medium",
            RiskTier::High => "high",
            RiskTier::Critical => "critical",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "low" => RiskTier::Low,
            "medium" => RiskTier::Medium,
            "high" => RiskTier::High,
            "critical" => RiskTier::Critical,
            _ => return None,
        })
    }
}

impl fmt::Display for RiskTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
