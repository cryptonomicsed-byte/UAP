//! M1-06 (V6-05-02..08, V6-05-10): dispatch validation, one-use permits, replay
//! protection, human approvals, admission ceilings and the audit trail.
//!
//! These are the negative tests first: for every way an action can be illegal, the
//! kernel must refuse with the *specific* reason, because an operator debugging a
//! denial needs to know which of 20 checks fired — and a test that only asserts
//! "denied" cannot tell those 20 apart.

mod common;

use agentos_policy::approval::{ApprovalRecord, SignedApproval};
use agentos_policy::budget::Spend;
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::grant::{SignedGrant, GRANT_DOMAIN};
use agentos_policy::ids::{Digest, RefId};
use agentos_policy::intent::{ActionIntent, Advisory, AdvisoryVerdict};
use agentos_policy::kernel::{DenyReason, PolicyKernel};
use agentos_policy::lease::SignedLease;
use agentos_policy::resource::{ResourcePattern, ResourceScope};
use agentos_policy::signature::{Signature, SigningKeyPair};

// ------------------------------------------------------------------- helpers

fn money_world() -> common::World {
    let mut g = common::grant();
    g.effects.push(EffectClass::Money);
    g.max_risk = RiskTier::Critical;
    g.resources
        .push(ResourcePattern::parse("cloud_account:aws:123456789012").unwrap());
    common::World::new(g)
}

fn money_intent() -> ActionIntent {
    let mut i = common::intent();
    i.intent_id = RefId::parse("int-money-1").unwrap();
    i.effect = EffectClass::Money;
    i.risk = RiskTier::Critical;
    i.target = ResourceScope::parse("cloud_account:aws:123456789012").unwrap();
    i.idempotency_key = Some(RefId::parse("idem-money-1").unwrap());
    i.params_digest = Digest::of(b"{\"amount_usd\":\"12.50\"}");
    i
}

fn external_world() -> common::World {
    let mut g = common::grant();
    g.effects.push(EffectClass::ExternalMessage);
    common::World::new(g)
}

fn external_intent(id: &str, idem: &str) -> ActionIntent {
    let mut i = common::intent();
    i.intent_id = RefId::parse(id).unwrap();
    i.effect = EffectClass::ExternalMessage;
    i.idempotency_key = Some(RefId::parse(idem).unwrap());
    i.params_digest = Digest::of(idem.as_bytes());
    i
}

fn approval_record(intent: &ActionIntent, params: Digest, max_risk: RiskTier) -> ApprovalRecord {
    let suffix = &params.to_hex()[..8];
    ApprovalRecord {
        approval_id: RefId::parse(&format!("appr-{}-{}", intent.intent_id.as_str(), suffix))
            .unwrap(),
        tenant: intent.tenant.clone(),
        sid: intent.sid.clone(),
        intent_id: intent.intent_id.clone(),
        params_digest: params,
        effect: intent.effect,
        max_risk,
        approved_at_ms: common::NOW,
        expires_at_ms: common::NOW + 300_000,
    }
}

/// An approval signed by the approver whose clearance matches `max_risk`.
fn approval(intent: &ActionIntent, params: Digest, max_risk: RiskTier) -> SignedApproval {
    let rec = approval_record(intent, params, max_risk);
    if max_risk == RiskTier::Critical {
        SignedApproval::sign(
            rec,
            common::critical_approver_id(),
            &common::critical_approver_key(),
        )
    } else {
        SignedApproval::sign(rec, common::approver_id(), &common::approver_key())
    }
}

// ------------------------------------------------------- identity of the caller

