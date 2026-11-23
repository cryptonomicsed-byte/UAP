# Multi-agent build protocol

3 worker agents + 1 checker run every 30 min. NO duplication is possible because:

* build-ledger.json is the single claim board, kept in git.
* claim.py takes the next `pending` item under flock, commits the claim, and pushes —
  the next worker's `git pull` sees it and takes the following item. Strict order.
* A claimed item belongs to that worker alone. Others never touch claimed-by-others.
* done.py marks `done` with sha + evidence. The checker (independent) re-runs the
  tests at that sha and flips `verified` or `rework:<reason>`. Rework items are taken
  before nothing else when no pending item remains.
* Stale claims (claimed but untouched for >6h) are released by the checker.
