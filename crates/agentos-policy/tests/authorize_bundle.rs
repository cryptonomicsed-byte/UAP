//! G-24 (V6-07-03): independent policy authorization of model-proposed tool intents.
//!
//! The bridge between a model's tool call and the kernel is a *bundle*: the signed
//! grant, the signed lease, the proposed intent and — when the effect class demands
//! one — a signed human approval. This suite pins the four claims that make the bridge
//! worth having:
//!
//!  1. The kernel's verdict, not the model's, decides. A model that advises "allow" for
//!     an ungranted tool is refused, and one that advises "deny" for a granted tool is
//!     still allowed: the advisory is recorded, never consulted.
//!  2. Every signed object is re-verified on every call: a tampered lease, a foreign
//!     issuer, a changed tool schema or an approval bound to different arguments all
//!     refuse with their *specific* reason code.
//!  3. The wire format is strict: unknown fields, a wrong `v`, or a malformed document
//!     produce `invalid-request` — never a panic and never an allow.
//!  4. The CLI exit codes separate "allowed" from "policy refused" from "the caller sent
//!     garbage", so the caller can fail closed without guessing.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};

use agentos_policy::authorize::{
    approval_fields_json, authorize_bundle, grant_fields_json, intent_fields_json, lease_fields_json,
};
use agentos_policy::approval::{ApprovalRecord, SignedApproval, APPROVAL_DOMAIN};
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::grant::{SignedGrant, GRANT_DOMAIN};
use agentos_policy::ids::{Digest, RefId};
use agentos_policy::intent::{ActionIntent, Advisory, AdvisoryVerdict, INTENT_DOMAIN};
use agentos_policy::lease::{SignedLease, LEASE_DOMAIN};
use agentos_policy::resource::ResourceScope;
use agentos_policy::signature::{IssuerId, Signature};
use serde_json::{json, Value};

const ISSUER: &str = "issuer-acme";

fn issuer_id() -> IssuerId {
    ISSUER.parse().unwrap()
}

fn signed_grant(g: &agentos_policy::grant::Grant) -> SignedGrant {
    SignedGrant::sign(g.clone(), issuer_id(), &common::key())
}

fn signed_lease(g: &agentos_policy::grant::Grant) -> SignedLease {
    SignedLease::sign(common::lease_for(g, 1), issuer_id(), &common::key())
}

fn signed_grant_value(g: &agentos_policy::grant::Grant) -> Value {
    json!({
        "fields": grant_fields_json(g),
        "issuer": ISSUER,
        "signature_hex": signed_grant(g).signature.to_hex(),
    })
}

fn signed_lease_value(g: &agentos_policy::grant::Grant) -> Value {
    json!({
        "fields": lease_fields_json(&common::lease_for(g, 1)),
        "issuer": ISSUER,
        "signature_hex": signed_lease(g).signature.to_hex(),
    })
}

fn approval_for(intent: &ActionIntent, params: Digest) -> SignedApproval {
    let record = ApprovalRecord {
        approval_id: RefId::parse(&format!("appr-{}", &params.to_hex()[..8])).unwrap(),
        tenant: intent.tenant.clone(),
        sid: intent.sid.clone(),
        intent_id: intent.intent_id.clone(),
        params_digest: params,
        effect: intent.effect,
        max_risk: intent.risk,
        approved_at_ms: common::NOW - 5_000,
        expires_at_ms: common::NOW + 300_000,
    };
    // Critical risk needs a critical-clearance human: the same rule the kernel applies,
    // so this fixture cannot accidentally test an approver who is not allowed to say yes.
    SignedApproval::sign(
        record,
        common::critical_approver_id(),
        &common::critical_approver_key(),
    )
}

fn approval_value(a: &SignedApproval) -> Value {
    json!({
        "fields": approval_fields_json(&a.record),
        "approver": common::critical_approver_id().as_str(),
        "signature_hex": a.signature.to_hex(),
    })
}

