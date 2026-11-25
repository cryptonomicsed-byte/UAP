/**
 * SID agent templates.
 *
 * Niche: agent identity and lifecycle.
 * UAP core stays TypeScript. Rust lease-gate authorizes tools. Elixir only
 * supervises spawn and teardown. A template is not a grant.
 *
 * Feature contracts adapted, not copied:
 * - n8n-io/nod: ask before an irreversible act; own computer is not host takeover
 * - milind-soni/OpenMausBot: team package, no enterprise/
 * - nickvasilescu/bot-hq: Hermes session, not a second task ledger
 * - elie222/rakazo: a parent may delegate to a sub-agent with its own memory
 * - leepokai/Codync: a teammate is reachable by URL, model is bring-your-own
 * Persona packs (anti-slop, chain, game, video) compile into templates.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { actingHashLegacy, sidHashLegacy, verifySidLegacy } from '../identity/sid-legacy.js';

export interface FeatureSource {
  repo: string;
  sha: string;
  take: string;
}

export interface SidTemplate {
  slug: string;
  family: string;
  title: string;
  source: FeatureSource;
  riskClass: 'low' | 'medium' | 'high';
  capabilities: string[];
  grants: [];
  /** Which engineering-pack specialists (lib/engineering-pack.ts SPECIALISTS ids) this persona
   *  actually installs as real skills at birth. Deliberately conservative: a template gets a
   *  specialist only when there is a genuinely close match, never padded to look complete. */
  specialistIds: string[];
}

export const FEATURE_SOURCES: FeatureSource[] = [
  { repo: 'n8n-io/nod', sha: '08da5a7f10648db7814ca9b7a1b3a458293ffba5', take: 'approval before irreversible act; computer is not host takeover' },
  { repo: 'milind-soni/OpenMausBot', sha: '0c352d70286aceb8ccabc9d11a56713e35026920', take: 'team package and ACP driver; enterprise/ excluded' },
  { repo: 'nickvasilescu/bot-hq', sha: 'decf9a215cddd8792a5f20f4a11a87d4dffa6d15', take: 'Hermes session patterns; not a second ledger' },
  { repo: 'elie222/rakazo', sha: '4f4189032d7fbf0395762bce2e2ac7924b1238f6', take: 'delegation to a sub-agent with its own memory' },
  { repo: 'leepokai/Codync', sha: '9dae3e2bec9b91a4a42f85a943eb3983f95d0503', take: 'bring-your-own model; teammate reachable by URL' },
  { repo: 'cryptonomicsed-byte/sid', sha: '756d8d8ecb36c359ee1ebfe9bd7772a42ec37418', take: 'sid/0.1 certificate; parent null means a root agent' },
];

export const SID_TEMPLATES: SidTemplate[] = [
  { slug: 'anti-slop-reviewer', family: 'design', title: 'Anti-slop reviewer', source: { repo: 'miqdadbadjuber/anti-slop', sha: '7f6a03df2931c12cb244dc4ab14ee4866b0ac2ba', take: 'review gate, not a running agent' }, riskClass: 'low', capabilities: ['review-prose', 'review-ui'], grants: [], specialistIds: ['review', 'qa'] },
  { slug: 'blockchain-coder', family: 'chain', title: 'Blockchain coder', source: { repo: '0xlayerghost/solidity-agent-kit', sha: '4f7b4c61a9f386f0f57d92bbeae5034146010a69', take: 'review and test methodology; no signing key' }, riskClass: 'high', capabilities: ['review-contract', 'foundry-test'], grants: [], specialistIds: ['move'] },
  { slug: 'game-dev', family: 'game', title: 'Game developer', source: { repo: 'LISK819129/OpenNPC', sha: 'e4c736ba7450746b040a8d7ead94aa04cce6d16d', take: 'NPC dialogue patterns; no host control' }, riskClass: 'medium', capabilities: ['npc-dialogue', 'scene-plan'], grants: [], specialistIds: [] },
  { slug: 'video-creator', family: 'video', title: 'Video creator', source: { repo: 'remotion-dev/skills', sha: 'a3f4098a2afd0e13f6a6f8c8760e275f75457ea9', take: 'timeline conventions; no silent paid render' }, riskClass: 'medium', capabilities: ['timeline', 'storyboard'], grants: [], specialistIds: ['motion'] },
  { slug: 'nod-operator', family: 'computer', title: 'Nod operator', source: FEATURE_SOURCES[0], riskClass: 'high', capabilities: ['computer-preview', 'approval-required'], grants: [], specialistIds: ['qa'] },
  { slug: 'rakazo-delegator', family: 'delegation', title: 'Rakazo delegator', source: FEATURE_SOURCES[3], riskClass: 'medium', capabilities: ['spawn-subagent', 'isolated-memory'], grants: [], specialistIds: ['architect'] },
  { slug: 'omokoda-guest', family: 'omokoda', title: 'Ọmọ Kọ́dà guest', source: { repo: 'omokoda-agent', sha: 'b7b9cef645cc7de39678e9a01183495dc5756752', take: 'Ọmọ Kọ́dà kernel guest, born via /v1/birth on the shared kernel. The agent key stays server-side. The repo has no LICENSE file, so only its HTTP API is called and nothing is vendored.' }, riskClass: 'high', capabilities: ['omokoda-kernel', 'isolated-memory'], grants: [], specialistIds: [] },
  { slug: 'coding-agent', family: 'engineering', title: 'Coding agent', source: { repo: 'obra/superpowers', sha: '22f0b463e7a5e579904dd6211a520321035526f7', take: 'plan, TDD, debug, review methodology; general-purpose engineering persona' }, riskClass: 'medium', capabilities: ['review-code', 'write-code'], grants: [], specialistIds: ['architect', 'rust', 'python', 'go'] },
  { slug: 'security-agent', family: 'security', title: 'Security agent', source: { repo: 'dkneeland/agentic-guardrails', sha: '043e56682b902cfcd991b58b51eda0675f1617b9', take: 'independent cleanup/review methodology; no dedicated security-audit pack is license-cleared yet, so this installs review/qa specialists only' }, riskClass: 'high', capabilities: ['review-code', 'review-contract'], grants: [], specialistIds: ['review', 'qa'] },
];

