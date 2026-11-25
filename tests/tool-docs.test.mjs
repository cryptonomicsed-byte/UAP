import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_SECRET ??= 'tool-docs-test-secret';
const { generateToolDocs, renderToolDocsMarkdown } = await import('../server/src/lib/tool-docs.ts');

test('every registered tool gets a doc entry with a real effect/risk from the kernel classifier', () => {
  const docs = generateToolDocs();
  assert.ok(docs.length > 0);
  for (const d of docs) {
    assert.ok(d.name.length > 0);
    assert.ok(['read', 'compute', 'write', 'external_message', 'money', 'publish', 'production_change', 'security_testing', 'clinical_data'].includes(d.effect));
    assert.ok(['low', 'medium', 'high', 'critical'].includes(d.risk));
    assert.ok(Array.isArray(d.errorFamilies) && d.errorFamilies.length > 0);
  }
});

test('a known risky tool is flagged for approval by default; a known read tool is not', () => {
  const docs = generateToolDocs();
  const saveFile = docs.find((d) => d.name === 'save_file');
  if (saveFile) assert.equal(saveFile.requiresApprovalByDefault, true);
  const listRoutines = docs.find((d) => d.name === 'list_routines');
  if (listRoutines) {
    assert.equal(listRoutines.requiresApprovalByDefault, false);
    assert.equal(listRoutines.idempotent, true);
  }
});

test('a write-effect tool is never marked idempotent by default', () => {
  const docs = generateToolDocs();
  for (const d of docs) {
    if (d.effect === 'write' || d.effect === 'money' || d.effect === 'external_message') {
      assert.equal(d.idempotent, false, `${d.name} has effect ${d.effect} but was marked idempotent`);
    }
  }
});

test('markdown render includes every tool name and its error families', () => {
  const docs = generateToolDocs();
  const md = renderToolDocsMarkdown(docs);
  for (const d of docs.slice(0, 5)) {
    assert.match(md, new RegExp(`\`${d.name}\``));
  }
  assert.match(md, /Error families:/);
});
