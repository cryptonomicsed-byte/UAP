/**
 * V6 product surface routes — gates, marketplace, SID lifecycle, evidence.
 * Mounted under /api/v6/* so the shell and operators can exercise real modules.
 */
import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs';
import type { AuthVars } from './lib/auth.js';
import { requireUser } from './lib/auth.js';
import { listLanguageGatePacks, runLanguageGatePack, acceptPackClaim, type LanguageId } from './lib/language-gates.js';
import { listFiveTiers, createTenant, oneClickInstall, makeMarketplaceItem, meterCredits, TIERS, type TierId } from './lib/marketplace.js';
import { evaluateDesignGates } from './lib/design-gates.js';
import { evaluateReleaseNogo } from './lib/design-critique.js';
import { runAllE2E, allE2EPass } from './lib/e2e-suites.js';
import { runFinalSignoff } from './lib/final-signoff.js';
import { BUILTIN_ROSTER } from './roles/builtin-roster.js';
import { shouldIssueSid, createWorldEntity, loadScene, type EntityKind } from './lib/npc-world.js';
import { unloadScene } from './lib/world-policy.js';
import { CHAIN_TEMPLATES, evaluateTxApproval, distinguishFamily, type TxApprovalRequest } from './lib/chain-gates.js';
import { ConsentRegistry, type ConsentPurpose } from './lib/patient-consent.js';
import { RESEARCH_ROLES, evaluateResearchOutput } from './lib/research-gates.js';
import { MEDIA_ROLES, createMediaAsset, reviewRights } from './lib/media-rights.js';
import { createFactoryJob, smithersBuild, skillforgeAttachPack, reaEvaluate, assertFactoryPromoteAllowed } from './lib/factory-pipeline.js';
import { adoptionReport, loadAdoptionMatrix } from './lib/agentos-adoption.js';
import { SidTemplateError, SidTemplateRuntime, superviseSpawn } from './lib/sid-templates.js';
import { materializeSidBot } from './lib/sid-bots.js';
import { polyglotMap } from './lib/polyglot-map.js';
import { SOURCE_RIGHTS, duskbotBlocked } from './lib/source-rights.js';
import { autonomyDecision, getAutonomy, setAutonomy, type Autonomy } from './lib/autonomy.js';
import { boardSnapshot } from './lib/board.js';
import { liveSnapshot } from './lib/live.js';
import { domainSurface } from './lib/domain-surface.js';
import { acceptBuild, dispatchSpecialists, packReport, type TaskEvidence } from './lib/engineering-pack.js';
import { scanPromptInjection, signSbom, buildReleaseRecord } from './lib/ops-security.js';
import {
  goldenLeaseFixture,
  verifyPortableLease,
  ssrfGuard,
  a11yCoreFlow,
  discoverTools,
} from './lib/v6-residual.js';
import { providerConfiguration, isProviderConfigured } from './providers.js';
import { env } from './env.js';
import { TOOLS, listAllToolCatalog } from './agent/tools.js';
import { db } from './db.js';
import { openWorkforce, validateTeamPackage, validateComputerLease, validateVoiceSession, authorizeVoiceEffect, validateOauthBinding, driverCall, WorkforceError } from './lib/workforce-runtime.js';
import { spawnSync } from 'node:child_process';

export const v6Api = new Hono<AuthVars>();

const root = () => path.resolve(process.cwd(), '..');

v6Api.get('/health', (c) => c.json({
  ok: true,
  surface: 'v6',
  tracks: ['gates', 'marketplace', 'roles', 'e2e', 'factory', 'domain'],
}));

v6Api.get('/language-packs', (c) => c.json({ packs: listLanguageGatePacks() }));

v6Api.post('/language-packs/:id/run', async (c) => {
  const id = c.req.param('id') as LanguageId;
  const body = await c.req.json().catch(() => ({})) as { dryRun?: boolean; claimPass?: boolean };
  if (body.claimPass) {
    return c.json(acceptPackClaim({ packId: id, claimedPass: true }));
  }
  const result = runLanguageGatePack(id, { dryRun: body.dryRun !== false, cwd: root() });
  return c.json(result);
});

