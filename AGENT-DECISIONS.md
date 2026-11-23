# AGENT-DECISIONS.md — UAP

Log of decisions made by agents working this repo. Read top-down; newest first.

## 2026-11-23 — Foundation = UAP itself (supersedes blueprint's OpenMausBot seed)

Context
  The v6 master blueprint (now archived in docs/v6-blueprint/) locked decision #7:
  "Start the authorized Apache-licensed subset of milind-soni/OpenMausBot as the
  preferred application/desktop seed." AgentOS contained only that spec; UAP is the
  implementation the spec describes and is already running in production at
  uap.omokoda.duckdns.org.

Decision (owner-directed, yolo mode)
  UAP is the build foundation. The v6 checklist and blueprint are merged into this repo
  as docs/v6-blueprint/ and govern the build from here. AgentOS stays as the spec
  archive, not the implementation home.

Rationale
  * UAP is our own code: no enterprise/ stripping, trademark/mascot removal, or fork
    update policy — the whole M0 rights risk the OpenMausBot seed carried
    (V6-01-01..V6-01-10) collapses to "audit our own tree".
  * Hermes-native and live: the blueprint's locked decision that "Hermes remains primary
    reasoning engine" is already true here, not a parity gate to prove.
  * PostgreSQL sessions, tenant metadata, fenced durable executor and a fail-closed
    durable boundary already exist — tracks D/E/F/G start from real code instead of zero.

Consequences
  * Blueprint locked decisions are historical; this log is authoritative where they
    conflict (foundation seed only — all other locked decisions stand).
  * OpenMausBot/Bot HQ are referenced only for adapter patterns (track G), never as the
    shell or a second reasoning master.
  * The checklist is ADDITIVE and none of its 235 items may be auto-ticked; the
    no-self-approval rule stays.

Next
  Execute the checklist against this repo, M0 first (own-tree rights audit + SID
  fixtures), then M1 (Rust policy/lease contracts), recording evidence in this file.
