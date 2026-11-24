// K-37 Role-routing isolation + per-project language skill version selection/rollback (V6-11-08..09)
import { createHash } from 'node:crypto';
import type { LanguageId } from './language-gates.js';
import { getLanguageGatePack, LANGUAGE_GATE_PACKS } from './language-gates.js';

export type RoleFamily =
  | 'engineering'
  | 'design'
  | 'research'
  | 'ops'
  | 'governance'
  | 'creative'
  | 'general';

/** Which language packs a role family may load by default. Empty = none. */
export const FAMILY_LANGUAGE_ALLOWLIST: Record<RoleFamily, readonly LanguageId[]> = {
  engineering: ['rust', 'elixir', 'julia', 'move', 'go', 'python', 'clojure'],
  design: [], // design roles must not pull coding language packs by default
  research: ['python', 'julia'], // numerical/data only
  ops: ['go', 'python', 'rust'],
  governance: [],
  creative: [],
  general: [], // generalist never auto-loads specialized language packs
};

export interface ProjectLanguagePin {
  language: LanguageId;
  version: string;
  pinnedAt: string;
  pinnedBy: string;
}

export interface ProjectLanguageState {
  projectId: string;
  pins: ProjectLanguagePin[];
  /** prior pins for rollback (newest last) */
  history: ProjectLanguagePin[];
}

export interface RouteRequest {
  roleId: string;
  roleFamily: RoleFamily;
  /** languages the agent or caller asked to load */
  requestedLanguages: LanguageId[];
  /** optional explicit project pins */
  projectState?: ProjectLanguageState;
}

export interface RoutedLanguageSkill {
  language: LanguageId;
  version: string;
  packDigest: string;
  source: 'request' | 'project_pin' | 'denied';
}

export interface RouteResult {
  allowed: RoutedLanguageSkill[];
  denied: { language: LanguageId; reason: string }[];
  isolationOk: boolean;
}

export function routeLanguageSkills(req: RouteRequest): RouteResult {
  const allow = new Set(FAMILY_LANGUAGE_ALLOWLIST[req.roleFamily] ?? []);
  const allowed: RoutedLanguageSkill[] = [];
  const denied: { language: LanguageId; reason: string }[] = [];
  const pinMap = new Map(
    (req.projectState?.pins ?? []).map((p) => [p.language, p] as const),
  );

  // Only consider requested languages — never auto-load the whole allowlist
  for (const lang of req.requestedLanguages) {
    if (!allow.has(lang)) {
      denied.push({ language: lang, reason: `family_${req.roleFamily}_denies_${lang}` });
      continue;
    }
    const pin = pinMap.get(lang);
    const version = pin?.version ?? LANGUAGE_GATE_PACKS[lang]?.version;
    const pack = version ? getLanguageGatePack(lang, version) : getLanguageGatePack(lang);
    if (!pack) {
      denied.push({ language: lang, reason: `unknown_or_unpinned_version:${lang}@${version}` });
      continue;
    }
    allowed.push({
      language: lang,
      version: pack.version,
      packDigest: pack.digest,
      source: pin ? 'project_pin' : 'request',
    });
  }

  // Isolation: no denied language may appear in allowed; no contradictory dual-load
  const allowedIds = new Set(allowed.map((a) => a.language));
  for (const d of denied) {
    if (allowedIds.has(d.language)) {
      return {
        allowed: [],
        denied: [...denied, { language: d.language, reason: 'isolation_violation' }],
        isolationOk: false,
      };
    }
  }

  return { allowed, denied, isolationOk: true };
}

/** Pin a language pack version for a project (V6-11-09). */
export function pinLanguageVersion(
  state: ProjectLanguageState,
  language: LanguageId,
  version: string,
  pinnedBy: string,
  at = new Date().toISOString(),
): ProjectLanguageState {
  const pack = getLanguageGatePack(language, version);
  if (!pack) {
    throw Object.assign(new Error(`cannot pin unknown ${language}@${version}`), {
      code: 'language_pin_unknown',
    });
  }
  const prev = state.pins.find((p) => p.language === language);
  const history = [...state.history];
  if (prev) history.push(prev);
  const pins = state.pins.filter((p) => p.language !== language);
  pins.push({ language, version, pinnedAt: at, pinnedBy });
  return { projectId: state.projectId, pins, history };
}

/** Roll back one language to previous pin, or clear if no history. */
export function rollbackLanguageVersion(
  state: ProjectLanguageState,
  language: LanguageId,
): ProjectLanguageState {
  const histIdx = [...state.history].map((h, i) => ({ h, i })).filter((x) => x.h.language === language).pop();
  const pins = state.pins.filter((p) => p.language !== language);
  const history = [...state.history];
  if (histIdx) {
    pins.push(histIdx.h);
    history.splice(histIdx.i, 1);
  }
  return { projectId: state.projectId, pins, history };
}

export function emptyProjectLanguageState(projectId: string): ProjectLanguageState {
  return { projectId, pins: [], history: [] };
}

/** Detect contradictory load: same role requesting languages outside family allowlist. */
export function assertNoContradictorySkills(req: RouteRequest): void {
  const r = routeLanguageSkills(req);
  if (!r.isolationOk) {
    throw Object.assign(new Error('language skill isolation violated'), {
      code: 'language_isolation_violation',
      result: r,
    });
  }
  // Design/governance/creative/general must not silently get engineering packs
  if ((FAMILY_LANGUAGE_ALLOWLIST[req.roleFamily] ?? []).length === 0 && r.allowed.length > 0) {
    throw Object.assign(new Error('family must not load language packs'), {
      code: 'language_family_isolation',
      result: r,
    });
  }
}

export function selectionDigest(allowed: RoutedLanguageSkill[]): string {
  const canonical = JSON.stringify(
    [...allowed].sort((a, b) => a.language.localeCompare(b.language)).map((a) => ({
      l: a.language, v: a.version, d: a.packDigest,
    })),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
