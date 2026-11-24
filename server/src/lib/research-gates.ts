// M-40 Research / medical roles + citation fidelity (V6-13-01..04, 08 partial)
import { createHash } from 'node:crypto';

export type ResearchRoleId =
  | 'evidence-investigator'
  | 'hypothesis-challenger'
  | 'citation-auditor'
  | 'medical-research-librarian';

export interface ResearchRole {
  id: ResearchRoleId;
  title: string;
  deniedClaims: string[];
  requiredBehaviors: string[];
  riskClass: 'medium' | 'high' | 'critical';
}

export const RESEARCH_ROLES: Record<ResearchRoleId, ResearchRole> = {
  'evidence-investigator': {
    id: 'evidence-investigator',
    title: 'Evidence Investigator',
    deniedClaims: ['guaranteed_outcome', 'invented_primary_source'],
    requiredBehaviors: ['primary_sources', 'uncertainty_labels', 'alternative_explanations'],
    riskClass: 'high',
  },
  'hypothesis-challenger': {
    id: 'hypothesis-challenger',
    title: 'Hypothesis Challenger',
    deniedClaims: ['unopposed_conclusion', 'suppress_counterevidence'],
    requiredBehaviors: ['steelman_alternatives', 'falsification_paths'],
    riskClass: 'high',
  },
  'citation-auditor': {
    id: 'citation-auditor',
    title: 'Citation Auditor',
    deniedClaims: ['unverified_doi', 'hallucinated_citation'],
    requiredBehaviors: ['source_fidelity_check', 'quote_span_verify'],
    riskClass: 'medium',
  },
  'medical-research-librarian': {
    id: 'medical-research-librarian',
    title: 'Medical Research Librarian',
    deniedClaims: [
      'i_am_a_clinician',
      'licensed_physician',
      'provides_diagnosis',
      'prescribes_treatment',
    ],
    requiredBehaviors: ['no_clinician_credential_claim', 'research_only_framing', 'defer_to_professionals'],
    riskClass: 'critical',
  },
};

export interface Citation {
  id: string;
  title: string;
  /** DOI, URL, or archive id — empty means unverifiable */
  locator: string;
  year?: number;
  /** Claimed quote or support span */
  supportSpan?: string;
}

export interface ClaimBundle {
  claim: string;
  contested: boolean;
  citations: Citation[];
  uncertainty?: string;
  alternatives?: string[];
  roleId: ResearchRoleId;
}

export interface CitationAuditResult {
  ok: boolean;
  blockers: string[];
  verified: string[];
  rejected: string[];
}

const DOI_RE = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Known-good fixture registry for tests (not a live resolver). */
const FIXTURE_REGISTRY = new Map<string, { title: string; supportSpans: string[] }>([
  ['10.1000/fixture.1', { title: 'Fixture Paper One', supportSpans: ['sample support text'] }],
  ['https://example.org/papers/alpha', { title: 'Alpha Study', supportSpans: ['alpha result'] }],
]);

export function registerCitationFixture(locator: string, title: string, supportSpans: string[]): void {
  FIXTURE_REGISTRY.set(locator, { title, supportSpans });
}

export function auditCitations(citations: Citation[]): CitationAuditResult {
  const blockers: string[] = [];
  const verified: string[] = [];
  const rejected: string[] = [];

  for (const c of citations) {
    if (!c.locator || (!DOI_RE.test(c.locator) && !URL_RE.test(c.locator))) {
      blockers.push(`invalid_locator:${c.id}`);
      rejected.push(c.id);
      continue;
    }
    const known = FIXTURE_REGISTRY.get(c.locator);
    if (!known) {
      // Not in fixture registry → treat as unresolved (cannot auto-verify)
      blockers.push(`unverified_citation:${c.id}`);
      rejected.push(c.id);
      continue;
    }
    if (c.title && known.title && c.title !== known.title) {
      blockers.push(`title_mismatch:${c.id}`);
      rejected.push(c.id);
      continue;
    }
    if (c.supportSpan && !known.supportSpans.some((s) => c.supportSpan!.includes(s) || s.includes(c.supportSpan!))) {
      blockers.push(`support_span_mismatch:${c.id}`);
      rejected.push(c.id);
      continue;
    }
    verified.push(c.id);
  }

  return { ok: blockers.length === 0, blockers, verified, rejected };
}

/**
 * Contested claims require primary sources + uncertainty + alternatives (V6-13-02).
 * Medical librarian must not claim clinician credentials (V6-13-04).
 * Hallucinated citations rejected (V6-13-03).
 */
export function evaluateResearchOutput(bundle: ClaimBundle): {
  allowed: boolean;
  blockers: string[];
  role: ResearchRole;
} {
  const role = RESEARCH_ROLES[bundle.roleId];
  const blockers: string[] = [];

  // Credential / denied claim scan on claim text
  const lower = bundle.claim.toLowerCase();
  for (const denied of role.deniedClaims) {
    const needle = denied.replace(/_/g, ' ');
    if (lower.includes(needle) || lower.includes(denied)) {
      blockers.push(`denied_claim:${denied}`);
    }
  }
  // Explicit clinician patterns for medical role
  if (bundle.roleId === 'medical-research-librarian') {
    if (/\b(i am|i'm) (a |your )?(doctor|physician|clinician|nurse practitioner)\b/i.test(bundle.claim)) {
      blockers.push('denied_claim:clinician_identity');
    }
    if (/\b(diagnos(e|is|ing)|prescrib(e|ing)|treat(ment)? plan)\b/i.test(bundle.claim)) {
      blockers.push('denied_claim:clinical_act');
    }
  }

  if (bundle.contested) {
    if (!bundle.citations.length) blockers.push('contested_requires_citations');
    if (!bundle.uncertainty || !bundle.uncertainty.trim()) blockers.push('contested_requires_uncertainty');
    if (!bundle.alternatives || bundle.alternatives.length === 0) {
      blockers.push('contested_requires_alternatives');
    }
  }

  if (bundle.citations.length) {
    const audit = auditCitations(bundle.citations);
    blockers.push(...audit.blockers);
  }

  // Adversarial: refuse invented support
  if (/as proven in the nonexistent/i.test(bundle.claim) || /doi:10\.9999\/fake/i.test(bundle.claim)) {
    blockers.push('invented_support');
  }

  return { allowed: blockers.length === 0, blockers, role };
}

/** Independent scientific gate — model self-score cannot overwrite (V6-13-09). */
export function independentScienceGate(input: {
  citationAuditOk: boolean;
  researchEvalAllowed: boolean;
  modelSelfScore?: number;
}): { pass: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.citationAuditOk) blockers.push('citation_audit_failed');
  if (!input.researchEvalAllowed) blockers.push('research_eval_failed');
  // Explicitly ignore modelSelfScore
  void input.modelSelfScore;
  return { pass: blockers.length === 0, blockers };
}

export function roleDigest(id: ResearchRoleId): string {
  const r = RESEARCH_ROLES[id];
  return createHash('sha256').update(JSON.stringify(r)).digest('hex');
}
