import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  routeLanguageSkills,
  pinLanguageVersion,
  rollbackLanguageVersion,
  emptyProjectLanguageState,
  assertNoContradictorySkills,
  FAMILY_LANGUAGE_ALLOWLIST,
  selectionDigest,
} from '../server/src/lib/language-routing.ts';
import { LANGUAGE_GATE_PACKS } from '../server/src/lib/language-gates.ts';

test('K-37 design role never loads language packs by default', () => {
  const r = routeLanguageSkills({
    roleId: 'brand-director',
    roleFamily: 'design',
    requestedLanguages: ['rust', 'python'],
  });
  assert.equal(r.allowed.length, 0);
  assert.equal(r.denied.length, 2);
  assert.equal(r.isolationOk, true);
  assert.equal(FAMILY_LANGUAGE_ALLOWLIST.design.length, 0);
});

test('K-37 engineering can load requested languages only (not whole allowlist)', () => {
  const r = routeLanguageSkills({
    roleId: 'rust-engineer',
    roleFamily: 'engineering',
    requestedLanguages: ['rust'],
  });
  assert.equal(r.allowed.length, 1);
  assert.equal(r.allowed[0].language, 'rust');
  assert.equal(r.allowed[0].version, LANGUAGE_GATE_PACKS.rust.version);
  assert.equal(r.denied.length, 0);
});

test('K-37 research cannot load move/solidity-style packs', () => {
  const r = routeLanguageSkills({
    roleId: 'evidence-investigator',
    roleFamily: 'research',
    requestedLanguages: ['move', 'python'],
  });
  assert.ok(r.denied.some((d) => d.language === 'move'));
  assert.ok(r.allowed.some((a) => a.language === 'python'));
});

test('K-37 project pin version selection + rollback', () => {
  let state = emptyProjectLanguageState('proj-1');
  // Only 1.0.0 exists today — pin it, then simulate history by pinning again after fake history
  state = pinLanguageVersion(state, 'go', '1.0.0', 'alice');
  assert.equal(state.pins[0].version, '1.0.0');
  // Manually inject prior pin into history for rollback demo
  state = {
    ...state,
    history: [{ language: 'go', version: '1.0.0', pinnedAt: '2020-01-01T00:00:00.000Z', pinnedBy: 'bob' }],
    pins: [{ language: 'go', version: '1.0.0', pinnedAt: '2026-01-01T00:00:00.000Z', pinnedBy: 'alice' }],
  };
  // pin again pushes current to history
  state = pinLanguageVersion(state, 'go', '1.0.0', 'carol');
  assert.ok(state.history.length >= 2);
  const beforeRollback = state.pins.find((p) => p.language === 'go');
  assert.equal(beforeRollback?.pinnedBy, 'carol');
  state = rollbackLanguageVersion(state, 'go');
  const after = state.pins.find((p) => p.language === 'go');
  assert.ok(after);
  assert.notEqual(after?.pinnedBy, 'carol');

  const routed = routeLanguageSkills({
    roleId: 'eng',
    roleFamily: 'engineering',
    requestedLanguages: ['go'],
    projectState: state,
  });
  assert.equal(routed.allowed[0].source, 'project_pin');
});

test('K-37 unknown pin version denied', () => {
  assert.throws(
    () => pinLanguageVersion(emptyProjectLanguageState('p'), 'rust', '99.0.0', 'x'),
    (e) => e.code === 'language_pin_unknown',
  );
});

test('K-37 assertNoContradictorySkills throws for design+rust request path when forced allowed empty check', () => {
  // design requests rust → denied only, isolationOk true, allowed empty — should NOT throw isolation
  assert.doesNotThrow(() =>
    assertNoContradictorySkills({
      roleId: 'design',
      roleFamily: 'design',
      requestedLanguages: ['rust'],
    }),
  );
});

test('K-37 selectionDigest stable', () => {
  const r = routeLanguageSkills({
    roleId: 'e',
    roleFamily: 'engineering',
    requestedLanguages: ['python', 'rust'],
  });
  const d1 = selectionDigest(r.allowed);
  const d2 = selectionDigest([...r.allowed].reverse());
  assert.equal(d1, d2);
  assert.equal(d1.length, 64);
});
