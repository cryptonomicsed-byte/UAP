#!/usr/bin/env python3
"""Real Nostr relay client for agent-phone signaling -- the piece agent-phone itself doesn't
have (its cli.py mentions --relay but never implements a relay connection; signaling.py only
builds/parses events offline). Thin glue over the user's own, already-tested
agent_phone.signaling + minipae primitives: this script adds the actual WebSocket
publish/subscribe, nothing more. Never reimplements NIP-17/NIP-44/Schnorr crypto.

Commands (NDJSON on stdout, one line per message, so a Node parent can stream it):
  listen --nsec <nsec> --relay <wss://...> [--once] [--timeout-s N]
      Subscribes to kind:1059 gift wraps tagged #p=<my pubkey>. For each one that unwraps,
      prints {"event":"signal","signal":{...},"from_pubkey":"<hex or null>"}.
      "from_pubkey" is set only for a real NIP-17 3-layer wrap, where the rumor's own
      "pubkey" field names the true sender (unwrap_gift_wrap() itself drops this field --
      replicating just that one extra return value here, not the crypto).
  send-offer --nsec <nsec> --relay <wss://...> --callee <npub> --sdp <sdp>
      Publishes a real OFFER signal to the relay. Prints {"event":"sent","call_id":"..."}.
  heartbeat --nsec <nsec> --relay <wss://...>
      Publishes presence (agent_phone.presence.build_heartbeat) to the relay.
"""
import argparse
import asyncio
import json
import sys
import time

sys.path.insert(0, "/opt/ares")
sys.path.insert(0, "/opt/ares/agent-phone")

import minipae  # noqa: E402
import websockets  # noqa: E402
from agent_phone.identity import Identity  # noqa: E402
from agent_phone.signaling import (  # noqa: E402
    KIND_GIFT_WRAP, Signal, build_offer, unwrap_gift_wrap,
)
from agent_phone.presence import build_heartbeat  # noqa: E402


def _out(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _unwrap_with_sender(event: dict, me: Identity):
    """Same as agent_phone.signaling.unwrap_gift_wrap, but also returns the real sender's
    pubkey when the wrap is a proper NIP-17 3-layer (rumor carries it); None for the
    legacy 1-layer form this stack's own callee->caller signals use (build_signal_wrap)."""
    content = unwrap_gift_wrap(event, me)
    from_pubkey = None
    try:
        wrap_pubkey = bytes.fromhex(event["pubkey"])
        outer_key = minipae.conversation_key(me.seckey, wrap_pubkey)
        inner = json.loads(minipae.nip44_decrypt(event["content"], outer_key))
        if isinstance(inner, dict) and inner.get("kind") == 13:
            seal_pubkey_hex = inner["pubkey"]
            seal_key = minipae.conversation_key(me.seckey, bytes.fromhex(seal_pubkey_hex))
            rumor = json.loads(minipae.nip44_decrypt(inner["content"], seal_key))
            from_pubkey = rumor.get("pubkey")
    except Exception:
        pass
    return content, from_pubkey


def _origin(url: str) -> str:
    """NIP-42 'relay' tag must be the bare ws(s) origin, no path -- the relay computes
    wss://<host> with an empty path, so wss://host:port/relay must be stripped to wss://host:port."""
    from urllib.parse import urlsplit
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _build_auth_event(me: Identity, relay_url: str, challenge: str) -> dict:
    """NIP-42: kind 22242, tags relay+challenge, empty content, signed by us."""
    return minipae.sign_event(22242, "", [["relay", _origin(relay_url)], ["challenge", challenge]], me.seckey)


async def _authed(ws, me: Identity, relay_url: str) -> None:
    """Catch an unsolicited AUTH challenge this relay sends right after connect (NIP-42)."""
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=2)
    except asyncio.TimeoutError:
        return
    msg = json.loads(raw)
    if msg[0] == "AUTH":
        await ws.send(json.dumps(["AUTH", _build_auth_event(me, relay_url, msg[1])]))
        await asyncio.wait_for(ws.recv(), timeout=5)  # OK for the AUTH event itself


async def cmd_listen(args) -> None:
    me = Identity.from_nsec(args.nsec)
    async with websockets.connect(args.relay, open_timeout=10, close_timeout=5) as ws:
        await _authed(ws, me, args.relay)
        req = ["REQ", "uap-sig", {"kinds": [KIND_GIFT_WRAP], "#p": [me.pubkey_hex], "since": int(time.time()) - 5}]
        await ws.send(json.dumps(req))
        _out({"event": "subscribed", "pubkey": me.pubkey_hex, "relay": args.relay})
        deadline = time.time() + args.timeout_s
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            msg = json.loads(raw)
            if msg[0] == "AUTH":
                await ws.send(json.dumps(["AUTH", _build_auth_event(me, args.relay, msg[1])]))
                continue
            if msg[0] != "EVENT":
                continue
            event = msg[2]
            try:
                content, from_pubkey = _unwrap_with_sender(event, me)
                signal = Signal.from_json(content)
                _out({"event": "signal", "signal": signal.__dict__, "signal_type": signal.type.value, "from_pubkey": from_pubkey})
            except Exception as e:
                _out({"event": "undecodable", "error": str(e)})
            if args.once:
                return


async def cmd_send_offer(args) -> None:
    me = Identity.from_nsec(args.nsec)
    callee_pubkey = minipae.npub_decode(args.callee)
    event = build_offer(me, callee_pubkey, args.sdp)
    async with websockets.connect(args.relay, open_timeout=10, close_timeout=5) as ws:
        await _authed(ws, me, args.relay)
        await ws.send(json.dumps(["EVENT", event]))
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        ack = json.loads(raw)
        if ack[0] == "AUTH":
            await ws.send(json.dumps(["AUTH", _build_auth_event(me, args.relay, ack[1])]))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps(["EVENT", event]))
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            ack = json.loads(raw)
    _out({"event": "sent", "relay_ack": ack})


async def cmd_heartbeat(args) -> None:
    me = Identity.from_nsec(args.nsec)
    event = build_heartbeat(me, [args.relay], note=args.note or "")
    async with websockets.connect(args.relay, open_timeout=10, close_timeout=5) as ws:
        await _authed(ws, me, args.relay)
        await ws.send(json.dumps(["EVENT", event]))
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        ack = json.loads(raw)
        if ack[0] == "AUTH":
            await ws.send(json.dumps(["AUTH", _build_auth_event(me, args.relay, ack[1])]))
            await asyncio.wait_for(ws.recv(), timeout=5)
            await ws.send(json.dumps(["EVENT", event]))
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            ack = json.loads(raw)
    _out({"event": "heartbeat_sent", "relay_ack": ack})


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--nsec", required=True)
    p.add_argument("--relay", required=True)
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("listen")
    s.add_argument("--once", action="store_true")
    s.add_argument("--timeout-s", type=float, default=30)
    s.set_defaults(func=cmd_listen)

    s = sub.add_parser("send-offer")
    s.add_argument("--callee", required=True)
    s.add_argument("--sdp", required=True)
    s.set_defaults(func=cmd_send_offer)

    s = sub.add_parser("heartbeat")
    s.add_argument("--note", default="")
    s.set_defaults(func=cmd_heartbeat)

    args = p.parse_args()
    asyncio.run(args.func(args))


if __name__ == "__main__":
    main()
