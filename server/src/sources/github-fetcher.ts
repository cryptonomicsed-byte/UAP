/**
 * B-20: GitHub implementation of the ingestion fetcher.
 *
 * The pipeline only needs four observations, so this adapter stays narrow: probe
 * repository access, resolve the default branch to a commit, list the pinned
 * tree with SHA-256 per blob, and read the licence file. It never executes source
 * content and never writes anything. A token is optional; without one GitHub's
 * rate limits and private-repository answers are recorded as-is.
 */
import crypto from 'node:crypto';
import type { RepositoryProbe } from './access.js';
import type { ManifestFile } from './manifest.js';
import type { SourceFetcher } from './ingest.js';

export interface GitHubFetcherOptions {
  readonly token?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly apiBase?: string;
  readonly concurrency?: number;
  readonly maxFileBytes?: number;
}

interface TreeEntry { path?: string; type?: string; size?: number }

const LICENSE_CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md'];

export function createGitHubFetcher(options: GitHubFetcherOptions = {}): SourceFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 16));
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'uap-source-registry/1.0',
    'x-github-api-version': '2022-11-28',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const request = async (url: string): Promise<Response> => fetchImpl(url, { headers, redirect: 'manual' });

  return {
    async probe(owner, repo): Promise<RepositoryProbe> {
      const response = await request(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? Number.NaN);
      if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
        return { status: response.status, redirectUrl: response.headers.get('location') ?? undefined };
      }
      const body = response.ok ? await response.json() as Record<string, unknown> : null;
      return {
        status: response.status,
        archived: body?.archived === true,
        defaultBranch: typeof body?.default_branch === 'string' ? body.default_branch : undefined,
        licenseSpdx: typeof (body?.license as Record<string, unknown> | undefined)?.spdx_id === 'string'
          ? (body?.license as Record<string, string>).spdx_id
          : null,
        forkOf: body?.fork === true && typeof (body?.parent as Record<string, unknown> | undefined)?.full_name === 'string'
          ? String((body?.parent as Record<string, unknown>).full_name)
          : null,
        mirrorOf: typeof body?.mirror_url === 'string' ? body.mirror_url : null,
        rateLimitRemaining: Number.isFinite(remaining) ? remaining : undefined,
      };
    },

    async resolveCommit(owner, repo, ref): Promise<string | null> {
      const response = await request(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`);
      if (!response.ok) return null;
      const body = await response.json() as { sha?: unknown };
      return typeof body.sha === 'string' ? body.sha : null;
    },

    async listFiles(owner, repo, commit): Promise<readonly ManifestFile[]> {
      const treeResponse = await request(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(commit)}?recursive=1`);
      if (!treeResponse.ok) throw new Error(`GitHub tree request failed with ${treeResponse.status}.`);
      const tree = await treeResponse.json() as { tree?: TreeEntry[]; truncated?: boolean };
      if (tree.truncated === true) {
        // A truncated tree proves nothing about the files it omits.
        throw new Error('GitHub returned a truncated tree; the manifest would be incomplete.');
      }
      const blobs = (tree.tree ?? []).filter((entry): entry is Required<TreeEntry> =>
        entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.size === 'number');
      const files: ManifestFile[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < blobs.length) {
          const entry = blobs[cursor++];
          if (entry.size > maxFileBytes) throw new Error(`File ${entry.path} exceeds the ${maxFileBytes}-byte manifest limit; split the source or raise the limit explicitly.`);
          const raw = await request(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commit)}/${entry.path.split('/').map(encodeURIComponent).join('/')}`);
          if (!raw.ok) throw new Error(`Raw file request for ${entry.path} failed with ${raw.status}.`);
          const bytes = Buffer.from(await raw.arrayBuffer());
          files.push({ path: entry.path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, blobs.length || 1) }, worker));
      return files;
    },

    async readLicenseFile(owner, repo, commit): Promise<string | null> {
      for (const candidate of LICENSE_CANDIDATES) {
        const raw = await request(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commit)}/${candidate}`);
        if (raw.ok) return raw.text();
      }
      return null;
    },
  };
}
