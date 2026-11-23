/**
 * B-20 / V6-02-05: SHA-256 file manifest for a pinned source.
 *
 * The digest is computed over sorted `path\0sha256\0size\n` rows, so directory
 * listing order cannot change it and any file content, addition or removal does.
 * Paths are relative POSIX paths; absolute paths, traversal, backslashes and NUL
 * bytes are refused rather than normalized, because a manifest that "fixes" a
 * path is a manifest that can name a different file than the source did.
 */
import crypto from 'node:crypto';

export interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface SourceManifest {
  readonly entries: ManifestFile[];
  readonly digest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export type ManifestErrorCode = 'manifest_path_invalid' | 'manifest_digest_invalid' | 'manifest_duplicate_path';

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

function validatePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) throw new ManifestError('manifest_path_invalid', 'Manifest path is empty or oversized.');
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw new ManifestError('manifest_path_invalid', `Manifest path ${JSON.stringify(path)} is absolute or contains unsupported characters.`);
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ManifestError('manifest_path_invalid', `Manifest path ${JSON.stringify(path)} is not a normalized relative path.`);
  }
}

export function buildSourceManifest(files: readonly ManifestFile[]): SourceManifest {
  const seen = new Set<string>();
  const entries: ManifestFile[] = [];
  for (const file of files) {
    validatePath(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new ManifestError('manifest_digest_invalid', `Manifest file ${file.path} has an invalid SHA-256.`);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new ManifestError('manifest_digest_invalid', `Manifest file ${file.path} has an invalid size.`);
    if (seen.has(file.path)) throw new ManifestError('manifest_duplicate_path', `Manifest contains ${file.path} twice.`);
    seen.add(file.path);
    entries.push({ path: file.path, sha256: file.sha256, size: file.size });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = crypto.createHash('sha256');
  for (const entry of entries) digest.update(`${entry.path}\0${entry.sha256}\0${entry.size}\n`);
  return {
    entries,
    digest: digest.digest('hex'),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}