v6Api.get('/tiers', (c) => c.json({ tiers: listFiveTiers(), detail: TIERS }));

v6Api.post('/marketplace/install', async (c) => {
  const body = await c.req.json() as { tier?: TierId; itemName?: string; signed?: boolean };
  const tenant = createTenant(body.tier ?? 'builder');
  const item = makeMarketplaceItem({
    name: body.itemName ?? 'demo-pack',
    signed: body.signed !== false,
    minTier: 'free',
  });
  const result = oneClickInstall(tenant, item);
  return c.json({ tenant, item, result });
});

v6Api.post('/marketplace/meter', async (c) => {
  const body = await c.req.json() as { tier?: TierId; amount?: number };
  const tenant = createTenant(body.tier ?? 'free');
  const r = meterCredits(tenant, body.amount ?? 1);
  return c.json({ tenant, ...r });
});

v6Api.get('/design/gates', (c) => c.json(evaluateDesignGates(root())));
v6Api.get('/design/release-nogo', (c) => c.json(evaluateReleaseNogo({ projectRoot: root() })));

v6Api.get('/roles/roster', (c) => {
  const roles = BUILTIN_ROSTER.map((r) => ({
    id: r.template.id,
    version: r.template.version,
    title: r.template.title,
    family: r.family,
    state: r.state,
    riskClass: r.template.riskClass,
    digest: r.template.digest,
    requestedGates: r.requestedGates,
    expectedArtifacts: r.expectedArtifacts,
  }));
  return c.json({ count: roles.length, roles });
});

v6Api.get('/e2e', (c) => {
  const suites = runAllE2E(root());
  return c.json({
    pass: allE2EPass(root()),
    suites: suites.map((s) => ({
      id: s.id,
      name: s.name,
      pass: s.pass,
      checks: s.checks.length,
      failed: s.checks.filter((x) => !x.ok).map((x) => x.name),
    })),
  });
});

v6Api.post('/signoff', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { key?: string; version?: string };
  const key = body.key || process.env.UAP_SIGNOFF_KEY || 'local-dev-signoff-key';
  return c.json(runFinalSignoff(root(), key, body.version ?? '6.0.0'));
});

v6Api.get('/npc/policy', (c) => {
  const kinds: EntityKind[] = ['npc_decorative', 'npc_persistent', 'player_avatar', 'world_prop'];
  return c.json(Object.fromEntries(kinds.map((k) => [k, shouldIssueSid(k)])));
});

v6Api.post('/npc/scene-cycle', async (c) => {
  const npc = createWorldEntity({ kind: 'npc_persistent', sceneId: 'demo', displayName: 'Guide', persona: 'calm' });
  const decor = createWorldEntity({ kind: 'npc_decorative', sceneId: 'demo', displayName: 'Lamp', persona: '' });
  const scene = loadScene('demo', [npc, decor]);
  const tear = unloadScene(scene);
  return c.json({ npc, decor, tear });
});

v6Api.get('/chain/templates', (c) => c.json({ templates: CHAIN_TEMPLATES }));

v6Api.post('/chain/approve', async (c) => {
  const body = await c.req.json() as TxApprovalRequest;
  return c.json(evaluateTxApproval(body));
});

v6Api.post('/chain/distinguish', async (c) => {
  const body = await c.req.json() as { mentions?: string[]; fileExt?: string; packageManifest?: string };
  return c.json({ family: distinguishFamily(body) });
});

v6Api.get('/research/roles', (c) => c.json({ roles: RESEARCH_ROLES }));
v6Api.post('/research/evaluate', async (c) => {
  const body = await c.req.json();
  return c.json(evaluateResearchOutput(body as any));
});