#[test]
fn denies_a_lease_from_an_untrusted_issuer() {
    let mut w = common::World::default_world();
    let rogue_issuer = "issuer-rogue".parse().unwrap();
    let rogue = SignedLease::sign(
        common::lease_for(&w.grant, 1),
        rogue_issuer,
        &common::rogue_key(),
    );
    let d = w
        .kernel
        .authorize(&rogue, &common::intent(), common::NOW)
        .unwrap_err();
    // The rogue key is not registered, so the issuer id is unknown before the signature
    // is even checked: no "trust on first use" path exists.
    assert_eq!(d.reason, DenyReason::UnknownIssuer);
}

#[test]
fn denies_a_tampered_lease() {
    let mut w = common::World::default_world();
    let mut forged = w.signed_lease.clone();
    forged.lease.expires_at_ms += 1;
    let d = w
        .kernel
        .authorize(&forged, &common::intent(), common::NOW)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::InvalidSignature);
}

#[test]
fn denies_expired_future_and_expired_intent() {
    let mut w = common::World::default_world();
    let lease_end = w.signed_lease.lease.expires_at_ms;

    let d = w
        .kernel
        .authorize(&w.signed_lease.clone(), &common::intent(), common::NOW - 1)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::LeaseNotYetValid);

    let d = w
        .kernel
        .authorize(&w.signed_lease.clone(), &common::intent(), lease_end)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::LeaseExpired);

    let mut short = common::intent();
    short.expires_at_ms = common::NOW + 30_000;
    let d = w
        .kernel
        .authorize(&w.signed_lease.clone(), &short, common::NOW + 30_000)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::IntentExpired);
}

#[test]
fn denies_a_superseded_worker_at_every_later_call() {
    // V6-05-10: worker A held epoch 1; worker B took the task over at epoch 2.
    let mut w = common::World::default_world();
    let dead_worker = w.signed_lease.clone();
    w.reissue(2);

    let d = w
        .kernel
        .authorize(&dead_worker, &common::intent(), common::NOW)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::StaleEpoch);

    // And it stays dead: a later retry does not revive it.
    let mut i2 = common::intent();
    i2.intent_id = RefId::parse("int-0002").unwrap();
    let d = w
        .kernel
        .authorize(&dead_worker, &i2, common::NOW + 1_000)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::StaleEpoch);
}

#[test]
fn denies_a_lease_when_the_revocation_list_advances() {
    let mut w = common::World::default_world();
    let list = RefId::parse("tenant-acme-revocations").unwrap();
    w.kernel.publish_revocation_version(&list, 13);
    let d = w
        .kernel
        .authorize(&w.signed_lease.clone(), &common::intent(), common::NOW)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::LeaseRevoked);

    // Publishing an older version cannot un-revoke.
    w.kernel.publish_revocation_version(&list, 11);
    let d = w
        .kernel
        .authorize(&w.signed_lease.clone(), &common::intent(), common::NOW)
        .unwrap_err();
    assert_eq!(d.reason, DenyReason::LeaseRevoked);
}

#[test]
fn denies_tenant_actor_task_and_role_mismatch() {
    let mut w = common::World::default_world();

    let mut i = common::intent();
    i.tenant = common::other_tenant();
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::TenantMismatch
    );

    let mut i = common::intent();
    i.sid = agentos_policy::ids::Sid::parse("sid_other").unwrap();
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::ActorMismatch
    );

    let mut i = common::intent();
    i.task_id = RefId::parse("task-other").unwrap();
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::TaskMismatch
    );

    let mut i = common::intent();
    i.role_digest = Digest::of(b"role:admin@1");
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::RoleMismatch
    );
}

// ------------------------------------------------------------ what is granted

#[test]
fn denies_an_effect_the_grant_does_not_confer() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.effect = EffectClass::Money;
    i.idempotency_key = Some(RefId::parse("idem-1").unwrap());
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::EffectNotGranted
    );
}

#[test]
fn denies_a_tool_whose_schema_changed_after_the_grant() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.tool_schema_digest = Digest::of(b"schema:browser.open_url@4");
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::ToolSchemaChanged
    );

    let mut i = common::intent();
    i.tool = agentos_policy::ids::ToolName::parse("shell.exec").unwrap();
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::ToolNotGranted
    );
}

