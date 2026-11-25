#!/usr/bin/env python3
"""Thin CLI wrapper around the real agent-phone/minipae identity code (not reimplemented
crypto). Prints one JSON line: {"npub": "...", "nsec": "...", "pubkey_hex": "..."}.
Usage: mint_identity.py [--from-nsec NSEC]
"""
import json
import sys

sys.path.insert(0, "/opt/ares")
sys.path.insert(0, "/opt/ares/agent-phone")

from agent_phone.identity import Identity  # noqa: E402

if len(sys.argv) > 2 and sys.argv[1] == "--from-nsec":
    ident = Identity.from_nsec(sys.argv[2])
else:
    ident = Identity.generate()

print(json.dumps({"npub": ident.npub, "nsec": ident.nsec, "pubkey_hex": ident.pubkey_hex}))
