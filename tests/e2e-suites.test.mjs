import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  runE2E55_SidLifecycle,
  runE2E56_PersonaSkills,
  runE2E57_DesignQuality,
  runE2E58_Languages,
  runE2E59_Domain,
  runE2E60_FactorySaas,
  runAllE2E,
  allE2EPass,
} from '../server/src/lib/e2e-suites.ts';

const root = path.resolve(import.meta.dirname, '..');

test('E2E-55 SID/lifecycle suite passes', () => {
  const s = runE2E55_SidLifecycle();
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
  assert.ok(s.checks.length >= 8);
});

test('E2E-56 persona/skills suite passes', () => {
  const s = runE2E56_PersonaSkills(root);
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test('E2E-57 design quality suite passes', () => {
  const s = runE2E57_DesignQuality(root);
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test('E2E-58 languages/contracts suite passes', () => {
  const s = runE2E58_Languages();
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test('E2E-59 domain outputs suite passes', () => {
  const s = runE2E59_Domain();
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test('E2E-60 factory/SaaS suite passes', () => {
  const s = runE2E60_FactorySaas();
  assert.equal(s.pass, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test('all E2E suites green together', () => {
  const all = runAllE2E(root);
  assert.equal(all.length, 6);
  assert.equal(allE2EPass(root), true);
  assert.ok(all.every((s) => s.pass));
});
