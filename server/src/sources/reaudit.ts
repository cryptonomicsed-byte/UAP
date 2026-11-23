/**
 * B-22 / V6-02-09: scheduled re-audit and revocation alerts.
 *
 * An audit is a dated claim, so it expires. `dueReaudits` turns the trust rung and the
 * source's risk class into a cadence, and surfaces three cases a scheduler must act on:
 * a cadence that has lapsed, a source that was never audited, and a revoked source that has
 * not been re-audited since the revocation.
 *
 * `matchAdvisories` joins external advisories (vulnerable package version, compromised
 * origin, archived upstream) against the pinned source metadata and produces deterministic
 * alerts. `applyAdvisory` is the only place that acts on them: critical findings revoke,
 * high findings quarantine, informational findings do not touch trust at all.
 */
import crypto from 'node:crypto';
import { TRUST_LEVELS, revokeSource, type QuarantineRecord, type RevocableSubject, type TrustStatus } from './trust.js';

const DAY = 86_400_000;

export const REAUDIT_POLICY = {
  cadenceDays: {
    USER_SUPPLIED_UNVERIFIED: 30,
    PUBLIC_LOCATED: 30,
    PINNED_SHA: 90,
    LICENSE_APPROVED: 180,
    STATIC_AUDITED: 90,
    SANDBOX_EVALUATED: 90,
    PUBLISHED: 30,
  } as Record<TrustStatus, number>,
  riskMultiplier: {
    low: 1.5,
    medium: 1,
    high: 0.5,
    critical: 0.25,
    unclassified: 1,
  } as Record<string, number>,
};

export type ReauditPolicy = typeof REAUDIT_POLICY;

export interface ReauditSource {
  readonly sourceId: string;
  readonly canonicalSlug?: string;
  readonly owner?: string;
  readonly trustStatus: TrustStatus;
  readonly riskClass?: string;
  readonly observedAt: number;
  readonly lastAuditedAt?: number | null;
  readonly revokedAt?: number | null;
  readonly dependencies?: readonly { readonly name: string; readonly version: string }[];
  readonly reviewerSignature?: RevocableSubject['reviewerSignature'];
  readonly revocations?: RevocableSubject['revocations'];
  readonly quarantinedBy?: readonly QuarantineRecord[];
}

export type ReauditReason = 'cadence' | 'never_audited' | 'revoked_pending_reaudit';

export interface ReauditEntry {
  readonly sourceId: string;
  readonly trustStatus: string;
  readonly riskClass: string;
  readonly dueAt: number;
  readonly daysOverdue: number;
  readonly overdue: boolean;
  readonly reason: ReauditReason;
}

export interface ReauditPlan {
  readonly schema: 'uap.source-reaudit-plan/1';
  readonly now: number;
  readonly due: readonly ReauditEntry[];
  readonly notDue: number;
}

// ---------- semver ----------

type Version = readonly [number, number, number];

const parseVersion = (value: string): Version | null => {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(value).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
};

const compare = (a: Version, b: Version): number => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

const bumpUpper = (base: Version, operator: '^' | '~'): Version => {
  if (operator === '~') return [base[0], base[1] + 1, 0];
  if (base[0] > 0) return [base[0] + 1, 0, 0];
  if (base[1] > 0) return [0, base[1] + 1, 0];
  return [0, 0, base[2] + 1];
};

const satisfiesComparator = (version: Version, comparator: string): boolean => {
  if (comparator === '*' || comparator === 'x' || comparator === 'X') return true;
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const base: Version = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  switch (operator) {
    case '^':
    case '~':
      return compare(version, base) >= 0 && compare(version, bumpUpper(base, operator)) < 0;
    case '>=':
      return compare(version, base) >= 0;
    case '<=':
      return compare(version, base) <= 0;
    case '>':
      return compare(version, base) > 0;
    case '<':
      return compare(version, base) < 0;
    default:
      // A partial exact pin follows npm: `1` is 1.x, `1.2` is 1.2.x, `1.2.3` is exact.
      if (match[4] !== undefined) return compare(version, base) === 0;
      return compare(version, base) >= 0 && compare(version, bumpUpper(base, '~')) < 0;
  }
};

