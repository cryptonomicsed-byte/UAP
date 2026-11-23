// B-20 (V6-02-01..06, V6-02-10, V6-02-11): source registry + ingestion pipeline.
// The candidate corpus is imported as unverified metadata. Nothing here installs,
// executes or promotes a source: trust stays USER_SUPPLIED_UNVERIFIED and only an
// independent reviewer signature can move it (B-22 owns that transition).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

const { parseCandidateCsv, SourceCandidateError } = await import('../server/src/sources/candidates.ts');
const { normalizeSourceUrl, applySourceRedirect, SourceUrlError } = await import('../server/src/sources/normalize.ts');
const { classifySource } = await import('../server/src/sources/classify.ts');
const { inspectSourceAccess } = await import('../server/src/sources/access.ts');
const { pinSource, assertPublishablePin, isCommitSha, SourcePinError } = await import('../server/src/sources/pin.ts');
const { buildSourceManifest, ManifestError } = await import('../server/src/sources/manifest.ts');
const { inspectLicense } = await import('../server/src/sources/license.ts');
const { filterCatalogForTenant } = await import('../server/src/sources/tenant-policy.ts');
const { ingestCandidates, requireAuditableSource, catalogView, SourceNotAuditableError } = await import('../server/src/sources/ingest.ts');
const { toRegistryRow, RegistryRowError } = await import('../server/src/storage/postgres/source-registry.ts');
const { SOURCE_REGISTRY_MIGRATION } = await import('../server/src/storage/postgres/source-registry-schema.ts');
const { POSTGRES_MIGRATIONS } = await import('../server/src/storage/postgres/schema.ts');
const { validatePostgresMigrationSql } = await import('../server/src/storage/postgres/sql-validation.ts');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hex40 = 'a'.repeat(40);
const manifestFile = (p, text) => ({ path: p, sha256: sha256(text), size: Buffer.byteLength(text) });

const codeOf = (fn) => {
  try { fn(); } catch (err) { return err.code ?? err.name; }
  return 'no-error';
};

// ---------- candidate CSV ----------

