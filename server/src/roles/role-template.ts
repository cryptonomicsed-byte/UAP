// RoleTemplate schema (V6-03-01).
//
// A role template is a versioned configuration object: stable id, version,
// source SHA, digest, rights, title and risk class. It is not an identity, not
// a process and not a grant — `requestedTools` is exactly that, a request that
// the policy kernel may refuse.
//
// The digest binds every reviewed field, so a template read back from any store
// can be re-verified without trusting that store (verifyRoleTemplate).
import { createHash } from 'node:crypto';
import type { SidRoleTemplate } from '../identity/sid.ts';

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';

export const RISK_CLASSES: readonly RiskClass[] = ['low', 'medium', 'high', 'critical'];

export interface RoleRights {
  license: string;
  sourceUrl: string;
  attribution: string;
}

export interface RoleTemplateInput {
  slug: string;
  publisher: string;
  version: number;
  sourceSha: string;
  sourcePath: string;
  title: string;
  riskClass: RiskClass;
  rights: RoleRights;
  instructions: string;
  requestedTools?: string[];
  evaluationSuite?: string | null;
}

export interface RoleTemplate {
  id: string;
  version: number;
  sourceSha: string;
  sourcePath: string;
  title: string;
  riskClass: RiskClass;
  rights: RoleRights & { status: 'declared' | 'unverified' };
  instructions: string;
  requestedTools: string[];
  evaluationSuite: string | null;
  digest: string;
}

export class RoleTemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RoleTemplateError';
    this.code = code;
  }
}

const DIGEST_FORMAT = 'uap-role-template/1';
const SOURCE_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TOOL_RE = /^[a-z0-9][a-z0-9_.:-]{0,80}$/;
const LICENSE_RE = /^[A-Za-z0-9.+:-]{1,64}$/;
const MAX_ID_LENGTH = 200;

function fail(code: string, message: string): never {
  throw new RoleTemplateError(code, message);
}

/** Lower-case and collapse anything that is not [a-z0-9] into a single dash. */
export const normalizeSegment = (value: string): string =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The id depends only on the publishing source and the role slug, never on the
 * version or the instructions — an upgrade keeps the identity of the role.
 */
export function roleTemplateId(publisher: string, slug: string): string {
  const rawPublisher = String(publisher ?? '').trim();
  const rawSlug = String(slug ?? '').trim();
  // A slug that looks like a path is refused, never silently mangled into a
  // different role: the id is the handle reviewers and grantees cite.
  if (/[\/\\]/.test(rawSlug) || rawSlug.includes('..') || rawSlug.length > 160) {
    fail('slug_invalid', 'slug must name a role, not a path');
  }
  if (/[\0-\x1f]/.test(rawSlug) || /[\0-\x1f]/.test(rawPublisher)) {
    fail('id_invalid', 'publisher and slug must not contain control characters');
  }
  const pub = normalizeSegment(rawPublisher);
  const sl = normalizeSegment(rawSlug);
  if (!pub || !sl) fail('id_invalid', 'publisher and slug must contain at least one alphanumeric');
  const id = `rt_${pub}_${sl}`;
  if (id.length > MAX_ID_LENGTH) fail('id_too_long', `role template id exceeds ${MAX_ID_LENGTH} characters`);
  return id;
}

/** Deterministic JSON: object keys sorted, so key order can never change a digest. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

interface DigestFields {
  id: string;
  version: number;
  sourceSha: string;
  sourcePath: string;
  title: string;
  riskClass: RiskClass;
  rights: RoleRights;
  instructions: string;
  requestedTools: string[];
  evaluationSuite: string | null;
}

export function roleTemplateDigest(fields: DigestFields): string {
  const payload = canonicalJson({
    format: DIGEST_FORMAT,
    id: fields.id,
    version: fields.version,
    sourceSha: fields.sourceSha,
    sourcePath: fields.sourcePath,
    title: fields.title,
    riskClass: fields.riskClass,
    rights: {
      license: fields.rights.license,
      sourceUrl: fields.rights.sourceUrl,
      attribution: fields.rights.attribution,
    },
    instructions: fields.instructions,
    requestedTools: fields.requestedTools,
    evaluationSuite: fields.evaluationSuite,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function requireText(value: unknown, code: string, field: string, max = 2000): string {
  if (typeof value !== 'string') fail(code, `${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) fail(code, `${field} must be 1..${max} characters`);
  return text;
}

function requireSourcePath(value: unknown): string {
  if (typeof value !== 'string') fail('source_path_invalid', 'sourcePath must be a string');
  const path = value.trim();
  const segments = path.split('/');
  if (
    !path ||
    path.length > 400 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some(segment => segment === '..' || segment === '.') ||
    !path.endsWith('.md')
  ) {
    fail('source_path_invalid', 'sourcePath must be a relative .md path inside the source repository');
  }
  return path;
}

function requireRights(value: unknown): RoleRights {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('rights_invalid', 'rights is required');
  const raw = value as Record<string, unknown>;
  const license = requireText(raw.license, 'rights_invalid', 'rights.license', 64);
  if (!LICENSE_RE.test(license)) fail('rights_invalid', 'rights.license must be an SPDX-style identifier or NOASSERTION');
  const sourceUrl = requireText(raw.sourceUrl, 'rights_invalid', 'rights.sourceUrl', 2000);
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return fail('rights_invalid', 'rights.sourceUrl must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('rights_invalid', 'rights.sourceUrl must be an absolute http(s) URL');
  }
  const attribution = requireText(raw.attribution, 'rights_invalid', 'rights.attribution', 400);
  return { license, sourceUrl, attribution };
}

function requireRequestedTools(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('requested_tool_invalid', 'requestedTools must be an array of tool names');
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !TOOL_RE.test(item)) {
      fail('requested_tool_invalid', `requested tool ${JSON.stringify(item)} is not a normalised tool name`);
    }
    out.add(item);
  }
  return [...out].sort();
}

/**
 * Build and freeze a role template. Unknown properties are dropped: a caller
 * cannot smuggle `grants` (or anything else) onto the object through input.
 */
