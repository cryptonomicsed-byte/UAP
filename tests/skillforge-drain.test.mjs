import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function withDb(script) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-skillforge-'));
  const env = {
    ...process.env,
    SESSION_SECRET: 'skillforge-test-only',
    DB_PATH: path.join(dir, 'app.sqlite'),
    HERMES_HOME_PRIMARY: path.join(dir, 'primary'),
    ENGINES_DIR: path.join(dir, 'managed'),
    HQ_LOCAL: '0',
  };
  const code = `
    import assert from 'node:assert/strict';
    import { db } from './server/src/db.ts';
    import { SkillForgeRegistry } from './server/src/skillforge/registry.ts';
    import { SkillForgeDrain } from './server/src/skillforge/drain.ts';
    await SkillForgeRegistry.init();
    await SkillForgeDrain.init();
    ${script}
  `;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const exit = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(exit, 0, output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('I-32 invoke refuses missing pack and missing tool; accepts signed pack tool', { timeout: 25000 }, async () => {
  await withDb(`
    let r = await SkillForgeDrain.invoke({ packId: 'missing', toolName: 'echo', args: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'pack_missing');

    const pack = {
      id: 'skillforge_uap_echo',
      version: '1.0.0',
      name: 'echo',
      publisher: 'uap',
      license: 'MIT',
      sourceSha: 'a'.repeat(64),
      sourceUrl: 'https://example.test/echo',
      tools: [{ name: 'echo', version: '1', description: 'echo', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffects: [], requiredGrants: [], timeoutMs: 1000 }],
      dependencies: [],
      grants: [],
      compatibleRoles: ['rt_uap_backend'],
      minHermesVersion: '1.0.0',
      signedAt: new Date().toISOString(),
      signedBy: 'test-key',
      signature: 'test-signature-bytes',
    };
    await SkillForgeRegistry.publishPack(pack, { skillPack: pack, grants: [] });

    r = await SkillForgeDrain.invoke({ packId: pack.id, toolName: 'nope', args: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'tool_missing');

    r = await SkillForgeDrain.invoke({ packId: pack.id, toolName: 'echo', args: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'args_required');

    r = await SkillForgeDrain.invoke({ packId: pack.id, toolName: 'echo', args: { msg: 'hi' }, roleId: 'rt_uap_backend' });
    assert.equal(r.ok, true);
    assert.equal(r.packVersion, '1.0.0');
    assert.equal(r.output.argsAccepted, true);
  `);
});

test('I-32 drain refuses same version; migrate path completes', { timeout: 25000 }, async () => {
  await withDb(`
    const base = {
      id: 'skillforge_uap_echo',
      name: 'echo', publisher: 'uap', license: 'MIT',
      sourceSha: 'b'.repeat(64), sourceUrl: 'https://example.test/echo',
      tools: [{ name: 'echo', version: '1', description: 'echo', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffects: [], requiredGrants: [], timeoutMs: 1000 }],
      dependencies: [], grants: [], compatibleRoles: [],
      minHermesVersion: '1.0.0', signedAt: new Date().toISOString(), signedBy: 'k', signature: 'sig',
    };
    await SkillForgeRegistry.publishPack({ ...base, version: '1.0.0' }, {});
    await SkillForgeRegistry.publishPack({ ...base, version: '1.1.0', sourceSha: 'c'.repeat(64) }, {});

    await assert.rejects(
      () => SkillForgeDrain.planDrain({ packId: base.id, fromVersion: '1.0.0', toVersion: '1.0.0', strategy: 'migrate' }),
      (e) => e.code === 'drain_same_version',
    );

    const plan = await SkillForgeDrain.planDrain({
      packId: base.id, fromVersion: '1.0.0', toVersion: '1.1.0', strategy: 'migrate', deadlineHours: 1,
    });
    assert.equal(plan.status, 'pending');
    assert.equal(plan.fromVersion, '1.0.0');
    assert.equal(plan.toVersion, '1.1.0');

    const done = await SkillForgeDrain.executeDrain(plan.id);
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt);

    const listed = SkillForgeDrain.listDrains(base.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'completed');
  `);
});
