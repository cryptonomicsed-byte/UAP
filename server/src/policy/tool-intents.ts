/**
 * Tool intent classification (V6-07-03).
 *
 * The effect class and risk tier of an action belong to the *tool*, not to the model's
 * description of it and not to the arguments it passes. A model that writes
 * `{"effect":"read"}` into its arguments changes nothing here: the table below is
 * consulted by tool name, and anything not in it is treated as a write — the safe
 * default, because an unknown tool is far more likely to be a hallucinated or
 * newly-added mutator than a harmless reader.
 */
import crypto from 'node:crypto';

export type EffectClass =
  | 'read'
  | 'compute'
  | 'write'
  | 'external_message'
  | 'money'
  | 'publish'
  | 'production_change'
  | 'security_testing'
  | 'clinical_data';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export interface ToolClass {
  effect: EffectClass;
  risk: RiskTier;
}

/**
 * The app's own tools. Keep this exhaustive: a tool added to `agent/tools.ts` without a
 * row here still works, but it is gated as a medium-risk write until someone says
 * otherwise — the failure mode is a refusal, not a silent widening.
 */
const TOOL_CLASSES: Record<string, ToolClass> = {
  list_routines: { effect: 'read', risk: 'low' },
  list_event_triggers: { effect: 'read', risk: 'low' },
  list_skills: { effect: 'read', risk: 'low' },
  create_skill: { effect: 'write', risk: 'medium' },
  send_email: { effect: 'write', risk: 'high' },
  x_search: { effect: 'compute', risk: 'medium' },
  save_file: { effect: 'write', risk: 'medium' },
  create_task: { effect: 'write', risk: 'medium' },
  update_task: { effect: 'write', risk: 'medium' },
  create_routine: { effect: 'write', risk: 'medium' },
  update_routine: { effect: 'write', risk: 'medium' },
  delete_routine: { effect: 'write', risk: 'medium' },
  create_event_routine: { effect: 'write', risk: 'medium' },
  set_checkins: { effect: 'write', risk: 'medium' },
  stay_silent: { effect: 'write', risk: 'low' },
  ask_user: { effect: 'write', risk: 'low' },
  request_app_connection: { effect: 'write', risk: 'low' },
  create_group: { effect: 'write', risk: 'medium' },
  send_to_bot: { effect: 'external_message', risk: 'medium' },
  post_to_group: { effect: 'external_message', risk: 'medium' },
};

/** Composio names are per-user and arrive at runtime; classify them by what they do. */
const READ_SLUG = /_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|CHECK|DESCRIBE|VIEW|COUNT)(_|$)/;
const SEND_SLUG = /_(SEND|POST|CREATE|UPDATE|DELETE|REMOVE|ADD|INSERT|WRITE|REPLY|FORWARD|PUBLISH|UPLOAD|SHARE|INVITE|MOVE|ARCHIVE)(_|$)/;
const MONEY_SLUG = /_(CHARGE|PAY|PAYMENT|REFUND|INVOICE|TRANSFER|CHECKOUT|PURCHASE|BILLING)(_|$)/;

export function classifyTool(name: string): ToolClass {
  const key = Object.keys(TOOL_CLASSES).find((k) => k.toLowerCase() === String(name ?? '').toLowerCase());
  if (key) return { ...TOOL_CLASSES[key] };
  const upper = String(name ?? '').toUpperCase();
  if (MONEY_SLUG.test(upper)) return { effect: 'money', risk: 'high' };
  if (READ_SLUG.test(upper)) return { effect: 'read', risk: 'low' };
  if (SEND_SLUG.test(upper)) return { effect: 'external_message', risk: 'medium' };
  // Unknown tool or a meta-tool that runs other tools: never assume it is harmless.
  return { effect: 'write', risk: 'medium' };
}

/** Stable JSON for hashing: keys sorted at every depth, `undefined` fields dropped. */
export function canonicalArgs(args: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        out[key] = normalize(v);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(normalize(args ?? {}));
}

export const sha256Hex = (s: string | Buffer): string =>
  crypto.createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

export const digestOfJson = (value: unknown): string => sha256Hex(canonicalArgs(value));

/** Digest of a tool's declared argument schema: the value a grant pins. */
export const schemaDigest = (schema: unknown): string => digestOfJson(schema ?? {});

/**
 * The kernel's tool-name grammar is lower-case `[a-z0-9][a-z0-9._-]{0,127}`. Composio
 * names are upper-case and occasionally contain characters outside it, so the kernel
 * sees a normalised name while the audit row keeps the name the model used.
 */
export function kernelToolName(name: string): string {
  const lower = String(name ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 128);
  return /^[a-z0-9]/.test(lower) ? lower : `t_${lower}`.slice(0, 128);
}

/** Resource target for one tool call. `tool:` is the only kind this bridge uses. */
export function targetFor(name: string): string {
  return `tool:${kernelToolName(name)}`;
}
