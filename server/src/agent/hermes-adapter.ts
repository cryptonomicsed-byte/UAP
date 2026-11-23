/**
 * Hermes adapter mapping and conversation lifecycle (V6-07-01, V6-07-07).
 *
 * The app talks to Hermes through the gateway's own HTTP surface, not through an
 * ACP-style adapter protocol. `HERMES_GATEWAY_SURFACE` states that mapping one
 * concept at a time and names the file and token that prove each claim; the test
 * suite re-reads those files so the table cannot describe a call this tree no
 * longer makes. Features the gateway does not offer are recorded as
 * `unsupported` with what is missing, never as silent parity.
 *
 * A conversation thread belongs to the SID that owns the agent. The thread id is
 * a pure function of (SID, generation): no model, clock or process state enters
 * it, so a model swap in Hermes configuration and a runtime restart both resume
 * the same thread — while two SIDs can never collide on one thread, which is the
 * failure V6-07-07 exists to prevent. Agents that have not been bound to an
 * issued SID keep the legacy bot-id thread; nothing silently invents a SID.
 */
import { db, now } from '../db.js';

export type AdapterVerdict = 'mapped' | 'partial' | 'unsupported';

export interface AdapterEvidence {
  /** Repo-relative path of the file that performs the call. */
  file: string;
  /** Literal that must still appear in that file. */
  token: string;
}

export interface AdapterSurfaceEntry {
  /** The ACP / OpenMausBot adapter concept this row answers for. */
  concept: string;
  verdict: AdapterVerdict;
  hermes: { method?: 'GET' | 'POST'; endpoint?: string; field?: string; note: string };
  evidence: AdapterEvidence[];
  /** Required on `unsupported` and `partial`: what Hermes does not give us. */
  limitation?: string;
}

const LOOP = 'server/src/agent/loop.ts';
const ENGINE = 'server/src/engine.ts';

export const HERMES_GATEWAY_SURFACE: readonly AdapterSurfaceEntry[] = [
  {
    concept: 'session/new',
    verdict: 'partial',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'conversation',
      note: 'The client names the conversation thread; the gateway does not mint a session id we can read back.',
    },
    evidence: [{ file: LOOP, token: 'conversation: conversationThread(' }],
    limitation: 'No session object, no server-issued id: the thread name is ours, derived from the SID.',
  },
  {
    concept: 'session/prompt',
    verdict: 'mapped',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'input',
      note: 'One turn = one POST with `input` and app `instructions`; the model alias is resolved by the gateway.',
    },
    evidence: [
      { file: LOOP, token: '/v1/responses' },
      { file: LOOP, token: 'instructions: await instructionsFor(' },
    ],
  },
  {
    concept: 'session/update',
    verdict: 'mapped',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'stream',
      note: 'Progress arrives as SSE: response.output_text.delta, response.reasoning_*_delta, response.output_item.added|done, hermes.status.',
    },
    evidence: [
      { file: LOOP, token: 'response.output_text.delta' },
      { file: LOOP, token: 'hermes.status' },
    ],
  },
  {
    concept: 'session/cancel',
    verdict: 'partial',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'signal',
      note: 'Cancel aborts our HTTP request; we cannot tell the gateway to stop the run it may still be executing.',
    },
    evidence: [{ file: LOOP, token: 'signal: ctrl.signal' }],
    limitation: 'Abort is client-side only. The transcript may still be written engine-side because store is true.',
  },
  {
    concept: 'session/load',
    verdict: 'partial',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'store',
      note: 'History lives in the gateway (`store: true`) and is resumed by conversation name, not by a load call.',
    },
    evidence: [{ file: LOOP, token: 'store: true' }],
    limitation: 'Resumption is the gateway reusing the named thread; there is no load/attach handshake and no proof here against a live gateway.',
  },
  {
    concept: 'session/request_permission',
    verdict: 'partial',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'function_call',
      note: 'The gateway runs the tool; the app gates its own tools through approval cards before the MCP call proceeds.',
    },
    evidence: [
      { file: LOOP, token: 'requestApproval' },
      { file: LOOP, token: "'response.output_item.added'" },
    ],
    limitation: 'The permission round trip is the app MCP + approvals flow, not an ACP permission request to the adapter.',
  },
  {
    concept: 'tool execution',
    verdict: 'partial',
    hermes: {
      method: 'POST',
      endpoint: '/v1/responses',
      field: 'function_call',
      note: 'Hermes executes its own tools and reports function_call/function_call_output items; this app executes none of them on its behalf.',
    },
    evidence: [
      { file: LOOP, token: 'function_call_output' },
      { file: LOOP, token: 'claimToolRow' },
    ],
    limitation: 'No adapter-side tool runner: results are observed and recorded, not produced.',
  },
  {
    concept: 'mcp discovery',
    verdict: 'unsupported',
    hermes: {
      note: 'This app serves its own MCP endpoint per agent; gateway-side discovery of it is configuration we have not proven.',
    },
    evidence: [{ file: 'server/src/mcp.ts', token: 'POST /mcp/<botId>' }],
    limitation: 'No discovery handshake in this tree; pointing a gateway at /mcp is operator configuration, not an implemented adapter feature.',
  },
  {
    concept: 'model selection',
    verdict: 'mapped',
    hermes: {
      method: 'GET',
      endpoint: '/api/model/options',
      note: 'Gateway configuration is the only model authority; turns send the `hermes-agent` alias and never a stored model hint.',
    },
    evidence: [
      { file: ENGINE, token: '/api/model/options' },
      { file: LOOP, token: "model: 'hermes-agent'" },
    ],
  },
  {
    concept: 'engine key check',
    verdict: 'mapped',
    hermes: {
      method: 'GET',
      endpoint: '/v1/models',
      note: 'A managed gateway is only reused when it answers with the key from its own home.',
    },
    evidence: [{ file: ENGINE, token: '/v1/models' }],
  },
  {
    concept: 'health',
    verdict: 'mapped',
    hermes: {
      method: 'GET',
      endpoint: '/health',
      note: 'Liveness and version for the engine panel and before reusing a gateway.',
    },
    evidence: [{ file: ENGINE, token: '/health' }],
  },
];

