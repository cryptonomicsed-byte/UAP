/**
 * TDD coverage for residual V6 depth (closes checklist partials).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mintPortableLease,
  verifyPortableLease,
  goldenLeaseFixture,
  discoverTools,
  authorizeComputerAction,
  juliaNumericFixture,
  GoStreamAdapter,
  clojureExplainDeny,
  assertWebSurface,
  drainOlderSkillVersions,
  suiLocalnetInvariants,
  foundryInvariantGate,
  clinicalReviewGate,
  scienceReproPack,
  personaStabilityScore,
  sceneNeedsSim,
  deviceBudgetCheck,
  auditMusicSource,
  validateMidiExport,
  soundtrackQc,
  parallaxMediaJob,
  craftWorkspaceGate,
  factoryCancelRestart,
  orgWalletSpend,
  userControlAction,
  ssrfGuard,
  redactPii,
  loadTestDormantSids,
  a11yCoreFlow,
  motionDirectorBudget,
  exactlyOnceEffect,
  pythonToolArgsGate,
  pinCandidateSource,
} from '../server/src/lib/v6-residual.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('V6 residual — portable lease', () => {
  it('verifies golden lease across four langs', () => {
    const secret = 'fixture-secret';
    const { lease, langs } = goldenLeaseFixture(secret);
    for (const lang of langs) {
      const r = verifyPortableLease(lease, secret, lang);
      assert.equal(r.ok, true, lang);
    }
    const bad = verifyPortableLease(lease, 'wrong', 'rust');
    assert.equal(bad.ok, false);
  });

  it('rejects expired lease', () => {
    const lease = mintPortableLease({
      agentSid: 's',
      resource: 'r',
      budget: { tokens: 1, toolCalls: 1, wallMs: 1 },
      ttlMs: -1000,
      secret: 's',
    });
    assert.equal(verifyPortableLease(lease, 's', 'go').ok, false);
  });
});

describe('V6 residual — hermes/computer/vault', () => {
  it('discovers only permitted tools', () => {
    const tools = discoverTools({
      mcpEnabled: true,
      composioEnabled: true,
      computerEnabled: true,
      permittedNames: ['mcp.list_tools', 'computer.screenshot'],
    });
    assert.ok(tools.some((t) => t.name === 'mcp.list_tools'));
    assert.ok(!tools.some((t) => t.name === 'composio.action'));
    assert.ok(tools.some((t) => t.name === 'computer.screenshot'));
  });

  it('requires vault + consent + single master', () => {
    assert.equal(
      authorizeComputerAction({
        action: 'computer.click',
        vaultSession: 'vs_1',
        hostConsent: true,
        master: 'computer',
      }).allowed,
      true,
    );
    assert.equal(
      authorizeComputerAction({
        action: 'box.exec',
        vaultSession: 'vs_1',
        hostConsent: true,
        master: 'computer',
      }).allowed,
      false,
    );
  });
});

describe('V6 residual — language adapters', () => {
  it('julia unit vector fixture', () => {
    const r = juliaNumericFixture(42, [0.6, 0.8]);
    assert.equal(r.withinTolerance, true);
  });

  it('go stream rejects late/dup/egress', () => {
    const s = new GoStreamAdapter(2);
    const now = Date.now();
    assert.equal(s.push({ id: 'a', seq: 1, payload: 'ok', deadlineMs: now + 1000 }, now).accepted, true);
    assert.equal(s.push({ id: 'a', seq: 2, payload: 'ok', deadlineMs: now + 1000 }, now).accepted, false);
    assert.equal(s.push({ id: 'b', seq: 0, payload: 'ok', deadlineMs: now + 1000 }, now).accepted, false);
    assert.equal(s.push({ id: 'c', seq: 2, payload: 'file:///etc/passwd', deadlineMs: now + 1000 }, now).accepted, false);
    assert.equal(s.push({ id: 'd', seq: 2, payload: 'late', deadlineMs: now - 1 }, now).accepted, false);
  });

  it('clojure cannot override DENY', () => {
    const r = clojureExplainDeny({ rustDecision: 'DENY', explanation: 'should allow really' });
    assert.equal(r.effective, 'DENY');
    assert.equal(r.overridden, false);
  });

  it('python rejects shell', () => {
    assert.equal(pythonToolArgsGate({ command: 'ls; rm -rf /' }, false).ok, false);
    assert.equal(pythonToolArgsGate({ path: '/tmp/x' }, false).ok, true);
  });

  it('web surface present', () => {
    assert.equal(assertWebSurface(ROOT).ok, true);
  });
});

describe('V6 residual — skill drain + chain', () => {
  it('drains older skill versions', () => {
    const tasks = [
      { taskId: 't1', skillId: 's', version: 1, state: /** @type {'running'} */ ('running') },
      { taskId: 't2', skillId: 's', version: 3, state: /** @type {'running'} */ ('running') },
    ];
    const r = drainOlderSkillVersions(tasks, 3);
    assert.deepEqual(r.drained, ['t1']);
    assert.equal(tasks[0].state, 'draining');
  });

  it('sui localnet invariants', () => {
    assert.equal(
      suiLocalnetInvariants({
        network: 'localnet',
        hasObjectOwner: true,
        capabilityOk: true,
        signingKeyExposed: false,
      }).ok,
      true,
    );
    assert.equal(
      suiLocalnetInvariants({
        network: 'mainnet',
        hasObjectOwner: true,
        capabilityOk: true,
        signingKeyExposed: false,
      }).ok,
      false,
    );
  });

  it('foundry gate needs fuzz + no critical', () => {
    assert.equal(foundryInvariantGate({ forgeTestPass: true, fuzzRuns: 512, criticalFindings: 0 }).ok, true);
    assert.equal(foundryInvariantGate({ forgeTestPass: true, fuzzRuns: 10, criticalFindings: 0 }).ok, false);
  });
});