/** npm-style range match for the subset advisories actually use. Unparseable input is false. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return String(range)
    .split('||')
    .some((alternative) => {
      const comparators = alternative.trim().split(/\s+/).filter(Boolean);
      return comparators.length > 0 && comparators.every((comparator) => satisfiesComparator(parsed, comparator));
    });
}

// ---------- cadence ----------

const cadenceDays = (status: TrustStatus, riskClass: string, policy: ReauditPolicy): number => {
  const base = policy.cadenceDays[status] ?? 90;
  const multiplier = policy.riskMultiplier[riskClass] ?? 1;
  return Math.max(1, Math.round(base * multiplier));
};

/**
 * Sources whose audit has lapsed, that were never audited, or that were revoked and not
 * re-audited. Deterministic: `now` is supplied and the output is sorted.
 */
export function dueReaudits(
  sources: readonly ReauditSource[],
  options: { readonly now: number; readonly policy?: ReauditPolicy },
): ReauditPlan {
  const { now } = options;
  const policy = options.policy ?? REAUDIT_POLICY;
  const due: ReauditEntry[] = [];

  for (const source of sources) {
    const riskClass = source.riskClass ?? 'unclassified';
    const common = { sourceId: source.sourceId, trustStatus: source.trustStatus as string, riskClass };

    if (source.revokedAt != null && (source.lastAuditedAt == null || source.lastAuditedAt <= source.revokedAt)) {
      due.push({ ...common, dueAt: source.revokedAt, daysOverdue: Math.floor((now - source.revokedAt) / DAY), overdue: true, reason: 'revoked_pending_reaudit' });
      continue;
    }
    if (source.lastAuditedAt == null) {
      due.push({ ...common, dueAt: source.observedAt, daysOverdue: Math.max(0, Math.floor((now - source.observedAt) / DAY)), overdue: true, reason: 'never_audited' });
      continue;
    }
    const dueAt = source.lastAuditedAt + cadenceDays(source.trustStatus, riskClass, policy) * DAY;
    if (now < dueAt) continue;
    due.push({ ...common, dueAt, daysOverdue: Math.floor((now - dueAt) / DAY), overdue: true, reason: 'cadence' });
  }

  due.sort((a, b) => (b.daysOverdue - a.daysOverdue) || a.sourceId.localeCompare(b.sourceId));
  return { schema: 'uap.source-reaudit-plan/1', now, due, notDue: sources.length - due.length };
}

// ---------- advisories ----------

export type AdvisoryKind = 'vulnerable-package' | 'compromised-origin' | 'archived-upstream' | 'license-changed';

export interface Advisory {
  readonly id: string;
  readonly kind: AdvisoryKind;
  readonly publishedAt: number;
  readonly package?: string;
  readonly affectedRange?: string;
  readonly severity?: 'low' | 'moderate' | 'high' | 'critical';
  readonly owner?: string;
  readonly repo?: string;
  readonly detail?: string;
}

export type AlertSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';
export type AlertAction = 'revoke_now' | 'quarantine' | 'note';

export interface TrustAlert {
  readonly id: string;
  readonly sourceId: string;
  readonly advisoryId: string;
  readonly kind: AdvisoryKind;
  readonly severity: AlertSeverity;
  readonly action: AlertAction;
  readonly reason: string;
  readonly matched: { readonly dependency?: string; readonly version?: string; readonly owner?: string };
  readonly at: number;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

const alertId = (sourceId: string, advisoryId: string): string =>
  `alert_${crypto.createHash('sha256').update(`${sourceId}|${advisoryId}`).digest('hex').slice(0, 16)}`;

const sourceOwner = (source: ReauditSource): string =>
  source.owner ?? (source.canonicalSlug ? source.canonicalSlug.split('/')[0] : '');

const sourceRepo = (source: ReauditSource): string =>
  source.canonicalSlug ? source.canonicalSlug.split('/')[1] ?? '' : '';

const vulnSeverity = (severity: string | undefined): { severity: AlertSeverity; action: AlertAction } => {
  switch (severity) {
    case 'critical':
      return { severity: 'critical', action: 'revoke_now' };
    case 'high':
      return { severity: 'high', action: 'quarantine' };
    case 'moderate':
      return { severity: 'moderate', action: 'note' };
    default:
      return { severity: 'low', action: 'note' };
  }
};

/**
 * Match advisories against sources. Duplicate advisory ids collapse (the first in sorted id
 * order wins), so a feed that repeats an advisory does not produce duplicate alerts.
 */
export function matchAdvisories(
  sources: readonly ReauditSource[],
  advisories: readonly Advisory[],
  options: { readonly now: number },
): { readonly schema: 'uap.source-reaudit-alerts/1'; readonly now: number; readonly alerts: readonly TrustAlert[]; readonly ignored: number } {
  const unique = new Map<string, Advisory>();
  for (const advisory of [...advisories].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!unique.has(advisory.id)) unique.set(advisory.id, advisory);
  }

