import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { displayFor } from './box.js';
import { cdpUrlFor, screenFor } from './computer.js';
import { db } from './db.js';
import { mcpServersFor } from './lib/mcp-connectors.js';
import { deployment } from './deployment.js';
import { env } from './env.js';
import type { EngineInfo, EngineProvider } from './types.js';

/**
 * Every bot is run by a Hermes agent.
 *
 * - The 'primary' engine is a Hermes gateway that already runs on the computer (HERMES_URL, home
 *   HERMES_HOME_PRIMARY). It has its own life: messaging, memory, model. We only talk to its API
 *   server; we never write its config, restart it or stop it.
 * - A 'managed' engine is a Hermes home of our own under ENGINES_DIR/<botId> with its own
 *   `hermes gateway run`, started here and left running when this server exits. Its home sits
 *   outside ~/.hermes, so Hermes treats it as a separate tenant beside the primary gateway.
 */

export type EngineKind = 'primary' | 'managed';
export interface Engine { kind: EngineKind; url: string; key: string; home: string }

const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;

// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// ---------- identity ----------

/** Token a bot's Hermes agent presents to this server's MCP endpoint. `primary` names the primary bot. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(`mcp:${botId}`).digest('hex');
}

export function primaryBotId(): string | null {
  const b = db.prepare("SELECT id, user_id FROM bots WHERE engine='primary' LIMIT 1").get() as any;
  if (!b) return null;
  deployment.requireOwner(b.user_id);
  if (!deployment.assignPrimary(b.id, b.user_id)) throw new Error('Primary Hermes binding does not match this bot.');
  return b.id;
}

export function engineKind(botId: string): EngineKind | null {
  const e = botRow(botId)?.engine;
  return e === 'primary' || e === 'managed' ? e : null;
}

/** Resolve existing symlinks even when the final path has not been created yet. */
function canonicalPath(file: string, seen = new Set<string>()): string {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) throw new Error('Cyclic symlink in Hermes home configuration.');
  seen.add(absolute);
  try { return fs.realpathSync(absolute); } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      return canonicalPath(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)), seen);
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error('Cannot resolve Hermes home configuration.');
  return path.join(canonicalPath(parent, seen), path.basename(absolute));
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Managed homes must not overlap, contain, or link into the externally owned primary home. */
function managedRoot(): string {
  const primary = canonicalPath(env.hermesHome);
  const managed = canonicalPath(env.enginesDir);
  if (within(managed, primary) || within(primary, managed)) {
    throw new Error('ENGINES_DIR and HERMES_HOME_PRIMARY must be separate, non-overlapping directories.');
  }
  return managed;
}

function homeFor(botId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error('Invalid agent ID for a managed Hermes home.');
  const root = managedRoot();
  const home = canonicalPath(path.join(env.enginesDir, botId));
  if (home !== path.join(root, botId)) throw new Error('Managed Hermes home escapes or aliases another home in ENGINES_DIR.');
  return home;
}

/** Files that we create/read must resolve inside this managed agent's own home. */
function managedPath(home: string, ...parts: string[]): string {
  const file = path.join(home, ...parts);
  if (!within(canonicalPath(file), home)) throw new Error('Managed Hermes file escapes its agent home.');
  return file;
}

function ownedBot(botId: string) {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  deployment.requireOwner(b.user_id);
  return b;
}

function managedBot(botId: string) {
  const b = ownedBot(botId);
  if (b.engine !== 'managed') throw new Error('not a managed engine');
  return b;
}

let cachedPrimaryKey: string | null = null;
function primaryKey(): string {
  if (env.hermesKey) return env.hermesKey;
  if (cachedPrimaryKey === null) cachedPrimaryKey = readDotenv(path.join(env.hermesHome, '.env')).API_SERVER_KEY ?? '';
  return cachedPrimaryKey;
}

// ---------- assignment ----------

