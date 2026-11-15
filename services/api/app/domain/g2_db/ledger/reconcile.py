"""Read-only ledger reconciliation R1..R9 (C1 D-15, C1-A1 C-11f) plus one supplementary identity check (X1).

SIMULATION ONLY. Pure functions over the snapshot that snapshot.fetch_snapshot() reads in ONE read-only snapshot. This module
reports PASS or an explicit list of discrepancies. It never repairs, never adjusts a balance and never writes anything; it has
no database access and no authority. A discrepancy is a finding for a human.

  R1 event count equals the number of funding-kind journal transactions
  R2 each event pairs with exactly one transaction of the same allocation, kind and amount
  R3 each transaction has exactly two legs in the exact pattern of its kind
  R4 debits equal credits per allocation (and per transaction)
  R5 account balances from the ledger equal the net of the events (funding less reductions), and equal the balances
     rebuilt from the event legs, for CASH_ALLOCATED and PROJECT_CAPITAL
  R6 versions run 1..n without a gap or a duplicate
  R7 each stored content digest equals the digest recomputed from the row (C1 D-8)
  R8 CASH_ALLOCATED is not negative   (slice-local narrowing, C1-A1 E-2: replaced, not carried, by later slices)
  R9 DISBURSED is zero
  X1 no idempotency key and no posting identity is shared by two events (supplementary; not part of D-15)
"""
from __future__ import annotations

from .canonical import KINDS, event_content_digest
from .replay import ACCOUNTS, ReplayError, balances_from_legs, events_of

