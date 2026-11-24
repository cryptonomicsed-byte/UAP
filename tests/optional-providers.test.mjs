import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const cleanEnv = () => {
  const env = { ...process.env, SESSION_SECRET: 'isolated-provider-test' };
  for (const name of ['XAI_API_KEY', 'COMPOSIO_API_KEY', 'ORGO_API_KEY']) {
    delete env[name];
    delete env[`${name}_FILE`];
  }
  for (const name of ['ORGO_COMPUTER_ID', 'HQ_LOCAL', 'UAP_NO_SCHEDULER', 'GROKBOT_NO_SCHEDULER']) delete env[name];
  return env;
};

async function runScript(script, env = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: root, env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  return { code, stdout, stderr };
}

async function withDirectory(prefix, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('missing optional providers reject before contacting external services and are absent from tool discovery', async () => {
  await withDirectory('uap-provider-contract-', async dir => {
    const result = await runScript(`
      import assert from 'node:assert/strict';
      import { providerConfiguration, requireProvider } from './server/src/providers.ts';
      import { catalog, composioTools, getComposio } from './server/src/composio.ts';
      import { orgo } from './server/src/orgo.ts';
      import { TOOLS, toolMap } from './server/src/agent/tools.ts';
      globalThis.fetch = () => { throw new Error('unexpected network request'); };
      for (const id of ['xai', 'orgo', 'composio']) {
        assert.equal(providerConfiguration()[id].status, 'unconfigured');
        assert.throws(() => requireProvider(id), { name: 'ProviderUnavailableError' });
      }
      assert.throws(() => getComposio(), { name: 'ProviderUnavailableError' });
      await assert.rejects(catalog(), { name: 'ProviderUnavailableError' });
      assert.deepEqual(await composioTools('unused'), []);
      await assert.rejects(orgo.getComputer('unused'), { name: 'ProviderUnavailableError' });
      for (const name of ['x_search', 'list_event_triggers', 'create_event_routine', 'request_app_connection']) {
        assert.ok(!TOOLS.some(tool => tool.name === name), name + ' must not be advertised');
      }
      await assert.rejects(toolMap.get('x_search').impl({ query: 'unused' }, {}), { name: 'ProviderUnavailableError' });
      assert.ok(TOOLS.some(tool => tool.name === 'create_task'), 'local functionality remains discoverable');
    `, { DB_PATH: path.join(dir, 'test.sqlite'), HERMES_HOME_PRIMARY: path.join(dir, 'hermes') });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('computer execution reports the actual missing prerequisite without running commands', async () => {
  await withDirectory('uap-computer-config-', async dir => {
    for (const [extraEnv, setting] of [
      [{ ORGO_API_KEY: 'configured-fixture-key' }, 'ORGO_COMPUTER_ID'],
      [{ ORGO_COMPUTER_ID: 'configured-computer' }, 'ORGO_API_KEY'],
    ]) {
      const result = await runScript(`
        import assert from 'node:assert/strict';
        import { requireOrgoComputer } from './server/src/providers.ts';
        import { box } from './server/src/box.ts';
        import { ensureComputer } from './server/src/computer.ts';
        globalThis.fetch = () => { throw new Error('unexpected provider network request'); };
        const setting = process.env.EXPECTED_SETTING;
        const expected = { name: 'ProviderUnavailableError', provider: 'orgo', setting };
        assert.throws(() => requireOrgoComputer(), expected);
        assert.throws(() => ensureComputer('unused'), expected);
        await assert.rejects(box.bash('must never execute'), expected);
      `, { ...extraEnv, EXPECTED_SETTING: setting, DB_PATH: path.join(dir, 'app.sqlite') });
      assert.equal(result.code, 0, result.stderr);
    }
  });
});

test('secret files and direct keys are trimmed; configured status makes no health claim or network call', async () => {
  await withDirectory('uap-provider-secrets-', async dir => {
    const keyFile = path.join(dir, 'provider-key');
    await writeFile(keyFile, '\n  file-fixture-key \n', { mode: 0o600 });
    const result = await runScript(`
      import assert from 'node:assert/strict';
      globalThis.fetch = () => { throw new Error('configuration must not call providers'); };
      const { env } = await import('./server/src/env.ts');
      const { providerConfiguration, requireProvider } = await import('./server/src/providers.ts');
      assert.equal(env.xaiKey, 'file-fixture-key');
      assert.equal(env.orgoKey, 'direct-fixture-key');
      assert.equal(env.composioKey, 'file-fixture-key');
      for (const id of ['xai', 'orgo', 'composio']) {
        assert.equal(providerConfiguration()[id].status, 'configured_unverified');
        requireProvider(id);
      }
      assert.ok(!JSON.stringify(providerConfiguration()).includes('fixture-key'));
    `, {
      XAI_API_KEY_FILE: keyFile,
      ORGO_API_KEY: ' direct-fixture-key ', ORGO_API_KEY_FILE: path.join(dir, 'unused-missing-file'),
      COMPOSIO_API_KEY: '  ', COMPOSIO_API_KEY_FILE: keyFile,
    });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('an explicitly configured missing or empty secret file fails instead of silently disabling the provider', async () => {
  await withDirectory('uap-invalid-secret-', async dir => {
    const emptyFile = path.join(dir, 'empty');
    await writeFile(emptyFile, ' \n');
    for (const file of [emptyFile, path.join(dir, 'missing')]) {
      const result = await runScript("await import('./server/src/env.ts');", { XAI_API_KEY_FILE: file });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, file === emptyFile ? /Empty secret file for XAI_API_KEY/ : /ENOENT/);
    }
  });
});

test('voice options report provider failures honestly and cache only successful catalogs', async () => {
  await withDirectory('uap-voice-catalog-', async dir => {
    const result = await runScript(`
      import assert from 'node:assert/strict';
      import { voiceApi } from './server/src/voice.ts';
      let requests = 0;
      for (const outcome of [
        () => { throw new Error('private-network-detail fixture-key'); },
        () => new Response('private-upstream-response fixture-key', { status: 401 }),
        () => Response.json({ voices: [] }),
        () => Response.json({ voices: [{ voice_id: '' }] }),
        () => new Response('invalid-json', { status: 200 }),
      ]) {
        globalThis.fetch = async () => { requests++; return outcome(); };
        const response = await voiceApi.request('/options');
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.code, 'provider_options_unavailable');
        assert.equal(body.provider, 'xai');
        assert.equal(body.retryable, true);
        assert.equal(body.voices, undefined, 'failure must not fabricate voice choices');
        assert.ok(!JSON.stringify(body).includes('private-'));
        assert.ok(!JSON.stringify(body).includes('fixture-key'));
      }
      assert.equal(requests, 5, 'failed requests must not populate the successful catalog cache');
      globalThis.fetch = async (url) => {
        requests++;
        assert.equal(url, 'https://api.x.ai/v1/tts/voices');
        return Response.json({ voices: [{ voice_id: 'provider-voice-1', name: 'Provider voice', gender: 'female' }] });
      };
      const success = await voiceApi.request('/options');
      assert.equal(success.status, 200);
      const catalog = await success.json();
      assert.deepEqual(catalog.voices, [{ id: 'provider-voice-1', name: 'Provider voice', gender: 'female' }]);
      assert.ok(catalog.languages.length > 0);
      const cached = await voiceApi.request('/options');
      assert.equal(cached.status, 200);
      assert.deepEqual(await cached.json(), catalog);
      assert.equal(requests, 6, 'a successful catalog is cached');
      const currentTime = Date.now();
      Date.now = () => currentTime + 3600001;
      globalThis.fetch = async () => { requests++; throw new Error('private-network-detail'); };
      const expired = await voiceApi.request('/options');
      assert.equal(expired.status, 502);
      assert.equal((await expired.json()).voices, undefined, 'an expired catalog must not hide a provider failure');
      assert.equal(requests, 7);
    `, { XAI_API_KEY: 'unit-fixture-key', DB_PATH: path.join(dir, 'app.sqlite'), HERMES_HOME_PRIMARY: path.join(dir, 'hermes') });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('default database path preserves legacy data and uses a neutral filename for new installs', async () => {
  await withDirectory('uap-db-location-', async dir => {
    const result = await runScript(`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { defaultDatabasePath } from './server/src/env.ts';
      const dir = process.env.TEST_DATA_DIR;
      assert.equal(defaultDatabasePath(dir), path.join(dir, 'platform.db'));
      fs.writeFileSync(path.join(dir, 'grokbot.db'), 'existing user data');
      assert.equal(defaultDatabasePath(dir), path.join(dir, 'grokbot.db'));
      assert.equal(fs.readFileSync(defaultDatabasePath(dir), 'utf8'), 'existing user data');
      fs.writeFileSync(path.join(dir, 'platform.db'), 'new data');
      assert.throws(() => defaultDatabasePath(dir), /Set DB_PATH explicitly/);
      assert.equal(fs.readFileSync(path.join(dir, 'grokbot.db'), 'utf8'), 'existing user data');
    `, { TEST_DATA_DIR: dir });
    assert.equal(result.code, 0, result.stderr);
  });
});

test('real server boots without optional keys; authenticated disabled-provider requests return explicit HTTP 503', { timeout: 25000 }, async () => {
  await withDirectory('uap-boot-', async dir => {
    const dbPath = path.join(dir, 'app.sqlite');
    // Seed only a local user/session. Creating a bot here would start or modify a Hermes gateway.
    const seeded = await runScript(`
      import { db, now } from './server/src/db.ts';
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('usr_provider_test', 'test@example.invalid', 'Provider test', now());
      db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('provider-test-session', 'usr_provider_test', now(), now() + 60000);
      db.close();
    `, { DB_PATH: dbPath });
    assert.equal(seeded.code, 0, seeded.stderr);
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
      cwd: root, env: {
        ...cleanEnv(), PORT: '0', UAP_NO_SCHEDULER: '1', DB_PATH: dbPath,
        ENGINES_DIR: path.join(dir, 'engines'), HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`startup timed out: ${stderr}`)), 15000);
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk;
          const match = output.match(/server on (http:\/\/localhost:\d+)/);
          if (match) {
            clearTimeout(timer);
            if (!output.includes('scheduler disabled')) reject(new Error('UAP_NO_SCHEDULER must disable background work'));
            else resolve(match[1]);
          }
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}: ${stderr}`)); });
      });
      const response = await fetch(`${url}/api/health`);
      assert.equal(response.status, 200);
      const health = await response.json();
      assert.equal(health.ok, true);
      for (const id of ['orgo', 'xai', 'composio']) assert.deepEqual(health.providers[id], { status: 'unconfigured' });
      assert.equal((await fetch(`${url}/api/voice/options`)).status, 401);
      const options = await fetch(`${url}/api/voice/options`, { headers: { cookie: 'grokbot_session=provider-test-session' } });
      assert.equal(options.status, 200);
      const optionsBody = await options.json();
      assert.equal(optionsBody.provider, 'local');
      assert.equal(optionsBody.paidFallback, false);
      const apps = await fetch(`${url}/api/apps`, { headers: { cookie: 'grokbot_session=provider-test-session' } });
      assert.equal(apps.status, 200);
      assert.equal((await apps.json()).provider, 'local');
      for (const [route, provider, method] of [
        ['/api/voice/preview', 'xai', 'POST'], ['/api/voice/stt', 'xai', 'POST'],
        ['/api/computer/ensure', 'orgo', 'POST'],
        ['/api/apps/gmail/connect', 'composio', 'POST'],
      ]) {
        const result = await fetch(`${url}${route}`, {
          method, headers: { cookie: 'grokbot_session=provider-test-session' },
        });
        assert.equal(result.status, 503, route);
        const error = await result.json();
        assert.equal(error.code, 'provider_unavailable', route);
        assert.equal(error.provider, provider, route);
        assert.match(error.error, /not configured/);
        if (provider === 'orgo') {
          assert.equal(error.setting, 'ORGO_COMPUTER_ID');
          assert.ok(!error.error.includes('ORGO_API_KEY'), 'missing computer ID must not be mislabeled as a missing API key');
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    }
  });
});
