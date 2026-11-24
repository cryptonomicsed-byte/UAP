import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  evaluateDesignGates,
  parseDesignFrontmatter,
  assertDesignGatesPass,
  findDesignMd,
} from '../server/src/design/gates.ts';

test('parseDesignFrontmatter extracts name and nested colors.primary', () => {
  const fm = parseDesignFrontmatter(`---
name: Agent Console
colors:
  primary: "#176C78"
  ink: "#1C1C1C"
---

## Overview
body
`);
  assert.equal(fm.ok, true);
  assert.equal(fm.fields.name, 'Agent Console');
  assert.equal(fm.fields['colors.primary'], '#176C78');
});

test('J-33 evaluateDesignGates NO-GO without DESIGN.md or personas', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-design-gate-'));
  try {
    const r = evaluateDesignGates(dir);
    assert.equal(r.nogo, true);
    assert.ok(r.findings.some((f) => f.code === 'design_md_missing'));
    assert.ok(r.findings.some((f) => f.code === 'design_persona_missing'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('J-33 UAP tree passes design gates (DESIGN.md + design personas present)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const md = findDesignMd(root);
  assert.ok(md, 'expected DESIGN.md in UAP tree');
  const r = evaluateDesignGates(root);
  assert.equal(r.nogo, false, JSON.stringify(r.findings, null, 2));
  assert.equal(r.ok, true);
  assert.equal(r.personas.realityChecker, true);
  assert.equal(r.personas.brandDirector || r.personas.creativeDirector, true);
  assert.ok(r.designName);
  assert.doesNotThrow(() => assertDesignGatesPass(root));
});

test('J-33 assertDesignGatesPass throws design_nogo on empty project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-design-nogo-'));
  try {
    assert.throws(() => assertDesignGatesPass(dir), (e) => e.code === 'design_nogo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('J-33 incomplete DESIGN.md (no primary) is blocker when colors object present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-design-primary-'));
  try {
    await mkdir(path.join(dir, 'docs', 'roles'), { recursive: true });
    await writeFile(path.join(dir, 'docs', 'roles', 'reality-checker.md'), '# Reality\n');
    await writeFile(path.join(dir, 'docs', 'roles', 'brand-director.md'), '# Brand\n');
    await writeFile(path.join(dir, 'docs', 'DESIGN.md'), `---
name: Incomplete
colors:
  ink: "#111"
---
`);
    const r = evaluateDesignGates(dir);
    assert.equal(r.nogo, true);
    assert.ok(r.findings.some((f) => f.code === 'design_md_missing_primary'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