function freePort(): number {
  const used = new Set((db.prepare('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all() as any[]).map((r) => r.engine_port as number));
  let p = env.enginePortBase;
  while (used.has(p)) p++;
  return p;
}

/** Bind the primary engine once; deleting its bot never transfers the external agent to another bot. */
export function assignEngine(botId: string): EngineKind {
  return db.transaction((): EngineKind => {
    const b = ownedBot(botId);
    if (b.engine === 'primary') {
      if (!deployment.assignPrimary(botId, b.user_id)) throw new Error('Primary Hermes binding does not match this bot.');
      return 'primary';
    }
    if (b.engine === 'managed') {
      homeFor(botId);
      return 'managed';
    }
    if (deployment.assignPrimary(botId, b.user_id)) {
      db.prepare("UPDATE bots SET engine='primary', engine_port=NULL WHERE id=?").run(botId);
      return 'primary';
    }
    homeFor(botId);
    db.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(freePort(), botId);
    return 'managed';
  })();
}

// ---------- a managed bot's Hermes home ----------

/** Model credentials eligible for the operator's explicit inheritance grant. Never messaging tokens. */
const SHARED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
];

/** Parts of the primary agent's config a managed agent starts from, so it reaches the same models. */
const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers'];

function soul(b: any): string {
  const owner = (db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id) as any)?.name ?? 'the user';
  const role = b.label ? `, ${b.label}` : '';
  return [
    `You are ${b.name}${role}. You work for ${owner} as one of a small team of AI agents, each with its own screen on a shared computer.`,
    b.description ? `\n${b.description}` : '',
    '\nYou are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    '',
  ].join('\n');
}

/** Rewrite the persona file after a rename or a new description. The primary agent keeps its own. */
export function syncPersona(botId: string) {
  const b = ownedBot(botId);
  if (b.engine !== 'managed') return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  fs.writeFileSync(managedPath(home, 'SOUL.md'), soul(b));
}

function extraMcpServers(): Record<string, any> {
  if (!env.extraMcpServers) return {};
  try {
    const v = JSON.parse(env.extraMcpServers);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    console.warn('[engine] EXTRA_MCP_SERVERS is not valid JSON; ignored');
    return {};
  }
}

/** Create or refresh the home. config.yaml is created once; after that only the keys we own are patched. */
async function writeHome(botId: string): Promise<{ home: string; key: string; display: string | null; modelSetupRequired: boolean }> {
  const b = managedBot(botId);
  const home = homeFor(botId);
  fs.mkdirSync(managedPath(home, 'logs'), { recursive: true });
  fs.mkdirSync(managedPath(home, 'locks'), { recursive: true });
  fs.chmodSync(home, 0o700);

  // Its screen decides which display and which Chrome it drives. Only meaningful on the computer itself.
  let display: string | null = null;
  let cdp = '';
  if (env.localBox) {
    try {
      const s = await screenFor(b.user_id, botId);
      display = displayFor(s.screenId);
      cdp = cdpUrlFor(botId, s.screenId);
    } catch (e: any) {
      console.warn(`[engine] no screen for ${b.name} yet: ${e?.message ?? e}`);
    }
  }

  const cwd = env.localBox ? `/root/grokbot/files/${botId}` : managedPath(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const cfgFile = managedPath(home, 'config.yaml');
  const fresh = !fs.existsSync(cfgFile);
  const cfg = fresh ? {} : readYaml(cfgFile);
  if (fresh) {
    if (env.inheritPrimaryCredentials) {
      const primary = readYaml(path.join(env.hermesHome, 'config.yaml'));
      for (const k of SHARED_CONFIG) if (primary[k] !== undefined) cfg[k] = primary[k];
    }
    cfg.agent = { reasoning_effort: 'medium' };
  }
  cfg.platform_toolsets = { ...(cfg.platform_toolsets ?? {}), api_server: ['hermes-api-server', ...(display ? ['computer_use'] : [])] };
  cfg.terminal = { ...(cfg.terminal ?? {}), cwd };
  if (cdp) cfg.browser = { ...(cfg.browser ?? {}), cdp_url: cdp };
  cfg.mcp_servers = {
    ...(cfg.mcp_servers ?? {}),
    ...extraMcpServers(),
    ...mcpServersFor(db, botId),
    hq: { url: `${env.mcpBaseUrl}/mcp/${botId}`, headers: { Authorization: `Bearer ${mcpToken(botId)}` }, timeout: 1800, connect_timeout: 30 },
  };
  writePrivate(cfgFile, YAML.stringify(cfg));

  // Mark newly provisioned homes without a model so retries keep reporting setup required.
  // Existing homes can use Hermes-specific configuration layouts and remain untouched.
  const setupMarker = managedPath(home, '.uap-model-setup-required');
  const hasModel = (typeof cfg.model === 'string' && cfg.model.trim().length > 0) ||
    (cfg.model !== null && typeof cfg.model === 'object' && Object.keys(cfg.model).length > 0);
  if (fresh && !hasModel) writePrivate(setupMarker, 'Configure a model in this managed Hermes home before starting.\n');
  if (hasModel && fs.existsSync(setupMarker)) fs.unlinkSync(setupMarker);
  const modelSetupRequired = fs.existsSync(setupMarker);

  if (!fs.existsSync(managedPath(home, 'SOUL.md'))) fs.writeFileSync(managedPath(home, 'SOUL.md'), soul(b));

  // Existing managed sign-ins remain private to that home; new copies require an explicit operator grant.
  const auth = managedPath(home, 'auth.json');
  if (env.inheritPrimaryCredentials && !fs.existsSync(auth)) {
    try { writePrivate(auth, fs.readFileSync(path.join(env.hermesHome, 'auth.json'), 'utf8')); } catch { /* the primary agent has none */ }
  }

  // Keep existing managed keys. Read/copy primary or server model keys only with an explicit grant.
  const envFile = managedPath(home, '.env');
  const mine = readDotenv(envFile);
  const key = mine.API_SERVER_KEY || crypto.randomBytes(24).toString('hex');
  const vars: Record<string, string> = { ...mine };
  if (env.inheritPrimaryCredentials) {
    const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
    for (const k of SHARED_ENV) {
      const v = primaryEnv[k] ?? process.env[k];
      if (v && !vars[k]) vars[k] = v;
    }
  }
  Object.assign(vars, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key, API_SERVER_PORT: String(b.engine_port), API_SERVER_HOST: '127.0.0.1' });
  if (cdp) vars.BROWSER_CDP_URL = cdp; else delete vars.BROWSER_CDP_URL;
  writePrivate(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  return { home, key, display, modelSetupRequired };
}

// ---------- a managed bot's gateway ----------

async function healthy(url: string, timeoutMs = 2500): Promise<any | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function keyAccepted(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** A missing/dead process is safe; an existing but unproven process blocks cleanup. */
function gatewayPid(home: string): number | null {
  const pidFile = managedPath(home, 'gateway.pid');
  let raw: string;
  try { raw = fs.readFileSync(pidFile, 'utf8').trim(); } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Cannot inspect managed gateway ownership; cleanup is blocked.');
  }
  const unproven = () => new Error('Cannot prove this live gateway belongs to the managed Hermes home; cleanup is blocked.');
  let pid = NaN;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'number') pid = j;
    else {
      if (j?.hermes_home && canonicalPath(j.hermes_home) !== home) throw unproven();
      pid = Number(j?.pid);
    }
  } catch (error) {
    if (/^\d+$/.test(raw)) pid = Number(raw);
    else throw unproven();
  }
  if (!Number.isInteger(pid) || pid <= 1) throw unproven();
  try { process.kill(pid, 0); } catch (error: any) {
    if (error?.code === 'ESRCH') return null;
    throw unproven();
  }
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gateway')) throw unproven();
    const ownHome = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(v => v.startsWith('HERMES_HOME='))?.slice('HERMES_HOME='.length);
    if (!ownHome || canonicalPath(ownHome) !== home) throw unproven();
  } catch { throw unproven(); }
  return pid;
}

