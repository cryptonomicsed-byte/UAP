// C-19 (V6-03-05 dedupe/conflict, V6-03-09 policy-override guard).
//
// Two jobs, one review step, because they fail in the same way: silently installing a role
// nobody approved.
//
//   * Dedupe: overlapping persona collections from different publishers produce the same role
//     under several ids and versions. Identical copies collapse; a newer version supersedes an
//     older one *and says so*; two different bodies at the same id+version is a conflict that
//     keeps the id uninstallable rather than picking a winner by input order.
//
//   * Policy guard: a persona is untrusted text. It may describe how to work; it may not tell
//     the platform to ignore prior instructions, print the system prompt, drop safety checks,
//     reassign the assistant's identity, read credentials, claim authority it was not granted,
//     or act without the owner knowing. Matching text is rejected with the rule id, the phrase
//     and the position — and the rejection is per-role, so one poisoned persona cannot block a
//     clean collection.
//
// Honesty about the guard: it is a deterministic review gate over normalised text (NFKC,
// zero-width stripped, lowercased, whitespace collapsed). It catches the documented override
// shapes; it is not a classifier and will not catch novel phrasing. That is why instructions
// are treated as data everywhere else in the platform — this gate is an extra refusal, not the
// only defence.

import { createHash } from 'node:crypto';
import type { RoleTemplate } from './role-template.ts';

export const REVIEW_SCHEMA = 'uap-role-review/1';

export class RoleReviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RoleReviewError';
    this.code = code;
  }
}

export class PolicyOverrideError extends Error {
  readonly code = 'policy_override';
  readonly rule: string;
  readonly match: string;
  readonly index: number;
  constructor(rule: string, label: string, match: string, index: number) {
    super(`instructions attempt a policy override (${rule}: ${label}) at offset ${index}: "${match}"`);
    this.name = 'PolicyOverrideError';
    this.rule = rule;
    this.match = match;
    this.index = index;
  }
}

export interface PolicyRule {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

export interface PolicyFinding {
  readonly rule: string;
  readonly label: string;
  readonly match: string;
  /** Offset into the normalised text (NFKC, zero-width removed, lowercase, whitespace collapsed). */
  readonly index: number;
}

export interface PolicyScan {
  readonly safe: boolean;
  readonly findings: readonly PolicyFinding[];
}

/**
 * The documented override classes. Each pattern is a single sentence-scale match on normalised
 * text; deliberately narrow so ordinary engineering prose ("never silently restart a worker",
 * "do not claim an interface works") does not trip it.
 */
export const POLICY_RULES: readonly PolicyRule[] = Object.freeze([
  Object.freeze({
    id: 'ignore_instructions',
    label: 'overrides prior instructions',
    pattern: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,30}\b(instruction|prompt|rule|direction)s?\b/,
  }),
  Object.freeze({
    id: 'prompt_extraction',
    label: 'asks for the system prompt',
    pattern: /\b(reveal|print|show|repeat|output|dump|leak)\b[^.]{0,40}\b(system prompt|system message|hidden instruction|developer message|initial prompt)\b/,
  }),
  Object.freeze({
    id: 'safety_disable',
    label: 'disables safety checks',
    pattern: /\b(disable|turn off|bypass|ignore|without)\b[^.]{0,30}\b(safety|guardrail|filter|moderation|policy check)s?\b/,
  }),
  Object.freeze({
    id: 'identity_hijack',
    label: 'reassigns the assistant identity',
    pattern: /\b(you are now|from now on you are|act as the (system|developer)|you have no restrictions|no rules apply)\b/,
  }),
  Object.freeze({
    id: 'secret_read',
    label: 'targets credentials',
    pattern: /\b(read|print|dump|show|send|reveal|exfiltrate|leak)\b[^.]{0,40}\b(api[ _-]?key|secret|token|credential|password|\.env)\b/,
  }),
  Object.freeze({
    id: 'privilege_escalation',
    label: 'claims authority it was not granted',
    pattern: /\b(you are|you have|grant yourself|assume)\b[^.]{0,30}\b(admin|root|owner|superuser|unrestricted)\b[^.]{0,20}\b(access|privilege|rights?|authority)\b/,
  }),
  Object.freeze({
    id: 'covert_action',
    label: 'hides actions from the owner',
    pattern: /\b(do not|don't|never)\b[^.]{0,25}\b(tell|inform|notify|ask|mention)\b[^.]{0,20}\b(the )?(user|owner|operator)\b|\bwithout (asking|telling|notifying) (the )?(user|owner|operator)\b/,
  }),
]);

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g;

/** NFKC + lowercase + whitespace collapse over one zero-width variant. */
function normalizeVariant(text: string, zeroWidth: (run: string) => string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, zeroWidth)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** NFKC + zero-width strip + lowercase + whitespace collapse. Exported so callers can map offsets. */
export function normalizeForReview(text: string): string {
  return normalizeVariant(text, () => '');
}

export function scanInstructions(text: unknown): PolicyScan {
  if (typeof text !== 'string') {
    throw new RoleReviewError('instructions_invalid', 'instructions must be a string');
  }
  // Two zero-width variants: stripping joins "Ig<zw>nore" into one word, replacing with a space
  // keeps "Ignore<zw>all" from becoming "ignoreall". Scanning both defeats either evasion.
  const variants = [...new Set([
    normalizeVariant(text, () => ''),
    normalizeVariant(text, () => ' '),
  ])];
  const findings: PolicyFinding[] = [];
  for (const rule of POLICY_RULES) {
    for (const normalized of variants) {
      const hit = rule.pattern.exec(normalized);
      if (hit) {
        findings.push({ rule: rule.id, label: rule.label, match: hit[0], index: hit.index });
        break;
      }
    }
  }
  return { safe: findings.length === 0, findings };
}

/** Throws PolicyOverrideError on the first override class found; returns true when clean. */
export function assertPolicySafe(text: string): true {
  const scan = scanInstructions(text);
  if (scan.safe) return true;
  const [first] = scan.findings;
  throw new PolicyOverrideError(first.rule, first.label, first.match, first.index);
}

export interface RejectedRole {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly findings: readonly PolicyFinding[];
}

export interface DuplicateRole {
  readonly role: string;
  readonly duplicate_of: string;
  readonly digest: string;
}

export interface RoleConflict {
  readonly kind: 'digest_mismatch' | 'content_overlap';
  readonly roles: readonly string[];
  readonly detail: string;
}

export interface SupersededRole {
  readonly id: string;
  readonly version: number;
  readonly superseded_by: number;
}

export interface ReviewResult {
  readonly schema: typeof REVIEW_SCHEMA;
  readonly accepted: readonly RoleTemplate[];
  readonly rejected: readonly RejectedRole[];
  readonly duplicates: readonly DuplicateRole[];
  readonly conflicts: readonly RoleConflict[];
  readonly superseded: readonly SupersededRole[];
}

const ref = (role: { id: string; version: number }): string => `${role.id}@${role.version}`;
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const instructionDigest = (text: string): string => createHash('sha256').update(text.trim(), 'utf8').digest('hex');

function requireTemplate(value: unknown): RoleTemplate {
  const role = value as Partial<RoleTemplate> | null;
  if (
    !role ||
    typeof role.id !== 'string' || role.id.length === 0 ||
    typeof role.title !== 'string' ||
    typeof role.instructions !== 'string' ||
    typeof role.digest !== 'string' || role.digest.length === 0 ||
    !Number.isInteger(role.version) || (role.version as number) < 1
  ) {
    throw new RoleReviewError('template_invalid', 'each role must be a built RoleTemplate (id, version, title, instructions, digest)');
  }
  return role as RoleTemplate;
}

/**
 * Review a collection of built role templates: guard, dedupe, supersede, surface conflicts.
 * Deterministic — the result does not depend on input order.
 */
export function reviewRoleTemplates(input: unknown): ReviewResult {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RoleReviewError('templates_invalid', 'review needs a non-empty array of role templates');
  }
  const templates = input.map(requireTemplate).slice().sort((a, b) => byString(ref(a), ref(b)) || byString(a.digest, b.digest));

