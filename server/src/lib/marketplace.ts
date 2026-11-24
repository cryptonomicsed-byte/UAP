// Q-48..50 Marketplace, tiers/metering, tenant isolation (V6 marketplace track)
import { createHash, randomBytes } from 'node:crypto';

export type TierId = 'free' | 'builder' | 'team' | 'business' | 'enterprise';

export interface TierQuota {
  tier: TierId;
  monthlyCredits: number;
  maxAgents: number;
  maxTenants: number;
  marketplaceInstalls: number;
  retentionDays: number;
}

export const TIERS: Record<TierId, TierQuota> = {
  free: { tier: 'free', monthlyCredits: 1000, maxAgents: 2, maxTenants: 1, marketplaceInstalls: 3, retentionDays: 14 },
  builder: { tier: 'builder', monthlyCredits: 20_000, maxAgents: 10, maxTenants: 1, marketplaceInstalls: 25, retentionDays: 90 },
  team: { tier: 'team', monthlyCredits: 100_000, maxAgents: 50, maxTenants: 5, marketplaceInstalls: 100, retentionDays: 180 },
  business: { tier: 'business', monthlyCredits: 500_000, maxAgents: 200, maxTenants: 25, marketplaceInstalls: 500, retentionDays: 365 },
  enterprise: { tier: 'enterprise', monthlyCredits: 5_000_000, maxAgents: 2000, maxTenants: 1000, marketplaceInstalls: 10_000, retentionDays: 730 },
};

export interface MarketplaceItem {
  id: string;
  name: string;
  version: string;
  publisher: string;
  packDigest: string;
  signed: boolean;
  minTier: TierId;
}

export interface Tenant {
  id: string;
  tier: TierId;
  creditsUsed: number;
  agents: number;
  installs: string[];
  periodStart: string;
  expiresAt: string | null;
}

const TIER_RANK: Record<TierId, number> = {
  free: 0, builder: 1, team: 2, business: 3, enterprise: 4,
};

export function createTenant(tier: TierId, expiresAt: string | null = null): Tenant {
  return {
    id: `ten_${randomBytes(6).toString('hex')}`,
    tier,
    creditsUsed: 0,
    agents: 0,
    installs: [],
    periodStart: new Date().toISOString(),
    expiresAt,
  };
}

export function meterCredits(tenant: Tenant, amount: number): { ok: boolean; blockers: string[] } {
  if (isExpired(tenant)) return { ok: false, blockers: ['tenant_expired'] };
  const quota = TIERS[tenant.tier];
  if (tenant.creditsUsed + amount > quota.monthlyCredits) {
    return { ok: false, blockers: ['credits_exhausted'] };
  }
  tenant.creditsUsed += amount;
  return { ok: true, blockers: [] };
}

export function oneClickInstall(
  tenant: Tenant,
  item: MarketplaceItem,
): { ok: boolean; blockers: string[]; installId?: string } {
  const blockers: string[] = [];
  if (isExpired(tenant)) blockers.push('tenant_expired');
  if (!item.signed) blockers.push('unsigned_pack');
  if (TIER_RANK[tenant.tier] < TIER_RANK[item.minTier]) blockers.push('tier_too_low');
  if (tenant.installs.length >= TIERS[tenant.tier].marketplaceInstalls) {
    blockers.push('install_quota');
  }
  if (tenant.installs.includes(item.id)) blockers.push('already_installed');
  if (blockers.length) return { ok: false, blockers };
  tenant.installs.push(item.id);
  const installId = createHash('sha256')
    .update(`${tenant.id}|${item.id}|${item.version}|${item.packDigest}`)
    .digest('hex')
    .slice(0, 24);
  return { ok: true, blockers: [], installId };
}

export function downgradeTier(tenant: Tenant, to: TierId): { ok: boolean; blockers: string[] } {
  if (TIER_RANK[to] > TIER_RANK[tenant.tier]) {
    return { ok: false, blockers: ['use_upgrade_path'] };
  }
  const quota = TIERS[to];
  const blockers: string[] = [];
  if (tenant.agents > quota.maxAgents) blockers.push('agents_over_quota');
  if (tenant.installs.length > quota.marketplaceInstalls) blockers.push('installs_over_quota');
  // Soft-block: require user to shed resources before downgrade completes
  if (blockers.length) return { ok: false, blockers };
  // Clamp credits used to new ceiling for remaining period (no free refill)
  tenant.tier = to;
  if (tenant.creditsUsed > quota.monthlyCredits) {
    // keep used over ceiling → further meter fails until period reset
  }
  return { ok: true, blockers: [] };
}

export function isExpired(tenant: Tenant, now = Date.now()): boolean {
  if (!tenant.expiresAt) return false;
  return Date.parse(tenant.expiresAt) <= now;
}

/** Q-50 tenant isolation: cross-tenant install/meter/read denied. */
export function assertTenantIsolation(a: Tenant, b: Tenant, action: 'read_installs' | 'meter' | 'install'): {
  allowed: boolean;
  blockers: string[];
} {
  if (a.id === b.id) return { allowed: true, blockers: [] };
  return {
    allowed: false,
    blockers: [`cross_tenant_${action}_denied`],
  };
}

export function listFiveTiers(): TierQuota[] {
  return (Object.keys(TIERS) as TierId[]).map((t) => TIERS[t]);
}

export function makeMarketplaceItem(partial: Partial<MarketplaceItem> & { name: string }): MarketplaceItem {
  return {
    id: partial.id ?? `mkt_${randomBytes(4).toString('hex')}`,
    name: partial.name,
    version: partial.version ?? '1.0.0',
    publisher: partial.publisher ?? 'uap',
    packDigest: partial.packDigest ?? createHash('sha256').update(partial.name).digest('hex'),
    signed: partial.signed ?? true,
    minTier: partial.minTier ?? 'free',
  };
}