async function stopGateway(botId: string) {
  managedBot(botId);
  const home = homeFor(botId);
  const pid = gatewayPid(home);
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    // Recheck ownership before every signal; never trust an old pid after an await.
    if (gatewayPid(home) !== pid) throw new Error('Gateway process changed during shutdown; cleanup is blocked.');
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch (error: any) {
      if (error?.code !== 'ESRCH') throw error;
    } }
  };
  const gone = () => {
    try { process.kill(pid, 0); return false; } catch (error: any) {
      if (error?.code === 'ESRCH') return true;
      throw new Error('Cannot confirm gateway shutdown; cleanup is blocked.');
    }
  };
  signal('SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (gone()) return;
  }
  signal('SIGKILL');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (gone()) return;
  }
  throw new Error('The managed gateway is still running; cleanup is blocked.');
}

const starting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();
const keys = new Map<string, string>();

function managedUrl(botId: string): string {
  return `http://127.0.0.1:${botRow(botId).engine_port}`;
}

function managedKey(botId: string): string {
  let k = keys.get(botId);
  if (!k) {
    const home = homeFor(botId);
    k = readDotenv(managedPath(home, '.env')).API_SERVER_KEY ?? '';
    if (k) keys.set(botId, k);
  }
  return k;
}

async function startGateway(botId: string): Promise<void> {
  const b = managedBot(botId);
  homeFor(botId); // Validate before contacting or stopping any process.
  if (!b.engine_port) db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort(), botId);
  const url = managedUrl(botId);

  // A gateway from an earlier run of this server is still good: use it as it is.
  if ((await healthy(url)) && managedKey(botId) && (await keyAccepted(url, managedKey(botId)))) return;
  if (await healthy(url)) {
    if (gatewayPid(homeFor(botId))) await stopGateway(botId);
    else throw new Error(`Port ${botRow(botId).engine_port} is taken by something else.`);
  }

  const { home, key, display, modelSetupRequired } = await writeHome(botId);
  if (modelSetupRequired) {
    throw new Error(`Managed Hermes needs model setup. Configure this agent's model and credentials in ${path.join(home, 'config.yaml')} and its private home, then retry. Primary credentials are not inherited without HERMES_INHERIT_PRIMARY_CREDENTIALS=1.`);
  }
  keys.set(botId, key);
  if (gatewayPid(home)) await stopGateway(botId);

  const log = fs.openSync(managedPath(home, 'logs', 'gateway.out.log'), 'a');
  const child = spawn(env.hermesBin, ['gateway', 'run', '--no-supervise'], {
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    // Only what the agent needs. None of this server's secrets, and nothing of the primary agent's messaging.
    env: {
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME ?? '/root',
      USER: process.env.USER ?? 'root',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HERMES_HOME: home,
      HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'),
      // Hermes' browser tool talks to a helper process it finds under this folder. With the default
      // (one folder per HOME) every agent on the computer would end up driving the same browser.
      BH_HOME: path.join(home, 'browser-harness'),
      ...(display ? { DISPLAY: display } : {}),
    },
  });
  fs.closeSync(log);
  let exited: string | null = null;
  child.once('error', (e) => { exited = `could not run ${env.hermesBin}: ${e.message}`; });
  child.once('exit', (code) => { exited = `the agent stopped while starting (exit ${code}). See ${path.join(home, 'logs', 'gateway.out.log')}`; });
  child.unref();

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) throw new Error(exited);
    if (await healthy(url, 1500)) {
      console.log(`[engine] ${b.name}: gateway up on ${url}`);
      return;
    }
  }
  throw new Error('The agent did not come up within 90 seconds.');
}