/// A complete, strict bundle. `include_approval` decides whether the (optional) signed
/// human approval travels with it.
fn bundle(grant_json: Value, lease_json: Value, intent: &ActionIntent, approval: Option<Value>) -> Value {
    let mut trust = json!({
        "issuers": [{ "id": ISSUER, "public_key_hex": common::key().public_key_hex() }],
    });
    trust["approvers"] = json!([
        {
            "id": common::approver_id().as_str(),
            "public_key_hex": common::approver_key().public_key_hex(),
            "clearance": "high",
        },
        {
            "id": common::critical_approver_id().as_str(),
            "public_key_hex": common::critical_approver_key().public_key_hex(),
            "clearance": "critical",
        },
    ]);
    let mut b = json!({
        "v": "uap-authorize/1",
        "now_ms": common::NOW,
        "trust": trust,
        "revocations": [{ "list": "tenant-acme-revocations", "version": 12 }],
        "grant": grant_json,
        "lease": lease_json,
        "intent": intent_fields_json(intent),
    });
    if let Some(a) = approval {
        b["approval"] = a;
    }
    b
}

fn run(bundle: &Value) -> Value {
    let text = authorize_bundle(&serde_json::to_string(bundle).unwrap()).expect("bundle parses");
    serde_json::from_str(&text).expect("decision is JSON")
}

fn default_bundle(intent: &ActionIntent) -> Value {
    let g = common::grant();
    bundle(
        signed_grant_value(&g),
        signed_lease_value(&g),
        intent,
        None,
    )
}

// ------------------------------------------------------------------ allow path

#[test]
fn a_granted_read_with_a_valid_lease_and_grant_is_allowed() {
    let d = run(&default_bundle(&common::intent()));
    assert_eq!(d["allowed"], json!(true), "decision: {d}");
    assert_eq!(d["code"], json!("allow"));
    assert_eq!(d["audit_seq"], json!(0));
    assert_eq!(d["intent_digest"], json!(common::intent().digest().to_hex()));
    // The permit names the exact intent; the executor can re-check it.
    assert_eq!(d["permit"]["intent_id"], json!("int-0001"));
    assert_eq!(d["permit"]["effect"], json!("read"));
}

// --------------------------------------------------- the model has no authority

#[test]
fn a_models_allow_verdict_cannot_grant_an_ungranted_tool() {
    let g = common::grant();
    let mut intent = common::intent();
    intent.tool = agentos_policy::ids::ToolName::parse("shell.exec").unwrap();
    intent.advisory = Some(Advisory {
        model: "frontier-1".to_string(),
        verdict: AdvisoryVerdict::Allow,
        confidence_bp: 9_900,
    });
    let d = run(&bundle(
        signed_grant_value(&g),
        signed_lease_value(&g),
        &intent,
        None,
    ));
    assert_eq!(d["allowed"], json!(false), "decision: {d}");
    assert_eq!(d["code"], json!("tool-not-granted"));
}

#[test]
fn a_models_deny_verdict_cannot_block_a_granted_tool_and_is_still_recorded() {
    let g = common::grant();
    let mut intent = common::intent();
    intent.advisory = Some(Advisory {
        model: "frontier-1".to_string(),
        verdict: AdvisoryVerdict::Deny,
        confidence_bp: 10_000,
    });
    let d = run(&bundle(
        signed_grant_value(&g),
        signed_lease_value(&g),
        &intent,
        None,
    ));
    assert_eq!(d["allowed"], json!(true), "decision: {d}");
    assert_eq!(d["advisory"]["verdict"], json!("deny"));
}

// ------------------------------------------------------- signature / binding checks

#[test]
fn a_tampered_lease_signature_is_refused_as_invalid_signature() {
    let g = common::grant();
    let mut lease = signed_lease_value(&g);
    lease["signature_hex"] = json!(Signature::from_bytes([3u8; 64]).to_hex());
    let d = run(&bundle(
        signed_grant_value(&g),
        lease,
        &common::intent(),
        None,
    ));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("invalid-signature"));
}

#[test]
fn an_issuer_the_bundle_does_not_trust_is_refused() {
    let g = common::grant();
    let mut b = default_bundle(&common::intent());
    b["trust"]["issuers"] = json!([]);
    b["grant"] = signed_grant_value(&g);
    b["lease"] = signed_lease_value(&g);
    let d = run(&b);
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("unknown-issuer"));
}

#[test]
fn an_intent_from_another_role_is_refused_as_role_mismatch() {
    let mut intent = common::intent();
    intent.role_digest = Digest::of(b"role:security@9");
    let d = run(&default_bundle(&intent));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("role-mismatch"));
}

#[test]
fn a_tool_whose_schema_changed_after_the_grant_is_refused() {
    let mut intent = common::intent();
    intent.tool_schema_digest = Digest::of(b"schema:browser.open_url@4");
    let d = run(&default_bundle(&intent));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("tool-schema-changed"));
}

