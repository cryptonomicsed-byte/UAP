// The per-role skill context is only real if the turn's instructions actually
// carry it: the prompt builder must go through the budgeted builder instead of
// pasting every skill body. Written before prompt.ts was wired; watched failing
// because the full 2,000-char skill bodies were inlined.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-skill-context-prompt-'));
process.env.DB_PATH = path.join(dir, 'app.sqlite');
process.env.SESSION_SECRET = 'skill-context-prompt-secret';
process.env.UAP_NO_SCHEDULER = '1';
process.env.GROKBOT_NO_SCHEDULER = '1';
delete process.env.SKILL_CONTEXT_BUDGET_TOKENS;

const { db } = await import('../server/src/db.ts');
const { instructionsFor } = await import('../server/src/agent/prompt.ts');
const { DEFAULT_SKILL_BUDGET_TOKENS } = await import('../server/src/agent/skill-context.ts');

const USER = 'user_skill_budget';
const BOT = 'bot_skill_budget';
const now = Date.now();

db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(USER, 'budget@example.test', 'Budget Owner', now);
db.prepare('INSERT INTO bots(id,user_id,name,label,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run(BOT, USER, 'Forge', 'Backend Engineer', 'Builds services', now, now);

const bodies = ['alpha', 'beta', 'gamma'].map((name, i) => ({
  id: `skill_${name}`,
  name: `skill-${name}`,
  body: `skill ${name} line 1: introductory sentence\n` + Array.from({ length: 14 }, (_, j) => `${name} detail ${j} ` + 'z'.repeat(120)).join('\n'),
}));
for (const s of bodies) {
  db.prepare('INSERT INTO skills(id,bot_id,name,body,created_at) VALUES(?,?,?,?,?)').run(s.id, BOT, s.name, s.body, now + bodies.indexOf(s));
}

const skillSection = (text) => {
  const marker = '## Skills Budget Owner gave you\n';
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start + marker.length);
  const end = rest.indexOf('\n## ');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
};

test('the turn prompt carries a budgeted skill section, not every body', async () => {
  const first = await instructionsFor(USER, BOT);
  const second = await instructionsFor(USER, BOT);
  assert.equal(first, second, 'the cached prompt prefix must be byte-identical between turns');

  const section = skillSection(first);
  assert.ok(section.length > 0, 'skills are still announced');
  assert.ok(Math.ceil(section.length / 4) <= DEFAULT_SKILL_BUDGET_TOKENS, 'skill section over budget');

  for (const s of bodies) {
    assert.ok(!first.includes(s.body.split('\n')[1]), `${s.name} body leaked past the budget`);
    assert.ok(section.includes(s.body.split('\n')[0].slice(0, 60)), `${s.name} first line should survive as a summary`);
  }
});

test('a smaller budget degrades to names and is honoured exactly', async () => {
  process.env.SKILL_CONTEXT_BUDGET_TOKENS = '40';
  try {
    const text = await instructionsFor(USER, BOT);
    const section = skillSection(text);
    assert.ok(section.length > 0);
    assert.ok(Math.ceil(section.length / 4) <= 40, `section over 40 tokens: ${Math.ceil(section.length / 4)}`);
    for (const s of bodies) {
      assert.ok(section.includes(s.name), `${s.name} should still be listed by name`);
      assert.ok(!section.includes('introductory sentence'), 'bodies must be gone at 80 tokens');
    }
  } finally {
    delete process.env.SKILL_CONTEXT_BUDGET_TOKENS;
  }
});
