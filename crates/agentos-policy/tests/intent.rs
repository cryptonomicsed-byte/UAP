//! M1-04 (V6-05-01 contracts, V6-05-02 inputs): ResourceScope must be an exact
//! target, ResourcePattern is the only place a wildcard may exist, and an
//! ActionIntent must be tamper-evident — changing any field changes its digest.

mod common;

use agentos_policy::budget::Spend;
use agentos_policy::canonical::CanonicalWriter;
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::ids::{Digest, RefId, TenantId, ToolName};
use agentos_policy::intent::{ActionIntent, Advisory, AdvisoryVerdict};
use agentos_policy::resource::{ResourceKind, ResourcePattern, ResourceScope};

// ---------------------------------------------------------------- ResourceScope

#[test]
fn resource_scope_has_kind_and_exact_id_and_no_wildcards() {
    let s = ResourceScope::parse("http_origin:https://example.com").unwrap();
    assert_eq!(s.kind(), ResourceKind::HttpOrigin);
    assert_eq!(s.id(), "https://example.com");
    assert_eq!(s.to_string(), "http_origin:https://example.com");

    // A dispatch target may never be a pattern: wildcards belong to grants only.
    for bad in [
        "http_origin:*",
        "http_origin:https://example.com/*",
        "repo:acme/*",
        "http_origin:",
        "http_origin",
        "nosuchkind:x",
        "http_origin:exa mple.com",
        "http_origin:exa\"mple.com",
        "http_origin:https://example.com?q=*",
    ] {
        assert!(
            ResourceScope::parse(bad).is_err(),
            "ResourceScope must reject {bad:?}"
        );
    }
}

#[test]
fn resource_scope_accepts_real_world_ids() {
    for (raw, kind) in [
        ("file:/srv/out/report.csv", ResourceKind::File),
        ("repo:cryptonomicsed-byte/uap", ResourceKind::Repo),
        ("database:uap.prod.sessions", ResourceKind::Database),
        ("vault_secret:tenant/acme/openai", ResourceKind::VaultSecret),
        ("cloud_account:aws:123456789012", ResourceKind::CloudAccount),
        ("dataset:s3://bucket/key.parquet", ResourceKind::Dataset),
        ("queue:uap.task_jobs", ResourceKind::Queue),
        ("model:openai/gpt-5", ResourceKind::Model),
        ("tool:browser.open_url", ResourceKind::Tool),
    ] {
        let s = ResourceScope::parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!(s.kind(), kind);
    }
}

// -------------------------------------------------------------- ResourcePattern

#[test]
fn pattern_matches_exact_subtree_and_any_but_never_a_sibling_prefix() {
    let exact = ResourcePattern::parse("repo:acme/core").unwrap();
    assert!(exact.matches(&ResourceScope::parse("repo:acme/core").unwrap()));
    assert!(!exact.matches(&ResourceScope::parse("repo:acme/core2").unwrap()));

    let subtree = ResourcePattern::parse("repo:acme/*").unwrap();
    assert!(subtree.matches(&ResourceScope::parse("repo:acme/core").unwrap()));
    assert!(subtree.matches(&ResourceScope::parse("repo:acme/core/sub").unwrap()));
    assert!(
        !subtree.matches(&ResourceScope::parse("repo:acmex/core").unwrap()),
        "a prefix match must respect the '/' boundary"
    );
    assert!(
        !subtree.matches(&ResourceScope::parse("file:acme/core").unwrap()),
        "a pattern is scoped to its own resource kind"
    );

    let any = ResourcePattern::any_of(ResourceKind::VaultSecret);
    assert!(any.matches(&ResourceScope::parse("vault_secret:tenant/a/k").unwrap()));
    assert!(!any.matches(&ResourceScope::parse("file:/etc/passwd").unwrap()));
}

