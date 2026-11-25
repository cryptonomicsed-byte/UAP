# Inspiration extraction checklist — Nod, Rakazo, Codync, OpenMausBot, Bot HQ, duskbot

Patterns adapted from real source studied locally (`/opt/ares/src-pins/{nod,rakazo,Codync,duskbot}`,
`/opt/ares/OpenMausBot-oss`), never copied verbatim, never anything requiring a license review,
paid account, or legal signoff to build and ship. `bot-hq` is not separately cloned — its listed
GitHub repo (`nickvasilescu/bot-hq`) was renamed to `nickvasilescu/orgo-teammates`
(confirmed in `docs/agentos/LICENSE-AUDIT.md`); it is also the repo UAP's own architecture is
benchmarked against throughout the v6 blueprint's `MAUS-*` items, so most of its reusable shape
is already the baseline this app is built on rather than a separate thing to mine.

Status legend: `[x]` built and shipped this repo, with the commit. `[ ]` identified, not yet built.

## Codync (`apps/android/design/Glass.kt`, `apps/desktop/.../*.css`)
- [x] Liquid-glass surface system: vibrancy (blur+saturate), rim highlight, lifted shadow, press
      swell — `web/src/styles/glass.css` `.glass`/`.chat__header`/`.jump-btn`/`.composer`. (this commit)
- [x] Scroll-timeline frost header (`sidebar-header.css`): zero-JS blur-in as content scrolls
      under a floating bar — `.chat__header::after` / `.sidebar__titlebar::after`, `@supports`-gated. (this commit)
- [x] Composer dock masked blur fade (`chat-controls.css` `.composer-fade`) — `.composer-area::before`. (this commit)
- [x] Magnetic icon button (`.mac-chat-button`'s cursor-lean) — `web/src/lib/useMagnetic.ts`, wired
      into the chat header's three quick-action buttons. (this commit)
- [x] Agent fallback chain pattern (bounded retry across logins) — `server/src/lib/agent-fallback.ts`. (earlier session)
- [ ] "Jump to latest" swell/translate entrance (`.jump-to-latest.shown`) — UAP's `.jump-btn` already
      has a simpler `rise` entrance; porting the opacity+translate combo is a small polish item, not done.
- [ ] Whats-new-style looping preview clips with a frosted play-badge (`whats-new.css`) — no feature
      in UAP yet that this would attach to (no release-notes/changelog surface).

## Rakazo (`apps/web/src/pages/shell/chat/*`)
- [x] Masked backdrop-blur top fade (`chat-top-fade.css`) — same technique as Codync's composer
      fade, applied to the chat header's scroll-linked frost. (this commit)
- [x] Ticket board (ownership, status taxonomy, comments) — `server/src/lib/ticket-board.ts`,
      `web/src/components/config/BoardView.tsx`. (earlier session)
- [ ] Model picker as a glass popover anchored to a pill (`chat-model-picker.tsx`) — UAP's `<Menu>`
      component is a plain dropdown today; restyling it as glass is a real, small follow-up, not done.

## duskbot
- [x] Delegated autonomy (parent level only ever raises a spawned sub-agent, never lowers) —
      `server/src/lib/autonomy.ts` `delegateAutonomy`. (earlier session)
- [ ] Nothing further found in the one file inspected (`apps/site` landing CSS was compiled
      Tailwind output, not a reusable source pattern). Not fabricating additional items for this repo.

## OpenMausBot (OSS)
- [x] Theme sanitizer (reject `url()`/`@import`/anything that could load something, per-SID
      accent only) — `server/src/lib/theme-sanitize.ts`, wired to the Appearance control on the
      agent desk. (earlier session)
- [ ] `apps/docs` is a documentation site, not the product UI — no further UI pattern mined from
      it. The product's actual desktop/web client source was not located inside the OSS tree
      checked out locally (`server/browser/desktop` is the embedded browser automation driver,
      not a UI to borrow from).

## Nod
- [x] Checked `desktop/ui/feedback.css` and `desktop/ui/styles.css` for distinctive patterns —
      found plain functional dialog styling, nothing beyond generic desktop-app CSS worth adapting.
      Honest null result, not padded with an invented item.
- [ ] Browser/workspace isolation and Trust/Vault architecture ideas were already identified as
      adaptation targets in the AgentOS atlas (`what_we_take` for `n8n-io/nod`); UAP already has
      its own Vault/OAuth connector flow (Composio-based) — a deeper compatibility audit between
      the two is a real but separate, larger piece of work, not a quick UI extraction.

## Bot HQ (via `nickvasilescu/orgo-teammates`, formerly `bot-hq`)
- [ ] Not separately mined this pass: UAP's whole bot-roster/chat/desk architecture is already
      benchmarked against this repo throughout the v6 blueprint's foundation-bakeoff items
      (`MAUS-B-*`). Re-deriving the same shape from its source would be redundant with work the
      blueprint's own foundation-selection process already covers, not a new UI trick.

## New design tricks added this pass, not derived from a specific repo
- [x] Animated conic-gradient glow ring on the composer when focused, rotating slowly
      (`web/src/styles/glass.css` `.composer::before` + `@keyframes glow-spin`), gated behind
      `prefers-reduced-motion`.
- [x] Subtle film-grain overlay (inline SVG `feTurbulence`, 2.5% opacity, `mix-blend-mode: overlay`)
      on glass chrome surfaces — depth without the flat, generic look a plain blur alone gives.
      `.glass-grain`, applied to the chat header.
- [ ] Cursor-follow spotlight glow on hover for board/desk cards — identified, not yet built (see
      next commit in this session if time allows).

## Discipline carried over from every source file actually inspected
Every one of them gated blur behind `prefers-reduced-transparency` and motion behind
`prefers-reduced-motion` — this was not an invented constraint, it is the actual convention in
the real Codync/Rakazo CSS. `tests/glass-design.test.mjs` enforces the same thing here
mechanically (checks the file, not a human remembering to do it next time).
