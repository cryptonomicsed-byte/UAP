# Source pins — 2026-11-24

Read from the machines, not from the blueprint text.

| Source | SHA | Note |
|---|---|---|
| milind-soni/OpenMausBot | `0c352d70286aceb8ccabc9d11a56713e35026920` | Cloned to `/opt/ares/OpenMausBot`. `enterprise/` is present and is **not** Apache-2.0. UAP does not import it. |
| nickvasilescu/bot-hq | `decf9a215cddd8792a5f20f4a11a87d4dffa6d15` | Already at `/opt/bot-hq`. Provisional web/Hermes seed. Not the tenant authority. |

`LICENSING.md` sha256 `e2741dbfc0f289c53b7a6bdbbce4ddca82155c5263ebd478ae19156975cc77b2` says production use of `enterprise/` needs a license key, and hosting/white-label needs a partner agreement. That agreement is not in this repo. Those checklist rows stay blocked.

## OSS edition proof

Worktree `/opt/ares/OpenMausBot-oss` is the same SHA with `enterprise/` deleted. `pnpm install --frozen-lockfile`, `pnpm typecheck`, and `vitest` on `server/enterprise.test.ts` plus `server/brand.test.ts` passed (19). Boot on port 18797 with a fake `OMB_LICENSE_KEY` returned `edition: oss` and `no enterprise layer exists`. Hermes driver unit tests (`server/drivers/acp/hermes.test.ts`) passed (67) on that tree. That is not a live Hermes parity bakeoff against Bot HQ. Evidence: `docs/v6-blueprint/foss-edition-evidence.json`.