#[test]
fn pattern_rejects_interior_and_double_wildcards() {
    for bad in [
        "repo:*acme",
        "repo:acme/*/sub",
        "repo:acme**",
        "repo:acme/*/*",
        "repo:",
        "repo",
        "repo:acme/core ",
    ] {
        assert!(
            ResourcePattern::parse(bad).is_err(),
            "ResourcePattern must reject {bad:?}"
        );
    }
}

// ----------------------------------------------------------------- ActionIntent

#[test]
fn intent_digest_changes_when_any_security_relevant_field_changes() {
    let base = common::intent();
    let baseline = base.digest();

    let mut mutations: Vec<ActionIntent> = Vec::new();

    let mut m = base.clone();
    m.tenant = common::other_tenant();
    mutations.push(m);

    let mut m = base.clone();
    m.sid = agentos_policy::ids::Sid::parse("sid_deadbeef").unwrap();
    mutations.push(m);

    let mut m = base.clone();
    m.task_id = RefId::parse("task-0002").unwrap();
    mutations.push(m);

    let mut m = base.clone();
    m.role_digest = Digest::of(b"role:admin@1");
    mutations.push(m);

    let mut m = base.clone();
    m.tool = ToolName::parse("browser.post_form").unwrap();
    mutations.push(m);

    let mut m = base.clone();
    m.tool_schema_digest = Digest::of(b"schema:browser.open_url@4");
    mutations.push(m);

    let mut m = base.clone();
    m.effect = EffectClass::Write;
    mutations.push(m);

    let mut m = base.clone();
    m.risk = RiskTier::Critical;
    mutations.push(m);

    let mut m = base.clone();
    m.target = ResourceScope::parse("http_origin:https://evil.example").unwrap();
    mutations.push(m);

    let mut m = base.clone();
    m.params_digest = Digest::of(b"{\"url\":\"https://evil.example\"}");
    mutations.push(m);

    let mut m = base.clone();
    m.idempotency_key = Some(RefId::parse("idem-1").unwrap());
    mutations.push(m);

    let mut m = base.clone();
    m.spend = Spend {
        cloud_micros: 1,
        ..Spend::zero()
    };
    mutations.push(m);

    let mut m = base.clone();
    m.expires_at_ms += 1;
    mutations.push(m);

    for (i, m) in mutations.iter().enumerate() {
        assert_ne!(
            m.digest(),
            baseline,
            "mutation {i} did not change the digest"
        );
    }
    // And the digest is stable for an equal value.
    assert_eq!(base.clone().digest(), baseline);
}

#[test]
fn intent_validation_rejects_inverted_and_empty_windows() {
    let mut i = common::intent();
    assert!(i.validate().is_ok());

    i.expires_at_ms = i.issued_at_ms; // zero-length
    assert!(i.validate().is_err());

    i.expires_at_ms = i.issued_at_ms - 1; // inverted
    assert!(i.validate().is_err());
}

#[test]
fn external_effects_require_an_idempotency_key() {
    let mut i = common::intent();
    i.effect = EffectClass::Money;
    assert!(
        i.validate().is_err(),
        "money movement without an idempotency key must not validate"
    );
    i.idempotency_key = Some(RefId::parse("idem-money-1").unwrap());
    assert!(i.validate().is_ok());

    // Reads do not need one.
    let mut r = common::intent();
    r.idempotency_key = None;
    assert!(r.validate().is_ok());
}

#[test]
fn advisory_verdict_is_carried_in_the_intent_but_is_not_part_of_authority() {
    // The kernel test proves it cannot change a decision; here we only prove it is
    // typed, bounded and digest-bound (so a swapped advisory is tamper-evident).
    let mut i = common::intent();
    let clean = i.digest();
    i.advisory = Some(Advisory {
        model: "policy-suggest-v1".to_string(),
        verdict: AdvisoryVerdict::Allow,
        confidence_bp: 10_000,
    });
    assert_ne!(i.digest(), clean);

    // Confidence is basis points: 10001 is not a confidence.
    i.advisory.as_mut().unwrap().confidence_bp = 10_001;
    assert!(i.validate().is_err());
}

