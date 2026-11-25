import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('create_skill / list_skills tools exist, are classified, and are gated as risky', () => {
  const tools = readFileSync(new URL('../server/src/agent/tools.ts', import.meta.url), 'utf8');
  assert.match(tools, /name: 'create_skill'/);
  assert.match(tools, /name: 'list_skills'/);
  // The real INSERT must match the skills table's actual columns used by the Settings UI route,
  // so a skill added by talking to the agent shows up identically to one added via the form.
  assert.match(tools, /INSERT INTO skills\(id,bot_id,name,body,description,created_at,updated_at\)/);
  assert.match(tools, /hub\.emit\(ctx\.userId, \{ type: 'skills'/);

  const intents = readFileSync(new URL('../server/src/policy/tool-intents.ts', import.meta.url), 'utf8');
  assert.match(intents, /create_skill: \{ effect: 'write'/);

  const autonomy = readFileSync(new URL('../server/src/lib/autonomy.ts', import.meta.url), 'utf8');
  assert.match(autonomy, /'create_skill',/);

  const docs = readFileSync(new URL('../server/src/lib/tool-docs.ts', import.meta.url), 'utf8');
  assert.match(docs, /'create_skill',/);
});
