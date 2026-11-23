/**
 * Policy-authorized tool intents (V6-07-03).
 *
 * Every tool call a model proposes over MCP passes through here before it executes:
 * the app builds an `ActionIntent` from its own registry (effect class, risk, exact
 * arguments, pinned schema digest), pairs it with a signed grant and a short-lived
 * signed lease, and asks the Rust kernel (`crates/agentos-policy`) for a verdict. The
 * kernel's answer is the authority. The model's opinion is not consulted at all — there
 * is no field in the bundle a model can write.
 *
 * ## Trust anchors
 *
 * This app is a self-hosted, single-owner install, so it is also the local issuer: one
 * Ed25519 issuer key and one approver key are generated on first use under
 * `POLICY_AUTHORITY_DIR` (mode 0600, never in the repo, never in the database). In a
 * hosted topology those keys live in the operator's KMS and the worker's task lease
 * replaces the turn lease minted here. What does *not* change between topologies is the
 * property that matters: the decision is made by a separate process that re-verifies
 * signatures over canonical bytes, so a bug or a prompt in the TS layer cannot widen it.
 *
 * ## Failure modes
 *
 * - kernel binary missing / times out / answers garbage → `policy-unavailable`, refused.
 * - tool unknown to the catalog → `tool-not-granted`, refused.
 * - tool blocked by the owner → not in the grant → `tool-not-granted`, refused.
 * - tool schema changed since the grant was pinned → `tool-schema-changed`, refused.
 * - effect class that always needs a human (money/publish/prod/security/clinical) is
 *   never granted, so it refuses with `effect-not-granted` / `approval-required`.
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { db, now } from '../db.js';
import { env } from '../env.js';
import { getBotRow } from '../store.js';
import { TOOLS } from '../agent/tools.js';
import { composioTools, innerToolSlugs } from '../composio.js';
import { isProviderConfigured } from '../providers.js';
import {
  canonicalArgs,
  classifyTool,
  digestOfJson,
  kernelToolName,
  schemaDigest,
  sha256Hex,
  targetFor,
  type EffectClass,
  type RiskTier,
} from './tool-intents.js';

export interface ToolAuthorizationInput {
  botId: string;
  userId: string;
  toolName: string;
  args: unknown;
  /** The tool's declared argument schema. Defaults to the registry's, else `{}`. */
  schema?: unknown;
}

export interface ToolAuthorizationDecision {
  allowed: boolean;
  code: string;
  detail?: string;
  effect: EffectClass;
  risk: RiskTier;
  intentDigest?: string;
  paramsDigest?: string;
  permit?: { permitId: string; intentId: string; effect: string; expiresAtMs: number };
  auditSeq?: number;
}

const EFFECT_ORDER: EffectClass[] = [
  'read', 'compute', 'write', 'external_message', 'money', 'publish',
  'production_change', 'security_testing', 'clinical_data',
];
const RISK_ORDER: RiskTier[] = ['low', 'medium', 'high', 'critical'];

/** Effects a grant may confer. The five classes that always need a human are absent. */
const GRANTED_EFFECTS: EffectClass[] = ['read', 'compute', 'write', 'external_message'];

const LEASE_MS = 60_000;
const GRANT_MS = 12 * 60 * 60 * 1000;
const KERNEL_TIMEOUT_MS = 5_000;
const COMPOSIO_CATALOG_TTL_MS = 10 * 60_000;

const authorityDir = () =>
  process.env.POLICY_AUTHORITY_DIR || path.join(path.dirname(env.dbPath), 'policy-authority');

const authorizeBin = () => process.env.AGENTOS_POLICY_BIN || defaultBin('authorize');
const mintBin = () => process.env.AGENTOS_POLICY_MINT_BIN || defaultBin('mint');

