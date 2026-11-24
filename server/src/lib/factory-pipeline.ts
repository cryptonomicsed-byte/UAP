// P-46 Factory integration: Smithers (build) + SkillForge (packs) + REA (eval) (V6 factory track)
import { createHash, randomBytes } from 'node:crypto';

export type FactoryStage = 'smithers_build' | 'skillforge_pack' | 'rea_eval' | 'promote' | 'reject';

export interface FactoryJob {
  id: string;
  projectId: string;
  stage: FactoryStage;
  artifactHash: string | null;
  packId: string | null;
  packVersion: string | null;
  reaScore: number | null;
  reaReportId: string | null;
  blockers: string[];
  history: { stage: FactoryStage; at: string; note: string }[];
}

export interface SmithersBuildInput {
  projectId: string;
  sourceHash: string;
  languageGatePackId?: string;
}

export interface ReaEvalInput {
  artifactHash: string;
  suiteId: string;
  /** Independent REA score 0-1 — not model self-score */
  score: number;
  findings: string[];
}

const REA_PASS_THRESHOLD = 0.8;

export function createFactoryJob(projectId: string): FactoryJob {
  return {
    id: `fac_${randomBytes(6).toString('hex')}`,
    projectId,
    stage: 'smithers_build',
    artifactHash: null,
    packId: null,
    packVersion: null,
    reaScore: null,
    reaReportId: null,
    blockers: [],
    history: [{ stage: 'smithers_build', at: new Date().toISOString(), note: 'created' }],
  };
}

/** Smithers: produce build artifact hash from source (V6 factory build). */
export function smithersBuild(job: FactoryJob, input: SmithersBuildInput): FactoryJob {
  if (job.stage !== 'smithers_build' && job.stage !== 'reject') {
    throw Object.assign(new Error(`smithers only from build stage, got ${job.stage}`), {
      code: 'factory_stage_invalid',
    });
  }
  if (input.projectId !== job.projectId) {
    throw Object.assign(new Error('project mismatch'), { code: 'factory_project_mismatch' });
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceHash)) {
    job.blockers.push('invalid_source_hash');
    job.stage = 'reject';
    return job;
  }
  const artifactHash = createHash('sha256')
    .update(`smithers|${input.sourceHash}|${input.languageGatePackId ?? ''}`)
    .digest('hex');
  job.artifactHash = artifactHash;
  job.stage = 'skillforge_pack';
  job.blockers = [];
  job.history.push({ stage: 'skillforge_pack', at: new Date().toISOString(), note: 'build_ok' });
  return job;
}

/** SkillForge: bind artifact into versioned pack (must not skip REA). */
export function skillforgeAttachPack(
  job: FactoryJob,
  pack: { id: string; version: string },
): FactoryJob {
  if (job.stage !== 'skillforge_pack') {
    throw Object.assign(new Error('pack attach only after smithers'), { code: 'factory_stage_invalid' });
  }
  if (!job.artifactHash) {
    job.blockers.push('missing_artifact');
    job.stage = 'reject';
    return job;
  }
  job.packId = pack.id;
  job.packVersion = pack.version;
  job.stage = 'rea_eval';
  job.history.push({ stage: 'rea_eval', at: new Date().toISOString(), note: `pack:${pack.id}@${pack.version}` });
  return job;
}

/**
 * REA independent evaluation — required before promote.
 * Model self-score must not be passed here; only REA suite results.
 */
export function reaEvaluate(job: FactoryJob, input: ReaEvalInput): FactoryJob {
  if (job.stage !== 'rea_eval') {
    throw Object.assign(new Error('rea only after pack'), { code: 'factory_stage_invalid' });
  }
  if (input.artifactHash !== job.artifactHash) {
    job.blockers.push('rea_artifact_mismatch');
    job.stage = 'reject';
    return job;
  }
  job.reaScore = input.score;
  job.reaReportId = createHash('sha256')
    .update(JSON.stringify({ suite: input.suiteId, score: input.score, findings: input.findings }))
    .digest('hex')
    .slice(0, 32);

  if (input.score < REA_PASS_THRESHOLD) {
    job.blockers.push('rea_below_threshold');
    job.stage = 'reject';
    job.history.push({ stage: 'reject', at: new Date().toISOString(), note: `rea=${input.score}` });
    return job;
  }
  if (input.findings.some((f) => f.startsWith('critical:'))) {
    job.blockers.push('rea_critical_finding');
    job.stage = 'reject';
    return job;
  }
  job.stage = 'promote';
  job.blockers = [];
  job.history.push({ stage: 'promote', at: new Date().toISOString(), note: 'rea_pass' });
  return job;
}

export function assertFactoryPromoteAllowed(job: FactoryJob): void {
  if (job.stage !== 'promote') {
    throw Object.assign(new Error(`cannot promote from ${job.stage}`), { code: 'factory_promote_denied' });
  }
  if (!job.artifactHash || !job.packId || !job.packVersion || job.reaScore == null || !job.reaReportId) {
    throw Object.assign(new Error('incomplete factory evidence'), { code: 'factory_evidence_incomplete' });
  }
  if (job.blockers.length) {
    throw Object.assign(new Error('blockers present'), { code: 'factory_blockers' });
  }
}

/** Reject skipping REA (SkillForge claim alone insufficient). */
export function attemptPromoteWithoutRea(job: FactoryJob): never {
  throw Object.assign(new Error('REA evaluation required before promote'), {
    code: 'factory_rea_required',
    stage: job.stage,
  });
}