test('the user-supplied candidate CSV imports every link with its original name and URL', () => {
  const csv = readFileSync(path.join(root, 'docs/v6-blueprint/universal_agent_platform_v6_candidate_sources.csv'), 'utf8');
  const candidates = parseCandidateCsv(csv);
  assert.equal(candidates.length, 103);
  for (const candidate of candidates) {
    assert.match(candidate.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    assert.ok(candidate.repository.includes('/'), 'repository keeps owner/repo');
    assert.ok(candidate.group.length > 0);
    assert.ok(candidate.proposedUse.length > 0);
    assert.match(candidate.status, /USER_SUPPLIED/);
  }
  const normalized = candidates.map((candidate) => normalizeSourceUrl(candidate.url));
  assert.equal(new Set(normalized.map((source) => source.canonicalSlug)).size, candidates.length);
});

test('malformed candidate rows are refused instead of guessed', () => {
  assert.equal(codeOf(() => parseCandidateCsv('url,repository\nhttps://github.com/a/b,a/b\n')), 'invalid_candidate_header');
  assert.equal(codeOf(() => parseCandidateCsv('group,repository,url,proposed_use,status\nG,a/b,,use,USER_SUPPLIED\n')), 'invalid_candidate_row');
  assert.equal(codeOf(() => parseCandidateCsv('group,repository,url,proposed_use,status\nG,a/b,not-a-url,use,USER_SUPPLIED\n')), 'invalid_candidate_row');
  const header = 'group,repository,url,proposed_use,status\n';
  const row = 'G,a/b,https://github.com/a/b,use,USER_SUPPLIED\n';
  assert.equal(codeOf(() => parseCandidateCsv(header + row + row)), 'duplicate_candidate');
  assert.throws(() => parseCandidateCsv(header + row + row), SourceCandidateError);
});

// ---------- normalization ----------

test('GitHub URLs normalize to a lowercase canonical slug while keeping authored casing', () => {
  const source = normalizeSourceUrl('http://www.GitHub.com/Acme/Skills.git/');
  assert.equal(source.provider, 'github');
  assert.equal(source.canonicalUrl, 'https://github.com/Acme/Skills');
  assert.equal(source.canonicalSlug, 'acme/skills');
  assert.equal(source.owner, 'acme');
  assert.equal(source.repo, 'skills');
  assert.equal(source.ownerDisplay, 'Acme');
  assert.equal(source.repoDisplay, 'Skills');
  assert.equal(source.originalUrl, 'http://www.GitHub.com/Acme/Skills.git/');

  const tree = normalizeSourceUrl('https://github.com/Acme/Skills/tree/main/skills/review');
  assert.equal(tree.canonicalUrl, 'https://github.com/Acme/Skills');
  assert.equal(normalizeSourceUrl('https://github.com/Acme/Skills?tab=readme').canonicalSlug, 'acme/skills');
});

test('URLs that are not repository roots are refused rather than mangled', () => {
  for (const bad of [
    'https://github.com/acme',
    'https://github.com/acme/skills/issues/4',
    'https://github.com/acme/skills/blob/main/README.md',
    'https://example.test/acme/skills',
    'file:///etc/passwd',
    'https://github.com/../etc',
  ]) {
    assert.equal(codeOf(() => normalizeSourceUrl(bad)), 'unsupported_url', bad);
  }
  assert.equal(codeOf(() => normalizeSourceUrl(' https://github.com/acme/skills')), 'invalid_url');
  assert.throws(() => normalizeSourceUrl('https://github.com/acme'), SourceUrlError);
});

test('a redirect target becomes the canonical source and the original URL stays as provenance', () => {
  const source = normalizeSourceUrl('https://github.com/old-owner/old-repo');
  const moved = applySourceRedirect(source, 'https://github.com/new-owner/new-repo');
  assert.equal(moved.canonicalSlug, 'new-owner/new-repo');
  assert.equal(moved.canonicalUrl, 'https://github.com/new-owner/new-repo');
  assert.equal(moved.originalUrl, 'https://github.com/old-owner/old-repo');
  assert.equal(codeOf(() => applySourceRedirect(source, 'https://example.test/x/y')), 'unsupported_url');
});

// ---------- classification ----------

test('source kind is identified from manifests and names with explicit evidence', () => {
  const skill = classifySource({ repository: 'acme/prompts', filePaths: ['SKILL.md', 'README.md'] });
  assert.equal(skill.kind, 'agent-skill');
  assert.ok(skill.evidence.includes('file:SKILL.md'));

  const meta = classifySource({ repository: 'acme/awesome-agent-skills', filePaths: ['README.md'] });
  assert.equal(meta.kind, 'meta-list');
  assert.ok(meta.evidence.some((entry) => entry.startsWith('name:')));

  const dataset = classifySource({ repository: 'acme/role-data', filePaths: ['data/personas.jsonl', 'README.md'] });
  assert.equal(dataset.kind, 'dataset');
  assert.ok(dataset.evidence.includes('file:data/personas.jsonl'));

  const software = classifySource({ repository: 'acme/engine', filePaths: ['Cargo.toml', 'src/lib.rs'] });
  assert.equal(software.kind, 'standalone-software');
  assert.ok(software.evidence.includes('file:Cargo.toml'));

  const docs = classifySource({ repository: 'acme/launch-checklist', proposedUse: 'launch readiness checklist standards', filePaths: ['README.md'] });
  assert.equal(docs.kind, 'documentation');

  const unknown = classifySource({ repository: 'acme/thing', filePaths: ['README.md'] });
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.confidence, 'low');
  assert.deepEqual(unknown.evidence, ['no recognized manifest, catalog or dataset marker']);
});

// ---------- access ----------

