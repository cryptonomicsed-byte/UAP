// C-18 (V6-03-06): the built-in launch roster is the product's opening workforce.
// A role that cannot state its artifacts, its gates and its reviewer is a chat prompt, not a role.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-launch-roster-'));

const {
  LAUNCH_ROSTER, ROSTER_SCHEMA, EFFECT_CLASSES, RISK_TIERS,
  getLaunchRole, rosterDigest, roleDigest,
} = await import('../server/src/roles/launch-roster.ts');

// The eleven families V6-03-06 names, in the item's own words.
const REQUIRED_ROLES = [
  'architecture.solution-architect',
  'engineering.frontend-engineer',
  'engineering.backend-engineer',
  'qa.reality-checker',
  'security.authorized-security-analyst',
  'rust.systems-engineer',
  'elixir.otp-supervisor-engineer',
  'julia.performance-engineer',
  'move.sui-engineer',
  'go.networking-engineer',
  'python.integration-engineer',
  'clojure.domain-modeler',
  'creative.brand-director',
  'creative.editorial-ui-designer',
  'research.evidence-researcher',
];

const sha256 = (value) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { content_digest, ...undigested } = LAUNCH_ROSTER[0] ?? {};
void content_digest; void undigested;

test('the launch roster covers every family V6-03-06 requires', () => {
  const ids = LAUNCH_ROSTER.map((r) => r.role_id);
  assert.equal(new Set(ids).size, ids.length, 'role ids are unique');
  for (const id of REQUIRED_ROLES) assert.ok(ids.includes(id), `missing launch role ${id}`);
  assert.ok(LAUNCH_ROSTER.length >= REQUIRED_ROLES.length);
  assert.equal(ROSTER_SCHEMA, 'platform.roles/v1');
});

test('every manifest carries the published RoleTemplate contract', () => {
  const strings = ['role_id', 'publisher_id', 'name', 'domain', 'version', 'source_repo', 'license', 'content_digest', 'instructions', 'risk_class'];
  const lists = ['skills', 'expected_artifacts', 'evaluation_suite', 'requested_capabilities', 'compatible_runtime_versions', 'quality_gates', 'required_reviewers'];
  for (const r of LAUNCH_ROSTER) {
    for (const key of strings) assert.equal(typeof r[key], 'string', `${r.role_id}.${key} must be a string`);
    for (const key of strings) assert.ok(r[key].length > 0, `${r.role_id}.${key} must not be empty`);
    for (const key of lists) {
      assert.ok(Array.isArray(r[key]) && r[key].length > 0, `${r.role_id}.${key} must be a non-empty list`);
      for (const v of r[key]) assert.equal(typeof v, 'string', `${r.role_id}.${key} entries must be strings`);
    }
    assert.ok('source_commit' in r, `${r.role_id} must declare source_commit (null only for built-in text)`);
    assert.ok('deprecation' in r, `${r.role_id} must declare deprecation`);
    assert.match(r.role_id, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, `${r.role_id} must be <domain>.<slug>`);
    assert.equal(r.domain, r.role_id.split('.')[0], `${r.role_id} domain must match its id prefix`);
    assert.match(r.version, /^\d+\.\d+\.\d+$/, `${r.role_id}.version must be semver`);
    assert.ok(RISK_TIERS.includes(r.risk_class), `${r.role_id}.risk_class ${r.risk_class} is a kernel risk tier`);
    assert.equal(r.source_repo, 'builtin', 'launch roles are authored in-repo, not ingested');
    assert.equal(r.source_commit, null, 'built-in text has no upstream commit to pin');
    assert.equal(r.license, 'MIT');
    assert.equal(r.deprecation, null);
  }
});

test('a role template requests capabilities and can never carry a grant', () => {
  for (const r of LAUNCH_ROSTER) {
    for (const forbidden of ['grants', 'grant', 'allowed_tools', 'tools', 'capabilities']) {
      assert.ok(!(forbidden in r), `${r.role_id} must not carry ${forbidden}: templates request, the kernel grants`);
    }
    for (const cap of r.requested_capabilities) {
      assert.ok(EFFECT_CLASSES.includes(cap), `${r.role_id} requests ${cap}, which is not a kernel effect class`);
    }
  }
});

