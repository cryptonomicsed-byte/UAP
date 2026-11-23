# Third-party notices

Universal Agent Platform derives from the MIT-licensed Bot HQ codebase (see `LICENSE`, including the original copyright attribution). It bundles or depends on the third-party work listed below. npm dependencies not listed here are covered by their own licenses, included in their packages.

## Lucide icons

The web UI's icons come from [Lucide](https://lucide.dev), via the `lucide-react` package (pinned to 1.61.0 in `web/package.json`). Lucide supplies the interface glyphs. Product-specific glyph exports have been removed.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Some Lucide icons are derived from [Feather](https://feathericons.com). Those are under the MIT License:

```
Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Original platform artwork

The geometric node badges in `web/src/avatar/`, the SVG favicon in `web/public/favicon.svg`, and the replacement palette were authored for this platform. Badge asset version: 1. No upstream mascot paths or traced artwork are used in these files. These first-party additions use the repository's MIT license.

The original `web/artwork/`, `web/public/assets/`, generated upstream avatar paths, favicon, and promotional `assets/` screenshots/logo/banner were removed from the working distribution because the upstream notice excluded rights to xAI/Cursor artwork. Their presence in upstream Git history does not grant commercial reuse rights.

## Runtime service marks

App logos supplied at runtime by Composio remain the property of their respective owners and identify connected services. Inclusion does not imply affiliation or endorsement. No third-party app logos or Google sign-in mark are bundled in the replacement UI.

## Machine-enforced inventory

The notices above are prose. The enforced inventory is:

* `npm run audit:rights` — builds a CycloneDX 1.5 SBOM from `package-lock.json`, applies
  `docs/rights/LICENSE-POLICY.json` (fail-closed: an unlisted, missing or unknown license
  fails the build — GPL/AGPL/SSPL/BUSL are denied explicitly), and verifies
  `docs/rights/ASSET-RIGHTS.json` against the actual bundled asset bytes.
* CI job `rights` in `.github/workflows/foundation.yml` uploads the SBOM, license report
  and asset manifest as the release evidence artifact.

## Review status

These notices record source provenance and removals. They do not constitute trademark clearance, legal approval, a review of every dependency/model license, or permission to use user-supplied artwork. The descriptive name Universal Agent Platform remains provisional pending commercial name and domain clearance.