  const alerts: TrustAlert[] = [];
  for (const source of sources) {
    for (const advisory of unique.values()) {
      const base = { id: alertId(source.sourceId, advisory.id), sourceId: source.sourceId, advisoryId: advisory.id, kind: advisory.kind, at: options.now };
      if (advisory.kind === 'vulnerable-package') {
        const hit = (source.dependencies ?? []).find((dependency) =>
          dependency.name === advisory.package && !!advisory.affectedRange && satisfies(dependency.version, advisory.affectedRange));
        if (!hit) continue;
        const { severity, action } = vulnSeverity(advisory.severity);
        alerts.push({
          ...base, severity, action,
          reason: `${hit.name}@${hit.version} falls inside ${advisory.affectedRange} (${advisory.id})`,
          matched: { dependency: hit.name, version: hit.version },
        });
        continue;
      }
      if (advisory.kind === 'compromised-origin') {
        const owner = sourceOwner(source);
        if (!owner || (advisory.owner && advisory.owner !== owner)) continue;
        alerts.push({
          ...base, severity: 'critical', action: 'revoke_now',
          reason: `origin owner ${owner} is reported compromised (${advisory.id})`,
          matched: { owner },
        });
        continue;
      }
      if (advisory.kind === 'archived-upstream') {
        const owner = sourceOwner(source);
        const repo = sourceRepo(source);
        if (!owner || (advisory.owner && advisory.owner !== owner) || (advisory.repo && advisory.repo !== repo)) continue;
        alerts.push({
          ...base, severity: 'info', action: 'note',
          reason: `upstream ${owner}/${repo || '*'} is archived; the pin still works but will not receive fixes`,
          matched: { owner },
        });
        continue;
      }
      // license-changed
      const owner = sourceOwner(source);
      if (!owner || (advisory.owner && advisory.owner !== owner)) continue;
      alerts.push({
        ...base, severity: 'moderate', action: 'note',
        reason: `licence or ownership of ${owner} changed; re-check the declared rights (${advisory.id})`,
        matched: { owner },
      });
    }
  }

  alerts.sort((a, b) => (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || a.sourceId.localeCompare(b.sourceId) || a.advisoryId.localeCompare(b.advisoryId));
  return { schema: 'uap.source-reaudit-alerts/1', now: options.now, alerts, ignored: advisories.length - unique.size };
}

// ---------- acting on an alert ----------

const rankOf = (status: string): number => (TRUST_LEVELS as readonly string[]).indexOf(status);
const QUARANTINE_FLOOR: TrustStatus = 'PUBLIC_LOCATED';

/**
 * Apply one alert. `revoke_now` revokes and clears the approval, `quarantine` demotes to the
 * quarantine floor while keeping the (now insufficient) reviewer record, and `note` returns
 * the source untouched. Idempotent per advisory id.
 */
export function applyAdvisory<T extends ReauditSource>(source: T, alert: TrustAlert, at: number): T {
  if (alert.action === 'note') return source;

  if (alert.action === 'revoke_now') {
    const already = (source.revocations ?? []).some((record) => record.advisoryId === alert.advisoryId);
    if (already) return source;
    return revokeSource(source, {
      reason: alert.kind === 'compromised-origin' ? 'compromised-origin' : 'vulnerable-package',
      detail: alert.reason,
      advisoryId: alert.advisoryId,
      at,
      by: `advisory:${alert.advisoryId}`,
    });
  }

  const quarantine = source.quarantinedBy ?? [];
  if (quarantine.some((record) => record.advisoryId === alert.advisoryId)) return source;
  // Demotion only: never invent an approval level the source did not hold.
  const demoted = rankOf(source.trustStatus) > rankOf(QUARANTINE_FLOOR) ? QUARANTINE_FLOOR : source.trustStatus;
  return {
    ...source,
    trustStatus: demoted,
    quarantinedBy: [...quarantine, { advisoryId: alert.advisoryId, severity: alert.severity, at }],
  } as T;
}