v6Api.get('/media/roles', (c) => c.json({ roles: MEDIA_ROLES }));
v6Api.post('/media/review', async (c) => {
  const body = await c.req.json() as any;
  const asset = createMediaAsset({
    title: body.title ?? 'demo',
    bytes: body.bytes ?? 'demo-bytes',
    license: body.license ?? 'CC0-1.0',
    licensor: body.licensor ?? 'uap',
    territory: body.territory,
    commercialOk: body.commercialOk ?? false,
    parentHash: body.parentHash,
    stemHash: body.stemHash,
  });
  if (body.approve) reviewRights(asset, body.reviewerRole ?? 'rights-reviewer', true);
  return c.json(asset);
});

v6Api.post('/consent/demo', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { purpose?: ConsentPurpose };
  const reg = new ConsentRegistry();
  try {
    const rec = reg.grant({
      subjectId: 'demo-subject',
      tenantId: 'demo-tenant',
      purpose: body.purpose ?? 'care_coordination',
      scope: ['records.read'],
    });
    return c.json({ ok: true, rec });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e), code: e?.code }, 400);
  }
});

v6Api.post('/factory/demo', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { score?: number };
  let job = createFactoryJob('api-demo');
  job = smithersBuild(job, { projectId: 'api-demo', sourceHash: 'src' });
  job = skillforgeAttachPack(job, { id: 'pack', version: '1' });
  job = reaEvaluate(job, {
    artifactHash: job.artifactHash || 'art',
    suiteId: 'rea',
    score: body.score ?? 0.91,
    findings: [],
  });
  let promoteOk = false;
  let err: string | null = null;
  try {
    assertFactoryPromoteAllowed(job);
    promoteOk = true;
  } catch (e: any) {
    err = String(e?.message ?? e);
  }
  return c.json({ job, promoteOk, err });
});

v6Api.post('/security/scan-injection', async (c) => {
  const body = await c.req.json() as { text?: string };
  return c.json(scanPromptInjection(body.text ?? ''));
});

v6Api.get('/evidence-report', (c) => {
  const p = path.join(root(), 'docs/v6-blueprint/v6-evidence-report.json');
  if (!fs.existsSync(p)) return c.json({ error: 'run scripts/v6-evidence-map.mjs first' }, 404);
  return c.json(JSON.parse(fs.readFileSync(p, 'utf8')));
});

v6Api.get('/release/preview', (c) => {
  const sbom = signSbom([{ name: 'uap', version: '6.0.0' }], 'preview', 'preview');
  const rel = buildReleaseRecord({
    version: '6.0.0-preview',
    sbom,
    testsPassed: true,
    injectionScanClean: true,
    backupVerified: true,
    slo: [{ name: 'api', objective: 0.99, windowHours: 24 }],
    playbooks: ['incident-response', 'rollback'],
  });
  return c.json(rel);
});

v6Api.get('/residual/lease-golden', (c) => {
  const secret = 'fixture-secret';
  const { lease, langs } = goldenLeaseFixture(secret);
  const results = langs.map((lang) => verifyPortableLease(lease, secret, lang));
  return c.json({ leaseId: lease.leaseId, results, allOk: results.every((r) => r.ok) });
});

v6Api.post('/residual/ssrf', async (c) => {
  const body = await c.req.json() as { url?: string };
  return c.json(ssrfGuard(body.url ?? ''));
});

v6Api.get('/residual/a11y', (c) =>
  c.json(a11yCoreFlow({ keyboardNav: true, screenReaderLabels: true, reducedMotion: true })),
);

v6Api.get('/residual/tools', (c) =>
  c.json({
    tools: discoverTools({
      mcpEnabled: true,
      composioEnabled: true,
      computerEnabled: true,
      permittedNames: ['mcp.list_tools', 'computer.screenshot'],
    }),
  }),
);

/** Operator surface for the details sidecar — providers, computer mode, MCP tools. */
v6Api.get('/operate-surface', (c) => {
  const catalog = listAllToolCatalog();
  const tools = catalog.map((t) => ({
    name: t.name,
    description: (t.description || '').slice(0, 160),
    provider: t.provider ?? null,
    available: !t.provider || isProviderConfigured(t.provider),
  }));
  return c.json({
    providers: providerConfiguration(),
    computer: {
      localBox: env.localBox,
      orgoConfigured: Boolean(env.orgoKey && env.orgoComputerId),
      maxScreens: Math.min(env.maxBots, 4),
    },
    hermes: {
      url: env.hermesUrl,
      bin: env.hermesBin,
    },
    mcp: {
      tools,
      activeCount: TOOLS.length,
      note: tools.length
        ? undefined
        : 'No built-in MCP tools registered on this server.',
    },
  });
});

