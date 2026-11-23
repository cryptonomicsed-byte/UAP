# Source quarantine, prompt-injection and secret scan (B-21 / V6-02-07)

Every imported source is scanned before it can be treated as role instructions or data.
The scan produces **evidence**, never a promotion: nothing is installed, executed or
trusted by this module, and `importAllowed` is true only for a bundle with zero findings.

## Pieces

| File | Role |
|---|---|
| `server/src/sources/quarantine.ts` | Scanner, decision ladder, import gate |
| `scripts/source-quarantine.mjs` | Operator CLI over a checkout (`npm run scan:source -- <path...>`) |
| `tests/source-quarantine.test.mjs` | 24 tests, written and watched failing first |

## Decision ladder

| Decision | When | Import |
|---|---|---|
| `clean` | no findings | allowed |
| `needs-review` | at least one `warn`, no `block` | refused (`source_needs_review`) |
| `quarantined` | at least one `block` | refused (`source_quarantined`) |

`assertImportAllowed(assessment)` throws `SourceQuarantineError`; its message and
`blockers` name the exact rules. The ingestion pipeline must call it before persisting
a source as usable — persisting the assessment alongside the record is the evidence.

## What is detected

**Secrets** (`scanForSecrets`, line-scoped): private key blocks, AWS access key ids,
GitHub tokens, Slack tokens, Stripe live keys, OpenAI-style keys, Google API keys,
JWTs (warn), and generic credential assignments (warn). Placeholders (`YOUR_API_KEY`,
`changeme`, `<redacted>`, runs of one character) are not reported.

**Prompt injection** (`detectPromptInjection`): the seven override classes are delegated
to C-19's `scanInstructions` (`ignore_instructions`, `prompt_extraction`,
`safety_disable`, `identity_hijack`, `secret_read`, `privilege_escalation`,
`covert_action`) so there is one vocabulary and one set of evasion-resistant patterns
(NFKC, zero-width, fullwidth). This module adds what that scan does not cover:
credential **paths** (`~/.ssh`, `id_rsa`, `.aws/credentials`, `.netrc`, `.npmrc`) sent
outbound, credentials posted to a URL, long encoded blobs (warn), and invisible
characters — bidi overrides and Unicode tag characters block, zero-width characters warn.
`credential_exfiltration` is more specific than `secret_read` and suppresses it.

**Executable scripts** (`analyzeExecutableScript`): remote pipe-to-shell
(`curl | bash`, `curl | python`, `wget | sh`), recursive deletion at `/`, block-device
writes, reverse shells (`nc -e`, `/dev/tcp/`), encoded PowerShell, base64-decode-then-eval
all block; `os.system`, `shell=True`, `child_process.exec`, `chmod 777` warn. Files run
through this analysis are counted in `counts.executableFiles`.

**Package manifests** (`analyzePackageManifest`): `preinstall`/`install`/`postinstall`
hooks warn — they execute code at install time and are never run here.

## Honesty rules

* **Secrets are never echoed.** A finding carries a redacted excerpt
  (`AKIA…(20 chars)`); tests assert the raw value is absent from the JSON.
* **Unscannable is never clean.** Binary files and files over the byte budget are
  reported (`unscannable_binary`, `file_too_large`) and force review; the CLI cannot
  exit 0 when its walk hit the file cap (`truncated: true`).
* **Deterministic.** Findings are sorted by path, line, rule; two runs on one bundle are
  byte-identical, so an assessment can be signed and compared later.

## CLI

```
npm run scan:source -- <path...>       # or: node --import tsx scripts/source-quarantine.mjs <path...>
```

Skips `.git`, `node_modules`, `dist`, `build`, `target`, `.next`, `coverage`. Prints
`{roots, truncated, assessment}` and exits `0` clean, `2` needs-review (or truncated),
`3` quarantined, `1` usage/IO error — a pipeline can gate on the exit code alone.

## Where the gate runs

B-20's `ingestCandidates` records metadata only (canonical URL, pinned commit, SHA-256
manifest rows) — it never downloads file bodies, so there is nothing to scan inside it.
The scan therefore runs at the two places content actually appears:

1. **A fetched checkout, before it becomes a role or a tool**: `npm run scan:source -- <dir>`
   exits non-zero on anything but clean.
2. **Bodies passed by a caller** (a fetcher that does read files): `assessSourceBundle(files)`
   then `assertImportAllowed(assessment)`; persist the assessment as the evidence.

Promotion to an audited trust status still requires B-22's independent reviewer, and the
registry must not record a promotion without the assessment attached.

## Non-claims

This is a review gate, not a sandbox, an antivirus, or a proof of safety. It does not
guess at obfuscated scripts it cannot parse, it cannot read binaries, and a `clean`
verdict only means none of the documented rules matched. Promotion to an audited trust
status still requires the independent reviewer of V6-02-08 (B-22).