  const rejected: RejectedRole[] = [];
  const clean: RoleTemplate[] = [];
  for (const role of templates) {
    const scan = scanInstructions(role.instructions);
    if (scan.safe) clean.push(role);
    else rejected.push({ id: role.id, version: role.version, title: role.title, findings: scan.findings });
  }

  const groups = new Map<string, RoleTemplate[]>();
  for (const role of clean) {
    const list = groups.get(role.id) ?? [];
    list.push(role);
    groups.set(role.id, list);
  }

  const accepted: RoleTemplate[] = [];
  const duplicates: DuplicateRole[] = [];
  const conflicts: RoleConflict[] = [];
  const superseded: SupersededRole[] = [];

  for (const id of [...groups.keys()].sort(byString)) {
    const list = groups.get(id) as RoleTemplate[];
    const versions = [...new Set(list.map((role) => role.version))].sort((a, b) => b - a);
    const top = versions[0];
    const atTop = list.filter((role) => role.version === top).sort((a, b) => byString(a.digest, b.digest));
    const digests = new Set(atTop.map((role) => role.digest));

    if (digests.size > 1) {
      // Two different bodies claim the same id and version. The platform does not get to choose.
      conflicts.push({
        kind: 'digest_mismatch',
        roles: [ref(atTop[0])],
        detail: `version ${top} has ${digests.size} distinct digests: ${[...digests].sort(byString).join(', ')}`,
      });
      continue;
    }

    accepted.push(atTop[0]);
    for (const extra of atTop.slice(1)) {
      duplicates.push({ role: ref(extra), duplicate_of: ref(atTop[0]), digest: extra.digest });
    }
    for (const version of versions.slice(1)) superseded.push({ id, version, superseded_by: top });
  }

  // Same instruction body under more than one id: installable, but review it (role explosion).
  const byBody = new Map<string, RoleTemplate[]>();
  for (const role of accepted) {
    const key = instructionDigest(role.instructions);
    const list = byBody.get(key) ?? [];
    list.push(role);
    byBody.set(key, list);
  }
  for (const [digest, list] of byBody) {
    const ids = new Set(list.map((role) => role.id));
    if (ids.size < 2) continue;
    conflicts.push({
      kind: 'content_overlap',
      roles: list.map(ref).sort(byString),
      detail: `identical instructions (sha256:${digest}) under ${ids.size} role ids`,
    });
  }

  return {
    schema: REVIEW_SCHEMA,
    accepted: accepted.sort((a, b) => byString(ref(a), ref(b)) || byString(a.digest, b.digest)),
    rejected: rejected.sort((a, b) => byString(`${a.id}@${a.version}`, `${b.id}@${b.version}`)),
    duplicates: duplicates.sort((a, b) => byString(`${a.role}${a.digest}`, `${b.role}${b.digest}`)),
    conflicts: conflicts.sort((a, b) => byString(a.kind + a.roles.join(','), b.kind + b.roles.join(','))),
    superseded: superseded.sort((a, b) => byString(`${a.id}@${a.version}`, `${b.id}@${b.version}`)),
  };
}