#[test]
fn denies_a_target_outside_the_grant() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.target = ResourceScope::parse("file:/etc/passwd").unwrap();
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::ResourceNotGranted
    );

    // Same kind, sibling name: exact matching, not prefix matching.
    let mut i = common::intent();
    i.target = ResourceScope::parse("http_origin:https://example.com.evil.test").unwrap();
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::ResourceNotGranted
    );
}

#[test]
fn denies_risk_above_the_grant_ceiling() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.risk = RiskTier::Critical;
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::RiskExceedsGrant
    );
}

#[test]
fn denies_spend_above_the_grant_budget() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.spend = Spend {
        cloud_micros: 5_000_001,
        ..Spend::zero()
    };
    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::SpendExceedsBudget
    );

    // Exactly at the ceiling is allowed: ceilings are inclusive.
    let mut i = common::intent();
    i.spend = Spend {
        cloud_micros: 5_000_000,
        ..Spend::zero()
    };
    assert!(w.authorize(&i, common::NOW).is_ok());
}

#[test]
fn denies_a_lease_longer_than_the_grant_wall_time() {
    let mut g = common::grant();
    g.budget.wall_ms = 30_000; // grant says 30s; fixture lease is 60s
    let mut w = common::World::new(g);
    assert_eq!(
        w.authorize(&common::intent(), common::NOW)
            .unwrap_err()
            .reason,
        DenyReason::WallTimeExceedsBudget
    );
}

#[test]
fn denies_when_the_grant_has_expired() {
    let mut g = common::grant();
    g.expires_at_ms = common::NOW + 10_000;
    let mut w = common::World::new(g);
    assert_eq!(
        w.authorize(&common::intent(), common::NOW + 20_000)
            .unwrap_err()
            .reason,
        DenyReason::GrantExpired
    );
}

#[test]
fn denies_when_the_grant_is_revoked_between_calls() {
    // V6-05-05: the grant is re-checked at every privileged call, not only at start.
    let mut w = common::World::default_world();
    let first = w
        .authorize(&common::intent(), common::NOW)
        .expect("first call allowed");
    w.kernel.mark_executed(&first.permit_id).unwrap();

    w.kernel.revoke_grant(&w.grant.grant_id);

    let mut second = common::intent();
    second.intent_id = RefId::parse("int-0002").unwrap();
    assert_eq!(
        w.authorize(&second, common::NOW + 1).unwrap_err().reason,
        DenyReason::GrantRevoked
    );
}

#[test]
fn denies_a_grant_signature_from_an_untrusted_key_at_registration() {
    let mut kernel = PolicyKernel::new();
    let signed = SignedGrant::sign(common::grant(), common::issuer(), &common::rogue_key());
    assert_eq!(
        kernel.register_grant(signed).unwrap_err().reason,
        DenyReason::UnknownIssuer
    );

    // Register the issuer, but with a different key: signature must fail.
    kernel.trust_issuer(common::issuer(), common::key().verifying_key());
    let forged = SignedGrant {
        grant: common::grant(),
        issuer: common::issuer(),
        signature: Signature::from_bytes([0u8; 64]),
    };
    assert_eq!(
        kernel.register_grant(forged).unwrap_err().reason,
        DenyReason::InvalidSignature
    );
}

// ------------------------------------------------------------------ admissions

#[test]
fn enforces_the_concurrency_ceiling_and_frees_the_slot_on_completion() {
    let mut g = common::grant();
    g.budget.concurrency = 1;
    let mut w = common::World::new(g);

    let p1 = w
        .authorize(&common::intent(), common::NOW)
        .expect("first slot");
    let mut i2 = common::intent();
    i2.intent_id = RefId::parse("int-0002").unwrap();
    assert_eq!(
        w.authorize(&i2, common::NOW).unwrap_err().reason,
        DenyReason::ConcurrencyCeiling
    );

    w.kernel.mark_executed(&p1.permit_id).unwrap();
    assert!(w.authorize(&i2, common::NOW + 1).is_ok());
}