describe('V6 residual — research/npc/media', () => {
  it('clinical blocks unsafe automation', () => {
    assert.equal(
      clinicalReviewGate({ clinicalImpact: true, autoAct: true }).ok,
      false,
    );
    assert.equal(
      clinicalReviewGate({ clinicalImpact: true, professionalReviewerId: 'doc1', autoAct: false }).ok,
      true,
    );
  });

  it('science repro pack complete', () => {
    assert.equal(
      scienceReproPack({
        datasetIds: ['d1'],
        notebookHash: 'abc',
        envLockHash: 'def',
        statisticalCheckPass: true,
        seed: 7,
      }).ok,
      true,
    );
  });

  it('persona stability + scene + device', () => {
    assert.equal(personaStabilityScore(['Hello guide here', 'Hello traveler guide']).stable, true);
    assert.equal(sceneNeedsSim([{ id: '1', need: 'food', relatedTo: ['2'] }]).assumesConsciousness, false);
    assert.equal(
      deviceBudgetCheck({
        targetDevice: 'quest3',
        vramMb: 4000,
        interactionLatencyMs: 20,
        budgetVramMb: 8000,
        budgetLatencyMs: 33,
      }).ok,
      true,
    );
  });

  it('media midi + soundtrack + parallax', () => {
    const midi = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96]);
    assert.equal(validateMidiExport(midi).ok, true);
    assert.equal(auditMusicSource({ name: 'x', license: 'CC0', pinnedSha: 'a'.repeat(40), providerUrl: 'https://ex.com' }).ok, true);
    assert.equal(
      soundtrackQc({
        durationSec: 30,
        loopSeamless: true,
        loudnessLufs: -14,
        clipping: false,
        captions: true,
        syncCues: 2,
      }).ok,
      true,
    );
    assert.equal(parallaxMediaJob({ billed: true, evidenceRegistryId: 'e1', tenantId: 't' }).ok, true);
  });
});

describe('V6 residual — factory marketplace ops', () => {
  it('craft + cancel preserve artifacts', () => {
    assert.equal(craftWorkspaceGate({ projectId: 'p', permissioned: true, path: '/ws/p' }).ok, true);
    const r = factoryCancelRestart({ id: 'j', artifactVersions: ['v1'], state: 'running' }, 'cancel');
    assert.equal(r.state, 'cancelled');
    assert.deepEqual(r.preserved, ['v1']);
  });

  it('org wallet + user controls', () => {
    let w = { orgId: 'o', credits: 10, approvalsRequired: true, paused: false };
    assert.equal(orgWalletSpend(w, 5, false).ok, false);
    const s = orgWalletSpend(w, 5, true);
    assert.equal(s.ok, true);
    assert.equal(s.wallet.credits, 5);
    let u = { paused: false, revoked: false, terminated: false, dataDeleted: false };
    u = userControlAction(u, 'revoke');
    u = userControlAction(u, 'delete_data');
    assert.equal(u.dataDeleted, true);
  });

  it('ssrf + pii + load + a11y + exactly-once', () => {
    assert.equal(ssrfGuard('https://example.com/a').ok, true);
    assert.equal(ssrfGuard('http://127.0.0.1/').ok, false);
    assert.equal(ssrfGuard('http://169.254.169.254/').ok, false);
    assert.match(redactPii('mail me@x.com ssn 123-45-6789'), /REDACTED/);
    assert.equal(loadTestDormantSids({ dormantCount: 10_000, simultaneousWorkers: 8, workerCap: 8 }).ok, true);
    assert.equal(loadTestDormantSids({ dormantCount: 1, simultaneousWorkers: 20, workerCap: 8 }).ok, false);
    assert.equal(a11yCoreFlow({ keyboardNav: true, screenReaderLabels: true, reducedMotion: true }).ok, true);
    assert.equal(motionDirectorBudget({ fps: 60, frameBudgetMs: 16, choreographyStates: ['a', 'b'] }).ok, true);
    const store = new Map();
    assert.equal(exactlyOnceEffect(store, 'k', 'e1').applied, true);
    assert.equal(exactlyOnceEffect(store, 'k', 'e2').applied, false);
  });

  it('pins candidate sources', () => {
    assert.equal(pinCandidateSource({ repo: 'r', headSha: 'a'.repeat(40), license: 'MIT' }).ok, true);
    assert.equal(pinCandidateSource({ repo: 'r', headSha: 'short', license: 'MIT' }).ok, false);
  });
});
