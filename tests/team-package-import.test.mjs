import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSafeYaml, rejectPathTraversal, validateTeamPackage, TeamPackageParseError, DEFAULT_LIMITS } from '../server/src/lib/team-package-import.ts';

test('a plain map/list manifest parses correctly', () => {
  const yaml = `name: analyst-team\nversion: 2\nagents:\n  - role: analyst\n    model: sonnet\n  - role: reviewer\n`;
  const r = parseSafeYaml(yaml);
  assert.equal(r.name, 'analyst-team');
  assert.equal(r.version, 2);
  assert.equal(r.agents.length, 2);
  assert.equal(r.agents[0].role, 'analyst');
});

test('an oversized package is refused before any parsing work happens', () => {
  const big = 'name: x\n' + 'x'.repeat(300 * 1024);
  assert.throws(() => parseSafeYaml(big), (e) => e instanceof TeamPackageParseError && e.code === 'size_exceeded');
});

test('a YAML anchor/alias (billion-laughs vector) is refused outright, not approximated', () => {
  const bomb = `a: &x [1,2,3]\nb: *x\n`;
  assert.throws(() => parseSafeYaml(bomb), (e) => e instanceof TeamPackageParseError && e.code === 'yaml_feature_refused');
});

test('a merge key and a YAML tag are also refused', () => {
  assert.throws(() => parseSafeYaml('<<: foo\n'), (e) => e.code === 'yaml_feature_refused');
  assert.throws(() => parseSafeYaml('x: !!python/object:os.system\n'), (e) => e.code === 'yaml_feature_refused');
});

test('nesting deeper than the limit is rejected, not stack-overflowed', () => {
  let yaml = 'root:\n';
  for (let i = 0; i < 20; i++) yaml += '  '.repeat(i + 1) + `l${i}:\n`;
  assert.throws(() => parseSafeYaml(yaml, { ...DEFAULT_LIMITS, maxDepth: 5 }), (e) => e.code === 'depth_exceeded');
});

test('path traversal is rejected: absolute, parent-escape, drive letter, null byte', () => {
  assert.throws(() => rejectPathTraversal('/etc/passwd'), (e) => e.code === 'path_absolute');
  assert.throws(() => rejectPathTraversal('../../etc/passwd'), (e) => e.code === 'path_traversal');
  assert.throws(() => rejectPathTraversal('C:\\Windows\\System32'), (e) => e.code === 'path_absolute');
  assert.throws(() => rejectPathTraversal('a/b\0c'), (e) => e.code === 'path_nul');
  assert.doesNotThrow(() => rejectPathTraversal('agents/analyst.md'));
});

test('validateTeamPackage rejects the whole import if one file path escapes the sandbox', () => {
  assert.throws(() => validateTeamPackage('name: x\n', ['agents/a.md', '../../etc/passwd']));
  const ok = validateTeamPackage('name: x\n', ['agents/a.md', 'agents/b.md']);
  assert.equal(ok.safePaths.length, 2);
});