#[test]
fn sweeps_expired_reservations_so_a_dead_worker_frees_its_slot() {
    let mut g = common::grant();
    g.budget.concurrency = 1;
    g.budget.wall_ms = 5_000;
    let mut w = common::World::new(g);
    // The lease must fit the grant's wall-time ceiling, so reissue a 5 s lease.
    w.reissue_with_duration(2, 5_000);

    let _held = w
        .authorize(&common::intent(), common::NOW)
        .expect("slot taken");
    let mut i2 = common::intent();
    i2.intent_id = RefId::parse("int-0002").unwrap();
    assert_eq!(
        w.authorize(&i2, common::NOW).unwrap_err().reason,
        DenyReason::ConcurrencyCeiling
    );

    assert_eq!(
        w.kernel.sweep(common::NOW + 5_001),
        1,
        "one stale reservation reaped"
    );

    // The takeover worker needs its own (later) lease; the dead one's slot is gone.
    w.reissue_at(2, common::NOW + 5_001, 5_000);
    assert!(w.authorize(&i2, common::NOW + 5_001).is_ok());
}

// ------------------------------------------------------------- permits & replay

#[test]
fn denies_a_replayed_intent() {
    let mut w = common::World::default_world();
    assert!(w.authorize(&common::intent(), common::NOW).is_ok());
    assert_eq!(
        w.authorize(&common::intent(), common::NOW)
            .unwrap_err()
            .reason,
        DenyReason::Replay
    );

    // Even under a new lease (new epoch): an intent id names one intent, once.
    w.reissue(2);
    assert_eq!(
        w.authorize(&common::intent(), common::NOW)
            .unwrap_err()
            .reason,
        DenyReason::Replay
    );
}

#[test]
fn denies_replay_of_an_idempotency_key_across_leases() {
    // V6-05-06: the external effect can only happen once, however the retry arrives.
    let mut w = external_world();
    assert!(w
        .authorize(&external_intent("int-x1", "idem-x"), common::NOW)
        .is_ok());

    w.reissue(2);
    assert_eq!(
        w.authorize(&external_intent("int-x2", "idem-x"), common::NOW)
            .unwrap_err()
            .reason,
        DenyReason::Replay
    );

    // A different idempotency key under the new lease is a different action: allowed.
    assert!(w
        .authorize(&external_intent("int-x3", "idem-y"), common::NOW)
        .is_ok());
}

#[test]
fn permit_binds_the_exact_intent_and_expires() {
    let mut w = common::World::default_world();
    let intent = common::intent();
    let permit = w.authorize(&intent, common::NOW).expect("allowed");

    w.kernel
        .verify_permit(&permit, &intent, common::NOW + 1)
        .expect("same intent ok");

    let mut changed = intent.clone();
    changed.params_digest = Digest::of(b"{\"url\":\"https://evil.example\"}");
    assert_eq!(
        w.kernel
            .verify_permit(&permit, &changed, common::NOW + 1)
            .unwrap_err(),
        DenyReason::IntentChanged
    );

    assert_eq!(
        w.kernel
            .verify_permit(&permit, &intent, permit.expires_at_ms)
            .unwrap_err(),
        DenyReason::PermitExpired
    );
}

#[test]
fn a_permit_is_executed_at_most_once() {
    let mut w = common::World::default_world();
    let permit = w
        .authorize(&common::intent(), common::NOW)
        .expect("allowed");
    w.kernel.mark_executed(&permit.permit_id).unwrap();
    assert_eq!(
        w.kernel.mark_executed(&permit.permit_id).unwrap_err(),
        DenyReason::Replay
    );
    assert_eq!(
        w.kernel
            .verify_permit(&permit, &common::intent(), common::NOW + 1)
            .unwrap_err(),
        DenyReason::Replay
    );
}

