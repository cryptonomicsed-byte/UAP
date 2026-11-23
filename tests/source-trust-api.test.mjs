// B-22 HTTP surface: the trust decision and the re-audit plan are computed over posted
// records. Neither persists anything (the registry writer owns that), and both refuse an
// anonymous caller like the rest of /api.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-source-trust-'));

const { promotionStatement, keyFingerprint } = await import('../server/src/sources/trust.ts');

const NOW = 1_760_000_000_000;

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = keyFingerprint(pem);
const reviewer = { id: 'rev-alice', publicKeyPem: pem, capabilities: ['source-reviewer', 'security-auditor'], active: true };
const source = {
  sourceId: 'src_' + 'a'.repeat(16),
  canonicalUrl: 'https://github.com/example/agent-skills',
  trustStatus: 'USER_SUPPLIED_UNVERIFIED',
  reviewerSignature: null,
  submittedBy: 'tenant-owner',
  ingestedBy: 'worker-c',
  access: { status: 'ok' },
  pinnedCommit: 'b'.repeat(40),
  manifest: { digest: 'c'.repeat(64), fileCount: 84 },
  license: { spdx: 'MIT', commercialUse: 'allowed' },
  lastAuditedAt: null,
  revokedAt: null,
};
const evidence = {
  audit: { reportDigest: 'd'.repeat(64), auditorId: 'auditor-1', completedAt: NOW - 3_600_000, criticalFindings: 0 },
};
const sign = (target) => {
  const statement = promotionStatement({ source, target, reviewerId: reviewer.id, reviewerKey: fingerprint, signedAt: NOW - 1000, evidence });
  return {
    reviewerId: reviewer.id, keyFingerprint: fingerprint, signedAt: NOW - 1000,
    signature: crypto.sign(null, Buffer.from(statement), privateKey).toString('base64'),
  };
};

let child;
let base;
let cookie;

before(async () => {
  const secret = 'source-trust-secret';
  await mkdir(path.join(dir, 'primary', 'memories'), { recursive: true });
  const env = {
    ...process.env, SESSION_SECRET: secret, PORT: '0', UAP_NO_SCHEDULER: '1', GROKBOT_NO_SCHEDULER: '1',
    DB_PATH: path.join(dir, 'app.sqlite'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_HOME_PRIMARY: path.join(dir, 'primary'), DEV_LOGIN: '0', ALLOWED_EMAILS: '',
  };
  for (const key of ['XAI_API_KEY', 'ORGO_API_KEY', 'COMPOSIO_API_KEY']) { delete env[key]; delete env[`${key}_FILE`]; }
  child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 30000);
    const onData = (part) => {
      output += part;
      const match = output.match(/server on (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${output}`)); });
  });
  const ownerKey = crypto.createHmac('sha256', secret).update('owner-login').digest('hex');
  const login = await fetch(`${base}/api/auth/owner`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

after(async () => {
  child?.kill();
  await rm(dir, { recursive: true, force: true });
});

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /api/sources/trust/evaluate returns the same decision the writer uses', async () => {
  const anonymous = await fetch(`${base}/api/sources/trust/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, target: 'STATIC_AUDITED', reviewers: [reviewer], signature: sign('STATIC_AUDITED'), now: NOW }),
  });
  assert.equal(anonymous.status, 401, 'trust evaluation is not a public surface');

  const ok = await post('/api/sources/trust/evaluate', { source, target: 'STATIC_AUDITED', reviewers: [reviewer], signature: sign('STATIC_AUDITED'), evidence, now: NOW });
  const okBody = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.decision.allowed, true);
  assert.equal(okBody.decision.record.trustStatus, 'STATIC_AUDITED');

  // A signature for STATIC_AUDITED cannot be presented for SANDBOX_EVALUATED.
  const retarget = await post('/api/sources/trust/evaluate', { source, target: 'SANDBOX_EVALUATED', reviewers: [reviewer], signature: sign('STATIC_AUDITED'), evidence, now: NOW });
  const retargetBody = await retarget.json();
  assert.equal(retarget.status, 200);
  assert.equal(retargetBody.decision.allowed, false);
  // The retargeted signature is refused; the rung also rightly asks for sandbox evidence.
  assert.equal(retargetBody.decision.blockers.some((b) => b.code === 'signature_mismatch'), true, JSON.stringify(retargetBody.decision.blockers));

  const missing = await post('/api/sources/trust/evaluate', { target: 'PUBLISHED' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'source required');
});

test('POST /api/sources/reaudit/plan reports due sources and revocation alerts', async () => {
  const sourceRow = {
    sourceId: 'src_' + 'e'.repeat(16),
    canonicalSlug: 'example/agent-skills',
    trustStatus: 'STATIC_AUDITED',
    riskClass: 'medium',
    observedAt: NOW - 400 * 86_400_000,
    lastAuditedAt: NOW - 120 * 86_400_000,
    dependencies: [{ name: 'old-http', version: '0.2.5' }],
  };
  const res = await post('/api/sources/reaudit/plan', {
    sources: [sourceRow],
    advisories: [{ id: 'ADV-9', kind: 'compromised-origin', owner: 'example', publishedAt: NOW }],
    now: NOW,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.plan.due.length, 1);
  assert.equal(body.plan.due[0].reason, 'cadence');
  assert.equal(body.alerts.length, 1);
  assert.equal(body.alerts[0].severity, 'critical');
  assert.equal(body.alerts[0].action, 'revoke_now');

  const bad = await post('/api/sources/reaudit/plan', { sources: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'sources required');

  const notArray = await post('/api/sources/reaudit/plan', { sources: [], advisories: 'nope' });
  assert.equal(notArray.status, 400);
});
