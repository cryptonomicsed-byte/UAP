import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** A secret from NAME, or from the file named by NAME_FILE (so keys need not sit in .env). */
function secret(name: string, required = true): string {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  if (file) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value) throw new Error(`Empty secret file for ${name}`);
    return value;
  }
  if (required) throw new Error(`Missing env ${name} (or ${name}_FILE)`);
  return '';
}

export function defaultDatabasePath(dataDir = new URL('../../data/', import.meta.url).pathname): string {
  // Preserve existing local data when upgrading from the upstream package name.
  const legacy = path.join(dataDir, 'grokbot.db');
  const current = path.join(dataDir, 'platform.db');
  if (fs.existsSync(legacy) && fs.existsSync(current)) throw new Error('Both platform.db and grokbot.db exist. Set DB_PATH explicitly to select the intended database.');
  return fs.existsSync(legacy) ? legacy : current;
}

const hermesHome = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  xaiKey: secret('XAI_API_KEY', false),
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  composioKey: secret('COMPOSIO_API_KEY', false),
  orgoKey: secret('ORGO_API_KEY', false),
  /** Real SMTP mailbox for the agents' own email (mail.spacemail.com, SSL). Password only,
   *  via SPACEMAIL_SMTP_PASS or SPACEMAIL_SMTP_PASS_FILE -- never required at boot, since not
   *  every deployment has this mailbox; sendEmail() checks isEmailConfigured() first. */
  spacemailUser: process.env.SPACEMAIL_SMTP_USER ?? 'uap@omokoda.space',
  spacemailPass: secret('SPACEMAIL_SMTP_PASS', false),
  sessionSecret: req('SESSION_SECRET'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? defaultDatabasePath(),

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Explicit operator grant to copy primary model config/auth/keys into managed homes. */
  inheritPrimaryCredentials: process.env.HERMES_INHERIT_PRIMARY_CREDENTIALS === '1',
  /** Where each extra bot's own Hermes home lives. Must be outside the primary home; separate homes still share the host OS identity. */
  enginesDir: process.env.ENGINES_DIR ?? new URL('../../data/engines', import.meta.url).pathname,
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Doug',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  // ---- the one shared computer ----
  /** The Orgo computer every bot works on (one screen each). Empty = legacy one-box-per-user mode is not supported. */
  orgoComputerId: process.env.ORGO_COMPUTER_ID ?? '',
  /** This server runs on that computer, so shell commands run locally instead of through Orgo's API. */
  localBox: process.env.HQ_LOCAL === '1',
  /**
   * DevTools URL of a Chrome that already runs on the default screen and belongs to the primary bot
   * (e.g. http://127.0.0.1:9333). When set, we never start or stop that screen's Chrome ourselves.
   */
  primaryCdpUrl: process.env.PRIMARY_CDP_URL ?? '',
  /** Bots that can each have a screen (Orgo allows four screens on one Linux computer). */
  maxBots: Number(process.env.MAX_BOTS ?? 4),
  /** Comma-separated emails allowed to sign in; empty = anyone who can reach the app. */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};
