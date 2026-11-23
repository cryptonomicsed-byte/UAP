/**
 * B-20 / V6-02-05: pin a source to an immutable commit.
 *
 * A branch name is a moving reference, so resolving it to a commit is the only
 * acceptable way to record a source. Publishing, installing or citing a source
 * calls `assertPublishablePin`, which refuses anything that is not a full commit
 * SHA — there is no "publish main" path to accidentally leave open.
 */

export type SourcePinErrorCode = 'invalid_commit' | 'unresolved_ref' | 'mutable_branch_reference';

export class SourcePinError extends Error {
  readonly code: SourcePinErrorCode;
  constructor(code: SourcePinErrorCode, message: string) {
    super(message);
    this.name = 'SourcePinError';
    this.code = code;
  }
}

export interface PinnedSource {
  readonly pinnedCommit: string;
  readonly pinKind: 'commit';
  readonly resolvedRef: string;
}

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value);
}

export async function pinSource(input: {
  owner: string;
  repo: string;
  defaultBranch: string;
  resolveCommit: (ref: string) => Promise<string | null>;
}): Promise<PinnedSource> {
  if (!input.defaultBranch || input.defaultBranch.length > 255 || /[\0\s]/.test(input.defaultBranch)) {
    throw new SourcePinError('mutable_branch_reference', 'A source must have a concrete default branch before it can be pinned.');
  }
  const commit = await input.resolveCommit(input.defaultBranch);
  if (!commit) throw new SourcePinError('unresolved_ref', `Could not resolve ${input.defaultBranch} to a commit.`);
  if (!isCommitSha(commit)) throw new SourcePinError('invalid_commit', 'Resolved commit is not a full lower-case SHA.');
  return { pinnedCommit: commit, pinKind: 'commit', resolvedRef: input.defaultBranch };
}

export function assertPublishablePin(pin: { pinnedCommit: string | null; pinKind: string }): void {
  if (pin.pinKind === 'branch') throw new SourcePinError('mutable_branch_reference', 'A mutable branch reference cannot be published.');
  if (!isCommitSha(pin.pinnedCommit)) throw new SourcePinError('invalid_commit', 'A source must be pinned to a full commit SHA before publication.');
}
