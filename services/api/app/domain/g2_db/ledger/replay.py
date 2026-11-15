"""Read-only replay of allocation balances from committed journal events (C1 D-14, C1-A1 C-11f).

SIMULATION ONLY. This module computes; it decides nothing and posts nothing. It never connects to a database: its input is the
snapshot document that snapshot.fetch_snapshot() reads from the three drawbridge_read views in ONE read-only snapshot.

Order is (allocation_id, version). The output is canonical JSON (sorted keys, ASCII, no insignificant whitespace) with no
timestamp, no transaction id and no host fact, so two runs on the same committed ledger, and a run before and after a clean
restart, are byte-identical. Malformed input is refused (ReplayError); discrepancies between the replay and the ledger are the
business of reconcile.py, which reports them and never repairs them.
"""
from __future__ import annotations

from .canonical import (CanonicalError, KINDS, TASK, canonical_compact, require_cents, require_ref, require_uuid, sha256_hex,
                        SHA_RE)

REPLAY_SCHEMA = "drawbridge.g2c1.replay.v1"
ACCOUNTS = ("CASH_ALLOCATED", "DISBURSED", "PROJECT_CAPITAL")
NORMAL_BALANCE = {"CASH_ALLOCATED": "D", "DISBURSED": "D", "PROJECT_CAPITAL": "C"}
EVENT_KEYS = frozenset({"allocation_id", "version", "event_id", "project_id", "event_kind", "amount_cents", "currency",
                        "authorization_id", "idempotency_key", "txn_id", "content_digest", "posting_identity",
                        "identity_generation", "legs"})
LEG_KEYS = frozenset({"leg_no", "account_name", "direction", "amount_cents"})


class ReplayError(CanonicalError):
    """The snapshot cannot be replayed because a row is malformed. Nothing is skipped or repaired."""


def _int(value, what: str, low: int = 0) -> int:
    if type(value) is not int or value < low:
        raise ReplayError(f"{what}: integer >= {low} required")
    return value


def validate_event(row) -> dict:
    """Strict shape of one ledger_event_stream row. Unknown or missing keys are errors."""
    if type(row) is not dict or set(row) != EVENT_KEYS:
        raise ReplayError(f"event row: keys must be exactly {sorted(EVENT_KEYS)}")
    try:
        require_uuid(row["allocation_id"], "allocation_id")
        require_uuid(row["event_id"], "event_id")
        require_uuid(row["project_id"], "project_id")
        require_uuid(row["txn_id"], "txn_id")
        require_ref(row["authorization_id"], "authorization_id")
        require_ref(row["idempotency_key"], "idempotency_key")
    except CanonicalError as exc:
        raise ReplayError(str(exc)) from exc
    _int(row["version"], "version", 1)
    if row["event_kind"] not in KINDS:
        raise ReplayError(f"event_kind: unknown kind {row['event_kind']!r}")
    try:
        require_cents(row["amount_cents"], "amount_cents", allow_zero=False)
    except CanonicalError as exc:
        raise ReplayError(str(exc)) from exc
    if row["currency"] != "USD":
        raise ReplayError("currency: USD only")
    if type(row["content_digest"]) is not str or SHA_RE.fullmatch(row["content_digest"]) is None:
        raise ReplayError("content_digest: 64 lower-case hex characters required")
    if type(row["posting_identity"]) is not str or type(row["identity_generation"]) is not int:
        raise ReplayError("posting identity fields malformed")
    legs = row["legs"]
    if type(legs) is not list:
        raise ReplayError("legs: list required")
    for leg in legs:
        if type(leg) is not dict or set(leg) != LEG_KEYS:
            raise ReplayError(f"leg: keys must be exactly {sorted(LEG_KEYS)}")
        _int(leg["leg_no"], "leg_no", 1)
        if leg["account_name"] not in ACCOUNTS or leg["direction"] not in ("D", "C"):
            raise ReplayError("leg: unknown account or direction")
        _int(leg["amount_cents"], "leg amount_cents", 1)
    return row


def balances_from_legs(events: list) -> dict:
    """Account balances (normal-balance signed, in cents) rebuilt from the legs of the given events."""
    debit = {name: 0 for name in ACCOUNTS}
    credit = {name: 0 for name in ACCOUNTS}
    for event in events:
        for leg in event["legs"]:
            (debit if leg["direction"] == "D" else credit)[leg["account_name"]] += leg["amount_cents"]
    return {name: (debit[name] - credit[name]) if NORMAL_BALANCE[name] == "D" else (credit[name] - debit[name])
            for name in ACCOUNTS}


def events_of(snapshot) -> list:
    if type(snapshot) is not dict or type(snapshot.get("events")) is not list:
        raise ReplayError("snapshot: an 'events' list is required")
    return [validate_event(row) for row in snapshot["events"]]


def replay(snapshot) -> dict:
    """Rebuild each allocation's balances and event list from the committed events. Pure function."""
    events = events_of(snapshot)
    ordered = sorted(events, key=lambda e: (e["allocation_id"], e["version"]))
    keys = [(e["allocation_id"], e["version"]) for e in ordered]
    if len(keys) != len(set(keys)):
        raise ReplayError("two events share one (allocation_id, version)")
    by_allocation: dict = {}
    for event in ordered:
        by_allocation.setdefault(event["allocation_id"], []).append(event)
    allocations = []
    for allocation_id in sorted(by_allocation):
        stream = by_allocation[allocation_id]
        versions = [e["version"] for e in stream]
        last = versions[-1]
        allocations.append({
            "allocation_id": allocation_id,
            "event_count": len(stream),
            "head_version": last,
            "version_gaps": [v for v in range(1, last + 1) if v not in set(versions)],
            "balances": balances_from_legs(stream),
            "events": [{"version": e["version"], "event_id": e["event_id"], "event_kind": e["event_kind"],
                        "amount_cents": e["amount_cents"], "txn_id": e["txn_id"], "content_digest": e["content_digest"]}
                       for e in stream],
        })
    return {"schema": REPLAY_SCHEMA, "task": TASK, "synthetic": True, "allocations": allocations}


def replay_bytes(document: dict) -> bytes:
    return canonical_compact(document)


def replay_sha256(document: dict) -> str:
    return sha256_hex(replay_bytes(document))
