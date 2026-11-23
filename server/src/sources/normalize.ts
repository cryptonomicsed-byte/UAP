/**
 * B-20 / V6-02-02: URLs are normalized for identity, never rewritten for display.
 *
 * The canonical slug (lower-case owner/repo) is what the registry keys on, so a
 * link supplied as `Acme/Skills` and one supplied as `acme/skills` are the same
 * source. The authored casing is retained separately because GitHub resolves
 * repositories case-insensitively but its displayed name is what a reviewer saw.
 * Redirect targets replace the canonical identity while the original URL stays
 * as provenance. Anything that is not a repository root is refused: this layer
 * does not guess that a file or issue URL means the repository behind it.
 */

export type SourceProvider = 'github' | 'unknown';

export interface NormalizedSource {
  readonly provider: SourceProvider;
  readonly canonicalUrl: string;
  readonly originalUrl: string;
  readonly owner: string;
  readonly repo: string;
  readonly ownerDisplay: string;
  readonly repoDisplay: string;
  readonly canonicalSlug: string;
}

export type SourceUrlErrorCode = 'unsupported_url' | 'invalid_url';

export class SourceUrlError extends Error {
  readonly code: SourceUrlErrorCode;
  constructor(code: SourceUrlErrorCode, message: string) {
    super(message);
    this.name = 'SourceUrlError';
    this.code = code;
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function normalizeSourceUrl(input: string): NormalizedSource {
  if (typeof input !== 'string' || input.length === 0 || input.length > 500 || input !== input.trim() || input.includes('\0')) {
    throw new SourceUrlError('invalid_url', 'Source URL must be a non-empty, trimmed string without NUL bytes.');
  }
  let url: URL;
  try { url = new URL(input); }
  catch { throw new SourceUrlError('invalid_url', 'Source URL is not a valid URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourceUrlError('unsupported_url', 'Only http(s) source URLs are accepted.');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') {
    throw new SourceUrlError('unsupported_url', 'Only GitHub repository URLs are accepted by the current registry.');
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const isTreeView = segments.length >= 3 && segments[2] === 'tree';
  if (segments.length < 2 || (segments.length > 2 && !isTreeView)) {
    throw new SourceUrlError('unsupported_url', 'Source URL must point at a GitHub repository root (a /tree/<ref> browse URL is also accepted).');
  }
  const [ownerSegment, repoSegment] = segments;
  const repoName = repoSegment.replace(/\.git$/i, '');
  if (!OWNER.test(ownerSegment) || !REPO.test(repoName) || repoName === '.' || repoName === '..' || repoName.includes('..')) {
    throw new SourceUrlError('unsupported_url', 'Owner and repository segments must be plain GitHub names.');
  }
  return {
    provider: 'github',
    canonicalUrl: `https://github.com/${ownerSegment}/${repoName}`,
    originalUrl: input,
    owner: ownerSegment.toLowerCase(),
    repo: repoName.toLowerCase(),
    ownerDisplay: ownerSegment,
    repoDisplay: repoName,
    canonicalSlug: `${ownerSegment.toLowerCase()}/${repoName.toLowerCase()}`,
  };
}

/** A verified redirect replaces the canonical identity; the supplied URL stays quoted. */
export function applySourceRedirect(source: NormalizedSource, redirectUrl: string): NormalizedSource {
  const target = normalizeSourceUrl(redirectUrl);
  return { ...target, originalUrl: source.originalUrl };
}
