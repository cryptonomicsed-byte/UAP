#!/usr/bin/env python3
"""S-64: claim commit must only contain build-ledger.json (not other staged files)."""
import os, subprocess, tempfile, shutil, json, sys

def sh(c, cwd):
    return subprocess.run(c, shell=True, capture_output=True, text=True, cwd=cwd)

def main():
    src = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    claim_src = os.path.join(src, "scripts", "claim.py")
    tmp = tempfile.mkdtemp(prefix="uap-claim-s64-")
    try:
        bare = os.path.join(tmp, "bare.git")
        work = os.path.join(tmp, "work")
        sh(f"git init -q --bare {bare}", tmp)
        sh(f"git clone -q {bare} {work}", tmp)
        ledger = {"items": [{"id": "T-1", "desc": "test", "status": "pending"}]}
        open(os.path.join(work, "build-ledger.json"), "w").write(json.dumps(ledger, indent=1))
        os.makedirs(os.path.join(work, "scripts"), exist_ok=True)
        shutil.copy(claim_src, os.path.join(work, "scripts", "claim.py"))
        sh(
            "git add build-ledger.json scripts/claim.py && "
            "git -c user.email=t@t -c user.name=t commit -q -m seed && "
            "git branch -M main && "
            "git push -q -u origin HEAD:main",
            work,
        )
        open(os.path.join(work, "poison.txt"), "w").write("secret-other-worker\n")
        sh("git add poison.txt", work)
        staged = sh("git diff --cached --name-only", work).stdout
        assert "poison.txt" in staged, staged
        r = sh("python3 scripts/claim.py worker-s64-test", work)
        if "CLAIM T-1" not in r.stdout:
            print("FAIL claim:", r.returncode, r.stdout, r.stderr)
            return 1
        sh("git fetch -q origin", work)
        show = sh("git log origin/main -1 --name-only --pretty=format:", work).stdout.strip().splitlines()
        files = [x for x in show if x.strip()]
        if files != ["build-ledger.json"]:
            print("FAIL claim published extra files:", files)
            print(sh("git log origin/main --oneline -3", work).stdout)
            return 1
        # poison must not be on remote
        tree = sh("git ls-tree -r --name-only origin/main", work).stdout
        if "poison.txt" in tree:
            print("FAIL poison published")
            return 1
        print("PASS S-64 claim commit files:", files)
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
