//! Shared builders. Not a library: only test crates compile this.
#![allow(dead_code)]

use agentos_policy::budget::{Budget, Spend};
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::grant::{Grant, SignedGrant, ToolGrant};
use agentos_policy::ids::{Digest, RefId, Sid, TenantId, ToolName};
use agentos_policy::intent::ActionIntent;
use agentos_policy::kernel::PolicyKernel;
use agentos_policy::lease::{RevocationRef, SignedLease, TaskLease};
use agentos_policy::resource::{ResourcePattern, ResourceScope};
use agentos_policy::signature::{IssuerId, SigningKeyPair};

pub const NOW: u64 = 1_700_000_000_000;
pub const LEASE_MS: u64 = 60_000;

pub fn tenant() -> TenantId {
    TenantId::parse("acme").unwrap()
}

pub fn other_tenant() -> TenantId {
    TenantId::parse("globex").unwrap()
}

pub fn sid() -> Sid {
    Sid::parse("sid_0a1b2c3d").unwrap()
}

pub fn task() -> RefId {
    RefId::parse("task-0001").unwrap()
}

pub fn tool() -> ToolName {
    ToolName::parse("browser.open_url").unwrap()
}

pub fn issuer() -> IssuerId {
    "issuer-acme".parse().unwrap()
}

/// The issuer key. A fixture constant, not a secret: it is published in the repo so
/// fixtures are reproducible. Production keys never live in this repository.
pub fn key() -> SigningKeyPair {
    SigningKeyPair::from_seed(&[7u8; 32])
}

/// A second, untrusted key (never registered with the kernel).
pub fn rogue_key() -> SigningKeyPair {
    SigningKeyPair::from_seed(&[9u8; 32])
}

/// The human approver key, registered with `High` clearance by [`World::new`].
pub fn approver_key() -> SigningKeyPair {
    SigningKeyPair::from_seed(&[11u8; 32])
}

pub fn approver_id() -> IssuerId {
    "approver-ops".parse().unwrap()
}

/// A CISO-level approver: the only human who may accept Critical risk.
pub fn critical_approver_key() -> SigningKeyPair {
    SigningKeyPair::from_seed(&[13u8; 32])
}

pub fn critical_approver_id() -> IssuerId {
    "approver-ciso".parse().unwrap()
}

pub fn grant() -> Grant {
    Grant {
        grant_id: RefId::parse("grant-0001").unwrap(),
        tenant: tenant(),
        sid: sid(),
        effects: vec![EffectClass::Read, EffectClass::Compute],
        resources: vec![
            ResourcePattern::parse("http_origin:https://example.com").unwrap(),
            ResourcePattern::parse("repo:acme/*").unwrap(),
        ],
        tools: vec![ToolGrant {
            tool: tool(),
            schema_digest: Digest::of(b"schema:browser.open_url@3"),
        }],
        max_risk: RiskTier::Medium,
        budget: Budget {
            concurrency: 2,
            wall_ms: 600_000,
            spend: Spend {
                cpu_ms: 60_000,
                ram_mib: 2048,
                gpu_ms: 0,
                cloud_micros: 5_000_000,
                events: 1_000,
            },
        },
        issued_at_ms: NOW - 1_000,
        expires_at_ms: NOW + 86_400_000,
        epoch: 1,
    }
}

/// A valid intent for `tenant()`/`sid()`/`task()`: read of `example.com`, low risk.
pub fn intent() -> ActionIntent {
    ActionIntent {
        intent_id: RefId::parse("int-0001").unwrap(),
        tenant: tenant(),
        sid: sid(),
        task_id: task(),
        role_digest: Digest::of(b"role:frontend@1"),
        tool: tool(),
        tool_schema_digest: Digest::of(b"schema:browser.open_url@3"),
        effect: EffectClass::Read,
        risk: RiskTier::Low,
        target: ResourceScope::parse("http_origin:https://example.com").unwrap(),
        params_digest: Digest::of(b"{\"url\":\"https://example.com\"}"),
        idempotency_key: None,
        spend: Spend::zero(),
        issued_at_ms: NOW,
        expires_at_ms: NOW + 60_000,
        advisory: None,
    }
}

pub fn lease_for(g: &Grant, epoch: u64) -> TaskLease {
    TaskLease {
        lease_id: RefId::parse(&format!("lease-{:04}", epoch)).unwrap(),
        task_id: task(),
        tenant: g.tenant.clone(),
        sid: g.sid.clone(),
        role_digest: Digest::of(b"role:frontend@1"),
        grant_id: g.grant_id.clone(),
        epoch,
        issued_at_ms: NOW,
        expires_at_ms: NOW + LEASE_MS,
        revocation: RevocationRef {
            list: RefId::parse("tenant-acme-revocations").unwrap(),
            version: 12,
        },
        nonce: Digest::of(format!("nonce:{epoch}").as_bytes()),
    }
}

/// A kernel with a trusted issuer, one grant and one registered epoch-1 lease.
pub struct World {
    pub kernel: PolicyKernel,
    pub signed_lease: SignedLease,
    pub grant: Grant,
}

impl World {
    pub fn new(grant: Grant) -> Self {
        let mut kernel = PolicyKernel::new();
        kernel.trust_issuer(issuer(), key().verifying_key());
        kernel.trust_approver(
            approver_id(),
            approver_key().verifying_key(),
            RiskTier::High,
        );
        kernel.trust_approver(
            critical_approver_id(),
            critical_approver_key().verifying_key(),
            RiskTier::Critical,
        );
        kernel
            .register_grant(SignedGrant::sign(grant.clone(), issuer(), &key()))
            .expect("fixture grant registers");
        let lease = lease_for(&grant, 1);
        let signed_lease = SignedLease::sign(lease, issuer(), &key());
        kernel
            .register_lease(&signed_lease)
            .expect("fixture lease registers");
        Self {
            kernel,
            signed_lease,
            grant,
        }
    }

    pub fn default_world() -> Self {
        Self::new(grant())
    }

    /// Issue and register a lease at a higher epoch (a new worker takes the task over).
    pub fn reissue(&mut self, epoch: u64) -> SignedLease {
        self.reissue_with_duration(epoch, LEASE_MS)
    }

    pub fn reissue_with_duration(&mut self, epoch: u64, lease_ms: u64) -> SignedLease {
        self.reissue_at(epoch, NOW, lease_ms)
    }

    /// A takeover lease issued at an arbitrary time (e.g. after the previous worker died).
    pub fn reissue_at(&mut self, epoch: u64, issued_at_ms: u64, lease_ms: u64) -> SignedLease {
        let mut lease = lease_for(&self.grant, epoch);
        lease.issued_at_ms = issued_at_ms;
        lease.expires_at_ms = issued_at_ms + lease_ms;
        let signed = SignedLease::sign(lease, issuer(), &key());
        self.kernel
            .register_lease(&signed)
            .expect("reissue registers");
        self.signed_lease = signed.clone();
        signed
    }

    pub fn authorize(
        &mut self,
        intent: &ActionIntent,
        now_ms: u64,
    ) -> Result<agentos_policy::kernel::ActionPermit, agentos_policy::kernel::Denial> {
        let lease = self.signed_lease.clone();
        self.kernel.authorize(&lease, intent, now_ms)
    }
}
