// Progressive per-role skill context with a hard token budget (V6-07-03).
//
// The prompt builder used to inline every skill body in full, so a bot with a
// handful of long skills silently outgrew its context and the cached prefix
// changed size on every edit. This module builds the skill section on a depth
// ladder — full bodies, then summaries, then names, then nothing — inside a
// budget the caller states, and reports exactly what it shed and why.
//
// Written before server/src/agent/skill-context.ts existed; every test here was
// watched failing with `Cannot find module .../skill-context.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SKILL_BUDGET_TOKENS,
  SKILL_CONTEXT_FLOOR_TOKENS,
  buildSkillContext,
} from '../server/src/agent/skill-context.ts';

const role = (over = {}) => ({
  id: 'role_backend_engineer',
  version: 3,
  digest: 'd'.repeat(64),
  title: 'Backend Engineer',
  instructions: 'You design, build and review backend services.',
  ...over,
});

const skill = (n, lines = 1) => ({
  id: `skill_${n}`,
  name: `skill-${n}`,
  body: Array.from({ length: lines }, (_, i) => `skill ${n} line ${i + 1}: ` + 'x'.repeat(120)).join('\n'),
});

const est = (text) => Math.ceil(text.length / 4);

test('a generous budget includes every skill body in full, role first', () => {
  const skills = [skill('a'), skill('b')];
  const env = buildSkillContext({ role: role(), skills, budgetTokens: 2000 });

  assert.equal(env.data.mode, 'full');
  assert.equal(env.floor, false);
  assert.equal(env.dropped, 0);
  assert.deepEqual(env.data.omitted, []);
  assert.equal(env.data.included.length, 2);
  assert.deepEqual(env.data.included.map((i) => i.level), ['full', 'full']);
  assert.ok(env.data.text.startsWith(role().instructions));
  assert.match(env.data.text, /### skill-a\nskill a line 1/);
  assert.match(env.data.text, /### skill-b\n/);
  assert.match(env.etag, /^[0-9a-f]{64}$/);
  assert.equal(env.estTokens, est(env.data.text));
  assert.ok(env.estTokens <= 2000);
});

test('the same inputs produce byte-identical text and etag', () => {
  const input = { role: role(), skills: [skill('a'), skill('b')], budgetTokens: 800 };
  const one = buildSkillContext(input);
  const two = buildSkillContext({ ...input, skills: [skill('a'), skill('b')] });
  assert.equal(one.data.text, two.data.text);
  assert.equal(one.etag, two.etag);
  // A different budget that does not change the selection must not change the
  // etag — otherwise the cached prompt is invalidated for free.
  const roomy = buildSkillContext({ ...input, budgetTokens: 1400 });
  assert.equal(roomy.etag, one.etag);
  // ...while a different selection must.
  const extra = buildSkillContext({ ...input, skills: [skill('a'), skill('b'), skill('c')], budgetTokens: 1400 });
  assert.notEqual(extra.etag, one.etag);
});

test('under pressure it degrades to summaries, then names, never over budget', () => {
  const skills = Array.from({ length: 8 }, (_, i) => skill(i, 6));
  const seen = new Set();
  for (let budget = SKILL_CONTEXT_FLOOR_TOKENS; budget <= 4000; budget += 7) {
    const env = buildSkillContext({ role: role(), skills, budgetTokens: budget });
    seen.add(env.data.mode);
    assert.ok(env.estTokens <= budget, `budget ${budget} exceeded: ${env.estTokens}`);
    assert.ok(env.data.text.length <= budget * 4, `chars ${env.data.text.length} over ${budget * 4}`);
    assert.equal(env.floor, false);
    assert.equal(env.dropped, env.data.omitted.length);
    assert.equal(env.data.included.length + env.data.omitted.length, skills.length);
  }
  assert.deepEqual([...seen].sort(), ['full', 'names', 'summary']);
});

test('a summary is the first line only, and everything is reported as truncated', () => {
  const skills = [skill('a', 4), skill('b', 4)];
  const full = buildSkillContext({ role: role(), skills, budgetTokens: 4000 });
  const env = buildSkillContext({ role: role(), skills, budgetTokens: 120 });

  assert.equal(env.data.mode, 'summary');
  for (const s of skills) {
    assert.ok(!env.data.text.includes(s.body.split('\n')[1]), 'later lines must not leak into summaries');
    assert.ok(env.data.text.includes(s.body.split('\n')[0].slice(0, 80)));
    assert.ok(env.truncated.includes(s.name));
  }
  assert.ok(env.estTokens < full.estTokens);
  assert.deepEqual(env.data.omitted, []);
});

test('names-only still lists every skill and says why bodies were dropped', () => {
  const skills = [skill('a', 4), skill('b', 4), skill('c', 4)];
  const env = buildSkillContext({ role: role(), skills, budgetTokens: SKILL_CONTEXT_FLOOR_TOKENS + 6 });

  assert.equal(env.data.mode, 'names');
  for (const s of skills) assert.ok(env.data.text.includes(`- ${s.name}`));
  assert.equal(env.data.omitted.length, 0);
  assert.equal(env.truncated.length, skills.length);
});

test('a budget too small to honour returns a pointer, not a lie', () => {
  const skills = [skill('a'), skill('b')];
  const env = buildSkillContext({ role: role(), skills, budgetTokens: SKILL_CONTEXT_FLOOR_TOKENS - 1 });

  assert.equal(env.floor, true);
  assert.equal(env.data.text, '');
  assert.equal(env.estTokens, 0);
  assert.equal(env.dropped, skills.length);
  assert.deepEqual(env.data.omitted.map((o) => o.name), skills.map((s) => s.name));
  assert.ok(env.data.omitted.every((o) => o.reason === 'budget_floor'));
  assert.match(env.etag, /^[0-9a-f]{64}$/);
});

test('a role that alone exceeds the budget is reported, not smuggled in', () => {
  const bigRole = role({ instructions: 'r'.repeat(4000) });
  const env = buildSkillContext({ role: bigRole, skills: [skill('a')], budgetTokens: 200 });

  assert.equal(env.floor, true);
  assert.ok(env.data.roleTokens > 200);
  assert.ok(!env.data.text.includes('r'.repeat(100)), 'no partial role instruction text');
  assert.ok(env.data.omitted.every((o) => o.reason === 'role_over_budget'));
});

test('no skills is a valid, stable state', () => {
  const env = buildSkillContext({ role: role(), skills: [], budgetTokens: 500 });
  assert.equal(env.data.mode, 'none');
  assert.equal(env.data.text, role().instructions);
  assert.deepEqual(env.data.included, []);
  assert.deepEqual(env.data.omitted, []);
  assert.equal(env.truncated.length, 0);
  assert.equal(env.dropped, 0);
  assert.equal(buildSkillContext({ role: role(), skills: [], budgetTokens: 500 }).etag, env.etag);
});

test('an invalid budget or summary length is refused, not clamped', () => {
  assert.throws(() => buildSkillContext({ role: role(), skills: [skill('a')], budgetTokens: 0 }), RangeError);
  assert.throws(() => buildSkillContext({ role: role(), skills: [skill('a')], budgetTokens: 12.5 }), RangeError);
  assert.throws(() => buildSkillContext({ role: role(), skills: [skill('a')], budgetTokens: 100, summaryChars: 0 }), RangeError);
});

test('the default budget is the documented constant', () => {
  assert.ok(Number.isInteger(DEFAULT_SKILL_BUDGET_TOKENS) && DEFAULT_SKILL_BUDGET_TOKENS >= 500);
  const env = buildSkillContext({ role: role(), skills: [skill('a')] });
  assert.equal(env.data.budgetTokens, DEFAULT_SKILL_BUDGET_TOKENS);
});
