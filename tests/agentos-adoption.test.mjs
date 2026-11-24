import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { adoptionReport, loadAdoptionMatrix, runAgentOsSlice } from '../server/src/lib/agentos-adoption.ts';

const matrix = new URL('../docs/agentos/AgentOS_repository_adoption_matrix.csv', import.meta.url);

test('adoption matrix loads every row and installs none', () => {
  const rows = loadAdoptionMatrix(matrix);
  assert.ok(rows.length >= 100, `expected the full matrix, got ${rows.length}`);
  const report = adoptionReport(rows);
  assert.equal(report.installable, 0);
  assert.equal(report.executed, 0);
  assert.ok(report.decisions.every((d) => d.installable === false && d.executeContent === false));
  assert.ok(report.p0.includes('milind-soni/OpenMausBot'));
  assert.ok(report.p0.includes('NousResearch/hermes-agent'));
  assert.ok(report.p0.includes('cryptonomicsed-byte/sid'));
  const payloads = report.decisions.find((d) => d.repository.includes('PayloadsAllTheThings'));
  assert.equal(payloads?.executeContent, false);
});

test('agentos vertical slice enforces lease, keeps SID, blocks shell bypass', () => {
  const built = spawnSync('cargo', ['build', '--quiet', '--offline'], {
    cwd: new URL('../lang-packs/rust/lease-gate', import.meta.url),
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(built.status, 0, built.stderr);
  const bin = new URL('../lang-packs/rust/lease-gate/target/debug/lease-gate', import.meta.url);
  const slice = runAgentOsSlice({ rustBin: bin.pathname, elixir: true });
  assert.match(slice.sid, /^sid_/);
  assert.equal(slice.sidAfterTeardown, 'ACTIVE');
  assert.equal(slice.taskStatus, 'UNCERTAIN');
  assert.equal(slice.uncertainBlocksSuccess, true);
  assert.equal(slice.toolWithLease.allowed, true);
  assert.equal(slice.toolWithoutLease.allowed, false);
  assert.equal(slice.shellBypass.ok, false);
  assert.equal(slice.elixir, 'spawned');
});