export type AdapterIdentityFailure =
  | 'sid_invalid'
  | 'bot_invalid'
  | 'generation_invalid'
  | 'bot_missing'
  | 'sid_in_use'
  | 'sid_rebind_requires_new_generation';

export class AdapterIdentityError extends Error {
  readonly code: AdapterIdentityFailure;

  constructor(code: AdapterIdentityFailure, message: string) {
    super(message);
    this.name = 'AdapterIdentityError';
    this.code = code;
  }
}

/** Same grammar the issuance service enforces; a thread may not carry a looser id. */
const SID_RE = /^sid_[a-z0-9][a-z0-9_-]{0,62}$/;
const BOT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ThreadIdentity {
  thread: string;
  /** `sid` = scoped to an issued identity; `bot-legacy` = not yet bound. */
  scopedBy: 'sid' | 'bot-legacy';
}

/**
 * The engine-side thread name for one conversation.
 *
 * Deliberately not parameterised by model or provider: swapping the model under a
 * SID keeps its thread, and a restart re-derives the same name from stored state.
 */
export function conversationThread(input: { botId: string; sid?: string | null; generation: number }): ThreadIdentity {
  const botId = input?.botId;
  if (typeof botId !== 'string' || !BOT_RE.test(botId)) {
    throw new AdapterIdentityError('bot_invalid', 'botId must be 1-64 characters of [A-Za-z0-9_-].');
  }
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new AdapterIdentityError('generation_invalid', 'generation must be a positive integer.');
  }
  const sid = input.sid ?? null;
  if (sid === null) return { thread: `hq-${botId}-g${input.generation}`, scopedBy: 'bot-legacy' };
  if (typeof sid !== 'string' || !SID_RE.test(sid)) {
    throw new AdapterIdentityError('sid_invalid', 'sid must match sid_<slug>.');
  }
  return { thread: `hq-${sid}-g${input.generation}`, scopedBy: 'sid' };
}

/**
 * Bind an issued SID to an agent row, so its conversations are threaded under that
 * identity. Operator action, not issuance: it records what the operator asserts and
 * refuses the two states that would be a lie —
 *  - a SID already bound to another live agent (`sid_in_use`),
 *  - re-labelling a conversation that already has rows in the current generation
 *    (`sid_rebind_requires_new_generation`); open a new chat first, so old rows keep
 *    the thread they were written under.
 */
export function bindConversationSid(
  botId: string,
  sid: string,
  options: { apply?: boolean } = {},
): { botId: string; sid: string; thread: string; applied: boolean } {
  const apply = options.apply ?? true;
  const requested = conversationThread({ botId, sid, generation: 1 }); // grammar first: no DB writes on a bad id
  if (requested.scopedBy !== 'sid') throw new AdapterIdentityError('sid_invalid', 'sid must match sid_<slug>.');
  const bot = db.prepare('SELECT id, sid, generation FROM bots WHERE id=?').get(botId) as
    | { id: string; sid: string | null; generation: number }
    | undefined;
  if (!bot) throw new AdapterIdentityError('bot_missing', `No agent ${botId}.`);

  if (bot.sid === sid) {
    return { botId, sid, thread: conversationThread({ botId, sid, generation: bot.generation }).thread, applied: false };
  }

  const rows = (db.prepare('SELECT COUNT(*) AS n FROM rows WHERE bot_id=? AND generation=?').get(botId, bot.generation) as { n: number }).n;
  if (rows > 0) {
    throw new AdapterIdentityError(
      'sid_rebind_requires_new_generation',
      `${botId} already has ${rows} row(s) in generation ${bot.generation}; open a new chat before binding ${sid}.`,
    );
  }
  const other = db.prepare('SELECT id FROM bots WHERE sid=? AND id<>?').get(sid, botId) as { id: string } | undefined;
  if (other) throw new AdapterIdentityError('sid_in_use', `${sid} is already bound to ${other.id}.`);

  if (apply) db.prepare('UPDATE bots SET sid=?, updated_at=? WHERE id=?').run(sid, now(), botId);
  return { botId, sid, thread: conversationThread({ botId, sid, generation: bot.generation }).thread, applied: apply };
}
