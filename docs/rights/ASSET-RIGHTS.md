# Asset and font rights manifest

Status: **evidence record, not legal clearance.** This file explains the machine
registry that the release gate enforces; it does not assert trademark clearance or
permission for user-supplied artwork.

## Enforced by

```bash
npm run audit:rights          # node scripts/audit-rights.mjs
```

The audit is fail-closed:

| Condition | Verdict |
|---|---|
| asset file present with no registry row | `unregistered` → exit 1 |
| registry hash differs from file hash | `hash-mismatch` → exit 1 |
| registry row without origin/license | `incomplete-rights-row` → exit 1 |
| registry row whose file is gone | `registered-asset-missing` → exit 1 |
| dependency license not in `LICENSE-POLICY.json` allow list | `not-allowed` → exit 1 |
| dependency with no license field | `missing-license` → exit 1 |
| lockfile/policy unreadable or policy missing allow list | exit 2 (audit cannot run) |

Artifacts land in `artifacts/rights/`: `sbom.cdx.json` (CycloneDX 1.5),
`license-report.json`, `asset-manifest.json`, `rights-report.json`. CI uploads them,
so the SBOM a release claims is the SBOM the build produced from that lockfile
(`rights-report.json.lockSha256` binds the report to the exact lock bytes).

## Registry

Machine-readable rows live in [`ASSET-RIGHTS.json`](./ASSET-RIGHTS.json). Each row
records `path`, `sha256`, `bytes`, `origin` and `license`.

### Current entries

| Path | Origin | License |
|---|---|---|
| `web/public/favicon.svg` | authored in-repo (geometric node badge) | MIT |

No font binaries are bundled: the web UI uses system font stacks. Adding a webfont
means adding a registry row with its OFL/Apache-2.0 license file hashed alongside it —
the audit will refuse the build until that is done.

## Scanned locations and extensions

Roots: `web/public`, `web/src/avatar`.
Extensions: png jpg jpeg webp avif gif svg ico woff woff2 ttf otf eot mp3 wav ogg flac
mp4 webm mov glb gltf hdr exr pdf.

Source code (`*.ts`, `*.tsx`, `*.css`) is covered by the repository MIT license, not by
this registry.

## Change history

* 2026-11-23 — registry created with the first-party favicon; audit wired into
  `npm run check` and the Foundation CI workflow (V6-01-07).
