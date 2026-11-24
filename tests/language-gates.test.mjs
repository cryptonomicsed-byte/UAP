import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSevenPacksComplete,
  listLanguageGatePacks,
  getLanguageGatePack,
  runLanguageGatePack,
  acceptPackClaim,
  LANGUAGE_GATE_PACKS,
} from '../server/src/lib/language-gates.ts';

test('K-36 seven language packs published and digests stable', () => {
  assertSevenPacksComplete();
  const packs = listLanguageGatePacks();
  assert.equal(packs.length, 7);
  const ids = packs.map((p) => p.id).sort();
  assert.deepEqual(ids, ['clojure', 'elixir', 'go', 'julia', 'move', 'python', 'rust']);
  for (const p of packs) {
    assert.equal(p.digest.length, 64);
    assert.ok(p.checks.length >= 2, p.id);
    assert.ok(p.version);
    // digest deterministic
    const again = getLanguageGatePack(p.id);
    assert.equal(again?.digest, p.digest);
  }
});

test('K-36 each pack has real tool binaries named (not empty claims)', () => {
  for (const p of listLanguageGatePacks()) {
    for (const c of p.checks) {
      assert.ok(c.binary, `${p.id}.${c.id} missing binary`);
      assert.ok(c.args.length >= 0);
      assert.ok(c.description);
    }
  }
  // Spot-check pinned tools match blueprint intent
  assert.ok(LANGUAGE_GATE_PACKS.rust.checks.some((c) => c.id.includes('clippy')));
  assert.ok(LANGUAGE_GATE_PACKS.elixir.checks.some((c) => c.binary === 'mix'));
  assert.ok(LANGUAGE_GATE_PACKS.python.checks.some((c) => c.binary === 'ruff' || c.binary === 'pytest'));
  assert.ok(LANGUAGE_GATE_PACKS.move.checks.some((c) => c.binary === 'sui'));
  assert.ok(LANGUAGE_GATE_PACKS.go.checks.some((c) => c.kind === 'race' || c.id.includes('race')));
  assert.ok(LANGUAGE_GATE_PACKS.clojure.checks.some((c) => c.binary === 'clojure'));
  assert.ok(LANGUAGE_GATE_PACKS.julia.checks.some((c) => c.binary === 'julia'));
});

test('K-36 dryRun never counts as pass', () => {
  const r = runLanguageGatePack('rust', { dryRun: true });
  assert.equal(r.pass, false);
  assert.ok(r.blockers.includes('dry_run_no_pass'));
  assert.ok(r.evidence.every((e) => e.status === 'not_run'));
});

test('K-36 claim without evidence rejected (V6-11-10)', () => {
  const bare = acceptPackClaim({ packId: 'rust', claimedPass: true });
  assert.equal(bare.accepted, false);
  assert.equal(bare.reason, 'claim_without_evidence');

  const noHash = acceptPackClaim({
    packId: 'rust',
    claimedPass: true,
    evidence: [{
      checkId: 'rust.test',
      status: 'pass',
      exitCode: 0,
      stdoutSha256: null,
      stderrSha256: null,
      durationMs: 1,
      binaryPresent: true,
    }],
  });
  assert.equal(noHash.accepted, false);

  const ok = acceptPackClaim({
    packId: 'rust',
    claimedPass: true,
    evidence: [{
      checkId: 'rust.test',
      status: 'pass',
      exitCode: 0,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64),
      durationMs: 10,
      binaryPresent: true,
    }],
  });
  assert.equal(ok.accepted, true);
});

test('K-36 allowSkipMissingTools produces skip not claim-pass', () => {
  // Use a pack whose primary binaries may be missing in this environment
  const r = runLanguageGatePack('move', { allowSkipMissingTools: true });
  assert.equal(r.pass, false); // skipped-only is not a pass
  assert.ok(r.evidence.length >= 1);
  // If sui missing, all skip → no_required_checks_executed
  if (r.evidence.every((e) => e.status === 'skip')) {
    assert.ok(r.blockers.includes('no_required_checks_executed'));
  }
});

test('K-36 getLanguageGatePack version pin', () => {
  assert.ok(getLanguageGatePack('python', '1.0.0'));
  assert.equal(getLanguageGatePack('python', '9.9.9'), null);
});
