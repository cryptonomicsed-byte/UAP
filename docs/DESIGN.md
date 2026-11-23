---
version: alpha
name: Agent Console
description: Quiet operating surface for a fleet of agents. Slate neutrals, one deep teal accent, flat elevation in dark mode, honest states.
colors:
  primary: "#176C78"
  neutral: "#F6F9FA"
  ink: "#1C1C1C"
  success: "#10AB61"
  warn: "#DA830E"
  danger: "#E72E3B"
typography:
  body-sm:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Inter, sans-serif"
    fontSize: 13px
  body-md:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Inter, sans-serif"
    fontSize: 14px
  message:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Inter, sans-serif"
    fontSize: 15px
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: 13px
spacing:
  sm: 8px
  md: 16px
rounded:
  sm: 8px
  md: 12px
  bubble: 14px
  card: 16px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FCFCFC"
    rounded: "{rounded.full}"
    padding: 8px 16px
  button-primary-hover:
    backgroundColor: "#125560"
    textColor: "#FCFCFC"
    rounded: "{rounded.full}"
  button-secondary:
    backgroundColor: "#1C1C1C0F"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: 8px 16px
  surface-pane:
    backgroundColor: "#FFFFFF"
    rounded: "{rounded.card}"
---

## Overview

The Agent Console is an **Operate** surface: the user watches and steers a fleet
of agents. Density and glanceability win; there is no hero, no marketing framing.
Every state (idle, running, degraded, error, empty) is a real state rendered from
real data — never a decorative simulation.

## Colors

- **Primary `#176C78`** — deep teal. The only accent for actions, focus and
  selection. Chosen for the platform's deep-work posture, deliberately not
  indigo/violet. Hover darkens to `#125560`; dark mode inverts to `#9ED9DE`.
- **Ink `#1C1C1C`** — all text starts here; secondary/tertiary/quaternary are
  alpha steps of the same ink, never grey mixes.
- **Bot colors** — a fixed 11-color set (`--color-bot-*`) identifying agents by
  avatar. Semantic, never used for chrome.
- **Status** — success `#10AB61`, warn `#DA830E`, danger `#E72E3B`. Status color
  always pairs with text, never color alone.

## Typography

System stack by default (Inter as progressive enhancement, not a requirement).
The mono stack is reserved for ids, paths and diagnostics — mono accents, not
mono everywhere.

## Layout

Chrome background → sidebar → pane hierarchy, light: `#F6F9FA` → `#EAF0F2` →
`#FFFFFF`. Dark mode is a single flat surface family (no shadows, 0.5px borders
instead). Spacing starts at 8px. Touch targets are 44px on coarse pointers.

## Elevation & Depth

Light mode: hairline + soft shadow pairs. Dark mode: **flat** — every elevation
is a 0.5px border. Depth is expressed by background steps, never glowing shadows.

## Shapes

Full-radius pills for actions, 14px bubbles, 16px cards. Corners are containers;
they do not substitute for hierarchy.

## Components

`button-primary` is the single high-emphasis action per view. Everything else is
secondary or ghost. Disabled controls state *why* where the reason is knowable —
a dead button with no explanation is a bug, not a style choice.

## Do's and Don'ts

- **Do** render idle/running/degraded/error/empty as distinct truthful states.
- **Do** keep one primary action per surface.
- **Do** respect `prefers-reduced-motion`.
- **Don't** add gradients, glass blur, or decorative shadows in dark mode.
- **Don't** use emoji, stock illustrations, or fabricated metrics.
- **Don't** put a centered hero on this surface — it is a console, not a landing
  page.
