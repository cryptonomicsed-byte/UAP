# Living Workspace design contract

## Shape

One matte Obsidian roster; one fluid stage for the selected agent; one optional inspector. The wider desktop shows all three. A narrow screen uses a roster drawer and inspector sheet, with the same selected agent and no parallel navigation rail. Workspace Tasks and Board remain reachable from the one roster, including on mobile.

## Palette

| Token | Value | Role |
|---|---|---|
| Obsidian | `#17191d` | Roster and inspector |
| Canvas | `#1b1d21` | Conversation and workspace stage |
| Graphite | `#24272d` | Composer, panels, and controls |
| Porcelain | `#f2efe8` | Primary text |
| Muted | `#bdbab3` | Secondary text |
| Sage | `#a8b89f` | Selection and progress |
| Lilac | `#b4a2cc` | Keyboard focus |
| Amber | `#e4bd7c` | Waiting for input |

The existing controls, gateways, and design primitives stay mounted behind their appropriate affordances. The inspector defaults to Operate; opening a computer preview is explicit in this layout. State comes from provider and event responses; an unconfigured computer is neither isolated nor running. Keep day/week names and abbreviations legible without color. No continuous portrait animation; respect reduced motion for interactive transitions.

The Studio is a dark presentation preset; existing classic light, dark, and system preferences are not overwritten. Opt in from the account menu with Use Living Workspace and switch back with Use classic layout. Set `VITE_UAP_STUDIO=1` at build time only for a controlled default-on environment; explicit browser preferences override the default. This setting does not change auth, SIDs, or permissions.

Screen proof: build and run `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser` against the disposable local fixture. Desktop and mobile PNGs are written to `tests/out/foundation/`. The six-width check is not a full WCAG or 90/100 design review. See `docs/studio/IMPLEMENTATION.md` for remaining release requirements.