export interface MintedAgent {
  sid: string;
  kind: 'full' | 'sub';
  parentSid: string | null;
  template: string;
  status: 'cast';
  document: Record<string, unknown>;
  grants: [];
}

function sidId(slug: string): string {
  return `sid_${slug}-${randomBytes(3).toString('hex')}`;
}

function certificate(input: { sid: string; title: string; parent: string | null; template: SidTemplate }): Record<string, unknown> {
  const primary = 7;
  const secondary = 11;
  const doc: Record<string, unknown> = {
    format: 'sid/0.1',
    id: input.sid,
    version: 1,
    previous_version: null,
    previous_hash: 'none',
    status: 'cast',
    born_at: new Date().toISOString(),
    identity: {
      name: input.title,
      type: 'agent',
      odu_primary: primary,
      odu_secondary: secondary,
      odu_link: (primary << 8) | secondary,
      parent: input.parent,
      principal: null,
      description: input.template.source.take,
    },
    capabilities: { requested: input.template.capabilities, grants: [] },
    lifecycle: { state: 'cast' },
    provenance: {
      template: input.template.slug,
      source_repo: input.template.source.repo,
      source_sha: input.template.source.sha,
      feature_sources: FEATURE_SOURCES.map((s) => `${s.repo}@${s.sha.slice(0, 12)}`),
    },
  };
  doc.acting_hash = actingHashLegacy(doc);
  doc.hash = sidHashLegacy(doc);
  return doc;
}

export function ensureSidTemplateSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sid_agents (
      sid TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      template_slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_sid TEXT,
      status TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export class SidTemplateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SidTemplateError';
  }
}

export class SidTemplateRuntime {
  constructor(private readonly db: Database.Database) {
    ensureSidTemplateSchema(db);
  }

  templates() {
    return SID_TEMPLATES;
  }

  install(input: { tenantId: string; template: string }): MintedAgent {
    const template = SID_TEMPLATES.find((row) => row.slug === input.template);
    if (!template) throw new SidTemplateError('template', 'unknown template');
    if (template.grants.length !== 0) throw new SidTemplateError('grants', 'a template cannot carry grants');
    return this.mint({ tenantId: input.tenantId, template, kind: 'full', parentSid: null });
  }

  spawnSubAgent(input: { tenantId: string; parentSid: string; template: string }): MintedAgent {
    const parent = this.db.prepare('SELECT sid, tenant_id, status FROM sid_agents WHERE sid=?').get(input.parentSid) as { sid: string; tenant_id: string; status: string } | undefined;
    if (!parent) throw new SidTemplateError('parent', 'parent SID is not installed');
    if (parent.tenant_id !== input.tenantId) throw new SidTemplateError('tenant', 'sub-agent cannot cross tenants');
    if (parent.status === 'retired') throw new SidTemplateError('parent', 'retired parent cannot spawn');
    const template = SID_TEMPLATES.find((row) => row.slug === input.template);
    if (!template) throw new SidTemplateError('template', 'unknown template');
    const child = this.mint({ tenantId: input.tenantId, template, kind: 'sub', parentSid: parent.sid });
    if (child.sid === parent.sid) throw new SidTemplateError('lineage', 'spawn must not reuse the parent SID');
    return child;
  }

  private mint(input: { tenantId: string; template: SidTemplate; kind: 'full' | 'sub'; parentSid: string | null }): MintedAgent {
    const sid = sidId(input.template.slug);
    const document = certificate({ sid, title: input.template.title, parent: input.parentSid, template: input.template });
    const checked = verifySidLegacy(document);
    if (!checked.ok) throw new SidTemplateError('certificate', checked.errors.join('; '));
    this.db.prepare('INSERT INTO sid_agents(sid,tenant_id,template_slug,kind,parent_sid,status,document_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sid, input.tenantId, input.template.slug, input.kind, input.parentSid, 'cast', JSON.stringify(document), Date.now());
    return { sid, kind: input.kind, parentSid: input.parentSid, template: input.template.slug, status: 'cast', document, grants: [] };
  }
}

/** Elixir owns the spawn/teardown announcement. A missing runtime is reported, not faked. */
export function superviseSpawn(childSid: string, parentSid: string | null): { backend: 'elixir' | 'unavailable'; lines: string[] } {
  const script = `
parent = ${JSON.stringify(parentSid)}
child = ${JSON.stringify(childSid)}
IO.puts("SPAWN #{child} parent=#{parent || "nil"}")
IO.puts("TERMINATED #{child}")
`;
  const proc = spawnSync('elixir', ['-e', script], { encoding: 'utf8', timeout: 8000 });
  if (proc.status !== 0) return { backend: 'unavailable', lines: [] };
  return { backend: 'elixir', lines: proc.stdout.trim().split('\n') };
}
