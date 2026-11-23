import type { NoticeBody } from '@shared/types';

export interface NoticeView {
  tone: 'info' | 'warn' | 'error';
  /** The explanation the server wrote; the UI never rephrases it. */
  text: string;
  code: string | null;
  /** A follow-up line only when the same action can plausibly work again. */
  hint: string | null;
}

/** Codes where retrying is actually the remedy (transient: rate limit, outage, timeout, gateway down). */
const RETRY_HELPS = new Set(['engine_unreachable', 'provider_rate_limited', 'provider_unavailable', 'timeout']);

/**
 * Render a notice honestly: the server names the failure and decides whether retrying helps.
 * The UI adds a hint only for transient codes and never promises a retry will fix a setting.
 */
export function noticeView(body: NoticeBody): NoticeView {
  const tone = body.tone ?? 'info';
  const code = typeof body.code === 'string' && body.code ? body.code : null;
  const hint = tone === 'error' && code && body.retryable === true && RETRY_HELPS.has(code) ? 'Try again.' : null;
  return { tone, text: body.text, code, hint };
}
