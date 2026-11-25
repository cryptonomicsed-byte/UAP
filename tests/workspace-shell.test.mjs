import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the desk is on the agent, not a second navigation app', () => {
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  const desk = readFileSync(new URL('../web/src/components/AgentDesk.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../web/src/components/DetailsPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /SurfaceBar/);
  assert.doesNotMatch(app, /WorkspaceRail/);
  assert.match(panel, /AgentDesk/);
  assert.match(desk, /Autonomy/);
  assert.match(desk, /Install/);
  assert.match(desk, /No model is set/);
  const chat = readFileSync(new URL('../web/src/components/ChatView.tsx', import.meta.url), 'utf8');
  const header = chat.indexOf('chat__header');
  const transcript = chat.indexOf('<Transcript');
  assert.ok(header > 0 && header < transcript);
  const tokens = readFileSync(new URL('../web/src/styles/tokens.css', import.meta.url), 'utf8');
  assert.doesNotMatch(tokens, /Inter/);
});
