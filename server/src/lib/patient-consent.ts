// M-41 Patient-data privacy / consent controls (V6-13-05, 13-10)
import { createHash, randomBytes } from 'node:crypto';

export type ConsentPurpose =
  | 'research_secondary'
  | 'care_coordination'
  | 'model_training_excluded' // always denied for patient data
  | 'analytics_deidentified'
  | 'export_portability';

export type ConsentState = 'granted' | 'denied' | 'revoked' | 'expired';

export interface ConsentRecord {
  id: string;
  subjectId: string; // patient / data subject
  tenantId: string;
  purpose: ConsentPurpose;
  state: ConsentState;
  grantedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  scope: string[]; // data categories e.g. labs, notes, imaging
  encryption: 'aes-256-gcm' | 'required';
  auditId: string;
}

export interface AccessAttempt {
  subjectId: string;
  tenantId: string;
  purpose: ConsentPurpose;
  categories: string[];
  actorId: string;
  at?: string;
}

export interface AccessDecision {
  allowed: boolean;
  blockers: string[];
  requiresEncryption: boolean;
  consentId?: string;
}

/** In-memory consent registry for gate logic (DB wiring is separate). */
export class ConsentRegistry {
  private bySubject = new Map<string, ConsentRecord[]>();

  grant(input: {
    subjectId: string;
    tenantId: string;
    purpose: ConsentPurpose;
    scope: string[];
    expiresAt?: string | null;
  }): ConsentRecord {
    if (input.purpose === 'model_training_excluded') {
      throw Object.assign(new Error('patient data cannot be consented for model training'), {
        code: 'consent_purpose_forbidden',
      });
    }
    const id = `cns_${randomBytes(8).toString('hex')}`;
    const rec: ConsentRecord = {
      id,
      subjectId: input.subjectId,
      tenantId: input.tenantId,
      purpose: input.purpose,
      state: 'granted',
      grantedAt: new Date().toISOString(),
      revokedAt: null,
      expiresAt: input.expiresAt ?? null,
      scope: [...input.scope],
      encryption: 'required',
      auditId: hashAudit(['grant', id, input.subjectId, input.purpose]),
    };
    const list = this.bySubject.get(input.subjectId) ?? [];
    list.push(rec);
    this.bySubject.set(input.subjectId, list);
    return rec;
  }

  revoke(subjectId: string, consentId: string): ConsentRecord {
    const list = this.bySubject.get(subjectId) ?? [];
    const rec = list.find((r) => r.id === consentId);
    if (!rec) {
      throw Object.assign(new Error('consent not found'), { code: 'consent_not_found' });
    }
    rec.state = 'revoked';
    rec.revokedAt = new Date().toISOString();
    rec.auditId = hashAudit(['revoke', rec.id, rec.auditId]);
    return rec;
  }

  list(subjectId: string): ConsentRecord[] {
    return [...(this.bySubject.get(subjectId) ?? [])];
  }

  evaluateAccess(attempt: AccessAttempt): AccessDecision {
    const blockers: string[] = [];
    if (attempt.purpose === 'model_training_excluded') {
      return {
        allowed: false,
        blockers: ['purpose_forbidden_model_training'],
        requiresEncryption: true,
      };
    }

    const now = attempt.at ? Date.parse(attempt.at) : Date.now();
    const matches = (this.bySubject.get(attempt.subjectId) ?? []).filter((r) => {
      if (r.tenantId !== attempt.tenantId) return false;
      if (r.purpose !== attempt.purpose) return false;
      if (r.state !== 'granted') return false;
      if (r.expiresAt && Date.parse(r.expiresAt) <= now) return false;
      return attempt.categories.every((c) => r.scope.includes(c) || r.scope.includes('*'));
    });

    if (!matches.length) {
      blockers.push('no_active_consent');
      return { allowed: false, blockers, requiresEncryption: true };
    }

    // Prefer most recent grant
    const best = [...matches].sort((a, b) => (b.grantedAt ?? '').localeCompare(a.grantedAt ?? ''))[0];
    return {
      allowed: true,
      blockers: [],
      requiresEncryption: true,
      consentId: best.id,
    };
  }
}

export interface ExportRequest {
  subjectId: string;
  tenantId: string;
  categories: string[];
}

export interface ExportResult {
  allowed: boolean;
  blockers: string[];
  payload: null | { categories: string[]; encrypted: true; exportId: string };
}

/** Portability export requires active export_portability consent (V6-13-10). */
export function evaluateExport(reg: ConsentRegistry, req: ExportRequest): ExportResult {
  const decision = reg.evaluateAccess({
    subjectId: req.subjectId,
    tenantId: req.tenantId,
    purpose: 'export_portability',
    categories: req.categories,
    actorId: req.subjectId,
  });
  if (!decision.allowed) {
    return { allowed: false, blockers: decision.blockers, payload: null };
  }
  return {
    allowed: true,
    blockers: [],
    payload: {
      categories: req.categories,
      encrypted: true,
      exportId: `exp_${hashAudit([req.subjectId, ...req.categories]).slice(0, 16)}`,
    },
  };
}

/** After consent revocation, access and export must fail. */
export function assertRevocationEffective(reg: ConsentRegistry, subjectId: string, tenantId: string, purpose: ConsentPurpose, categories: string[]): void {
  const d = reg.evaluateAccess({ subjectId, tenantId, purpose, categories, actorId: 'test' });
  if (d.allowed) {
    throw Object.assign(new Error('revocation not effective'), { code: 'consent_revocation_ineffective' });
  }
}

function hashAudit(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Retention policy labels — patient content never retained without rule. */
export const PATIENT_RETENTION_RULES = {
  'clinical_audit_meta': 'Non-content audit metadata may retain timestamps and actor ids only',
} as const;