#[test]
fn an_expired_intent_is_refused_before_execution() {
    let mut intent = common::intent();
    intent.issued_at_ms = common::NOW - 60_000;
    intent.expires_at_ms = common::NOW - 1;
    let d = run(&default_bundle(&intent));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("intent-expired"));
}

// --------------------------------------------------------------- human approval

fn money_world() -> (agentos_policy::grant::Grant, ActionIntent) {
    let mut g = common::grant();
    g.effects.push(EffectClass::Money);
    g.max_risk = RiskTier::Critical;
    g.resources.push(
        agentos_policy::resource::ResourcePattern::parse("cloud_account:aws:123456789012").unwrap(),
    );
    let mut intent = common::intent();
    intent.intent_id = RefId::parse("int-money-1").unwrap();
    intent.effect = EffectClass::Money;
    intent.risk = RiskTier::Critical;
    intent.target = ResourceScope::parse("cloud_account:aws:123456789012").unwrap();
    intent.idempotency_key = Some(RefId::parse("idem-money-1").unwrap());
    intent.params_digest = Digest::of(b"{\"amount_usd\":\"12.50\"}");
    (g, intent)
}

#[test]
fn a_money_effect_without_a_human_approval_is_refused() {
    let (g, intent) = money_world();
    let d = run(&bundle(
        signed_grant_value(&g),
        signed_lease_value(&g),
        &intent,
        None,
    ));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("approval-required"));
}

#[test]
fn an_approval_bound_to_other_arguments_cannot_authorize_the_money_intent() {
    let (g, intent) = money_world();
    let wrong = approval_for(&intent, Digest::of(b"{\"amount_usd\":\"9999.00\"}"));
    let d = run(&bundle(
        signed_grant_value(&g),
        signed_lease_value(&g),
        &intent,
        Some(approval_value(&wrong)),
    ));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("approval-invalid"));
}

#[test]
fn an_approval_of_the_exact_arguments_allows_the_money_intent() {
    let (g, intent) = money_world();
    let ok = approval_for(&intent, intent.params_digest);
    let d = run(&bundle(
        signed_grant_value(&g),
        signed_lease_value(&g),
        &intent,
        Some(approval_value(&ok)),
    ));
    assert_eq!(d["allowed"], json!(true), "decision: {d}");
    assert_eq!(d["permit"]["effect"], json!("money"));
}

#[test]
fn a_money_effect_is_refused_when_the_grant_does_not_confer_it() {
    let (_, intent) = money_world();
    let d = run(&default_bundle(&intent));
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("effect-not-granted"));
}

// --------------------------------------------------------------- strict wire format

#[test]
fn an_unknown_field_anywhere_in_the_bundle_is_invalid_request() {
    let mut b = default_bundle(&common::intent());
    b["intent"]["model_says_ok"] = json!(true);
    let text = authorize_bundle(&serde_json::to_string(&b).unwrap()).unwrap();
    let d: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("invalid-request"));
    assert!(d["detail"].as_str().unwrap().contains("unknown field"), "{d}");
}

#[test]
fn a_wrong_wire_version_is_invalid_request() {
    let mut b = default_bundle(&common::intent());
    b["v"] = json!("uap-authorize/2");
    let d: Value =
        serde_json::from_str(&authorize_bundle(&serde_json::to_string(&b).unwrap()).unwrap())
            .unwrap();
    assert_eq!(d["code"], json!("invalid-request"));
}

#[test]
fn a_document_missing_its_lease_cannot_be_authorized() {
    let mut b = default_bundle(&common::intent());
    b.as_object_mut().unwrap().remove("lease");
    let d: Value =
        serde_json::from_str(&authorize_bundle(&serde_json::to_string(&b).unwrap()).unwrap())
            .unwrap();
    assert_eq!(d["code"], json!("invalid-request"));
}

#[test]
fn non_json_input_is_invalid_request_not_a_panic() {
    let d: Value = serde_json::from_str(&authorize_bundle("not json at all").unwrap()).unwrap();
    assert_eq!(d["code"], json!("invalid-request"));
}

// ------------------------------------------------------------------- canonical pin