test('repository access reports 404, private/auth failures, rate limits and redirects honestly', async () => {
  const client = (probe) => ({ probe: async () => probe });
  const source = normalizeSourceUrl('https://github.com/acme/skills');

  const ok = await inspectSourceAccess(client({ status: 200, defaultBranch: 'main', archived: false }), source);
  assert.deepEqual(ok.status, 'ok');
  assert.equal(ok.defaultBranch, 'main');

  const missing = await inspectSourceAccess(client({ status: 404 }), source);
  assert.equal(missing.status, 'not-found');
  assert.equal(missing.detail, 'not_found_or_private_without_credentials');

  const auth = await inspectSourceAccess(client({ status: 401 }), source);
  assert.equal(auth.status, 'auth-required');

  const limited = await inspectSourceAccess(client({ status: 403, rateLimitRemaining: 0 }), source);
  assert.equal(limited.status, 'rate-limited');

  const forbidden = await inspectSourceAccess(client({ status: 403 }), source);
  assert.equal(forbidden.status, 'forbidden');

  const moved = await inspectSourceAccess(client({ status: 301, redirectUrl: 'https://github.com/acme/skills-v2' }), source);
  assert.equal(moved.status, 'moved');
  assert.equal(moved.redirectUrl, 'https://github.com/acme/skills-v2');

  const failed = await inspectSourceAccess({ probe: async () => { throw new Error('socket hang up'); } }, source);
  assert.equal(failed.status, 'network-error');
  assert.equal(failed.detail, 'request_failed');

  const archived = await inspectSourceAccess(client({ status: 200, archived: true, defaultBranch: 'main' }), source);
  assert.equal(archived.archived, true);
});

// ---------- pinning ----------

test('branch heads resolve to a commit and branch-only references cannot be published', async () => {
  const pinned = await pinSource({ owner: 'acme', repo: 'skills', defaultBranch: 'main', resolveCommit: async (ref) => (ref === 'main' ? hex40 : null) });
  assert.equal(pinned.pinnedCommit, hex40);
  assert.equal(pinned.pinKind, 'commit');
  assert.doesNotThrow(() => assertPublishablePin(pinned));

  assert.equal(codeOf(() => assertPublishablePin({ pinnedCommit: null, pinKind: 'branch' })), 'mutable_branch_reference');
  assert.equal(codeOf(() => assertPublishablePin({ pinnedCommit: 'main', pinKind: 'commit' })), 'invalid_commit');
  assert.equal(codeOf(() => assertPublishablePin({ pinnedCommit: hex40.slice(0, 12), pinKind: 'commit' })), 'invalid_commit');
  assert.equal(isCommitSha(hex40), true);
  assert.equal(isCommitSha('a'.repeat(64)), true);
  assert.equal(isCommitSha('MAIN'), false);

  await assert.rejects(
    pinSource({ owner: 'acme', repo: 'skills', defaultBranch: 'main', resolveCommit: async () => null }),
    (err) => err instanceof SourcePinError && err.code === 'unresolved_ref',
  );
});

// ---------- manifest ----------

test('the SHA-256 manifest is order-independent and covers every file', () => {
  const files = [manifestFile('b.txt', 'b'), manifestFile('a.txt', 'a'), manifestFile('dir/c.txt', 'c')];
  const first = buildSourceManifest(files);
  const second = buildSourceManifest([...files].reverse());
  assert.equal(first.digest, second.digest);
  assert.equal(first.fileCount, 3);
  assert.equal(first.totalBytes, 3);
  assert.deepEqual(first.entries.map((entry) => entry.path), ['a.txt', 'b.txt', 'dir/c.txt']);
  assert.match(first.digest, /^[a-f0-9]{64}$/);

  const changed = buildSourceManifest([manifestFile('a.txt', 'changed')]);
  assert.notEqual(first.digest, changed.digest);
});

test('unsafe or duplicate manifest paths are refused', () => {
  const good = manifestFile('a.txt', 'a');
  for (const badPath of ['/etc/passwd', '../escape', 'a/../../b', 'a\\b', 'a\0b', '']) {
    assert.equal(codeOf(() => buildSourceManifest([{ ...good, path: badPath }])), 'manifest_path_invalid', badPath);
  }
  assert.equal(codeOf(() => buildSourceManifest([good, good])), 'manifest_duplicate_path');
  assert.equal(codeOf(() => buildSourceManifest([{ ...good, sha256: 'abc' }])), 'manifest_digest_invalid');
  assert.equal(codeOf(() => buildSourceManifest([{ ...good, size: -1 }])), 'manifest_digest_invalid');
  assert.throws(() => buildSourceManifest([good, good]), ManifestError);
});

