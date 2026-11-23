//! The dispatch kernel: one function, twenty ordered checks, one audit record.
//!
//! [`PolicyKernel::authorize`] is called at the start of a privileged action **and
//! again at every privileged tool call** (V6-05-05). There is no cached "already
//! allowed" state that survives a revocation: the grant, the lease, the revocation
//! list and the approval are all re-read on every call.
//!
//! ## Check order (stable, asserted by tests)
//!
//! * (1) lease internally valid → `invalid-lease`
//! * (2) issuer trusted → `unknown-issuer`
//! * (3) lease signature → `invalid-signature`
//! * (4) lease window vs now → `lease-not-yet-valid` / `lease-expired`
//! * (5) revocation list version → `lease-revoked`
//! * (6) task epoch → `stale-epoch`
//! * (7) intent internally valid → `invalid-intent`
//! * (8) intent expiry → `intent-expired`
//! * (9-12) tenant / actor / task / role binding
//! * (13-16) grant exists, not revoked, not expired, belongs to this tenant+SID
//! * (17-21) effect, tool, schema digest, risk, target
//! * (22) spend ceilings → `spend-exceeds-budget`
//! * (23) task wall time vs grant → `wall-time-exceeds-budget`
//! * (24) replay (intent id, idempotency key) → `replay`
//! * (25) human approval where required → `approval-required` / `approval-invalid`
//! * (26) concurrency ceiling → `concurrency-ceiling`
//!
//! Only after all 26 pass is a one-use [`ActionPermit`] minted, the reservation
//! recorded, the approval consumed and the replay keys claimed. Everything before
//! that point is a pure read.

use std::collections::{BTreeMap, BTreeSet};

use crate::approval::{ApprovalRecord, SignedApproval};
use crate::effect::{EffectClass, RiskTier};
use crate::grant::{Grant, SignedGrant, ToolVerdict};
use crate::ids::{Digest, RefId, Sid, TenantId};
use crate::intent::{ActionIntent, Advisory};
use crate::lease::{SignedLease, TaskLease};
use crate::signature::{IssuerId, SigError, VerifyingKey};

/// Why an action was refused. Each variant has a stable kebab-case code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    InvalidLease,
    UnknownIssuer,
    InvalidSignature,
    InvalidGrant,
    InvalidApproval,
    InvalidIntent,
    LeaseNotYetValid,
    LeaseExpired,
    LeaseRevoked,
    StaleEpoch,
    IntentExpired,
    TenantMismatch,
    ActorMismatch,
    TaskMismatch,
    RoleMismatch,
    GrantUnknown,
    GrantRevoked,
    GrantExpired,
    EffectNotGranted,
    ToolNotGranted,
    ToolSchemaChanged,
    RiskExceedsGrant,
    ResourceNotGranted,
    SpendExceedsBudget,
    WallTimeExceedsBudget,
    ConcurrencyCeiling,
    ApprovalRequired,
    ApprovalInvalid,
    Replay,
    PermitUnknown,
    PermitExpired,
    IntentChanged,
}

impl DenyReason {
    /// Stable code for logs, receipts and E2E assertions. Never rename one.
    pub fn code(self) -> &'static str {
        match self {
            DenyReason::InvalidLease => "invalid-lease",
            DenyReason::UnknownIssuer => "unknown-issuer",
            DenyReason::InvalidSignature => "invalid-signature",
            DenyReason::InvalidGrant => "invalid-grant",
            DenyReason::InvalidApproval => "invalid-approval",
            DenyReason::InvalidIntent => "invalid-intent",
            DenyReason::LeaseNotYetValid => "lease-not-yet-valid",
            DenyReason::LeaseExpired => "lease-expired",
            DenyReason::LeaseRevoked => "lease-revoked",
            DenyReason::StaleEpoch => "stale-epoch",
            DenyReason::IntentExpired => "intent-expired",
            DenyReason::TenantMismatch => "tenant-mismatch",
            DenyReason::ActorMismatch => "actor-mismatch",
            DenyReason::TaskMismatch => "task-mismatch",
            DenyReason::RoleMismatch => "role-mismatch",
            DenyReason::GrantUnknown => "grant-unknown",
            DenyReason::GrantRevoked => "grant-revoked",
            DenyReason::GrantExpired => "grant-expired",
            DenyReason::EffectNotGranted => "effect-not-granted",
            DenyReason::ToolNotGranted => "tool-not-granted",
            DenyReason::ToolSchemaChanged => "tool-schema-changed",
            DenyReason::RiskExceedsGrant => "risk-exceeds-grant",
            DenyReason::ResourceNotGranted => "resource-not-granted",
            DenyReason::SpendExceedsBudget => "spend-exceeds-budget",
            DenyReason::WallTimeExceedsBudget => "wall-time-exceeds-budget",
            DenyReason::ConcurrencyCeiling => "concurrency-ceiling",
            DenyReason::ApprovalRequired => "approval-required",
            DenyReason::ApprovalInvalid => "approval-invalid",
            DenyReason::Replay => "replay",
            DenyReason::PermitUnknown => "permit-unknown",
            DenyReason::PermitExpired => "permit-expired",
            DenyReason::IntentChanged => "intent-changed",
        }
    }
}

