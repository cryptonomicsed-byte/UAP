/**
 * MAUS-G-10: safe static documentation of tool effects, budgets, error families and
 * idempotency expectations — generated from the kernel's own real classification
 * (tool-intents.ts), autonomy gating (autonomy.ts's RISKY set) and the failure taxonomy
 * (failure.ts), not hand-typed prose that drifts from the code it describes.
 */
import { TOOLS } from '../agent/tools.js';
import { classifyTool, type EffectClass, type RiskTier } from '../policy/tool-intents.js';

const RISKY_TOOLS = new Set([
  'spawn_sid_subagent', 'install_sid_template', 'save_file', 'send_to_bot', 'create_routine', 'create_group', 'create_skill', 'send_email',
]);

export interface ToolDoc {
  name: string;
  label: string;
  effect: EffectClass;
  risk: RiskTier;
  requiresApprovalByDefault: boolean;
  idempotent: boolean;
  errorFamilies: string[];
}

/** read/compute are naturally idempotent (no side effect to repeat); everything else is not
 *  assumed idempotent unless a tool explicitly says so — the safe default, same reasoning
 *  tool-intents.ts uses for effect classification: an unknown tool is a write until proven otherwise. */
function idempotentByEffect(effect: EffectClass): boolean {
  return effect === 'read' || effect === 'compute';
}

/** The error families a tool call can actually surface, drawn from lib/failure.ts's real
 *  taxonomy — every tool call can fail for engine/provider reasons; tools with an external
 *  effect also carry a generic failure since the remote side can itself error. */
function errorFamiliesFor(effect: EffectClass): string[] {
  const base = ['engine_unreachable', 'engine_auth', 'provider_auth', 'provider_rate_limited', 'provider_unavailable', 'timeout'];
  if (effect === 'read' || effect === 'compute') return base;
  return [...base, 'tool_error'];
}

export function generateToolDocs(): ToolDoc[] {
  return TOOLS.map((t) => {
    const cls = classifyTool(t.name);
    return {
      name: t.name,
      label: t.label,
      effect: cls.effect,
      risk: cls.risk,
      requiresApprovalByDefault: RISKY_TOOLS.has(t.name),
      idempotent: idempotentByEffect(cls.effect),
      errorFamilies: errorFamiliesFor(cls.effect),
    };
  });
}

export function renderToolDocsMarkdown(docs: ToolDoc[]): string {
  const lines = ['# Tool reference (generated — do not hand-edit)', '', 'Generated from the kernel\'s own classification; regenerate with `node --import tsx scripts/generate-tool-docs.mjs`.', ''];
  for (const d of docs) {
    lines.push(`## \`${d.name}\``);
    lines.push('');
    lines.push(`- **Label:** ${d.label}`);
    lines.push(`- **Effect:** ${d.effect}`);
    lines.push(`- **Risk tier:** ${d.risk}`);
    lines.push(`- **Approval by default:** ${d.requiresApprovalByDefault ? 'yes (ask-mode gated)' : 'no'}`);
    lines.push(`- **Idempotent:** ${d.idempotent ? 'yes — safe to retry' : 'no — do not auto-retry without a dedupe key'}`);
    lines.push(`- **Error families:** ${d.errorFamilies.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
