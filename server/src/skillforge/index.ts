// SkillForge Main Entry - exports and routes
export { SkillPackVersion, SkillCandidate, ToolDescriptor, SideEffect, SkillDependency, SignedCapabilityPack, SignedGrant, Budget, GrantCondition, SkillDrainPlan } from './types.js';
export { SkillForgeRegistry } from './registry.js';
export { SkillForgeLoader } from './loader.js';

// Static method wrappers for API routes
export async function listCandidates(status?: string) {
  const { SkillForgeRegistry } = await import('./registry.js');
  return SkillForgeRegistry.listCandidates(status as any);
}

export async function submitCandidate(candidate: any) {
  const { SkillForgeRegistry } = await import('./registry.js');
  return SkillForgeRegistry.submitCandidate(candidate);
}

export async function reviewCandidate(id: string, reviewer: string, status: 'approved' | 'rejected', notes?: string) {
  const { SkillForgeRegistry } = await import('./registry.js');
  await SkillForgeRegistry.reviewCandidate(id, reviewer, status, undefined);
  return { ok: true };
}

export async function listPacks(publisher?: string) {
  const { SkillForgeRegistry } = await import('./registry.js');
  return SkillForgeRegistry.listPacks(publisher);
}

export async function getPack(id: string) {
  const { SkillForgeRegistry } = await import('./registry.js');
  return SkillForgeRegistry.getPack(id);
}

export async function getCapabilityPack(id: string) {
  const { SkillForgeRegistry } = await import('./registry.js');
  return SkillForgeRegistry.getCapabilityPack(id);
}

export async function loadForRole(roleId: string, budgetTokens: number) {
  const { SkillForgeLoader } = await import('./loader.js');
  return SkillForgeLoader.loadForRole(roleId, budgetTokens);
}

export async function initRegistry() {
  const { SkillForgeRegistry } = await import('./registry.js');
  await SkillForgeRegistry.init();
}