impl core::fmt::Display for DenyReason {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.code())
    }
}

/// A refusal plus the audit sequence number that records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Denial {
    pub reason: DenyReason,
    pub audit_seq: u64,
}

/// A one-use permission to execute exactly the intent it was minted for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionPermit {
    pub permit_id: Digest,
    pub lease_id: RefId,
    pub task_id: RefId,
    pub intent_id: RefId,
    /// Digest of the exact intent; the executor re-computes it before running.
    pub intent_digest: Digest,
    pub effect: EffectClass,
    pub expires_at_ms: u64,
}

/// One audit record per decision. Denials are recorded with their reason code, and the
/// model's advisory verdict is recorded even though it never affected the decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRecord {
    pub seq: u64,
    pub at_ms: u64,
    pub tenant: Option<String>,
    pub sid: Option<String>,
    pub task_id: Option<String>,
    pub intent_id: Option<String>,
    pub effect: Option<&'static str>,
    pub risk: Option<&'static str>,
    pub target: Option<String>,
    pub decision: &'static str,
    pub reason: Option<&'static str>,
    pub advisory: Option<Advisory>,
    pub permit_id: Option<String>,
}

#[derive(Debug)]
struct Approver {
    key: VerifyingKey,
    clearance: RiskTier,
}

#[derive(Debug)]
struct PermitState {
    permit: ActionPermit,
    executed: bool,
}

#[derive(Debug)]
struct Reservation {
    tenant: TenantId,
    sid: Sid,
    deadline_ms: u64,
}

#[derive(Debug)]
struct ApprovalState {
    record: ApprovalRecord,
    used: bool,
}

/// In-memory policy state. Persistence and single-writer discipline belong to the
/// worker (track F); this type is deliberately free of I/O so decisions are replayable.
#[derive(Debug, Default)]
pub struct PolicyKernel {
    issuers: BTreeMap<IssuerId, VerifyingKey>,
    approvers: BTreeMap<IssuerId, Approver>,
    grants: BTreeMap<RefId, Grant>,
    revoked_grants: BTreeSet<RefId>,
    /// Revocation list id → highest published version.
    revocations: BTreeMap<RefId, u64>,
    /// Task id → highest epoch ever seen.
    task_epochs: BTreeMap<RefId, u64>,
    permits: BTreeMap<Digest, PermitState>,
    reservations: BTreeMap<Digest, Reservation>,
    consumed_intents: BTreeSet<(TenantId, RefId)>,
    used_idempotency: BTreeSet<(TenantId, RefId)>,
    /// Keyed by intent id: an approval authorises one intent, not one approval id.
    approvals: BTreeMap<RefId, ApprovalState>,
    seen_approval_ids: BTreeSet<RefId>,
    audit: Vec<AuditRecord>,
    permit_seq: u64,
}

