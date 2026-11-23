// S-63 rework: claim.py must never destroy the shared clone's tracked work.
// The claim protocol runs in /root/UAP, where several workers keep tracked edits;
// a failed push previously ran `git reset --hard HEAD~1` and wiped them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const scratch = () => mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'uap-claim-'));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Raw bytes, untrimmed — for byte-identity assertions.
function gitRaw(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function ledger(items) {
  return JSON.stringify({ _protocol: 'test', meta: { build: 'v6' }, items }, null, 1);
}

// A bare origin plus a clone carrying claim.py, two pending items, and a tracked WIP file.
function fixture() {
  const dir = scratch();
  const origin = path.join(dir, 'origin.git');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');

  const work = path.join(dir, 'work');
  git(dir, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(work, 'scripts'), { recursive: true });
  cpSync(path.join(root, 'scripts', 'claim.py'), path.join(work, 'scripts', 'claim.py'));
  writeFileSync(
    path.join(work, 'build-ledger.json'),
    ledger([
      { id: 'T-01', desc: 'first task', status: 'pending' },
      { id: 'T-02', desc: 'second task', status: 'pending' },
    ]),
  );
  writeFileSync(path.join(work, 'WORKER-WIP.txt'), 'committed baseline\n');
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture');
  git(work, 'push', '-q', 'origin', 'main');
  return { dir, origin, work };
}

function hook(work, name, body) {
  const file = path.join(work, '.git', 'hooks', name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function runClaim(work, worker = 'worker-test') {
  const r = spawnSync('python3', [path.join(work, 'scripts', 'claim.py'), worker], {
    cwd: work,
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

test('push failure: exits 3, never prints CLAIM, and leaves origin ledger untouched', () => {
  const { work, origin } = fixture();
  hook(work, 'pre-push', 'echo "remote rejected" >&2\nexit 1');

  const r = runClaim(work);

  assert.equal(r.status, 3, `expected exit 3 for push-failed, got ${r.status}: ${r.out}`);
  assert.match(r.out, /^NOTHING push-failed/m);
  assert.doesNotMatch(r.out, /^CLAIM /m);

  const originLedger = JSON.parse(git(origin, 'show', 'main:build-ledger.json'));
  assert.deepEqual(
    originLedger.items.map(i => i.status),
    ['pending', 'pending'],
    'a claim that never reached origin must not appear anywhere',
  );
});

test('push failure: tracked uncommitted work in the shared clone survives', () => {
  const { work } = fixture();
  hook(work, 'pre-push', 'echo "remote rejected" >&2\nexit 1');
  // The exact state concurrent workers hold in /root/UAP: unsaved edits to a tracked file.
  writeFileSync(path.join(work, 'WORKER-WIP.txt'), 'WORKER-WIP-MARKER\n');

  const r = runClaim(work);

  assert.equal(r.status, 3, r.out);
  assert.equal(
    readFileSync(path.join(work, 'WORKER-WIP.txt'), 'utf8'),
    'WORKER-WIP-MARKER\n',
    'claim.py destroyed another worker\'s tracked edit',
  );
  assert.match(git(work, 'status', '--porcelain'), /^M WORKER-WIP\.txt$/m);
});

test('push failure: the claim commit is undone and the ledger restored to origin exactly', () => {
  const { work, origin } = fixture();
  const before = git(work, 'rev-parse', 'HEAD');
  hook(work, 'pre-push', 'exit 1');

  runClaim(work);

  assert.equal(git(work, 'rev-parse', 'HEAD'), before, 'claim commit must not stay at HEAD');
  assert.equal(
    readFileSync(path.join(work, 'build-ledger.json'), 'utf8'),
    gitRaw(origin, 'show', 'main:build-ledger.json').toString('utf8'),
    'local ledger must be byte-identical to origin after a failed claim',
  );
  assert.equal(git(work, 'status', '--porcelain'), '', 'no staged leftovers after rollback');
});

test('push failure before a commit exists (rejected pre-commit) keeps HEAD intact', () => {
  const { work } = fixture();
  const before = git(work, 'rev-parse', 'HEAD');
  hook(work, 'pre-commit', 'echo "hook says no" >&2\nexit 1');
  writeFileSync(path.join(work, 'WORKER-WIP.txt'), 'still here\n');

  const r = runClaim(work);

  assert.equal(r.status, 3, r.out);
  assert.equal(git(work, 'rev-parse', 'HEAD'), before, 'rollback must not drop an unrelated commit');
  assert.equal(readFileSync(path.join(work, 'WORKER-WIP.txt'), 'utf8'), 'still here\n');
});

test('success path: prints CLAIM once, pushes it, and leaves local WIP alone', () => {
  const { work, origin } = fixture();
  writeFileSync(path.join(work, 'WORKER-WIP.txt'), 'untouched\n');

  const r = runClaim(work, 'worker-test');

  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^CLAIM T-01 first task$/m);
  assert.equal(git(work, 'status', '--porcelain'), 'M WORKER-WIP.txt');
  const claimed = JSON.parse(git(origin, 'show', 'main:build-ledger.json')).items[0];
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimed_by, 'worker-test');
});

test('stale ledger: a pull that cannot fast-forward refuses with exit 0 and claims nothing', () => {
  const { dir, origin, work } = fixture();
  // Another worker advances origin; this clone diverges.
  const other = path.join(dir, 'other');
  git(dir, 'clone', '-q', origin, other);
  writeFileSync(path.join(other, 'WORKER-WIP.txt'), 'theirs\n');
  git(other, 'add', '-A');
  git(other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'other worker');
  git(other, 'push', '-q', 'origin', 'main');
  writeFileSync(path.join(work, 'WORKER-WIP.txt'), 'mine\n');
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'local diverge');

  const r = runClaim(work);

  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^NOTHING pull-failed/m);
  assert.doesNotMatch(r.out, /^CLAIM /m);
  assert.equal(
    JSON.parse(git(origin, 'show', 'main:build-ledger.json')).items[0].status,
    'pending',
  );
});

test('claim.py never hard-resets the tree', () => {
  const src = readFileSync(path.join(root, 'scripts', 'claim.py'), 'utf8');
  assert.doesNotMatch(src, /reset[^\n]*--hard/, 'a hard reset in the shared clone is destructive');
});
