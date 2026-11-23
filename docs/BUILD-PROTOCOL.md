# Multi-agent build protocol

3 worker agents + 1 checker run every 30 min. NO duplication is possible because:

* build-ledger.json is the single claim board, kept in git.
* claim.py takes the next `pending` item under flock, commits the claim, and pushes —
  the next worker's `git pull` sees it and takes the following item. Strict order.
  If that pull cannot fast-forward (dirty or diverged tree) it claims nothing and
  exits 0. If the push fails the claim is rolled back **non-destructively** (soft
  reset of its own commit + restore of `build-ledger.json` only — never a hard reset,
  which would erase other workers' tracked edits in the shared clone) and it exits
  **3**, so a driver loop can tell `NOTHING push-failed` from "nothing to claim".
* A claimed item belongs to that worker alone. Others never touch claimed-by-others.
* done.py marks `done` with sha + evidence. The checker (independent) re-runs the
  tests at that sha and flips `verified` or `rework:<reason>`. Rework items are taken
  before nothing else when no pending item remains.
* Stale claims (claimed but untouched for >6h) are released by the checker.
