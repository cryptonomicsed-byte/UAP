//! M1-05 (V6-05-01/03): Grant and Lease are signed documents.
//!
//! A grant says what a SID may do for how long with what budget. A lease says this
//! worker, at this epoch, is the one allowed to act on this task. Both are signed;
//! neither signature covers a mutable outside field, so verification is the same
//! operation everywhere (Rust, Elixir, Go, Python — see M1-07 fixtures).

mod common;

use agentos_policy::budget::{Budget, Spend};
use agentos_policy::canonical::signing_bytes;
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::grant::{Grant, GrantError, SignedGrant, ToolGrant, GRANT_DOMAIN};
use agentos_policy::ids::{Digest, RefId, Sid, ToolName};
use agentos_policy::lease::{LeaseError, RevocationRef, SignedLease, TaskLease, LEASE_DOMAIN};
use agentos_policy::resource::ResourcePattern;
use agentos_policy::signature::{verify, Signature, SigningKeyPair};

fn key() -> SigningKeyPair {
    SigningKeyPair::from_seed(&[7u8; 32])
}

fn other_key() -> SigningKeyPair {
    SigningKeyPair::from_seed(&[9u8; 32])
}

fn grant() -> Grant {
    Grant {
        grant_id: RefId::parse("grant-0001").unwrap(),
        tenant: common::tenant(),
        sid: common::sid(),
        effects: vec![EffectClass::Read, EffectClass::Compute],
        resources: vec![
            ResourcePattern::parse("http_origin:https://example.com").unwrap(),
            ResourcePattern::parse("repo:acme/*").unwrap(),
        ],
        tools: vec![ToolGrant {
            tool: common::tool(),
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
        issued_at_ms: common::NOW,
        expires_at_ms: common::NOW + 86_400_000,
        epoch: 1,
    }
}

fn lease() -> TaskLease {
    TaskLease {
        lease_id: RefId::parse("lease-0001").unwrap(),
        task_id: common::task(),
        tenant: common::tenant(),
        sid: common::sid(),
        role_digest: Digest::of(b"role:frontend@1"),
        grant_id: RefId::parse("grant-0001").unwrap(),
        epoch: 1,
        issued_at_ms: common::NOW,
        expires_at_ms: common::NOW + 60_000,
        revocation: RevocationRef {
            list: RefId::parse("tenant-acme-revocations").unwrap(),
            version: 12,
        },
        nonce: Digest::of(b"nonce:0001"),
    }
}

// ----------------------------------------------------------------------- Grant

#[test]
fn grant_signs_and_verifies_and_every_field_is_covered() {
    let g = grant();
    let signed = SignedGrant::sign(g.clone(), "issuer-acme".parse().unwrap(), &key());
    signed.verify(&key().verifying_key()).expect("valid grant");

    let mut mutations: Vec<Grant> = Vec::new();
    let mut m = g.clone();
    m.grant_id = RefId::parse("grant-0002").unwrap();
    mutations.push(m);
    let mut m = g.clone();
    m.tenant = common::other_tenant();
    mutations.push(m);
    let mut m = g.clone();
    m.sid = Sid::parse("sid_deadbeef").unwrap();
    mutations.push(m);
    let mut m = g.clone();
    m.effects.push(EffectClass::Money);
    mutations.push(m);
    let mut m = g.clone();
    m.resources
        .push(ResourcePattern::parse("file:/etc/*").unwrap());
    mutations.push(m);
    let mut m = g.clone();
    m.tools[0].schema_digest = Digest::of(b"schema:browser.open_url@4");
    mutations.push(m);
    let mut m = g.clone();
    m.max_risk = RiskTier::Critical;
    mutations.push(m);
    let mut m = g.clone();
    m.budget.concurrency = 3;
    mutations.push(m);
    let mut m = g.clone();
    m.budget.spend.cloud_micros += 1;
    mutations.push(m);
    let mut m = g.clone();
    m.expires_at_ms += 1;
    mutations.push(m);
    let mut m = g.clone();
    m.epoch += 1;
    mutations.push(m);

    for (i, m) in mutations.iter().enumerate() {
        let forged = SignedGrant {
            grant: m.clone(),
            issuer: signed.issuer.clone(),
            signature: signed.signature,
        };
        assert!(
            forged.verify(&key().verifying_key()).is_err(),
            "grant mutation {i} still verified"
        );
    }
}

#[test]
fn grant_from_another_issuer_key_does_not_verify() {
    let signed = SignedGrant::sign(grant(), "issuer-acme".parse().unwrap(), &other_key());
    assert!(signed.verify(&key().verifying_key()).is_err());
}

#[test]
fn grant_validation_refuses_empty_or_duplicate_lists() {
    let mut g = grant();
    assert!(g.validate().is_ok());

    g.effects.clear();
    assert_eq!(g.validate(), Err(GrantError::NoEffects));
    g = grant();
    g.effects.push(EffectClass::Read); // duplicate
    assert_eq!(g.validate(), Err(GrantError::DuplicateEffect));

    g = grant();
    g.resources.clear();
    assert_eq!(g.validate(), Err(GrantError::NoResources));

    g = grant();
    g.tools.clear();
    assert_eq!(g.validate(), Err(GrantError::NoTools));

    g = grant();
    g.expires_at_ms = g.issued_at_ms;
    assert_eq!(g.validate(), Err(GrantError::EmptyOrInvertedWindow));

    g = grant();
    g.budget.concurrency = 0;
    assert_eq!(g.validate(), Err(GrantError::ZeroConcurrency));

    g = grant();
    g.budget.wall_ms = 0;
    assert_eq!(g.validate(), Err(GrantError::ZeroWallTime));
}

#[test]
fn grant_covering_helpers_answer_exactly() {
    let g = grant();
    assert!(g.covers_effect(EffectClass::Read));
    assert!(!g.covers_effect(EffectClass::Money));
    assert!(
        g.allows_target(&agentos_policy::resource::ResourceScope::parse("repo:acme/core").unwrap())
    );
    assert!(!g.allows_target(
        &agentos_policy::resource::ResourceScope::parse("repo:other/core").unwrap()
    ));
    assert_eq!(
        g.tool_verdict(&common::tool(), &Digest::of(b"schema:browser.open_url@3")),
        agentos_policy::grant::ToolVerdict::Allowed
    );
    assert_eq!(
        g.tool_verdict(&common::tool(), &Digest::of(b"schema:browser.open_url@4")),
        agentos_policy::grant::ToolVerdict::SchemaMismatch
    );
    assert_eq!(
        g.tool_verdict(&ToolName::parse("shell.exec").unwrap(), &Digest::of(b"x")),
        agentos_policy::grant::ToolVerdict::NotGranted
    );
}

// ----------------------------------------------------------------------- Lease

#[test]
fn lease_signs_and_verifies_and_every_field_is_covered() {
    let l = lease();
    let signed = SignedLease::sign(l.clone(), "issuer-acme".parse().unwrap(), &key());
    signed.verify(&key().verifying_key()).expect("valid lease");

    let mut mutations: Vec<TaskLease> = Vec::new();
    let mut m = l.clone();
    m.lease_id = RefId::parse("lease-0002").unwrap();
    mutations.push(m);
    let mut m = l.clone();
    m.task_id = RefId::parse("task-0002").unwrap();
    mutations.push(m);
    let mut m = l.clone();
    m.tenant = common::other_tenant();
    mutations.push(m);
    let mut m = l.clone();
    m.sid = Sid::parse("sid_deadbeef").unwrap();
    mutations.push(m);
    let mut m = l.clone();
    m.role_digest = Digest::of(b"role:admin@1");
    mutations.push(m);
    let mut m = l.clone();
    m.grant_id = RefId::parse("grant-9999").unwrap();
    mutations.push(m);
    let mut m = l.clone();
    m.epoch = 2;
    mutations.push(m);
    let mut m = l.clone();
    m.expires_at_ms += 1;
    mutations.push(m);
    let mut m = l.clone();
    m.revocation.version += 1; // the revocation reference is signed, not advisory
    mutations.push(m);
    let mut m = l.clone();
    m.revocation.list = RefId::parse("other-list").unwrap();
    mutations.push(m);
    let mut m = l.clone();
    m.nonce = Digest::of(b"nonce:0002");
    mutations.push(m);

    for (i, m) in mutations.iter().enumerate() {
        let forged = SignedLease {
            lease: m.clone(),
            issuer: signed.issuer.clone(),
            signature: signed.signature,
        };
        assert!(
            forged.verify(&key().verifying_key()).is_err(),
            "lease mutation {i} still verified"
        );
    }
}

#[test]
fn lease_signature_is_domain_separated_from_a_grant() {
    let l = lease();
    let signed = SignedLease::sign(l.clone(), "issuer-acme".parse().unwrap(), &key());
    let payload = l.canonical_json();

    // The same bytes under the wrong domain must not verify.
    let wrong = signing_bytes(GRANT_DOMAIN, &payload);
    assert!(verify(&key().verifying_key(), &wrong, &signed.signature).is_err());
    let right = signing_bytes(LEASE_DOMAIN, &payload);
    assert!(verify(&key().verifying_key(), &right, &signed.signature).is_ok());
}

#[test]
fn lease_validation_enforces_window_and_epoch() {
    let mut l = lease();
    assert!(l.validate().is_ok());

    l.epoch = 0;
    assert_eq!(l.validate(), Err(LeaseError::ZeroEpoch));

    l = lease();
    l.expires_at_ms = l.issued_at_ms;
    assert_eq!(l.validate(), Err(LeaseError::EmptyOrInvertedWindow));

    // Short-lived by construction: the kernel refuses a lease longer than 24h.
    l = lease();
    l.expires_at_ms = l.issued_at_ms + 24 * 60 * 60 * 1000 + 1;
    assert_eq!(l.validate(), Err(LeaseError::TooLongLived));
}

#[test]
fn lease_validity_window_is_half_open() {
    let l = lease();
    assert!(!l.is_valid_at(l.issued_at_ms - 1));
    assert!(l.is_valid_at(l.issued_at_ms));
    assert!(l.is_valid_at(l.expires_at_ms - 1));
    assert!(!l.is_valid_at(l.expires_at_ms));
}

#[test]
fn lease_canonical_json_is_byte_exact() {
    let l = lease();
    let expected = format!(
        concat!(
            "{{\"v\":\"uap-lease/1\",\"lease_id\":\"lease-0001\",\"task_id\":\"task-0001\",",
            "\"tenant\":\"acme\",\"sid\":\"sid_0a1b2c3d\",\"role_digest\":\"{}\",",
            "\"grant_id\":\"grant-0001\",\"epoch\":1,\"issued_at_ms\":1700000000000,",
            "\"expires_at_ms\":1700000060000,",
            "\"revocation\":{{\"list\":\"tenant-acme-revocations\",\"version\":12}},",
            "\"nonce\":\"{}\"}}"
        ),
        l.role_digest.to_hex(),
        l.nonce.to_hex()
    );
    assert_eq!(l.canonical_json(), expected);
}

#[test]
fn grant_canonical_json_arrays_are_compact_and_ordered() {
    let g = grant();
    let json = g.canonical_json();
    assert!(
        json.contains("\"effects\":[\"read\",\"compute\"]"),
        "effects array not canonical: {json}"
    );
    assert!(
        json.contains("\"resources\":[\"http_origin:https://example.com\",\"repo:acme/*\"]"),
        "resources array not canonical: {json}"
    );
    assert!(
        json.contains("\"tools\":[{\"tool\":\"browser.open_url\""),
        "tools array not canonical: {json}"
    );
    assert!(
        !json.contains(", "),
        "canonical JSON must not contain spaces"
    );
}

#[test]
fn signature_hex_has_one_spelling() {
    let sig = Signature::from_bytes([0xab; 64]);
    let hex = sig.to_hex();
    assert_eq!(hex.len(), 128);
    assert!(hex
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_eq!(Signature::parse_hex(&hex).unwrap(), sig);
    assert!(Signature::parse_hex(&hex.to_uppercase()).is_err());
    assert!(Signature::parse_hex("abcd").is_err());
}

#[test]
fn issuer_id_cannot_be_an_empty_or_wildcard_string() {
    assert!("".parse::<agentos_policy::signature::IssuerId>().is_err());
    assert!("is*"
        .parse::<agentos_policy::signature::IssuerId>()
        .is_err());
    assert!("issuer-acme"
        .parse::<agentos_policy::signature::IssuerId>()
        .is_ok());
}