/** Start (or adopt) the bot's gateway. Safe to call often; concurrent calls share one start. */
function ensureManaged(botId: string): Promise<void> {
  let p = starting.get(botId);
  if (!p) {
    p = startGateway(botId)
      .then(() => { failures.delete(botId); })
      .catch((e: any) => {
        const msg = String(e?.message ?? e);
        failures.set(botId, msg);
        console.warn(`[engine] ${botId}: ${msg}`);
        throw e;
      })
      .finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

/** Where to send this bot's turns. Starts its gateway if it is not running. */
export async function engineFor(botId: string): Promise<Engine> {
  const b = ownedBot(botId);
  let kind = engineKind(botId);
  if (!kind) {
    if (b.kind === 'room') throw new Error('A group chat has no agent of its own.');
    kind = assignEngine(botId);
  }
  if (kind === 'primary') {
    if (!deployment.assignPrimary(botId, b.user_id)) throw new Error('Primary Hermes binding does not match this bot.');
    return { kind, url: env.hermesUrl, key: primaryKey(), home: env.hermesHome };
  }
  const url = managedUrl(botId);
  if (!(await healthy(url, 1500)) || !managedKey(botId)) await ensureManaged(botId);
  return { kind, url, key: managedKey(botId), home: homeFor(botId) };
}

/** The bot's Hermes home, without starting anything (memory files, sign-in commands). */
export function engineHome(botId: string): string | null {
  const b = botRow(botId);
  if (!b) return null;
  deployment.requireOwner(b.user_id);
  const kind = engineKind(botId);
  if (kind === 'primary' && !deployment.assignPrimary(botId, b.user_id)) throw new Error('Primary Hermes binding does not match this bot.');
  return kind === 'primary' ? env.hermesHome : kind === 'managed' ? homeFor(botId) : null;
}

/**
 * Hermes can run a private screen of its own for a profile (its "Bot Desktop": an Xvnc display with
 * state in <home>/bot-desktop). While that screen is up, the agent's computer-use tool acts there and
 * not on the screen this app shows (so does its browser tool, unless the config pins it to a Chrome
 * with `browser.cdp_url`), so the user could be watching an idle desktop.
 */
export function ownScreenOn(botId: string): boolean {
  const home = engineHome(botId);
  if (!home) return false;
  const dir = path.join(home, 'bot-desktop');
  try {
    // launcher.pid holds "<pid> <create time>"; the env file appears once the screen is usable.
    const pid = Number(fs.readFileSync(path.join(dir, 'launcher.pid'), 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(path.join(dir, 'env'))) return false;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Ask Hermes to stop that private screen. Hermes refuses while a person is using it; the refusal is passed on. */
export function stopOwnScreen(botId: string): Promise<void> {
  const home = engineHome(botId);
  if (!home) return Promise.reject(new Error('This bot has no agent.'));
  return new Promise((resolve, reject) => {
    execFile(env.hermesBin, ['computer-use', 'screen', 'stop'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!ownScreenOn(botId)) return resolve();
      const said = `${stderr || ''}\n${stdout || ''}`.trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || (err ? String(err.message) : 'The screen is still running.')));
    });
  });
}

/** Start the gateway in the background (after creating a bot, or on server start). */
export function provisionEngine(botId: string) {
  if (engineKind(botId) === 'managed') ensureManaged(botId).catch(() => {});
}

export async function restartEngine(botId: string): Promise<void> {
  if (engineKind(botId) !== 'managed') return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  optionsCache.delete(botId);
  provisionEngine(botId);
}

/** The bot is gone: stop its gateway and delete its home. The primary agent is left alone. */
export async function removeEngine(botId: string): Promise<void> {
  const b = ownedBot(botId);
  if (b.engine !== 'managed') return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  keys.delete(botId);
  failures.delete(botId);
  optionsCache.delete(botId);
  homeFor(botId); // Recheck after awaiting shutdown before removing anything.
  fs.rmSync(home, { recursive: true, force: true });
}

/** On server start: give older bots an engine, then bring the managed gateways up. */
export function initEngines() {
  managedRoot();
  fs.mkdirSync(env.enginesDir, { recursive: true });
  const bots = db.prepare("SELECT id, is_primary FROM bots WHERE engine IS NULL AND COALESCE(kind,'agent') <> 'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all() as any[];
  for (const b of bots) assignEngine(b.id);
  for (const b of db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as any[]) provisionEngine(b.id);
}

// ---------- what the settings panel shows ----------

/** Providers worth showing even when not signed in. */
const WELL_KNOWN = ['anthropic', 'openai-codex', 'xai-oauth', 'xai', 'openrouter', 'nous', 'gemini', 'openai-api'];

const optionsCache = new Map<string, { at: number; data: any }>();

async function modelOptions(botId: string, e: { url: string; key: string }): Promise<any | null> {
  const hit = optionsCache.get(botId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  try {
    const r = await fetch(`${e.url}/api/model/options`, { headers: e.key ? { Authorization: `Bearer ${e.key}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    optionsCache.set(botId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

function toProviders(data: any): EngineProvider[] {
  const list: any[] = Array.isArray(data?.providers) ? data.providers : [];
  const out = list
    .filter((p) => p?.slug && (p.authenticated || WELL_KNOWN.includes(p.slug)))
    .map((p): EngineProvider => {
      const featured = Array.isArray(p.featured_models) && p.featured_models.length ? p.featured_models : Array.isArray(p.models) ? p.models : [];
      return {
        id: String(p.slug),
        name: p.slug === 'anthropic' ? 'Claude (Anthropic)' : String(p.name ?? p.slug),
        // Hermes lists Anthropic as an API-key provider, yet it can also sign in to a Claude subscription. Offer that until a key is in place.
        kind: String(p.auth_type ?? '').includes('oauth') || (p.slug === 'anthropic' && !p.authenticated) ? 'subscription' : 'api_key',
        connected: !!p.authenticated,
        models: featured.filter((m: unknown) => typeof m === 'string').slice(0, 12),
      };
    });
  const rank = (p: EngineProvider) => (p.connected ? 0 : 1) * 100 + (WELL_KNOWN.indexOf(p.id) < 0 ? 50 : WELL_KNOWN.indexOf(p.id));
  return out.sort((a, b) => rank(a) - rank(b));
}

export async function engineInfo(botId: string): Promise<EngineInfo> {
  const b = ownedBot(botId);
  const kind = engineKind(botId);
  const base: EngineInfo = { botId, kind, configurationMode: 'in_hermes', profile: kind === 'primary' ? 'default' : botId, status: 'stopped', error: null, model: null, provider: null, version: null, providers: [], ownScreen: kind ? ownScreenOn(botId) : false };
  if (!kind) return { ...base, status: 'error', error: 'This bot has no agent.' };

  let e: { url: string; key: string };
  if (kind === 'primary') e = { url: env.hermesUrl, key: primaryKey() };
  else {
    if (!b.engine_port) return { ...base, status: 'error', error: 'No port assigned.' };
    e = { url: managedUrl(botId), key: managedKey(botId) };
  }

  const health = await healthy(e.url);
  if (!health) {
    if (kind === 'primary') return { ...base, status: 'error', error: `The agent at ${env.hermesUrl} is not answering.` };
    if (starting.has(botId)) return { ...base, status: 'starting' };
    const failed = failures.get(botId);
    if (failed) return { ...base, status: 'error', error: failed };
    provisionEngine(botId);
    return { ...base, status: 'starting' };
  }
  if (kind === 'managed' && starting.has(botId)) return { ...base, status: 'starting' };

  const data = await modelOptions(botId, e);
  return {
    ...base,
    status: 'ready',
    version: typeof health.version === 'string' && health.version !== 'unknown' ? health.version : null,
    // SQLite fields are historical hints, never an authority over gateway configuration.
    model: typeof data?.model === 'string' && data.model.trim() ? data.model : null,
    provider: typeof data?.provider === 'string' && data.provider.trim() ? data.provider : null,
    providers: toProviders(data),
  };
}

/** After a sign-in the provider list changes; drop what we remembered. */
export function forgetEngineOptions(botId: string) { optionsCache.delete(botId); }