impl PolicyKernel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Configure an issuer's public key. Re-trusting an id replaces its key, which is
    /// how a key rotation is staged; registered grants are unaffected (they are stored
    /// verified, and every lease re-verifies at dispatch).
    pub fn trust_issuer(&mut self, id: IssuerId, key: VerifyingKey) {
        self.issuers.insert(id, key);
    }

    /// Configure a human approver and the highest risk tier they may accept.
    pub fn trust_approver(&mut self, id: IssuerId, key: VerifyingKey, clearance: RiskTier) {
        self.approvers.insert(id, Approver { key, clearance });
    }

    pub fn register_grant(&mut self, grant: SignedGrant) -> Result<(), Denial> {
        let outcome = self.check_grant(&grant);
        if let Err(reason) = outcome {
            return Err(self.record_denial(reason, None, None, 0));
        }
        self.grants
            .insert(grant.grant.grant_id.clone(), grant.grant);
        Ok(())
    }

    pub fn revoke_grant(&mut self, id: &RefId) {
        self.revoked_grants.insert(id.clone());
    }

    /// Publish a higher revocation-list version. Monotonic: an older version is ignored.
    pub fn publish_revocation_version(&mut self, list: &RefId, version: u64) {
        let e = self.revocations.entry(list.clone()).or_insert(0);
        if version > *e {
            *e = version;
        }
    }

    pub fn register_lease(&mut self, lease: &SignedLease) -> Result<(), Denial> {
        let outcome = self.check_lease(lease);
        if let Err(reason) = outcome {
            return Err(self.record_denial(reason, None, None, 0));
        }
        let task = lease.lease.task_id.clone();
        let epoch = lease.lease.epoch;
        let e = self.task_epochs.entry(task).or_insert(0);
        if epoch > *e {
            *e = epoch;
        }
        Ok(())
    }

    pub fn approve(&mut self, approval: SignedApproval) -> Result<(), Denial> {
        let outcome = self.check_approval(&approval);
        if let Err(reason) = outcome {
            return Err(self.record_denial(reason, None, None, 0));
        }
        self.seen_approval_ids
            .insert(approval.record.approval_id.clone());
        self.approvals.insert(
            approval.record.intent_id.clone(),
            ApprovalState {
                record: approval.record,
                used: false,
            },
        );
        Ok(())
    }

    /// Authorise one action. Called per privileged call, not once per task.
    pub fn authorize(
        &mut self,
        lease: &SignedLease,
        intent: &ActionIntent,
        now_ms: u64,
    ) -> Result<ActionPermit, Denial> {
        let outcome = self.check_action(lease, intent, now_ms);
        match outcome {
            Ok(permit) => {
                self.audit.push(AuditRecord {
                    seq: self.audit.len() as u64,
                    at_ms: now_ms,
                    tenant: Some(intent.tenant.to_string()),
                    sid: Some(intent.sid.to_string()),
                    task_id: Some(intent.task_id.to_string()),
                    intent_id: Some(intent.intent_id.to_string()),
                    effect: Some(intent.effect.as_str()),
                    risk: Some(intent.risk.as_str()),
                    target: Some(intent.target.to_string()),
                    decision: "allow",
                    reason: None,
                    advisory: intent.advisory.clone(),
                    permit_id: Some(permit.permit_id.to_hex()),
                });
                Ok(permit)
            }
            Err(reason) => {
                Err(self.record_denial(reason, Some(intent), intent.advisory.clone(), now_ms))
            }
        }
    }

    /// Executor-side re-check that a permit still matches the intent it is about to run.
    pub fn verify_permit(
        &self,
        permit: &ActionPermit,
        intent: &ActionIntent,
        now_ms: u64,
    ) -> Result<(), DenyReason> {
        let state = self
            .permits
            .get(&permit.permit_id)
            .ok_or(DenyReason::PermitUnknown)?;
        if now_ms >= state.permit.expires_at_ms {
            return Err(DenyReason::PermitExpired);
        }
        if state.permit.intent_id != intent.intent_id
            || state.permit.intent_digest != intent.digest()
        {
            return Err(DenyReason::IntentChanged);
        }
        if state.executed {
            return Err(DenyReason::Replay);
        }
        Ok(())
    }

    /// Mark a permit executed and release its admission slot. A second mark is a replay.
    pub fn mark_executed(&mut self, permit_id: &Digest) -> Result<(), DenyReason> {
        let state = self
            .permits
            .get_mut(permit_id)
            .ok_or(DenyReason::PermitUnknown)?;
        if state.executed {
            return Err(DenyReason::Replay);
        }
        state.executed = true;
        self.reservations.remove(permit_id);
        Ok(())
    }

    /// Abandon a permit (cancelled task) and release its slot.
    pub fn release(&mut self, permit_id: &Digest) {
        self.reservations.remove(permit_id);
    }

    /// Reap reservations whose wall-time deadline passed (dead worker). Returns count.
    pub fn sweep(&mut self, now_ms: u64) -> usize {
        let expired: Vec<Digest> = self
            .reservations
            .iter()
            .filter(|(_, r)| r.deadline_ms <= now_ms)
            .map(|(k, _)| *k)
            .collect();
        for k in &expired {
            self.reservations.remove(k);
        }
        expired.len()
    }

    pub fn audit(&self) -> &[AuditRecord] {
        &self.audit
    }

    // ------------------------------------------------------------- private

    fn check_grant(&self, signed: &SignedGrant) -> Result<(), DenyReason> {
        let key = self
            .issuers
            .get(&signed.issuer)
            .ok_or(DenyReason::UnknownIssuer)?;
        signed
            .verify(key)
            .map_err(|_| DenyReason::InvalidSignature)?;
        signed
            .grant
            .validate()
            .map_err(|_| DenyReason::InvalidGrant)?;
        Ok(())
    }

    fn check_lease(&self, signed: &SignedLease) -> Result<(), DenyReason> {
        signed
            .lease
            .validate()
            .map_err(|_| DenyReason::InvalidLease)?;
        let key = self
            .issuers
            .get(&signed.issuer)
            .ok_or(DenyReason::UnknownIssuer)?;
        signed
            .verify(key)
            .map_err(|_| DenyReason::InvalidSignature)?;
        if let Some(published) = self.revocations.get(&signed.lease.revocation.list) {
            if signed.lease.revocation.version < *published {
                return Err(DenyReason::LeaseRevoked);
            }
        }
        if let Some(seen) = self.task_epochs.get(&signed.lease.task_id) {
            if signed.lease.epoch < *seen {
                return Err(DenyReason::StaleEpoch);
            }
        }
        Ok(())
    }

    fn check_approval(&self, signed: &SignedApproval) -> Result<(), DenyReason> {
        let approver = self
            .approvers
            .get(&signed.approver)
            .ok_or(DenyReason::UnknownIssuer)?;
        signed
            .verify(&approver.key)
            .map_err(|_| DenyReason::InvalidSignature)?;
        signed
            .record
            .validate()
            .map_err(|_| DenyReason::InvalidApproval)?;
        if approver.clearance < signed.record.max_risk {
            return Err(DenyReason::ApprovalInvalid);
        }
        if self.seen_approval_ids.contains(&signed.record.approval_id) {
            return Err(DenyReason::ApprovalInvalid);
        }
        Ok(())
    }

    #[allow(clippy::too_many_lines)]
    fn check_action(
        &mut self,
        signed: &SignedLease,
        intent: &ActionIntent,
        now_ms: u64,
    ) -> Result<ActionPermit, DenyReason> {
        let lease: &TaskLease = &signed.lease;
        if lease.validate().is_err() {
            return Err(DenyReason::InvalidLease);
        }
        let key = self
            .issuers
            .get(&signed.issuer)
            .ok_or(DenyReason::UnknownIssuer)?;
        signed
            .verify(key)
            .map_err(|_: SigError| DenyReason::InvalidSignature)?;

        if now_ms < lease.issued_at_ms {
            return Err(DenyReason::LeaseNotYetValid);
        }
        if now_ms >= lease.expires_at_ms {
            return Err(DenyReason::LeaseExpired);
        }
        if let Some(published) = self.revocations.get(&lease.revocation.list) {
            if lease.revocation.version < *published {
                return Err(DenyReason::LeaseRevoked);
            }
        }
        if let Some(seen) = self.task_epochs.get(&lease.task_id) {
            if lease.epoch < *seen {
                return Err(DenyReason::StaleEpoch);
            }
        }
        intent.validate().map_err(|_| DenyReason::InvalidIntent)?;
        if now_ms >= intent.expires_at_ms {
            return Err(DenyReason::IntentExpired);
        }
        if intent.tenant != lease.tenant {
            return Err(DenyReason::TenantMismatch);
        }
        if intent.sid != lease.sid {
            return Err(DenyReason::ActorMismatch);
        }
        if intent.task_id != lease.task_id {
            return Err(DenyReason::TaskMismatch);
        }
        if intent.role_digest != lease.role_digest {
            return Err(DenyReason::RoleMismatch);
        }

        let grant = self
            .grants
            .get(&lease.grant_id)
            .ok_or(DenyReason::GrantUnknown)?;
        if self.revoked_grants.contains(&grant.grant_id) {
            return Err(DenyReason::GrantRevoked);
        }
        if now_ms >= grant.expires_at_ms {
            return Err(DenyReason::GrantExpired);
        }
        if grant.tenant != lease.tenant || grant.sid != lease.sid {
            return Err(DenyReason::TenantMismatch);
        }
        if !grant.covers_effect(intent.effect) {
            return Err(DenyReason::EffectNotGranted);
        }
        match grant.tool_verdict(&intent.tool, &intent.tool_schema_digest) {
            ToolVerdict::Allowed => {}
            ToolVerdict::NotGranted => return Err(DenyReason::ToolNotGranted),
            ToolVerdict::SchemaMismatch => return Err(DenyReason::ToolSchemaChanged),
        }
        if intent.risk > grant.max_risk {
            return Err(DenyReason::RiskExceedsGrant);
        }
        if !grant.allows_target(&intent.target) {
            return Err(DenyReason::ResourceNotGranted);
        }
        if !intent.spend.exceeds(&grant.budget.spend).is_empty() {
            return Err(DenyReason::SpendExceedsBudget);
        }
        let lease_ms = lease.expires_at_ms - lease.issued_at_ms;
        if lease_ms > grant.budget.wall_ms {
            return Err(DenyReason::WallTimeExceedsBudget);
        }

        // Replay: an intent id names one action, once, for ever within the tenant.
        if self
            .consumed_intents
            .contains(&(intent.tenant.clone(), intent.intent_id.clone()))
        {
            return Err(DenyReason::Replay);
        }
        if let Some(idem) = &intent.idempotency_key {
            if self
                .used_idempotency
                .contains(&(intent.tenant.clone(), idem.clone()))
            {
                return Err(DenyReason::Replay);
            }
        }

        let needs_approval =
            intent.effect.requires_human_approval() || intent.risk == RiskTier::Critical;
        if needs_approval {
            let state = self
                .approvals
                .get(&intent.intent_id)
                .ok_or(DenyReason::ApprovalRequired)?;
            let r = &state.record;
            if state.used
                || r.params_digest != intent.params_digest
                || r.max_risk < intent.risk
                || r.effect != intent.effect
                || r.tenant != intent.tenant
                || r.sid != intent.sid
                || now_ms >= r.expires_at_ms
            {
                return Err(DenyReason::ApprovalInvalid);
            }
        }

        let active = self
            .reservations
            .values()
            .filter(|r| r.tenant == intent.tenant && r.sid == intent.sid)
            .count();
        if active >= grant.budget.concurrency as usize {
            return Err(DenyReason::ConcurrencyCeiling);
        }

        // ---- commit (infallible from here) ----
        if needs_approval {
            if let Some(state) = self.approvals.get_mut(&intent.intent_id) {
                state.used = true;
            }
        }
        self.consumed_intents
            .insert((intent.tenant.clone(), intent.intent_id.clone()));
        if let Some(idem) = &intent.idempotency_key {
            self.used_idempotency
                .insert((intent.tenant.clone(), idem.clone()));
        }
        self.permit_seq += 1;
        let permit_id = Digest::of(
            format!(
                "{}|{}|{}",
                lease.lease_id.as_str(),
                intent.intent_id.as_str(),
                self.permit_seq
            )
            .as_bytes(),
        );
        let expires_at_ms = lease
            .expires_at_ms
            .min(intent.expires_at_ms)
            .min(now_ms.saturating_add(grant.budget.wall_ms));
        let permit = ActionPermit {
            permit_id,
            lease_id: lease.lease_id.clone(),
            task_id: lease.task_id.clone(),
            intent_id: intent.intent_id.clone(),
            intent_digest: intent.digest(),
            effect: intent.effect,
            expires_at_ms,
        };
        self.permits.insert(
            permit_id,
            PermitState {
                permit: permit.clone(),
                executed: false,
            },
        );
        self.reservations.insert(
            permit_id,
            Reservation {
                tenant: intent.tenant.clone(),
                sid: intent.sid.clone(),
                deadline_ms: expires_at_ms,
            },
        );
        Ok(permit)
    }

    fn record_denial(
        &mut self,
        reason: DenyReason,
        intent: Option<&ActionIntent>,
        advisory: Option<Advisory>,
        now_ms: u64,
    ) -> Denial {
        let seq = self.audit.len() as u64;
        self.audit.push(AuditRecord {
            seq,
            at_ms: now_ms,
            tenant: intent.map(|i| i.tenant.to_string()),
            sid: intent.map(|i| i.sid.to_string()),
            task_id: intent.map(|i| i.task_id.to_string()),
            intent_id: intent.map(|i| i.intent_id.to_string()),
            effect: intent.map(|i| i.effect.as_str()),
            risk: intent.map(|i| i.risk.as_str()),
            target: intent.map(|i| i.target.to_string()),
            decision: "deny",
            reason: Some(reason.code()),
            advisory,
            permit_id: None,
        });
        Denial {
            reason,
            audit_seq: seq,
        }
    }
}
