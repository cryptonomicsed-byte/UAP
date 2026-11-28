import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';


const read = (file) => readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8');

test('the Living Workspace has one roster and a reversible classic layout', () => {
  const shell = read('App.tsx');
  assert.match(shell, /readPreference\('uap\.studio'\)/);
  assert.match(shell, /'app--studio'/);
  assert.equal([...shell.matchAll(/<Sidebar\b/g)].length, 1);
  const roster = read('components/Sidebar.tsx');
  assert.match(roster, /Living Workspace/);
  assert.match(roster, /Filter agents/);
  assert.match(roster, /Use classic layout/);
  assert.match(roster, /Use Living Workspace/);
});

test('workspace facets and mobile navigation retain the existing action components', () => {
  const chat = read('components/ChatView.tsx');
  assert.match(chat, /aria-label="Agent workspace"/);
  assert.match(chat, /<BotTasks bot=\{bot\}/);
  assert.match(chat, /<Transcript /);
  assert.match(chat, /<VoiceCallBar /);
  assert.match(chat, /<Composer key=\{bot\.id\}/);
  assert.match(read('main.tsx'), /styles\/studio\.css/);
});

test('the studio stage connects the selected agent to original art, files, activity and routines', () => {
  const chat = read('components/ChatView.tsx');
  assert.match(chat, /<AgentActivity bot=\{bot\} rows=\{rows\}/);
  assert.match(chat, /<AgentAutomations bot=\{bot\}/);
  assert.match(chat, /<LibraryTab key=\{bot\.id\} bot=\{bot\}/);
  assert.match(read('components/Transcript.tsx'), /<AgentPortrait id=\{bot\.id\}/);
  assert.match(read('components/Sidebar.tsx'), /<AgentPortrait id=\{bot\.id\}/);
});