#[test]
fn the_wire_fields_rebuild_the_exact_canonical_documents() {
    let g = common::grant();
    assert_eq!(grant_fields_json(&g).as_object().unwrap()["v"], json!(GRANT_DOMAIN));
    assert_eq!(
        lease_fields_json(&common::lease_for(&g, 1)).as_object().unwrap()["v"],
        json!(LEASE_DOMAIN)
    );
    assert_eq!(
        intent_fields_json(&common::intent()).as_object().unwrap()["v"],
        json!(INTENT_DOMAIN)
    );
    let intent = common::intent();
    let a = approval_for(&intent, intent.params_digest);
    assert_eq!(
        approval_fields_json(&a.record).as_object().unwrap()["v"],
        json!(APPROVAL_DOMAIN)
    );
}

// --------------------------------------------------------------------------- CLI

fn run_cli(input: &str) -> (i32, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_authorize"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("authorize binary runs");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
    )
}

#[test]
fn the_cli_exits_zero_on_allow_and_ten_on_a_policy_refusal() {
    let allow = serde_json::to_string(&default_bundle(&common::intent())).unwrap();
    let (code, stdout) = run_cli(&allow);
    assert_eq!(code, 0, "stdout: {stdout}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap()["allowed"],
        json!(true)
    );

    let mut denied = default_bundle(&common::intent());
    denied["intent"]["tool"] = json!("shell.exec");
    let (code, stdout) = run_cli(&serde_json::to_string(&denied).unwrap());
    assert_eq!(code, 10, "stdout: {stdout}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap()["code"],
        json!("tool-not-granted")
    );
}

#[test]
fn the_cli_exits_twenty_on_unparseable_input_and_still_prints_a_decision() {
    let (code, stdout) = run_cli("{oops");
    assert_eq!(code, 20);
    let d: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("invalid-request"));
}

// -------------------------------------------------------------------------- mint

#[test]
fn minting_a_grant_from_a_seed_produces_a_document_the_kernel_accepts() {
    let g = common::grant();
    let seed = [7u8; 32];
    let minted = agentos_policy::authorize::mint_json(&json!({
        "v": "uap-mint/1",
        "kind": "grant",
        "issuer": ISSUER,
        "seed_hex": hex32(&seed),
        "fields": grant_fields_json(&g),
    })
    .to_string())
    .expect("mint succeeds");
    let m: Value = serde_json::from_str(&minted).unwrap();
    assert_eq!(m["public_key_hex"], json!(common::key().public_key_hex()));
    assert_eq!(m["fields"], grant_fields_json(&g));

    // The signature the minter produced verifies under a bundle whose trust anchor is
    // the same public key.
    let mut b = default_bundle(&common::intent());
    b["grant"] = json!({
        "fields": m["fields"],
        "issuer": ISSUER,
        "signature_hex": m["signature_hex"],
    });
    let d = run(&b);
    assert_eq!(d["allowed"], json!(true), "decision: {d}");
}

#[test]
fn minting_refuses_a_field_set_the_domain_type_rejects() {
    let mut fields = grant_fields_json(&common::grant());
    fields["effects"] = json!([]); // a grant with no effect class can never be valid
    let err = agentos_policy::authorize::mint_json(&json!({
        "v": "uap-mint/1",
        "kind": "grant",
        "issuer": ISSUER,
        "seed_hex": hex32(&[7u8; 32]),
        "fields": fields,
    })
    .to_string())
    .unwrap_err();
    assert!(err.contains("invalid-grant"), "{err}");
}

#[test]
fn a_lease_signed_with_a_different_seed_verifies_against_its_own_key_only() {
    // Mint a lease with a rogue seed, then present it in a bundle that trusts the
    // canonical issuer key: the signature must fail, because the bundle's trust anchor
    // is not whatever key the caller happened to use.
    let g = common::grant();
    let rogue = [9u8; 32];
    let minted = agentos_policy::authorize::mint_json(&json!({
        "v": "uap-mint/1",
        "kind": "lease",
        "issuer": ISSUER,
        "seed_hex": hex32(&rogue),
        "fields": lease_fields_json(&common::lease_for(&g, 1)),
    })
    .to_string())
    .unwrap();
    let m: Value = serde_json::from_str(&minted).unwrap();
    let mut b = default_bundle(&common::intent());
    b["lease"] = json!({
        "fields": m["fields"],
        "issuer": ISSUER,
        "signature_hex": m["signature_hex"],
    });
    let d = run(&b);
    assert_eq!(d["allowed"], json!(false));
    assert_eq!(d["code"], json!("invalid-signature"));
}

fn hex32(seed: &[u8; 32]) -> String {
    seed.iter().map(|b| format!("{b:02x}")).collect()
}