test('launch roles cannot reach money, publish, production or clinical effects', () => {
  const elevated = ['money', 'publish', 'production_change', 'clinical_data'];
  for (const r of LAUNCH_ROSTER) {
    for (const cap of r.requested_capabilities) {
      assert.ok(!elevated.includes(cap), `${r.role_id} requests ${cap}; no launch role may hold it`);
    }
  }
  const securityTesting = LAUNCH_ROSTER.filter((r) => r.requested_capabilities.includes('security_testing'));
  assert.deepEqual(securityTesting.map((r) => r.role_id), ['security.authorized-security-analyst']);
  for (const r of securityTesting) {
    assert.equal(r.approval_required, true, 'security testing requires an approved engagement');
    assert.match(r.instructions, /authoriz/i, 'the security role states the engagement precondition');
  }
  for (const r of LAUNCH_ROSTER) {
    if (!r.requested_capabilities.includes('security_testing')) {
      assert.equal(r.approval_required, false, `${r.role_id} needs no engagement approval`);
    }
  }
});

test('artifacts, gates, task plans and reviewers are objective and independent', () => {
  for (const r of LAUNCH_ROSTER) {
    assert.ok(r.expected_artifacts.length >= 2, `${r.role_id} must name at least two artifacts`);
    assert.ok(r.evaluation_suite.length >= 1, `${r.role_id} must name an evaluation suite`);
    assert.ok(r.quality_gates.length >= 1, `${r.role_id} must name a quality gate`);
    assert.ok(r.required_reviewers.length >= 1, `${r.role_id} must name an independent reviewer`);
    assert.ok(!r.required_reviewers.includes(r.role_id), `${r.role_id} cannot review its own work`);
    assert.ok(Array.isArray(r.sample_task_plan) && r.sample_task_plan.length >= 3, `${r.role_id} needs a 3+ step sample plan`);
    for (const step of r.sample_task_plan) {
      assert.equal(typeof step.step, 'string');
      assert.ok(step.step.length > 0);
      assert.ok(r.expected_artifacts.includes(step.artifact), `${r.role_id} step artifact ${step.artifact} must be one of its expected artifacts`);
    }
  }
});

test('digests are derived from content, so a silent edit is detectable', () => {
  for (const r of LAUNCH_ROSTER) {
    const { content_digest: stored, ...rest } = r;
    assert.equal(stored, roleDigest(rest), `${r.role_id} digest does not match its content`);
    assert.equal(stored, sha256(rest), `${r.role_id} digest is sha256 over the manifest without the digest field`);
    assert.notEqual(roleDigest({ ...rest, name: rest.name + ' ' }), stored, 'changing the name must change the digest');
  }
  assert.equal(rosterDigest(), sha256(LAUNCH_ROSTER.map(({ content_digest: d }) => d)));
});

test('the roster is immutable at runtime', () => {
  assert.ok(Object.isFrozen(LAUNCH_ROSTER));
  for (const r of LAUNCH_ROSTER) {
    assert.ok(Object.isFrozen(r), `${r.role_id} must be frozen`);
    for (const key of ['expected_artifacts', 'requested_capabilities', 'quality_gates', 'required_reviewers', 'sample_task_plan']) {
      assert.ok(Object.isFrozen(r[key]) || Object.isFrozen(r), `${r.role_id}.${key} must be frozen`);
    }
  }
  assert.throws(() => { LAUNCH_ROSTER.push(LAUNCH_ROSTER[0]); }, TypeError);
});

test('lookup is by exact id and unknown ids are absent, not guessed', () => {
  assert.equal(getLaunchRole('rust.systems-engineer').name, 'Rust Systems Engineer');
  assert.equal(getLaunchRole('rust.systems-engineer'), LAUNCH_ROSTER.find((r) => r.role_id === 'rust.systems-engineer'));
  assert.equal(getLaunchRole('rust.systems-engineer '), null);
  assert.equal(getLaunchRole('nope.nothing'), null);
  assert.equal(getLaunchRole(''), null);
});

// ---------- HTTP surface: the roster is served, not a module only tests import ----------

let child;
let base;
let cookie;

before(async () => {
  const secret = 'launch-roster-secret';
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

test('GET /api/roles/roster serves the same roster the module exports', async () => {
  const anonymous = await fetch(`${base}/api/roles/roster`);
  assert.equal(anonymous.status, 401, 'the catalog is not public');

  const res = await fetch(`${base}/api/roles/roster`, { headers: { cookie } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.schema, ROSTER_SCHEMA);
  assert.equal(body.digest, rosterDigest());
  assert.equal(body.roles.length, LAUNCH_ROSTER.length);
  assert.deepEqual(body.roles.map((r) => r.content_digest), LAUNCH_ROSTER.map((r) => r.content_digest));

  const one = await fetch(`${base}/api/roles/roster/move.sui-engineer`, { headers: { cookie } });
  assert.equal(one.status, 200);
  assert.equal((await one.json()).role.name, 'Sui Move Engineer');

  const missing = await fetch(`${base}/api/roles/roster/nope.nothing`, { headers: { cookie } });
  assert.equal(missing.status, 404);
});
