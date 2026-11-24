// H-28 per-language conformance suites — real check inventory + dry-run evidence policy
import type { LanguageId } from './language-gates.js';
import {
  LANGUAGE_GATE_PACKS,
  listLanguageGatePacks,
  runLanguageGatePack,
  acceptPackClaim,
} from './language-gates.js';

export interface LanguageConformanceReport {
  language: LanguageId;
  checkIds: string[];
  dryRunPass: false; // always false by policy
  claimWithoutEvidenceAccepted: false;
  ok: boolean;
}

export function runLanguageConformance(language: LanguageId): LanguageConformanceReport {
  const pack = LANGUAGE_GATE_PACKS[language];
  const dry = runLanguageGatePack(language, { dryRun: true });
  const claim = acceptPackClaim({ packId: language, claimedPass: true });
  return {
    language,
    checkIds: pack.checks.map((c) => c.id),
    dryRunPass: false,
    claimWithoutEvidenceAccepted: false,
    ok:
      pack.checks.length >= 2 &&
      !dry.pass &&
      !claim.accepted &&
      dry.evidence.every((e) => e.status === 'not_run'),
  };
}

export function runAllLanguageConformance(): {
  reports: LanguageConformanceReport[];
  ok: boolean;
} {
  const reports = listLanguageGatePacks().map((p) => runLanguageConformance(p.id));
  return { reports, ok: reports.length === 7 && reports.every((r) => r.ok) };
}
