/**
 * B-20 / V6-02-10: tenant policy filtering of catalog contents.
 *
 * Filtering is closed by default: an entry with no domain tags is invisible to a
 * tenant with a domain policy, and an entry whose risk class is still
 * `unclassified` is invisible regardless of policy. Every hidden entry carries
 * its reason so the UI cannot silently drop a source the operator expected.
 */

export type RiskClass = 'low' | 'medium' | 'high' | 'critical' | 'unclassified';

export interface CatalogEntry {
  readonly sourceId: string;
  readonly domains: readonly string[];
  readonly supportedTools: readonly string[];
  readonly riskClass: RiskClass;
  readonly [key: string]: unknown;
}

export interface TenantSourcePolicy {
  readonly domains: readonly string[];
  readonly supportedTools: readonly string[];
  readonly maxRisk: Exclude<RiskClass, 'unclassified'>;
}

export interface HiddenCatalogEntry {
  readonly sourceId: string;
  readonly reason: 'risk_unclassified' | 'risk_exceeds_policy' | 'no_domain_match' | 'no_supported_tool_match';
}

const RISK_ORDER: Record<Exclude<RiskClass, 'unclassified'>, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function filterCatalogForTenant<T extends CatalogEntry>(entries: readonly T[], policy: TenantSourcePolicy): { visible: T[]; hidden: HiddenCatalogEntry[] } {
  const visible: T[] = [];
  const hidden: HiddenCatalogEntry[] = [];
  const domains = new Set(policy.domains.map((domain) => domain.toLowerCase()));
  const tools = new Set(policy.supportedTools.map((tool) => tool.toLowerCase()));
  for (const entry of entries) {
    if (entry.riskClass === 'unclassified') { hidden.push({ sourceId: entry.sourceId, reason: 'risk_unclassified' }); continue; }
    if (RISK_ORDER[entry.riskClass] > RISK_ORDER[policy.maxRisk]) { hidden.push({ sourceId: entry.sourceId, reason: 'risk_exceeds_policy' }); continue; }
    if (!entry.domains.some((domain) => domains.has(domain.toLowerCase()))) { hidden.push({ sourceId: entry.sourceId, reason: 'no_domain_match' }); continue; }
    if (!entry.supportedTools.some((tool) => tools.has(tool.toLowerCase()))) { hidden.push({ sourceId: entry.sourceId, reason: 'no_supported_tool_match' }); continue; }
    visible.push(entry);
  }
  return { visible, hidden };
}
