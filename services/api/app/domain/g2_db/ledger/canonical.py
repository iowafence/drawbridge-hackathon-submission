"""Shared canonical serialization, money parsing and the C1 D-8 content digest (SIM-ENG-003-G2C1).

SIMULATION ONLY. Synthetic data only. Pure functions: no database, no network, no clock, no randomness, no file access.

Money is handled as Decimal text or integer cents; a binary float is refused everywhere (G1S 10.1, MONEY-M02).
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from decimal import Decimal, Inexact, InvalidOperation, localcontext

TASK = "SIM-ENG-003-G2C1"
CURRENCY = "USD"
GENESIS = "0" * 64

# G1S 10.1 limits, in integer cents (limit D: |m| <= 2**53 - 1 == MAX_BALANCE_ABS x 100).
MAX_TXN_CENTS = 9_999_999_999_999            # 99,999,999,999.99
MAX_BALANCE_CENTS = 9_007_199_254_740_991    # 90,071,992,547,409.91

REF_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")   # C1 D-8: the delimiter '|' cannot occur
SHA_RE = re.compile(r"[0-9a-f]{64}")
KINDS = ("FUNDING", "FUNDING_REDUCTION")


class CanonicalError(ValueError):
    """Input refused. Nothing is defaulted, coerced or repaired."""


def canonical_compact(obj) -> bytes:
    """Sorted keys, ASCII only, no insignificant whitespace, no NaN or Infinity."""
    try:
        return json.dumps(obj, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
    except (TypeError, ValueError) as exc:
        raise CanonicalError(f"not canonically serializable: {exc}") from exc


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require_uuid(value, what: str) -> str:
    """Lower-case hyphenated UUID text, exactly as PostgreSQL renders a uuid."""
    if type(value) is not str:
        raise CanonicalError(f"{what}: uuid text required")
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise CanonicalError(f"{what}: malformed uuid") from exc
    if str(parsed) != value:
        raise CanonicalError(f"{what}: uuid must be lower-case hyphenated")
    return value


def require_ref(value, what: str) -> str:
    if type(value) is not str or REF_RE.fullmatch(value) is None:
        raise CanonicalError(f"{what}: malformed reference")
    return value


def require_cents(value, what: str, *, maximum: int = MAX_BALANCE_CENTS, allow_zero: bool = True) -> int:
    """Integer cents. bool, float, str and Decimal are refused."""
    if type(value) is not int:
        raise CanonicalError(f"{what}: integer cents required, got {type(value).__name__}")
    if value < (0 if allow_zero else 1) or value > maximum:
        raise CanonicalError(f"{what}: cents out of range: {value}")
    return value


def money_text_to_cents(text) -> int:
    """Exact cents from decimal text with at most two decimals. Never rounds, never uses a float."""
    if type(text) is not str:
        raise CanonicalError(f"money text required, got {type(text).__name__}")
    if re.fullmatch(r"[0-9]{1,15}(\.[0-9]{1,2})?", text) is None:
        raise CanonicalError(f"malformed money text: {text!r}")
    with localcontext() as ctx:
        ctx.prec = 40
        ctx.traps[Inexact] = True
        ctx.traps[InvalidOperation] = True
        cents = Decimal(text).scaleb(2)
        if cents != cents.to_integral_value():
            raise CanonicalError(f"more than two decimals: {text!r}")
        return int(cents)


def cents_to_money_text(cents: int) -> str:
    """Text for signed integer cents (a derived balance may be negative)."""
    if type(cents) is not int or abs(cents) > MAX_BALANCE_CENTS * 2:
        raise CanonicalError("cents_to_money_text: signed integer cents within range required")
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return f"{sign}{whole}.{frac:02d}"


def event_content_digest(allocation_id: str, event_kind: str, amount_cents: int, currency: str,
                         authorization_id: str, idempotency_key: str) -> str:
    """C1 D-8: SHA-256 of the UTF-8 text
    G2C1-EVT-V1|allocation_id|event_kind|amount_cents|currency|authorization_id|idempotency_key
    Version, ids and times are not in the digest: it identifies the CLAIM. Identical to drawbridge_auth.g2c1_event_digest."""
    require_uuid(allocation_id, "allocation_id")
    if event_kind not in KINDS:
        raise CanonicalError(f"event_kind: unknown kind {event_kind!r}")
    require_cents(amount_cents, "amount_cents", maximum=MAX_TXN_CENTS, allow_zero=False)
    if currency != CURRENCY:
        raise CanonicalError("currency: USD only")
    require_ref(authorization_id, "authorization_id")
    require_ref(idempotency_key, "idempotency_key")
    text = "|".join(["G2C1-EVT-V1", allocation_id, event_kind, str(amount_cents), currency, authorization_id, idempotency_key])
    return sha256_hex(text.encode("utf-8"))
