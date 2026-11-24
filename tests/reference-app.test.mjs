import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  recordReferenceDeploy,
  assertUnrelatedSidIsolated,
  deployReceiptHash,
} from '../server/src/lib/reference-app.ts';

const art = createHash('sha256').update('app').digest('hex');

test('P-47 reference deploy records bindings', () => {
  const d = recordReferenceDeploy({
    appId: 'ref-chat',
    version: '1.0.0',
    artifactHash: art,
    factoryJobId: 'fac_1',
    tenantId: 't1',
    sidBindings: ['sid_a', 'sid_b'],
  });
  assert.equal(d.sidBindings.length, 2);
  assert.equal(deployReceiptHash(d).length, 64);
});

test('P-47 unrelated SID cannot invoke or read', () => {
  const d = recordReferenceDeploy({
    appId: 'ref-chat',
    version: '1.0.0',
    artifactHash: art,
    factoryJobId: 'fac_1',
    tenantId: 't1',
    sidBindings: ['sid_a'],
  });
  const inv = assertUnrelatedSidIsolated({ deploy: d, probingSid: 'sid_other', action: 'invoke' });
  assert.equal(inv.allowed, false);
  assert.ok(inv.blockers.includes('cross_app_invoke_denied'));
  const ok = assertUnrelatedSidIsolated({ deploy: d, probingSid: 'sid_a', action: 'invoke' });
  assert.equal(ok.allowed, true);
});

test('P-47 deploy requires SID binding', () => {
  assert.throws(
    () => recordReferenceDeploy({
      appId: 'x',
      version: '1',
      artifactHash: art,
      factoryJobId: 'f',
      tenantId: 't',
      sidBindings: [],
    }),
    (e) => e.code === 'refapp_sid_required',
  );
});
