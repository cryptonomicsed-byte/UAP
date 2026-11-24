#!/usr/bin/env python3
"""Mark a claimed item done with evidence: python3 scripts/done.py <id> <sha> '<evidence>'
"""
import json, subprocess, sys, os, time
U = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
iid, sha, ev = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""
d = json.load(open(f"{U}/build-ledger.json"))
for it in d["items"]:
    if it["id"] == iid:
        it["status"] = "done"; it["done_sha"] = sha; it["evidence"] = ev
        it["verified"] = None
json.dump(d, open(f"{U}/build-ledger.json", "w"), indent=1)
# S-64: only publish ledger — clear foreign staged files first
subprocess.run(
    f"cd {U} && git reset -q HEAD && git add -- build-ledger.json && "
    f"git -c user.name=build-agent -c user.email=build@uap.local "
    f"commit -q -m 'done {iid} @ {sha}' -- build-ledger.json && git push -q origin HEAD",
    shell=True,
)
print(f"DONE {iid}")
