"""External digest-chain manifest: exporter and verifier (C1 section 4, format drawbridge.g2c1.ledger-manifest.v1).

SIMULATION ONLY. THE MANIFEST IS TAMPER DETECTION ONLY. It is a derived export. The database never reads it and no decision
depends on it. Verification never authorizes a posting or a payment.

Format. One JSON document written as canonical compact JSON (sorted keys, ASCII, no insignificant whitespace, no trailing
newline): schema, task, synthetic, allocations. Each allocation: allocation_id, event_count, head_sha256, events. Each event:
version, event_id, event_kind, amount_cents (integer), currency, authorization_id, idempotency_key, txn_id, content_digest
(hex), legs (leg_no, account_name, direction D or C, amount_cents), prev_sha256 (64 zeros for the first event of an allocation)
and sha256 = SHA-256 of the entry's canonical compact JSON WITHOUT its sha256 field. The file has its own whole-file SHA-256.
This is the chain method of the accepted E3 event chain.

What it can do: detect that an exported ledger's content, order or a link changed AFTER export (altered content, reordered,
dropped-middle, altered link), by recomputing the chain and the content digests; and detect, by comparing a fresh export with
an earlier one, that the database no longer matches what it recorded.

What it cannot do (LIMITATIONS, printed by every command so they are never overclaimed):
"""
from __future__ import annotations

import json
from pathlib import Path

from .canonical import (CanonicalError, GENESIS, KINDS, SHA_RE, TASK, canonical_compact, event_content_digest, require_cents,
                        require_ref, require_uuid, sha256_hex)
from .replay import ACCOUNTS, events_of

MANIFEST_SCHEMA = "drawbridge.g2c1.ledger-manifest.v1"

LIMITATIONS = (
    "1. The manifest prevents nothing. It is detection only.",
    "2. It is not authoritative. The database is. A discrepancy is a finding to a human, never an automatic repair, and the database never reads the manifest.",
    "3. It proves nothing about who wrote anything: a hash chain is not a signature and carries no identity, and SHA-256 chaining alone provides no external attestation.",
    "4. A party who can alter both the database and the manifest can forge both consistently. It is only as strong as the place the head digest is anchored; G2C1 anchors it only in the review's own evidence.",
    "5. Dropping events from the end of a stream is invisible unless the head digest or event count was recorded earlier and is supplied to the verifier.",
    "6. The schema owner and the scratch administrator can disable triggers and edit rows; no resistance to them is claimed.",
    "7. It says nothing about the business truth of an event. Every authorization is synthetic. Verification never authorizes posting or payment.",
)
__doc__ += "\n".join(LIMITATIONS) + "\n"

DOC_KEYS = frozenset({"schema", "task", "synthetic", "allocations"})
ALLOCATION_KEYS = frozenset({"allocation_id", "event_count", "head_sha256", "events"})
ENTRY_KEYS = frozenset({"version", "event_id", "event_kind", "amount_cents", "currency", "authorization_id", "idempotency_key",
                        "txn_id", "content_digest", "legs", "prev_sha256", "sha256"})
LEG_KEYS = frozenset({"leg_no", "account_name", "direction", "amount_cents"})
_PATTERN = {"FUNDING": (("D", "CASH_ALLOCATED"), ("C", "PROJECT_CAPITAL")),
            "FUNDING_REDUCTION": (("D", "PROJECT_CAPITAL"), ("C", "CASH_ALLOCATED"))}


def entry_digest(entry: dict) -> str:
    """SHA-256 of the entry's canonical compact JSON without its own sha256 field (it includes prev_sha256)."""
    return sha256_hex(canonical_compact({k: v for k, v in entry.items() if k != "sha256"}))


def build_manifest(snapshot) -> dict:
    """Pure function: snapshot -> manifest document. Order is (allocation_id, version)."""
    events = sorted(events_of(snapshot), key=lambda e: (e["allocation_id"], e["version"]))
    grouped: dict = {}
    for e in events:
        grouped.setdefault(e["allocation_id"], []).append(e)
    allocations = []
    for allocation_id in sorted(grouped):
        prior, entries = GENESIS, []
        for e in grouped[allocation_id]:
            entry = {
                "version": e["version"], "event_id": e["event_id"], "event_kind": e["event_kind"],
                "amount_cents": e["amount_cents"], "currency": e["currency"], "authorization_id": e["authorization_id"],
                "idempotency_key": e["idempotency_key"], "txn_id": e["txn_id"], "content_digest": e["content_digest"],
                "legs": [{"leg_no": g["leg_no"], "account_name": g["account_name"], "direction": g["direction"],
                          "amount_cents": g["amount_cents"]} for g in sorted(e["legs"], key=lambda g: g["leg_no"])],
                "prev_sha256": prior,
            }
            entry["sha256"] = prior = entry_digest(entry)
            entries.append(entry)
        allocations.append({"allocation_id": allocation_id, "event_count": len(entries), "head_sha256": prior, "events": entries})
    return {"schema": MANIFEST_SCHEMA, "task": TASK, "synthetic": True, "allocations": allocations}