function defaultBin(name: string): string {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..');
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(repo, 'target', profile, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(repo, 'target', 'debug', name);
}

// --------------------------------------------------------------- local authority

interface AuthorityKey { id: string; key: crypto.KeyObject; seedHex: string; publicHex: string; clearance?: RiskTier }

let authority: { issuer: AuthorityKey; approver: AuthorityKey } | null = null;

function readOrCreateKey(file: string, id: string, clearance?: RiskTier): AuthorityKey {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let jwk: { d?: string; x?: string };
  if (fs.existsSync(file)) {
    jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const exported = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
    jwk = { d: exported.d, x: exported.x };
    // 0600 from creation: the seed must never be group/world readable, not even for the
    // window between `open` and a later `chmod`.
    fs.writeFileSync(file, JSON.stringify(jwk, null, 1), { mode: 0o600 });
  }
  if (!jwk.d || !jwk.x) throw new Error(`authority key ${file} is malformed`);
  const key = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, format: 'jwk' });
  return {
    id,
    key,
    seedHex: Buffer.from(jwk.d, 'base64url').toString('hex'),
    publicHex: Buffer.from(jwk.x, 'base64url').toString('hex'),
    clearance,
  };
}

export function localAuthority() {
  if (authority) return authority;
  const dir = authorityDir();
  authority = {
    issuer: readOrCreateKey(path.join(dir, 'issuer.json'), 'local-issuer'),
    approver: readOrCreateKey(path.join(dir, 'approver.json'), 'local-approver', 'critical'),
  };
  return authority;
}

/** Fingerprint of the issuer's public key: identifies the installation's authority. */
export const authorityFingerprint = () => sha256Hex(Buffer.from(localAuthority().issuer.publicHex, 'hex'));

// ---------------------------------------------------------------------- binaries

interface BinResult { status: number | null; stdout: string; stderr: string; timedOut: boolean }

function runBin(bin: string, input: string, timeoutMs = KERNEL_TIMEOUT_MS): Promise<BinResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ status: null, stdout: '', stderr: String(e?.message ?? e), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.once('error', (e: any) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: String(e?.message ?? e), timedOut }); });
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
    child.stdin?.end(input);
  });
}

// ------------------------------------------------------------------- minted docs

interface SignedDoc { fields: unknown; signature_hex: string; issuer?: string; approver?: string }

async function mint(kind: 'grant' | 'lease' | 'approval', fields: unknown, key: AuthorityKey, role: 'issuer' | 'approver'): Promise<SignedDoc> {
  const request = {
    v: 'uap-mint/1',
    kind,
    issuer: key.id,
    seed_hex: key.seedHex,
    fields,
  };
  const r = await runBin(mintBin(), JSON.stringify(request));
  if (r.status !== 0) throw new Error(`mint ${kind}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}`);
  const doc = JSON.parse(r.stdout);
  return role === 'issuer'
    ? { fields: doc.fields, signature_hex: doc.signature_hex, issuer: doc.issuer }
    : { fields: doc.fields, signature_hex: doc.signature_hex, approver: doc.issuer };
}

// ------------------------------------------------------------------- the catalog

interface CatalogEntry { name: string; schema: unknown }

const composioCatalog = new Map<string, { at: number; entries: CatalogEntry[] }>();

/**
 * What this owner's tools are, as the app can describe them today. Own tools come from
 * the registry; Composio tools come from the provider (cached, because a tool call should
 * not pay for a remote listing). A provider failure yields no entries — the call is then
 * refused as `tool-not-granted`, which is the correct failure for "I cannot describe the
 * tool, so I cannot pin its schema".
 */
async function catalogFor(userId: string): Promise<CatalogEntry[]> {
  const own: CatalogEntry[] = TOOLS.map((t: any) => ({ name: t.name, schema: t.parameters }));
  if (!isProviderConfigured('composio')) return own;
  const cached = composioCatalog.get(userId);
  if (cached && Date.now() - cached.at < COMPOSIO_CATALOG_TTL_MS) return [...own, ...cached.entries];
  let entries: CatalogEntry[] = [];
  try {
    const tools = await composioTools(userId);
    entries = (Array.isArray(tools) ? tools : [])
      .filter((t: any) => t && typeof t.name === 'string')
      .map((t: any) => ({ name: t.name, schema: t.parameters ?? {} }));
  } catch {
    entries = [];
  }
  composioCatalog.set(userId, { at: Date.now(), entries });
  return [...own, ...entries];
}

