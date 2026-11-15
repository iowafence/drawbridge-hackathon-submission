"""Bounded retry for the two posting functions (C1-A1 section 5, SIM-ENG-003-G2C1-A1 section 3 item 2).

SIMULATION ONLY. Driver-neutral: it inspects an exception for `sqlstate` (or `pgcode`) and a unique-violation constraint name
(`diag.constraint_name`, `constraint_name`, or the text of `PsqlError`). It never connects to anything.

Rules, all from the accepted records:
  * at most 3 attempts IN TOTAL (one initial, two retries); each attempt re-executes the WHOLE function from its first step;
    there is no mid-protocol resume and no provider retry;
  * 40001 (serialization failure) is retried inside that bound;
  * 23505 is retried ONLY when it names one of the three expected unique constraints (a lost race that SERIALIZABLE may surface
    as a unique violation instead of 40001); any other 23505 is a DEFECT, is not retried and is re-raised unchanged;
  * every other error is final and is re-raised unchanged;
  * on exhaustion the final SQLSTATE is recorded as a finding; no new application error code is created;
  * the loop is a bounded `for`: there is no unbounded retry.

Which of 23505 and 40001 a race raises is NOT VERIFIED until observed against the real cluster (C1-A1 section 5).
"""
from __future__ import annotations

import re
from typing import Callable

MAX_ATTEMPTS = 3
RETRIABLE_UNIQUE_CONSTRAINTS = frozenset({
    "journal_txn_idempotency_key_uk",           # UNIQUE (idempotency_key)
    "journal_txn_posting_identity_uk",          # UNIQUE (posting_identity, identity_generation)
    "allocation_event_allocation_version_uk",   # UNIQUE (allocation_id, version)
})
SERIALIZATION_FAILURE = "40001"
UNIQUE_VIOLATION = "23505"

_CONSTRAINT_RE = re.compile(r'unique constraint "([^"]+)"')


class RetryExhausted(Exception):
    """All attempts were used. `final_sqlstate` and `attempts` are the finding; the last error is __cause__."""

    def __init__(self, attempts: list, final_sqlstate: str | None):
        super().__init__(f"retry exhausted after {len(attempts)} attempts; final SQLSTATE {final_sqlstate}")
        self.attempts = attempts
        self.final_sqlstate = final_sqlstate


class PsqlError(Exception):
    """An error reported by psql, parsed from its text. `sqlstate` is the five-character code."""

    def __init__(self, sqlstate: str, message: str):
        super().__init__(f"{sqlstate}: {message}")
        self.sqlstate = sqlstate
        self.message = message
        self.constraint_name = extract_constraint_name(message)


def extract_constraint_name(message: str) -> str | None:
    found = _CONSTRAINT_RE.search(message or "")
    return found.group(1) if found else None


def sqlstate_of(exc: BaseException) -> str | None:
    value = getattr(exc, "sqlstate", None) or getattr(exc, "pgcode", None)
    return value if isinstance(value, str) else None


def constraint_of(exc: BaseException) -> str | None:
    diag = getattr(exc, "diag", None)
    name = getattr(diag, "constraint_name", None) if diag is not None else None
    name = name or getattr(exc, "constraint_name", None)
    return name if isinstance(name, str) else None


def classify(exc: BaseException) -> str:
    """RETRY, DEFECT_UNEXPECTED_UNIQUE or FINAL."""
    state = sqlstate_of(exc)
    if state == SERIALIZATION_FAILURE:
        return "RETRY"
    if state == UNIQUE_VIOLATION:
        return "RETRY" if constraint_of(exc) in RETRIABLE_UNIQUE_CONSTRAINTS else "DEFECT_UNEXPECTED_UNIQUE"
    return "FINAL"


def call_with_bounded_retry(operation: Callable[[int], object], *, max_attempts: int = MAX_ATTEMPTS):
    """Run `operation(attempt_number)` as a whole, at most `max_attempts` times in total (never more than MAX_ATTEMPTS).

    Returns the operation's result. Raises the original exception for a FINAL or unexpected-unique error, or RetryExhausted
    when every attempt was retriable. The attempt log is attached to RetryExhausted."""
    if type(max_attempts) is not int or not 1 <= max_attempts <= MAX_ATTEMPTS:
        raise ValueError(f"max_attempts must be an integer from 1 to {MAX_ATTEMPTS}")
    log: list = []
    last: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return operation(attempt)
        except Exception as exc:  # noqa: BLE001 - classified below; anything not retriable is re-raised unchanged
            verdict = classify(exc)
            log.append({"attempt": attempt, "sqlstate": sqlstate_of(exc), "constraint": constraint_of(exc), "verdict": verdict})
            if verdict != "RETRY":
                raise
            last = exc
    raise RetryExhausted(log, sqlstate_of(last) if last is not None else None) from last
