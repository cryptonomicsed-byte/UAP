// SkillForge Main Entry - exports and routes
export { SkillPackVersion, SkillCandidate, ToolDescriptor, SideEffect, SkillDependency, SignedCapabilityPack, SignedGrant, Budget, GrantCondition, SkillDrainPlan } from './types.js';
export { SkillForgeRegistry } from './registry.js';
export { SkillForgeLoader } from './loader.js';
export { SkillForgeReviewQueue } from './review-queue.js';

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
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  await SkillForgeRegistry.init();
  await SkillForgeReviewQueue.init();
}

// Review Queue API
export async function submitForReview(candidateId: string, packId: string, submitter: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.submitForReview(candidateId, packId, submitter);
}

export async function assignReviewer(itemId: string, reviewer: string, reviewerRole: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.assignReviewer(itemId, reviewer, reviewerRole);
}

export async function approveReview(itemId: string, reviewer: string, signature: string, notes?: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.approve(itemId, reviewer, signature, notes);
}

export async function rejectReview(itemId: string, reviewer: string, notes?: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.reject(itemId, reviewer, notes);
}

export async function publishPack(packId: string, version: string, publisher: string, approvalSignature: string, previousVersion?: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.publish(packId, version, publisher, approvalSignature, previousVersion);
}

export async function rollbackPack(plan: any) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.rollback(plan);
}

export async function getReviewQueue(status?: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.getQueue(status);
}

export async function getPublishHistory(packId?: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.getPublishHistory(packId);
}

export async function getRollbackHistory(packId?: string) {
  const { SkillForgeReviewQueue } = await import('./review-queue.js');
  return SkillForgeReviewQueue.getRollbackHistory(packId);
}