function blockedTools(userId: string): string[] {
  const rows = db.prepare("SELECT tool FROM policies WHERE user_id=? AND mode='blocked'").all(userId) as { tool: string }[];
  return rows.map((r) => r.tool.toLowerCase());
}

// ------------------------------------------------------------------ identity ids

const tenantOf = (userId: string) => `owner-${sha256Hex(userId).slice(0, 16)}`;

const KERNEL_SID = /^[a-z0-9][a-z0-9._:-]{2,127}$/;

/**
 * The SID the kernel reasons about. A registry SID bound by an operator (G-23) is used
 * verbatim; before that, a stable app-local identity is derived from the bot id and
 * named `sid_local_…` so nothing mistakes it for an issued SID.
 */
function sidOf(botId: string): string {
  const bound = (getBotRow(botId) as any)?.sid;
  if (typeof bound === 'string' && KERNEL_SID.test(bound)) return bound;
  const derived = `sid_local_${sha256Hex(botId).slice(0, 16)}`;
  return derived;
}

const roleDigest = (botId: string) => sha256Hex(`role:${botId}`);

// --------------------------------------------------------------- grant and lease

const grantCache = new Map<string, { doc: SignedDoc; at: number }>();

interface GrantScope { tenant: string; sid: string; entries: CatalogEntry[]; fingerprint: string }

async function signedGrant(scope: GrantScope): Promise<SignedDoc> {
  const cached = grantCache.get(scope.fingerprint);
  if (cached && Date.now() - cached.at < GRANT_MS - 60_000) return cached.doc;
  const issued = Date.now();
  const fields = {
    v: 'uap-grant/1',
    grant_id: `grant_${sha256Hex(scope.fingerprint).slice(0, 16)}`,
    tenant: scope.tenant,
    sid: scope.sid,
    effects: GRANTED_EFFECTS,
    resources: ['tool:*'],
    tools: scope.entries.map((e) => ({ tool: kernelToolName(e.name), schema: schemaDigest(e.schema) })),
    max_risk: 'medium',
    budget: {
      concurrency: 4,
      wall_ms: 600_000,
      spend: { cpu_ms: 120_000, ram_mib: 2048, gpu_ms: 0, cloud_micros: 2_000_000, events: 1_000 },
    },
    issued_at_ms: issued - 1_000,
    expires_at_ms: issued + GRANT_MS,
    epoch: 1,
  };
  const doc = await mint('grant', fields, localAuthority().issuer, 'issuer');
  grantCache.set(scope.fingerprint, { doc, at: issued });
  return doc;
}

async function signedLease(tenant: string, sid: string, grantId: string, roleDigestHex: string): Promise<SignedDoc> {
  const issued = Date.now();
  const fields = {
    v: 'uap-lease/1',
    lease_id: `lease_${crypto.randomBytes(9).toString('base64url').toLowerCase()}`,
    task_id: `task_${crypto.randomBytes(9).toString('base64url').toLowerCase()}`,
    tenant,
    sid,
    role_digest: roleDigestHex,
    grant_id: grantId,
    epoch: 1,
    issued_at_ms: issued - 1_000,
    expires_at_ms: issued + LEASE_MS,
    revocation: { list: `revocations-${tenant}`, version: 1 },
    nonce: crypto.randomBytes(32).toString('hex'),
  };
  return mint('lease', fields, localAuthority().issuer, 'issuer');
}

// ------------------------------------------------------------------ the decision

