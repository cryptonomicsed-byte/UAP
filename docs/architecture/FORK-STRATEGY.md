# Upstream fork strategy (V6-01-09)

Status: **binding**. This is how UAP relates to upstream OpenMausBot / Bot HQ and every candidate source.

## Principles

1. **UAP is the product tree.** Upstream is a reference and occasional patch donor, never a second master.
2. **No silent identity.** Upstream trademarks, mascots, package names, and `enterprise/` trees are excluded from build artifacts (`npm run audit:branding`, `npm run audit:rights`).
3. **Pin, don't float.** Every imported source is commit-SHA pinned. Branch-only references are refused by `server/src/sources/pin.ts`.
4. **Rights before merge.** LICENSE/NOTICE + dependency SBOM must pass CI before code lands on `main`.

## Update policy

| Change type | Process |
|---|---|
| Security fix from upstream | Cherry-pick or re-implement; keep UAP brand/IDs; run full `npm test` + rights audit |
| Feature we want | Re-implement against UAP contracts (Rust policy, Elixir worker, Hermes adapter). Do not vendor wholesale |
| Dependency bump | `npm ci` + `audit:rights` + typecheck/build/test green before merge |
| Candidate source refresh | Source registry re-audit (`server/src/sources/reaudit.ts`); trust status never auto-promotes |

## Backports

- Prefer forward-port into UAP modules over maintaining a long-lived fork branch of upstream.
- If a temporary fork branch is required, name it `upstream/<date>-<topic>` and delete it after the UAP-side patch lands.
- Never force-push `main`.

## Rollback

1. `git revert` the offending merge/commit on `main` (no history rewrite).
2. Redeploy via green-only `uap-sync` (tests must pass).
3. If a source pack is compromised: revoke trust (`sources/trust.ts`), cancel grants, emit audit — do not leave installable=true.

## Non-OSS exclusions

- Anything under upstream `enterprise/` is **out of scope** and must not appear in `web/dist`, `server/dist`, or container images.
- Proprietary model weights, paid skill packs, and unlicensed fonts/assets are blocked by rights CI.
- Third-party persona repos remain `USER_SUPPLIED_UNVERIFIED` until an independent reviewer signature is recorded.

## Operator checklist before adopting an upstream patch

- [ ] Diff reviewed for trademark/mascot/enterprise paths
- [ ] Rights audit green
- [ ] Hermes adapter + policy kernel still pass
- [ ] Deploy badge SHA advances on production after green sync
