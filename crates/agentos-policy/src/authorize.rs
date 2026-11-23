//! The authorization bridge: one bundle in, one decision out (V6-07-03).
//!
//! A model proposes a tool call. That proposal is not an authority and must not become
//! one by being convenient: the caller builds an [`crate::intent::ActionIntent`] from
//! *its own* tool registry (effect class, risk, target, argument digest, schema digest),
//! pairs it with the signed grant and the signed task lease, and asks this module —
//! which is the kernel and nothing else — for a verdict.
//!
//! ## Why a bundle and not an FFI call
//!
//! The decision has to be reachable from a runtime that is not Rust (the app's TS
//! server, a Go sidecar, an operator's shell) without re-implementing the canonical
//! encodings four times. The bundle is the lowest common denominator: strict JSON in,
//! strict JSON out, and the process exit code separates *allowed* from *policy refused*
//! from *you sent garbage* so a caller can fail closed without parsing prose.
//!
//! ## What the bundle carries
//!
//! | Key | Meaning |
//! |---|---|
//! | `v` | `uap-authorize/1` — a different version is a refusal, never a guess |
//! | `now_ms` | the clock, passed in (the kernel never reads one) |
//! | `trust` | issuer keys and human-approver keys this call is allowed to trust |
//! | `revocations` | published revocation-list versions, highest wins |
//! | `grant`/`lease`/`approval` | `{fields, issuer|approver, signature_hex}` |
//! | `intent` | the proposed action, in the intent canonical schema |
//!
//! Every `fields` object is parsed with `deny_unknown_fields`: a field the contract
//! does not define is `invalid-request`, because a kernel that silently ignores part of
//! a grant is a kernel whose verdict cannot be explained afterwards.

use std::str::FromStr;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::approval::{ApprovalRecord, SignedApproval};
use crate::budget::{Budget, Spend};
use crate::effect::{EffectClass, RiskTier};
use crate::grant::{Grant, SignedGrant, ToolGrant, GRANT_DOMAIN};
use crate::ids::{Digest, RefId, Sid, TenantId, ToolName};
use crate::intent::{ActionIntent, Advisory, AdvisoryVerdict};
use crate::kernel::PolicyKernel;
use crate::lease::{SignedLease, TaskLease};
use crate::resource::{ResourcePattern, ResourceScope};
use crate::signature::{verifying_key_from_hex, IssuerId, Signature, SigningKeyPair};

/// Wire version of the authorization bundle.
pub const AUTHORIZE_DOMAIN: &str = "uap-authorize/1";
/// Wire version of the minting request.
pub const MINT_DOMAIN: &str = "uap-mint/1";

/// Exit code: the kernel allowed the intent (a one-use permit is in the answer).
pub const EXIT_ALLOW: i32 = 0;
/// Exit code: the kernel refused; the answer names the stable reason code.
pub const EXIT_DENY: i32 = 10;
/// Exit code: the caller's document was malformed; nothing was decided.
pub const EXIT_INVALID: i32 = 20;

