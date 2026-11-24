import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TIERS,
  listFiveTiers,
  createTenant,
  meterCredits,
  oneClickInstall,
  downgradeTier,
  isExpired,
  assertTenantIsolation,
  makeMarketplaceItem,
} from '../server/src/lib/marketplace.ts';

test('Q-49 five tiers with real quotas', () => {
  const tiers = listFiveTiers();
  assert.equal(tiers.length, 5);
  assert.ok(TIERS.free.monthlyCredits < TIERS.builder.monthlyCredits);
  assert.ok(TIERS.enterprise.monthlyCredits > TIERS.business.monthlyCredits);
});

test('Q-48 one-click install signed pack within tier', () => {
  const t = createTenant('builder');
  const item = makeMarketplaceItem({ name: 'tools', minTier: 'free', signed: true });
  const r = oneClickInstall(t, item);
  assert.equal(r.ok, true);
  assert.ok(r.installId);
  assert.ok(t.installs.includes(item.id));
});

test('Q-48 rejects unsigned and tier-too-low', () => {
  const t = createTenant('free');
  const unsigned = makeMarketplaceItem({ name: 'x', signed: false });
  assert.equal(oneClickInstall(t, unsigned).ok, false);
  const entOnly = makeMarketplaceItem({ name: 'ent', minTier: 'enterprise', signed: true });
  assert.ok(oneClickInstall(t, entOnly).blockers.includes('tier_too_low'));
});

test('Q-49 metering exhausts credits', () => {
  const t = createTenant('free');
  assert.equal(meterCredits(t, 500).ok, true);
  assert.equal(meterCredits(t, 600).ok, false);
  assert.ok(meterCredits(t, 600).blockers.includes('credits_exhausted'));
});

test('Q-50 downgrade blocked when over quota; expiry blocks meter', () => {
  const t = createTenant('team');
  t.agents = 40;
  const d = downgradeTier(t, 'builder');
  assert.equal(d.ok, false);
  assert.ok(d.blockers.includes('agents_over_quota'));

  t.agents = 5;
  t.installs = [];
  assert.equal(downgradeTier(t, 'builder').ok, true);
  assert.equal(t.tier, 'builder');

  const exp = createTenant('free', '2020-01-01T00:00:00.000Z');
  assert.equal(isExpired(exp), true);
  assert.ok(meterCredits(exp, 1).blockers.includes('tenant_expired'));
});

test('Q-50 cross-tenant isolation', () => {
  const a = createTenant('team');
  const b = createTenant('team');
  const r = assertTenantIsolation(a, b, 'install');
  assert.equal(r.allowed, false);
  assert.ok(r.blockers.includes('cross_tenant_install_denied'));
  assert.equal(assertTenantIsolation(a, a, 'read_installs').allowed, true);
});
