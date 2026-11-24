// J-33 Design gates — DESIGN.md required + design persona binding (V6-10)
import fs from 'node:fs';
import path from 'node:path';

export type DesignGateCode =
  | 'design_md_missing'
  | 'design_md_unreadable'
  | 'design_md_no_frontmatter'
  | 'design_md_missing_name'
  | 'design_md_missing_colors'
  | 'design_md_missing_primary'
  | 'design_persona_missing'
  | 'ok';

export interface DesignGateFinding {
  code: DesignGateCode;
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  path?: string;
}

export interface DesignGateResult {
  ok: boolean;
  nogo: boolean;
  findings: DesignGateFinding[];
  designMdPath?: string;
  designName?: string;
  personas: { creativeDirector: boolean; realityChecker: boolean; brandDirector: boolean; motionDirector: boolean };
}

const DESIGN_PERSONA_SLUGS = {
  creativeDirector: ['brand-director', 'creative-director'],
  realityChecker: ['reality-checker'],
  brandDirector: ['brand-director'],
  motionDirector: ['motion-director'],
} as const;

/** Resolve DESIGN.md from project root candidates. */
export function findDesignMd(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, 'DESIGN.md'),
    path.join(projectRoot, 'docs', 'DESIGN.md'),
    path.join(projectRoot, 'docs', 'design', 'DESIGN.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/** Parse YAML front matter block (--- ... ---) without a full YAML dependency. */
export function parseDesignFrontmatter(text: string): { ok: boolean; fields: Record<string, string>; error?: string } {
  if (!text.startsWith('---')) {
    return { ok: false, fields: {}, error: 'missing opening ---' };
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { ok: false, fields: {}, error: 'missing closing ---' };
  const block = text.slice(3, end).trim();
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      fields[currentKey] = m[2].replace(/^["']|["']$/g, '').trim();
    } else if (currentKey && /^\s+/.test(line)) {
      // nested line under colors/typography — mark parent as present
      fields[currentKey] = fields[currentKey] || '(object)';
      const nested = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (nested) fields[`${currentKey}.${nested[1]}`] = nested[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { ok: true, fields };
}

export function listRolePersonaSlugs(rolesDir: string): string[] {
  if (!fs.existsSync(rolesDir)) return [];
  return fs.readdirSync(rolesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

/**
 * Evaluate design gates for a project tree.
 * nogo=true when any blocker finding exists (release must not proceed).
 */
export function evaluateDesignGates(projectRoot: string, opts?: { rolesDir?: string }): DesignGateResult {
  const findings: DesignGateFinding[] = [];
  const rolesDir = opts?.rolesDir ?? path.join(projectRoot, 'docs', 'roles');
  const slugs = listRolePersonaSlugs(rolesDir);

  const personas = {
    creativeDirector: DESIGN_PERSONA_SLUGS.creativeDirector.some((s) => slugs.includes(s)),
    realityChecker: DESIGN_PERSONA_SLUGS.realityChecker.some((s) => slugs.includes(s)),
    brandDirector: DESIGN_PERSONA_SLUGS.brandDirector.some((s) => slugs.includes(s)),
    motionDirector: DESIGN_PERSONA_SLUGS.motionDirector.some((s) => slugs.includes(s)),
  };

  if (!personas.realityChecker) {
    findings.push({
      code: 'design_persona_missing',
      severity: 'blocker',
      message: 'Reality Checker persona missing under docs/roles (reality-checker.md)',
      path: path.join(rolesDir, 'reality-checker.md'),
    });
  }
  if (!personas.creativeDirector && !personas.brandDirector) {
    findings.push({
      code: 'design_persona_missing',
      severity: 'blocker',
      message: 'Creative/Brand Director persona missing (brand-director.md or creative-director.md)',
      path: rolesDir,
    });
  } else if (!personas.motionDirector) {
    findings.push({
      code: 'design_persona_missing',
      severity: 'warning',
      message: 'Motion Director persona optional but recommended (motion-director.md)',
      path: path.join(rolesDir, 'motion-director.md'),
    });
  }

  const designMdPath = findDesignMd(projectRoot);
  if (!designMdPath) {
    findings.push({
      code: 'design_md_missing',
      severity: 'blocker',
      message: 'DESIGN.md not found (looked in ./DESIGN.md, docs/DESIGN.md, docs/design/DESIGN.md)',
    });
  } else {
    let text: string;
    try {
      text = fs.readFileSync(designMdPath, 'utf8');
    } catch (e: any) {
      findings.push({
        code: 'design_md_unreadable',
        severity: 'blocker',
        message: `Cannot read DESIGN.md: ${e?.message ?? e}`,
        path: designMdPath,
      });
      text = '';
    }
    if (text) {
      const fm = parseDesignFrontmatter(text);
      if (!fm.ok) {
        findings.push({
          code: 'design_md_no_frontmatter',
          severity: 'blocker',
          message: `DESIGN.md front matter invalid: ${fm.error}`,
          path: designMdPath,
        });
      } else {
        if (!fm.fields.name) {
          findings.push({
            code: 'design_md_missing_name',
            severity: 'blocker',
            message: 'DESIGN.md front matter requires name:',
            path: designMdPath,
          });
        }
        if (!fm.fields.colors && !fm.fields['colors.primary']) {
          findings.push({
            code: 'design_md_missing_colors',
            severity: 'blocker',
            message: 'DESIGN.md front matter requires colors: (with at least primary)',
            path: designMdPath,
          });
        } else if (!fm.fields['colors.primary'] && fm.fields.colors !== '(object)') {
          // colors: present as scalar only
          if (!String(fm.fields.colors || '').includes('#')) {
            findings.push({
              code: 'design_md_missing_primary',
              severity: 'warning',
              message: 'DESIGN.md colors.primary not found; prefer an explicit primary accent',
              path: designMdPath,
            });
          }
        } else if (fm.fields.colors === '(object)' && !fm.fields['colors.primary']) {
          findings.push({
            code: 'design_md_missing_primary',
            severity: 'blocker',
            message: 'DESIGN.md colors block must include primary:',
            path: designMdPath,
          });
        }

        const result: DesignGateResult = {
          ok: findings.every((f) => f.severity !== 'blocker'),
          nogo: findings.some((f) => f.severity === 'blocker'),
          findings,
          designMdPath,
          designName: fm.fields.name,
          personas,
        };
        return result;
      }
    }
  }

  return {
    ok: findings.every((f) => f.severity !== 'blocker'),
    nogo: findings.some((f) => f.severity === 'blocker'),
    findings,
    designMdPath: designMdPath ?? undefined,
    personas,
  };
}

/** Hard gate: throw if NO-GO. */
export function assertDesignGatesPass(projectRoot: string): DesignGateResult {
  const result = evaluateDesignGates(projectRoot);
  if (result.nogo) {
    const blockers = result.findings.filter((f) => f.severity === 'blocker').map((f) => f.code).join(', ');
    throw Object.assign(new Error(`Design NO-GO: ${blockers}`), { code: 'design_nogo', result });
  }
  return result;
}
