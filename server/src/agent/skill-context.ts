/**
 * Progressive per-role skill context with a hard token budget (V6-07-03).
 *
 * The prompt builder used to paste every skill body in full. A bot with a few
 * long skills then silently outgrew its context, and any edit changed the size
 * of the cached prefix. This module renders the same information on a depth
 * ladder — full bodies, then first-line summaries, then names, then nothing —
 * and stops before the caller's budget instead of hoping.
 *
 * The budget covers the whole injected block. The role's own instructions come
 * first and are never truncated mid-sentence: if they alone exceed the budget
 * the result is an honest pointer (`floor: true`, empty text) that says the
 * budget cannot be honoured. Callers are expected to raise the budget, not to
 * treat an empty block as a valid identity.
 *
 * Token counts are the one estimate this module makes: 4 characters per token,
 * rounded up, which is the same convention the estate's budget tooling uses.
 * Nothing here reads a clock, so the same inputs always produce the same bytes
 * and the same etag — the etag hashes the rendered selection only, so a budget
 * change that does not change what is included does not invalidate the cache.
 */
import { createHash } from 'node:crypto';

export const DEFAULT_SKILL_BUDGET_TOKENS = 1200;

/**
 * Below this the envelope cannot carry the minimum useful payload (a role line
 * or a few skill names), so the builder returns a pointer instead of a slice
 * that claims to fit.
 */
export const SKILL_CONTEXT_FLOOR_TOKENS = 40;

const DEFAULT_SUMMARY_CHARS = 200;
const CHARS_PER_TOKEN = 4;

export type SkillContextMode = 'full' | 'summary' | 'names' | 'none';
export type SkillContextLevel = 'full' | 'summary' | 'name';
export type SkillOmitReason = 'budget' | 'budget_floor' | 'role_over_budget';

export interface RoleContextInput {
  id: string;
  version: number;
  digest: string;
  title: string;
  instructions: string;
}

export interface SkillInput {
  id: string;
  name: string;
  body: string;
}

export interface BuildSkillContextInput {
  role: RoleContextInput;
  skills: readonly SkillInput[];
  budgetTokens?: number;
  summaryChars?: number;
}

export interface IncludedSkill {
  id: string;
  name: string;
  level: SkillContextLevel;
  chars: number;
}

export interface OmittedSkill {
  name: string;
  reason: SkillOmitReason;
}

export interface SkillContextEnvelope {
  data: {
    mode: SkillContextMode;
    /** The exact text to inject. Empty only when `floor` is true. */
    text: string;
    included: IncludedSkill[];
    omitted: OmittedSkill[];
    role: { id: string; version: number; digest: string };
    /** Estimated tokens the role's own instructions occupy. */
    roleTokens: number;
    budgetTokens: number;
  };
  /** sha256 of the rendered selection; ignores metadata such as the budget. */
  etag: string;
  /** Estimated tokens in `data.text` (ceil(chars / 4)). */
  estTokens: number;
  /** Names whose content was shortened at this budget (mode summary/names). */
  truncated: string[];
  /** Count of skills not represented at their best available level. */
  dropped: number;
  /** True when the budget cannot be honoured and `data.text` is a pointer. */
  floor: boolean;
}

const tokensFor = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function firstLine(body: string, max: number): string {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? line.slice(0, max).trimEnd() : line;
}

function render(level: SkillContextLevel, skill: SkillInput, summaryChars: number): string {
  if (level === 'full') return `### ${skill.name}\n${skill.body.trim()}`;
  if (level === 'summary') return `### ${skill.name}\n${firstLine(skill.body, summaryChars)}`;
  return `- ${skill.name}`;
}

function etagOf(role: RoleContextInput, mode: SkillContextMode, text: string, floor: boolean): string {
  return sha256Hex(JSON.stringify({
    role: { id: role.id, version: role.version, digest: role.digest, title: role.title },
    mode,
    floor,
    text,
  }));
}

