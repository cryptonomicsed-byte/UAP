import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('agent can set autonomy, remember, and read the workspace', () => {
  const tools = readFileSync(new URL('../server/src/agent/tools.ts', import.meta.url), 'utf8');
  for (const name of ['set_autonomy', 'remember', 'list_workspace']) assert.match(tools, new RegExp(`name: '${name}'`));
});

test('desktop supervisor probes the RFB banner, not just the port', () => {
  const script = readFileSync(new URL('../scripts/uap-local-desktop.sh', import.meta.url), 'utf8');
  assert.match(script, /RFB /);
  assert.match(script, /banner_ok/);
  assert.doesNotMatch(script, /echo >\/dev\/tcp/);
});