// ------------------------------------------------------------------ raw schema

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBundle {
    v: String,
    now_ms: u64,
    trust: RawTrust,
    #[serde(default)]
    revocations: Vec<RawRevocationVersion>,
    grant: RawSigned,
    lease: RawSigned,
    intent: Value,
    #[serde(default)]
    approval: Option<RawSignedApproval>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTrust {
    #[serde(default)]
    issuers: Vec<RawIssuerKey>,
    #[serde(default)]
    approvers: Vec<RawApproverKey>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawIssuerKey {
    id: String,
    public_key_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawApproverKey {
    id: String,
    public_key_hex: String,
    clearance: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRevocationVersion {
    list: String,
    version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSigned {
    fields: Value,
    issuer: String,
    signature_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignedApproval {
    fields: Value,
    approver: String,
    signature_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGrantFields {
    v: String,
    grant_id: String,
    tenant: String,
    sid: String,
    effects: Vec<String>,
    resources: Vec<String>,
    tools: Vec<RawToolGrant>,
    max_risk: String,
    budget: RawBudget,
    issued_at_ms: u64,
    expires_at_ms: u64,
    epoch: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawToolGrant {
    tool: String,
    schema: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBudget {
    concurrency: u64,
    wall_ms: u64,
    spend: RawSpend,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSpend {
    cpu_ms: u64,
    ram_mib: u64,
    gpu_ms: u64,
    cloud_micros: u64,
    events: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawIntent {
    v: String,
    intent_id: String,
    tenant: String,
    sid: String,
    task_id: String,
    role_digest: String,
    tool: String,
    tool_schema: String,
    effect: String,
    risk: String,
    target: String,
    params: String,
    idempotency: Option<String>,
    spend: RawSpend,
    issued_at_ms: u64,
    expires_at_ms: u64,
    advisory: Option<RawAdvisory>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAdvisory {
    model: String,
    verdict: String,
    confidence_bp: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawApprovalFields {
    v: String,
    approval_id: String,
    tenant: String,
    sid: String,
    intent_id: String,
    params: String,
    effect: String,
    max_risk: String,
    approved_at_ms: u64,
    expires_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMint {
    v: String,
    kind: String,
    issuer: String,
    seed_hex: String,
    fields: Value,
}

// ------------------------------------------------------------ typed conversions

fn field<T>(what: &str, v: Result<T, impl core::fmt::Display>) -> Result<T, String> {
    v.map_err(|e| format!("{what}: {e}"))
}

fn effect(s: &str) -> Result<EffectClass, String> {
    EffectClass::parse(s).ok_or_else(|| format!("unknown effect class {s:?}"))
}

fn risk(s: &str) -> Result<RiskTier, String> {
    RiskTier::parse(s).ok_or_else(|| format!("unknown risk tier {s:?}"))
}

fn spend(s: &RawSpend) -> Spend {
    Spend {
        cpu_ms: s.cpu_ms,
        ram_mib: s.ram_mib,
        gpu_ms: s.gpu_ms,
        cloud_micros: s.cloud_micros,
        events: s.events,
    }
}

impl RawGrantFields {
    fn typed(&self) -> Result<Grant, String> {
        if self.v != GRANT_DOMAIN {
            return Err(format!("grant v is {:?}", self.v));
        }
        let mut effects = Vec::new();
        for e in &self.effects {
            effects.push(effect(e)?);
        }
        let mut resources = Vec::new();
        for r in &self.resources {
            resources.push(field("resource", ResourcePattern::parse(r))?);
        }
        let mut tools = Vec::new();
        for t in &self.tools {
            tools.push(ToolGrant {
                tool: field("tool", ToolName::parse(&t.tool))?,
                schema_digest: field("schema", Digest::parse_hex(&t.schema))?,
            });
        }
        Ok(Grant {
            grant_id: field("grant_id", RefId::parse(&self.grant_id))?,
            tenant: field("tenant", TenantId::parse(&self.tenant))?,
            sid: field("sid", Sid::parse(&self.sid))?,
            effects,
            resources,
            tools,
            max_risk: risk(&self.max_risk)?,
            budget: Budget {
                concurrency: u32::try_from(self.budget.concurrency)
                    .map_err(|_| "budget.concurrency exceeds u32".to_string())?,
                wall_ms: self.budget.wall_ms,
                spend: spend(&self.budget.spend),
            },
            issued_at_ms: self.issued_at_ms,
            expires_at_ms: self.expires_at_ms,
            epoch: self.epoch,
        })
    }
}

impl RawIntent {
    fn typed(&self) -> Result<ActionIntent, String> {
        if self.v != crate::intent::INTENT_DOMAIN {
            return Err(format!("intent v is {:?}", self.v));
        }
        let advisory = match &self.advisory {
            None => None,
            Some(a) => Some(Advisory {
                model: a.model.clone(),
                verdict: AdvisoryVerdict::parse(&a.verdict)
                    .ok_or_else(|| format!("unknown advisory verdict {:?}", a.verdict))?,
                confidence_bp: u16::try_from(a.confidence_bp)
                    .map_err(|_| "advisory confidence exceeds u16".to_string())?,
            }),
        };
        Ok(ActionIntent {
            intent_id: field("intent_id", RefId::parse(&self.intent_id))?,
            tenant: field("tenant", TenantId::parse(&self.tenant))?,
            sid: field("sid", Sid::parse(&self.sid))?,
            task_id: field("task_id", RefId::parse(&self.task_id))?,
            role_digest: field("role_digest", Digest::parse_hex(&self.role_digest))?,
            tool: field("tool", ToolName::parse(&self.tool))?,
            tool_schema_digest: field("tool_schema", Digest::parse_hex(&self.tool_schema))?,
            effect: effect(&self.effect)?,
            risk: risk(&self.risk)?,
            target: field("target", ResourceScope::parse(&self.target))?,
            params_digest: field("params", Digest::parse_hex(&self.params))?,
            idempotency_key: match &self.idempotency {
                None => None,
                Some(k) => Some(field("idempotency", RefId::parse(k))?),
            },
            spend: spend(&self.spend),
            issued_at_ms: self.issued_at_ms,
            expires_at_ms: self.expires_at_ms,
            advisory,
        })
    }
}

impl RawApprovalFields {
    fn typed(&self) -> Result<ApprovalRecord, String> {
        if self.v != crate::approval::APPROVAL_DOMAIN {
            return Err(format!("approval v is {:?}", self.v));
        }
        Ok(ApprovalRecord {
            approval_id: field("approval_id", RefId::parse(&self.approval_id))?,
            tenant: field("tenant", TenantId::parse(&self.tenant))?,
            sid: field("sid", Sid::parse(&self.sid))?,
            intent_id: field("intent_id", RefId::parse(&self.intent_id))?,
            params_digest: field("params", Digest::parse_hex(&self.params))?,
            effect: effect(&self.effect)?,
            max_risk: risk(&self.max_risk)?,
            approved_at_ms: self.approved_at_ms,
            expires_at_ms: self.expires_at_ms,
        })
    }
}

// ---------------------------------------------------------------- field encoders

/// The grant `fields` document, in the exact schema [`RawGrantFields`] parses. Kept
/// beside the parser so the two cannot drift; `mint` and every caller share it.
pub fn grant_fields_json(g: &Grant) -> Value {
    json!({
        "v": GRANT_DOMAIN,
        "grant_id": g.grant_id.as_str(),
        "tenant": g.tenant.as_str(),
        "sid": g.sid.as_str(),
        "effects": g.effects.iter().map(|e| e.as_str()).collect::<Vec<_>>(),
        "resources": g.resources.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "tools": g.tools.iter().map(|t| json!({
            "tool": t.tool.as_str(),
            "schema": t.schema_digest.to_hex(),
        })).collect::<Vec<_>>(),
        "max_risk": g.max_risk.as_str(),
        "budget": {
            "concurrency": g.budget.concurrency,
            "wall_ms": g.budget.wall_ms,
            "spend": spend_json(&g.budget.spend),
        },
        "issued_at_ms": g.issued_at_ms,
        "expires_at_ms": g.expires_at_ms,
        "epoch": g.epoch,
    })
}

pub fn lease_fields_json(l: &TaskLease) -> Value {
    json!({
        "v": crate::lease::LEASE_DOMAIN,
        "lease_id": l.lease_id.as_str(),
        "task_id": l.task_id.as_str(),
        "tenant": l.tenant.as_str(),
        "sid": l.sid.as_str(),
        "role_digest": l.role_digest.to_hex(),
        "grant_id": l.grant_id.as_str(),
        "epoch": l.epoch,
        "issued_at_ms": l.issued_at_ms,
        "expires_at_ms": l.expires_at_ms,
        "revocation": { "list": l.revocation.list.as_str(), "version": l.revocation.version },
        "nonce": l.nonce.to_hex(),
    })
}

pub fn intent_fields_json(i: &ActionIntent) -> Value {
    json!({
        "v": crate::intent::INTENT_DOMAIN,
        "intent_id": i.intent_id.as_str(),
        "tenant": i.tenant.as_str(),
        "sid": i.sid.as_str(),
        "task_id": i.task_id.as_str(),
        "role_digest": i.role_digest.to_hex(),
        "tool": i.tool.as_str(),
        "tool_schema": i.tool_schema_digest.to_hex(),
        "effect": i.effect.as_str(),
        "risk": i.risk.as_str(),
        "target": i.target.to_string(),
        "params": i.params_digest.to_hex(),
        "idempotency": i.idempotency_key.as_ref().map(RefId::as_str),
        "spend": spend_json(&i.spend),
        "issued_at_ms": i.issued_at_ms,
        "expires_at_ms": i.expires_at_ms,
        "advisory": i.advisory.as_ref().map(|a| json!({
            "model": a.model,
            "verdict": a.verdict.as_str(),
            "confidence_bp": a.confidence_bp,
        })),
    })
}

pub fn approval_fields_json(a: &ApprovalRecord) -> Value {
    json!({
        "v": crate::approval::APPROVAL_DOMAIN,
        "approval_id": a.approval_id.as_str(),
        "tenant": a.tenant.as_str(),
        "sid": a.sid.as_str(),
        "intent_id": a.intent_id.as_str(),
        "params": a.params_digest.to_hex(),
        "effect": a.effect.as_str(),
        "max_risk": a.max_risk.as_str(),
        "approved_at_ms": a.approved_at_ms,
        "expires_at_ms": a.expires_at_ms,
    })
}

fn spend_json(s: &Spend) -> Value {
    json!({
        "cpu_ms": s.cpu_ms,
        "ram_mib": s.ram_mib,
        "gpu_ms": s.gpu_ms,
        "cloud_micros": s.cloud_micros,
        "events": s.events,
    })
}

// ---------------------------------------------------------------------- decision

fn invalid(detail: &str) -> String {
    json!({
        "v": AUTHORIZE_DOMAIN,
        "allowed": false,
        "code": "invalid-request",
        "detail": detail,
    })
    .to_string()
}

fn parse_fields<T: for<'de> Deserialize<'de>>(v: &Value, what: &str) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("{what}: {e}"))
}

/// Decide one bundle. Returns the decision JSON; `Err` only when the answer itself
/// cannot be serialized (a bug), so a caller never mistakes a bridge failure for an
/// allow.
pub fn authorize_bundle(input: &str) -> Result<String, String> {
    let raw: RawBundle = match serde_json::from_str(input) {
        Ok(r) => r,
        Err(e) => return Ok(invalid(&format!("bundle: {e}"))),
    };
    if raw.v != AUTHORIZE_DOMAIN {
        return Ok(invalid(&format!("bundle v is {:?}", raw.v)));
    }
    let grant_fields: RawGrantFields = match parse_fields(&raw.grant.fields, "grant.fields") {
        Ok(f) => f,
        Err(e) => return Ok(invalid(&e)),
    };
    let intent_raw: RawIntent = match parse_fields(&raw.intent, "intent") {
        Ok(f) => f,
        Err(e) => return Ok(invalid(&e)),
    };
    let approval_fields: Option<RawApprovalFields> = match &raw.approval {
        None => None,
        Some(a) => match parse_fields(&a.fields, "approval.fields") {
            Ok(f) => Some(f),
            Err(e) => return Ok(invalid(&e)),
        },
    };

    // Typed conversion: every identifier and digest is re-validated here, so an
    // out-of-grammar tool name is a refusal rather than a silently different name.
    let grant = match grant_fields.typed() {
        Ok(g) => g,
        Err(e) => return Ok(invalid(&e)),
    };
    let intent = match intent_raw.typed() {
        Ok(i) => i,
        Err(e) => return Ok(invalid(&e)),
    };
    let approval = match approval_fields {
        None => None,
        Some(f) => match f.typed() {
            Ok(a) => Some(a),
            Err(e) => return Ok(invalid(&e)),
        },
    };
    // The lease schema is owned by `fixtures` (it is the portable contract): reuse the
    // strict parser so this bridge cannot accept a lease the Go/Elixir verifiers reject.
    let lease_json = serde_json::to_string(&raw.lease.fields).map_err(|e| e.to_string())?;
    let lease = match crate::fixtures::parse_fields(&lease_json) {
        Ok(l) => l,
        Err(e) => return Ok(invalid(&format!("lease.fields: {e}"))),
    };
    let issuer = match IssuerId::from_str(&raw.lease.issuer) {
        Ok(i) => i,
        Err(e) => return Ok(invalid(&format!("lease issuer: {e}"))),
    };
    let grant_issuer = match IssuerId::from_str(&raw.grant.issuer) {
        Ok(i) => i,
        Err(e) => return Ok(invalid(&format!("grant issuer: {e}"))),
    };

    let mut kernel = PolicyKernel::new();
    for key in &raw.trust.issuers {
        let id = match IssuerId::from_str(&key.id) {
            Ok(i) => i,
            Err(e) => return Ok(invalid(&format!("trust issuer id: {e}"))),
        };
        let vk = match verifying_key_from_hex(&key.public_key_hex) {
            Ok(k) => k,
            Err(e) => return Ok(invalid(&format!("trust issuer key: {e}"))),
        };
        kernel.trust_issuer(id, vk);
    }
    for key in &raw.trust.approvers {
        let id = match IssuerId::from_str(&key.id) {
            Ok(i) => i,
            Err(e) => return Ok(invalid(&format!("trust approver id: {e}"))),
        };
        let vk = match verifying_key_from_hex(&key.public_key_hex) {
            Ok(k) => k,
            Err(e) => return Ok(invalid(&format!("trust approver key: {e}"))),
        };
        let clearance = match risk(&key.clearance) {
            Ok(r) => r,
            Err(e) => return Ok(invalid(&e)),
        };
        kernel.trust_approver(id, vk, clearance);
    }
    for rev in &raw.revocations {
        let list = match RefId::parse(&rev.list) {
            Ok(l) => l,
            Err(e) => return Ok(invalid(&format!("revocation list: {e}"))),
        };
        kernel.publish_revocation_version(&list, rev.version);
    }

    let grant_sig = match Signature::parse_hex(&raw.grant.signature_hex) {
        Ok(s) => s,
        Err(e) => return Ok(invalid(&format!("grant signature: {e}"))),
    };
    let lease_sig = match Signature::parse_hex(&raw.lease.signature_hex) {
        Ok(s) => s,
        Err(e) => return Ok(invalid(&format!("lease signature: {e}"))),
    };
    if let Err(denial) = kernel.register_grant(SignedGrant {
        grant: grant.clone(),
        issuer: grant_issuer,
        signature: grant_sig,
    }) {
        return Ok(refusal(&denial, &intent));
    }
    let signed_lease = SignedLease {
        lease: lease.clone(),
        issuer,
        signature: lease_sig,
    };
    if let Err(denial) = kernel.register_lease(&signed_lease) {
        return Ok(refusal(&denial, &intent));
    }
    if let Some(record) = approval {
        let approver = same(&raw.approval, "approver")
            .and_then(|s| IssuerId::from_str(&s).map_err(|e| format!("approval approver: {e}")));
        let approver = match approver {
            Ok(a) => a,
            Err(e) => return Ok(invalid(&e)),
        };
        let sig_hex = same(&raw.approval, "signature_hex")
            .and_then(|s| Signature::parse_hex(&s).map_err(|e| format!("approval signature: {e}")));
        let sig = match sig_hex {
            Ok(s) => s,
            Err(e) => return Ok(invalid(&e)),
        };
        if let Err(denial) = kernel.approve(SignedApproval {
            record,
            approver,
            signature: sig,
        }) {
            return Ok(refusal(&denial, &intent));
        }
    }

    match kernel.authorize(&signed_lease, &intent, raw.now_ms) {
        Ok(permit) => Ok(json!({
            "v": AUTHORIZE_DOMAIN,
            "allowed": true,
            "code": "allow",
            "intent_digest": intent.digest().to_hex(),
            "params_digest": intent.params_digest.to_hex(),
            "tenant": intent.tenant.as_str(),
            "sid": intent.sid.as_str(),
            "task_id": intent.task_id.as_str(),
            "tool": intent.tool.as_str(),
            "effect": intent.effect.as_str(),
            "risk": intent.risk.as_str(),
            "target": intent.target.to_string(),
            "advisory": intent.advisory.as_ref().map(|a| json!({
                "model": a.model,
                "verdict": a.verdict.as_str(),
                "confidence_bp": a.confidence_bp,
            })),
            "permit": {
                "permit_id": permit.permit_id.to_hex(),
                "intent_id": permit.intent_id.as_str(),
                "intent_digest": permit.intent_digest.to_hex(),
                "effect": permit.effect.as_str(),
                "expires_at_ms": permit.expires_at_ms,
            },
            "audit_seq": kernel.audit().last().map_or(0, |r| r.seq),
        })
        .to_string()),
        Err(denial) => Ok(refusal(&denial, &intent)),
    }
}

/// `raw.approval` is `Option`; the caller already knows it is present when this runs.
fn same(approval: &Option<RawSignedApproval>, key: &str) -> Result<String, String> {
    let a = approval.as_ref().ok_or("approval missing")?;
    Ok(match key {
        "approver" => a.approver.clone(),
        "signature_hex" => a.signature_hex.clone(),
        _ => return Err(format!("unknown approval key {key}")),
    })
}

fn refusal(denial: &crate::kernel::Denial, intent: &ActionIntent) -> String {
    json!({
        "v": AUTHORIZE_DOMAIN,
        "allowed": false,
        "code": denial.reason.code(),
        "intent_digest": intent.digest().to_hex(),
        "params_digest": intent.params_digest.to_hex(),
        "tenant": intent.tenant.as_str(),
        "sid": intent.sid.as_str(),
        "task_id": intent.task_id.as_str(),
        "tool": intent.tool.as_str(),
        "effect": intent.effect.as_str(),
        "risk": intent.risk.as_str(),
        "target": intent.target.to_string(),
        "audit_seq": denial.audit_seq,
    })
    .to_string()
}

/// Decision code for the CLI exit status: 0 allow, 10 policy refusal, 20 malformed.
pub fn exit_code_for(decision_json: &str) -> i32 {
    match serde_json::from_str::<Value>(decision_json) {
        Ok(d) if d["allowed"] == json!(true) => EXIT_ALLOW,
        Ok(d) if d["code"] == json!("invalid-request") => EXIT_INVALID,
        Ok(_) => EXIT_DENY,
        Err(_) => EXIT_INVALID,
    }
}

// -------------------------------------------------------------------------- mint

/// Sign one document from a seed. This is the only place the bridge creates authority,
/// and it is a separate call on purpose: minting is an administrative act (issuer
/// service, operator command), authorizing is a check. Keeping them apart means an
/// authorization call can never quietly mint the authority it is about to honour.
pub fn mint_json(input: &str) -> Result<String, String> {
    let raw: RawMint = serde_json::from_str(input).map_err(|e| format!("mint: {e}"))?;
    if raw.v != MINT_DOMAIN {
        return Err(format!("mint v is {:?}", raw.v));
    }
    let seed = parse_seed(&raw.seed_hex)?;
    let key = SigningKeyPair::from_seed(&seed);
    let public_key_hex = key.public_key_hex();
    let (signature_hex, canonical_sha256) = match raw.kind.as_str() {
        "grant" => {
            let fields: RawGrantFields = parse_fields(&raw.fields, "grant.fields")?;
            let grant = fields.typed()?;
            grant
                .validate()
                .map_err(|e| format!("invalid-grant: {e}"))?;
            let signed = SignedGrant::sign(grant.clone(), issuer(&raw.issuer)?, &key);
            (
                signed.signature.to_hex(),
                Digest::of(grant.canonical_json().as_bytes()).to_hex(),
            )
        }
        "lease" => {
            let fields = serde_json::to_string(&raw.fields).map_err(|e| e.to_string())?;
            let lease =
                crate::fixtures::parse_fields(&fields).map_err(|e| format!("lease.fields: {e}"))?;
            lease
                .validate()
                .map_err(|e| format!("invalid-lease: {e}"))?;
            let signed = SignedLease::sign(lease.clone(), issuer(&raw.issuer)?, &key);
            (
                signed.signature.to_hex(),
                Digest::of(lease.canonical_json().as_bytes()).to_hex(),
            )
        }
        "approval" => {
            let fields: RawApprovalFields = parse_fields(&raw.fields, "approval.fields")?;
            let record = fields.typed()?;
            record
                .validate()
                .map_err(|e| format!("invalid-approval: {e}"))?;
            let signed = SignedApproval::sign(record.clone(), issuer(&raw.issuer)?, &key);
            (
                signed.signature.to_hex(),
                Digest::of(record.canonical_json().as_bytes()).to_hex(),
            )
        }
        other => return Err(format!("unknown kind {other:?}")),
    };
    Ok(json!({
        "v": MINT_DOMAIN,
        "kind": raw.kind,
        "issuer": raw.issuer,
        "public_key_hex": public_key_hex,
        "signature_hex": signature_hex,
        "canonical_sha256": canonical_sha256,
        "fields": raw.fields,
    })
    .to_string())
}

fn issuer(s: &str) -> Result<IssuerId, String> {
    IssuerId::from_str(s).map_err(|e| format!("issuer: {e}"))
}

fn parse_seed(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err("seed_hex must be 64 hex characters".to_string());
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
            .map_err(|_| "seed_hex is not hexadecimal".to_string())?;
        *slot = byte;
    }
    Ok(out)
}