export function buildSkillContext(input: BuildSkillContextInput): SkillContextEnvelope {
  const budgetTokens = input.budgetTokens ?? DEFAULT_SKILL_BUDGET_TOKENS;
  const summaryChars = input.summaryChars ?? DEFAULT_SUMMARY_CHARS;
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) {
    throw new RangeError('budgetTokens must be a positive integer');
  }
  if (!Number.isInteger(summaryChars) || summaryChars < 1) {
    throw new RangeError('summaryChars must be a positive integer');
  }

  const roleText = input.role.instructions.trimEnd();
  const roleTokens = tokensFor(roleText);
  const roleMeta = {
    id: input.role.id,
    version: input.role.version,
    digest: input.role.digest,
  };
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;

  const pointer = (reason: SkillOmitReason): SkillContextEnvelope => {
    const omitted = input.skills.map((s) => ({ name: s.name, reason }));
    return {
      data: {
        mode: 'names',
        text: '',
        included: [],
        omitted,
        role: roleMeta,
        roleTokens,
        budgetTokens,
      },
      etag: etagOf(input.role, 'names', '', true),
      estTokens: 0,
      truncated: input.skills.map((s) => s.name),
      dropped: input.skills.length,
      floor: true,
    };
  };

  if (budgetTokens < SKILL_CONTEXT_FLOOR_TOKENS) return pointer('budget_floor');
  if (roleTokens > budgetTokens) return pointer('role_over_budget');

  if (input.skills.length === 0) {
    return {
      data: {
        mode: 'none',
        text: roleText,
        included: [],
        omitted: [],
        role: roleMeta,
        roleTokens,
        budgetTokens,
      },
      etag: etagOf(input.role, 'none', roleText, false),
      estTokens: roleTokens,
      truncated: [],
      dropped: 0,
      floor: false,
    };
  }

  const fits = (section: string): boolean => roleText.length + 2 + section.length <= budgetChars;
  const body = (section: string): string => `${roleText}\n\n${section}`;

  for (const level of ['full', 'summary'] as const) {
    const parts = input.skills.map((s) => render(level, s, summaryChars));
    const section = parts.join('\n\n');
    if (fits(section)) {
      return {
        data: {
          mode: level,
          text: body(section),
          included: input.skills.map((s, i) => ({ id: s.id, name: s.name, level, chars: parts[i].length })),
          omitted: [],
          role: roleMeta,
          roleTokens,
          budgetTokens,
        },
        etag: etagOf(input.role, level, body(section), false),
        estTokens: tokensFor(body(section)),
        truncated: level === 'summary' ? input.skills.map((s) => s.name) : [],
        dropped: 0,
        floor: false,
      };
    }
  }

  // Names do not fit as a whole section either: keep as many as the budget
  // allows, in the caller's order, and report the rest instead of overrunning.
  const names = input.skills.map((s) => render('name', s, summaryChars));
  const kept: number[] = [];
  let section = '';
  for (let i = 0; i < names.length; i += 1) {
    const next = section ? `${section}\n${names[i]}` : names[i];
    if (!fits(next)) break;
    section = next;
    kept.push(i);
  }
  const text = section ? body(section) : roleText;
  const omitted = input.skills
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => !kept.includes(i))
    .map(({ s }) => ({ name: s.name, reason: 'budget' as const }));

  return {
    data: {
      mode: 'names',
      text,
      included: kept.map((i) => ({
        id: input.skills[i].id,
        name: input.skills[i].name,
        level: 'name',
        chars: names[i].length,
      })),
      omitted,
      role: roleMeta,
      roleTokens,
      budgetTokens,
    },
    etag: etagOf(input.role, 'names', text, false),
    estTokens: tokensFor(text),
    truncated: kept.map((i) => input.skills[i].name),
    dropped: omitted.length,
    floor: false,
  };
}
