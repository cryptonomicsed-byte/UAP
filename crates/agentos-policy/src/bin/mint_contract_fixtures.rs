//! H-27: regenerate the committed cross-language contract fixtures.
//!
//! Usage: `mint-contract-fixtures [output-root]`
//! (default `contracts/v1/fixtures`). The output is deterministic: the signing key is
//! the published fixture seed `[7u8; 32]`, no clock is read and every digest comes
//! from a fixed string — so `git status` after a run is the drift check, and the test
//! `the_fixture_minter_is_deterministic_and_matches_what_is_committed` enforces it.
//!
//! Each case directory carries:
//!
//! | File | Meaning |
//! |---|---|
//! | `fields.json` | the document fields, strict schema (unknown keys are an error) |
//! | `canonical.txt` | the exact canonical bytes (no trailing newline) |
//! | `canonical.sha256` | SHA-256 of those bytes |
//! | `sig.hex` | Ed25519 over `domain\n<canonical>` (signed documents only) |
//! | `issuer.pub.hex` | the key a verifier must trust (signed documents only) |
//! | `expect.txt` | `valid` or `invalid` |
//! | `reason.txt` | for invalid cases: the token a refusal must mention |
//!
//! The invalid cases cover the three ways a second implementation goes wrong: a
//! re-canonicalised field edit (signature must catch it), a corrupted signature, and
//! lenient JSON that accepts a field the kernel never emits.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{json, Value};

use agentos_policy::approval::{ApprovalRecord, SignedApproval};
use agentos_policy::authorize::{approval_fields_json, grant_fields_json, intent_fields_json};
use agentos_policy::budget::{Budget, Spend};
use agentos_policy::effect::{EffectClass, RiskTier};
use agentos_policy::grant::{Grant, SignedGrant, ToolGrant};
use agentos_policy::ids::{Digest, RefId, Sid, TenantId, ToolName};
use agentos_policy::intent::{ActionIntent, Advisory, AdvisoryVerdict};
use agentos_policy::resource::ResourceScope;
use agentos_policy::signature::SigningKeyPair;

/// Published fixture key. Not a secret: it only ever signs test vectors.
const FIXTURE_SEED: [u8; 32] = [7u8; 32];
const ISSUER: &str = "acme-issuer";
const APPROVER: &str = "acme-approver";

fn tenant() -> TenantId {
    TenantId::parse("acme").expect("fixture tenant")
}

fn sid() -> Sid {
    Sid::parse("sid_0a1b2c3d").expect("fixture sid")
}

fn spend() -> Spend {
    Spend {
        cpu_ms: 120_000,
        ram_mib: 512,
        gpu_ms: 0,
        cloud_micros: 250_000,
        events: 50,
    }
}

fn grant() -> Grant {
    Grant {
        grant_id: RefId::parse("grant-0001").expect("grant id"),
        tenant: tenant(),
        sid: sid(),
        effects: vec![EffectClass::Read, EffectClass::Compute],
        resources: vec![
            agentos_policy::resource::ResourcePattern::parse("repo:acme/*")
                .expect("resource pattern"),
        ],
        tools: vec![ToolGrant {
            tool: ToolName::parse("repo.read").expect("tool"),
            schema_digest: Digest::of(b"tool:repo.read@1"),
        }],
        max_risk: RiskTier::Medium,
        budget: Budget {
            concurrency: 2,
            wall_ms: 600_000,
            spend: spend(),
        },
        issued_at_ms: 1_700_000_000_000,
        expires_at_ms: 1_700_086_400_000,
        epoch: 3,
    }
}

fn approval() -> ApprovalRecord {
    ApprovalRecord {
        approval_id: RefId::parse("approval-0001").expect("approval id"),
        tenant: tenant(),
        sid: sid(),
        intent_id: RefId::parse("intent-0001").expect("intent id"),
        params_digest: Digest::of(b"args:{\"repo\":\"acme/site\"}"),
        effect: EffectClass::Publish,
        max_risk: RiskTier::High,
        approved_at_ms: 1_700_000_000_000,
        expires_at_ms: 1_700_000_600_000,
    }
}

