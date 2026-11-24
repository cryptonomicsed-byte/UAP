import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { providerConfiguration, ProviderUnavailableError } from './providers.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { v6Api } from './routes-v6.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi } from './mcp.js';
import { initEngines } from './engine.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof ProviderUnavailableError) {
    return c.json({ error: error.message, code: 'provider_unavailable', provider: error.provider, setting: error.setting }, 503);
  }
  console.error('[server] request failed', error);
  return c.json({ error: 'Internal server error' }, 500);
});
app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes', providers: providerConfiguration() }));
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api/v6', v6Api);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[uap] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
// Disable background schedulers for extra dev/test servers sharing a database copy.
// Keep the upstream alias compatible with existing self-hosted installations.
if (process.env.UAP_NO_SCHEDULER !== '1' && process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
  initProactive(enqueue);
} else console.log('[uap] scheduler disabled (UAP_NO_SCHEDULER or legacy alias)');
startIdleWatcher();
initEngines();