def manifest_bytes(document: dict) -> bytes:
    return canonical_compact(document)


def write_manifest(document: dict, path) -> dict:
    """Exclusive create (never overwrites) of the manifest and of `<path>.sha256`. Returns the digests."""
    data = manifest_bytes(document)
    digest = sha256_hex(data)
    target = Path(path)
    with target.open("xb") as handle:
        handle.write(data)
    with Path(str(target) + ".sha256").open("xb") as handle:
        handle.write(f"{digest}  {target.name}\n".encode("ascii"))
    heads = {a["allocation_id"]: {"event_count": a["event_count"], "head_sha256": a["head_sha256"]} for a in document["allocations"]}
    return {"manifest_sha256": digest, "bytes": len(data), "heads": heads}


# --------------------------------------------------------------------------------------------------- verification
def _dup_free(pairs):
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise CanonicalError(f"duplicate JSON key {key!r}")
        out[key] = value
    return out


def _no_constant(name):
    raise CanonicalError(f"non-finite constant {name}")


def _no_float(text):
    raise CanonicalError(f"JSON number with fraction or exponent {text}")


def parse_manifest(data: bytes):
    try:
        return json.loads(bytes(data).decode("utf-8"), object_pairs_hook=_dup_free, parse_constant=_no_constant,
                          parse_float=_no_float)
    except CanonicalError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise CanonicalError(f"not valid JSON: {exc}") from exc


def _verify_allocation(index: int, alloc, failures: list) -> None:
    def fail(code: str, event_index: int | None = None, **detail) -> None:
        failures.append({"code": code, "allocation_index": index, "event_index": event_index, **detail})

    if type(alloc) is not dict or set(alloc) != ALLOCATION_KEYS:
        fail("ALLOCATION_KEYS")
        return
    try:
        require_uuid(alloc["allocation_id"], "allocation_id")
    except CanonicalError:
        fail("ALLOCATION_ID")
        return
    events = alloc["events"]
    if type(events) is not list or not events or type(alloc["event_count"]) is not int or alloc["event_count"] != len(events):
        fail("EVENT_COUNT", declared=alloc["event_count"] if type(alloc["event_count"]) is int else None)
        return
    prior = GENESIS
    for i, entry in enumerate(events):
        if type(entry) is not dict or set(entry) != ENTRY_KEYS:
            fail("ENTRY_KEYS", i)
            return
        try:
            if type(entry["version"]) is not int or entry["version"] != i + 1:
                raise CanonicalError("version")
            require_uuid(entry["event_id"], "event_id")
            require_uuid(entry["txn_id"], "txn_id")
            require_ref(entry["authorization_id"], "authorization_id")
            require_ref(entry["idempotency_key"], "idempotency_key")
            if entry["event_kind"] not in KINDS or entry["currency"] != "USD":
                raise CanonicalError("kind or currency")
            require_cents(entry["amount_cents"], "amount_cents", allow_zero=False)
            for field in ("content_digest", "prev_sha256", "sha256"):
                if type(entry[field]) is not str or SHA_RE.fullmatch(entry[field]) is None:
                    raise CanonicalError(field)
        except CanonicalError as exc:
            fail("ENTRY_FIELD", i, field=str(exc))
            return
        if event_content_digest(alloc["allocation_id"], entry["event_kind"], entry["amount_cents"], entry["currency"],
                                entry["authorization_id"], entry["idempotency_key"]) != entry["content_digest"]:
            fail("CONTENT_DIGEST", i)
            return
        legs = entry["legs"]
        pattern = _PATTERN[entry["event_kind"]]
        ok = type(legs) is list and len(legs) == 2
        if ok:
            for leg, (direction, account) in zip(legs, pattern):
                ok = ok and type(leg) is dict and set(leg) == LEG_KEYS and leg["direction"] == direction \
                    and leg["account_name"] == account and leg["account_name"] in ACCOUNTS \
                    and type(leg["amount_cents"]) is int and leg["amount_cents"] == entry["amount_cents"] \
                    and type(leg["leg_no"]) is int and leg["leg_no"] in (1, 2)
            ok = ok and legs[0]["leg_no"] == 1 and legs[1]["leg_no"] == 2
        if not ok:
            fail("LEG_PATTERN", i)
            return
        if entry["prev_sha256"] != prior:
            fail("LINK", i, expected_prev=prior, found_prev=entry["prev_sha256"])
            return
        if entry_digest(entry) != entry["sha256"]:
            fail("ENTRY_DIGEST", i)
            return
        prior = entry["sha256"]
    if alloc["head_sha256"] != prior:
        fail("HEAD", len(events) - 1, expected_head=prior, found_head=alloc["head_sha256"])