#[test]
fn effect_classes_and_risk_tiers_have_stable_wire_names() {
    for (e, s) in [
        (EffectClass::Read, "read"),
        (EffectClass::Compute, "compute"),
        (EffectClass::Write, "write"),
        (EffectClass::ExternalMessage, "external_message"),
        (EffectClass::Money, "money"),
        (EffectClass::Publish, "publish"),
        (EffectClass::ProductionChange, "production_change"),
        (EffectClass::SecurityTesting, "security_testing"),
        (EffectClass::ClinicalData, "clinical_data"),
    ] {
        assert_eq!(e.as_str(), s);
        assert_eq!(EffectClass::parse(s).unwrap(), e);
    }
    // Exactly five classes are human-approval classes; that list is a policy fact,
    // so it is asserted rather than assumed.
    let need: Vec<&str> = EffectClass::ALL
        .iter()
        .filter(|e| e.requires_human_approval())
        .map(|e| e.as_str())
        .collect();
    assert_eq!(
        need,
        vec![
            "money",
            "publish",
            "production_change",
            "security_testing",
            "clinical_data"
        ]
    );

    assert!(RiskTier::Low < RiskTier::Medium);
    assert!(RiskTier::Medium < RiskTier::High);
    assert!(RiskTier::High < RiskTier::Critical);
    assert_eq!(RiskTier::Critical.as_str(), "critical");
}

#[test]
fn spend_arithmetic_is_checked_not_wrapping() {
    let big = Spend {
        cpu_ms: u64::MAX,
        ..Spend::zero()
    };
    let one = Spend {
        cpu_ms: 1,
        ..Spend::zero()
    };
    assert!(
        big.checked_add(&one).is_none(),
        "overflow must be None, not 0"
    );
    assert_eq!(Spend::zero().checked_add(&one).unwrap().cpu_ms, 1);
}

#[test]
fn canonical_json_is_compact_ordered_and_escapes_unsafe_characters() {
    // Golden bytes: the exact wire form other languages must reproduce.
    let i = common::intent();
    let expected = format!(
        concat!(
            "{{\"v\":\"uap-intent/1\",\"intent_id\":\"int-0001\",\"tenant\":\"acme\",",
            "\"sid\":\"sid_0a1b2c3d\",\"task_id\":\"task-0001\",",
            "\"role_digest\":\"{}\",\"tool\":\"browser.open_url\",",
            "\"tool_schema\":\"{}\",\"effect\":\"read\",\"risk\":\"low\",",
            "\"target\":\"http_origin:https://example.com\",",
            "\"params\":\"{}\",\"idempotency\":null,",
            "\"spend\":{{\"cpu_ms\":0,\"ram_mib\":0,\"gpu_ms\":0,",
            "\"cloud_micros\":0,\"events\":0}},",
            "\"issued_at_ms\":1700000000000,\"expires_at_ms\":1700000060000,",
            "\"advisory\":null}}"
        ),
        i.role_digest.to_hex(),
        i.tool_schema_digest.to_hex(),
        i.params_digest.to_hex()
    );
    assert_eq!(i.canonical_json(), expected);
    assert_eq!(i.canonical_bytes(), expected.as_bytes());

    // The writer's escaper is real even though validated ids never need it.
    let mut w = CanonicalWriter::new();
    w.field_str("k", "quote\" back\\slash \u{1} tab\tnl\n");
    assert_eq!(
        w.finish(),
        "{\"k\":\"quote\\\" back\\\\slash \\u0001 tab\\tnl\\n\"}"
    );
}

#[test]
fn tenant_and_tool_ids_cannot_carry_json_json_metacharacters() {
    for bad in ["a\"b", "a}b", "a,b", "a:b"] {
        assert!(TenantId::parse(bad).is_err());
    }
    let ok = ToolName::parse("browser.open_url").unwrap();
    assert!(!ok.as_str().contains('"'));
}
