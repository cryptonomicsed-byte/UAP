// Markdown persona parser (V6-03-02). Persona repositories are prose plus
// frontmatter. Parsing them yields role fields for review; it never yields
// authority. Tool names a persona asks for become requests, and any field that
// tries to speak about permissions is recorded as ignored so the attempt is
// visible instead of silently effective.
//
// Written before server/src/roles/persona-parser.ts existed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  PersonaError,
  composeInstructions,
  parsePersonaFile,
  parsePersonaRepository,
} from '../server/src/roles/persona-parser.ts';
import { buildRoleTemplate, verifyRoleTemplate } from '../server/src/roles/role-template.ts';

const FRONTMATTER = `---
name: Backend Engineer
description: Designs and reviews backend services.
tools: Read, Grep
---
`;

const codeOf = fn => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PersonaError, `expected PersonaError, got ${err?.name}`);
    return err.code;
  }
  assert.fail('expected a PersonaError');
};

test('frontmatter fields become role fields and the body is preserved byte-exact', () => {
  const body = 'You design, build and review backend services.\n\n- Prefer boring technology.\n';
  const content = FRONTMATTER + body;
  const doc = parsePersonaFile({ path: 'engineering/backend-engineer.md', content });
  assert.equal(doc.title, 'Backend Engineer');
  assert.equal(doc.description, 'Designs and reviews backend services.');
  assert.equal(doc.body, body);
  assert.equal(doc.canonicalMarkdown, content, 'the source bytes are kept for provenance');
  assert.deepEqual(doc.requestedTools, ['grep', 'read']);
  assert.deepEqual(doc.unparsedToolDeclarations, []);
  assert.deepEqual(doc.ignoredAuthorityFields, []);
});

test('an H1 is a valid title; a document with no title at all is refused', () => {
  const doc = parsePersonaFile({ path: 'a.md', content: '# Security Reviewer\n\nReview code.\n' });
  assert.equal(doc.title, 'Security Reviewer');
  assert.equal(codeOf(() => parsePersonaFile({ path: 'b.md', content: 'Just prose.\n' })), 'title_missing');
  assert.equal(codeOf(() => parsePersonaFile({ path: 'c.md', content: '   \n\n' })), 'content_empty');
});

test('tool declarations are requests, never grants, and authority fields are ignored', () => {
  const content = `---
name: Auditor
allowed-tools: Read, Bash(git:*), "search the web freely"
permissions: [admin, deploy]
grants: ["*"]
capabilities: ["billing:write"]
---
Audit everything.
`;
  const doc = parsePersonaFile({ path: 'audit.md', content });
  assert.deepEqual(doc.requestedTools, ['bash', 'read']);
  assert.deepEqual(doc.unparsedToolDeclarations, ['search the web freely']);
  assert.deepEqual(doc.ignoredAuthorityFields, ['capabilities', 'grants', 'permissions']);
  for (const forbidden of ['grants', 'permissions', 'capabilities', 'grantedTools', 'authorization']) {
    assert.equal(forbidden in doc, false, `${forbidden} must not exist on a parsed persona`);
  }
});

test('repository parsing is deterministic and path-safe', () => {
  const files = [
    { path: 'b.md', content: FRONTMATTER + 'Second.\n' },
    { path: 'a.md', content: FRONTMATTER + 'First.\n' },
  ];
  const repo = parsePersonaRepository(files);
  assert.deepEqual(repo.documents.map(d => d.path), ['a.md', 'b.md']);
  assert.match(repo.digest, /^[a-f0-9]{64}$/);
  assert.equal(parsePersonaRepository([...files].reverse()).digest, repo.digest);
  assert.equal(
    repo.digest,
    createHash('sha256')
      .update(`a.md\0${files[1].content}\0b.md\0${files[0].content}\0`)
      .digest('hex'),
  );

  assert.equal(codeOf(() => parsePersonaRepository([files[0], files[0]])), 'duplicate_path');
  assert.equal(codeOf(() => parsePersonaRepository([{ path: '../evil.md', content: '# X\n' }])), 'path_invalid');
  assert.equal(codeOf(() => parsePersonaRepository([{ path: '/abs.md', content: '# X\n' }])), 'path_invalid');
  assert.equal(codeOf(() => parsePersonaRepository([{ path: 'notes.txt', content: '# X\n' }])), 'path_invalid');
  assert.equal(codeOf(() => parsePersonaFile({ path: 'nul.md', content: '# X\0\n' })), 'content_invalid');
  assert.equal(
    codeOf(() => parsePersonaFile({ path: 'big.md', content: '# X\n' + 'a'.repeat(1024 * 1024 + 1) })),
    'file_too_large',
  );
  assert.equal(
    codeOf(() => parsePersonaFile({ path: 'bad.md', content: '---\nname: [unclosed\n---\nBody\n' })),
    'frontmatter_invalid',
  );
});

test('composed instructions follow path order and a one-byte edit changes the digest', () => {
  const files = [
    { path: 'z.md', content: '# Zeta\n\nLast.\n' },
    { path: 'a.md', content: '# Alpha\n\nFirst.\n' },
  ];
  const repo = parsePersonaRepository(files);
  assert.equal(composeInstructions(repo.documents), '# Alpha\n\nFirst.\n\n# Zeta\n\nLast.\n');

  const edited = parsePersonaRepository([
    files[0],
    { path: 'a.md', content: '# Alpha\n\nFirst!\n' },
  ]);
  assert.notEqual(edited.digest, repo.digest);
});

test('a parsed persona feeds the role-template schema and round-trips its digest', () => {
  const repo = parsePersonaRepository([
    { path: 'engineering/backend-engineer.md', content: FRONTMATTER + 'Design services.\n' },
  ]);
  const first = repo.documents[0];
  const template = buildRoleTemplate({
    slug: 'backend-engineer',
    publisher: 'msitarzewski/agency-agents',
    version: 1,
    sourceSha: 'c'.repeat(40),
    sourcePath: first.path,
    title: first.title,
    riskClass: 'medium',
    rights: {
      license: 'MIT',
      sourceUrl: 'https://github.com/msitarzewski/agency-agents',
      attribution: 'msitarzewski/agency-agents contributors',
    },
    instructions: composeInstructions(repo.documents),
    requestedTools: first.requestedTools,
  });
  assert.equal(verifyRoleTemplate(template), template.digest);
  assert.deepEqual(template.requestedTools, ['grep', 'read']);
});