function classify(args: unknown, toolName: string): { effect: EffectClass; risk: RiskTier } {
  let c = classifyTool(toolName);
  // A meta-tool runs other tools: the intent it proposes is the most severe of them.
  for (const slug of innerToolSlugs(toolName, args)) {
    const inner = classifyTool(slug);
    if (EFFECT_ORDER.indexOf(inner.effect) > EFFECT_ORDER.indexOf(c.effect)) c = { ...c, effect: inner.effect };
    if (RISK_ORDER.indexOf(inner.risk) > RISK_ORDER.indexOf(c.risk)) c = { ...c, risk: inner.risk };
  }
  return c;
}

function record(input: {
  botId: string; userId: string; tenant: string; sid: string; tool: string;
  effect: string; risk: string; decision: 'allow' | 'deny'; code: string;
  intentDigest?: string; paramsDigest?: string; permitId?: string;
}): void {
  db.prepare(`INSERT INTO policy_decisions
    (bot_id, user_id, tenant, sid, tool, effect, risk, decision, code, intent_digest, params_digest, permit_id, at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.botId, input.userId, input.tenant, input.sid, input.tool, input.effect, input.risk,
    input.decision, input.code, input.intentDigest ?? null, input.paramsDigest ?? null,
    input.permitId ?? null, now(),
  );
}

/**
 * Authorize one model-proposed tool call. Always returns a decision; never throws — a
 * throw here would be an unhandled tool error, and a refusal is the correct answer in
 * every uncertain case.
 */
export async function authorizeModelToolCall(input: ToolAuthorizationInput): Promise<ToolAuthorizationDecision> {
  const toolName = String(input.toolName ?? '');
  const classified = classify(input.args, toolName);
  const base = { effect: classified.effect, risk: classified.risk };
  let tenant = '';
  let sid = '';
  try {
    const bot = getBotRow(input.botId) as any;
    if (!bot || bot.user_id !== input.userId) {
      return { allowed: false, code: 'actor-unknown', detail: 'no such bot for this owner', ...base };
    }
    tenant = tenantOf(input.userId);
    sid = sidOf(input.botId);

    const blocked = new Set(blockedTools(input.userId));
    const entries = (await catalogFor(input.userId))
      .filter((e) => !blocked.has(e.name.toLowerCase()));
    const match = entries.find((e) => e.name.toLowerCase() === toolName.toLowerCase());
    if (!match) {
      const detail = `the tool ${JSON.stringify(toolName)} is not in this agent's grant (unknown, or blocked by the owner)`;
      record({ ...input, tenant, sid, tool: toolName, ...base, decision: 'deny', code: 'tool-not-granted' });
      return { allowed: false, code: 'tool-not-granted', detail, ...base };
    }

    // The pinned schema is the catalogue's, never the caller's: a grant that re-pinned
    // whatever schema arrived with the call would authorise every schema change.
    const schema = input.schema ?? match.schema;
    const fingerprint = `${tenant}|${sid}|${sha256Hex(entries.map((e) => `${kernelToolName(e.name)}:${schemaDigest(e.schema)}`).join('\n'))}`;
    const grant = await signedGrant({ tenant, sid, entries, fingerprint });

    const grantId = (grant.fields as any).grant_id as string;
    const lease = await signedLease(tenant, sid, grantId, roleDigest(input.botId));

    const intentId = `int_${crypto.randomBytes(9).toString('base64url').toLowerCase()}`;
    const paramsDigest = sha256Hex(canonicalArgs(input.args));
    const issuedAt = Date.now();
    const intent = {
      v: 'uap-intent/1',
      intent_id: intentId,
      tenant,
      sid,
      task_id: (lease.fields as any).task_id,
      role_digest: roleDigest(input.botId),
      tool: kernelToolName(toolName),
      tool_schema: schemaDigest(schema),
      effect: classified.effect,
      risk: classified.risk,
      target: targetFor(toolName),
      params: paramsDigest,
      // Every external effect carries its own key: the kernel refuses a second call with
      // the same key inside one kernel instance, and the audit trail can join the two.
      idempotency: classified.effect === 'read' || classified.effect === 'compute'
        ? null
        : `idem_${crypto.randomBytes(9).toString('base64url').toLowerCase()}`,
      spend: {
        cpu_ms: 5_000,
        ram_mib: 512,
        gpu_ms: 0,
        cloud_micros: toolName.toLowerCase() === 'x_search' ? 20_000 : 0,
        events: 10,
      },
      issued_at_ms: issuedAt,
      expires_at_ms: issuedAt + 30_000,
      advisory: null,
    };

    const authority = localAuthority();
    const bundle = {
      v: 'uap-authorize/1',
      now_ms: issuedAt,
      trust: {
        issuers: [{ id: authority.issuer.id, public_key_hex: authority.issuer.publicHex }],
        approvers: [{
          id: authority.approver.id,
          public_key_hex: authority.approver.publicHex,
          clearance: authority.approver.clearance,
        }],
      },
      revocations: [{ list: `revocations-${tenant}`, version: 1 }],
      grant,
      lease,
      intent,
      approval: null,
    };

    const r = await runBin(authorizeBin(), JSON.stringify(bundle));
    if (r.timedOut || r.status === null) {
      const detail = r.timedOut
        ? `the policy kernel did not answer within ${KERNEL_TIMEOUT_MS}ms`
        : `the policy kernel could not be executed (${r.stderr.trim() || authorizeBin()})`;
      record({ ...input, tenant, sid, tool: toolName, ...base, decision: 'deny', code: 'policy-unavailable', paramsDigest });
      return { allowed: false, code: 'policy-unavailable', detail, ...base, paramsDigest };
    }
    let decision: any;
    try {
      decision = JSON.parse(r.stdout);
    } catch {
      record({ ...input, tenant, sid, tool: toolName, ...base, decision: 'deny', code: 'policy-unavailable', paramsDigest });
      return { allowed: false, code: 'policy-unavailable', detail: 'the policy kernel answered with something that is not JSON', ...base, paramsDigest };
    }
    if (decision.allowed === true && decision.permit?.intent_id === intentId) {
      record({ ...input, tenant, sid, tool: toolName, ...base, decision: 'allow', code: 'allow', paramsDigest, intentDigest: decision.intent_digest, permitId: decision.permit.permit_id });
      return {
        allowed: true,
        code: 'allow',
        ...base,
        paramsDigest,
        intentDigest: decision.intent_digest,
        permit: {
          permitId: decision.permit.permit_id,
          intentId: decision.permit.intent_id,
          effect: decision.permit.effect,
          expiresAtMs: decision.permit.expires_at_ms,
        },
        auditSeq: decision.audit_seq,
      };
    }
    const code = typeof decision.code === 'string' ? decision.code : 'policy-unavailable';
    const detail = decision.detail ?? (code === 'invalid-request' ? r.stdout.slice(0, 300) : undefined);
    record({ ...input, tenant, sid, tool: toolName, ...base, decision: 'deny', code, paramsDigest });
    return { allowed: false, code, detail, ...base, paramsDigest };
  } catch (e: any) {
    const detail = String(e?.message ?? e).slice(0, 300);
    try {
      if (tenant && sid) record({ ...input, tenant, sid, tool: toolName, ...base, decision: 'deny', code: 'policy-unavailable' });
    } catch { /* the audit write is best-effort here; the refusal is not */ }
    return { allowed: false, code: 'policy-unavailable', detail, ...base };
  }
}

/** What the model is told when the kernel refuses. No retry hint, no partial success. */
export function refusalText(decision: ToolAuthorizationDecision): string {
  const reason = decision.detail ? `${decision.code} — ${decision.detail}` : decision.code;
  return `Policy refused this action (${reason}). It did not run. Do not retry it unchanged; if it is genuinely needed, tell the owner what was refused and why.`;
}