fn intent_read() -> ActionIntent {
    ActionIntent {
        intent_id: RefId::parse("intent-0001").expect("intent id"),
        tenant: tenant(),
        sid: sid(),
        task_id: RefId::parse("task-0001").expect("task id"),
        role_digest: Digest::of(b"role:frontend@1"),
        tool: ToolName::parse("repo.read").expect("tool"),
        tool_schema_digest: Digest::of(b"tool:repo.read@1"),
        effect: EffectClass::Read,
        risk: RiskTier::Low,
        target: ResourceScope::parse("repo:acme/site").expect("scope"),
        params_digest: Digest::of(b"args:{\"repo\":\"acme/site\"}"),
        idempotency_key: None,
        spend: Spend::zero(),
        issued_at_ms: 1_700_000_000_000,
        expires_at_ms: 1_700_000_060_000,
        advisory: Some(Advisory {
            model: "local:qwen2.5-7b".to_string(),
            verdict: AdvisoryVerdict::Allow,
            confidence_bp: 8_800,
        }),
    }
}

/// An external effect with no idempotency key: well-formed JSON, invalid intent.
fn intent_missing_idempotency() -> ActionIntent {
    ActionIntent {
        intent_id: RefId::parse("intent-0002").expect("intent id"),
        tool: ToolName::parse("mail.send").expect("tool"),
        tool_schema_digest: Digest::of(b"tool:mail.send@1"),
        effect: EffectClass::ExternalMessage,
        risk: RiskTier::Medium,
        target: ResourceScope::parse("http_origin:https://api.example.com").expect("scope"),
        params_digest: Digest::of(b"args:{\"to\":\"ops@acme.test\"}"),
        advisory: None,
        ..intent_read()
    }
}

/// A third valid intent shape: no advisory, so `advisory` is `null` on the wire.
fn intent_no_advisory() -> ActionIntent {
    ActionIntent {
        intent_id: RefId::parse("intent-0003").expect("intent id"),
        advisory: None,
        ..intent_read()
    }
}

fn write_case(
    root: &Path,
    contract: &str,
    case: &str,
    files: &[(&str, String)],
) -> std::io::Result<()> {
    let dir = root.join(contract).join(case);
    fs::create_dir_all(&dir)?;
    for (name, body) in files {
        fs::write(dir.join(name), body)?;
    }
    Ok(())
}

fn pretty(v: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(v).expect("serialize fields")
    )
}

fn sha_line(text: &str) -> String {
    format!("{}\n", Digest::of(text.as_bytes()).to_hex())
}