const workforce = () => openWorkforce(db);

v6Api.post('/workforce/activate', async (c) => {
  const body = await c.req.json<{ tenantId?: string; roleSlug?: string; roleDigest?: string }>().catch(() => ({ tenantId: 'local', roleSlug: 'specialist', roleDigest: 'b'.repeat(64) }));
  try {
    const installation = workforce().activateRole({
      tenantId: body.tenantId || 'local',
      roleSlug: body.roleSlug || 'specialist',
      roleDigest: body.roleDigest || 'b'.repeat(64),
    });
    return c.json({ installation, note: 'SID persists across tasks' });
  } catch (error) {
    const err = error instanceof WorkforceError ? error : new WorkforceError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

v6Api.post('/workforce/task', async (c) => {
  const body = await c.req.json<{ tenantId?: string; sid?: string; intent?: string; riskClass?: string; idempotencyKey?: string }>().catch(() => ({ tenantId: 'local', sid: '', intent: '', riskClass: 'READ_DRAFT', idempotencyKey: '' }));
  if (!body.sid || !body.intent || !body.idempotencyKey) return c.json({ error: 'sid, intent, idempotencyKey required' }, 400);
  try {
    const task = workforce().assignTask({
      tenantId: body.tenantId || 'local',
      sid: body.sid,
      intent: body.intent,
      riskClass: body.riskClass || 'READ_DRAFT',
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ task });
  } catch (error) {
    const err = error instanceof WorkforceError ? error : new WorkforceError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

v6Api.post('/workforce/teardown', async (c) => {
  const body = await c.req.json<{ taskId?: string; outcome?: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' }>().catch(() => ({ taskId: '', outcome: 'SUCCEEDED' as const }));
  if (!body.taskId) return c.json({ error: 'taskId required' }, 400);
  try {
    return c.json(workforce().teardown(body.taskId, body.outcome || 'SUCCEEDED'));
  } catch (error) {
    const err = error instanceof WorkforceError ? error : new WorkforceError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

v6Api.post('/workforce/contracts', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  try {
    return c.json({
      team: body.team ? validateTeamPackage(body.team as Record<string, unknown>) : null,
      computer: body.computer ? validateComputerLease(body.computer as Record<string, unknown>) : null,
      voice: body.voice ? validateVoiceSession(body.voice as Record<string, unknown>) : null,
      voiceEffect: body.voiceEffect ? authorizeVoiceEffect(body.voiceEffect as { highRisk?: boolean; confirmed?: boolean }) : null,
      oauth: body.oauth && body.actingSid ? validateOauthBinding(body.oauth as Record<string, unknown>, String(body.actingSid)) : null,
      driver: body.driver && body.method ? driverCall(body.driver as { protocol?: string }, String(body.method)) : null,
    });
  } catch (error) {
    const err = error instanceof WorkforceError ? error : new WorkforceError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

v6Api.get('/workforce/elixir-probe', (c) => {
  const probe = spawnSync('elixir', ['-e', 'IO.puts("ALIVE")'], { timeout: 8000, encoding: 'utf8' });
  return c.json({
    backend: probe.status === 0 && probe.stdout.includes('ALIVE') ? 'elixir' : 'unavailable',
    status: probe.status,
    note: 'Elixir is the worker supervisor when present. The task ledger remains authoritative if the BEAM process dies.',
  });
});

v6Api.get('/agentos/adoption', (c) => {
  const file = path.resolve(new URL('../../docs/agentos/AgentOS_repository_adoption_matrix.csv', import.meta.url).pathname);
  if (!fs.existsSync(file)) return c.json({ error: 'adoption matrix is not installed' }, 404);
  const report = adoptionReport(loadAdoptionMatrix(file));
  return c.json({
    count: report.count,
    installable: report.installable,
    executed: report.executed,
    p0: report.p0,
    note: 'A matrix row is not an install. Content is not executed.',
  });
});

const sidTemplates = () => new SidTemplateRuntime(db);

v6Api.get('/sid/templates', (c) => c.json({
  templates: sidTemplates().templates(),
  note: 'A template is a SID birth recipe. It carries no grants. Spawn creates a new SID, never a copy of the parent.',
}));

v6Api.post('/sid/install', async (c) => {
  const body = await c.req.json<{ tenantId?: string; template?: string }>().catch(() => ({ tenantId: undefined as string | undefined, template: undefined as string | undefined }));
  if (!body.template) return c.json({ error: 'template required' }, 400);
  try {
    const agent = sidTemplates().install({ tenantId: body.tenantId || 'local', template: body.template });
    const supervised = superviseSpawn(agent.sid, null);
    return c.json({ agent, supervised });
  } catch (error) {
    const err = error instanceof SidTemplateError ? error : new SidTemplateError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

v6Api.post('/sid/spawn', async (c) => {
  const body = await c.req.json<{ tenantId?: string; parentSid?: string; template?: string }>().catch(() => ({ tenantId: undefined as string | undefined, parentSid: undefined as string | undefined, template: undefined as string | undefined }));
  if (!body.parentSid || !body.template) return c.json({ error: 'parentSid and template required' }, 400);
  try {
    const agent = sidTemplates().spawnSubAgent({ tenantId: body.tenantId || 'local', parentSid: body.parentSid, template: body.template });
    const supervised = superviseSpawn(agent.sid, agent.parentSid);
    return c.json({ agent, supervised });
  } catch (error) {
    const err = error instanceof SidTemplateError ? error : new SidTemplateError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

v6Api.get('/board', (c) => c.json(boardSnapshot(db)));
v6Api.get('/live', (c) => c.json(liveSnapshot(db)));
v6Api.get('/domain', (c) => c.json(domainSurface()));
v6Api.get('/engineering-pack', (c) => c.json(packReport()));
v6Api.post('/smithers/dispatch', async (c) => {
  const body = await c.req.json<{ task?: string }>().catch(() => ({ task: undefined as string | undefined }));
  if (!body.task) return c.json({ error: 'task required' }, 400);
  return c.json(dispatchSpecialists(body.task));
});
v6Api.post('/smithers/accept', async (c) => {
  const body = await c.req.json<TaskEvidence>().catch(() => ({} as TaskEvidence));
  return c.json(acceptBuild(body));
});
v6Api.get('/sources', (c) => c.json({ sources: SOURCE_RIGHTS, duskbot: duskbotBlocked() }));
v6Api.get('/polyglot', (c) => c.json({ pillars: polyglotMap() }));
v6Api.get('/bots/:id/autonomy', (c) => c.json({ mode: getAutonomy(db, c.req.param('id')) }));
v6Api.post('/bots/:id/autonomy', async (c) => {
  const body = await c.req.json<{ mode?: Autonomy }>().catch(() => ({ mode: undefined as Autonomy | undefined }));
  if (body.mode !== 'ask' && body.mode !== 'draft' && body.mode !== 'act') return c.json({ error: 'mode must be ask, draft, or act' }, 400);
  return c.json({ mode: setAutonomy(db, c.req.param('id'), body.mode), sample: autonomyDecision(body.mode, 'spawn_sid_subagent') });
});

v6Api.post('/sid/materialize', requireUser, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ template?: string; parentBotId?: string }>().catch(() => ({ template: undefined as string | undefined, parentBotId: undefined as string | undefined }));
  if (!body.template) return c.json({ error: 'template required' }, 400);
  try {
    const made = materializeSidBot(db, { userId: user.id, template: body.template, parentBotId: body.parentBotId });
    return c.json(made);
  } catch (error) {
    const err = error instanceof SidTemplateError ? error : new SidTemplateError('failed', String((error as Error).message));
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

