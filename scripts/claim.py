#!/usr/bin/env python3
"""Atomic next-task claim for the multi-agent UAP build.
Usage: python3 scripts/claim.py <worker-id>
Actions: claims the first pending item (or first 'rework' item if none pending),
         writes build-ledger.json under flock, commits + pushes the claim.
Prints: CLAIM <id> <desc> | NOTHING <reason>
"""
import json, subprocess, sys, fcntl, time, os
U = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = "/tmp/uap-build-claim.lock"
worker = sys.argv[1] if len(sys.argv) > 1 else "worker-unknown"

def sh(c):
    return subprocess.run(c, shell=True, capture_output=True, text=True)

with open(LOCK, "w") as lf:
    fcntl.flock(lf, fcntl.LOCK_EX)
    pull = sh(f"cd {U} && git pull --ff-only -q origin main")
    if pull.returncode != 0:
        # Never claim from a stale ledger: a dirty tree or a diverged branch means
        # this worker cannot see other workers' claims yet.
        print("NOTHING pull-failed (tree dirty or diverged) — fix the tree first")
        sys.exit(0)
    d = json.load(open(f"{U}/build-ledger.json"))
    # belt-and-braces: re-read the ledger from origin after the pull so an
    # in-flight claim by another worker can never be handed out twice.
    cur = sh(f"cd {U} && git show origin/main:build-ledger.json").stdout
    if cur:
        d = json.loads(cur)
    items = d["items"]
    pick = None
    for it in items:                      # strict order: pending first
        if it["status"] == "pending":
            pick = it; break
    if pick is None:
        for it in items:                  # then rework items
            if it["status"] == "rework":
                pick = it; break
    if pick is None:
        print("NOTHING all-claimed-or-blocked")
        sys.exit(0)
    pick["status"] = "claimed"; pick["claimed_by"] = worker
    pick["claimed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(d, open(f"{U}/build-ledger.json", "w"), indent=1)
    sh(f"cd {U} && git add build-ledger.json && "
       f"git -c user.name=build-agent -c user.email=build@uap.local "
       f"commit -q -m 'claim {pick['id']} by {worker}' && git push -q origin HEAD")
    print(f"CLAIM {pick['id']} {pick['desc']}")