// ------------------------------------------------------------------- approvals

#[test]
fn money_requires_a_human_approval_bound_to_the_exact_arguments() {
    let mut w = money_world();
    let intent = money_intent();

    assert_eq!(
        w.authorize(&intent, common::NOW).unwrap_err().reason,
        DenyReason::ApprovalRequired
    );

    // An approval for different arguments does not authorise these arguments.
    w.kernel
        .approve(approval(
            &intent,
            Digest::of(b"{\"amount_usd\":\"9999.00\"}"),
            RiskTier::Critical,
        ))
        .expect("approval registers");
    assert_eq!(
        w.authorize(&intent, common::NOW).unwrap_err().reason,
        DenyReason::ApprovalInvalid
    );

    // The right one does — once.
    let good = approval(&intent, intent.params_digest, RiskTier::Critical);
    w.kernel.approve(good.clone()).expect("approval registers");
    assert!(w.authorize(&intent, common::NOW).is_ok());
    // Minting a fresh approval id for the same intent cannot resurrect the intent,
    // because the intent itself is one-use.
    assert_eq!(
        w.authorize(&intent, common::NOW).unwrap_err().reason,
        DenyReason::Replay
    );
}

#[test]
fn approval_requires_clearance_at_least_the_risk() {
    let mut w = money_world();
    let intent = money_intent(); // risk = Critical
    let over_reach = SignedApproval::sign(
        approval_record(&intent, intent.params_digest, RiskTier::Critical),
        common::approver_id(),
        &common::approver_key(),
    );
    assert_eq!(
        w.kernel.approve(over_reach).unwrap_err().reason,
        DenyReason::ApprovalInvalid
    );
}

#[test]
fn approval_from_an_untrusted_approver_is_refused() {
    let mut w = money_world();
    let intent = money_intent();
    let forged = SignedApproval::sign(
        ApprovalRecord {
            approval_id: RefId::parse("appr-forged").unwrap(),
            tenant: intent.tenant.clone(),
            sid: intent.sid.clone(),
            intent_id: intent.intent_id.clone(),
            params_digest: intent.params_digest,
            effect: intent.effect,
            max_risk: RiskTier::Critical,
            approved_at_ms: common::NOW,
            expires_at_ms: common::NOW + 60_000,
        },
        common::approver_id(),
        &common::rogue_key(),
    );
    assert_eq!(
        w.kernel.approve(forged).unwrap_err().reason,
        DenyReason::InvalidSignature
    );
}

#[test]
fn critical_risk_needs_approval_even_for_a_write() {
    let mut g = common::grant();
    g.effects.push(EffectClass::Write);
    g.max_risk = RiskTier::Critical;
    g.resources
        .push(ResourcePattern::parse("database:uap.prod.sessions").unwrap());
    let mut w = common::World::new(g);

    let mut i = common::intent();
    i.intent_id = RefId::parse("int-write").unwrap();
    i.effect = EffectClass::Write;
    i.risk = RiskTier::Critical;
    i.target = ResourceScope::parse("database:uap.prod.sessions").unwrap();
    i.idempotency_key = Some(RefId::parse("idem-write").unwrap());

    assert_eq!(
        w.authorize(&i, common::NOW).unwrap_err().reason,
        DenyReason::ApprovalRequired
    );
    w.kernel
        .approve(approval(&i, i.params_digest, RiskTier::Critical))
        .unwrap();
    assert!(w.authorize(&i, common::NOW).is_ok());
}

// --------------------------------------------------------------- advisory model