fn main() -> ExitCode {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("contracts/v1/fixtures"));
    let key = SigningKeyPair::from_seed(&FIXTURE_SEED);
    let public_key = key.public_key_hex();
    let issuer: agentos_policy::signature::IssuerId = ISSUER.parse().expect("issuer id");
    let approver: agentos_policy::signature::IssuerId = APPROVER.parse().expect("approver id");

    // ---- grant ------------------------------------------------------------
    let grant = grant();
    let signed = SignedGrant::sign(grant.clone(), issuer.clone(), &key);
    let grant_canonical = grant.canonical_json();
    if let Err(e) = write_case(
        &root,
        "grant",
        "grant-0001",
        &[
            ("fields.json", pretty(&grant_fields_json(&grant))),
            ("canonical.txt", grant_canonical.clone()),
            ("canonical.sha256", sha_line(&grant_canonical)),
            ("sig.hex", format!("{}\n", signed.signature.to_hex())),
            ("issuer.pub.hex", format!("{public_key}\n")),
            ("expect.txt", "valid\n".to_string()),
        ],
    ) {
        eprintln!("mint-contract-fixtures: {e}");
        return ExitCode::FAILURE;
    }

    // Tampered: the attacker re-canonicalises a raised budget ceiling and replays the
    // original signature. Only the signature can catch this.
    let mut tampered = grant.clone();
    tampered.budget.spend.cloud_micros = 25_000_000;
    let tampered_canonical = tampered.canonical_json();
    if let Err(e) = write_case(
        &root,
        "grant",
        "grant-0002-tampered",
        &[
            ("fields.json", pretty(&grant_fields_json(&tampered))),
            ("canonical.txt", tampered_canonical.clone()),
            ("canonical.sha256", sha_line(&tampered_canonical)),
            ("sig.hex", format!("{}\n", signed.signature.to_hex())),
            ("issuer.pub.hex", format!("{public_key}\n")),
            ("expect.txt", "invalid\n".to_string()),
            ("reason.txt", "signature\n".to_string()),
        ],
    ) {
        eprintln!("mint-contract-fixtures: {e}");
        return ExitCode::FAILURE;
    }

    // Lenient JSON: a note field the kernel never emits must be refused by schema.
    let mut with_note = grant_fields_json(&grant);
    with_note["note"] = json!("added by a client that ignored the schema");
    if let Err(e) = write_case(
        &root,
        "grant",
        "grant-0003-unknown-field",
        &[
            ("fields.json", pretty(&with_note)),
            ("canonical.txt", grant_canonical.clone()),
            ("canonical.sha256", sha_line(&grant_canonical)),
            ("sig.hex", format!("{}\n", signed.signature.to_hex())),
            ("issuer.pub.hex", format!("{public_key}\n")),
            ("expect.txt", "invalid\n".to_string()),
            ("reason.txt", "unknown field\n".to_string()),
        ],
    ) {
        eprintln!("mint-contract-fixtures: {e}");
        return ExitCode::FAILURE;
    }

    // ---- approval ---------------------------------------------------------
    let record = approval();
    let signed_approval = SignedApproval::sign(record.clone(), approver, &key);
    let approval_canonical = record.canonical_json();
    if let Err(e) = write_case(
        &root,
        "approval",
        "approval-0001",
        &[
            ("fields.json", pretty(&approval_fields_json(&record))),
            ("canonical.txt", approval_canonical.clone()),
            ("canonical.sha256", sha_line(&approval_canonical)),
            (
                "sig.hex",
                format!("{}\n", signed_approval.signature.to_hex()),
            ),
            ("issuer.pub.hex", format!("{public_key}\n")),
            ("expect.txt", "valid\n".to_string()),
        ],
    ) {
        eprintln!("mint-contract-fixtures: {e}");
        return ExitCode::FAILURE;
    }
    let mut approval_note = approval_fields_json(&record);
    approval_note["approved_by"] = json!("a human, allegedly");
    if let Err(e) = write_case(
        &root,
        "approval",
        "approval-0002-unknown-field",
        &[
            ("fields.json", pretty(&approval_note)),
            ("canonical.txt", approval_canonical.clone()),
            ("canonical.sha256", sha_line(&approval_canonical)),
            (
                "sig.hex",
                format!("{}\n", signed_approval.signature.to_hex()),
            ),
            ("issuer.pub.hex", format!("{public_key}\n")),
            ("expect.txt", "invalid\n".to_string()),
            ("reason.txt", "unknown field\n".to_string()),
        ],
    ) {
        eprintln!("mint-contract-fixtures: {e}");
        return ExitCode::FAILURE;
    }

    // ---- intent -----------------------------------------------------------
    for (case, intent, expect, reason) in [
        ("intent-0001", intent_read(), "valid", None),
        (
            "intent-0002-missing-idempotency",
            intent_missing_idempotency(),
            "invalid",
            Some("idempotency key"),
        ),
        (
            "intent-0003-no-advisory",
            intent_no_advisory(),
            "valid",
            None,
        ),
    ] {
        let canonical = intent.canonical_json();
        let mut files = vec![
            ("fields.json", pretty(&intent_fields_json(&intent))),
            ("canonical.txt", canonical.clone()),
            ("canonical.sha256", sha_line(&canonical)),
            ("expect.txt", format!("{expect}\n")),
        ];
        if let Some(reason) = reason {
            files.push(("reason.txt", format!("{reason}\n")));
        }
        if let Err(e) = write_case(&root, "intent", case, &files) {
            eprintln!("mint-contract-fixtures: {e}");
            return ExitCode::FAILURE;
        }
    }

    eprintln!(
        "mint-contract-fixtures: wrote fixtures under {}",
        root.display()
    );
    ExitCode::SUCCESS
}
