#!/usr/bin/env python3
"""Portable lease verifier (V6-05-09) — Python reference implementation.

Usage: verify-lease.py <fixture-dir>

Reads the committed golden fixture, rebuilds the canonical bytes from the fields,
compares the SHA-256, then verifies the Ed25519 signature. Exits 0 iff the conclusion
(valid/invalid) equals `expect.txt`.

This is deliberately a *second* implementation of the same contract as
`crates/agentos-policy/src/lease.rs`: if the Rust and Python canonical serialisers ever
disagree, the SHA-256 comparison fails here rather than silently in production.

Dependency: `cryptography` (Ed25519). Everything else is stdlib.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DOMAIN = "uap-lease/1"
LEASE_KEYS = [
    "v",
    "lease_id",
    "task_id",
    "tenant",
    "sid",
    "role_digest",
    "grant_id",
    "epoch",
    "issued_at_ms",
    "expires_at_ms",
    "revocation",
    "nonce",
]
REVOKED_KEYS = ["list", "version"]
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID = re.compile(r"^[!-~]+$")  # printable ASCII, no space


def fail(reason):
    return False, reason, None


def as_uint(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def as_id(value, name):
    if not isinstance(value, str) or not value or not SAFE_ID.match(value):
        raise ValueError(f"{name} must be a non-empty printable-ASCII string")
    if '"' in value or "\\" in value:
        raise ValueError(f"{name} contains a character that needs JSON escaping")
    return value


def as_hex64(value, name):
    if not isinstance(value, str) or not HEX64.match(value):
        raise ValueError(f"{name} must be 64 lowercase hex characters")
    return value


def canonical(fields):
    """Rebuild the canonical bytes. Field order is the protocol, not sorted at runtime."""
    rev = fields["revocation"]
    parts = [
        '"v":"' + fields["v"] + '"',
        '"lease_id":"' + fields["lease_id"] + '"',
        '"task_id":"' + fields["task_id"] + '"',
        '"tenant":"' + fields["tenant"] + '"',
        '"sid":"' + fields["sid"] + '"',
        '"role_digest":"' + fields["role_digest"] + '"',
        '"grant_id":"' + fields["grant_id"] + '"',
        '"epoch":' + str(fields["epoch"]),
        '"issued_at_ms":' + str(fields["issued_at_ms"]),
        '"expires_at_ms":' + str(fields["expires_at_ms"]),
        '"revocation":{"list":"' + rev["list"] + '","version":' + str(rev["version"]) + "}",
        '"nonce":"' + fields["nonce"] + '"',
    ]
    return "{" + ",".join(parts) + "}"


def verify(directory: Path):
    try:
        fields = json.loads((directory / "fields.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return fail(f"fields.json: {exc}")

    if not isinstance(fields, dict) or list(fields.keys()) != LEASE_KEYS:
        return fail(f"schema: keys are {sorted(fields) if isinstance(fields, dict) else fields}")

    try:
        if fields["v"] != DOMAIN:
            raise ValueError(f"v is {fields['v']!r}")
        for key in ("lease_id", "task_id", "tenant", "sid", "grant_id"):
            as_id(fields[key], key)
        as_hex64(fields["role_digest"], "role_digest")
        as_hex64(fields["nonce"], "nonce")
        for key in ("epoch", "issued_at_ms", "expires_at_ms"):
            as_uint(fields[key], key)
        rev = fields["revocation"]
        if not isinstance(rev, dict) or list(rev.keys()) != REVOKED_KEYS:
            raise ValueError("revocation must be {list, version}")
        as_id(rev["list"], "revocation.list")
        as_uint(rev["version"], "revocation.version")
    except (KeyError, ValueError) as exc:
        return fail(f"schema: {exc}")

    body = canonical(fields)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    try:
        expected = (directory / "canonical.sha256").read_text().strip()
    except OSError as exc:
        return False, f"canonical.sha256: {exc}", digest
    if digest != expected:
        return False, f"canonical bytes differ (built {digest}, expected {expected})", digest

    try:
        sig = bytes.fromhex((directory / "sig.hex").read_text().strip())
        pub = bytes.fromhex((directory / "issuer.pub.hex").read_text().strip())
    except (OSError, ValueError) as exc:
        return False, f"key/signature: {exc}", digest
    if len(sig) != 64:
        return False, "signature is not 64 bytes", digest
    if len(pub) != 32:
        return False, "public key is not 32 bytes", digest

    payload = DOMAIN.encode("utf-8") + b"\n" + body.encode("utf-8")
    try:
        Ed25519PublicKey.from_public_bytes(pub).verify(sig, payload)
    except (InvalidSignature, ValueError):
        return False, "signature does not verify", digest
    return True, "ok", digest


def main(argv):
    if len(argv) != 2:
        print("usage: verify-lease.py <fixture-dir>", file=sys.stderr)
        return 2
    directory = Path(argv[1])
    name = directory.name
    try:
        expect = (directory / "expect.txt").read_text().strip()
    except OSError as exc:
        print(f"verify-lease {name}: error=expect.txt:{exc}")
        return 1
    want = expect == "valid"
    verified, reason, digest = verify(directory)
    print(
        f"verify-lease {name}: expect={expect} got={'valid' if verified else 'invalid'} "
        f"sha256={digest or '-'} reason={reason}"
    )
    return 0 if verified == want else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
