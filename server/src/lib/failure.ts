/**
 * Honest failure reporting for turns and provider-backed tools.
 *
 * A degraded model or tool provider must never look like a successful run, a silent
 * retry or a made-up answer. This module turns whatever went wrong into a stable code
 * and a plain-language explanation the transcript can show, and strips credentials and
 * markup from anything that is only useful to a log.
 *
 * Nothing here retries or falls back: the callers make exactly the call they asked for.
 */

export type FailureCode =
  | 'engine_unreachable'
  | 'engine_auth'
  | 'provider_auth'
  | 'provider_rate_limited'
  | 'provider_billing'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'context_length'
  | 'timeout'
  | 'run_failed';

export interface FailureView {
  code: FailureCode;
  text: string;
  retryable: boolean;
}

/** A provider-backed tool failed; the message is safe to hand to the model and the user. */
export class ToolProviderError extends Error {
  constructor(public readonly provider: string, message: string) {
    super(message);
    this.name = 'ToolProviderError';
  }
}

/** Codes whose cause is a setting, an account or the model choice: running it again changes nothing. */
const NOT_RETRYABLE = new Set<FailureCode>([
  'engine_auth', 'provider_auth', 'provider_billing', 'model_unavailable', 'context_length', 'run_failed',
]);

const TEXT: Record<FailureCode, string> = {
  engine_unreachable: 'The Hermes gateway is not reachable. Check that it is running, then try again.',
  engine_auth: 'The Hermes gateway rejected its credentials. Check the gateway API key or sign-in in Hermes, then try again.',
  provider_auth: 'The model provider rejected its API key. Check that provider in Hermes, then try again.',
  provider_rate_limited: 'The model provider is rate limiting requests. Wait a moment, then try again.',
  provider_billing: 'The model provider refused the request for a billing or quota reason. Check the provider account; retrying will not help until it is fixed.',
  provider_unavailable: 'The model provider failed to answer. Nothing was retried and no other provider was used; try again shortly.',
  model_unavailable: 'The configured model is not available from its provider. Pick a model that exists in Hermes, then try again.',
  context_length: 'This conversation is too long for the configured model. Start a fresh chat or choose a model with a larger context window.',
  timeout: 'The model provider did not answer in time. Nothing was retried; try again.',
  run_failed: 'The agent run failed. Nothing was retried automatically; try again or check the Hermes gateway logs.',
};

const MAX_DETAIL = 200;

/**
 * Keep only what a log line needs: no HTML/JSON markup, no credentials, no control bytes.
 * Never used as the user-facing explanation — see TEXT for that.
 */
export function sanitizeDetail(raw: unknown, max = MAX_DETAIL): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw
    .replace(/<[^>]{0,400}>/g, ' ')
    .replace(/\b(?:sk|xai|gsk|api|key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

interface FailureInput {
  status?: number;
  /** The provider's own machine-readable code, when the body carried one. */
  code?: string;
  message?: string;
  cause?: any;
}

function networkFailure(input: FailureInput): boolean {
  const cause = input.cause?.code ?? input.cause?.errno ?? '';
  const message = String(input.message ?? '');
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|UND_ERR_|socket hang up/i.test(`${message} ${cause}`)
    || /UND_ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(cause));
}

function codeFromText(text: string): FailureCode | null {
  if (/context[_ -]?length|maximum context|too many tokens|token limit|conversation.*too long/i.test(text)) return 'context_length';
  if (/rate.?limit|too many requests|quota exceeded.*per minute|\b429\b/i.test(text)) return 'provider_rate_limited';
  if (/payment required|billing|insufficient (?:credit|quota)|out of credit|\b402\b/i.test(text)) return 'provider_billing';
  if (/model.*(?:not found|does not exist|unknown|unavailable|no access)|no such model|does not have access to model/i.test(text)) return 'model_unavailable';
  if (/api.?key|credential|unauthor|authenticat|invalid key|\b40[13]\b/i.test(text)) return 'provider_auth';
  if (/timed? ?out|timeout|deadline exceeded|\b40[48]\b|\b504\b/i.test(text)) return 'timeout';
  if (/upstream|provider|overloaded|bad gateway|service unavailable|\b50[234]\b|\b529\b/i.test(text)) return 'provider_unavailable';
  return null;
}

function classify(input: FailureInput): FailureCode {
  const message = String(input.message ?? '');
  const providerCode = String(input.code ?? '');
  const status = input.status;

  if (networkFailure(input)) return 'engine_unreachable';
  if (status === 401 || status === 403) return 'engine_auth';
  if (status === 402) return 'provider_billing';

  // The provider's own code wins over prose when it is one we know.
  const fromProviderCode = codeFromText(`${providerCode} ${message}`);
  if (providerCode) {
    if (/context/i.test(providerCode)) return 'context_length';
    if (/rate|too_many/i.test(providerCode)) return 'provider_rate_limited';
    if (/billing|payment|quota/i.test(providerCode)) return 'provider_billing';
    if (/model/i.test(providerCode) && /not_found|unavailable|no_access/i.test(providerCode)) return 'model_unavailable';
    if (/auth|unauthor|invalid_api_key/i.test(providerCode)) return 'provider_auth';
    if (/timeout/i.test(providerCode)) return 'timeout';
    if (/provider|upstream|unavailable|overloaded/i.test(providerCode)) return 'provider_unavailable';
  }
  if (fromProviderCode) return fromProviderCode;

  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'provider_rate_limited';
  if (status === 502 || status === 503 || status === 529) return 'provider_unavailable';
  if (status !== undefined && status >= 500) return 'run_failed';
  return 'run_failed';
}

/** Classify anything a turn can throw into a notice the transcript can show honestly. */
export function classifyFailure(error: unknown): FailureView {
  const e = error as FailureInput & { engineCode?: string; name?: string };
  const code = classify({
    status: typeof e?.status === 'number' ? e.status : undefined,
    code: e?.engineCode ?? (e as any)?.providerCode,
    message: String((error as any)?.message ?? error ?? ''),
    cause: e?.cause,
  });
  return { code, text: TEXT[code], retryable: !NOT_RETRYABLE.has(code) };
}

/** A tool provider answered badly: say which call failed, what state it left, and stop. */
export function toolFailure(provider: string, what: string, status?: number): ToolProviderError {
  const http = status === undefined ? '' : ` (HTTP ${status})`;
  return new ToolProviderError(provider, `${what} failed${http}. The ${provider} provider did not complete the request; nothing was retried.`);
}

/** A tool provider could not be reached at all. */
export function toolUnreachable(provider: string, what: string): ToolProviderError {
  return new ToolProviderError(provider, `${what} could not reach ${provider}. The network or the provider is unavailable; nothing was retried.`);
}
