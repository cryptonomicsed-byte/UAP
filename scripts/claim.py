#!/usr/bin/env python3
"""Atomic next-task claim for the multi-agent UAP build.
Usage: python3 scripts/claim.py <worker-id>
Actions: claims the first pending item (or first 'rework' item if none pending),
         writes build-ledger.json under flock, commits + pushes the claim.
Prints: CLAIM <id> <desc> | NOTHING <reason>
Exit:   0 = claimed, or nothing to claim (incl. stale tree); 3 = claim lost
        (push failed; the ledger was rolled back locally)
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
    for it in items:                      # rework first: broken items block the build
        if it["status"] == "rework":
            pick = it; break
    if pick is None:
        for it in items:                  # then next pending in strict order
            if it["status"] == "pending":
                pick = it; break
    if pick is None:
        print("NOTHING all-claimed-or-blocked")
        sys.exit(0)
    pick["status"] = "claimed"; pick["claimed_by"] = worker
    pick["claimed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(d, open(f"{U}/build-ledger.json", "w"), indent=1)
    base = sh(f"cd {U} && git rev-parse HEAD").stdout.strip()
    # S-64: never publish another worker's staged files. Clear the index, stage
    # only the ledger, and pathspec-limit the commit to that single path.
    psh = sh(
        f"cd {U} && "
        f"git reset -q HEAD && "
        f"git add -- build-ledger.json && "
        f"git -c user.name=build-agent -c user.email=build@uap.local "
        f"commit -q -m 'claim {pick['id']} by {worker}' -- build-ledger.json && "
        f"git push -q origin HEAD"
    )
    if psh.returncode != 0:
        # The push may have landed even though the command reported failure
        # (hook noise, transport hiccup). Trust the remote, not the exit code.
        head = sh(f"cd {U} && git rev-parse HEAD").stdout.strip()
        remote = sh(f"cd {U} && git ls-remote origin refs/heads/main").stdout.split()
        if head and head != base and remote and remote[0] == head:
            print(f"CLAIM {pick['id']} {pick['desc']}")
            sys.exit(0)
        # Roll back OUR claim only. This script runs in the shared clone, where
        # every worker keeps tracked edits: a hard reset would erase work that is
        # not ours, so undo the commit softly and restore that one file.
        if head and head != base:
            sh(f"cd {U} && git reset -q --soft {base}")
        # Drop staged leftovers from the failed claim attempt without touching WD.
        sh(f"cd {U} && git reset -q HEAD")
        sh(f"cd {U} && git checkout -q HEAD -- build-ledger.json")
        detail = " ".join(psh.stderr.split())[:120]
        print(f"NOTHING push-failed ({detail})")
        sys.exit(3)
    print(f"CLAIM {pick['id']} {pick['desc']}")

