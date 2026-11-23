//! Shared builders. Not a library: only test crates compile this.
#![allow(dead_code)]

use agentos_policy::budget::Spend;
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::ids::{Digest, RefId, Sid, TenantId, ToolName};
use agentos_policy::intent::ActionIntent;
use agentos_policy::resource::ResourceScope;

pub const NOW: u64 = 1_700_000_000_000;

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

/// A valid intent for `tenant()`/`sid()`/`task()`: read of `example.com`, low risk,
/// one-minute window starting at NOW, no spend.
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