// ---------- license ----------

test('license inspection reads declared text, records notices and never claims approval', () => {
  const mit = inspectLicense({ licenseFile: 'LICENSE', licenseText: 'MIT License\n\nPermission is hereby granted, free of charge...', noticeTexts: [] });
  assert.equal(mit.spdx, 'MIT');
  assert.equal(mit.licenseSource, 'license-file');
  assert.equal(mit.commercialUse, 'allowed');
  assert.equal(mit.approval, 'not-reviewed');

  const agpl = inspectLicense({ licenseFile: 'LICENSE', licenseText: 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3', noticeTexts: [{ path: 'NOTICE', text: 'Built on upstream work.' }] });
  assert.equal(agpl.spdx, 'AGPL-3.0');
  assert.equal(agpl.commercialUse, 'restricted');
  assert.deepEqual(agpl.obligations, ['network-copyleft', 'source-disclosure']);
  assert.deepEqual(agpl.notices, ['NOTICE']);

  const api = inspectLicense({ apiSpdx: 'Apache-2.0', noticeTexts: [] });
  assert.equal(api.spdx, 'Apache-2.0');
  assert.equal(api.licenseSource, 'api');
  assert.equal(api.commercialUse, 'allowed');
  assert.deepEqual(api.obligations, ['notice-retention', 'patent-grant']);

  const missing = inspectLicense({ noticeTexts: [] });
  assert.equal(missing.spdx, null);
  assert.equal(missing.licenseSource, 'none');
  assert.equal(missing.commercialUse, 'unknown');
});

// ---------- tenant policy ----------

test('catalog filtering applies domain, tool and risk policy with explicit hide reasons', () => {
  const entries = [
    { sourceId: 'src_a', domains: ['design'], supportedTools: ['read'], riskClass: 'low' },
    { sourceId: 'src_b', domains: ['web3'], supportedTools: ['read', 'wallet'], riskClass: 'high' },
    { sourceId: 'src_c', domains: ['design'], supportedTools: ['read'], riskClass: 'unclassified' },
    { sourceId: 'src_d', domains: [], supportedTools: ['read'], riskClass: 'low' },
  ];
  const result = filterCatalogForTenant(entries, { domains: ['design'], supportedTools: ['read'], maxRisk: 'medium' });
  assert.deepEqual(result.visible.map((entry) => entry.sourceId), ['src_a']);
  assert.deepEqual(result.hidden, [
    { sourceId: 'src_b', reason: 'risk_exceeds_policy' },
    { sourceId: 'src_c', reason: 'risk_unclassified' },
    { sourceId: 'src_d', reason: 'no_domain_match' },
  ]);
  assert.equal(filterCatalogForTenant(entries, { domains: [], supportedTools: ['read'], maxRisk: 'medium' }).visible.length, 0);
});

// ---------- ingestion ----------

const okFetcher = (over = {}) => ({
  probe: async () => ({ status: 200, archived: false, defaultBranch: 'main' }),
  resolveCommit: async () => hex40,
  listFiles: async () => [manifestFile('SKILL.md', '# Role\n'), manifestFile('README.md', 'readme')],
  readLicenseFile: async () => 'MIT License\n\nPermission is hereby granted, free of charge...',
  ...over,
});

const candidate = (over = {}) => ({
  group: 'Identity & general workforce',
  repository: 'Acme/Skills',
  url: 'https://github.com/Acme/Skills',
  proposedUse: 'role templates',
  status: 'USER_SUPPLIED / REQUIRES SOURCE+LICENSE AUDIT',
  ...over,
});

test('ingestion records an unverified, pinned, licensed candidate and refuses to install it', async () => {
  const report = await ingestCandidates([candidate()], { fetcher: okFetcher(), now: () => 1000 });
  assert.equal(report.records.length, 1);
  assert.equal(report.unavailable.length, 0);
  const record = report.records[0];
  assert.equal(record.originalName, 'Acme/Skills');
  assert.equal(record.originalUrl, 'https://github.com/Acme/Skills');
  assert.equal(record.canonicalSlug, 'acme/skills');
  assert.equal(record.access.status, 'ok');
  assert.equal(record.pinnedCommit, hex40);
  assert.match(record.manifest.digest, /^[a-f0-9]{64}$/);
  assert.equal(record.classification.kind, 'agent-skill');
  assert.equal(record.license.spdx, 'MIT');
  assert.equal(record.trustStatus, 'USER_SUPPLIED_UNVERIFIED');
  assert.equal(record.reviewerSignature, null);
  assert.equal(record.availability, 'available');
  // V6-02-11: nothing role-shaped is synthesized for an unaudited source.
  assert.equal('roleTemplate' in record, false);
  assert.equal('instructions' in record, false);
  assert.equal('requestedTools' in record, false);

  const view = catalogView(record);
  assert.equal(view.installable, false);
  assert.equal(view.reason, 'trust_not_promoted');
  assert.equal(codeOf(() => requireAuditableSource(record)), 'source_not_auditable');
  assert.throws(() => requireAuditableSource(record), SourceNotAuditableError);
});

test('access failures are recorded as unavailable with the honest reason and no invented pin', async () => {
  const cases = [
    [{ probe: async () => ({ status: 404 }) }, 'not-found', 'not_found_or_private'],
    [{ probe: async () => ({ status: 401 }) }, 'auth-required', 'auth_required'],
    [{ probe: async () => ({ status: 403, rateLimitRemaining: 0 }) }, 'rate-limited', 'rate_limited'],
    [{ probe: async () => ({ status: 301, redirectUrl: 'https://github.com/acme/moved' }) }, 'moved', 'relocated'],
    [{ probe: async () => { throw new Error('boom'); } }, 'network-error', 'network_error'],
  ];
  for (const [override, status, reason] of cases) {
    const report = await ingestCandidates([candidate()], { fetcher: okFetcher(override), now: () => 1000 });
    assert.equal(report.records.length, 1, status);
    assert.equal(report.records[0].availability, 'unavailable');
    assert.equal(report.records[0].unavailableReason, reason);
    assert.equal(report.records[0].access.status, status);
    assert.equal(report.records[0].pinnedCommit, null);
    assert.equal(report.records[0].manifest, null);
    assert.equal(report.unavailable[0].reason, reason);
    assert.equal(catalogView(report.records[0]).installable, false);
  }
});

test('archived sources and missing licenses stay visible as candidates but cannot be installed', async () => {
  const archived = await ingestCandidates([candidate()], { fetcher: okFetcher({ probe: async () => ({ status: 200, archived: true, defaultBranch: 'main' }) }), now: () => 1000 });
  assert.equal(archived.records[0].availability, 'available');
  assert.equal(archived.records[0].archived, true);
  assert.equal(catalogView(archived.records[0]).reason, 'archived_source');

  const unlicensed = await ingestCandidates([candidate()], { fetcher: okFetcher({ readLicenseFile: async () => null }), now: () => 1000 });
  assert.equal(unlicensed.records[0].license.licenseSource, 'none');
  assert.equal(unlicensed.records[0].availability, 'available');
  assert.equal(catalogView(unlicensed.records[0]).reason, 'license_not_declared');
});

test('duplicate candidates are deduplicated without a second fetch and are reported', async () => {
  let probes = 0;
  const fetcher = okFetcher({ probe: async () => { probes += 1; return { status: 200, archived: false, defaultBranch: 'main' }; } });
  const report = await ingestCandidates([
    candidate(),
    candidate({ repository: 'acme/SKILLS', url: 'https://github.com/acme/SKILLS' }),
  ], { fetcher, now: () => 1000 });
  assert.equal(probes, 1);
  assert.equal(report.records.length, 1);
  assert.deepEqual(report.duplicates, [{ duplicate: 'https://github.com/acme/SKILLS', kept: 'https://github.com/Acme/Skills', canonicalSlug: 'acme/skills' }]);
  assert.equal(report.counts.candidates, 2);
  assert.equal(report.counts.recorded, 1);
  assert.equal(report.counts.duplicates, 1);
});

test('non-GitHub links are reported unavailable and never fetched or persisted as GitHub', async () => {
  let probes = 0;
  const fetcher = okFetcher({ probe: async () => { probes += 1; return { status: 200 }; } });
  const report = await ingestCandidates([candidate({ repository: 'example/widgets', url: 'https://example.test/widgets' })], { fetcher, now: () => 1000 });
  assert.equal(probes, 0);
  assert.equal(report.records.length, 0);
  assert.equal(report.unavailable.length, 1);
  assert.equal(report.unavailable[0].reason, 'unsupported_provider');
});

test('an empty repository listing is unavailable rather than an empty audited package', async () => {
  const report = await ingestCandidates([candidate()], { fetcher: okFetcher({ listFiles: async () => [] }), now: () => 1000 });
  assert.equal(report.records[0].availability, 'unavailable');
  assert.equal(report.records[0].unavailableReason, 'no_files');
  assert.equal(report.records[0].manifest, null);
});

test('promotion requires a reviewer signature and an audited trust status', async () => {
  const report = await ingestCandidates([candidate()], { fetcher: okFetcher(), now: () => 1000 });
  const record = report.records[0];
  const promoted = { ...record, trustStatus: 'LICENSE_APPROVED', reviewerSignature: { reviewerId: 'r1', signature: 'sig', signedAt: 2000 } };
  assert.doesNotThrow(() => requireAuditableSource(promoted));
  assert.equal(catalogView(promoted).installable, true);
  assert.throws(() => requireAuditableSource({ ...record, trustStatus: 'LICENSE_APPROVED' }), (err) => err.code === 'reviewer_signature_required');
  assert.equal(catalogView({ ...record, accessibility: 'gone' }).installable, false);
});

// ---------- persistence mapping ----------

test('registry rows are whitelisted metadata and promoted rows cannot be written without a signature', async () => {
  const report = await ingestCandidates([candidate()], { fetcher: okFetcher(), now: () => 1000 });
  const row = toRegistryRow(report.records[0], 3000);
  assert.equal(row.source_id.startsWith('src_'), true);
  assert.equal(row.trust_status, 'USER_SUPPLIED_UNVERIFIED');
  assert.equal(row.reviewer_signature, null);
  assert.equal(row.manifest_digest, report.records[0].manifest.digest);
  assert.equal('instructions' in row, false);
  assert.equal('role_template' in row, false);

  assert.equal(codeOf(() => toRegistryRow({ ...report.records[0], trustStatus: 'LICENSE_APPROVED' }, 3000)), 'reviewer_signature_required');
  assert.equal(codeOf(() => toRegistryRow({ ...report.records[0], manifest: { ...report.records[0].manifest, digest: 'xyz' } }, 3000)), 'invalid_manifest_digest');
  assert.equal(codeOf(() => toRegistryRow({ ...report.records[0], canonicalSlug: 'Acme/Skills' }, 3000)), 'invalid_canonical_slug');
  assert.throws(() => toRegistryRow({ ...report.records[0], trustStatus: 'LICENSE_APPROVED' }, 3000), RegistryRowError);
});

// ---------- schema ----------

test('the source registry migration is contiguous, RLS-forced and enforces reviewer signatures', () => {
  assert.equal(SOURCE_REGISTRY_MIGRATION.id, POSTGRES_MIGRATIONS.length);
  assert.equal(POSTGRES_MIGRATIONS.at(-1).id, SOURCE_REGISTRY_MIGRATION.id);
  assert.deepEqual(POSTGRES_MIGRATIONS.map((migration) => migration.id), POSTGRES_MIGRATIONS.map((_, index) => index + 1));
  assert.doesNotThrow(() => validatePostgresMigrationSql(SOURCE_REGISTRY_MIGRATION.sql));
  const sql = SOURCE_REGISTRY_MIGRATION.sql;
  assert.match(sql, /CREATE TABLE uap\.source_repositories/);
  assert.match(sql, /CREATE TABLE uap\.source_ingest_runs/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /reviewer_signature IS NOT NULL/);
  assert.match(sql, /trust_status IN \(\s*'USER_SUPPLIED_UNVERIFIED'/);
  assert.match(sql, /manifest_file_count/);
  assert.match(sql, /last_audited_at/);
});
