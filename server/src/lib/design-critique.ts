// J-35 Design critique rubric + release NO-GO enforcement (V6-10-11..12)
import fs from 'node:fs';
import { evaluateDesignGates, type DesignGateResult } from './design-gates.js';

export type CritiqueDimension =
  | 'hierarchy'
  | 'consistency'
  | 'accessibility'
  | 'motion'
  | 'density'
  | 'honesty'
  | 'distinctiveness';

export interface CritiqueScore {
  dimension: CritiqueDimension;
  score: number; // 0-5
  notes: string;
}

export interface CritiqueReport {
  projectRoot: string;
  scoredAt: string;
  scores: CritiqueScore[];
  average: number;
  pass: boolean;
  nogo: boolean;
  designGates: DesignGateResult;
  blockers: string[];
  rubricVersion: 'j35-v1';
}

/** Minimum average to pass independent design critique (human-calibrated floor). */
export const CRITIQUE_PASS_AVERAGE = 3.5;

/** Any single dimension below this is a blocker. */
export const CRITIQUE_DIMENSION_FLOOR = 2;

export const RUBRIC: Record<CritiqueDimension, string> = {
  hierarchy: 'One clear primary action; type/weight establish order without boxes-as-hierarchy',
  consistency: 'Tokens from DESIGN.md used; no one-off colors/radii; light+dark coherent',
  accessibility: 'Focus visible, contrast AA, 44px coarse targets, reduced-motion respected',
  motion: 'Motion clarifies state only; none required to understand UI; reduced-motion zero',
  density: 'Operate-surface density; no marketing hero; empty/error/loading are real states',
  honesty: 'No fake metrics, dead controls, or success claims without evidence',
  distinctiveness: 'Not generic indigo SaaS; brand accent deliberate; no glassmorphism sludge',
};

export function scoreCritique(scores: CritiqueScore[]): { average: number; blockers: string[] } {
  if (scores.length === 0) return { average: 0, blockers: ['no_scores'] };
  for (const s of scores) {
    if (s.score < 0 || s.score > 5 || !Number.isFinite(s.score)) {
      throw Object.assign(new Error(`invalid score for ${s.dimension}`), { code: 'critique_invalid_score' });
    }
  }
  const average = scores.reduce((a, s) => a + s.score, 0) / scores.length;
  const blockers: string[] = [];
  for (const s of scores) {
    if (s.score < CRITIQUE_DIMENSION_FLOOR) blockers.push(`dimension_floor:${s.dimension}`);
  }
  if (average < CRITIQUE_PASS_AVERAGE) blockers.push('average_below_pass');
  return { average, blockers };
}

export function evaluateReleaseNogo(input: {
  projectRoot: string;
  critiqueScores?: CritiqueScore[];
  uiQaManifestPath?: string;
  requireUiQa?: boolean;
}): CritiqueReport {
  const designGates = evaluateDesignGates(input.projectRoot);
  const blockers: string[] = [];

  if (designGates.nogo) {
    for (const f of designGates.findings.filter((x) => x.severity === 'blocker')) {
      blockers.push(`design_gate:${f.code}`);
    }
  }

  const scores = input.critiqueScores ?? [];
  let average = 0;
  if (scores.length) {
    const s = scoreCritique(scores);
    average = s.average;
    blockers.push(...s.blockers);
  } else {
    blockers.push('critique_missing');
  }

  if (input.requireUiQa) {
    const p = input.uiQaManifestPath;
    if (!p || !fs.existsSync(p)) blockers.push('ui_qa_manifest_missing');
    else {
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (m.harness !== 'j34-ui-qa' || !Array.isArray(m.shots) || m.shots.length < 6) {
          blockers.push('ui_qa_manifest_incomplete');
        }
      } catch {
        blockers.push('ui_qa_manifest_unreadable');
      }
    }
  }

  const nogo = blockers.length > 0;
  return {
    projectRoot: input.projectRoot,
    scoredAt: new Date().toISOString(),
    scores,
    average,
    pass: !nogo,
    nogo,
    designGates,
    blockers,
    rubricVersion: 'j35-v1',
  };
}

export function assertReleaseAllowed(report: CritiqueReport): void {
  if (report.nogo) {
    throw Object.assign(new Error(`Release NO-GO: ${report.blockers.join(', ')}`), {
      code: 'release_nogo',
      report,
    });
  }
}