export function buildRoleTemplate(input: RoleTemplateInput): RoleTemplate {
  if (!input || typeof input !== 'object') fail('input_invalid', 'role template input is required');

  const id = roleTemplateId(String(input.publisher ?? '').trim(), String(input.slug ?? '').trim());
  if (!Number.isInteger(input.version) || input.version < 1) {
    fail('version_invalid', 'version must be a positive integer');
  }
  if (typeof input.sourceSha !== 'string' || !SOURCE_SHA_RE.test(input.sourceSha)) {
    fail('source_sha_invalid', 'sourceSha must be a 40- or 64-character lower-case hex git commit');
  }
  const sourcePath = requireSourcePath(input.sourcePath);
  const title = requireText(input.title, 'title_invalid', 'title', 200);
  if (!RISK_CLASSES.includes(input.riskClass)) {
    fail('risk_class_invalid', `riskClass must be one of ${RISK_CLASSES.join(', ')}`);
  }
  const rights = requireRights(input.rights);
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) {
    fail('instructions_invalid', 'instructions must be non-empty markdown');
  }
  if (input.instructions.length > 1024 * 1024) {
    fail('instructions_invalid', 'instructions exceed 1 MiB');
  }
  const requestedTools = requireRequestedTools(input.requestedTools);
  const evaluationSuite =
    input.evaluationSuite === undefined || input.evaluationSuite === null
      ? null
      : requireText(input.evaluationSuite, 'evaluation_suite_invalid', 'evaluationSuite', 200);

  const digest = roleTemplateDigest({
    id,
    version: input.version,
    sourceSha: input.sourceSha,
    sourcePath,
    title,
    riskClass: input.riskClass,
    rights,
    instructions: input.instructions,
    requestedTools,
    evaluationSuite,
  });

  return {
    id,
    version: input.version,
    sourceSha: input.sourceSha,
    sourcePath,
    title,
    riskClass: input.riskClass,
    rights: {
      license: rights.license,
      sourceUrl: rights.sourceUrl,
      attribution: rights.attribution,
      status: rights.license === 'NOASSERTION' ? 'unverified' : 'declared',
    },
    instructions: input.instructions,
    requestedTools,
    evaluationSuite,
    digest,
  };
}

/** Recompute the digest of a stored template and refuse any drift. */
export function verifyRoleTemplate(template: RoleTemplate): string {
  if (!template || typeof template !== 'object' || typeof template.digest !== 'string') {
    fail('digest_mismatch', 'stored role template has no digest');
  }
  const recomputed = roleTemplateDigest({
    id: String(template.id ?? ''),
    version: template.version,
    sourceSha: String(template.sourceSha ?? ''),
    sourcePath: String(template.sourcePath ?? ''),
    title: String(template.title ?? ''),
    riskClass: template.riskClass,
    rights: {
      license: String(template.rights?.license ?? ''),
      sourceUrl: String(template.rights?.sourceUrl ?? ''),
      attribution: String(template.rights?.attribution ?? ''),
    },
    instructions: String(template.instructions ?? ''),
    requestedTools: Array.isArray(template.requestedTools) ? template.requestedTools.map(String) : [],
    evaluationSuite: template.evaluationSuite ?? null,
  });
  if (recomputed !== template.digest) {
    fail('digest_mismatch', 'role template digest does not match its fields');
  }
  return recomputed;
}

/**
 * The reference a SID installation cites. It names the immutable version and
 * its digest — never the instructions, so a grantee of the SID cannot read the
 * role's prose out of the identity record, and no authority travels with it.
 */
export function roleTemplateRef(template: Pick<RoleTemplate, 'id' | 'version' | 'digest'>): SidRoleTemplate {
  return { id: template.id, version: template.version, digest: template.digest };
}

/**
 * Published versions are immutable: the same id at the same version must keep
 * the same digest, and a new version must be strictly newer.
 */
export function assertVersionImmutable(
  previous: Pick<RoleTemplate, 'id' | 'version' | 'digest'>,
  next: Pick<RoleTemplate, 'id' | 'version' | 'digest'>,
): void {
  if (previous.id !== next.id) fail('id_mismatch', 'templates belong to different role ids');
  if (next.version < previous.version) {
    fail('version_regression', `version ${next.version} is older than published version ${previous.version}`);
  }
  if (next.version === previous.version && next.digest !== previous.digest) {
    fail('version_immutable', `version ${next.version} already exists with a different digest`);
  }
}
