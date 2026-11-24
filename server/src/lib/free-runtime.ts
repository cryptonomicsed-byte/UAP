/**
 * Free runtime selection — blueprint MAUS-R-03 / MAUS-E2E-077.
 * Paid Orgo, xAI voice, and Composio are optional upgrades.
 * Free path never silently falls through to a paid provider.
 */
export type PaidProvider = 'orgo' | 'xai' | 'composio';
export type FreeBackend = 'local' | 'unavailable';

export interface RuntimeChoice {
  computer: 'local' | 'orgo' | 'unavailable';
  voice: 'local' | 'xai';
  connectors: 'local' | 'composio';
  paidFallback: false;
}

export function selectRuntime(input: {
  localBox: boolean;
  orgoConfigured: boolean;
  xaiConfigured: boolean;
  composioConfigured: boolean;
}): RuntimeChoice {
  return {
    computer: input.localBox ? 'local' : input.orgoConfigured ? 'orgo' : 'unavailable',
    // Local browser speech is always the free voice. xAI is an explicit upgrade, never a silent swap.
    voice: input.xaiConfigured ? 'xai' : 'local',
    connectors: input.composioConfigured ? 'composio' : 'local',
    paidFallback: false,
  };
}

export const LOCAL_VOICES = [
  { id: 'local-default', name: 'Device voice', gender: 'neutral' },
  { id: 'local-calm', name: 'Device voice (slower)', gender: 'neutral' },
] as const;

export const LOCAL_CONNECTORS = [
  { slug: 'local-files', name: 'Local files', description: 'Read and write the agent workspace on this host.', categories: ['developer tools'], connected: true, local: true },
  { slug: 'local-shell', name: 'Local shell', description: 'Run commands on the HQ_LOCAL box. No cloud computer.', categories: ['developer tools'], connected: true, local: true },
  { slug: 'local-mcp', name: 'Built-in MCP tools', description: 'Tasks, routines, messages, and approvals served by this server.', categories: ['productivity'], connected: true, local: true },
  { slug: 'browser-speech', name: 'Device voice', description: 'Speech recognition and synthesis in the browser. No xAI key.', categories: ['communication'], connected: true, local: true },
] as const;

/** Paid providers stay optional. Free selection must not require their keys. */
export function assertNoPaidFallback(choice: RuntimeChoice, requested: 'computer' | 'voice' | 'connectors'): void {
  if (choice.paidFallback) throw new Error('silent paid fallback is forbidden');
  if (requested === 'computer' && choice.computer === 'unavailable') {
    throw new Error('computer unavailable: set HQ_LOCAL=1 or configure Orgo explicitly');
  }
}