CHECKS = ("R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "X1")
RECON_KEYS = frozenset({"txn_id", "txn_allocation_id", "txn_kind", "txn_amount_cents", "posting_identity", "txn_idempotency_key",
                        "leg_count", "debit_cents", "credit_cents", "pattern_leg_count", "event_id", "event_allocation_id",
                        "event_version", "event_kind", "event_amount_cents"})
BALANCE_KEYS = frozenset({"project_id", "allocation_id", "account_name", "normal_balance", "debit_cents", "credit_cents",
                          "balance_cents", "leg_count"})


class ReconcileError(ValueError):
    """The snapshot is structurally unusable (not a discrepancy of the ledger)."""


def _rows(snapshot, key: str, keys: frozenset) -> list:
    if type(snapshot) is not dict or type(snapshot.get(key)) is not list:
        raise ReconcileError(f"snapshot: a '{key}' list is required")
    for row in snapshot[key]:
        if type(row) is not dict or set(row) != keys:
            raise ReconcileError(f"{key} row: keys must be exactly {sorted(keys)}")
    return snapshot[key]


def reconcile(snapshot, *, require_snapshot_proof: bool = False) -> dict:
    try:
        events = events_of(snapshot)
    except ReplayError as exc:
        raise ReconcileError(str(exc)) from exc
    recon = _rows(snapshot, "reconciliation", RECON_KEYS)
    balances = _rows(snapshot, "balances", BALANCE_KEYS)
    found: list = []

    def add(check: str, code: str, **detail) -> None:
        found.append({"check": check, "code": code, **detail})

    if require_snapshot_proof:
        if snapshot.get("txn_read_only") != "on" or snapshot.get("txn_isolation") != "repeatable read":
            add("SNAPSHOT", "SNAPSHOT_PROOF_MISSING", txn_read_only=snapshot.get("txn_read_only"),
                txn_isolation=snapshot.get("txn_isolation"))

    # R1
    funding_txns = [r for r in recon if r["txn_kind"] in KINDS]
    if len(events) != len(funding_txns):
        add("R1", "EVENT_COUNT_MISMATCH", events=len(events), funding_transactions=len(funding_txns))

    # R2
    event_ids = [e["event_id"] for e in events]
    recon_by_event: dict = {}
    for row in recon:
        if row["event_id"] is not None:
            recon_by_event.setdefault(row["event_id"], []).append(row)
        if row["txn_kind"] is None and row["event_id"] is not None:
            add("R2", "EVENT_WITHOUT_TRANSACTION", event_id=row["event_id"], txn_id=row["txn_id"])
        elif row["txn_kind"] is not None and row["event_id"] is None:
            add("R2", "TRANSACTION_WITHOUT_EVENT", txn_id=row["txn_id"])
        elif row["txn_kind"] is not None:
            if (row["event_allocation_id"] != row["txn_allocation_id"] or row["event_kind"] != row["txn_kind"]
                    or row["event_amount_cents"] != row["txn_amount_cents"]):
                add("R2", "EVENT_TRANSACTION_MISMATCH", event_id=row["event_id"], txn_id=row["txn_id"])
    for event_id in event_ids:
        if len(recon_by_event.get(event_id, [])) != 1:
            add("R2", "EVENT_PAIRING_NOT_ONE", event_id=event_id, pairs=len(recon_by_event.get(event_id, [])))

    # R3 and the per-transaction half of R4
    for row in recon:
        if row["txn_kind"] is None:
            continue
        if row["leg_count"] != 2 or row["pattern_leg_count"] != 2:
            add("R3", "LEG_PATTERN_INVALID", txn_id=row["txn_id"], legs=row["leg_count"], pattern_legs=row["pattern_leg_count"])
        if row["debit_cents"] != row["credit_cents"] or row["debit_cents"] != row["txn_amount_cents"]:
            add("R4", "TRANSACTION_IMBALANCE", txn_id=row["txn_id"], debit_cents=row["debit_cents"],
                credit_cents=row["credit_cents"], total_cents=row["txn_amount_cents"])

    # R4 per allocation
    debit: dict = {}
    credit: dict = {}
    for b in balances:
        debit[b["allocation_id"]] = debit.get(b["allocation_id"], 0) + b["debit_cents"]
        credit[b["allocation_id"]] = credit.get(b["allocation_id"], 0) + b["credit_cents"]
    for allocation_id in sorted(set(debit) | set(credit)):
        if debit.get(allocation_id, 0) != credit.get(allocation_id, 0):
            add("R4", "ALLOCATION_IMBALANCE", allocation_id=allocation_id, debit_cents=debit.get(allocation_id, 0),
                credit_cents=credit.get(allocation_id, 0))

    # R5 and R8, R9
    by_allocation: dict = {}
    for e in events:
        by_allocation.setdefault(e["allocation_id"], []).append(e)
    ledger_balance = {(b["allocation_id"], b["account_name"]): b["balance_cents"] for b in balances}
    for b in balances:
        if b["account_name"] not in ACCOUNTS:
            add("R5", "UNEXPECTED_ACCOUNT", allocation_id=b["allocation_id"], account_name=b["account_name"])
    for allocation_id in sorted(set(by_allocation) | {b["allocation_id"] for b in balances}):
        stream = by_allocation.get(allocation_id, [])
        net = sum(e["amount_cents"] if e["event_kind"] == "FUNDING" else -e["amount_cents"] for e in stream)
        from_legs = balances_from_legs(stream)
        for account in ("CASH_ALLOCATED", "PROJECT_CAPITAL"):
            have = ledger_balance.get((allocation_id, account), 0)
            if have != net:
                add("R5", "BALANCE_NOT_NET_OF_EVENTS", allocation_id=allocation_id, account_name=account, ledger_cents=have,
                    event_net_cents=net)
            if from_legs[account] != have:
                add("R5", "BALANCE_NOT_EVENT_LEGS", allocation_id=allocation_id, account_name=account, ledger_cents=have,
                    event_legs_cents=from_legs[account])
        cash = ledger_balance.get((allocation_id, "CASH_ALLOCATED"), 0)
        if cash < 0 or net < 0:
            add("R8", "CASH_NEGATIVE", allocation_id=allocation_id, ledger_cents=cash, event_net_cents=net)
        disbursed = ledger_balance.get((allocation_id, "DISBURSED"), 0)
        if disbursed != 0 or from_legs["DISBURSED"] != 0:
            add("R9", "DISBURSED_NONZERO", allocation_id=allocation_id, ledger_cents=disbursed,
                event_legs_cents=from_legs["DISBURSED"])

    # R6
    for allocation_id, stream in sorted(by_allocation.items()):
        versions = sorted(e["version"] for e in stream)
        if len(versions) != len(set(versions)):
            add("R6", "VERSION_DUPLICATE", allocation_id=allocation_id)
        expected = list(range(1, len(set(versions)) + 1))
        if sorted(set(versions)) != expected:
            add("R6", "VERSION_GAP", allocation_id=allocation_id, versions=sorted(set(versions)))

    # R7
    for e in events:
        recomputed = event_content_digest(e["allocation_id"], e["event_kind"], e["amount_cents"], e["currency"],
                                          e["authorization_id"], e["idempotency_key"])
        if recomputed != e["content_digest"]:
            add("R7", "CONTENT_DIGEST_MISMATCH", event_id=e["event_id"], version=e["version"])

    # X1
    for field, code in (("idempotency_key", "IDEMPOTENCY_KEY_SHARED"), ("posting_identity", "POSTING_IDENTITY_SHARED")):
        seen: dict = {}
        for e in events:
            key = (e[field], e["identity_generation"]) if field == "posting_identity" else e[field]
            seen.setdefault(key, []).append(e["event_id"])
        for key, ids in sorted(seen.items(), key=lambda item: str(item[0])):
            if len(ids) > 1:
                add("X1", code, value=str(key), event_ids=sorted(ids))

    status = {check: "PASS" for check in CHECKS}
    for d in found:
        if d["check"] in status:
            status[d["check"]] = "DISCREPANCY"
    return {"outcome": "PASS" if not found else "DISCREPANCIES", "checks": status, "discrepancies": found,
            "counts": {"events": len(events), "transactions": len(recon), "accounts": len(balances)}}