def verify_manifest(data: bytes, *, expected_file_sha256: str | None = None, expected_heads: dict | None = None,
                    expected_counts: dict | None = None) -> dict:
    """Verify a manifest. Returns {ok, failures, notes, limitations}. Never raises for a defect in the manifest.

    expected_heads / expected_counts map allocation_id to a head digest / event count recorded EARLIER and independently; they are
    the only way a dropped tail can be detected."""
    failures: list = []
    notes: list = []
    result = {"ok": False, "failures": failures, "notes": notes, "limitations": list(LIMITATIONS)}
    if expected_file_sha256 is not None and sha256_hex(bytes(data)) != expected_file_sha256:
        failures.append({"code": "FILE_SHA256", "allocation_index": None, "event_index": None})
    try:
        doc = parse_manifest(data)
    except CanonicalError as exc:
        failures.append({"code": "UNPARSEABLE", "allocation_index": None, "event_index": None, "detail": str(exc)})
        return result
    if type(doc) is not dict or set(doc) != DOC_KEYS or doc["schema"] != MANIFEST_SCHEMA or doc["task"] != TASK \
            or doc["synthetic"] is not True or type(doc["allocations"]) is not list:
        failures.append({"code": "DOCUMENT", "allocation_index": None, "event_index": None})
        return result
    try:
        if canonical_compact(doc) != bytes(data):
            failures.append({"code": "NOT_CANONICAL", "allocation_index": None, "event_index": None})
    except CanonicalError:
        failures.append({"code": "NOT_CANONICAL", "allocation_index": None, "event_index": None})
    ids = [a.get("allocation_id") if type(a) is dict else None for a in doc["allocations"]]
    if ids != sorted(ids, key=str) or len(ids) != len(set(map(str, ids))):
        failures.append({"code": "ALLOCATION_ORDER", "allocation_index": None, "event_index": None})
    for index, alloc in enumerate(doc["allocations"]):
        try:
            _verify_allocation(index, alloc, failures)
        except (TypeError, KeyError, ValueError, AttributeError, RecursionError) as exc:
            # Defence in depth (LOOM-2 V01 F-6): a malformed value that no explicit check anticipated is a defined FAILURE, never a
            # raised exception and never a PASS.
            failures.append({"code": "MALFORMED_ALLOCATION", "allocation_index": index, "event_index": None,
                             "detail": type(exc).__name__})
    # Only string identifiers can be looked up; an unhashable or non-string allocation_id was already reported above
    # (ALLOCATION_ID / ALLOCATION_ORDER) and cannot satisfy an anchor.
    by_id = {a["allocation_id"]: a for a in doc["allocations"]
             if type(a) is dict and type(a.get("allocation_id")) is str}
    for name, expected, field in (("heads", expected_heads, "head_sha256"), ("counts", expected_counts, "event_count")):
        if expected is None:
            continue
        for allocation_id, value in sorted(expected.items()):
            alloc = by_id.get(allocation_id)
            if alloc is None or alloc.get(field) != value:
                failures.append({"code": "HEAD_MISMATCH" if name == "heads" else "COUNT_MISMATCH", "allocation_index": None,
                                 "event_index": None, "allocation_id": allocation_id})
    if expected_heads is None and expected_counts is None:
        notes.append("NO_ANCHOR: no earlier head digest or event count was supplied, so a dropped tail is NOT detectable here.")
    result["ok"] = not failures
    return result


def read_sidecar(path) -> str:
    text = Path(str(path) + ".sha256").read_text(encoding="ascii").strip()
    digest = text.split()[0] if text else ""
    if SHA_RE.fullmatch(digest) is None:
        raise CanonicalError("sidecar: malformed digest")
    return digest