#[test]
fn an_advisory_allow_cannot_lift_a_denial_and_is_logged() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.target = ResourceScope::parse("file:/etc/passwd").unwrap();
    i.advisory = Some(Advisory {
        model: "policy-suggest-v1".to_string(),
        verdict: AdvisoryVerdict::Allow,
        confidence_bp: 10_000,
    });
    let d = w.authorize(&i, common::NOW).unwrap_err();
    assert_eq!(d.reason, DenyReason::ResourceNotGranted);

    let rec = w.kernel.audit().last().expect("audit record");
    assert_eq!(rec.decision, "deny");
    assert_eq!(rec.reason, Some("resource-not-granted"));
    assert_eq!(
        rec.advisory.as_ref().unwrap().verdict,
        AdvisoryVerdict::Allow
    );
}

#[test]
fn an_advisory_deny_cannot_block_an_allowed_action_and_is_logged() {
    let mut w = common::World::default_world();
    let mut i = common::intent();
    i.advisory = Some(Advisory {
        model: "policy-suggest-v1".to_string(),
        verdict: AdvisoryVerdict::Deny,
        confidence_bp: 9_900,
    });
    assert!(w.authorize(&i, common::NOW).is_ok());
    let rec = w.kernel.audit().last().expect("audit record");
    assert_eq!(rec.decision, "allow");
    assert_eq!(
        rec.advisory.as_ref().unwrap().verdict,
        AdvisoryVerdict::Deny
    );
}

#[test]
fn every_decision_is_audited_with_a_reason_code() {
    let mut w = common::World::default_world();
    let ok = w.authorize(&common::intent(), common::NOW);
    assert!(ok.is_ok());
    let mut bad = common::intent();
    bad.intent_id = RefId::parse("int-bad").unwrap();
    bad.risk = RiskTier::Critical;
    assert!(w.authorize(&bad, common::NOW).is_err());

    let audit = w.kernel.audit();
    assert_eq!(audit.len(), 2);
    assert_eq!(audit[0].decision, "allow");
    assert_eq!(audit[0].reason, None);
    assert_eq!(audit[1].decision, "deny");
    assert_eq!(audit[1].reason, Some("risk-exceeds-grant"));
    assert_eq!(audit[1].seq, 1);
    assert_eq!(audit[1].tenant.as_deref(), Some("acme"));
    assert_eq!(audit[1].effect, Some("read"));
}

// ------------------------------------------------------------------ Vault path

#[test]
fn a_revoked_worker_cannot_read_a_vault_secret() {
    // V6-05-10: the kill applies to every privileged path, not just tool execution.
    // A Vault read is an ordinary intent with a vault_secret target and goes through
    // the same kernel.
    let mut g = common::grant();
    g.resources
        .push(ResourcePattern::parse("vault_secret:tenant/acme/*").unwrap());
    let mut w = common::World::new(g);
    let mut i = common::intent();
    i.intent_id = RefId::parse("int-vault").unwrap();
    i.target = ResourceScope::parse("vault_secret:tenant/acme/openai").unwrap();

    assert!(w.authorize(&i, common::NOW).is_ok());

    let mut i2 = common::intent();
    i2.intent_id = RefId::parse("int-vault-2").unwrap();
    i2.target = ResourceScope::parse("vault_secret:tenant/acme/openai").unwrap();
    w.kernel
        .publish_revocation_version(&RefId::parse("tenant-acme-revocations").unwrap(), 13);
    assert_eq!(
        w.authorize(&i2, common::NOW + 1).unwrap_err().reason,
        DenyReason::LeaseRevoked
    );
}

#[test]
fn the_lease_domain_tag_cannot_be_confused_with_a_grant_payload() {
    // Guards the signature domain constant used by portability fixtures.
    assert_ne!(GRANT_DOMAIN, agentos_policy::lease::LEASE_DOMAIN);
    let w = common::World::default_world();
    assert!(w
        .signed_lease
        .verify(&common::key().verifying_key())
        .is_ok());
    assert!(w
        .signed_lease
        .verify(&SigningKeyPair::from_seed(&[42u8; 32]).verifying_key())
        .is_err());
}
