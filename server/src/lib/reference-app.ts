// P-47 Reference app deployment evidence + unrelated-SID isolation test helpers
import { createHash } from 'node:crypto';

export interface ReferenceAppDeploy {
  appId: string;
  version: string;
  artifactHash: string;
  factoryJobId: string;
  tenantId: string;
  sidBindings: string[];
  deployedAt: string;
}

export function recordReferenceDeploy(input: {
  appId: string;
  version: string;
  artifactHash: string;
  factoryJobId: string;
  tenantId: string;
  sidBindings: string[];
}): ReferenceAppDeploy {
  if (!input.sidBindings.length) {
    throw Object.assign(new Error('reference app needs at least one SID binding'), {
      code: 'refapp_sid_required',
    });
  }
  if (!/^[a-f0-9]{64}$/.test(input.artifactHash)) {
    throw Object.assign(new Error('bad artifact hash'), { code: 'refapp_artifact_invalid' });
  }
  return {
    ...input,
    deployedAt: new Date().toISOString(),
  };
}

/**
 * Unrelated SID must not observe or control another app's bindings (P-47).
 */
export function assertUnrelatedSidIsolated(input: {
  deploy: ReferenceAppDeploy;
  probingSid: string;
  action: 'read_config' | 'invoke' | 'bind';
}): { allowed: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.deploy.sidBindings.includes(input.probingSid)) {
    blockers.push('sid_not_bound_to_app');
    if (input.action === 'bind') blockers.push('cross_app_sid_bind_denied');
    if (input.action === 'invoke') blockers.push('cross_app_invoke_denied');
    if (input.action === 'read_config') blockers.push('cross_app_read_denied');
  }
  return { allowed: blockers.length === 0, blockers };
}

export function deployReceiptHash(d: ReferenceAppDeploy): string {
  return createHash('sha256')
    .update(JSON.stringify({
      appId: d.appId,
      version: d.version,
      artifactHash: d.artifactHash,
      factoryJobId: d.factoryJobId,
      tenantId: d.tenantId,
      sidBindings: [...d.sidBindings].sort(),
      deployedAt: d.deployedAt,
    }))
    .digest('hex');
}
