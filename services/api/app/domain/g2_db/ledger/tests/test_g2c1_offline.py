"""Developer-side OFFLINE tests for the G2C1 funding-ledger tooling (SIM-ENG-003-G2C1). SIMULATION ONLY.

These tests never open a database connection and never execute SQL. They are the builder's own checks, NOT independent
acceptance: LOOM-2 writes and runs the acceptance tests. Everything that needs PostgreSQL is in db_cases.py and is NOT RUN.

Run from an external workspace (never with the repository as working directory):
    python3 -I -B -m unittest discover -s <workspace>/services/api/app/domain/g2_db/ledger/tests -p 'test_g2c1_offline.py'
"""
import copy
import hashlib
import os
import stat
import json
import re
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
G2DB = HERE.parents[1]
ROOT = HERE.parents[6]
sys.path.insert(0, str(G2DB))

from ledger import canonical, manifest, reconcile, replay, retry, snapshot, static_lint  # noqa: E402

MIGRATION = ROOT / "db/migrations/0011_g2c1_funding_ledger.sql"
RUNNER = G2DB / "tools/g2c1_durable_cluster.sh"
FIXTURE = ROOT / "fixtures/g2c1_synthetic.json"
NS = uuid.UUID("c2c10000-0000-4000-8000-000000000001")


def fx() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def u(label: str) -> str:
    return str(uuid.uuid5(NS, label))


def build_snapshot(sequences=None) -> dict:
    """A pure-Python model of what the three views return for a clean ledger built from the fixture sequences."""
    doc = fx()
    project = doc["project"]["project_id"]
    events, recon, accounts = [], [], {}
    for seq in sequences if sequences is not None else doc["sequences"]:
        alloc = seq["allocation_id"]
        for version, op in enumerate(seq["operations"], 1):
            kind = "FUNDING" if op["op"] == "post_funding" else "FUNDING_REDUCTION"
            cents = canonical.money_text_to_cents(op["amount"])
            txn, event = u(f"txn-{alloc}-{version}"), u(f"event-{alloc}-{version}")
            debit, credit = ("CASH_ALLOCATED", "PROJECT_CAPITAL") if kind == "FUNDING" else ("PROJECT_CAPITAL", "CASH_ALLOCATED")
            identity = ("FUNDING:" if kind == "FUNDING" else "REDUCTION:") + op["authorization_id"]
            events.append({
                "allocation_id": alloc, "version": version, "event_id": event, "project_id": project, "event_kind": kind,
                "amount_cents": cents, "currency": "USD", "authorization_id": op["authorization_id"],
                "idempotency_key": op["idempotency_key"], "txn_id": txn,
                "content_digest": canonical.event_content_digest(alloc, kind, cents, "USD", op["authorization_id"], op["idempotency_key"]),
                "posting_identity": identity, "identity_generation": 1,
                "legs": [{"leg_no": 1, "account_name": debit, "direction": "D", "amount_cents": cents},
                         {"leg_no": 2, "account_name": credit, "direction": "C", "amount_cents": cents}],
            })
            recon.append({"txn_id": txn, "txn_allocation_id": alloc, "txn_kind": kind, "txn_amount_cents": cents,
                          "posting_identity": identity, "txn_idempotency_key": op["idempotency_key"], "leg_count": 2,
                          "debit_cents": cents, "credit_cents": cents, "pattern_leg_count": 2, "event_id": event,
                          "event_allocation_id": alloc, "event_version": version, "event_kind": kind, "event_amount_cents": cents})
            for name, direction in ((debit, "D"), (credit, "C")):
                acc = accounts.setdefault((alloc, name), {"debit": 0, "credit": 0, "legs": 0})
                acc["debit" if direction == "D" else "credit"] += cents
                acc["legs"] += 1
    balances = []
    for (alloc, name), a in sorted(accounts.items()):
        normal = "C" if name == "PROJECT_CAPITAL" else "D"
        balances.append({"project_id": project, "allocation_id": alloc, "account_name": name, "normal_balance": normal,
                         "debit_cents": a["debit"], "credit_cents": a["credit"],
                         "balance_cents": (a["credit"] - a["debit"]) if normal == "C" else (a["debit"] - a["credit"]), "leg_count": a["legs"]})
    for alloc in {e["allocation_id"] for e in events}:
        if (alloc, "DISBURSED") not in accounts:
            balances.append({"project_id": project, "allocation_id": alloc, "account_name": "DISBURSED", "normal_balance": "D",
                             "debit_cents": 0, "credit_cents": 0, "balance_cents": 0, "leg_count": 0})
    balances.sort(key=lambda b: (b["allocation_id"], b["account_name"]))
    return {"txn_read_only": "on", "txn_isolation": "repeatable read", "events": events, "balances": balances,
            "reconciliation": sorted(recon, key=lambda r: r["txn_id"])}


def codes(result) -> set:
    return {d["code"] for d in result["discrepancies"]}


class Canonical(unittest.TestCase):
    def test_digest_matches_an_independent_computation(self):
        alloc = "c2c10000-0000-4000-8000-0000000000b1"
        text = "G2C1-EVT-V1|c2c10000-0000-4000-8000-0000000000b1|FUNDING|50000000|USD|G2C1-AUTH-0001|G2C1-IDEM-0001"
        self.assertEqual(canonical.event_content_digest(alloc, "FUNDING", 50_000_000, "USD", "G2C1-AUTH-0001", "G2C1-IDEM-0001"),
                         hashlib.sha256(text.encode("utf-8")).hexdigest())

    def test_digest_binds_every_claim_field(self):
        base = ("c2c10000-0000-4000-8000-0000000000b1", "FUNDING", 100, "USD", "A-1", "K-1")
        seen = {canonical.event_content_digest(*base)}
        for i, other in enumerate(("c2c10000-0000-4000-8000-0000000000b2", "FUNDING_REDUCTION", 101, None, "A-2", "K-2")):
            if other is None:
                continue
            args = list(base)
            args[i] = other
            seen.add(canonical.event_content_digest(*args))
        self.assertEqual(len(seen), 6)

    def test_digest_refuses_malformed_claims(self):
        a = "c2c10000-0000-4000-8000-0000000000b1"
        for args in ((a, "SETTLEMENT", 100, "USD", "A", "K"), (a, "FUNDING", 0, "USD", "A", "K"), (a, "FUNDING", 100.0, "USD", "A", "K"),
                     (a, "FUNDING", True, "USD", "A", "K"), (a, "FUNDING", 100, "EUR", "A", "K"), (a, "FUNDING", 100, "USD", "A|B", "K"),
                     (a, "FUNDING", 100, "USD", "A", ""), (a.upper(), "FUNDING", 100, "USD", "A", "K"), (a, "FUNDING", canonical.MAX_TXN_CENTS + 1, "USD", "A", "K")):
            with self.subTest(args=args), self.assertRaises(canonical.CanonicalError):
                canonical.event_content_digest(*args)

    def test_limits_are_the_g1s_values(self):
        self.assertEqual(canonical.MAX_TXN_CENTS, 9_999_999_999_999)
        self.assertEqual(canonical.MAX_BALANCE_CENTS, 9_007_199_254_740_991)
        self.assertEqual(canonical.MAX_BALANCE_CENTS, 2**53 - 1)
        self.assertEqual(canonical.money_text_to_cents("90071992547409.91"), canonical.MAX_BALANCE_CENTS)
        self.assertEqual(canonical.money_text_to_cents("99999999999.99"), canonical.MAX_TXN_CENTS)
        self.assertEqual(900 * canonical.MAX_TXN_CENTS, 8_999_999_999_999_100)
        self.assertLess(900 * canonical.MAX_TXN_CENTS, canonical.MAX_BALANCE_CENTS)
        self.assertGreater(901 * canonical.MAX_TXN_CENTS, canonical.MAX_BALANCE_CENTS)

    def test_money_text_is_exact_and_refuses_everything_else(self):
        self.assertEqual(canonical.money_text_to_cents("500000.00"), 50_000_000)
        self.assertEqual(canonical.money_text_to_cents("0.1"), 10)
        self.assertEqual(canonical.cents_to_money_text(1), "0.01")
        self.assertEqual(canonical.cents_to_money_text(-130_000_000), "-1300000.00")
        for bad in ("1.005", "1e3", "NaN", "Infinity", "-1.00", "", " 1.00", "1,000.00", 1.5, 100, None, True, b"1.00", "1.", ".5"):
            with self.subTest(bad=bad), self.assertRaises(canonical.CanonicalError):
                canonical.money_text_to_cents(bad)

    def test_canonical_form(self):
        self.assertEqual(canonical.canonical_compact({"b": 1, "a": [True, None]}), b'{"a":[true,null],"b":1}')
        for bad in (float("nan"), float("inf"), object()):
            with self.assertRaises(canonical.CanonicalError):
                canonical.canonical_compact({"x": bad})
        self.assertEqual(canonical.canonical_compact({"k": "é"}), b'{"k":"\\u00e9"}')

    def test_uuid_rendering_matches_postgresql(self):
        self.assertEqual(canonical.require_uuid("c2c10000-0000-4000-8000-0000000000b1", "x"), "c2c10000-0000-4000-8000-0000000000b1")
        for bad in ("C2C10000-0000-4000-8000-0000000000B1", "c2c1000000004000800000000000b1", "{c2c10000-0000-4000-8000-0000000000b1}", 5, None):
            with self.assertRaises(canonical.CanonicalError):
                canonical.require_uuid(bad, "x")


class Fixture(unittest.TestCase):
    def test_fixture_is_synthetic_exact_and_distinct_from_e3(self):
        raw = FIXTURE.read_text(encoding="ascii")
        doc = json.loads(raw, parse_float=lambda s: (_ for _ in ()).throw(AssertionError(f"float in fixture: {s}")))
        self.assertIs(doc["synthetic"], True)
        for forbidden in ("DB-DEMO-001", "REQ-STEEL", "REQ-ELEC", "REQ-CONC", "REQ-ELIG", "OBL-STEEL", "OBL-CONCRETE", "OBL-FRAMING",
                          "E3-SYNTH", "cash_crisis"):
            self.assertNotIn(forbidden, raw)
        for alloc in doc["allocations"]:
            canonical.require_uuid(alloc["allocation_id"], "allocation_id")
        canonical.require_uuid(doc["project"]["project_id"], "project_id")
        refs = [op[k] for s in doc["sequences"] for op in s["operations"] for k in ("authorization_id", "idempotency_key")]
        self.assertEqual(len(refs), len(set(refs)))
        for ref in refs:
            canonical.require_ref(ref, "ref")

    def test_fixture_expectations_follow_from_the_operations(self):
        for seq in fx()["sequences"]:
            cash = 0
            for index, op in enumerate(seq["operations"], 1):
                self.assertEqual(op["expected_version"], index)
                cents = canonical.money_text_to_cents(op["amount"])
                cash += cents if op["op"] == "post_funding" else -cents
                self.assertGreaterEqual(cash, 0)
            self.assertEqual(cash, seq["expected"]["cash_allocated_cents"])
            self.assertEqual(cash, seq["expected"]["project_capital_cents"])
            self.assertEqual(len(seq["operations"]), seq["expected"]["event_count"])

    def test_limit_table_is_consistent(self):
        lim = fx()["limits"]
        self.assertEqual(canonical.money_text_to_cents(lim["max_txn_amount"]), canonical.MAX_TXN_CENTS)
        self.assertEqual(canonical.money_text_to_cents(lim["max_balance_abs"]), lim["max_balance_abs_cents"])
        total = 900 * canonical.MAX_TXN_CENTS
        self.assertEqual(canonical.cents_to_money_text(total), lim["total_of_max_postings"])
        self.assertEqual(canonical.cents_to_money_text(canonical.MAX_BALANCE_CENTS - total), lim["remainder_to_cap"])
        for text in ("0.001", "1.005", "1e3", "NaN", "Infinity", "-Infinity", "-1.00", "", "99999999999.991"):
            self.assertIn(text, lim["invalid_amount_texts"])
            with self.assertRaises(canonical.CanonicalError):
                canonical.money_text_to_cents(text)
        for text in ("0", "0.00"):   # well-formed money text; the DATABASE refuses a non-positive amount (INVALID_AMOUNT)
            self.assertIn(text, lim["invalid_amount_texts"])
            self.assertEqual(canonical.money_text_to_cents(text), 0)

    def test_retry_constants_in_the_fixture_match_the_module(self):
        r = fx()["retry"]
        self.assertEqual(r["max_attempts"], retry.MAX_ATTEMPTS)
        self.assertEqual(set(r["retriable_unique_constraints"]), set(retry.RETRIABLE_UNIQUE_CONSTRAINTS))


class Err(Exception):
    def __init__(self, sqlstate, constraint=None):
        super().__init__(sqlstate)
        self.sqlstate = sqlstate
        self.constraint_name = constraint


class Retry(unittest.TestCase):
    def test_bound_is_three_total_attempts(self):
        self.assertEqual(retry.MAX_ATTEMPTS, 3)
        calls = []

        def op(attempt):
            calls.append(attempt)
            raise Err("40001")
        with self.assertRaises(retry.RetryExhausted) as caught:
            retry.call_with_bounded_retry(op)
        self.assertEqual(calls, [1, 2, 3])
        self.assertEqual(caught.exception.final_sqlstate, "40001")
        self.assertEqual(len(caught.exception.attempts), 3)

    def test_success_after_a_retry(self):
        def op(attempt):
            if attempt < 2:
                raise Err("40001")
            return ("ok", attempt)
        self.assertEqual(retry.call_with_bounded_retry(op), ("ok", 2))

    def test_the_bound_cannot_be_raised_or_removed(self):
        for bad in (0, 4, 100, -1, None, 2.0, True, "3"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                retry.call_with_bounded_retry(lambda a: None, max_attempts=bad)

    def test_only_the_three_named_unique_constraints_are_retriable(self):
        for name in sorted(retry.RETRIABLE_UNIQUE_CONSTRAINTS):
            self.assertEqual(retry.classify(Err("23505", name)), "RETRY")
        for name in ("journal_txn_pkey", "allocation_event_txn_uk", "allocation_event_pkey", "journal_account_name_uk", "", None):
            self.assertEqual(retry.classify(Err("23505", name)), "DEFECT_UNEXPECTED_UNIQUE", name)

    def test_unexpected_unique_violation_is_surfaced_unchanged_and_not_retried(self):
        calls = []

        def op(attempt):
            calls.append(attempt)
            raise Err("23505", "allocation_event_txn_uk")
        with self.assertRaises(Err) as caught:
            retry.call_with_bounded_retry(op)
        self.assertEqual(calls, [1])
        self.assertEqual(caught.exception.constraint_name, "allocation_event_txn_uk")

    def test_other_errors_are_final(self):
        for state in ("DW409", "DW422", "DW404", "23514", "23001", "40P01", "42501", "57014", "08006", None):
            calls = []

            def op(attempt, state=state):
                calls.append(attempt)
                raise Err(state)
            with self.subTest(state=state), self.assertRaises(Err):
                retry.call_with_bounded_retry(op)
            self.assertEqual(calls, [1])

    def test_a_lost_race_on_the_version_index_is_retried_then_resolves(self):
        outcomes = [Err("23505", "allocation_event_allocation_version_uk"), Err("40001"), "replayed"]

        def op(attempt):
            result = outcomes[attempt - 1]
            if isinstance(result, Exception):
                raise result
            return result
        self.assertEqual(retry.call_with_bounded_retry(op), "replayed")

    def test_driver_shapes(self):
        class Diag:
            constraint_name = "journal_txn_idempotency_key_uk"

        class DriverExc(Exception):
            pgcode = "23505"
            diag = Diag()
        self.assertEqual(retry.classify(DriverExc()), "RETRY")
        err = retry.PsqlError("23505", 'duplicate key value violates unique constraint "journal_txn_posting_identity_uk"')
        self.assertEqual(err.constraint_name, "journal_txn_posting_identity_uk")
        self.assertEqual(retry.classify(err), "RETRY")

    def test_no_unbounded_loop_in_the_source(self):
        text = (G2DB / "ledger/retry.py").read_text(encoding="utf-8")
        self.assertNotRegex(text, r"\bwhile\b")


class ReplayAndReconcile(unittest.TestCase):
    def test_clean_ledger_replays_and_reconciles(self):
        snap = build_snapshot()
        doc = replay.replay(snap)
        self.assertEqual([a["event_count"] for a in doc["allocations"]], [3, 2])
        balances = {a["allocation_id"]: a["balances"] for a in doc["allocations"]}
        self.assertEqual(balances["c2c10000-0000-4000-8000-0000000000b1"],
                         {"CASH_ALLOCATED": 65_000_000, "DISBURSED": 0, "PROJECT_CAPITAL": 65_000_000})
        self.assertEqual(balances["c2c10000-0000-4000-8000-0000000000b2"],
                         {"CASH_ALLOCATED": 0, "DISBURSED": 0, "PROJECT_CAPITAL": 0})
        result = reconcile.reconcile(snap, require_snapshot_proof=True)
        self.assertEqual(result["outcome"], "PASS", result)
        self.assertEqual(set(result["checks"].values()), {"PASS"})
        self.assertEqual(sorted(result["checks"]), sorted(reconcile.CHECKS))

    def test_replay_is_deterministic_and_order_independent(self):
        snap = build_snapshot()
        shuffled = copy.deepcopy(snap)
        shuffled["events"].reverse()
        a, b = replay.replay_bytes(replay.replay(snap)), replay.replay_bytes(replay.replay(shuffled))
        self.assertEqual(a, b)
        self.assertEqual(replay.replay_sha256(replay.replay(snap)), hashlib.sha256(a).hexdigest())
        self.assertEqual(a, replay.replay_bytes(replay.replay(copy.deepcopy(snap))))
        text = a.decode("ascii")
        for volatile in ("xid", "created_at", "timestamp", "pid"):
            self.assertNotIn(volatile, text)

    def test_replay_touches_no_file_and_no_process(self):
        snap = build_snapshot()
        refuse = mock.Mock(side_effect=AssertionError("replay must be pure"))
        with mock.patch("builtins.open", refuse), mock.patch("subprocess.run", refuse), mock.patch("subprocess.Popen", refuse), \
                mock.patch("socket.socket", refuse):
            replay.replay(snap)
            reconcile.reconcile(snap)
            manifest.build_manifest(snap)
        refuse.assert_not_called()

    def test_replay_does_not_mutate_its_input(self):
        snap = build_snapshot()
        frozen = json.dumps(snap, sort_keys=True)
        replay.replay(snap)
        reconcile.reconcile(snap)
        manifest.build_manifest(snap)
        self.assertEqual(json.dumps(snap, sort_keys=True), frozen)

    def test_replay_reports_gaps_and_refuses_duplicates_and_malformed_rows(self):
        snap = build_snapshot()
        gap = copy.deepcopy(snap)
        gap["events"] = [e for e in gap["events"] if not (e["allocation_id"].endswith("b1") and e["version"] == 2)]
        alloc = next(a for a in replay.replay(gap)["allocations"] if a["allocation_id"].endswith("b1"))
        self.assertEqual(alloc["version_gaps"], [2])
        dup = copy.deepcopy(snap)
        dup["events"].append(copy.deepcopy(dup["events"][0]))
        with self.assertRaises(replay.ReplayError):
            replay.replay(dup)
        for mutate in (lambda e: e.pop("legs"), lambda e: e.update(extra=1), lambda e: e.update(amount_cents=1.5),
                       lambda e: e.update(amount_cents=True), lambda e: e.update(event_kind="SETTLEMENT"),
                       lambda e: e.update(version=0), lambda e: e.update(content_digest="A" * 64),
                       lambda e: e["legs"][0].update(direction="X"), lambda e: e.update(currency="EUR")):
            bad = copy.deepcopy(snap)
            mutate(bad["events"][0])
            with self.subTest(), self.assertRaises(replay.ReplayError):
                replay.replay(bad)

    def _inject(self, change):
        snap = build_snapshot()
        change(snap)
        return reconcile.reconcile(snap)

    def test_r1_event_count(self):
        self.assertIn("EVENT_COUNT_MISMATCH", codes(self._inject(lambda s: s["reconciliation"].pop())))

    def test_r2_event_without_transaction_and_transaction_without_event(self):
        def orphan_txn(s):
            s["reconciliation"].append({**s["reconciliation"][0], "txn_id": u("orphan"), "event_id": None, "event_allocation_id": None,
                                        "event_version": None, "event_kind": None, "event_amount_cents": None})
        self.assertIn("TRANSACTION_WITHOUT_EVENT", codes(self._inject(orphan_txn)))

        def orphan_event(s):
            s["reconciliation"][0].update(txn_kind=None, txn_allocation_id=None, txn_amount_cents=None)
        self.assertIn("EVENT_WITHOUT_TRANSACTION", codes(self._inject(orphan_event)))

    def test_r2_pairing_mismatch(self):
        for field, value in (("event_amount_cents", 1), ("event_kind", "FUNDING_REDUCTION"), ("event_allocation_id", u("other"))):
            with self.subTest(field=field):
                self.assertIn("EVENT_TRANSACTION_MISMATCH", codes(self._inject(lambda s: s["reconciliation"][0].update({field: value}))))

    def test_r3_leg_pattern(self):
        self.assertIn("LEG_PATTERN_INVALID", codes(self._inject(lambda s: s["reconciliation"][0].update(leg_count=3))))
        self.assertIn("LEG_PATTERN_INVALID", codes(self._inject(lambda s: s["reconciliation"][0].update(pattern_leg_count=1))))

    def test_r4_imbalance(self):
        self.assertIn("TRANSACTION_IMBALANCE", codes(self._inject(lambda s: s["reconciliation"][0].update(credit_cents=1))))

        def allocation_imbalance(s):
            s["balances"][0]["debit_cents"] += 5
        self.assertIn("ALLOCATION_IMBALANCE", codes(self._inject(allocation_imbalance)))

    def test_r5_balances(self):
        def drift(s):
            for b in s["balances"]:
                if b["account_name"] == "CASH_ALLOCATED" and b["allocation_id"].endswith("b1"):
                    b["balance_cents"] += 100
        self.assertIn("BALANCE_NOT_NET_OF_EVENTS", codes(self._inject(drift)))
        self.assertIn("BALANCE_NOT_EVENT_LEGS", codes(self._inject(drift)))
        self.assertIn("UNEXPECTED_ACCOUNT", codes(self._inject(lambda s: s["balances"].append({**s["balances"][0], "account_name": "SUSPENSE"}))))

        def phantom(s):
            s["balances"].append({**s["balances"][0], "allocation_id": u("ghost"), "account_name": "CASH_ALLOCATED", "balance_cents": 7})
        self.assertIn("BALANCE_NOT_NET_OF_EVENTS", codes(self._inject(phantom)))

    def test_r6_versions(self):
        self.assertIn("VERSION_GAP", codes(self._inject(lambda s: s["events"][1].update(version=5))))
        self.assertIn("VERSION_GAP", codes(self._inject(lambda s: s["events"].pop(0))))

    def test_r7_digest(self):
        self.assertIn("CONTENT_DIGEST_MISMATCH", codes(self._inject(lambda s: s["events"][0].update(content_digest="0" * 64))))
        self.assertIn("CONTENT_DIGEST_MISMATCH", codes(self._inject(lambda s: s["events"][0].update(idempotency_key="G2C1-IDEM-9999"))))

    def test_r8_negative_cash(self):
        def negative(s):
            for e in s["events"]:
                if e["allocation_id"].endswith("b2") and e["version"] == 2:
                    e["amount_cents"] = 200_000
                    e["legs"][0]["amount_cents"] = e["legs"][1]["amount_cents"] = 200_000
        self.assertIn("CASH_NEGATIVE", codes(self._inject(negative)))

    def test_r9_disbursed(self):
        def disbursed(s):
            for b in s["balances"]:
                if b["account_name"] == "DISBURSED":
                    b["balance_cents"] = 5
                    break
        self.assertIn("DISBURSED_NONZERO", codes(self._inject(disbursed)))

    def test_x1_shared_identities(self):
        self.assertIn("IDEMPOTENCY_KEY_SHARED", codes(self._inject(lambda s: s["events"][1].update(idempotency_key=s["events"][0]["idempotency_key"]))))
        self.assertIn("POSTING_IDENTITY_SHARED", codes(self._inject(lambda s: s["events"][1].update(posting_identity=s["events"][0]["posting_identity"]))))

    def test_snapshot_proof_is_required_when_asked(self):
        snap = build_snapshot()
        del snap["txn_isolation"]
        self.assertIn("SNAPSHOT_PROOF_MISSING", codes(reconcile.reconcile(snap, require_snapshot_proof=True)))
        self.assertEqual(reconcile.reconcile(snap)["outcome"], "PASS")

    def test_discrepancies_are_reported_never_repaired(self):
        snap = build_snapshot()
        snap["balances"][0]["balance_cents"] += 1
        before = json.dumps(snap, sort_keys=True)
        result = reconcile.reconcile(snap)
        self.assertEqual(result["outcome"], "DISCREPANCIES")
        self.assertEqual(json.dumps(snap, sort_keys=True), before)

    def test_malformed_snapshot_is_refused_not_passed(self):
        for bad in (None, {}, {"events": []}, {"events": [], "balances": [], "reconciliation": [{"x": 1}]}):
            with self.subTest(bad=bad), self.assertRaises(reconcile.ReconcileError):
                reconcile.reconcile(bad)

    def test_empty_ledger_passes_trivially(self):
        empty = {"events": [], "balances": [], "reconciliation": []}
        self.assertEqual(reconcile.reconcile(empty)["outcome"], "PASS")
        self.assertEqual(replay.replay(empty)["allocations"], [])


class Manifest(unittest.TestCase):
    def setUp(self):
        self.snap = build_snapshot()
        self.doc = manifest.build_manifest(self.snap)
        self.data = manifest.manifest_bytes(self.doc)
        self.b1 = "c2c10000-0000-4000-8000-0000000000b1"

    def verify(self, doc, **kw):
        return manifest.verify_manifest(manifest.manifest_bytes(doc), **kw)

    def codes(self, result):
        return {f["code"] for f in result["failures"]}

    def test_valid_chain_passes_and_states_its_limits(self):
        result = manifest.verify_manifest(self.data)
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["limitations"]), 7)
        self.assertTrue(any("NO_ANCHOR" in n for n in result["notes"]))
        self.assertEqual(self.doc["schema"], "drawbridge.g2c1.ledger-manifest.v1")
        self.assertEqual(sorted(self.doc), ["allocations", "schema", "synthetic", "task"])
        self.assertEqual([a["event_count"] for a in self.doc["allocations"]], [3, 2])
        first = self.doc["allocations"][0]["events"][0]
        self.assertEqual(first["prev_sha256"], "0" * 64)
        self.assertEqual(self.doc["allocations"][0]["head_sha256"], self.doc["allocations"][0]["events"][-1]["sha256"])

    def test_chain_method_is_the_documented_one(self):
        entry = self.doc["allocations"][0]["events"][1]
        body = {k: v for k, v in entry.items() if k != "sha256"}
        self.assertEqual(entry["sha256"], hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")).hexdigest())
        self.assertEqual(entry["prev_sha256"], self.doc["allocations"][0]["events"][0]["sha256"])

    def test_export_is_deterministic_and_independent_of_row_order(self):
        shuffled = copy.deepcopy(self.snap)
        shuffled["events"].reverse()
        self.assertEqual(manifest.manifest_bytes(manifest.build_manifest(shuffled)), self.data)

    def test_altered_content_fails_with_a_position(self):
        doc = copy.deepcopy(self.doc)
        doc["allocations"][0]["events"][1]["amount_cents"] += 1
        result = self.verify(doc)
        self.assertFalse(result["ok"])
        first = result["failures"][0]
        self.assertEqual((first["allocation_index"], first["event_index"]), (0, 1))

    def test_altered_content_with_recomputed_entry_hash_still_fails_on_the_link_or_digest(self):
        doc = copy.deepcopy(self.doc)
        e = doc["allocations"][0]["events"][1]
        e["authorization_id"] = "G2C1-AUTH-9999"
        e["sha256"] = manifest.entry_digest(e)
        result = self.verify(doc)
        self.assertIn("CONTENT_DIGEST", self.codes(result))

    def test_fully_recomputed_forgery_is_the_stated_limit(self):
        doc = copy.deepcopy(self.doc)
        alloc = doc["allocations"][0]
        e = alloc["events"][2]
        e["amount_cents"] = 7
        for leg in e["legs"]:
            leg["amount_cents"] = 7
        e["content_digest"] = canonical.event_content_digest(alloc["allocation_id"], e["event_kind"], 7, "USD", e["authorization_id"], e["idempotency_key"])
        e["sha256"] = manifest.entry_digest(e)
        alloc["head_sha256"] = e["sha256"]
        self.assertTrue(self.verify(doc)["ok"], "a party who can rewrite the whole chain is NOT detected without an anchor")
        anchored = self.verify(doc, expected_heads={self.b1: self.doc["allocations"][0]["head_sha256"]})
        self.assertFalse(anchored["ok"])
        self.assertIn("HEAD_MISMATCH", self.codes(anchored))

    def test_reordered_events_fail(self):
        doc = copy.deepcopy(self.doc)
        ev = doc["allocations"][0]["events"]
        ev[0], ev[1] = ev[1], ev[0]
        self.assertFalse(self.verify(doc)["ok"])

    def test_dropped_middle_fails(self):
        doc = copy.deepcopy(self.doc)
        del doc["allocations"][0]["events"][1]
        doc["allocations"][0]["event_count"] = 2
        result = self.verify(doc)
        self.assertFalse(result["ok"])

    def test_missing_predecessor_fails(self):
        doc = copy.deepcopy(self.doc)
        del doc["allocations"][0]["events"][0]
        doc["allocations"][0]["event_count"] = 2
        self.assertFalse(self.verify(doc)["ok"])
        doc = copy.deepcopy(self.doc)
        doc["allocations"][0]["events"][0]["prev_sha256"] = "1" * 64
        self.assertIn("LINK", self.codes(self.verify(doc)))

    def test_altered_link_fails(self):
        doc = copy.deepcopy(self.doc)
        doc["allocations"][0]["events"][2]["prev_sha256"] = "2" * 64
        result = self.verify(doc)
        self.assertEqual(result["failures"][0]["code"], "LINK")
        self.assertEqual(result["failures"][0]["event_index"], 2)

    def test_dropped_tail_is_undetected_without_an_anchor_and_detected_with_one(self):
        doc = copy.deepcopy(self.doc)
        alloc = doc["allocations"][0]
        del alloc["events"][2]
        alloc["event_count"] = 2
        alloc["head_sha256"] = alloc["events"][-1]["sha256"]
        unanchored = self.verify(doc)
        self.assertTrue(unanchored["ok"], "limit 5: a dropped tail is invisible without a recorded head")
        self.assertTrue(any("dropped tail" in n for n in unanchored["notes"]))
        by_head = self.verify(doc, expected_heads={self.b1: self.doc["allocations"][0]["head_sha256"]})
        by_count = self.verify(doc, expected_counts={self.b1: 3})
        self.assertIn("HEAD_MISMATCH", self.codes(by_head))
        self.assertIn("COUNT_MISMATCH", self.codes(by_count))
        self.assertTrue(self.verify(self.doc, expected_heads={self.b1: self.doc["allocations"][0]["head_sha256"]}, expected_counts={self.b1: 3})["ok"])

    def test_dropped_whole_allocation_is_caught_only_with_an_anchor(self):
        doc = copy.deepcopy(self.doc)
        del doc["allocations"][1]
        self.assertTrue(self.verify(doc)["ok"])
        self.assertFalse(self.verify(doc, expected_counts={"c2c10000-0000-4000-8000-0000000000b2": 2})["ok"])

    def test_head_field_tampering_fails(self):
        doc = copy.deepcopy(self.doc)
        doc["allocations"][0]["head_sha256"] = "3" * 64
        self.assertIn("HEAD", self.codes(self.verify(doc)))

    def test_corrupted_file_is_caught(self):
        self.assertIn("FILE_SHA256", self.codes(manifest.verify_manifest(self.data, expected_file_sha256="0" * 64)))
        self.assertTrue(manifest.verify_manifest(self.data, expected_file_sha256=hashlib.sha256(self.data).hexdigest())["ok"])
        flipped = bytearray(self.data)
        flipped[len(flipped) // 2] ^= 0x01
        self.assertFalse(manifest.verify_manifest(bytes(flipped))["ok"])
        self.assertFalse(manifest.verify_manifest(self.data[:-5])["ok"])
        self.assertFalse(manifest.verify_manifest(b"")["ok"])
        self.assertFalse(manifest.verify_manifest(b"[]")["ok"])

    def test_non_canonical_float_duplicate_and_constant_inputs_fail(self):
        pretty = json.dumps(self.doc, indent=2).encode("ascii")
        self.assertIn("NOT_CANONICAL", self.codes(manifest.verify_manifest(pretty)))
        self.assertIn("NOT_CANONICAL", self.codes(manifest.verify_manifest(self.data + b"\n")))
        text = self.data.decode("ascii")
        for bad in (text.replace('"amount_cents":50000000', '"amount_cents":50000000.0', 1), text.replace('"synthetic":true', '"synthetic":true,"synthetic":true', 1),
                    text.replace('"synthetic":true', '"synthetic":NaN', 1)):
            self.assertNotEqual(bad, text)
            self.assertFalse(manifest.verify_manifest(bad.encode("ascii"))["ok"])

    def test_wrong_leg_pattern_or_type_fails(self):
        for mutate in (lambda e: e["legs"].reverse(), lambda e: e["legs"][0].update(account_name="DISBURSED"), lambda e: e["legs"].pop(),
                       lambda e: e.update(amount_cents=True), lambda e: e.update(event_kind="SETTLEMENT"), lambda e: e.update(version=9)):
            doc = copy.deepcopy(self.doc)
            mutate(doc["allocations"][0]["events"][0])
            with self.subTest(), self.assertRaises(AssertionError):
                self.assertTrue(self.verify(doc)["ok"])

    def test_write_is_exclusive_and_writes_a_sidecar(self):
        with scratch_tmp() as tmp:
            out = Path(tmp) / "manifest.json"
            info = manifest.write_manifest(self.doc, out)
            self.assertEqual(out.read_bytes(), self.data)
            self.assertEqual(info["manifest_sha256"], hashlib.sha256(self.data).hexdigest())
            self.assertEqual(manifest.read_sidecar(out), info["manifest_sha256"])
            self.assertEqual(info["heads"][self.b1]["event_count"], 3)
            with self.assertRaises(FileExistsError):
                manifest.write_manifest(self.doc, out)
            out.write_bytes(b"x")
            self.assertTrue(manifest.verify_manifest(self.data, expected_file_sha256=manifest.read_sidecar(out))["ok"])

    def test_the_database_never_reads_the_manifest(self):
        sql = MIGRATION.read_text(encoding="utf-8").lower()
        for word in ("manifest", "pg_read_file", "copy "):
            self.assertNotIn(word, re.sub(r"--.*", "", sql))


class Snapshot(unittest.TestCase):
    def test_database_names_are_guarded(self):
        for bad in ("postgres", "template1", "prod", "drawbridge_g2_dev; drop", "DRAWBRIDGE_G2_DEV", "", None, "drawbridge_g2_dev ", "../x",
                    "drawbridge_g2_dev", "drawbridge_g2_test", "drawbridge_g2_scratch_inject_01", "drawbridge_g2_scratch ", "drawbridge_g2_scratch\n",
                    "DRAWBRIDGE_G2_SCRATCH", "drawbridge_g2_scratch2", b"drawbridge_g2_scratch", 7):
            with self.subTest(bad=bad), self.assertRaises(snapshot.SnapshotError):
                snapshot.fetch_snapshot(bad, run=mock.Mock(side_effect=AssertionError("must not run")))

    def test_the_read_goes_through_the_g2c1_runner_as_the_reader_in_one_read_only_transaction(self):
        good = json.dumps({"txn_read_only": "on", "txn_isolation": "repeatable read", "events": [], "balances": [], "reconciliation": []})
        stub = LaunchStub(out=f"BEGIN\n{good}\nCOMMIT\n")
        doc = snapshot.fetch_snapshot("drawbridge_g2_scratch", run=stub)
        self.assertEqual(doc["events"], [])
        self.assertEqual(len(stub.calls), 1)
        argv, kw = stub.calls[0]
        # call site 1 of 6 (snapshot.py:64): the runner file itself is argv[0]; no interpreter, no env wrapper, no shell
        self.assertEqual(argv[0], str(RUNNER))
        self.assertEqual(argv[1:7], ["psql", "drawbridge_g2_scratch", "drawbridge_reader", "-At", "-v", "VERBOSITY=verbose"])
        self.assertEqual(argv[7], "-c")
        self.assertEqual(len(argv), 9)
        sql = argv[8]
        self.assertEqual(sql, snapshot.SNAPSHOT_SQL)
        self.assertNotIn("-f", argv)
        self.assertNotIn("/bin/bash", argv)
        self.assertNotIn("bash", [Path(a).name for a in argv])
        self.assertIsNot(kw.get("shell"), True)
        self.assertEqual(kw["stdin"], subprocess.DEVNULL)
        self.assertNotIn("input", kw)
        self.assertNotIn("capture_output", kw)
        self.assertEqual(set(kw["env"]), {"PATH", "HOME", "LANG"})
        self.assertEqual(kw["env"]["PATH"], "/usr/bin:/bin")
        self.assertIn("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;", sql)
        self.assertEqual(sql.count("SELECT"), 4)
        self.assertEqual(len(re.findall(r"\bFROM drawbridge_read\.", sql)), 3)
        self.assertNotRegex(sql, r"drawbridge_auth\.|INSERT|UPDATE|DELETE|post_funding")
        self.assertNotIn("54418", " ".join(argv))
        self.assertNotIn("pg18-g2/", " ".join(argv))

    def test_a_result_without_read_only_repeatable_read_proof_is_refused(self):
        for ro, iso in (("off", "repeatable read"), ("on", "read committed"), (None, None)):
            doc = {"txn_read_only": ro, "txn_isolation": iso, "events": [], "balances": [], "reconciliation": []}
            with self.subTest(ro=ro, iso=iso), self.assertRaises(snapshot.SnapshotError):
                snapshot.parse_snapshot_output(json.dumps(doc))
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.parse_snapshot_output("BEGIN\nCOMMIT\n")
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.parse_snapshot_output('{"a":1}\n{"b":2}\n')

    def test_a_failing_reader_is_an_error_not_an_empty_ledger(self):
        stub = LaunchStub(rc=3, err="REFUSED: G2C1 cluster socket absent")
        with self.assertRaises(snapshot.SnapshotError) as ctx:
            snapshot.fetch_snapshot("drawbridge_g2_scratch", run=stub)
        self.assertEqual(ctx.exception.exit_status, 3)
        self.assertIsNone(ctx.exception.sqlstate)       # nothing readable: never inferred from the text


    def test_the_runner_path_resolves_to_the_effective_task_allowlist(self):
        self.assertEqual(snapshot.RUNNER, RUNNER)
        self.assertTrue(str(RUNNER).endswith("services/api/app/domain/g2_db/tools/g2c1_durable_cluster.sh"))


class StaticChecks(unittest.TestCase):
    def test_migration_static_lint_is_clean(self):
        result = static_lint.lint_migration(MIGRATION)
        self.assertEqual(result["findings"], [])
        inv = result["inventory"]
        self.assertEqual(inv["types"], ["drawbridge_auth.funding_post_result"])
        self.assertEqual(sorted(t.split(".")[1] for t in inv["tables"]), ["allocation_event", "journal_account", "journal_leg", "journal_txn"])
        self.assertEqual(sorted(v.split(".")[1] for v in inv["views"]), ["ledger_account_balance", "ledger_event_stream", "ledger_reconciliation"])
        for name in ("post_funding", "post_funding_reduction"):
            f = next(x for x in inv["functions"] if x["name"] == f"drawbridge_auth.{name}")
            self.assertEqual((f["volatility"], f["security_definer"], f["search_path"]), ("VOLATILE", True, True))

    def test_migration_has_the_contract_objects(self):
        text = re.sub(r"--.*", "", MIGRATION.read_text(encoding="utf-8"))
        for needle in ("CONSTRAINT journal_txn_idempotency_key_uk UNIQUE (idempotency_key)",
                       "CONSTRAINT journal_txn_posting_identity_uk UNIQUE (posting_identity, identity_generation)",
                       "CONSTRAINT allocation_event_allocation_version_uk UNIQUE (allocation_id, version)",
                       "numeric(20,2)", "numeric(13,2)", "90071992547409.91", "99999999999.99", "identity_generation = 1",
                       "DEFERRABLE INITIALLY DEFERRED", "'AUTHORITY_REDUCTION_BLOCKED' USING ERRCODE = 'DW422', DETAIL = 'REDUCTION_EXCEEDS_CASH'",
                       "FOR UPDATE", "unsupported journal kind", "REVOKE ALL ON FUNCTION", "LANGUAGE plpgsql VOLATILE SECURITY DEFINER"):
            self.assertIn(needle, text)
        for needle in ("transfer_exposure", "funding_authority", "mirror_of", "direction_swapped", "settlement_"):
            self.assertNotIn(needle, text.lower())
        self.assertNotRegex(text, r"FOREIGN KEY \(reverses_txn_id")   # no G1S 4.4 reversal-to-original key (C-2b)
        self.assertNotRegex(text, r"CREATE TABLE drawbridge_auth\.(transfer_exposure|funding_authority|payment_event|obligation_reversal)")

    def test_sqlstate_and_outcome_names_match_the_records(self):
        text = MIGRATION.read_text(encoding="utf-8")
        for name, state in (("ALLOCATION_NOT_FOUND", "DW404"), ("STALE_VERSION", "DW409"), ("IDEMPOTENCY_CONFLICT", "DW409"),
                            ("DUPLICATE_AUTHORIZATION", "DW409"), ("INVALID_AMOUNT", "DW422"), ("INVALID_REFERENCE", "DW422"),
                            ("AUTHORITY_REDUCTION_BLOCKED", "DW422")):
            self.assertRegex(text, rf"'{name}'\s+USING ERRCODE = '{state}'")
        self.assertEqual(len(re.findall(r"IF session_user <> 'authority_svc'", text)), 2)

    def test_migration_blob_bytes_are_stable(self):
        raw = MIGRATION.read_bytes()
        self.assertEqual(static_lint.lint_migration(MIGRATION)["sha256"], hashlib.sha256(raw).hexdigest())
        raw.decode("utf-8")
        self.assertNotIn(b"\r", raw)

    def test_runner_static_lint_is_clean(self):
        self.assertEqual(static_lint.lint_runner(RUNNER)["findings"], [])

    def test_runner_shell_syntax_without_executing_it(self):
        done = subprocess.run(["/bin/bash", "-n", str(RUNNER)], capture_output=True, text=True, check=False)
        self.assertEqual((done.returncode, done.stderr), (0, ""))

    def test_runner_root_arithmetic_and_paths(self):
        text = RUNNER.read_text(encoding="utf-8")
        self.assertIn('ROOT="$(cd "$HERE/../../../../../.." && pwd -P)"', text)   # physical path: symlinks resolved
        self.assertEqual((RUNNER.parent / "../../../../../..").resolve(), ROOT.resolve())
        self.assertIn("readonly PORT=54438", text)
        self.assertNotIn("PORT=54418", text)
        mode = RUNNER.stat().st_mode & 0o777
        self.assertEqual(mode & 0o111, 0o111)

    def test_runner_refuses_by_construction_the_existing_cluster(self):
        code = "\n".join(l for l in RUNNER.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("#"))
        self.assertNotRegex(code, r"pg18-g2(?!c1)")
        # The old guards compared constants built from each other (always true). The substantive guard inspects the file system.
        self.assertNotIn('[ "$BASE" = "$ROOT/build/pg18-g2c1" ] ||', code)
        self.assertNotIn('[ "$PORT" != "54418" ]', code)
        self.assertIn("guard_paths()", code)
        self.assertIn('realpath -e -- "$p"', code)
        self.assertIn('if [ -L "$p" ]; then die', code)
        self.assertEqual(code.count("rm "), 0)

    def test_ledger_sources_import_no_driver_and_open_no_connection(self):
        for path in (G2DB / "ledger").glob("*.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"^\s*(import|from)\s+(psycopg2?|asyncpg|pg8000|sqlalchemy|socket|requests|urllib|http)\b", path.name)
            self.assertNotRegex(text, r"\bfloat\s*\(", path.name)
            self.assertNotRegex(text, r"\beval\s*\(|\bexec\s*\(|__import__", path.name)

    def test_owned_paths_only(self):
        allowed = (re.compile(r"^db/migrations/0011_g2c1_funding_ledger\.sql$"), re.compile(r"^fixtures/g2c1_synthetic\.json$"),
                   re.compile(r"^services/api/app/domain/g2_db/ledger/"), re.compile(r"^services/api/app/domain/g2_db/tools/g2c1_durable_cluster\.sh$"))
        done = subprocess.run(["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, check=False)
        if done.returncode != 0:
            self.skipTest("not a git checkout (external export)")
        mine = [p for p in done.stdout.splitlines() if "g2c1" in p.lower() or "/ledger/" in p]
        for path in mine:
            self.assertTrue(any(a.match(path) for a in allowed), path)


# ---------------------------------------------------------------------------------------------------------------------------------
# LOOM-2 V01 hardening tests. All offline: no PostgreSQL, no SQL, no cluster. Every database case remains NOT RUN.
sys.path.insert(0, str(HERE))
import db_cases  # noqa: E402  (importing it connects to nothing)


class MigrationUnchanged(unittest.TestCase):
    def test_migration_bytes_unchanged_and_erratum_recorded(self):
        data = MIGRATION.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), "0b8ddcc61650a3535b4377929250c17f2be2539b63c02075b1ab4cc7452743b6")
        self.assertEqual(len(data), 43067)
        text = data.decode("utf-8")
        self.assertIn("only through the 4.4 single CHECK", text)          # the inaccurate wording is still there: bytes were not touched
        import ledger
        self.assertIn("ERRATUM E-F9", ledger.__doc__)
        self.assertIn("0b8ddcc61650a3535b4377929250c17f2be2539b63c02075b1ab4cc7452743b6", ledger.__doc__)


class LaunchStub:
    """A fake `run` for snapshot.launch_runner: records every launch (argv and keyword arguments) and writes canned bytes into the stdout and
    stderr FILES the launcher supplies. `script` may be a callable (argv) -> (rc, out, err) for per-call answers. Nothing is executed."""

    def __init__(self, rc=0, out="", err="", script=None):
        self.rc, self.out, self.err, self.script, self.calls = rc, out, err, script, []

    def __call__(self, argv, **kw):
        self.calls.append((list(argv), kw))
        rc, out, err = self.script(list(argv)) if self.script else (self.rc, self.out, self.err)
        kw["stdout"].write(out.encode() if isinstance(out, str) else out)
        kw["stderr"].write(err.encode() if isinstance(err, str) else err)
        return subprocess.CompletedProcess(argv, rc)


APPROVED_SCRATCH_NAME = "g2c1-a10-scratch"      # the ONLY approved scratch root is $HOME/g2c1-a10-scratch (owner decision, A10 C-3 / A11 B-5)
UNIX_SOCKET_PATH_MAX = 107                       # sun_path is 108 bytes including the terminating NUL
_CREATED: dict = {}                              # approved root -> names of the entries THIS process created there (nothing else is trusted)


def _inside(child, parent) -> bool:
    try:
        Path(child).relative_to(parent)
        return True
    except ValueError:
        return False


def _check_ancestors(path: str) -> None:
    """Every ancestor of the path is a real directory (no symbolic link) owned by the executing account or by root, and is not writable by group or
    other unless it has the sticky bit (a shared temporary directory)."""
    me = os.geteuid()
    system_owner = os.lstat("/").st_uid                 # root, or the overflow account when the suite runs in a user namespace
    for parent in Path(path).parents:
        st = os.lstat(parent)
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
            raise RuntimeError(f"G2C1 workspace: {parent} is not a real directory")
        if st.st_uid not in (0, me, system_owner):
            raise RuntimeError(f"G2C1 workspace: {parent} is owned by another account")
        if st.st_mode & 0o022 and not st.st_mode & stat.S_ISVTX:
            raise RuntimeError(f"G2C1 workspace: {parent} is writable by group or other")


def workspace_root(*, home=None, checkout=None, environ=None) -> Path:
    """The ONLY place the offline tests create files: exactly `<account home>/g2c1-a10-scratch` (A11 B-5). There is NO system-temporary fallback: with
    or without the G2C1_TEST_WORKSPACE override the root is required, and an override other than the exact root is refused. Verified every call: the
    account home comes from the account database for the effective UID, is absolute and canonical with no symbolic link and owned by that UID; HOME and
    TMPDIR in the environment, when set, must not name anything else; every ancestor is safe; the root does not overlap the checkout; the root is a real
    directory owned by the UID with mode exactly 0700; and the root holds NO entry this process did not create (contents left by an earlier or crashed
    run STOP the suite: nothing is read, reused, repaired, cleaned or deleted). An absent root is created (one level, 0700) and re-verified. A failure
    raises; nothing falls back to another location."""
    env = os.environ if environ is None else environ
    if os.getuid() != os.geteuid():                     # A12 F-D/F-I: one unambiguous executing account
        raise RuntimeError("the real and effective UIDs differ; the executing account is ambiguous")
    base = snapshot.verified_home() if home is None else home
    if type(base) is not str or not os.path.isabs(base) or os.path.realpath(base) != base:
        raise RuntimeError("the account home directory is not an absolute path without symbolic links")
    approved = os.path.join(base, APPROVED_SCRATCH_NAME)
    override = env.get("G2C1_TEST_WORKSPACE")
    if override is not None and override != approved:
        raise RuntimeError(f"G2C1_TEST_WORKSPACE may only name the approved scratch root {approved}")
    env_home = env.get("HOME")
    if env_home not in (None, "") and env_home != base:
        raise RuntimeError("HOME in the environment conflicts with the account home directory")
    tmpdir = env.get("TMPDIR")
    if tmpdir not in (None, "") and os.path.realpath(tmpdir) != approved:
        raise RuntimeError("TMPDIR conflicts with the approved scratch root")
    try:
        st = os.lstat(base)
    except OSError as exc:
        raise RuntimeError("the account home directory cannot be read") from exc
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
        raise RuntimeError("the account home directory is not a directory owned by the executing account")
    home_dev = st.st_dev
    _check_ancestors(approved)
    co = Path(ROOT if checkout is None else checkout).resolve()
    if _inside(approved, co) or _inside(co, approved):
        raise RuntimeError("the approved scratch root must not be, contain or lie inside the source checkout")
    try:
        os.lstat(approved)
    except FileNotFoundError:
        os.mkdir(approved, 0o700)                       # one level only; an absent parent is an error, never created
        os.chmod(approved, 0o700)                       # the process umask can only remove bits; this makes the mode exact
        _CREATED.setdefault(approved, set())
    st = os.lstat(approved)
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or os.path.realpath(approved) != approved:
        raise RuntimeError("the approved scratch root is not a real directory without symbolic links")
    if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise RuntimeError("the approved scratch root must be owned by the executing account with mode exactly 0700")
    if st.st_dev != home_dev:                           # A12 F-D: the root lies on the verified home's own filesystem (the private sandbox home)
        raise RuntimeError("the approved scratch root is not on the same filesystem as the verified account home")
    unknown = sorted(set(os.listdir(approved)) - _CREATED.get(approved, set()))
    if unknown:
        raise RuntimeError(f"STOP: the approved scratch root holds {len(unknown)} entr{'y' if len(unknown) == 1 else 'ies'} this run did not create; "
                           "nothing is deleted, repaired or reused (operator investigation needs separate authority)")
    _CREATED.setdefault(approved, set())
    return Path(approved)


def new_scratch(prefix: str = "g2c1t") -> Path:
    """A new per-run directory beneath the approved root, created atomically with mode 0700 (mkdtemp). It is never deleted (no workspace deletion)."""
    root = workspace_root()
    d = tempfile.mkdtemp(dir=root, prefix=prefix)
    _CREATED[str(root)].add(os.path.basename(d))
    return Path(d)


class scratch_tmp:
    """Drop-in for `with scratch_tmp() as tmp:` that creates the directory under the approved root and deletes NOTHING on exit."""

    def __init__(self, prefix: str = "g2c1t"):
        self.name = str(new_scratch(prefix))

    def __enter__(self) -> str:
        return self.name

    def __exit__(self, *exc) -> bool:
        return False


def evidence_tmp():
    """A new, empty, 0700 directory beneath the approved root (the shape db_cases.prepare_evidence_dir requires). Nothing is removed afterwards."""
    return new_scratch("g2c1ev")


tempfile.tempdir = str(workspace_root())         # every library temporary file of this process lives under the approved root (no /tmp fallback)


def approved_source_table(**override) -> Path:
    """An owner-approved source table built from the executing sources, for offline tests only (a real one comes from a later exact-hash record;
    nothing here is an approved commit). Returns a file in its own fresh directory."""
    table = {"schema": db_cases.SOURCE_TABLE_SCHEMA, "commit": "1" * 40, "runner_sha256": snapshot.RUNNER_SHA256,
             "registry_sha256": db_cases.registry_digest(), "files": db_cases.executing_sources()}
    table.update(override)
    path = evidence_tmp() / "approved-source.json"
    path.write_text(json.dumps(table))
    return path


class ConnectionOptions(unittest.TestCase):
    """F-2: the READ COMMITTED option string and the constructed connection parameters."""

    def test_exact_option_strings(self):
        self.assertEqual(db_cases.SERIALIZABLE, "-c default_transaction_isolation=serializable")
        self.assertEqual(db_cases.READ_COMMITTED, "-c default_transaction_isolation=read\\ committed")

    def test_no_literal_quote_characters(self):
        for text in (db_cases.SERIALIZABLE, db_cases.READ_COMMITTED):
            self.assertNotIn("'", text)
            self.assertNotIn('"', text)

    def test_libpq_style_split_yields_the_intended_setting(self):
        self.assertEqual(db_cases.split_pgoptions(db_cases.READ_COMMITTED), ["-c", "default_transaction_isolation=read committed"])
        self.assertEqual(db_cases.split_pgoptions(db_cases.SERIALIZABLE), ["-c", "default_transaction_isolation=serializable"])
        # and the broken string of LOOM-2 V01 F-2 is demonstrably wrong under the same rule
        self.assertEqual(db_cases.split_pgoptions("-c default_transaction_isolation='read committed'"),
                         ["-c", "default_transaction_isolation='read", "committed'"])

    def test_constructed_command_and_environment(self):
        stub = LaunchStub(out="e|t|1|f\n")
        ev = evidence_tmp()
        db = db_cases.Db("drawbridge_g2_scratch", run=stub, evidence_dir=ev)
        db.case_id = "T-CASE"
        a = str(uuid.uuid4())
        r = db.call("post_funding", a, 1, "1.00", "AUTH-x", "IDEM-y", options=db_cases.READ_COMMITTED)
        argv, kw = stub.calls[0]
        # call site 2 of 6 (db_cases.py:165): direct execution of the runner file with an explicit environment
        self.assertEqual(argv[:10], [str(RUNNER), "psql", "drawbridge_g2_scratch", "authority_svc", "-At", "-F", "|", "-v", "VERBOSITY=verbose", "-c"])
        self.assertEqual(len(argv), 11)
        self.assertEqual(kw["env"]["PGOPTIONS"], "-c default_transaction_isolation=read\\ committed")
        self.assertEqual(set(kw["env"]), {"PATH", "HOME", "LANG", "PGOPTIONS"})
        self.assertEqual(r.evidence["invocation"], argv)
        self.assertEqual(r.evidence["exit_status"], 0)
        self.assertEqual(r.evidence["operation"], "post_call")
        self.assertTrue(Path(r.evidence["stdout"]).is_file() and Path(r.evidence["stderr"]).is_file())
        db.call("post_funding", a, 2, "1.00", "AUTH-z", "IDEM-w", options=None)
        self.assertNotIn("PGOPTIONS", stub.calls[1][1]["env"])
        with self.assertRaises(snapshot.LaunchRefused):
            db.call("post_funding", a, 3, "1.00", "AUTH-q", "IDEM-v", options="-c default_transaction_isolation='read committed'")
        with self.assertRaises(snapshot.PayloadRefused):
            db.op("alloc_event_count", options=db_cases.SERIALIZABLE, a=a)       # an operation that takes no isolation option refuses one
        with self.assertRaises(db_cases.DeferredByN9):
            db.command("authority_svc", db_cases.READ_COMMITTED, {"alloc": "a"})
        with self.assertRaises(db_cases.UnregisteredSql):
            db.run("authority_svc", "select :'x';", variables={"x": "1"})

    def test_runner_forwards_the_option_string_as_one_quoted_word(self):
        text = RUNNER.read_text(encoding="utf-8")
        self.assertIn('${PGOPTIONS:+PGOPTIONS="$PGOPTIONS"}', text)


class PsqlDiagnostics(unittest.TestCase):
    """F-3: error evidence from `psql -f -` is read, with prefixes and line numbers, and fails closed when unreadable."""

    def parse(self, text):
        return db_cases.parse_diagnostics(text)

    def test_standard_error_output(self):
        errors, unparsed = self.parse("ERROR:  23001: ledger tables are append-only\nDETAIL:  UPDATE refused\nLOCATION:  x, y.c:1\n")
        self.assertEqual(errors, [("23001", "ledger tables are append-only", "UPDATE refused")])
        self.assertEqual(unparsed, [])

    def test_psql_prefixed_error_output(self):
        errors, unparsed = self.parse("psql:<stdin>:12: ERROR:  DW422: AUTHORITY_REDUCTION_BLOCKED\nDETAIL:  REDUCTION_EXCEEDS_CASH\nCONTEXT:  PL/pgSQL function\n")
        self.assertEqual(errors, [("DW422", "AUTHORITY_REDUCTION_BLOCKED", "REDUCTION_EXCEEDS_CASH")])
        self.assertEqual(unparsed, [])

    def test_prefixed_detail_line_is_also_accepted(self):
        errors, _ = self.parse("psql:<stdin>:3: ERROR:  DW409: STALE_VERSION\npsql:<stdin>:3: DETAIL:  x\n")
        self.assertEqual(errors, [("DW409", "STALE_VERSION", "x")])

    def test_prefix_with_a_path_containing_colons_and_spaces(self):
        errors, _ = self.parse("psql:/tmp/a b/c:d.sql:45: ERROR:  42501: permission denied for table journal_txn\n")
        self.assertEqual(errors, [("42501", "permission denied for table journal_txn", None)])

    def test_multiple_error_lines_keep_order_and_their_own_detail(self):
        text = ("psql:<stdin>:3: ERROR:  23505: duplicate key value violates unique constraint \"journal_account_name_uk\"\n"
                "DETAIL:  Key (allocation_id, account_name)=(x, y) already exists.\n"
                "psql:<stdin>:9: ERROR:  40001: could not serialize access\n"
                "psql:<stdin>:11: ERROR:  DW409: STALE_VERSION\n")
        errors, unparsed = self.parse(text)
        self.assertEqual([e[0] for e in errors], ["23505", "40001", "DW409"])
        self.assertIn("already exists", errors[0][2])
        self.assertIsNone(errors[1][2])
        self.assertIsNone(errors[2][2])
        self.assertEqual(unparsed, [])

    def test_a_detail_from_a_later_message_is_not_attached_to_an_earlier_error(self):
        errors, _ = self.parse("ERROR:  DW422: A\nNOTICE:  something\nDETAIL:  belongs to the notice\n")
        self.assertEqual(errors, [("DW422", "A", None)])

    def test_missing_sqlstate_is_unparsed_and_fails_closed(self):
        errors, unparsed = self.parse("psql:<stdin>:1: ERROR:  syntax error at or near \"x\"\n")
        self.assertEqual(errors, [])
        self.assertEqual(len(unparsed), 1)
        result = db_cases.Result(3, "", "psql:<stdin>:1: ERROR:  syntax error at or near \"x\"\n", errors, unparsed)
        for attr in ("state", "message", "detail"):
            with self.subTest(attr), self.assertRaises(db_cases.CaseFailure):
                getattr(result, attr)

    def test_unexpected_diagnostic_formats_fail_closed(self):
        for text in ("psql: error: connection to server on socket failed: No such file or directory\n",
                     "FATAL:  role \"x\" does not exist\n",
                     "psql:<stdin>:1: PANIC:  boom\n",
                     "ERROR 23001 append-only\nsomething else\n"):
            with self.subTest(text=text):
                errors, unparsed = self.parse(text)
                result = db_cases.Result(2, "", text, errors, unparsed)
                with self.assertRaises(db_cases.CaseFailure):
                    result.state

    def test_a_nonzero_exit_without_any_diagnostic_is_not_read_as_an_error_or_as_success(self):
        result = db_cases.Result(3, "", "REFUSED: something from the runner\n", *self.parse("REFUSED: something from the runner\n"))
        with self.assertRaises(db_cases.CaseFailure):
            result.state

    def test_a_clean_success_has_no_state(self):
        result = db_cases.Result(0, "1|2|3|f\n", "", *self.parse(""))
        self.assertIsNone(result.state)
        self.assertEqual(result.rows(), [["1", "2", "3", "f"]])

    def test_one_unreadable_line_poisons_an_otherwise_readable_result(self):
        text = "ERROR:  DW409: STALE_VERSION\nFATAL:  terminating connection\n"
        result = db_cases.Result(3, "", text, *self.parse(text))
        with self.assertRaises(db_cases.CaseFailure):
            result.state

    def test_parse_errors_wrapper_matches(self):
        self.assertEqual(db_cases.parse_errors("psql:<stdin>:3: ERROR:  23001: x\n"), [("23001", "x", None)])


class FakeDb:
    """A scripted stand-in for db_cases.Db. It runs the harness LOGIC with canned results; nothing connects to anything. It records
    every call, so a test can prove that a guard refused BEFORE any database contact."""

    def __init__(self, truncate_single="0A000", truncate_set="23001", per_table=None, trigger_count="4", facts=None, database="drawbridge_g2_dev"):
        self.database = database
        self.truncate_single, self.truncate_set = truncate_single, truncate_set
        self.per_table = per_table or {}
        self.trigger_count = trigger_count
        self.facts = facts
        self.calls = []

    def err(self, state, message="m"):
        return db_cases.Result(3, "", f"psql:<stdin>:1: ERROR:  {state}: {message}\n", [(state, message, None)], [])

    def seed_allocation(self, label):
        self.calls.append("seed")
        return str(uuid.uuid4())

    def call(self, *a, **kw):
        self.calls.append("call")
        return db_cases.Result(0, "e|t|1|f\n", "", [], [])

    def scalar(self, role, sql, **kw):
        self.calls.append("scalar")
        if "pg_trigger" in sql:
            return self.trigger_count
        if "current_database()" in sql and "shobj_description" in sql:
            return self.facts
        return "1,1,2,3" if sql.startswith("select (select") else "1"

    def run(self, role, sql, **kw):
        self.calls.append("run")
        if sql.startswith("select count(*)") and role in ("authority_svc", "drawbridge_reader") and "drawbridge_auth." in sql:
            return self.err("42501", "permission denied")
        if sql.startswith("insert into") and role in ("authority_svc", "drawbridge_reader"):
            return self.err("42501", "permission denied")
        if sql.startswith("select * from drawbridge_auth.post_funding"):
            return self.err("42501", "permission denied")
        return db_cases.Result(0, "5\n", "", [], [])

    def admin(self, sql, **kw):
        self.calls.append("admin")
        if sql.startswith("update") or sql.startswith("delete"):
            return self.err("23001", "append-only")
        if sql.startswith("truncate") and "," in sql:
            return self.err(self.truncate_set, "x") if self.truncate_set else db_cases.Result(0, "", "", [], [])
        if sql.startswith("truncate"):
            table = sql.rstrip(";").split(".")[-1]
            state = self.per_table.get(table, self.truncate_single)
            if state is None:
                return db_cases.Result(0, "", "", [], [])
            return self.err(state, "x")
        if sql.startswith("select * from drawbridge_auth.post_funding"):
            return self.err("42501", "permission denied")
        return db_cases.Result(0, "", "", [], [])


class TruncateExpectations(unittest.TestCase):
    """F-4 / N-4: each permitted SQLSTATE is tied to the invariant under test. Logic only; PostgreSQL decides which alternative really
    occurs and that remains NOT RUN."""

    def run_case(self, fake):
        body = next(c.body for c in db_cases.CASES if c.case_id == "G2C1-DBT-10")
        body(fake)

    def test_foreign_key_references_are_re_derived_from_the_migration(self):
        text = MIGRATION.read_text(encoding="utf-8")
        referenced = set(re.findall(r"REFERENCES drawbridge_auth\.(journal_txn|journal_account|journal_leg|allocation_event)\b", text))
        self.assertEqual(referenced, set(db_cases.FK_REFERENCED))
        self.assertEqual(db_cases.FK_REFERENCED, ("journal_txn", "journal_account"))
        for old in sorted(MIGRATION.parent.glob("00[01][0-9]_*.sql")):
            if old.name.startswith("0011"):
                continue
            self.assertNotRegex(old.read_text(encoding="utf-8"), r"REFERENCES\s+drawbridge_auth\.(journal_leg|allocation_event)\b", old.name)

    def test_the_permitted_states_per_table(self):
        self.assertEqual(db_cases.TRUNCATE_EXPECTED, {"allocation_event": {"23001"}, "journal_leg": {"23001"},
                                                      "journal_txn": {"23001", "0A000"}, "journal_account": {"23001", "0A000"}})
        self.assertEqual(sorted(db_cases.TRUNCATE_ALTERNATIVES), ["0A000", "23001"])

    def test_every_permitted_combination_is_accepted(self):
        for txn in ("23001", "0A000"):
            for account in ("23001", "0A000"):
                with self.subTest(txn=txn, account=account):
                    self.run_case(FakeDb(per_table={"allocation_event": "23001", "journal_leg": "23001", "journal_txn": txn, "journal_account": account}))

    def test_0a000_is_refused_where_no_foreign_key_condition_exists(self):
        for table in ("allocation_event", "journal_leg"):
            with self.subTest(table=table), self.assertRaises(db_cases.CaseFailure) as caught:
                self.run_case(FakeDb(per_table={"allocation_event": "23001", "journal_leg": "23001", table: "0A000"}))
            self.assertIn("cannot occur", str(caught.exception))

    def test_an_authorization_failure_is_not_accepted_as_a_trigger_refusal(self):
        for table in db_cases.LEDGER_TABLES:
            with self.subTest(table=table), self.assertRaises(db_cases.CaseFailure):
                self.run_case(FakeDb(per_table={"allocation_event": "23001", "journal_leg": "23001", "journal_txn": "23001", "journal_account": "23001", table: "42501"}))

    def test_an_arbitrary_error_is_not_accepted(self):
        for odd in ("XX000", "23503", "55000"):
            with self.subTest(odd=odd), self.assertRaises(db_cases.CaseFailure):
                self.run_case(FakeDb(per_table={"journal_txn": odd, "allocation_event": "23001", "journal_leg": "23001", "journal_account": "23001"}))

    def test_a_successful_truncate_is_a_failure(self):
        with self.assertRaises(db_cases.CaseFailure):
            self.run_case(FakeDb(per_table={"allocation_event": None}))

    def test_the_whole_set_truncate_must_reach_the_trigger(self):
        for state in ("0A000", "42501", None):
            with self.subTest(state=state), self.assertRaises(db_cases.CaseFailure):
                self.run_case(FakeDb(truncate_single="23001", truncate_set=state))

    def test_the_four_triggers_are_counted_in_the_catalog(self):
        self.assertIn("_no_truncate", db_cases.NO_TRUNCATE_TRIGGER_COUNT_SQL)
        self.assertIn("tgtype & 32", db_cases.NO_TRUNCATE_TRIGGER_COUNT_SQL)
        self.run_case(FakeDb(truncate_single="23001"))
        for count in ("3", "0", "5"):
            with self.subTest(count=count), self.assertRaises(db_cases.CaseFailure):
                self.run_case(FakeDb(truncate_single="23001", trigger_count=count))
        # the migration really creates <table>_no_truncate BEFORE TRUNCATE statement triggers for exactly these four tables
        text = MIGRATION.read_text(encoding="utf-8")
        self.assertIn("BEFORE TRUNCATE ON drawbridge_auth.%I FOR EACH STATEMENT", text)
        self.assertIn("t || '_no_truncate'", text)

    def test_an_unreadable_truncate_error_fails_closed(self):
        class Unreadable(FakeDb):
            def admin(self, sql, **kw):
                if sql.startswith("truncate"):
                    return db_cases.Result(3, "", "psql:<stdin>:1: ERROR:  cannot truncate\n", [], ["psql:<stdin>:1: ERROR:  cannot truncate"])
                return super().admin(sql, **kw)
        with self.assertRaises(db_cases.CaseFailure):
            self.run_case(Unreadable())


GOOD_FACTS = "|".join(["drawbridge_g2_scratch_inject_01", db_cases.EXPECTED_DATA_DIRECTORY, "54438", "", "on", db_cases.INJECTION_MARKER, "false"])
GOOD_ENV = {db_cases.INJECT_OPTIN_ENV: db_cases.inject_optin_value("drawbridge_g2_scratch_inject_01")}


import contextlib
import os


@contextlib.contextmanager
def optin_env(value=None):
    """Set (or clear) the injection opt-in variable for the duration of a with-block, then restore it."""
    saved = os.environ.pop(db_cases.INJECT_OPTIN_ENV, None)
    if value is not None:
        os.environ[db_cases.INJECT_OPTIN_ENV] = value
    try:
        yield
    finally:
        os.environ.pop(db_cases.INJECT_OPTIN_ENV, None)
        if saved is not None:
            os.environ[db_cases.INJECT_OPTIN_ENV] = saved


class FaultAndDefectInjectionCases(unittest.TestCase):
    """F-5 / N-5: the injection cases exist, say exactly what they cover, and never run unless the gate holds."""

    def test_new_cases_are_declared(self):
        ids = {c.case_id: c for c in db_cases.CASES}
        for cid in ("G2C1-DBT-25", "G2C1-DBT-26", "G2C1-DBT-27"):
            self.assertIn(cid, ids)
        self.assertTrue(ids["G2C1-DBT-26"].inject and ids["G2C1-DBT-27"].inject)
        self.assertFalse(ids["G2C1-DBT-25"].inject)
        self.assertEqual(len(ids), 27)

    def test_f02_and_f03_are_one_boundary_and_the_limitation_is_recorded(self):
        self.assertEqual(list(db_cases.FAULT_TRIGGERS), ["F01", "F23", "F04"])
        self.assertEqual(db_cases.FAULT_TRIGGERS["F23"], ("journal_leg", None))     # no leg_no filter: both legs, one statement
        self.assertNotIn("F02", db_cases.FAULT_SQLSTATES)
        self.assertNotIn("F03", db_cases.FAULT_SQLSTATES)
        self.assertEqual(len(set(db_cases.FAULT_SQLSTATES.values())), 3)
        self.assertIn("F02 and F03 share one boundary", db_cases.FAULT_COVERAGE_LIMITATION)
        self.assertIn("not independently verified", db_cases.FAULT_COVERAGE_LIMITATION)
        text = (HERE / "db_cases.py").read_text(encoding="utf-8")
        self.assertNotIn("new.leg_no = 1", text)
        self.assertNotIn("new.leg_no = 2", text)
        self.assertNotIn("independently verified fault boundaries", text.replace("not independently verified", ""))

    def test_the_migration_inserts_both_legs_in_one_statement(self):
        # the fact that makes F02 and F03 one boundary: a single INSERT ... VALUES with the two legs
        text = MIGRATION.read_text(encoding="utf-8")
        self.assertEqual(text.count("INSERT INTO drawbridge_auth.journal_leg"), 1)
        start = text.index("INSERT INTO drawbridge_auth.journal_leg")
        statement = text[start:text.index(";", start)]
        self.assertEqual(statement.count("(v_txn,"), 2)          # leg 1 and leg 2 are two rows of ONE statement
        self.assertIn("(v_txn, 1,", statement)
        self.assertIn("(v_txn, 2,", statement)

    def test_fault_sql_installs_after_insert_row_triggers_and_removes_them(self):
        for fault, (table, when) in db_cases.FAULT_TRIGGERS.items():
            install, remove = db_cases.fault_install_sql(fault), db_cases.fault_remove_sql(fault)
            low = fault.lower()
            self.assertIn(f"create trigger zz_fault_{low} after insert on drawbridge_auth.{table} for each row", install)
            self.assertIn(f"errcode = '{db_cases.FAULT_SQLSTATES[fault]}'", install)
            self.assertEqual("when" in install, when is not None)
            self.assertIn(f"drop trigger if exists zz_fault_{low} on drawbridge_auth.{table}", remove)
            self.assertNotIn("truncate", install + remove)

    def test_run_all_refuses_an_injection_database_with_an_enabled_run_and_runs_no_injection_case(self):
        stub = LaunchStub()
        for inject_db in ("drawbridge_g2_scratch_inject_01", "drawbridge_g2_dev", "x"):
            with self.subTest(inject_db), self.assertRaises(db_cases.SelectionRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, inject_database=inject_db, cases="G2C1-DBT-02", evidence_dir=evidence_tmp(), run=stub)
        self.assertEqual(stub.calls, [])
        report = {r["case_id"]: r["status"] for r in db_cases.run_all(enabled=False, database=SCRATCH, inject_database="drawbridge_g2_scratch_inject_01")}
        self.assertEqual(report["G2C1-DBT-26"], "NOT RUN")
        self.assertEqual(report["G2C1-DBT-27"], "NOT RUN")
        self.assertEqual(stub.calls, [])

    def test_whole_ledger_cases_refuse_an_injection_database(self):
        for cid in ("G2C1-DBT-18", "G2C1-DBT-19", "G2C1-DBT-20", "G2C1-DBT-23"):
            body = next(c.original for c in db_cases.CASES if c.case_id == cid)   # the preserved case function (DBT-23 is held, so its registered body only refuses)
            fake = FakeDb(database="drawbridge_g2_scratch_inject_01")
            with self.subTest(cid), self.assertRaises(db_cases.CaseFailure):
                body(fake)
            self.assertEqual(fake.calls, [], cid)

    def test_the_injected_ledger_transaction_sql_is_confined_to_one_transaction_with_replica_role(self):
        sql, txn = db_cases.injected_txn_sql("a", "T", [("CASH_ALLOCATED", "D", "5.00"), ("PROJECT_CAPITAL", "C", "4.00")], "5.00")
        self.assertTrue(sql.startswith("begin;\nset local session_replication_role = replica;"))
        self.assertTrue(sql.rstrip().endswith("commit;"))
        self.assertIn(txn, sql)
        self.assertNotIn("truncate", sql.lower())
        self.assertNotIn("alter ", sql.lower())

    def test_the_db_case_sources_contain_no_database_or_table_drop(self):
        text = (HERE / "db_cases.py").read_text(encoding="utf-8")
        self.assertNotRegex(text, r"(?i)drop\s+table|drop\s+database")


class InjectionGate(unittest.TestCase):
    """N-6: a name prefix alone never authorizes injection. Every condition is checked, and the refusal precedes any database call."""

    NAME = "drawbridge_g2_scratch_inject_01"

    def pre(self, name=NAME, acceptance="drawbridge_g2_dev", env=None):
        return db_cases.injection_precheck(name, acceptance, GOOD_ENV if env is None else env)

    def live(self, **change):
        parts = dict(zip(("db", "dir", "port", "listen", "fsync", "comment", "template"), GOOD_FACTS.split("|")))
        parts.update(change)
        return db_cases.injection_live_failures(self.NAME, "|".join(parts.values()))

    def test_all_conditions_satisfied(self):
        self.assertEqual(self.pre(), [])
        self.assertEqual(self.live(), [])

    def test_a_name_prefix_alone_is_refused(self):
        fails = self.pre(env={})
        self.assertTrue(any("opt-in" in f for f in fails), fails)
        self.assertTrue(self.pre(name=None))
        self.assertTrue(self.pre(name=""))

    def test_the_opt_in_is_bound_to_the_database_name(self):
        other = {db_cases.INJECT_OPTIN_ENV: db_cases.inject_optin_value("drawbridge_g2_scratch_inject_02")}
        self.assertTrue(any("opt-in" in f for f in self.pre(env=other)))
        for wrong in ("1", "yes", "DESTROY-THROWAWAY-DATABASE", db_cases.inject_optin_value(self.NAME) + " "):
            self.assertTrue(self.pre(env={db_cases.INJECT_OPTIN_ENV: wrong}), wrong)

    def test_default_system_unrecognised_and_acceptance_databases_are_refused(self):
        for name in ("drawbridge_g2_dev", "drawbridge_g2_test", "postgres", "template1", "template0", "drawbridge_g2_scratch"):
            self.assertTrue(self.pre(name=name, env={db_cases.INJECT_OPTIN_ENV: db_cases.inject_optin_value(name)}), name)
        for name in ("drawbridge_prod", "inject", "drawbridge_g2_scratch_injec", "x" + self.NAME):
            fails = self.pre(name=name, env={db_cases.INJECT_OPTIN_ENV: db_cases.inject_optin_value(name)})
            self.assertTrue(any("prefix" in f for f in fails), (name, fails))
        # the acceptance database may not double as the injection database even when it carries the prefix
        acc = self.NAME
        self.assertTrue(any("acceptance" in f for f in self.pre(name=acc, acceptance=acc)))

    def test_the_historical_cluster_is_refused(self):
        self.assertTrue(any("historical" in f for f in self.live(dir=str(db_cases.ROOT / "build" / "pg18-g2" / "data"), port="54418")))
        self.assertTrue(any("historical" in f for f in self.live(port="54418")))
        self.assertTrue(self.live(dir="/var/lib/postgresql/18/main"))

    def test_each_live_condition_is_enforced(self):
        for change in ({"db": "postgres"}, {"dir": "/elsewhere/build/pg18-g2c1/data"}, {"port": "5432"}, {"listen": "*"}, {"fsync": "off"},
                       {"comment": ""}, {"comment": "throwaway"}, {"template": "true"}):
            with self.subTest(change=change):
                self.assertTrue(self.live(**change))
        self.assertTrue(db_cases.injection_live_failures(self.NAME, "garbage"))
        self.assertTrue(db_cases.injection_live_failures(self.NAME, ""))

    def test_a_name_prefix_plus_a_correct_server_but_no_marker_is_refused(self):
        fails = self.live(comment="")
        self.assertEqual(len(fails), 1)
        self.assertIn("marker", fails[0])

    def test_the_cases_refuse_before_any_database_call(self):
        # With the body-level gate removed these calls would reach the fake (calls != []): the test discriminates (LOOM-2 V02 M17, M18).
        for cid in ("G2C1-DBT-26", "G2C1-DBT-27"):
            body = next(c.body for c in db_cases.CASES if c.case_id == cid)
            for name, value in (("drawbridge_g2_dev", db_cases.inject_optin_value("drawbridge_g2_dev")), ("drawbridge_g2_scratch_inject_01", None)):
                fake = FakeDb(database=name, facts=GOOD_FACTS)
                with self.subTest(cid=cid, name=name), optin_env(value), self.assertRaises(db_cases.CaseFailure):
                    body(fake)
                self.assertEqual(fake.calls, [], "a database method was called before the gate refused")

    def test_the_live_check_runs_after_the_cheap_gate_and_stops_the_case_on_a_bad_server(self):
        body = next(c.body for c in db_cases.CASES if c.case_id == "G2C1-DBT-27")
        fake = FakeDb(database=self.NAME, facts=GOOD_FACTS.replace(db_cases.INJECTION_MARKER, ""))
        with optin_env(db_cases.inject_optin_value(self.NAME)), self.assertRaises(db_cases.CaseFailure) as caught:
            body(fake)
        self.assertIn("marker", str(caught.exception))
        self.assertEqual(fake.calls, ["scalar"])      # exactly the one read-only identity query, then refusal


class FreshAllocationRaceClassification(unittest.TestCase):
    """F-1: the verdict for each possible loser outcome, and the approved retry rule is NOT widened."""

    def test_each_outcome_has_the_recorded_verdict(self):
        v = db_cases.f1_verdict
        self.assertEqual(v("40001", "could not serialize access due to read/write dependencies"), "OBSERVED_40001")
        for name in sorted(retry.RETRIABLE_UNIQUE_CONSTRAINTS):
            self.assertEqual(v("23505", f'duplicate key value violates unique constraint "{name}"'), "OBSERVED_23505_APPROVED", name)
        self.assertEqual(v("23505", 'duplicate key value violates unique constraint "journal_account_name_uk"'), "F1_CONFIRMED_OWNER_DECISION_REQUIRED")
        self.assertEqual(v("23505", 'duplicate key value violates unique constraint "journal_txn_pkey"'), "DEFECT_UNEXPECTED_UNIQUE")
        self.assertEqual(v("23505", "no constraint text"), "DEFECT_UNEXPECTED_UNIQUE")
        self.assertEqual(v("DW409", "STALE_VERSION"), "STABLE_REFUSAL_STALE_VERSION")
        self.assertEqual(v("DW409", "IDEMPOTENCY_CONFLICT"), "UNEXPECTED")
        self.assertEqual(v("XX000", "x"), "UNEXPECTED")
        self.assertEqual(set(db_cases.F1_VERDICTS), {"OBSERVED_40001", "OBSERVED_23505_APPROVED", "F1_CONFIRMED_OWNER_DECISION_REQUIRED",
                                                      "STABLE_REFUSAL_STALE_VERSION", "DEFECT_UNEXPECTED_UNIQUE", "UNEXPECTED"})

    def test_the_approved_retry_list_and_bound_are_unchanged(self):
        self.assertEqual(retry.RETRIABLE_UNIQUE_CONSTRAINTS, frozenset({
            "journal_txn_idempotency_key_uk", "journal_txn_posting_identity_uk", "allocation_event_allocation_version_uk"}))
        self.assertEqual(retry.MAX_ATTEMPTS, 3)
        self.assertEqual(retry.classify(Err("23505", "journal_account_name_uk")), "DEFECT_UNEXPECTED_UNIQUE")

    def test_the_case_arranges_the_scenario_the_finding_asks_for(self):
        text = (HERE / "db_cases.py").read_text(encoding="utf-8")
        body = text[text.index("def fresh_allocation_race"):text.index("# ------", text.index("def fresh_allocation_race"))]
        for needle in ("journal_account where allocation_id", "== \"0\"", "range(2)", "SERIALIZABLE", "sequential", "events, versions",
                       "CaseFinding", "F1_CONFIRMED_OWNER_DECISION_REQUIRED", "idempotency_key", "posting_identity", "retry.classify"):
            self.assertIn(needle, body, needle)
        self.assertNotIn("RETRIABLE_UNIQUE_CONSTRAINTS.add", text)
        self.assertNotIn("RETRIABLE_UNIQUE_CONSTRAINTS |", text)


class ManifestMalformedInput(unittest.TestCase):
    """F-6: malformed manifest input yields a defined verification failure, never PASS and never an unhandled exception."""

    def setUp(self):
        self.doc = manifest.build_manifest(build_snapshot())

    def verify(self, doc, **kw):
        return manifest.verify_manifest(manifest.manifest_bytes(doc), **kw)

    def test_unhashable_allocation_id_is_a_defined_failure(self):
        for bad in (["x"], {"k": "v"}, [[]], {"a": {"b": 1}}):
            doc = copy.deepcopy(self.doc)
            doc["allocations"][0]["allocation_id"] = bad
            with self.subTest(bad=bad):
                result = self.verify(doc)
                self.assertFalse(result["ok"])
                self.assertIn("ALLOCATION_ID", {f["code"] for f in result["failures"]})

    def test_unhashable_ids_with_anchors_do_not_raise_and_do_not_satisfy_the_anchor(self):
        doc = copy.deepcopy(self.doc)
        good = doc["allocations"][0]["allocation_id"]
        head = doc["allocations"][0]["head_sha256"]
        doc["allocations"][0]["allocation_id"] = [good]
        result = self.verify(doc, expected_heads={good: head}, expected_counts={good: 3})
        self.assertFalse(result["ok"])
        self.assertTrue({"HEAD_MISMATCH", "COUNT_MISMATCH"} <= {f["code"] for f in result["failures"]})

    def test_non_dict_allocations_and_other_wrong_types_never_pass_and_never_raise(self):
        for mutate in (lambda d: d["allocations"].append(None), lambda d: d["allocations"].append([1, 2]),
                       lambda d: d["allocations"].append("x"), lambda d: d["allocations"].__setitem__(0, 5),
                       lambda d: d["allocations"][0].__setitem__("events", [[]]),
                       lambda d: d["allocations"][0].__setitem__("events", [None]),
                       lambda d: d["allocations"][0]["events"][0].__setitem__("legs", [None, None]),
                       lambda d: d["allocations"][0]["events"][0].__setitem__("legs", [{"direction": ["D"]}, {}]),
                       lambda d: d["allocations"][0]["events"][0].__setitem__("event_kind", ["FUNDING"]),
                       lambda d: d["allocations"][0]["events"][0].__setitem__("currency", {"a": 1}),
                       lambda d: d["allocations"][0].__setitem__("event_count", [3]),
                       lambda d: d["allocations"][0].__setitem__("head_sha256", ["0"])):
            doc = copy.deepcopy(self.doc)
            mutate(doc)
            with self.subTest():
                result = self.verify(doc)
                self.assertFalse(result["ok"])
                self.assertTrue(result["failures"])

    def test_the_verifier_never_raises_for_arbitrary_documents(self):
        for data in (b"", b"null", b"[]", b"{}", b'{"allocations":[[]]}', b'{"allocations":[{"allocation_id":[1]}]}', b"\xff\xfe", b"1e999"):
            with self.subTest(data=data):
                self.assertFalse(manifest.verify_manifest(data)["ok"])

    def test_the_valid_manifest_still_passes_and_chain_bytes_are_unchanged(self):
        data = manifest.manifest_bytes(self.doc)
        self.assertTrue(manifest.verify_manifest(data)["ok"])
        self.assertEqual(data, canonical.canonical_compact(self.doc))
        self.assertEqual(len(manifest.verify_manifest(data)["limitations"]), 7)

    def test_each_mutation_fails_with_its_own_code(self):
        expected = {
            "reverse legs": (lambda e: e["legs"].reverse(), "LEG_PATTERN"),
            "disbursed account": (lambda e: e["legs"][0].update(account_name="DISBURSED"), "LEG_PATTERN"),
            "drop a leg": (lambda e: e["legs"].pop(), "LEG_PATTERN"),
            "boolean amount": (lambda e: e.update(amount_cents=True), "ENTRY_FIELD"),
            "settlement kind": (lambda e: e.update(event_kind="SETTLEMENT"), "ENTRY_FIELD"),
            "wrong version": (lambda e: e.update(version=9), "ENTRY_FIELD"),
        }
        for label, (mutate, code) in expected.items():
            doc = copy.deepcopy(self.doc)
            mutate(doc["allocations"][0]["events"][0])
            with self.subTest(label):
                self.assertIn(code, {f["code"] for f in self.verify(doc)["failures"]})

    def test_cli_verify_reports_a_defined_failure_for_an_unhashable_id(self):
        from ledger import cli
        doc = copy.deepcopy(self.doc)
        doc["allocations"][0]["allocation_id"] = ["x"]
        with scratch_tmp() as tmp:
            path = Path(tmp) / "m.json"
            path.write_bytes(manifest.manifest_bytes(doc))
            with mock.patch("sys.stdout"):
                self.assertEqual(cli.main(["verify", "--manifest", str(path)]), 1)


BASH = "/bin/bash"
APPROVED_BASE_NAMES = ["0001_g2a_schema_foundation.sql", "0002_g2a_normalization_v1.sql", "0003_g2a_project_allocation_counterparty.sql", "0004_g2a_rc1_usd_only.sql",
                       "0005_g2b_evidence_lineage_registries.sql", "0006_g2b_obligation_history_guard.sql", "0007_g2b_protected_functions.sql",
                       "0008_g2b_r1_trusted_source_document.sql", "0009_g2b_r2_u2_referential_integrity.sql", "0010_g2b_r2_byte_input_boundary.sql"]


class RunnerGuards(unittest.TestCase):
    """F-10 / F-11. Negative guard tests that never start, stop or contact a cluster: each scenario is refused by the path guards,
    which run before any PostgreSQL binary is named."""

    def tree(self, tmp: Path) -> Path:
        tools = tmp / "services/api/app/domain/g2_db/tools"
        tools.mkdir(parents=True)
        script = tools / "g2c1_durable_cluster.sh"
        script.write_bytes(RUNNER.read_bytes())
        script.chmod(0o755)
        (tmp / "db/migrations").mkdir(parents=True)
        return script

    def run_script(self, script, *args):
        return subprocess.run([str(script), *args], capture_output=True, text=True, check=False, timeout=60,
                              env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})

    def refused(self, done, fragment):
        self.assertEqual(done.returncode, 3, done.stderr)
        self.assertIn("REFUSED", done.stderr)
        self.assertIn(fragment, done.stderr)

    def test_a_symlinked_cluster_directory_is_refused_by_every_command(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            elsewhere = tmp / "elsewhere/pg18-g2"          # stands for a different cluster
            (elsewhere / "data").mkdir(parents=True)
            (elsewhere / "data/PG_VERSION").write_text("18\n")
            (tmp / "build").mkdir()
            (tmp / "build/pg18-g2c1").symlink_to(elsewhere)
            for command in ("status", "start", "stop", "crash-stop", "crash-kill", "identity"):
                with self.subTest(command):
                    self.refused(self.run_script(script, command), "symbolic link")

    def test_a_symlinked_build_directory_is_refused(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            (tmp / "elsewhere").mkdir()
            (tmp / "build").symlink_to(tmp / "elsewhere")
            self.refused(self.run_script(script, "status"), "symbolic link")

    def test_a_symlinked_data_directory_is_refused(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            other = tmp / "other_cluster_data"
            other.mkdir()
            (other / "PG_VERSION").write_text("18\n")
            base = tmp / "build/pg18-g2c1"
            base.mkdir(parents=True)
            (base / "data").symlink_to(other)
            for command in ("start", "stop", "crash-stop", "status"):
                with self.subTest(command):
                    self.refused(self.run_script(script, command), "symbolic link")

    def test_a_symlinked_identity_file_or_postgresql_conf_is_refused(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            base = tmp / "build/pg18-g2c1"
            (base / "data").mkdir(parents=True)
            (base / "data/PG_VERSION").write_text("18\n")
            real = tmp / "foreign.conf"
            real.write_text("port = 54438\n")
            (base / "data/postgresql.conf").symlink_to(real)
            self.refused(self.run_script(script, "status"), "symbolic link")

    def test_an_unrecorded_cluster_directory_is_refused_before_pg_ctl(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            data = tmp / "build/pg18-g2c1/data"
            data.mkdir(parents=True)
            (data / "PG_VERSION").write_text("18\n")
            for command in ("start", "stop", "crash-stop", "status", "crash-kill"):
                with self.subTest(command):
                    self.refused(self.run_script(script, command), "identity file")

    def test_a_cluster_whose_configuration_names_another_port_is_refused(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            base = tmp / "build/pg18-g2c1"
            data = base / "data"
            data.mkdir(parents=True)
            (data / "PG_VERSION").write_text("18\n")
            (base / "identity.txt").write_text(f"data_directory={data}\nport=54438\n")
            (data / "postgresql.conf").write_text("port = 54418\nunix_socket_directories = '/x'\nfsync = off\n")
            self.refused(self.run_script(script, "start"), "port 54438")

    def test_a_symlinked_script_is_refused(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            alias = tmp / "alias.sh"
            alias.symlink_to(script)
            done = self.run_script(alias, "status")
            self.refused(done, "symbolic link")

    def test_a_symlinked_migration_file_or_directory_is_refused_before_any_connection(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            real = tmp / "real_0011.sql"
            real.write_text("select 1;\n")
            (tmp / "db/migrations/0011_g2c1_funding_ledger.sql").symlink_to(real)
            digest = hashlib.sha256(real.read_bytes()).hexdigest()
            self.refused(self.run_script(script, "migrate-0011", "drawbridge_g2_scratch", digest), "symbolic link")

    def test_a_wrong_hash_is_refused_before_any_connection(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            script = self.tree(tmp)
            (tmp / "db/migrations/0011_g2c1_funding_ledger.sql").write_text("select 1;\n")
            self.refused(self.run_script(script, "migrate-0011", "drawbridge_g2_scratch", "0" * 64), "not the owner-approved hash")
            self.refused(self.run_script(script, "migrate-0011", "drawbridge_g2_scratch", "ABC"), "64 lower-case hex")
            self.refused(self.run_script(script, "migrate-0011", "not_a_scratch_db", "0" * 64), "not the owner-approved apply target")

    def test_commands_on_an_absent_cluster_are_refused(self):
        with scratch_tmp() as tmp:
            script = self.tree(Path(tmp))
            for command in ("start", "stop", "crash-stop", "status"):
                with self.subTest(command):
                    self.refused(self.run_script(script, command), "not initialised")

    def test_root_and_unknown_command_behaviour(self):
        with scratch_tmp() as tmp:
            script = self.tree(Path(tmp))
            done = self.run_script(script, "frobnicate")
            self.assertEqual(done.returncode, 2)
            self.assertIn("usage", done.stderr)

    def test_the_real_runner_has_no_delete_operation_and_no_historical_cluster_reference(self):
        code = "\n".join(l for l in RUNNER.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("#"))
        for word in (" rm ", "rm -", "rmdir", "unlink", "shred", "dropdb", "pg_resetwal", "mv "):
            self.assertNotIn(word, code, word)
        self.assertNotRegex(code, r"pg18-g2(?!c1)")
        self.assertNotIn("54418", code)
        self.assertIn("fsync = on", code)
        self.assertIn("readonly PORT=54438", code)


class RunnerAppliesTheVerifiedBytes(unittest.TestCase):
    """F-11: apply_file reads the file once; the hash that is checked is over those bytes; those bytes (not the path) reach psql."""

    def extract(self) -> str:
        text = RUNNER.read_text(encoding="utf-8")
        start = text.index("# ---- ledger status")
        end = text.index('case "${1:-}" in')
        return text[start:end]

    def harness(self, tmp: Path, body: str, want: str, replace_during_apply: bool = False) -> subprocess.CompletedProcess:
        mig = tmp / "db/migrations"
        mig.mkdir(parents=True, exist_ok=True)
        captured = tmp / "captured.sql"
        calls = tmp / "calls.log"
        script = tmp / "harness.sh"
        script.write_text(f"""#!/bin/bash
set -euo pipefail
ROOT={tmp}
die() {{ echo "REFUSED: $*" >&2; exit 3; }}
sha_of() {{ sha256sum "$1" | cut -d' ' -f1; }}
q() {{ # stub for the guarded psql: the migration reaches it only on stdin
  echo "q $*" >> {calls}
  case "$*" in
    *to_regclass*) echo f ;;
    *"select file_sha256"*) sha256sum {captured} | cut -d' ' -f1 ;;
    *"-f -"*) {"printf 'tampered' > " + str(mig / '0011_g2c1_funding_ledger.sql') + ";" if replace_during_apply else ""} cat > {captured} ;;
    *) echo "" ;;
  esac
}}
{self.extract()}
apply_file {mig}/0011_g2c1_funding_ledger.sql {want}
""", encoding="utf-8")
        (mig / "0011_g2c1_funding_ledger.sql").write_bytes(body.encode("utf-8"))
        return subprocess.run([BASH, str(script)], capture_output=True, text=True, check=False, timeout=60)

    def test_the_bytes_that_reach_psql_are_exactly_the_approved_bytes(self):
        body = "-- é line one\nselect 1;\n\n\n"          # trailing blank lines and non-ASCII must survive exactly
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            done = self.harness(tmp, body, digest)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((tmp / "captured.sql").read_bytes(), body.encode("utf-8"))
            self.assertIn(f"sha256={digest}", done.stdout)
            calls = (tmp / "calls.log").read_text()
            self.assertIn(f"values ('0011_g2c1_funding_ledger.sql','{digest}')", calls)
            self.assertNotRegex(calls, r"-f \S*0011_g2c1_funding_ledger\.sql")     # the path is never handed to psql

    def test_a_file_replaced_after_the_read_cannot_change_what_is_applied(self):
        body = "select 'approved';\n"
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            done = self.harness(tmp, body, digest, replace_during_apply=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((tmp / "captured.sql").read_bytes(), body.encode("utf-8"))
            self.assertEqual((tmp / "db/migrations/0011_g2c1_funding_ledger.sql").read_bytes(), b"tampered")   # the file really was replaced

    def test_bytes_that_do_not_match_the_approved_hash_are_never_sent(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            done = self.harness(tmp, "select 2;\n", hashlib.sha256(b"select 1;\n").hexdigest())
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("not the owner-approved hash", done.stderr)
            self.assertFalse((tmp / "captured.sql").exists())
            self.assertNotIn("-f -", (tmp / "calls.log").read_text() if (tmp / "calls.log").exists() else "")

    def test_a_nul_byte_is_refused_not_silently_truncated(self):
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            mig = tmp / "db/migrations"
            mig.mkdir(parents=True)
            data = b"select 1;\x00select 2;\n"
            digest = hashlib.sha256(data).hexdigest()
            done = self.harness(tmp, "x", digest)           # create the harness, then swap in the NUL file
            (mig / "0011_g2c1_funding_ledger.sql").write_bytes(data)
            again = subprocess.run([BASH, str(tmp / "harness.sh")], capture_output=True, text=True, check=False, timeout=60)
            self.assertEqual(again.returncode, 3, again.stderr)
            self.assertFalse((tmp / "captured.sql").exists())

    def test_the_runner_text_applies_stdin_and_never_a_path(self):
        text = RUNNER.read_text(encoding="utf-8")
        body = self.extract()
        self.assertIn("-f -", body)
        self.assertNotRegex(body, r'\bq [^\n]*-f "\$f"')
        self.assertIn('apply_file "$F" "$APPROVED"', text)
        self.assertIn("realpath -e", body)


# ---------------------------------------------------------------------------------------------------------------------------------
# V02 pre-apply safety repair (N-1, N-2, N-3, N-7). Everything here is offline. A STUB program stands in for psql; it logs its
# arguments and environment and connects to nothing. The runner is the only code under test.
import socket
import stat

OLD_RUNNER_COMMIT = "ea3e9168f4e1582e98e2821e99daf50b18e4d9dd"
OLD_RUN_PSQL_LAST = '"${clean[@]}" "$BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -p "$PORT" -U "$role" -d "$db" "$@"'
NEW_RUN_PSQL_LAST = '"${clean[@]}" "$BIN/psql" -X -q -v ON_ERROR_STOP=1 "$@" -h "$SOCK" -p "$PORT" -U "$role" -d "$db"'


def old_runner_text() -> str:
    """The runner as committed in ea3e9168: caller arguments are appended AFTER the runner's own connection options and the public
    `psql` command passes them through. Taken from git when that commit is available, otherwise rebuilt from the current text by
    restoring exactly those two behaviours."""
    done = subprocess.run(["git", "-C", str(ROOT), "show", f"{OLD_RUNNER_COMMIT}:services/api/app/domain/g2_db/tools/g2c1_durable_cluster.sh"],
                          capture_output=True, text=True, check=False)
    if done.returncode == 0 and OLD_RUN_PSQL_LAST in done.stdout:
        return done.stdout
    text = RUNNER.read_text(encoding="utf-8")
    assert NEW_RUN_PSQL_LAST in text
    text = text.replace(NEW_RUN_PSQL_LAST, OLD_RUN_PSQL_LAST)
    start = text.index('    check_db "$DB"; check_role "$ROLE"\n    validate_psql_args')
    end = text.index(";;", start)
    return text[:start] + '    run_psql "$DB" "$ROLE" "$@" ' + text[end:]


class StubCluster:
    """A throwaway tree holding a copy of a runner, a bound-but-unused unix socket file where the cluster socket would be, and a stub
    `psql` that answers the cluster-fact query correctly, answers migration-ledger queries from the tree, and logs every call."""

    def __init__(self, runner_text: str, tmp: Path):
        self.tmp = tmp
        tools = tmp / "services/api/app/domain/g2_db/tools"
        tools.mkdir(parents=True)
        self.script = tools / "g2c1_durable_cluster.sh"
        self.bin = tmp / "stubbin"
        self.bin.mkdir()
        self.log, self.stdin_capture = tmp / "psql.log", tmp / "stdin.capture"
        self.base = tmp / "build/pg18-g2c1"
        self.data, self.sock = self.base / "data", self.base / "sock"
        self.sock.mkdir(parents=True)
        self.data.mkdir()
        self.mig = tmp / "db/migrations"
        self.mig.mkdir(parents=True)
        self.recorded_0011 = tmp / "recorded_0011"
        bin_line = "BIN=/usr/lib/postgresql/18/bin"
        assert runner_text.count(bin_line) == 1
        self.script.write_text(runner_text.replace(bin_line, f"BIN={self.bin}"), encoding="utf-8")
        self.script.chmod(0o755)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.sock / ".s.PGSQL.54438"))     # creates the socket FILE only; nothing listens, nothing connects
        listener.close()
        facts = f"{self.data}||{self.sock}|54438|on|on|on|on|180000"
        stub = self.bin / "psql"
        stub.write_text(f"""#!/bin/bash
{{ printf 'ARGV:'; for a in "$@"; do printf ' [%s]' "$a"; done; echo; env | sort | sed 's/^/ENV: /'; }} >> {self.log}
all="$*"
case "$all" in
  *"current_setting('data_directory')"*) echo "{facts}"; exit 0 ;;
  *"to_regclass('drawbridge_auth.schema_migration')"*) echo t; exit 0 ;;
esac
if [[ "$all" =~ file_name=\\'([^\\']+)\\' ]]; then
  n="${{BASH_REMATCH[1]}}"
  if [[ "$n" == 0011* && ! -e {self.recorded_0011} ]]; then exit 0; fi
  sha256sum {self.mig}/"$n" | cut -d' ' -f1; exit 0
fi
case " $all " in *" -f - "*) cat >> {self.stdin_capture}; case "$all" in *"values ('0011"*) : > {self.recorded_0011} ;; esac ;; esac
exit 0
""", encoding="utf-8")
        stub.chmod(0o555)
        self.bin.chmod(0o555)          # the runner trusts a PostgreSQL binary directory only if the invoking user cannot write to it

    def run(self, *args, env=None, stdin=None):
        full = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", **(env or {})}
        return subprocess.run([str(self.script), *args], capture_output=True, text=True, check=False, timeout=60, env=full, input=stdin or "")

    def invocations(self):
        """The stub's calls except the cluster-fact verification: [(argv list, env dict)]."""
        if not self.log.exists():
            return []
        calls, argv, env = [], None, {}
        for line in self.log.read_text(encoding="utf-8").splitlines():
            if line.startswith("ARGV:"):
                if argv is not None:
                    calls.append((argv, env))
                argv, env = re.findall(r"\[(.*?)\]", line[5:], flags=re.S), {}
            elif line.startswith("ENV: ") and argv is not None:
                k, _, v = line[5:].partition("=")
                env[k] = v
        if argv is not None:
            calls.append((argv, env))
        return calls

    def connections(self):
        return [c for c in self.invocations() if not any("current_setting('data_directory')" in a for a in c[0])]

    def verifications(self):
        return [c for c in self.invocations() if any("current_setting('data_directory')" in a for a in c[0])]


def effective_target(argv):
    """What psql would use if the LAST occurrence of an option wins (reasoned from how psql assigns each option; NOT observed)."""
    target, i = {}, 0
    while i < len(argv):
        for flag, key in (("-h", "host"), ("-p", "port"), ("-U", "user"), ("-d", "dbname")):
            if argv[i] == flag and i + 1 < len(argv):
                target[key] = argv[i + 1]
                i += 1
                break
        i += 1
    return target


SOCKET_SUFFIX = "/build/pg18-g2c1/sock/.s.PGSQL.54438"


def short_tmp():
    """A runner tree beneath the approved root (A11 B-5; never /tmp). Unix socket paths are limited to 107 bytes: the length of the cluster socket path
    under the new directory is checked BEFORE any use and an over-long path STOPS the test (no fallback to /tmp)."""
    t = scratch_tmp("g2c1t")
    if len(os.fsencode(t.name + SOCKET_SUFFIX)) > UNIX_SOCKET_PATH_MAX:
        raise RuntimeError(f"STOP: the socket path under the approved root exceeds {UNIX_SOCKET_PATH_MAX} bytes; no fallback to /tmp is permitted")
    return t


class RunnerPsqlTargetIsolation(unittest.TestCase):
    """N-1: the guarded psql command cannot be retargeted by its arguments, its environment or its input. A STUB psql is used; the
    real psql is never invoked."""

    OVERRIDE = ["-h", "/elsewhere/pg18-g2/sock", "-p", "54418", "-d", "otherdb", "-U", "postgres", "-c", "select 1"]

    def stub(self, text, tmp):
        return StubCluster(text, Path(tmp))

    def test_the_old_runner_let_the_caller_override_the_verified_target(self):
        with short_tmp() as tmp:
            st = self.stub(old_runner_text(), tmp)
            done = st.run("psql", "drawbridge_g2_dev", "authority_svc", *self.OVERRIDE)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(len(st.verifications()), 1)               # the verification ran against the correct socket ...
            argv, _ = st.connections()[0]
            target = effective_target(argv)                          # ... and the connection goes elsewhere
            self.assertEqual(target, {"host": "/elsewhere/pg18-g2/sock", "port": "54418", "user": "postgres", "dbname": "otherdb"})
            self.assertEqual(argv[argv.index("-h") + 1], str(st.sock))   # the runner's own value was there first and was outvoted

    def test_the_repaired_runner_rejects_the_same_attempt_before_any_psql_call(self):
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            done = st.run("psql", "drawbridge_g2_dev", "authority_svc", *self.OVERRIDE)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("is not allowed", done.stderr)
            self.assertEqual(st.invocations(), [])                      # not even the cluster-fact query ran

    def test_every_target_selecting_argument_is_rejected(self):
        attempts = [["-h", "/x"], ["-hX"], ["-p", "54418"], ["-p54418"], ["-U", "postgres"], ["-Upostgres"], ["-d", "other"], ["-dother"],
                    ["--host=/x"], ["--host", "/x"], ["--port=54418"], ["--username=postgres"], ["--dbname=other"],
                    ["postgresql://u@h:1/db"], ["otherdb"], ["-l"], ["--list"], ["-W"], ["-w"], ["-X"], ["--no-psqlrc"],
                    ["-o", "/tmp/out"], ["-L", "/tmp/log"], ["-s"], ["-S"], ["-e"], ["-a"], ["-E"], ["-b"], ["-n"], ["-z"], ["-0"], ["-R", "x"],
                    ["-P", "pager=on"], ["-T", "x"], ["-V"], ["--help"], ["--"], ["-Atd", "other"], ["-q"], ["--set=x=1"], ["--single-transaction"],
                    ["-f", "/etc/passwd"], ["-f", "file.sql"], ["--file=x"], ["-f"], ["-c"], ["-F"], ["-v"], ["-c", ""]]
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            for extra in attempts:
                with self.subTest(extra=extra):
                    for argv in (extra, extra + ["-c", "select 1"], ["-c", "select 1"] + extra):
                        done = st.run("psql", "drawbridge_g2_dev", "authority_svc", *argv)
                        self.assertEqual(done.returncode, 3, (argv, done.stderr))
                        self.assertIn("REFUSED", done.stderr)
            for argv in ([], ["-At"], ["-1"], ["-At", "-F", "|"]):       # nothing to run: an interactive session is not supported
                done = st.run("psql", "drawbridge_g2_dev", "authority_svc", *argv)
                self.assertEqual(done.returncode, 3, (argv, done.stderr))
            self.assertEqual(st.invocations(), [], "a rejected argument vector reached psql")

    def test_variables_and_command_text_cannot_smuggle_a_meta_command_or_a_target(self):
        attempts = [["-v", "HOST=x", "-c", "select 1"], ["-v", "PGHOST=x", "-c", "select 1"], ["-v", "DBNAME=x", "-c", "select 1"], ["-v", "USER=x", "-c", "select 1"],
                    ["-v", "PORT=1", "-c", "select 1"], ["-v", "ON_ERROR_STOP=0", "-c", "select 1"], ["-v", "AUTOCOMMIT=off", "-c", "select 1"],
                    ["-v", "ECHO=all", "-c", "select 1"], ["-v", "novalue", "-c", "select 1"], ["-v", "=x", "-c", "select 1"], ["-v", "1x=y", "-c", "select 1"],
                    ["-v", "VERBOSITY=bogus", "-c", "select 1"], ["-v", "x=a\\b", "-c", "select 1"], ["-v", "x=\\connect other", "-c", "select 1"],
                    ["-c", "\\connect other"], ["-c", "\\c other"], ["-c", "select 1 \\gset"], ["-c", "select 1; \\c other"], ["-c", "\\! id"],
                    ["-F", "\\t", "-c", "select 1"], ["-F", "", "-c", "select 1"], ["-F", "123456789", "-c", "select 1"]]
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            for argv in attempts:
                with self.subTest(argv=argv):
                    done = st.run("psql", "drawbridge_g2_dev", "authority_svc", *argv)
                    self.assertEqual(done.returncode, 3, (argv, done.stderr))
            self.assertEqual(st.invocations(), [])

    def test_input_that_contains_a_backslash_is_stopped_before_it_reaches_psql(self):
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            for text in ("select 1;\n\\connect other\nselect 2;\n", "select 1; \\c other\n", "\\! id\n", "select E'a\\nb';\n"):
                st.stdin_capture.write_text("") if st.stdin_capture.exists() else None
                before = st.stdin_capture.read_text() if st.stdin_capture.exists() else ""
                done = st.run("psql", "drawbridge_g2_dev", "authority_svc", "-f", "-", stdin=text)
                self.assertNotEqual(done.returncode, 0, text)
                self.assertIn("backslash", done.stderr)
                sent = (st.stdin_capture.read_text() if st.stdin_capture.exists() else "")[len(before):]
                self.assertNotIn("\\", sent, (text, sent))
                self.assertNotIn("select 2", sent)
            # a harmless statement before the offending line has been submitted, which is why the refusal exits non-zero

    def test_the_environment_cannot_reach_psql(self):
        poison = {"PGHOST": "/elsewhere", "PGPORT": "54418", "PGUSER": "postgres", "PGDATABASE": "other", "PGSERVICE": "x", "PGSERVICEFILE": "/x",
                  "PGPASSFILE": "/x", "PGPASSWORD": "x", "PGSSLMODE": "disable", "PGSYSCONFDIR": "/x", "PGHOSTADDR": "127.0.0.1",
                  "DATABASE_URL": "postgresql://x", "PSQLRC": "/x", "PSQL_HISTORY": "/x", "HOME": "/x", "G2C1_PSQL_LANG": "C", "G2C1_PSQL_APPNAME": "x",
                  "PGAPPNAME": "x", "BASH_ENV": "/x", "ENV": "/x"}     # loader variables (LD_*) are refused outright: see RunnerTrustedExecution
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            done = st.run("psql", "drawbridge_g2_dev", "authority_svc", "-At", "-c", "select 1", env=poison)
            self.assertEqual(done.returncode, 0, done.stderr)
            for argv, env in st.invocations():
                self.assertEqual(sorted(env), sorted(k for k in env if k in ("PATH", "LANG", "PWD", "SHLVL", "_", "OLDPWD")), env)
                self.assertEqual(env.get("LANG"), "C.UTF-8")

    def test_pgoptions_is_a_closed_list(self):
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            for bad in ("-c role=drawbridge_owner", "-c search_path=x", "-c session_authorization=postgres", "-c default_transaction_isolation=serializable -c role=x",
                        "-c default_transaction_isolation=read committed", "--host=x", "-c default_transaction_read_only=off"):
                with self.subTest(bad=bad):
                    done = st.run("psql", "drawbridge_g2_dev", "authority_svc", "-c", "select 1", env={"PGOPTIONS": bad})
                    self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(st.invocations(), [])
            for good, shown in ((db_cases.SERIALIZABLE, db_cases.SERIALIZABLE), (db_cases.READ_COMMITTED, db_cases.READ_COMMITTED),
                                ("-c default_transaction_isolation=repeatable\\ read", "-c default_transaction_isolation=repeatable\\ read"), ("", None)):
                with self.subTest(good=good):
                    st.log.write_text("") if st.log.exists() else None
                    done = st.run("psql", "drawbridge_g2_dev", "authority_svc", "-c", "select 1", env={"PGOPTIONS": good} if good else {})
                    self.assertEqual(done.returncode, 0, done.stderr)
                    envs = [e for _, e in st.connections()]
                    self.assertEqual(envs[-1].get("PGOPTIONS"), shown)

    def test_database_and_role_allowlists_still_hold(self):
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            for db, role in (("drawbridge_prod", "authority_svc"), ("drawbridge_g2_dev", "postgres"), ("drawbridge_g2_dev;x", "authority_svc"), ("drawbridge_g2_dev", "drawbridge_owner")):
                done = st.run("psql", db, role, "-c", "select 1")
                self.assertEqual(done.returncode, 3, (db, role, done.stderr))
            self.assertEqual(st.invocations(), [])

    def test_an_allowed_command_runs_with_the_runners_own_target_last_and_only_the_allowed_arguments(self):
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            sql = "select 1;\nselect 'é';\n"
            done = st.run("psql", "drawbridge_g2_dev", "authority_svc", "-At", "-F", "|", "-v", "VERBOSITY=verbose", "-v", "alloc=abc", "-f", "-", env={"PGOPTIONS": db_cases.SERIALIZABLE}, stdin=sql)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(st.stdin_capture.read_text(), sql)
            argv, env = st.connections()[0]
            self.assertEqual(argv[-8:], ["-h", str(st.sock), "-p", "54438", "-U", "authority_svc", "-d", "drawbridge_g2_dev"])
            self.assertEqual(effective_target(argv), {"host": str(st.sock), "port": "54438", "user": "authority_svc", "dbname": "drawbridge_g2_dev"})
            self.assertEqual(argv.count("-h"), 1)
            self.assertEqual(argv.count("-d"), 1)
            self.assertEqual(env.get("PGOPTIONS"), db_cases.SERIALIZABLE)

    def test_the_real_consumers_use_only_allowed_arguments(self):
        # the argument vectors that db_cases.Db and snapshot.fetch_snapshot build must pass the runner's closed allowlist, and (new) are
        # executed DIRECTLY: argv[0] is the runner and nothing precedes it
        good = json.dumps({"txn_read_only": "on", "txn_isolation": "repeatable read", "events": [], "balances": [], "reconciliation": []})
        snap_stub, db_stub = LaunchStub(out=good), LaunchStub(out="e|t|1|f\n")
        snapshot.fetch_snapshot("drawbridge_g2_scratch", run=snap_stub)
        alloc = str(uuid.uuid4())
        db_cases.Db("drawbridge_g2_scratch", run=db_stub).call("post_funding", alloc, 1, "1.00", "AUTH-x", "IDEM-y")
        commands = {"snapshot": snap_stub.calls[0][0], "db_cases": db_stub.calls[0][0]}
        with short_tmp() as tmp:
            st = self.stub(RUNNER.read_text(encoding="utf-8"), tmp)
            for label, command in commands.items():
                with self.subTest(label):
                    self.assertEqual(command[0], str(RUNNER))
                    command = [str(st.script)] + command[1:]
                    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": snapshot.verified_home()}
                    done = subprocess.run(command, capture_output=True, text=True, check=False, timeout=60, stdin=subprocess.DEVNULL, env=env)
                    self.assertEqual(done.returncode, 0, done.stderr)

    def test_no_connection_option_can_follow_a_caller_argument_in_the_runner_text(self):
        text = RUNNER.read_text(encoding="utf-8")
        self.assertIn(NEW_RUN_PSQL_LAST, text)
        self.assertNotIn(OLD_RUN_PSQL_LAST, text)
        self.assertEqual(text.count('"$BIN/psql"'), 2)      # the fact query in verify_cluster and the one guarded invocation


class RunnerEmptyAndSecondApply(unittest.TestCase):
    """N-3 (empty migration) and LOOM-2 mutant M9 (second-apply exit 7), end to end through migrate-0011 with a stub psql."""

    GOOD = "-- synthetic stand-in\nselect 1;\n"

    def tree(self, tmp, body: bytes):
        st = StubCluster(RUNNER.read_text(encoding="utf-8"), Path(tmp))
        for n in APPROVED_BASE_NAMES:                      # the real, owner-approved base files (the runner's table names exactly these)
            (st.mig / n).write_bytes((ROOT / "db/migrations" / n).read_bytes())
        (st.mig / "0011_g2c1_funding_ledger.sql").write_bytes(body)
        return st

    def apply(self, st, digest):
        return st.run("migrate-0011", "drawbridge_g2_scratch", digest)

    def test_an_empty_migration_is_refused_even_with_its_own_hash_approved_and_nothing_is_submitted_or_recorded(self):
        empty = hashlib.sha256(b"").hexdigest()
        with short_tmp() as tmp:
            st = self.tree(tmp, b"")
            done = self.apply(st, empty)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("empty", done.stderr)
            log = st.log.read_text()
            self.assertNotIn("schema_migration(file_name", log)         # no ledger row would be recorded
            self.assertNotIn("[-f] [-]", log)                           # no SQL was submitted
            self.assertFalse(st.stdin_capture.exists())
            self.assertNotIn("applied", done.stdout)

    def test_a_wrong_hash_is_refused_and_nothing_is_submitted(self):
        with short_tmp() as tmp:
            st = self.tree(tmp, self.GOOD.encode())
            for wrong in (hashlib.sha256(b"x").hexdigest(), hashlib.sha256(b"").hexdigest(), "0" * 64):
                done = self.apply(st, wrong)
                self.assertEqual(done.returncode, 3, done.stderr)
            self.assertFalse(st.stdin_capture.exists())
            self.assertEqual(st.connections(), [])

    def test_correct_nonempty_bytes_follow_the_approved_path(self):
        body = self.GOOD.encode()
        digest = hashlib.sha256(body).hexdigest()
        with short_tmp() as tmp:
            st = self.tree(tmp, body)
            done = self.apply(st, digest)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(st.stdin_capture.read_bytes(), body)
            self.assertIn(f"applied 0011_g2c1_funding_ledger.sql  sha256={digest}", done.stdout)
            apply_call = [a for a, _ in st.connections() if "-f" in a and "-" in a][0]
            self.assertIn("-1", apply_call)                             # one transaction
            self.assertIn(f"insert into drawbridge_auth.schema_migration(file_name,file_sha256) values ('0011_g2c1_funding_ledger.sql','{digest}')", " ".join(apply_call))
            self.assertEqual(apply_call[-2:], ["-d", "drawbridge_g2_scratch"])

    def test_a_second_run_exits_7_and_submits_nothing(self):
        body = self.GOOD.encode()
        digest = hashlib.sha256(body).hexdigest()
        with short_tmp() as tmp:
            st = self.tree(tmp, body)
            st.recorded_0011.write_text("recorded")
            done = self.apply(st, digest)
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertIn("already recorded", done.stderr)
            self.assertFalse(st.stdin_capture.exists())

    def test_the_empty_check_precedes_every_database_call_in_apply_file(self):
        text = RUNNER.read_text(encoding="utf-8")
        body = text[text.index("apply_file() {"):text.index('case "${1:-}" in')]
        self.assertLess(body.index('[ -n "$content" ] || die'), body.index("ledger_read"))
        self.assertLess(body.index('[ -n "$content" ] || die'), body.index("| q -1"))


class RunnerApplyHarnessGaps(unittest.TestCase):
    """LOOM-2 mutants M3 and M4: the second guard layer and the NUL cross-check without an approved hash."""

    def extract(self, name, nxt):
        text = RUNNER.read_text(encoding="utf-8")
        return text[text.index(name):text.index(nxt, text.index(name))]

    def test_m4_a_nul_byte_is_refused_when_no_approved_hash_is_given(self):
        harness = RunnerAppliesTheVerifiedBytes()
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            again = harness.harness(tmp, "select 1;\x00select 2;\n", "")      # no approved hash: the cross-check is the ONLY NUL guard
            self.assertEqual(again.returncode, 3, again.stderr)
            self.assertIn("NUL", again.stderr)
            self.assertFalse((tmp / "captured.sql").exists())

    def test_m3_the_realpath_containment_layer_refuses_a_component_that_resolves_outside(self):
        guard = self.extract("guard_paths() {", "# An initialised cluster")
        with scratch_tmp() as tmp:
            tmp = Path(tmp)
            (tmp / "build/pg18-g2c1/data").mkdir(parents=True)
            script = tmp / "g.sh"
            # a stub `realpath` reports a location outside build/pg18-g2c1 for an existing, non-symlink path
            script.write_text(f"""#!/bin/bash
set -euo pipefail
ROOT={tmp}; BASE=$ROOT/build/pg18-g2c1; DATA=$BASE/data; SOCK=$BASE/sock; LOG=$BASE/postgres.log; IDENT=$BASE/identity.txt
die() {{ echo "REFUSED: $*" >&2; exit 3; }}
realpath() {{ if [ "${{@: -1}}" = "$DATA" ]; then echo /somewhere/else; else command realpath "$@"; fi; }}
{guard}
guard_paths
echo passed
""", encoding="utf-8")
            done = subprocess.run([BASH, str(script)], capture_output=True, text=True, check=False, timeout=60)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("resolves outside build/pg18-g2c1", done.stderr)
            # control: without the stub the same tree passes
            script.write_text(script.read_text().replace("realpath() {", "realpath_unused() {"))
            ok = subprocess.run([BASH, str(script)], capture_output=True, text=True, check=False, timeout=60)
            self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "passed"), ok.stderr)


class ManifestBroadExcept(unittest.TestCase):
    """LOOM-2 mutant M10: the defence-in-depth handler is exercised by forcing an unanticipated error."""

    def test_an_unanticipated_error_inside_allocation_verification_is_a_defined_failure(self):
        doc = manifest.build_manifest(build_snapshot())
        data = manifest.manifest_bytes(doc)
        for exc in (TypeError("boom"), KeyError("k"), ValueError("v"), AttributeError("a"), RecursionError("r")):
            with self.subTest(exc=type(exc).__name__), mock.patch.object(manifest, "_verify_allocation", side_effect=exc):
                result = manifest.verify_manifest(data)
                self.assertFalse(result["ok"])
                self.assertIn("MALFORMED_ALLOCATION", {f["code"] for f in result["failures"]})
        with mock.patch.object(manifest, "_verify_allocation", side_effect=ZeroDivisionError("not handled")), self.assertRaises(ZeroDivisionError):
            manifest.verify_manifest(data)       # only the listed exception types are converted; nothing is swallowed blindly


class BarrierAndOverlapEvidence(unittest.TestCase):
    """N-2: the start barrier is OBSERVED on the server, overlap is classified from evidence, and a run without overlap is
    INCONCLUSIVE. Logic only: the counts are scripted; no database."""

    class Scripted:
        def __init__(self, counts):
            self.counts, self.asked = list(counts), []

        def scalar(self, role, sql, **kw):
            self.asked.append(sql)
            return str(self.counts.pop(0) if len(self.counts) > 1 else self.counts[0])

    def test_wait_for_count_polls_the_server_and_does_not_use_a_fixed_sleep(self):
        fake, sleeps = self.Scripted([0, 1, 2]), []
        ticks = iter(range(100))
        got = db_cases.wait_for_count(fake, "q", 2, timeout=30, poll=0.5, sleep=sleeps.append, clock=lambda: next(ticks))
        self.assertEqual(got, 2)
        self.assertEqual(len(fake.asked), 3)
        self.assertEqual(sleeps, [0.5, 0.5])

    def test_wait_for_count_gives_up_at_the_deadline_and_reports_what_it_saw(self):
        fake, ticks = self.Scripted([1]), iter([0, 1, 5, 40])
        self.assertEqual(db_cases.wait_for_count(fake, "q", 2, timeout=30, poll=0.5, sleep=lambda s: None, clock=lambda: next(ticks)), 1)

    def test_the_barrier_queries_look_at_advisory_waiters_and_the_holder(self):
        self.assertIn("not granted", db_cases.advisory_waiters_sql(731))
        self.assertIn("objid = 731", db_cases.advisory_waiters_sql(731))
        self.assertIn("granted and mode = 'ExclusiveLock'", db_cases.advisory_holders_sql(731))

    def test_parallel_uses_no_fixed_sleep_to_decide_that_the_writers_are_parked(self):
        source = (HERE / "db_cases.py").read_text(encoding="utf-8")
        body = source[source.index("def parallel("):source.index("def require_barrier")]
        self.assertNotIn("time.sleep(", body)
        self.assertIn("wait_for_count(db, advisory_holders_sql(gate)", body)
        self.assertIn("wait_for_count(db, advisory_waiters_sql(gate)", body)
        self.assertIn("results.barrier = {", body)

    def test_barrier_completeness(self):
        ok = {"holder_observed": True, "waiters_observed": 2, "expected": 2}
        self.assertTrue(db_cases.barrier_complete(ok))
        for bad in ({**ok, "waiters_observed": 1}, {**ok, "waiters_observed": 0}, {**ok, "holder_observed": False}, {}):
            self.assertFalse(db_cases.barrier_complete(bad), bad)
        results = db_cases.ParallelResults([])
        results.barrier = {**ok, "waiters_observed": 1}
        with self.assertRaises(db_cases.CaseInconclusive):
            db_cases.require_barrier(results)

    def test_overlap_is_classified_from_the_barrier_and_the_loser_outcome(self):
        f = db_cases.iteration_overlap
        self.assertEqual(f(False, ["OBSERVED_40001"]), "BARRIER_FAILED")
        self.assertEqual(f(True, ["OBSERVED_40001"]), "OVERLAPPED")
        self.assertEqual(f(True, ["OBSERVED_23505_APPROVED"]), "OVERLAPPED")
        self.assertEqual(f(True, ["F1_CONFIRMED_OWNER_DECISION_REQUIRED"]), "OVERLAPPED")
        self.assertEqual(f(True, ["STABLE_REFUSAL_STALE_VERSION"]), "NOT_OVERLAPPED")
        self.assertEqual(f(True, []), "NOT_OVERLAPPED")

    def records(self, *items):
        return [{"overlap": o, "verdicts": v} for o, v in items]

    def test_a_run_with_no_overlapped_iteration_is_inconclusive_not_a_pass(self):
        summary = db_cases.summarize_f1(self.records(*[("NOT_OVERLAPPED", ["STABLE_REFUSAL_STALE_VERSION"])] * 20))
        self.assertEqual((summary["conclusion"], summary["iterations"], summary["overlapped"], summary["not_overlapped"]), ("INCONCLUSIVE", 20, 0, 20))
        summary = db_cases.summarize_f1(self.records(*[("BARRIER_FAILED", ["OBSERVED_40001"])] * 3))
        self.assertEqual(summary["conclusion"], "INCONCLUSIVE")

    def test_conclusions(self):
        s = db_cases.summarize_f1
        self.assertEqual(s(self.records(("OVERLAPPED", ["OBSERVED_40001"]), ("NOT_OVERLAPPED", ["STABLE_REFUSAL_STALE_VERSION"])))["conclusion"],
                         "NO_FINDING_OBSERVED_NOT_PROOF_OF_ABSENCE")
        self.assertEqual(s(self.records(("OVERLAPPED", ["F1_CONFIRMED_OWNER_DECISION_REQUIRED"]), ("NOT_OVERLAPPED", [])))["conclusion"], "FINDING")
        self.assertEqual(s(self.records(("OVERLAPPED", ["OBSERVED_40001"]), ("OVERLAPPED", ["DEFECT_UNEXPECTED_UNIQUE"])))["conclusion"], "FAIL")
        self.assertEqual(s(self.records(("OVERLAPPED", ["UNEXPECTED"])))["conclusion"], "FAIL")

    def test_the_case_keeps_20_iterations_the_sequential_control_and_records_each_writer(self):
        self.assertEqual(db_cases.F1_ITERATIONS, 20)
        source = (HERE / "db_cases.py").read_text(encoding="utf-8")
        body = source[source.index("def fresh_allocation_race"):source.index("# ------", source.index("def fresh_allocation_race"))]
        for needle in ('"sqlstate": r.state', '"constraint": retry.extract_constraint_name', '"committed": {"events"', "results.barrier", "CaseInconclusive",
                       "sequential writer B at version 1", "STALE_VERSION", "barrier_complete(results.barrier)"):
            self.assertIn(needle, body, needle)
        self.assertEqual(retry.MAX_ATTEMPTS, 3)
        self.assertEqual(len(retry.RETRIABLE_UNIQUE_CONSTRAINTS), 3)

    def test_other_concurrent_cases_demand_an_observed_barrier(self):
        source = (HERE / "db_cases.py").read_text(encoding="utf-8")
        for fn in ("def concurrent_same_version", "def cross_allocation", "def bounded_retry_real"):
            part = source[source.index(fn):source.index("\n\n\n", source.index(fn))]
            self.assertIn("require_barrier(", part, fn)


class CoverageOfV02Survivors(unittest.TestCase):
    """N-7: source-shape assertions for DB-case mutants that cannot run offline (M23, M24)."""

    def test_m24_the_label_behaviour_half_runs_as_the_authorized_caller(self):
        source = (HERE / "db_cases.py").read_text(encoding="utf-8")
        body = source[source.index("def catalog_lint"):source.index("APPROVED_LOSS")]
        self.assertIn('first = db.call("post_funding", al, 1, "1.00", label', body)
        self.assertIn('again = db.call("post_funding", al, 2, "1.00", label', body)
        self.assertIn("DUPLICATE_AUTHORIZATION", body)
        self.assertIn("changed the outcome", body)
        self.assertIn('"ADMIN", "FORCE", "OVERRIDE", "AUTHORIZED", "SUPERUSER"', body)

    def test_m23_the_injection_cases_check_their_own_rollback_and_control(self):
        source = (HERE / "db_cases.py").read_text(encoding="utf-8")
        body = source[source.index("def fault_injection"):source.index("def injected_txn_sql")]
        for needle in ("control posting must succeed with the fault disabled", 'left == "0,0,0,0"', "key or identity reserved", "must now post as a first write",
                       "the injected trigger was not removed", "require_inject_db(db)"):
            self.assertIn(needle, body, needle)


class DbCasesAreNotRun(unittest.TestCase):
    def test_every_database_case_is_declared_and_defaults_to_not_run(self):
        sys.path.insert(0, str(HERE))
        import db_cases  # noqa: E402
        ids = [c.case_id for c in db_cases.CASES]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 27)
        report = db_cases.run_all(enabled=False)
        self.assertEqual({r["status"] for r in report}, {"NOT RUN"})
        self.assertEqual([r["case_id"] for r in report], ids)


# ---------------------------------------------------------------------------------------------------------------------------------
# V04 hash-to-apply repair (owner decision, V02 ballot B-2/B-4): the exact bytes verified against an owner-approved digest are the exact
# bytes submitted, for migrations 0001-0010, the bootstrap SQL (static source and expanded text), the fixture preflight and 0011.
# Offline only: a STUB stands in for psql; nothing connects to anything.
BOOT_REL = "services/api/app/domain/g2_db/bootstrap/0000_cluster_bootstrap.sql"
PREFLIGHT_REL = "services/api/app/domain/g2_db/fixture_preflight.py"
REAL_INPUTS = ([f"db/migrations/{n}" for n in APPROVED_BASE_NAMES] + [BOOT_REL, PREFLIGHT_REL, "contracts/normalization_corpus_v1.sha256",
                                                                       "fixtures/normalization_corpus_v1.json"])


def runner_table() -> dict:
    """The approved table as the committed runner states it."""
    text = RUNNER.read_text(encoding="utf-8")
    base = re.findall(r'^  "(\d{4}_\S+) (\d+) ([0-9a-f]{64})"$', text, flags=re.M)
    return {
        "base": base,
        "boot_src": re.search(r'^APPROVED_BOOTSTRAP_SRC="(\S+) (\d+) ([0-9a-f]{64})"$', text, flags=re.M).groups(),
        "boot_exp": re.search(r'^APPROVED_BOOTSTRAP_EXPANDED="(\d+) ([0-9a-f]{64})"$', text, flags=re.M).groups(),
        "preflight": re.search(r'^APPROVED_PREFLIGHT="(\S+) (\d+) ([0-9a-f]{64})"$', text, flags=re.M).groups(),
        "corpus": re.search(r'^APPROVED_CORPUS_SHA256="([0-9a-f]{64})"$', text, flags=re.M).group(1),
        "db": re.search(r'^APPROVED_APPLY_DB="(\S+)"$', text, flags=re.M).group(1),
    }


def expanded_sql_of(text: str) -> str:
    start = text.index("bootstrap_expanded_sql() {")
    start = text.index("<<'G2C1_BOOTSTRAP_SQL'\n", start) + len("<<'G2C1_BOOTSTRAP_SQL'\n")
    return text[start:text.index("G2C1_BOOTSTRAP_SQL\n}", start)]


class HashToApplyTable(unittest.TestCase):
    """The table in the runner is exactly the committed files; the expanded bootstrap text is exactly the expansion of the approved source."""

    def test_every_approved_digest_and_length_equals_the_committed_file(self):
        t = runner_table()
        self.assertEqual([n for n, _, _ in t["base"]], APPROVED_BASE_NAMES)
        for n, size, digest in t["base"]:
            data = (ROOT / "db/migrations" / n).read_bytes()
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (int(size), digest), n)
        rel, size, digest = t["boot_src"]
        data = (ROOT / rel).read_bytes()
        self.assertEqual((rel, len(data), hashlib.sha256(data).hexdigest()), (BOOT_REL, int(size), digest))
        rel, size, digest = t["preflight"]
        data = (ROOT / rel).read_bytes()
        self.assertEqual((rel, len(data), hashlib.sha256(data).hexdigest()), (PREFLIGHT_REL, int(size), digest))
        self.assertEqual(hashlib.sha256((ROOT / "fixtures/normalization_corpus_v1.json").read_bytes()).hexdigest(), t["corpus"])
        self.assertEqual(t["db"], "drawbridge_g2_scratch")

    def test_the_expanded_bootstrap_text_hashes_to_its_approved_digest_and_has_no_meta_command(self):
        t = runner_table()
        exp = expanded_sql_of(RUNNER.read_text(encoding="utf-8")).encode("utf-8")
        self.assertEqual((len(exp), hashlib.sha256(exp).hexdigest()), (int(t["boot_exp"][0]), t["boot_exp"][1]))
        self.assertNotIn(b"\\", exp)
        self.assertNotIn(b"gexec", exp)

    def test_the_expanded_text_is_the_deterministic_expansion_of_the_approved_static_source(self):
        """Reasoned expansion of the static file (format %I of a plain lower-case name is the name itself); NOT a PostgreSQL run."""
        src = (ROOT / BOOT_REL).read_text(encoding="utf-8")
        exp = expanded_sql_of(RUNNER.read_text(encoding="utf-8"))
        db = runner_table()["db"]
        self.assertRegex(db, r"^[a-z][a-z0-9_]*$")                       # %I leaves such a name unquoted
        do_block = src[src.index("DO $$ BEGIN"):src.index("END $$;") + len("END $$;")]
        self.assertIn(do_block, exp)
        generated = []
        for m in re.finditer(r"SELECT format\('((?:[^']|'')*)', :'db'\)(?:\s+WHERE NOT EXISTS[^\n]*)?\s*\\gexec", src):
            generated.append(m.group(1).replace("''", "'").replace("%I", db) + ";")
        self.assertEqual(len(generated), 5)
        plain = [l for l in src.splitlines() if re.match(r"^(GRANT|ALTER ROLE) ", l)]
        want = ["GRANT drawbridge_owner TO drawbridge_migrator WITH INHERIT FALSE, SET TRUE;", *generated[:0]]
        body = [l for l in exp.splitlines() if l and not l.startswith("--")]
        tail = body[body.index("END $$;") + 1:]
        # statement order: the static file's order, with the five generated statements in place
        self.assertEqual(tail[0], plain[0])
        self.assertEqual(tail[1:6], generated)
        self.assertEqual(tail[6:], [l if l.endswith(";") else l + ";" for l in plain[1:]])
        self.assertTrue(generated[0].startswith("CREATE DATABASE") and "OWNER drawbridge_owner" in generated[0])
        self.assertEqual(want[0], plain[0])


class HashToApplyCluster:
    """A copy of the committed runner in a throwaway tree with the REAL approved inputs, a stub psql that keeps a tiny migration ledger,
    and a socket file where the cluster socket would be. Every psql call, its stdin and the environment are logged."""

    def __init__(self, tmp: Path, runner_text: str | None = None, facts: str | None = None, populate: bool = True):
        self.tmp = tmp
        tools = tmp / "services/api/app/domain/g2_db/tools"
        tools.mkdir(parents=True)
        self.script = tools / "g2c1_durable_cluster.sh"
        self.bin = tmp / "stubbin"
        self.bin.mkdir()
        self.state = tmp / "state"
        self.state.mkdir()
        self.base = tmp / "build/pg18-g2c1"
        self.data, self.sock = self.base / "data", self.base / "sock"
        self.sock.mkdir(parents=True)
        self.data.mkdir()
        text = runner_text if runner_text is not None else RUNNER.read_text(encoding="utf-8")
        bin_line = "BIN=/usr/lib/postgresql/18/bin"
        assert text.count(bin_line) == 1
        self.script.write_text(text.replace(bin_line, f"BIN={self.bin}"), encoding="utf-8")
        self.script.chmod(0o755)
        if populate:
            for rel in REAL_INPUTS:
                dest = tmp / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes((ROOT / rel).read_bytes())
            (tmp / "db/migrations/0011_g2c1_funding_ledger.sql").write_bytes(MIGRATION.read_bytes())
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.sock / ".s.PGSQL.54438"))
        listener.close()
        (self.state / "facts").write_text((facts or f"{self.data}||{self.sock}|54438|on|on|on|on|180000") + "\n")
        (self.state / "pin").write_text(runner_table()["corpus"] + "\n")
        (self.state / "ledger").write_text("")
        self.log = self.state / "psql.log"
        stub = self.bin / "psql"
        st = self.state
        stub.write_text(f"""#!/bin/bash
{{ printf 'ARGV:'; for a in "$@"; do printf ' [%s]' "$a"; done; echo; }} >> {self.log}
all="$*"
ovr() {{ # test hook: out_<cat> text, rc_<cat> exit status, sleep_<cat> seconds, from_<cat> = first call number at which they apply
  local c="$1" n=0
  [ -e {st}/cnt_$c ] && n=$(cat {st}/cnt_$c); n=$((n + 1)); echo $n > {st}/cnt_$c
  if [ -e {st}/from_$c ] && [ "$n" -lt "$(cat {st}/from_$c)" ]; then return 0; fi
  [ -e {st}/sleep_$c ] && sleep "$(cat {st}/sleep_$c)"
  [ -e {st}/out_$c ] && printf '%s' "$(cat {st}/out_$c)" && echo
  [ -e {st}/rc_$c ] && exit "$(cat {st}/rc_$c)"
  [ -e {st}/out_$c ] && exit 0
  return 0
}}
case "$all" in *"current_setting('data_directory')"*) cat {st}/facts; exit 0 ;; esac
case "$all" in *"to_regclass('drawbridge_auth.schema_migration')"*) ovr regclass; if [ -e {st}/ledger_exists ]; then echo t; else echo f; fi; exit 0 ;; esac
case "$all" in *"select count(*) from drawbridge_auth.schema_migration"*) ovr count; wc -l < {st}/ledger; exit 0 ;; esac
case "$all" in *"normalization_pin"*) ovr pin; cat {st}/pin; exit 0 ;; esac
if [[ "$all" == *"select file_sha256"* && "$all" =~ file_name=\\'([^\\']+)\\' ]]; then
  n="${{BASH_REMATCH[1]}}"
  ovr hash
  if [ -e {st}/lie_name ] && [ "$(cat {st}/lie_name)" = "$n" ] && grep -q "^$n " {st}/ledger; then echo eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee; exit 0; fi
  if [ -e {st}/ledger_lies ]; then cat {st}/ledger_lies; else awk -v n="$n" '$1==n{{print $2}}' {st}/ledger; fi
  exit 0
fi
case " $all " in *" -f - "*)
  k=$(( $(ls {st} | grep -c '^stdin\\.') + 1 ))
  cat > {st}/stdin.$k
  if [ -e {st}/fail_on ] && [ "$(cat {st}/fail_on)" = "$k" ]; then echo "stub failure on submission $k" >&2; exit 1; fi
  if [ -e {st}/hook ]; then bash {st}/hook "$k"; fi
  if [[ "$all" =~ values\\ \\(\\'([^\\']+)\\',\\'([0-9a-f]+)\\'\\) ]]; then echo "${{BASH_REMATCH[1]}} ${{BASH_REMATCH[2]}}" >> {st}/ledger; : > {st}/ledger_exists; fi ;;
esac
exit 0
""", encoding="utf-8")
        stub.chmod(0o555)
        self.bin.chmod(0o555)

    def run(self, *args, env=None, via=None, timeout=120):
        full = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", **(env if env is not None else {})}
        return subprocess.run([*(via or []), str(self.script), *args], capture_output=True, text=True, check=False, timeout=timeout, env=full)

    def hook(self, name, text):
        (self.state / name).write_text(text)

    def calls(self):
        """psql invocations other than the cluster-fact verification, each as its argv list."""
        if not self.log.exists():
            return []
        out = []
        for line in self.log.read_text(encoding="utf-8").splitlines():
            if line.startswith("ARGV:"):
                argv = re.findall(r"\[(.*?)\]", line[5:], flags=re.S)
                if not any("current_setting('data_directory')" in a for a in argv):
                    out.append(argv)
        return out

    def submissions(self):
        """Standard-input submissions, in order, as bytes."""
        files = sorted((p for p in self.state.glob("stdin.*")), key=lambda p: int(p.name.split(".")[1]))
        return [p.read_bytes() for p in files]

    def ledger_rows(self):
        return [tuple(l.split()) for l in (self.state / "ledger").read_text().splitlines()]


APPROVED_DB = "drawbridge_g2_scratch"


class HashToApplyBase(unittest.TestCase):
    """Migrations 0001-0010: verified against the approved digest BEFORE any SQL; the verified bytes are submitted; order; duplicates."""

    def test_correct_approved_bytes_are_submitted_in_order_and_each_ledger_entry_matches(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(c.submissions(), [(ROOT / "db/migrations" / n).read_bytes() for n in APPROVED_BASE_NAMES])
            self.assertEqual([n for n, _ in c.ledger_rows()], APPROVED_BASE_NAMES)
            self.assertEqual([h for _, h in c.ledger_rows()], [d for _, _, d in runner_table()["base"]])
            self.assertIn("fixture hash matches pin", done.stdout)
            self.assertEqual(done.stdout.count("applied 0"), 10)

    def test_a_modified_source_is_refused_before_any_database_contact(self):
        for victim in (0, 4, 9):
            with self.subTest(victim), short_tmp() as tmp:
                c = HashToApplyCluster(Path(tmp))
                p = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[victim]
                p.write_bytes(p.read_bytes() + b"-- tampered\n")
                done = c.run("migrate-base", APPROVED_DB)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn("not the owner-approved SHA-256", done.stderr)
                self.assertEqual(c.calls(), [])                      # not even a read-only query: nothing is applied from a partly verified set
                self.assertEqual(c.submissions(), [])

    def test_same_length_substitution_is_refused(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            p = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[2]
            data = bytearray(p.read_bytes())
            data[-2] ^= 0x01
            p.write_bytes(bytes(data))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])

    def test_an_empty_source_is_refused(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.tmp / "db/migrations" / APPROVED_BASE_NAMES[0]).write_bytes(b"")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("empty", done.stderr)
            self.assertEqual(c.calls(), [])

    def test_a_missing_approved_digest_is_refused(self):
        text = RUNNER.read_text(encoding="utf-8")
        first = runner_table()["base"][0]
        broken = text.replace(f'"{first[0]} {first[1]} {first[2]}"', f'"{first[0]} {first[1]} "')
        self.assertNotEqual(broken, text)
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp), runner_text=broken)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("no owner-approved SHA-256", done.stderr)
            self.assertEqual(c.calls(), [])

    def test_an_incorrect_approved_digest_in_the_runner_refuses_correct_bytes(self):
        text = RUNNER.read_text(encoding="utf-8")
        first = runner_table()["base"][3]
        broken = text.replace(first[2], "0" * 64)
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp), runner_text=broken)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])

    def test_the_file_set_must_be_exactly_the_approved_set_in_the_approved_order(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.tmp / "db/migrations/0003_other.sql").write_text("select 1;\n")      # a duplicate number
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("exactly the owner-approved set", done.stderr)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.tmp / "db/migrations" / APPROVED_BASE_NAMES[6]).rename(c.tmp / "db/migrations/0007_renamed.sql")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.tmp / "db/migrations" / APPROVED_BASE_NAMES[9]).rename(c.tmp / "db/migrations/0010_x.sql.bak")        # a missing file
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)

    def test_the_approved_length_is_enforced_independently_of_the_digest(self):
        first = runner_table()["base"][3]
        text = RUNNER.read_text(encoding="utf-8")
        broken = text.replace(f'"{first[0]} {first[1]} {first[2]}"', f'"{first[0]} {int(first[1]) + 1} {first[2]}"')
        self.assertNotEqual(broken, text)
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp), runner_text=broken)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("approved length", done.stderr)
            self.assertEqual(c.calls(), [])

    def test_a_nul_byte_that_the_shell_would_silently_drop_is_still_refused(self):
        """The digest in the table is that of the bytes without the NUL (what a shell variable holds); the second read sees the NUL."""
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            p = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[3]
            p.write_bytes(p.read_bytes() + b"\x00")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("changed while it was being read", done.stderr)
            self.assertEqual(c.calls(), [])

    def test_a_symbolic_link_source_is_refused(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            p = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[1]
            real = c.tmp / "real.sql"
            real.write_bytes(p.read_bytes())
            p.unlink()
            p.symlink_to(real)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("symbolic link", done.stderr)
            self.assertEqual(c.calls(), [])

    def test_replacement_during_execution_cannot_change_what_is_submitted(self):
        """The source file of 0005 is overwritten while 0001 is being submitted (after every file was read once)."""
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            victim = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[4]
            (c.state / "hook").write_text(f'printf tampered > {victim}\n')
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(victim.read_bytes(), b"tampered")                      # the file really was replaced mid-run
            self.assertEqual(c.submissions()[4], (ROOT / "db/migrations" / APPROVED_BASE_NAMES[4]).read_bytes())
            self.assertEqual(c.ledger_rows()[4][1], runner_table()["base"][4][2])

    def test_a_ledger_that_does_not_match_the_submitted_bytes_stops_the_run(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.state / "ledger_lies").write_text("f" * 64 + "\n")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 6, done.stderr)
            self.assertIn("not the verified bytes", done.stderr)
            self.assertEqual(len(c.submissions()), 1)                                # stopped after the first file

    def test_a_second_run_is_refused_and_submits_nothing(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.assertEqual(c.run("migrate-base", APPROVED_DB).returncode, 0)
            n = len(c.submissions())
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertIn("not empty", done.stderr)
            self.assertEqual(len(c.submissions()), n)

    def test_a_failure_mid_run_stops_without_continuing_or_cleaning_up(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.state / "fail_on").write_text("3\n")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(len(c.submissions()), 3)                                # nothing after the failing file
            self.assertEqual([n for n, _ in c.ledger_rows()], APPROVED_BASE_NAMES[:2])
            self.assertTrue((c.data).exists() and (c.state / "ledger").exists())      # nothing was deleted

    def test_the_fixture_preflight_and_corpus_are_verified_before_any_sql(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            p = c.tmp / PREFLIGHT_REL
            p.write_bytes(p.read_bytes() + b"\n# tampered\n")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            p = c.tmp / "fixtures/normalization_corpus_v1.json"
            p.write_bytes(p.read_bytes() + b" ")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 5, done.stderr)                        # the preflight itself refuses
            self.assertEqual(c.calls(), [])
        text = RUNNER.read_text(encoding="utf-8")
        with short_tmp() as tmp:       # consistent replacement of corpus and digest file is still not the approved digest
            c = HashToApplyCluster(Path(tmp), runner_text=text.replace(runner_table()["corpus"], "1" * 64))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])


class HashToApplyBootstrap(unittest.TestCase):
    """Bootstrap: the approved static source is verified; the complete expanded plain-SQL text is verified; exactly that text is submitted."""

    def test_the_submitted_sql_is_exactly_the_approved_expanded_text(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            done = c.run("bootstrap", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            subs = c.submissions()
            self.assertEqual(len(subs), 1)
            t = runner_table()
            self.assertEqual((len(subs[0]), hashlib.sha256(subs[0]).hexdigest()), (int(t["boot_exp"][0]), t["boot_exp"][1]))
            self.assertEqual(subs[0].decode("utf-8"), expanded_sql_of(RUNNER.read_text(encoding="utf-8")))
            argv = c.calls()[0]
            self.assertIn("-f", argv)
            self.assertEqual(argv[argv.index("-f") + 1], "-")                      # stdin, never a path
            self.assertNotIn(BOOT_REL, " ".join(argv))
            self.assertEqual(argv[-2:], ["-d", "postgres"])
            self.assertIn("-U", argv); self.assertEqual(argv[argv.index("-U") + 1], "g2_scratch_admin")

    def test_no_psql_meta_command_or_generated_statement_reaches_the_database(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.assertEqual(c.run("bootstrap", APPROVED_DB).returncode, 0)
            sql = c.submissions()[0].decode()
            self.assertNotIn("\\", sql)
            self.assertNotIn("gexec", sql)
            self.assertNotIn(":'db'", sql)
            self.assertEqual("\n".join(l for l in sql.splitlines() if not l.startswith("--")).count("CREATE DATABASE"), 1)
            self.assertNotIn("drawbridge_g2_dev", sql)
            self.assertNotIn("DROP", sql.upper())

    def test_a_modified_static_source_is_refused_before_any_database_contact(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            p = c.tmp / BOOT_REL
            p.write_bytes(p.read_bytes() + b"-- tampered\n")
            done = c.run("bootstrap", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])
            self.assertEqual(c.submissions(), [])

    def test_an_empty_static_source_is_refused(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.tmp / BOOT_REL).write_bytes(b"")
            self.assertEqual(c.run("bootstrap", APPROVED_DB).returncode, 3)
            self.assertEqual(c.calls(), [])

    def test_generated_sql_that_differs_from_the_approved_expansion_is_refused(self):
        text = RUNNER.read_text(encoding="utf-8")
        for old, new in (("OWNER drawbridge_owner;", "OWNER postgres;"), ("GRANT CONNECT ON DATABASE", "GRANT ALL ON DATABASE"),
                         ("NOBYPASSRLS", "BYPASSRLS"),
                         ("client_encoding = 'UTF8';\nALTER ROLE drawbridge_migrator", "client_encoding = 'UTF9';\nALTER ROLE drawbridge_migrator"),   # same length
                         ("TO drawbridge_migrator, authority_svc,", "TO drawbridge_migrator, authority_svd,")):                                      # same length
            with self.subTest(old), short_tmp() as tmp:
                self.assertIn(old, expanded_sql_of(text))
                c = HashToApplyCluster(Path(tmp), runner_text=text.replace(old, new, 1))
                done = c.run("bootstrap", APPROVED_DB)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn("not the owner-approved", done.stderr)
                self.assertEqual(c.calls(), [])
                self.assertEqual(c.submissions(), [])

    def test_an_expansion_that_gains_a_meta_command_is_refused_even_if_its_digest_were_approved(self):
        text = RUNNER.read_text(encoding="utf-8")
        exp = expanded_sql_of(text)
        bad = exp.replace("ALTER ROLE authority_svc SET client_encoding = 'UTF8';", "\\connect other\nALTER ROLE authority_svc SET client_encoding = 'UTF8';")
        self.assertNotEqual(bad, exp)
        patched = text.replace(exp, bad).replace(runner_table()["boot_exp"][1], hashlib.sha256(bad.encode()).hexdigest()).replace(
            f'APPROVED_BOOTSTRAP_EXPANDED="{runner_table()["boot_exp"][0]} ', f'APPROVED_BOOTSTRAP_EXPANDED="{len(bad.encode())} ')
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp), runner_text=patched)
            done = c.run("bootstrap", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("backslash", done.stderr)
            self.assertEqual(c.calls(), [])

    def test_a_replacement_of_the_static_source_during_execution_changes_nothing_submitted(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.state / "hook").write_text(f'printf tampered > {c.tmp / BOOT_REL}\n')
            done = c.run("bootstrap", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(c.submissions()[0].decode(), expanded_sql_of(RUNNER.read_text(encoding="utf-8")))

    def test_a_bootstrap_failure_is_reported_and_nothing_is_retried_or_cleaned(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.state / "fail_on").write_text("1\n")
            done = c.run("bootstrap", APPROVED_DB)
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(len(c.submissions()), 1)                                 # one attempt, no retry
            self.assertTrue(c.data.exists())

    def test_only_the_approved_database_is_accepted(self):
        for db in ("drawbridge_g2_dev", "drawbridge_g2_test", "drawbridge_g2_scratch_inject_01", "postgres", "template1", "drawbridge_g2_scratch2"):
            for command in ("bootstrap", "migrate-base"):
                with self.subTest(command=command, db=db), short_tmp() as tmp:
                    c = HashToApplyCluster(Path(tmp))
                    done = c.run(command, db)
                    self.assertEqual(done.returncode, 3, done.stderr)
                    self.assertIn("owner-approved apply target", done.stderr)
                    self.assertEqual(c.calls(), [])
            with self.subTest(command="migrate-0011", db=db), short_tmp() as tmp:
                c = HashToApplyCluster(Path(tmp))
                done = c.run("migrate-0011", db, hashlib.sha256(MIGRATION.read_bytes()).hexdigest())
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertEqual(c.calls(), [])


class HashToApplyClusterIdentity(unittest.TestCase):
    """Wrong cluster, wrong socket, historical cluster: every connection is refused by verify_cluster before any submission."""

    def facts(self, c, **kw):
        base = dict(data=str(c.data), listen="", sock=str(c.sock), port="54438", fsync="on", sync="on", fpw="on", cks="on", ver="180000")
        base.update(kw)
        return "|".join(base[k] for k in ("data", "listen", "sock", "port", "fsync", "sync", "fpw", "cks", "ver"))

    def test_wrong_cluster_wrong_socket_wrong_port_and_the_historical_cluster_are_refused(self):
        cases = {
            "other data directory": dict(data="/somewhere/else/data"),
            "historical data directory": dict(data="/elsewhere/build/pg18-g2/data"),
            "other socket directory": dict(sock="/somewhere/else/sock"),
            "historical port": dict(port="54418"),
            "network listener": dict(listen="*"),
            "fsync off": dict(fsync="off"),
            "synchronous_commit off": dict(sync="off"),
            "full_page_writes off": dict(fpw="off"),
            "no checksums": dict(cks="off"),
            "wrong major version": dict(ver="170000"),
        }
        for label, change in cases.items():
            for command, args in (("bootstrap", (APPROVED_DB,)), ("migrate-base", (APPROVED_DB,)), ("migrate-0011", (APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest()))):
                with self.subTest(label=label, command=command), short_tmp() as tmp:
                    c = HashToApplyCluster(Path(tmp))
                    (c.state / "facts").write_text(self.facts(c, **change) + "\n")
                    done = c.run(command, *args)
                    self.assertNotEqual(done.returncode, 0, done.stdout)
                    self.assertIn("target verification failed", done.stderr)
                    self.assertEqual(c.submissions(), [], label)

    def test_a_missing_socket_is_refused(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            (c.sock / ".s.PGSQL.54438").unlink()
            for command in ("bootstrap", "migrate-base"):
                done = c.run(command, APPROVED_DB)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn("socket absent", done.stderr)
            self.assertEqual(c.submissions(), [])

    def test_the_runner_names_neither_the_historical_cluster_nor_its_port(self):
        code = "\n".join(l for l in RUNNER.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("#"))
        self.assertNotRegex(code, r"pg18-g2(?!c1)")
        self.assertNotIn("54418", code)

    def test_the_historical_cluster_is_not_reachable_by_a_planted_link(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            hist = c.tmp / "build/pg18-g2"
            hist.mkdir()
            moved = c.tmp / "build/moved"
            c.base.rename(moved)
            c.base.symlink_to(moved)
            done = c.run("bootstrap", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("symbolic link", done.stderr)
            self.assertEqual(c.calls(), [])


class HashToApply0011Preserved(unittest.TestCase):
    """0011's read-once hash-to-apply behaviour is preserved, and the ledger is compared with the approved base table."""

    def populate(self, c):
        for n, _, d in runner_table()["base"]:
            (c.state / "ledger").open("a").write(f"{n} {d}\n")
        (c.state / "ledger_exists").write_text("")

    def test_0011_applies_only_the_approved_bytes_when_the_base_ledger_is_the_approved_table(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.populate(c)
            digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
            self.assertEqual(digest, "0b8ddcc61650a3535b4377929250c17f2be2539b63c02075b1ab4cc7452743b6")
            done = c.run("migrate-0011", APPROVED_DB, digest)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(c.submissions(), [MIGRATION.read_bytes()])
            self.assertEqual(c.ledger_rows()[-1], ("0011_g2c1_funding_ledger.sql", digest))

    def test_0011_is_refused_when_a_base_row_differs_from_the_approved_table_even_if_the_file_on_disk_matches_it(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.populate(c)
            rows = (c.state / "ledger").read_text().splitlines()
            rows[5] = rows[5].split()[0] + " " + "a" * 64
            (c.state / "ledger").write_text("\n".join(rows) + "\n")
            done = c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest())
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("apply migrate-base first", done.stderr)
            self.assertEqual(c.submissions(), [])

    def test_0011_ledger_mismatch_after_apply_stops_the_run(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.populate(c)
            (c.state / "ledger_lies").write_text("e" * 64 + "\n")
            digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
            # ledger_lies also answers the base-row lookups, so give the lie only after the base check: use a hook-free two-step probe
            done = c.run("migrate-0011", APPROVED_DB, digest)
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(c.submissions(), [])           # the base check already refused: the lie is not the approved table

    def test_0011_ledger_that_does_not_record_the_verified_bytes_stops_the_run_after_apply(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.populate(c)
            (c.state / "lie_name").write_text("0011_g2c1_funding_ledger.sql\n")
            done = c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest())
            self.assertEqual(done.returncode, 6, done.stderr)
            self.assertIn("not the verified bytes", done.stderr)
            self.assertEqual(c.submissions(), [MIGRATION.read_bytes()])       # the approved bytes were what was submitted; the mismatch is reported

    def test_0011_replacement_during_apply_changes_nothing(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            self.populate(c)
            (c.state / "hook").write_text(f'printf tampered > {c.tmp / "db/migrations/0011_g2c1_funding_ledger.sql"}\n')
            done = c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest())
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(c.submissions(), [MIGRATION.read_bytes()])


class HashToApplyStructure(unittest.TestCase):
    """The approved first-apply commands never use the generic psql command, its stdin filter or an argument allowlist, and never a path."""

    def commands(self):
        text = RUNNER.read_text(encoding="utf-8")
        out = {}
        for name in ("bootstrap", "migrate-base", "migrate-0011"):
            start = text.index(f"\n  {name})\n")
            end = re.compile(r"\n  (?:[a-z0-9-]+|\*)\)\n").search(text, start + 3).start()
            out[name] = "\n".join(l for l in text[start:end].splitlines() if not l.strip().startswith("#"))
        return text, out

    def test_none_of_the_first_apply_commands_uses_the_stdin_filter_or_the_argument_allowlist(self):
        text, cmds = self.commands()
        for name, body in cmds.items():
            for banned in ("guard_stdin", "validate_psql_args", "validate_caller_pgoptions", "psql)", "$BIN/psql"):
                self.assertNotIn(banned, body, (name, banned))
        self.assertEqual(text.count("guard_stdin |"), 1)
        self.assertEqual(text.count("validate_psql_args \"$@\""), 1)

    def test_no_first_apply_command_hands_a_file_path_to_psql(self):
        text, cmds = self.commands()
        self.assertNotRegex(cmds["bootstrap"], r'run_psql[^\n]*-f "\$')
        self.assertNotRegex(cmds["migrate-base"], r'\bq [^\n]*-f "\$')
        body = text[text.index("apply_file() {"):text.index("load_verified()")]
        self.assertNotRegex("\n".join(l for l in body.splitlines() if not l.strip().startswith("#")), r'\bq [^\n]*-f "\$')
        self.assertIn("-f -", cmds["bootstrap"])

    def test_verification_precedes_every_database_call_in_migrate_base_and_bootstrap(self):
        text, cmds = self.commands()
        mb = cmds["migrate-base"]
        self.assertLess(mb.index("load_verified"), mb.index("run_psql"))
        self.assertLess(mb.rindex("load_verified"), mb.index("run_psql"))
        self.assertLess(mb.index("APPROVED_CORPUS_SHA256"), mb.index("run_psql"))
        bs = cmds["bootstrap"]
        self.assertLess(bs.index("load_verified"), bs.index("run_psql"))
        self.assertLess(bs.index("APPROVED_BOOTSTRAP_EXPANDED") if "APPROVED_BOOTSTRAP_EXPANDED" in bs else 0, bs.index("run_psql"))

    def test_the_runner_still_has_no_delete_operation_and_runs_unprivileged(self):
        code = "\n".join(l for l in RUNNER.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("#"))
        for word in (" rm ", "rm -", "rmdir", "unlink", "shred", "dropdb", "drop database", "DROP DATABASE", "sudo", "pg_resetwal"):
            self.assertNotIn(word, code, word)
        self.assertIn('[ "$(id -u)" -ne 0 ] || die "must not run as root"', code)
        self.assertNotIn("DROP", expanded_sql_of(RUNNER.read_text(encoding="utf-8")).upper())


# ---------------------------------------------------------------------------------------------------------------------------------
# V05 trust-boundary repair (owner decision, V03 ballot B-5R; LOOM-2 V04 findings F-1 and F-2). Offline: a STUB stands in for psql.
# F-1: the runner must not trust caller-provided command resolution or shell initialization. Each attack below is run against the REAL
# committed runner, executed directly as its shebang requires, and the result is classified: REFUSED, or HARMLESS (the attacker's code is
# never executed and the verified bytes are unchanged). "Harmless" is proved by markers the attacker's code would leave, not by printing PATH.
TAMPERED_BASE_INDEX = 4          # 0005
FAKE_TOOLS = ("sha256sum", "cat", "wc", "python3", "realpath", "cut", "basename", "dirname", "id", "grep", "head", "readlink", "ls",
              "mkdir", "chmod", "timeout", "env", "bash", "printf", "echo", "test", "[")


class Attacker:
    """A directory of fake tools (each leaves a marker and breaks the call), exported-function overrides and hostile variables."""

    def __init__(self, tmp: Path):
        self.dir = tmp / "evil"
        self.marks = tmp / "marks"
        self.dir.mkdir()
        self.marks.mkdir()
        for tool in FAKE_TOOLS:
            p = self.dir / tool
            p.write_text(f"#!/usr/bin/python3 -I\nimport sys, pathlib\npathlib.Path(r'{self.marks}/tool_{tool.replace('[', 'lbracket')}').touch()\nsys.exit(99)\n")
            p.chmod(0o755)
        self.bash_env = tmp / "bash_env.sh"
        self.bash_env.write_text(f"touch {self.marks}/bash_env_ran\n")
        self.pyevil = tmp / "pyevil"
        self.pyevil.mkdir()
        (self.pyevil / "sitecustomize.py").write_text(f"import pathlib; pathlib.Path(r'{self.marks}/python_sitecustomize').touch()\n")
        (self.pyevil / "startup.py").write_text(f"import pathlib; pathlib.Path(r'{self.marks}/python_startup').touch()\n")
        (self.pyevil / "json.py").write_text(f"import pathlib; pathlib.Path(r'{self.marks}/python_json').touch()\n")

    def hostile_env(self, functions=True):
        env = {"PATH": f"{self.dir}:.:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(self.dir), "TMPDIR": str(self.dir),
               "BASH_ENV": str(self.bash_env), "ENV": str(self.bash_env), "SHELLOPTS": "xtrace", "BASHOPTS": "extdebug",
               "PS4": f"+$(touch {self.marks}/ps4_ran)", "CDPATH": str(self.dir), "GLOBIGNORE": "*", "IFS": "x", "POSIXLY_CORRECT": "1",
               "PROMPT_COMMAND": f"touch {self.marks}/prompt_ran",
               "PYTHONPATH": str(self.pyevil), "PYTHONSTARTUP": str(self.pyevil / "startup.py"), "PYTHONHOME": str(self.dir),
               "PYTHONUSERBASE": str(self.dir), "PYTHONINSPECT": "1"}
        if functions:
            for name in ("sha256sum", "cat", "wc", "python3", "realpath", "cut", "basename", "dirname", "id", "grep", "head", "readlink", "ls",
                         "mkdir", "chmod", "timeout", "env", "printf", "echo", "read", "declare", "builtin", "command", "hash", "unset", "set",
                         "exit", "die", "q", "run_psql", "load_verified", "sha_of", "ledger_read", "check_apply_db"):
                env[f"BASH_FUNC_{name}%%"] = f"() {{  touch {self.marks}/function_{name}; echo LIE\n}}"
        return env

    def marks_left(self):
        return sorted(p.name for p in self.marks.iterdir())


def pristine(name):
    return (ROOT / "db/migrations" / name).read_bytes()


class RunnerTrustedExecution(unittest.TestCase):
    """F-1: command resolution and shell initialization."""

    def setUp(self):
        self.text = RUNNER.read_text(encoding="utf-8")

    def cluster(self, tmp, text=None):
        return HashToApplyCluster(Path(tmp), runner_text=text)

    def test_the_interpreter_is_fixed_in_the_shebang_in_privileged_mode_and_the_file_is_executable(self):
        self.assertEqual(self.text.splitlines()[0], "#!/usr/bin/bash -p")
        if (ROOT / ".git").exists():                                # a git checkout must carry the executable bit; archive exports may lose it
            self.assertTrue(os.access(RUNNER, os.X_OK), "the runner must be executable in a git checkout")
        done = subprocess.run(["/usr/bin/bash", "-n", str(RUNNER)], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_control_hostile_environment_with_untampered_inputs_is_harmless_for_every_first_apply_command(self):
        for command, args in (("bootstrap", (APPROVED_DB,)), ("migrate-base", (APPROVED_DB,))):
            with self.subTest(command), short_tmp() as tmp:
                a, c = Attacker(Path(tmp)), self.cluster(tmp)
                done = c.run(command, *args, env=a.hostile_env())
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(a.marks_left(), [], "attacker code ran")
                if command == "migrate-base":
                    self.assertEqual(c.submissions(), [pristine(n) for n in APPROVED_BASE_NAMES])
                else:
                    self.assertEqual(c.submissions()[0].decode(), expanded_sql_of(self.text))

    def test_0011_under_the_hostile_environment_is_harmless(self):
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            for n, _, d in runner_table()["base"]:
                (c.state / "ledger").open("a").write(f"{n} {d}\n")
            (c.state / "ledger_exists").write_text("")
            done = c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest(), env=a.hostile_env())
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(a.marks_left(), [])
            self.assertEqual(c.submissions(), [MIGRATION.read_bytes()])

    def test_a_fake_tool_first_in_path_is_never_executed_for_each_sensitive_tool(self):
        """Fake sha256sum, cat, wc and python3 (and the rest of the list) in PATH: not one is executed, and the apply decision is unchanged."""
        for tool in ("sha256sum", "cat", "wc", "python3"):
            with self.subTest(tool), short_tmp() as tmp:
                a, c = Attacker(Path(tmp)), self.cluster(tmp)
                env = {"PATH": f"{a.dir}:/usr/bin:/bin"}
                done = c.run("migrate-base", APPROVED_DB, env=env)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertNotIn(f"tool_{tool}", a.marks_left())
                self.assertEqual(a.marks_left(), [])

    def test_a_lying_sha256sum_cannot_make_tampered_bytes_pass(self):
        """The fake reports the APPROVED digest for the tampered content. If the runner used it, tampered 0005 would be submitted."""
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            victim = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[TAMPERED_BASE_INDEX]
            victim.write_bytes(victim.read_bytes() + b"-- tampered\n")
            approved = runner_table()["base"][TAMPERED_BASE_INDEX][2]
            liar = a.dir / "sha256sum"
            liar.write_text(f"#!/usr/bin/python3 -I\nimport sys, hashlib, pathlib\npathlib.Path(r'{a.marks}/tool_sha256sum').touch()\nprint('{approved}  -')\n")
            wc = a.dir / "wc"
            wc.write_text(f"#!/usr/bin/python3 -I\nimport pathlib\npathlib.Path(r'{a.marks}/tool_wc').touch()\nprint({runner_table()['base'][TAMPERED_BASE_INDEX][1]})\n")
            done = c.run("migrate-base", APPROVED_DB, env=a.hostile_env())
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("not the owner-approved SHA-256", done.stderr)
            self.assertEqual(c.submissions(), [])
            self.assertEqual(c.calls(), [])
            self.assertEqual(a.marks_left(), [], "the lying tools were executed")

    def test_a_lying_python3_cannot_make_a_tampered_corpus_pass(self):
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            p = c.tmp / "fixtures/normalization_corpus_v1.json"
            p.write_bytes(p.read_bytes() + b" ")
            (a.dir / "python3").write_text(f"#!/usr/bin/python3 -I\nimport pathlib\npathlib.Path(r'{a.marks}/tool_python3').touch()\nprint('{runner_table()['corpus']}')\n")
            done = c.run("migrate-base", APPROVED_DB, env=a.hostile_env())
            self.assertEqual(done.returncode, 5, done.stderr)
            self.assertEqual(c.calls(), [])
            self.assertEqual(c.submissions(), [])
            self.assertEqual(a.marks_left(), [])

    def test_exported_shell_function_overrides_are_not_imported_and_cannot_affect_the_decision(self):
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            victim = c.tmp / "db/migrations" / APPROVED_BASE_NAMES[1]
            victim.write_bytes(victim.read_bytes() + b"x")
            env = a.hostile_env(functions=True)
            done = c.run("migrate-base", APPROVED_DB, env=env)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.submissions(), [])
            self.assertEqual(a.marks_left(), [], "an exported function ran")
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            self.assertEqual(c.run("migrate-base", APPROVED_DB, env=a.hostile_env(functions=True)).returncode, 0)
            self.assertEqual(a.marks_left(), [])

    def test_bash_env_is_not_processed_when_the_runner_is_executed_directly(self):
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            done = c.run("identity", env={"BASH_ENV": str(a.bash_env), "ENV": str(a.bash_env)})
            self.assertNotIn("executed directly", done.stderr)
            self.assertNotIn("bash_env_ran", a.marks_left())

    def test_started_as_bash_script_the_runner_refuses_and_the_interpreter_limit_is_honestly_documented(self):
        """`bash <runner>` lets bash read $BASH_ENV and import functions BEFORE any line of the runner runs: that cannot be prevented from
        inside the script. The runner detects the missing privileged mode and refuses before doing anything. The marker proves the limit."""
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            env = a.hostile_env(functions=False)
            env.pop("POSIXLY_CORRECT")          # posix mode would make bash itself ignore $BASH_ENV and hide the very limit this test documents
            done = c.run("migrate-base", APPROVED_DB, env=env, via=["/usr/bin/bash"])
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("executed directly", done.stderr)
            self.assertEqual(c.calls(), [])
            self.assertEqual(c.submissions(), [])
            self.assertIn("bash_env_ran", a.marks_left())          # the interpreter, not the runner, ran it: the stated trusted-host limit
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            env = {"BASH_FUNC_sha256sum%%": f"() {{  touch {a.marks}/function_sha256sum; echo LIE\n}}"}
            done = c.run("migrate-base", APPROVED_DB, env=env, via=["/usr/bin/bash"])
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:            # `bash -p <runner>` is equivalent to the shebang and is accepted
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            done = c.run("migrate-base", APPROVED_DB, env=a.hostile_env(), via=["/usr/bin/bash", "-p"])
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(a.marks_left(), [])

    def test_loader_level_environment_variables_are_refused_before_anything_runs(self):
        for var, value in (("LD_PRELOAD", "/nonexistent.so"), ("LD_LIBRARY_PATH", "/nonexistent"), ("LD_AUDIT", "/nonexistent.so"),
                           ("LD_DEBUG", "all"), ("GCONV_PATH", "/nonexistent"), ("LOCPATH", "/nonexistent"), ("NLSPATH", "/nonexistent")):
            with self.subTest(var), short_tmp() as tmp:
                c = self.cluster(tmp)
                done = c.run("migrate-base", APPROVED_DB, env={var: value})
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn(f"{var}", done.stderr)
                self.assertEqual(c.calls(), [])
                self.assertEqual(c.submissions(), [])

    def test_shell_behaviour_and_python_variables_are_harmless(self):
        for var, value in (("SHELLOPTS", "xtrace"), ("BASHOPTS", "extdebug"), ("CDPATH", "/"), ("GLOBIGNORE", "*"), ("IFS", "x"),
                           ("POSIXLY_CORRECT", "1"), ("PYTHONHOME", "/nonexistent"), ("PYTHONPATH", "/nonexistent"), ("PYTHONSTARTUP", "/nonexistent"),
                           ("TMPDIR", "/nonexistent"), ("HOME", "/nonexistent"), ("PATH", ".::/nonexistent")):
            with self.subTest(var), short_tmp() as tmp:
                a, c = Attacker(Path(tmp)), self.cluster(tmp)
                done = c.run("migrate-base", APPROVED_DB, env={var: value})
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(c.submissions(), [pristine(n) for n in APPROVED_BASE_NAMES])

    def test_wrong_trusted_tool_locations_fail_closed(self):
        line = "readonly TRUSTED_TOOL_DIR=/usr/bin"
        self.assertIn(line, self.text)
        with short_tmp() as tmp:       # a directory the invoking user can write to
            evil = Path(tmp) / "tools"
            evil.mkdir()
            for t in ("env", "cat", "sha256sum", "cut", "wc", "realpath", "basename", "dirname", "id", "grep", "head", "readlink", "ls", "mkdir",
                      "chmod", "timeout", "python3"):
                (evil / t).symlink_to(f"/usr/bin/{t}")
            c = self.cluster(tmp, self.text.replace(line, f"readonly TRUSTED_TOOL_DIR={evil}"))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("writable by the invoking user", done.stderr)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:       # a missing directory
            c = self.cluster(tmp, self.text.replace(line, "readonly TRUSTED_TOOL_DIR=/nonexistent/bin"))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:       # a non-writable directory holding a writable tool file
            d = Path(tmp) / "tools"
            d.mkdir()
            for t in ("env", "cat", "sha256sum", "cut", "wc", "realpath", "basename", "dirname", "id", "grep", "head", "readlink", "ls", "mkdir",
                      "chmod", "timeout", "python3"):
                (d / t).symlink_to(f"/usr/bin/{t}")
            (d / "sha256sum").unlink()
            (d / "sha256sum").write_text("#!/usr/bin/python3 -I\nprint('x')\n")
            (d / "sha256sum").chmod(0o777)
            d.chmod(0o555)
            c = self.cluster(tmp, self.text.replace(line, f"readonly TRUSTED_TOOL_DIR={d}"))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("sha256sum", done.stderr)
            self.assertEqual(c.calls(), [])
            d.chmod(0o755)
        with short_tmp() as tmp:       # a tool that is not executable
            d = Path(tmp) / "tools"
            d.mkdir()
            for t in ("env", "cat", "sha256sum", "cut", "wc", "realpath", "basename", "dirname", "id", "grep", "head", "readlink", "ls", "mkdir",
                      "chmod", "timeout", "python3"):
                (d / t).symlink_to(f"/usr/bin/{t}")
            (d / "wc").unlink()
            (d / "wc").write_text("not executable\n")
            (d / "wc").chmod(0o444)
            d.chmod(0o555)
            c = self.cluster(tmp, self.text.replace(line, f"readonly TRUSTED_TOOL_DIR={d}"))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])
            d.chmod(0o755)

    def test_a_writable_postgresql_binary_directory_or_binary_is_refused(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            c.bin.chmod(0o755)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("writable by the invoking user", done.stderr)
            self.assertEqual(c.calls(), [])
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            (c.bin / "psql").chmod(0o755)
            done = c.run("bootstrap", APPROVED_DB)
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])

    def test_no_first_apply_command_resolves_a_utility_through_path(self):
        """Static: every external utility the runner text calls has a wrapper that runs the absolute path under env -i; PATH is fixed."""
        code = "\n".join(l for l in self.text.splitlines() if not l.strip().startswith("#"))
        self.assertIn("PATH=/usr/bin:/bin; export PATH", code)
        for tool in ("cat", "sha256sum", "cut", "wc", "realpath", "basename", "dirname", "id", "grep", "head", "readlink", "ls", "mkdir", "chmod",
                     "timeout", "python3"):
            self.assertIn(f"{tool}() {{ _tool {tool} \"$@\"; }}", code, tool)
        self.assertNotRegex(code, r"(^|[^\w/$.-])(env) -i")          # env is only ever called by its absolute path
        self.assertIn('"$TRUSTED_TOOL_DIR/env" -i PATH=/usr/bin:/bin LANG=C.UTF-8', code)


class LedgerFailClosed(unittest.TestCase):
    """F-2: every migration-ledger status query fails closed. No fallback to "not applied", no automatic retry."""

    def cluster(self, tmp, text=None):
        return HashToApplyCluster(Path(tmp), runner_text=text)

    def populate(self, c):
        for n, _, d in runner_table()["base"]:
            (c.state / "ledger").open("a").write(f"{n} {d}\n")
        (c.state / "ledger_exists").write_text("")

    def count(self, c, cat):
        p = c.state / f"cnt_{cat}"
        return int(p.read_text()) if p.exists() else 0

    def test_a_failed_status_query_stops_migrate_base_before_anything_is_applied(self):
        for cat in ("regclass",):
            with self.subTest(cat), short_tmp() as tmp:
                c = self.cluster(tmp)
                c.hook(f"rc_{cat}", "1")
                done = c.run("migrate-base", APPROVED_DB)
                self.assertEqual(done.returncode, 8, done.stderr)
                self.assertIn("could not be verified", done.stderr)
                self.assertEqual(c.submissions(), [])
                self.assertEqual(self.count(c, cat), 1, "the failing query must not be retried")

    def test_every_status_query_failure_in_migrate_base_stops_it_with_exit_8(self):
        for cat, setup in (("count", True), ("hash", False), ("pin", False)):
            with self.subTest(cat), short_tmp() as tmp:
                c = self.cluster(tmp)
                if setup:
                    (c.state / "ledger_exists").write_text("")
                c.hook(f"rc_{cat}", "2")
                done = c.run("migrate-base", APPROVED_DB)
                self.assertEqual(done.returncode, 8, done.stderr)
                self.assertEqual(self.count(c, cat), 1)
                if cat == "count":
                    self.assertEqual(c.submissions(), [])
                if cat == "hash":
                    self.assertEqual(len(c.submissions()), 1)           # stopped right after the first file; nothing further applied

    def test_malformed_status_output_is_refused(self):
        bad_bool = ("maybe", "", "t t", "T", "true", "1")
        for out in bad_bool:
            with self.subTest(("regclass", out)), short_tmp() as tmp:
                c = self.cluster(tmp)
                c.hook("out_regclass", out)
                done = c.run("migrate-base", APPROVED_DB)
                self.assertEqual(done.returncode, 8, (out, done.stderr))
                self.assertEqual(c.submissions(), [])
        for out in ("abc", "-1", "", "0 0", "1.5", "99999999999"):
            with self.subTest(("count", out)), short_tmp() as tmp:
                c = self.cluster(tmp)
                (c.state / "ledger_exists").write_text("")
                c.hook("out_count", out)
                done = c.run("migrate-base", APPROVED_DB)
                self.assertEqual(done.returncode, 8, (out, done.stderr))
                self.assertEqual(c.submissions(), [])
        for out in ("zz", "A" * 64, "a" * 63, "a" * 65, "not a hash"):
            with self.subTest(("hash", out)), short_tmp() as tmp:
                c = self.cluster(tmp)
                c.hook("out_hash", out)
                done = c.run("migrate-base", APPROVED_DB)
                self.assertEqual(done.returncode, 8, (out, done.stderr))
                self.assertLessEqual(len(c.submissions()), 1)

    def test_a_timed_out_status_query_stops_the_run_and_is_not_retried(self):
        text = RUNNER.read_text(encoding="utf-8")
        self.assertIn("G2C1_QUERY_TIMEOUT=60", text)
        with short_tmp() as tmp:
            c = self.cluster(tmp, text.replace("G2C1_QUERY_TIMEOUT=60", "G2C1_QUERY_TIMEOUT=1"))
            c.hook("sleep_regclass", "5")
            started = time.monotonic()
            done = c.run("migrate-base", APPROVED_DB)
            self.assertLess(time.monotonic() - started, 4.5)
            self.assertEqual(done.returncode, 8, done.stderr)
            self.assertEqual(c.submissions(), [])
            self.assertEqual(self.count(c, "regclass"), 1)

    def test_the_timeout_cannot_be_set_by_the_caller(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            c.hook("sleep_regclass", "2")
            done = c.run("migrate-base", APPROVED_DB, env={"G2C1_QUERY_TIMEOUT": "1"})
            self.assertEqual(done.returncode, 0, done.stderr)               # the caller's value is discarded; the 60 s bound applies

    def test_a_caller_supplied_timeout_cannot_cut_off_an_apply(self):
        """G2C1_QUERY_TIMEOUT is discarded at start: a caller value must not apply to the (long-running) migration submissions either."""
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            c.hook("hook", "sleep 2\n")
            done = c.run("bootstrap", APPROVED_DB, env={"G2C1_QUERY_TIMEOUT": "1"})
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(len(c.submissions()), 1)

    def test_an_unexpected_ledger_state_stops_without_applying(self):
        with short_tmp() as tmp:        # relation present, ledger not empty -> second application refused (exit 7), state unchanged
            c = self.cluster(tmp)
            (c.state / "ledger_exists").write_text("")
            (c.state / "ledger").write_text("0001_g2a_schema_foundation.sql " + "a" * 64 + "\n")
            before = (c.state / "ledger").read_text()
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertEqual(c.submissions(), [])
            self.assertEqual((c.state / "ledger").read_text(), before)
        with short_tmp() as tmp:        # count says 3 although the relation test said empty file: still refused
            c = self.cluster(tmp)
            (c.state / "ledger_exists").write_text("")
            c.hook("out_count", "3")
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertEqual(c.submissions(), [])

    def test_a_duplicate_migration_is_refused_and_leaves_the_ledger_unchanged(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            self.assertEqual(c.run("migrate-base", APPROVED_DB).returncode, 0)
            snapshot_ledger, n = (c.state / "ledger").read_text(), len(c.submissions())
            again = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(again.returncode, 7, again.stderr)
            self.assertEqual((c.state / "ledger").read_text(), snapshot_ledger)
            self.assertEqual(len(c.submissions()), n)

    def test_0011_missing_ledger_and_unreadable_ledger_stop_before_any_submission(self):
        with short_tmp() as tmp:        # ledger relation absent: the base-row query itself errors -> exit 8
            c = self.cluster(tmp)
            c.hook("rc_hash", "1")
            done = c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest())
            self.assertEqual(done.returncode, 8, done.stderr)
            self.assertEqual(c.submissions(), [])
        with short_tmp() as tmp:        # relation present, rows missing -> the approved base is not recorded (exit 3)
            c = self.cluster(tmp)
            (c.state / "ledger_exists").write_text("")
            done = c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest())
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertIn("apply migrate-base first", done.stderr)
            self.assertEqual(c.submissions(), [])

    def test_0011_recorded_check_fails_closed_when_its_query_fails_or_is_malformed(self):
        """The fail-open pattern of V04 F-2 was also at the 0011 recorded-check: a failing query used to look like 'not recorded'."""
        digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
        n_base = 10
        for label, hooks in (("failure", {"rc_hash": "1"}), ("malformed", {"out_hash": "oops"})):
            with self.subTest(label), short_tmp() as tmp:
                c = self.cluster(tmp)
                self.populate(c)
                c.hook("from_hash", str(n_base + 1))              # the first ten hash queries (base rows) are answered normally
                for k, v in hooks.items():
                    c.hook(k, v)
                done = c.run("migrate-0011", APPROVED_DB, digest)
                self.assertEqual(done.returncode, 8, done.stderr)
                self.assertEqual(c.submissions(), [])

    def test_0011_apply_file_status_checks_fail_closed(self):
        digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
        for label, hooks, want in (("regclass failure", {"rc_regclass": "1"}, 8), ("regclass malformed", {"out_regclass": "perhaps"}, 8)):
            with self.subTest(label), short_tmp() as tmp:
                c = self.cluster(tmp)
                self.populate(c)
                for k, v in hooks.items():
                    c.hook(k, v)
                done = c.run("migrate-0011", APPROVED_DB, digest)
                self.assertEqual(done.returncode, want, done.stderr)
                self.assertEqual(c.submissions(), [])
        with self.subTest("post-apply readback failure"), short_tmp() as tmp:
            c = self.cluster(tmp)
            self.populate(c)
            c.hook("from_hash", "13")                              # 10 base rows + the recorded-check + apply_file's own lookup answer normally
            c.hook("rc_hash", "1")
            done = c.run("migrate-0011", APPROVED_DB, digest)
            self.assertEqual(done.returncode, 8, done.stderr)
            self.assertEqual(c.submissions(), [MIGRATION.read_bytes()])   # the approved bytes were submitted; the unreadable ledger is reported

    def test_valid_first_application_still_succeeds(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(len(c.submissions()), 10)
            digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
            done = c.run("migrate-0011", APPROVED_DB, digest)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(c.ledger_rows()[-1], ("0011_g2c1_funding_ledger.sql", digest))

    # ---- V05 F-4: the two fail-open reversions the V05 mutation matrix found (M32, M38) ----------------------------------------------
    def test_a_failed_or_malformed_ledger_lookup_at_every_0011_base_prerequisite_is_not_read_as_not_recorded(self):
        """M38: the base-prerequisite read reverted to `|| echo "$want"` accepts a failing query as 'recorded'. A failing query at ANY of the
        ten positions must stop the run with exit 8 and submit nothing; it must neither pass as recorded nor be read as 'not applied'."""
        digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
        for pos in range(1, 11):
            for label, hooks in (("failure", {"rc_hash": "1"}), ("malformed", {"out_hash": "not-a-digest"}), ("timeout", {"rc_hash": "124"})):
                with self.subTest(f"{label} at base row {pos}"), short_tmp() as tmp:
                    c = self.cluster(tmp)
                    self.populate(c)
                    c.hook("from_hash", str(pos))
                    for k, v in hooks.items():
                        c.hook(k, v)
                    done = c.run("migrate-0011", APPROVED_DB, digest)
                    self.assertEqual(done.returncode, 8, done.stderr)
                    self.assertEqual(c.submissions(), [])
                    self.assertEqual(self.count(c, "hash"), pos, "the failing query must be issued once and not retried")
                    self.assertEqual(len(c.ledger_rows()), 10)

    def test_a_failed_ledger_row_lookup_inside_apply_file_is_not_read_as_not_applied(self):
        """M32: apply_file's row lookup reverted to `$(q ... || true)` reads a failing query as 'no row' and applies. Lookup positions for
        migrate-0011: 10 base rows, the recorded check (11), apply_file's own row lookup (12)."""
        digest = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
        for label, hooks in (("failure", {"rc_hash": "1"}), ("malformed", {"out_hash": "oops"}), ("timeout", {"rc_hash": "124"})):
            with self.subTest(label), short_tmp() as tmp:
                c = self.cluster(tmp)
                self.populate(c)
                c.hook("from_hash", "12")
                for k, v in hooks.items():
                    c.hook(k, v)
                done = c.run("migrate-0011", APPROVED_DB, digest)
                self.assertEqual(done.returncode, 8, done.stderr)
                self.assertEqual(c.submissions(), [])
                self.assertEqual(len(c.ledger_rows()), 10)
                self.assertNotIn("0011_g2c1_funding_ledger.sql", [r[0] for r in c.ledger_rows()])

    def test_a_failed_query_is_never_treated_as_an_unapplied_migration_in_migrate_base(self):
        for pos in range(1, 11):
            with self.subTest(f"row lookup {pos}"), short_tmp() as tmp:
                c = self.cluster(tmp)
                self.populate(c)                                  # a ledger that already holds all ten approved rows
                c.hook("from_hash", str(pos))
                c.hook("rc_hash", "1")
                done = c.run("migrate-base", APPROVED_DB)
                self.assertNotEqual(done.returncode, 0)
                self.assertEqual(c.submissions(), [], "a status failure must never lead to a submission")

    def test_base_and_0011_migrations_are_submitted_in_one_transaction(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            self.assertEqual(c.run("migrate-base", APPROVED_DB).returncode, 0)
            self.assertEqual(c.run("migrate-0011", APPROVED_DB, hashlib.sha256(MIGRATION.read_bytes()).hexdigest()).returncode, 0)
            submits = [a for a in c.calls() if "-f" in a and "-" in a]
            self.assertEqual(len(submits), 11)
            for argv in submits:
                self.assertIn("-1", argv, argv)

    def test_no_status_query_in_the_runner_uses_the_fail_open_command_substitution_test(self):
        code = "\n".join(l for l in RUNNER.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("#"))
        self.assertNotRegex(code, r'\[[^\]]*\$\([^)]*\bq\b')
        self.assertEqual(code.count("G2C1_PSQL_QUIET=1 q -At"), 1)             # the single status-query site is ledger_read


class RunnerStartupGate(unittest.TestCase):
    """V05 F-1 (startup order) and F-3 (BASH_XTRACEFD). Offline stubs only; the supported invocation is direct execution."""

    def cluster(self, tmp, text=None):
        return HashToApplyCluster(Path(tmp), runner_text=text)

    def test_the_mode_check_and_the_xtrace_refusal_precede_set_euo_pipefail_and_every_other_statement(self):
        """Behavioural proof is in the tests below; this checks only that the gate is the first executable code (documentation of the order)."""
        code = [l for l in RUNNER.read_text(encoding="utf-8").splitlines() if l.strip() and not l.lstrip().startswith("#")]
        self.assertTrue(code[0].startswith('case "$-" in *p*)'))
        self.assertTrue(code[1].startswith('case "${BASH_XTRACEFD+set}" in set)'))
        self.assertEqual(code[2], "set -euo pipefail")

    def test_exported_functions_named_like_the_gate_builtins_cannot_get_the_runner_past_the_mode_check(self):
        """Unsupported invocation (`bash <runner>`): exported functions named set, declare (V05 B5/B7) and the other builtins the later
        checks use. Nothing reaches psql, nothing is submitted, and the functions for set and declare never run."""
        names = ("set", "declare", "unset", "builtin", "command", "test", "[", "read", "eval", "hash", "compgen", "shopt", "local", "readonly")
        for name in names:
            with self.subTest(name), short_tmp() as tmp:
                c = self.cluster(tmp)
                marks = Path(tmp) / "marks"
                marks.mkdir()
                env = {f"BASH_FUNC_{name}%%": f"() {{  touch {marks}/fn_{name}\n}}"}
                done = c.run("migrate-base", APPROVED_DB, env=env, via=["/usr/bin/bash"])
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertEqual(c.calls(), [])
                self.assertEqual(c.submissions(), [])
                self.assertEqual(c.ledger_rows(), [])
                if name not in ("test", "[", "read", "eval", "hash", "compgen", "shopt", "local", "readonly", "unset", "builtin", "command"):
                    self.assertFalse((marks / f"fn_{name}").exists(), f"the function {name} ran before the mode check")

    def test_a_shadowing_function_plus_a_lying_digest_tool_still_cannot_change_the_submitted_bytes_when_started_as_bash(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            (Path(tmp) / "db/migrations" / APPROVED_BASE_NAMES[0]).write_bytes(b"select 'tampered';\n")
            env = {"BASH_FUNC_set%%": "() {  :\n}", "BASH_FUNC_declare%%": "() {  :\n}", "BASH_FUNC_sha256sum%%": "() {  echo " + "a" * 64 + "  -\n}"}
            done = c.run("migrate-base", APPROVED_DB, env=env, via=["/usr/bin/bash"])
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.submissions(), [])

    def test_bash_env_runs_before_script_initialization_when_started_incorrectly_and_that_cannot_be_blocked_in_the_script(self):
        """BASH_ENV pre-startup behaviour, documented: with `bash <runner>` the interpreter runs $BASH_ENV before line one. The runner refuses
        afterwards (no psql call), but it cannot prevent the execution. Under the supported invocation $BASH_ENV does not run at all."""
        with short_tmp() as tmp:
            a, c = Attacker(Path(tmp)), self.cluster(tmp)
            env = {"BASH_ENV": str(a.bash_env)}
            bad = c.run("migrate-base", APPROVED_DB, env=env, via=["/usr/bin/bash"])
            self.assertEqual(bad.returncode, 3, bad.stderr)
            self.assertEqual(c.calls(), [])
            self.assertIn("bash_env_ran", a.marks_left())
            (a.marks / "bash_env_ran").unlink()
            ok = c.run("identity", env=env)
            self.assertNotIn("bash_env_ran", a.marks_left())
        text = RUNNER.read_text(encoding="utf-8")
        for needle in ("cannot stop $BASH_ENV from executing before script initialization", "dynamic loader from running before line one",
                       "compromised operating system or a host administrator is outside scope", "NOT CLAIMED: safety against an arbitrary hostile environment"):
            self.assertIn(needle, text)
        self.assertNotIn("the only way to do that", text)

    def test_ld_preload_is_refused_when_visible_and_its_limitation_is_stated(self):
        """A visible LD_PRELOAD is refused (defense in depth). A library that erases its own variable before the runner's first line is
        not detectable from inside the script; the header says so. This test does not claim otherwise."""
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            done = c.run("migrate-base", APPROVED_DB, env={"LD_PRELOAD": "/nonexistent.so"})
            self.assertEqual(done.returncode, 3, done.stderr)
            self.assertEqual(c.calls(), [])
        self.assertIn("it can erase its own variable", RUNNER.read_text(encoding="utf-8"))

    def test_an_inherited_bash_xtracefd_is_refused_before_any_psql_call_or_ledger_change(self):
        """F-3: values 1, 2, 3, an unused descriptor, an invalid one and an empty one. Refused (exit 3), never unset, no submission, ledger
        untouched, and stdout is not closed (a later write would have failed and left a partial base migration)."""
        for value in ("1", "2", "3", "9", "99", "-1", "abc", ""):
            with self.subTest(repr(value)), short_tmp() as tmp:
                c = self.cluster(tmp)
                out = Path(tmp) / "stdout.txt"
                with out.open("wb") as fh:
                    done = subprocess.run([str(c.script), "migrate-base", APPROVED_DB], stdout=fh, stderr=subprocess.PIPE, text=True, check=False,
                                          env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "BASH_XTRACEFD": value}, timeout=60)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn("BASH_XTRACEFD", done.stderr)
                self.assertEqual(c.calls(), [])
                self.assertEqual(c.submissions(), [])
                self.assertEqual(c.ledger_rows(), [])
                self.assertEqual(out.read_bytes(), b"")

    def test_a_live_xtrace_descriptor_inherited_from_the_caller_is_refused_and_left_open(self):
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            trace = Path(tmp) / "trace.txt"
            fd = os.open(trace, os.O_WRONLY | os.O_CREAT)
            try:
                done = subprocess.run([str(c.script), "migrate-base", APPROVED_DB], capture_output=True, text=True, check=False, pass_fds=(fd,),
                                      env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "BASH_XTRACEFD": str(fd)}, timeout=60)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertEqual(c.calls(), [])
                os.fstat(fd)                                         # the caller's own descriptor is untouched
            finally:
                os.close(fd)

    def test_control_with_bash_xtracefd_absent_the_first_application_is_unchanged(self):
        """Control: with BASH_XTRACEFD absent the first application is unchanged and every base migration is applied."""
        with short_tmp() as tmp:
            c = self.cluster(tmp)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(c.submissions(), [pristine(n) for n in APPROVED_BASE_NAMES])
            self.assertEqual(len(c.ledger_rows()), 10)



# ======================================================================================================================================
# GATE A (SIM-ENG-003-G2C1-A8): source-only functional-harness repair. Every test below uses stubs and temporary trees: no database, no
# PostgreSQL, no SQL, no network. They are developer regression tests, NOT independent acceptance (A8 C-1): LOOM-2 inspects every
# material assertion, re-runs them and mutates copies.
# ======================================================================================================================================
import ast
import io
import contextlib
import random

SCRATCH = "drawbridge_g2_scratch"
SNAPSHOT_PY = G2DB / "ledger" / "snapshot.py"
DB_CASES_PY = HERE / "db_cases.py"
RUNNER_PIN = "f99374307cd3ade7b0dff6cfb754a28d0cf4d515c394d1f60c63e4b216973414"
MIGRATION_PIN = "0b8ddcc61650a3535b4377929250c17f2be2539b63c02075b1ab4cc7452743b6"
RETRY_BASELINE_SHA256 = "874fd16e69864ba913365869ca653e59c09675b9b303a581eb3c5cc35cfd327b"   # retry.py at the engineering baseline 14e453db


def string_constants(path: Path):
    """(function name or '<module>', constant) for every string constant in a source file, docstrings excluded."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    doc_nodes = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)) and ast.get_docstring(node, clean=False) is not None:
            doc_nodes.add(id(node.body[0].value))
    out = []

    def walk(node, owner):
        for child in ast.iter_child_nodes(node):
            name = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else owner
            if isinstance(child, ast.Constant) and isinstance(child.value, str) and id(child) not in doc_nodes:
                out.append((owner, child.value))
            walk(child, name)
    walk(tree, "<module>")
    return out


def functions_containing(path: Path, predicate):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return sorted(n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                  and any(predicate(x) for x in ast.walk(n)))


class GateATargetSelection(unittest.TestCase):
    BAD = (None, "", "drawbridge_g2_dev", "drawbridge_g2_test", "postgres", "template0", "template1", "drawbridge_g2_scratch_inject_01",
           "drawbridge_g2_scratch_inject", "drawbridge_g2_scratch ", " drawbridge_g2_scratch", "drawbridge_g2_scratch\n", "DRAWBRIDGE_G2_SCRATCH",
           "drawbridge_g2_scratch2", "drawbridge_g2_scratch;", "pg18-g2", "drawbridge_g2_scratch\x00", b"drawbridge_g2_scratch", 54418)

    def test_only_the_exact_acceptance_name_is_accepted(self):
        self.assertEqual(snapshot.require_acceptance_target(SCRATCH), SCRATCH)
        for bad in self.BAD:
            with self.subTest(bad=bad), self.assertRaises(snapshot.TargetRefused):
                snapshot.require_acceptance_target(bad)

    def test_db_refuses_every_bad_name_before_any_launch(self):
        for bad in self.BAD:
            stub = LaunchStub()
            with self.subTest(bad=bad), self.assertRaises(snapshot.TargetRefused):
                db_cases.Db(bad, run=stub).run("g2_scratch_admin", "select 1;")
            self.assertEqual(stub.calls, [])

    def test_run_all_refuses_before_any_launch(self):
        for bad in self.BAD:
            stub = LaunchStub()
            with self.subTest(bad=bad), self.assertRaises(snapshot.TargetRefused):
                db_cases.run_all(enabled=True, database=bad, cases="G2C1-DBT-02", evidence_dir=evidence_tmp(), run=stub)
            self.assertEqual(stub.calls, [])
            if bad is not None:
                with self.assertRaises(snapshot.TargetRefused):
                    db_cases.run_all(enabled=False, database=bad, run=stub)
            self.assertEqual(stub.calls, [])

    def test_a_dry_run_reports_all_27_not_run_and_launches_nothing(self):
        for database in (None, SCRATCH):
            stub = LaunchStub()
            report = db_cases.run_all(enabled=False, database=database, run=stub)
            self.assertEqual(len(report), 27)
            self.assertEqual({r["status"] for r in report}, {"NOT RUN"})
            self.assertEqual(stub.calls, [])

    def test_an_injection_database_is_never_the_acceptance_target(self):
        with self.assertRaises(snapshot.TargetRefused):
            db_cases.Db("drawbridge_g2_scratch_inject_01")
        with self.assertRaises(snapshot.TargetRefused):
            db_cases.Db(SCRATCH, injection=True)
        with self.assertRaises(snapshot.TargetRefused):
            db_cases.Db("drawbridge_g2_dev", injection=True)
        self.assertEqual(db_cases.Db("drawbridge_g2_scratch_inject_01", injection=True).database, "drawbridge_g2_scratch_inject_01")
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.fetch_snapshot("drawbridge_g2_scratch_inject_01", run=LaunchStub())

    def test_main_requires_an_explicit_target_and_rejects_every_override(self):
        def go(argv, env=None):
            err, out = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, env or {}, clear=False), contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                return db_cases.main(argv), out.getvalue(), err.getvalue()
        for argv in ([], ["--enable"], ["--db"], ["--db", "drawbridge_g2_dev"], ["--db", "drawbridge_g2_scratch_inject_01"], ["--db", SCRATCH, "--db", SCRATCH],
                     ["--db", SCRATCH, "--host", "x"], ["--db", SCRATCH, "--port", "54418"], ["--db", SCRATCH, "extra"], ["--db", "--enable"],
                     ["--db", SCRATCH, "--enable", "--enable"], ["--db", SCRATCH, "--enable"], ["--db", SCRATCH, "--enable", "--evidence-dir", "x"],
                     ["--db", SCRATCH, "--cases"], ["--db", SCRATCH, "--cases", "G2C1-DBT-02", "--cases", "G2C1-DBT-03"]):
            with self.subTest(argv=argv):
                rc, out, err = go(argv)
                self.assertEqual(rc, 2, (out, err))
                self.assertEqual(out, "")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(db_cases.ENABLE_ENV, None)
            rc, out, err = go(["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02", "--evidence-dir", str(evidence_tmp())])
            self.assertEqual(rc, 2)                     # an enabled run also needs an owner-approved source table (A10 R7)
            rc, out, err = go(["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02", "--evidence-dir", str(evidence_tmp()), "--approved-source", str(approved_source_table())])
            self.assertEqual(rc, 3)                     # the opt-in environment value is still required
        rc, out, err = go(["--db", SCRATCH])
        self.assertEqual(rc, 0)
        self.assertEqual({r["status"] for r in json.loads(out)}, {"NOT RUN"})
        rc, out, err = go(["--db", SCRATCH, "--cases", "G2C1-DBT-03,G2C1-DBT-02"])      # a dry run validates and reports the canonical order; nothing runs
        self.assertEqual(rc, 0)
        self.assertIn("SELECTED CASES: G2C1-DBT-02,G2C1-DBT-03", err)

    def test_enabled_runs_need_an_empty_private_evidence_directory(self):
        for bad in (None, "/nonexistent-g2c1-dir", str(HERE / "db_cases.py")):
            with self.subTest(bad=bad), self.assertRaises(snapshot.LaunchRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, evidence_dir=bad, run=LaunchStub())
        d = evidence_tmp()
        (d / "x").write_text("x")
        with self.assertRaises(snapshot.LaunchRefused):
            db_cases.prepare_evidence_dir(d)                 # not empty: nothing is reused
        d2 = evidence_tmp()
        d2.chmod(0o755)
        with self.assertRaises(snapshot.LaunchRefused):
            db_cases.prepare_evidence_dir(d2)                # group/other access
        link = evidence_tmp() / "link"
        link.symlink_to(evidence_tmp())
        with self.assertRaises(snapshot.LaunchRefused):
            db_cases.prepare_evidence_dir(link)

    def test_no_default_database_exists_in_the_source(self):
        sig = __import__("inspect").signature
        self.assertIs(sig(db_cases.Db.__init__).parameters["database"].default, sig(db_cases.Db.__init__).parameters["database"].empty)
        self.assertIsNone(sig(db_cases.run_all).parameters["database"].default)
        for path in (DB_CASES_PY, SNAPSHOT_PY):
            hits = [(owner, c) for owner, c in string_constants(path) if "drawbridge_g2_dev" in c or "drawbridge_g2_test" in c]
            self.assertEqual([h for h in hits if h[0] != "<module>"], [], path.name)   # only the module-level RESERVED_DATABASES tuple may name them
        self.assertEqual(db_cases.RESERVED_DATABASES.count("drawbridge_g2_dev"), 1)

    def test_the_harness_names_no_historical_cluster_outside_the_excluded_case(self):
        self.assertEqual([c for _, c in string_constants(SNAPSHOT_PY) if "pg18-g2" in c or "54418" in c], [])
        owners = {o for o, c in string_constants(DB_CASES_PY) if re.search(r"pg18-g2(?!c1)", c) or "54418" in c}
        # snapshot_old is nested in runtime_safety (DBT-24, EXCLUDED by A8 C-3, unreachable through CASES); injection_live_failures only REFUSES a
        # database whose live facts name the historical path or port
        self.assertEqual(owners, {"snapshot_old", "injection_live_failures"})
        self.assertEqual(functions_containing(DB_CASES_PY, lambda n: isinstance(n, ast.FunctionDef) and n.name == "snapshot_old"), ["runtime_safety", "snapshot_old"])


class GateALauncher(unittest.TestCase):
    def test_the_environment_is_explicit_and_nothing_hostile_is_inherited(self):
        hostile = {"BASH_ENV": "/x", "BASH_XTRACEFD": "2", "LD_PRELOAD": "/x", "LD_LIBRARY_PATH": "/x", "GCONV_PATH": "/x", "LOCPATH": "/x", "NLSPATH": "/x",
                   "SHELLOPTS": "xtrace", "ENV": "/x", "PGHOST": "h", "PGPORT": "54418", "PGOPTIONS": "-c x", "PGSERVICE": "s", "G2C1_QUERY_TIMEOUT": "1",
                   "G2C1_PSQL_QUIET": "1", "PATH": "/tmp/evil", "HOME": "/tmp/evil", "LANG": "xx"}
        stub = LaunchStub()
        with mock.patch.dict(os.environ, hostile, clear=False):
            snapshot.launch_runner(["identity"], run=stub, label="t-env")
        env = stub.calls[0][1]["env"]
        self.assertEqual(set(env), {"PATH", "HOME", "LANG"})
        self.assertEqual(env["PATH"], "/usr/bin:/bin")
        self.assertEqual(env["LANG"], "C.UTF-8")
        self.assertEqual(env["HOME"], snapshot.verified_home())
        self.assertNotEqual(env["HOME"], "/tmp/evil")

    def test_direct_execution_without_interpreter_shell_or_pipes(self):
        stub = LaunchStub()
        snapshot.launch_runner(["status"], run=stub, label="t-direct")
        argv, kw = stub.calls[0]
        self.assertEqual(argv, [str(RUNNER), "status"])
        self.assertTrue(os.access(RUNNER, os.X_OK))
        self.assertNotIn(kw.get("shell"), (True, 1))
        self.assertEqual(kw["stdin"], subprocess.DEVNULL)
        for stream in ("stdout", "stderr"):
            self.assertNotEqual(kw[stream], subprocess.PIPE)
            self.assertTrue(hasattr(kw[stream], "fileno"))      # a file, not a pipe that can close under the runner
        self.assertNotIn("capture_output", kw)
        self.assertNotIn("input", kw)

    def test_the_exact_exit_status_is_preserved(self):
        for rc in (0, 1, 2, 3, 4, 5, 6, 7, 8, 141, 255):
            r = snapshot.launch_runner(["status"], run=LaunchStub(rc=rc), label=f"t-rc{rc}")
            self.assertEqual(r.rc, rc)
        for bad in (None, "0", 0.0, True):
            with self.subTest(bad=bad), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["status"], run=mock.Mock(return_value=mock.Mock(returncode=bad)), label="t-badrc")

    def test_output_goes_to_files_whose_hashes_are_recorded_and_nothing_is_overwritten(self):
        ev = evidence_tmp()
        stub = LaunchStub(rc=1, out="out-bytes\n", err="err-bytes\n")
        r = snapshot.launch_runner(["identity"], run=stub, evidence_dir=ev, label="case-0001-x")
        self.assertEqual((ev / "case-0001-x.stdout").read_bytes(), b"out-bytes\n")
        self.assertEqual((ev / "case-0001-x.stderr").read_bytes(), b"err-bytes\n")
        self.assertEqual(r.stdout_sha256, hashlib.sha256(b"out-bytes\n").hexdigest())
        self.assertEqual(r.stderr_sha256, hashlib.sha256(b"err-bytes\n").hexdigest())
        self.assertEqual(oct((ev / "case-0001-x.stdout").stat().st_mode & 0o777), "0o600")
        again = LaunchStub()
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["identity"], run=again, evidence_dir=ev, label="case-0001-x")
        self.assertEqual(again.calls, [])
        self.assertEqual((ev / "case-0001-x.stdout").read_bytes(), b"out-bytes\n")   # untouched
        for bad_dir in (ev / "missing", ev / "case-0001-x.stdout"):
            with self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["identity"], run=LaunchStub(), evidence_dir=bad_dir, label="t")
        for label in ("", "a/b", "../x", "a b", "x" * 200, None):
            with self.subTest(label=label), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["identity"], run=LaunchStub(), label=label)

    def test_the_runner_must_be_the_approved_executable_file(self):
        self.assertEqual(snapshot.RUNNER_SHA256, RUNNER_PIN)
        self.assertEqual(hashlib.sha256(RUNNER.read_bytes()).hexdigest(), RUNNER_PIN)
        name = snapshot.RUNNER_BASENAME                                                         # A12 F-A: every copy carries the approved file name
        good = evidence_tmp() / name
        good.write_bytes(RUNNER.read_bytes())
        good.chmod(0o755)
        snapshot.launch_runner(["status"], run=LaunchStub(), runner=good, label="t-good")        # byte-identical copy: accepted
        changed = evidence_tmp() / name
        changed.write_bytes(RUNNER.read_bytes() + b"# x\n")
        changed.chmod(0o755)
        noexec = evidence_tmp() / name
        noexec.write_bytes(RUNNER.read_bytes())
        noexec.chmod(0o644)
        link = evidence_tmp() / name
        link.symlink_to(good)
        for bad in (changed, noexec, link, evidence_tmp() / name, Path("g2c1_durable_cluster.sh")):
            stub = LaunchStub()
            with self.subTest(bad=str(bad)), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["status"], run=stub, runner=bad, label="t-bad")
            self.assertEqual(stub.calls, [])

    def test_pgoptions_is_a_closed_list(self):
        call = snapshot.RegisteredCall("post_call", dict(fn="post_funding", alloc=str(uuid.uuid4()), ver=1, amt="1.00", auth="AUTH-1", key="KEY-1"))
        for ok in (db_cases.SERIALIZABLE, db_cases.READ_COMMITTED, "-c default_transaction_isolation=repeatable\\ read"):
            stub = LaunchStub()
            snapshot.launch_runner(["psql", SCRATCH, "authority_svc", "-At", "-c", call], run=stub, pgoptions=ok, label="t-pg")
            self.assertEqual(stub.calls[0][1]["env"]["PGOPTIONS"], ok)
        for bad in ("-c default_transaction_isolation='read committed'", "-c search_path=x", "", "-c default_transaction_isolation=serializable -c x=y"):
            stub = LaunchStub()
            with self.subTest(bad=bad), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["psql", SCRATCH, "authority_svc", "-At", "-c", call], run=stub, pgoptions=bad, label="t-pg")
            self.assertEqual(stub.calls, [])
        stub = LaunchStub()
        with self.assertRaises(snapshot.LaunchRefused):                       # PGOPTIONS is meaningful only for a registered psql operation that takes isolation options
            snapshot.launch_runner(["status"], run=stub, pgoptions=db_cases.SERIALIZABLE, label="t-pg")
        self.assertEqual(stub.calls, [])

    def test_a_timeout_or_unreadable_output_is_a_refusal_never_a_result(self):
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["status"], run=mock.Mock(side_effect=subprocess.TimeoutExpired("x", 1)), label="t-to")
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["status"], run=LaunchStub(out=b"\xff\xfe"), label="t-utf")
        for bad in ([], (), "status", ["status", 1], None):
            with self.subTest(bad=bad), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(bad, run=LaunchStub(), label="t-args")

    def test_the_home_directory_must_be_the_verified_account_home(self):
        tmp = evidence_tmp()
        link = tmp / "homelink"
        link.symlink_to(tmp)
        for fake_home in ("relative/home", str(tmp / "nope"), str(link), "/"):
            entry = mock.Mock(pw_dir=fake_home)
            with self.subTest(home=fake_home), mock.patch.object(snapshot.pwd, "getpwuid", return_value=entry), self.assertRaises(snapshot.LaunchRefused):
                snapshot.verified_home()


class GateAPayloadAndLiterals(unittest.TestCase):
    ACCEPT = ("select 1;", "select 1", "begin;\ninsert into t values (1);\ncommit;", "begin isolation level repeatable read read only; select 1; commit;",
              "select 'a;b';", "select 'it''s';", "select $$a;b$$;", "select $t$a;$$;b$t$;", 'select "a;b" from t;', "select 1 -- c; d\n;",
              "select /* x; /* y */ ; */ 1;", "select 'a'::text, 1::int;", "select ':x', ':''y';", "-- :x\nselect 1;", "start transaction; select 1; end;",
              "select 'tab\there', 'new\nline', 'unié';")
    REFUSE = ("", "   \n", None, 5, b"select 1", "select 1; select 2;", "select 1;;", ";", "select 'x;", 'select "x;', "select /* x;", "select $$x;",
              "select 1\\gset", "select '\\\\';", "select 1\x00", "select 1\x07", "select 1\r", "select :x;", "select :'x';", 'select :"x";', "select :{?x};",
              "begin;select 1;", "select 1;commit;", "begin;begin;select 1;commit;", "begin;select 1;rollback;", "begin;savepoint a;select 1;commit;",
              "begin;select 1;commit;select 2;", "insert into t values (1); select 1;", "x" * 100_001, "select '\ud800';")

    def test_accepted_payloads(self):
        for sql in self.ACCEPT:
            with self.subTest(sql=sql):
                self.assertEqual(snapshot.validate_sql_payload(sql), sql)

    def test_refused_payloads(self):
        for sql in self.REFUSE:
            with self.subTest(sql=sql), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(sql)

    def test_a_script_that_the_old_stdin_path_would_have_run_in_part_is_refused(self):
        # statements before the failing one would have been delivered by `-f -`; a multi-statement -c without explicit boundaries is refused
        with self.assertRaises(snapshot.PayloadRefused):
            snapshot.validate_sql_payload("insert into drawbridge_auth.project values (1); select 1/0;")

    def test_the_snapshot_statement_is_one_explicit_transaction_block(self):
        self.assertEqual(snapshot.validate_sql_payload(snapshot.SNAPSHOT_SQL), snapshot.SNAPSHOT_SQL)
        self.assertEqual(len(snapshot._scan(snapshot.SNAPSHOT_SQL)), 3)

    def test_a_refused_payload_is_never_submitted(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        for sql in ("select 1; select 2;", "select :x;", "select 1\\g"):
            with self.subTest(sql=sql), self.assertRaises(snapshot.PayloadRefused):
                db.run("g2_scratch_admin", sql)                      # free-form SQL is never accepted (UnregisteredSql is a PayloadRefused)
            with self.subTest(validator=sql), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(sql)
        self.assertEqual(stub.calls, [])

    def test_text_literals_cannot_leave_their_quotes(self):
        rng = random.Random(20261113)
        alphabet = "ab'\";:$-/*\n\t é{}%_ x\\0"
        for _ in range(3000):
            value = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 24))).replace("\\", "").replace("0", "0")
            literal = db_cases.sql_text(value)
            payload = f"select {literal};"
            stmts = snapshot._scan(payload)                   # one statement, no interpolation form, no escape from the literal
            self.assertEqual(stmts, ["select ''"], (value, payload))
            snapshot.validate_sql_payload(payload)

    def test_text_literal_grammar(self):
        self.assertEqual(db_cases.sql_text("it's"), "'it''s'")
        self.assertEqual(db_cases.sql_text(""), "''")
        self.assertEqual(db_cases.sql_text("tab\there\nunié;x"), "'tab\there\nunié;x'")
        for bad in (None, 1, b"x", "a\\b", "a\x00b", "a\x01b", "a\x7fb", "x" * 4097, "\ud800"):
            with self.subTest(bad=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_text(bad)

    def test_uuid_and_bigint_grammar(self):
        u = str(uuid.uuid4())
        self.assertEqual(db_cases.sql_uuid(u), f"'{u}'")
        for bad in (None, "", u.upper(), "{" + u + "}", u.replace("-", ""), u + " ", "'" + u, u + "'; drop", uuid.UUID(u), 5):
            with self.subTest(bad=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_uuid(bad)
        for ok in (0, 1, -1, 2 ** 63 - 1, -(2 ** 63)):
            self.assertEqual(db_cases.sql_int(ok), str(ok))
        for bad in (True, False, 2 ** 63, -(2 ** 63) - 1, "1", 1.0, None, "1; drop"):
            with self.subTest(bad=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_int(bad)

    def test_templates_need_exactly_their_typed_values(self):
        u = str(uuid.uuid4())
        t = "select {{a:uuid}}::uuid, {{n:int}}::bigint, {{s:text}};"
        self.assertEqual(db_cases.render_sql(t, a=u, n=3, s="x'y"), f"select '{u}'::uuid, 3::bigint, 'x''y';")
        self.assertEqual(db_cases.render_sql("select {{s:text}};", s="{{a:uuid}}"), "select '{{a:uuid}}';")   # a value is never re-expanded
        for kwargs in ({"a": u, "n": 3}, {"a": u, "n": 3, "s": "x", "extra": 1}, {"a": "nope", "n": 3, "s": "x"}, {"a": u, "n": "3", "s": "x"}, {"a": u, "n": 3, "s": 5}):
            with self.subTest(kwargs=kwargs), self.assertRaises(snapshot.PayloadRefused):
                db_cases.render_sql(t, **kwargs)
        for bad in ("select {{a:uuid}} , {{a:text}};", "select {{a}};", "select {{a:uuid};", "select {{A:uuid}};", 5):
            with self.subTest(bad=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.render_sql(bad, a=u)

    def test_posting_calls_are_rendered_from_typed_literals(self):
        stub = LaunchStub(out="e|t|1|f\n")
        db = db_cases.Db(SCRATCH, run=stub)
        a = str(uuid.uuid4())
        db.call("post_funding", a, 3, "NaN", "AUTH'x", "IDEM-1")
        sql = stub.calls[0][0][-1]
        self.assertEqual(sql, "select event_id, txn_id, version, replayed from drawbridge_auth.post_funding"
                              f"('{a}'::uuid, 3::bigint, 'NaN'::numeric, 'AUTH''x', 'IDEM-1');")
        self.assertEqual(stub.calls[0][1]["env"]["PGOPTIONS"], db_cases.SERIALIZABLE)
        before = len(stub.calls)
        for args in (("post_funding; drop", a, 1, "1", "A", "K"), ("post_funding", "nope", 1, "1", "A", "K"), ("post_funding", a, "1", "1", "A", "K"),
                     ("post_funding", a, 1, "1", "A\\B", "K"), ("other_function", a, 1, "1", "A", "K")):
            with self.subTest(args=args), self.assertRaises(snapshot.PayloadRefused):
                db.call(*args)
        self.assertEqual(len(stub.calls), before)

    def test_seeding_is_two_separately_submitted_units_and_stops_at_the_first_failure(self):
        calls = []
        stub = LaunchStub(script=lambda argv: (calls.append(argv[-1]) or (0, "", "")))
        db_cases.Db(SCRATCH, run=stub).seed_allocation("x")
        self.assertEqual(len(calls), 2)                           # project insert and allocation insert are two units, as `-f -` ran them
        self.assertTrue(calls[0].startswith("insert into drawbridge_auth.project"))
        self.assertTrue(calls[1].startswith("insert into drawbridge_auth.allocation"))
        stub2 = LaunchStub(rc=1, err="ERROR:  23505: x\n")
        with self.assertRaises(db_cases.CaseFailure):
            db_cases.Db(SCRATCH, run=stub2).seed_allocation("y")
        self.assertEqual(len(stub2.calls), 1)                     # the allocation insert was never sent after the project insert failed

class GateADiagnostics(unittest.TestCase):
    VERBOSE = ('ERROR:  23505: duplicate key value violates unique constraint "allocation_event_allocation_version_uk"\n'
               'DETAIL:  Key (allocation_id, version)=(a, 1) already exists.\n'
               'SCHEMA NAME:  drawbridge_auth\nTABLE NAME:  allocation_event\nCONSTRAINT NAME:  allocation_event_allocation_version_uk\n'
               'LOCATION:  _bt_check_unique, nbtinsert.c:666\n')

    def test_fields_come_from_the_verbose_lines_only(self):
        d = db_cases.parse_diagnostic_fields(self.VERBOSE)
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["sqlstate"], "23505")
        self.assertEqual(d[0]["constraint"], "allocation_event_allocation_version_uk")
        self.assertEqual(d[0]["table"], "allocation_event")
        self.assertEqual(d[0]["schema"], "drawbridge_auth")
        self.assertIn("already exists", d[0]["detail"])
        two = db_cases.parse_diagnostic_fields(self.VERBOSE + 'ERROR:  DW422: INVALID_AMOUNT\nDETAIL:  AMOUNT_RANGE\n')
        self.assertEqual([x["sqlstate"] for x in two], ["23505", "DW422"])
        self.assertIsNone(two[1]["constraint"])                # nothing leaks from the first error into the second

    def test_a_sqlstate_is_never_inferred_from_message_text(self):
        for text in ("ERROR:  duplicate key (23505)\n", "ERROR:  2350: short\n", "ERROR:  23505 no colon\n", "ERROR:  2350a: lower-case\n",
                     "FATAL:  28000: role missing\n", "psql: error: connection failed (23505)\n", "ERROR:  \n"):
            with self.subTest(text=text):
                self.assertEqual(db_cases.parse_diagnostic_fields(text), [])
                errors, unparsed = db_cases.parse_diagnostics(text)
                self.assertEqual(errors, [])
                r = db_cases.Result(1, "", text, errors, unparsed)
                with self.assertRaises(db_cases.CaseFailure):
                    r.state

    def test_a_nonzero_exit_without_a_readable_sqlstate_fails_closed(self):
        a = str(uuid.uuid4())
        r = db_cases.Db(SCRATCH, run=LaunchStub(rc=1, err="something odd happened\n")).op("alloc_event_count", a=a)
        self.assertEqual(r.rc, 1)
        with self.assertRaises(db_cases.CaseFailure):
            r.state
        ok = db_cases.Db(SCRATCH, run=LaunchStub(rc=1, err=self.VERBOSE)).op("alloc_event_count", a=a)
        self.assertEqual((ok.state, ok.diagnostics[0]["constraint"]), ("23505", "allocation_event_allocation_version_uk"))

    def test_the_evidence_names_case_database_role_invocation_exit_status_and_hashes(self):
        ev = evidence_tmp()
        a = str(uuid.uuid4())
        db = db_cases.Db(SCRATCH, run=LaunchStub(rc=1, out="o\n", err=self.VERBOSE), evidence_dir=ev)
        db.case_id = "G2C1-DBT-99"
        r = db.op("alloc_event_count", a=a)
        e = r.evidence
        self.assertEqual((e["case"], e["database"], e["role"], e["exit_status"], e["operation"]), ("G2C1-DBT-99", SCRATCH, "g2_scratch_admin", 1, "alloc_event_count"))
        self.assertEqual(e["invocation"][0], str(RUNNER))
        self.assertEqual(e["stdout_sha256"], hashlib.sha256(b"o\n").hexdigest())
        self.assertEqual(e["stderr_sha256"], hashlib.sha256(self.VERBOSE.encode()).hexdigest())
        r2 = db.op("alloc_event_count", a=a)
        self.assertNotEqual(e["stdout"], r2.evidence["stdout"])          # one new evidence file pair per submission
        self.assertTrue(Path(e["stdout"]).name.startswith("G2C1-DBT-99-0001-alloc_event_count"))
        self.assertEqual(len(list(ev.iterdir())), 4)

    def test_the_snapshot_reader_reports_a_sqlstate_only_from_the_verbose_error_line(self):
        for err, want in (("ERROR:  42501: permission denied for view x\n", "42501"), ("psql:<stdin>:1: ERROR:  23505: dup\n", "23505"),
                          ("ERROR:  permission denied (42501)\n", None), ("ERROR:  permission denied for relation 42501 x\n", None),
                          ("ERROR:  4250: short\n", None), ("", None)):
            with self.subTest(err=err), self.assertRaises(snapshot.SnapshotError) as ctx:
                snapshot.fetch_snapshot(SCRATCH, run=LaunchStub(rc=1, err=err))
            self.assertEqual((ctx.exception.exit_status, ctx.exception.sqlstate), (1, want))

    def test_the_psql_default_verbosity_is_never_used(self):
        stub = LaunchStub(out="3\n")
        db_cases.Db(SCRATCH, run=stub).op("alloc_event_count", a=str(uuid.uuid4()))
        self.assertIn("VERBOSITY=verbose", stub.calls[0][0])

class GateAHeldCases(unittest.TestCase):
    HELD = {"G2C1-DBT-01": "EXCLUDED", "G2C1-DBT-24": "EXCLUDED", "G2C1-DBT-15": "DEFERRED", "G2C1-DBT-16": "DEFERRED", "G2C1-DBT-17": "DEFERRED",
            "G2C1-DBT-22": "DEFERRED", "G2C1-DBT-25": "DEFERRED", "G2C1-DBT-23": "GATE-F"}

    def test_all_27_identifiers_are_preserved_and_exactly_the_approved_cases_are_held(self):
        ids = [c.case_id for c in db_cases.CASES]
        self.assertEqual(ids, [f"G2C1-DBT-{n:02d}" for n in range(1, 28)])
        self.assertEqual({c.case_id: c.hold[0] for c in db_cases.CASES if c.hold}, self.HELD)
        self.assertEqual(set(db_cases.HELD), set(self.HELD))
        for c in db_cases.CASES:
            self.assertTrue(callable(c.original), c.case_id)

    def test_a_held_case_refuses_before_any_launch_and_its_function_is_preserved(self):
        for c in db_cases.CASES:
            if not c.hold:
                self.assertIs(c.body, c.original)
                continue
            stub = LaunchStub()
            db = db_cases.Db(SCRATCH, run=stub)
            with self.subTest(c.case_id), mock.patch.object(subprocess, "run", side_effect=AssertionError("held case ran a process")), \
                    mock.patch.object(subprocess, "Popen", side_effect=AssertionError("held case started a process")), self.assertRaises(db_cases.CaseHeld):
                c.body(db)
            self.assertEqual(stub.calls, [])
            self.assertIsNot(c.body, c.original)
            self.assertTrue(hasattr(c.original, "__code__") and c.original.__name__ != "body")

    def test_the_report_states_the_hold_and_run_all_never_reaches_a_database_for_a_held_case(self):
        stub = LaunchStub()
        for held in self.HELD:
            with self.subTest(held), self.assertRaises(db_cases.SelectionRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, cases=held, evidence_dir=evidence_tmp(), run=stub)
        self.assertEqual(stub.calls, [])
        dry = {r["case_id"]: r for r in db_cases.run_all(enabled=False, database=SCRATCH)}
        self.assertEqual({k: v["hold"] for k, v in dry.items() if "hold" in v}, self.HELD)
        self.assertEqual(dry["G2C1-DBT-01"]["hold"], "EXCLUDED")
        self.assertIn("A8 C-2", dry["G2C1-DBT-01"]["reason"])
        self.assertIn("A8 C-3", dry["G2C1-DBT-24"]["reason"])
        self.assertIn("F-1 stays OPEN", dry["G2C1-DBT-25"]["reason"])

    def test_the_streamed_session_helpers_refuse_before_any_launch(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        with self.assertRaises(db_cases.DeferredByN9):
            db_cases.parallel(db, [lambda options: None], db_cases.SERIALIZABLE, 730)
        job = db_cases.gated_call(db, 730, "post_funding", str(uuid.uuid4()), 1, "1.00", "A", "K")
        with self.assertRaises(snapshot.PayloadRefused):          # free-form SQL with psql variables: never accepted
            job(db_cases.SERIALIZABLE)
        self.assertEqual(stub.calls, [])
        self.assertEqual(functions_containing(DB_CASES_PY, lambda n: isinstance(n, ast.Attribute) and n.attr == "Popen"),
                         ["parallel", "rollback_and_client_crash"])      # the only streamed users; each starts with db.command, which refuses

    def test_dbt_01_is_excluded_so_migration_0011_is_never_repeated(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        body = next(c.body for c in db_cases.CASES if c.case_id == "G2C1-DBT-01")
        with self.assertRaises(db_cases.CaseHeld):
            body(db)
        report = db_cases.run_all(enabled=False, database=SCRATCH)
        self.assertEqual(next(r for r in report if r["case_id"] == "G2C1-DBT-01")["status"], "NOT RUN")
        self.assertEqual(stub.calls, [])

    def test_f1_stays_open_and_the_retry_allowlist_is_unchanged(self):
        self.assertEqual(hashlib.sha256((G2DB / "ledger" / "retry.py").read_bytes()).hexdigest(), RETRY_BASELINE_SHA256)
        self.assertEqual(sorted(retry.RETRIABLE_UNIQUE_CONSTRAINTS),
                         ["allocation_event_allocation_version_uk", "journal_txn_idempotency_key_uk", "journal_txn_posting_identity_uk"])
        self.assertNotIn("journal_account_name_uk", retry.RETRIABLE_UNIQUE_CONSTRAINTS)
        self.assertEqual(db_cases.f1_verdict("23505", 'duplicate key value violates unique constraint "journal_account_name_uk"'),
                         "F1_CONFIRMED_OWNER_DECISION_REQUIRED")
        summary = db_cases.summarize_f1([{"overlap": "NOT_OBSERVED", "verdicts": []}, {"overlap": "NOT_OBSERVED", "verdicts": []}])
        self.assertEqual(summary["conclusion"], "INCONCLUSIVE")        # DBT-25 records overlap and a PASS/FAIL/FINDING/INCONCLUSIVE conclusion


class GateASixCallSites(unittest.TestCase):
    class Stop(Exception):
        pass

    def test_site_3_and_4_dbt_01_direct_runner_commands(self):
        sha = hashlib.sha256((ROOT / "db/migrations/0011_g2c1_funding_ledger.sql").read_bytes()).hexdigest()
        seen = []

        def script(argv):
            seen.append(argv)
            if argv[1] == "migrate-0011":
                return (7, "", "REFUSED: already recorded") if argv[3] == sha else (3, "", "REFUSED: not the owner-approved hash")
            raise self.Stop()
        original = next(c.original for c in db_cases.CASES if c.case_id == "G2C1-DBT-01")
        with self.assertRaises(db_cases.UnregisteredSql):      # after the two runner launches the case's free-form SQL is refused (the case is also EXCLUDED)
            original(db_cases.Db(SCRATCH, run=LaunchStub(script=script), evidence_dir=None))
        self.assertEqual(seen[0], [str(RUNNER), "migrate-0011", SCRATCH, sha])
        self.assertEqual(seen[1], [str(RUNNER), "migrate-0011", SCRATCH, "0" * 64])
        self.assertEqual(len(seen), 2)

    def test_site_5_dbt_23_direct_runner_commands(self):
        seen = []
        snap = json.dumps({"txn_read_only": "on", "txn_isolation": "repeatable read", "events": [], "balances": [], "reconciliation": []})

        def script(argv):
            seen.append(argv)
            if argv[1] == "psql" and "jsonb_build_object" in argv[-1]:
                return (0, snap, "")
            if argv[1] == "psql":
                return (0, "e|t|1|f\n", "")
            raise self.Stop()
        original = next(c.original for c in db_cases.CASES if c.case_id == "G2C1-DBT-23")
        with self.assertRaises(snapshot.CommandRefused):       # `stop` is a cluster-control command: refused by the launch boundary before any launch
            original(db_cases.Db(SCRATCH, run=LaunchStub(script=script)))
        self.assertTrue(all(a[1] != "stop" for a in seen))

    def test_site_6_dbt_24_uses_the_direct_launcher_and_is_unreachable(self):
        tree = ast.parse(DB_CASES_PY.read_text(encoding="utf-8"))
        fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "runtime_safety")
        calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "runner"]
        self.assertEqual([[a.value for a in c.args if isinstance(a, ast.Constant)] for c in calls], [["identity"]])
        self.assertEqual(next(c.hold[0] for c in db_cases.CASES if c.case_id == "G2C1-DBT-24"), "EXCLUDED")

    def test_no_interpreter_shell_or_stdin_stream_remains_in_the_two_modules(self):
        for path in (DB_CASES_PY, SNAPSHOT_PY):
            consts = [c for _, c in string_constants(path)]
            for banned in ("/bin/bash", "/usr/bin/bash", "bash", "sh", "/bin/sh", "-f"):
                self.assertNotIn(banned, consts, (path.name, banned))
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.keyword) and node.arg == "shell":
                    self.fail(f"{path.name}: a shell= argument appears")
                if isinstance(node, ast.Attribute) and node.attr in ("system", "popen") and getattr(node.value, "id", "") == "os":
                    self.fail(f"{path.name}: os.{node.attr}")

    def test_every_launch_in_the_modules_goes_through_the_shared_launcher_or_the_deferred_streams(self):
        self.assertEqual(functions_containing(SNAPSHOT_PY, lambda n: isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("run", "Popen")
                                              and getattr(n.func.value, "id", "") == "subprocess"),
                         [])        # snapshot.py only names subprocess.run as the DEFAULT of the injectable `run` parameter; it never calls subprocess directly
        direct = functions_containing(DB_CASES_PY, lambda n: isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("run", "Popen")
                                      and getattr(n.func.value, "id", "") == "subprocess")
        # parallel (the streamed lock holder) and DBT-22 (pkill) are DEFERRED and start with db.command, which refuses; DBT-24 (ps, ls; snapshot_old is nested)
        # is EXCLUDED; none is reachable through CASES
        self.assertEqual(direct, ["parallel", "rollback_and_client_crash", "runtime_safety", "snapshot_old"])


class GateAPreservation(unittest.TestCase):
    def test_the_runner_and_migration_bytes_are_the_approved_ones(self):
        self.assertEqual(hashlib.sha256(RUNNER.read_bytes()).hexdigest(), RUNNER_PIN)
        self.assertEqual(hashlib.sha256(MIGRATION.read_bytes()).hexdigest(), MIGRATION_PIN)
        self.assertEqual(MIGRATION.stat().st_size, 43067)

    def test_the_serializable_requirement_and_isolation_options_are_unchanged(self):
        self.assertEqual(db_cases.SERIALIZABLE, "-c default_transaction_isolation=serializable")
        self.assertEqual(db_cases.READ_COMMITTED, "-c default_transaction_isolation=read\\ committed")
        self.assertEqual(db_cases.INJECT_DB_PREFIX, "drawbridge_g2_scratch_inject")


class GateARunnerBehaviour(unittest.TestCase):
    """V06 mutation gaps M41, M05 and M37, tested BEHAVIOURALLY by running the committed runner text (a copy in a throwaway tree, with the
    cluster stub of HashToApplyCluster). The tests redirect the runner's tool directory to a directory of recording wrappers (this edits one
    line of the COPY; the committed runner is not changed). What each test does NOT show is stated beside it."""
    TOOLS = "env cat sha256sum cut wc realpath basename dirname id grep head readlink ls mkdir chmod timeout python3".split()

    def tools(self, tmp: Path, swap: Path | None = None):
        d = tmp / "tooldir"
        d.mkdir()
        log = tmp / "toollog"
        log.mkdir()
        for name in self.TOOLS:
            if name == "env":
                (d / name).symlink_to("/usr/bin/env")          # the wiper itself: it starts before the wipe, by construction
                continue
            extra = ""
            if name == "python3":
                extra = ('n=0; [ -e $d/pycount ] && read -r n < $d/pycount; n=$((n+1)); echo $n > $d/pycount\n'
                         'i=0; for a in "$@"; do printf \'%s\' "$a" > "$d/py.$n.$i"; i=$((i+1)); done; echo $i > "$d/py.$n.argc"\n')
            tail = f'exec /usr/bin/{name} "$@"'
            if name == "sha256sum" and swap is not None:
                # rewrite the preflight file on disk immediately AFTER the runner's last verification step, so that any later read of that path would
                # see bytes other than the verified ones
                tail = (f'/usr/bin/sha256sum "$@"; rc=$?; case " $* " in *"{swap}"*) printf \'print("{"0" * 64}")\\n\' > "{swap}" ;; esac; exit $rc')
            (d / name).write_text(f"#!/usr/bin/bash\nd={log}; echo {name} >> $d/called; export -p > \"$d/env.{name}.$$\"\n{extra}{tail}\n")
            (d / name).chmod(0o555)
        d.chmod(0o555)
        return d, log

    def cluster(self, tmp: Path, swap: Path | None = None, mutate=None):
        d, log = self.tools(tmp, swap)
        text = RUNNER.read_text(encoding="utf-8")
        self.assertEqual(text.count("readonly TRUSTED_TOOL_DIR=/usr/bin"), 1)
        text = text.replace("readonly TRUSTED_TOOL_DIR=/usr/bin", f"readonly TRUSTED_TOOL_DIR={d}")
        if mutate:
            text = mutate(text)
        return HashToApplyCluster(tmp, runner_text=text), log

    @staticmethod
    def called(log):
        return sorted(set((log / "called").read_text().split())) if (log / "called").exists() else []

    @staticmethod
    def leaking(log):
        return sorted({p.name.split(".")[1] for p in log.glob("env.*") if "G2C1_TEST_LEAK" in p.read_text()})

    def test_m41_a_pin_that_differs_from_the_corpus_digest_is_refused_with_exit_5(self):
        with short_tmp() as tmp:
            c = HashToApplyCluster(Path(tmp))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)                       # control: the matching pin is accepted
            self.assertIn("fixture hash matches pin", done.stdout + done.stderr)
        for label, pin in (("all zero", "0" * 64),) + tuple((f"one character at {pos}", None) for pos in (0, 31, 63)):
            with short_tmp() as tmp:
                c = HashToApplyCluster(Path(tmp))
                good = runner_table()["corpus"]
                if pin is None:
                    pos = int(label.split()[-1])
                    pin_value = good[:pos] + ("0" if good[pos] != "0" else "1") + good[pos + 1:]
                else:
                    pin_value = pin
                c.hook("pin", pin_value + "\n")
                done = c.run("migrate-base", APPROVED_DB)
                with self.subTest(label):
                    self.assertEqual(done.returncode, 5, done.stderr)
                    self.assertNotIn("fixture hash matches pin", done.stdout + done.stderr)
                    self.assertIn("differs from pinned", done.stderr)

    def test_m05_the_preflight_is_executed_from_the_verified_text_not_from_its_path(self):
        with short_tmp() as tmp:
            c, log = self.cluster(Path(tmp))
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            preflight = Path(tmp) / PREFLIGHT_REL
            forms = []
            for argc_file in sorted(log.glob("py.*.argc")):
                n = argc_file.name.split(".")[1]
                forms.append([(log / f"py.{n}.{i}").read_bytes().decode() for i in range(int(argc_file.read_text()))])
            isolated = [a for a in forms if a[:1] == ["-I"]]
            self.assertEqual(len(isolated), 1, forms)
            self.assertEqual(isolated[0][1], "-c")
            self.assertEqual(isolated[0][2].encode(), preflight.read_bytes())       # the bytes handed to the interpreter are the verified bytes
            self.assertNotIn(str(preflight), isolated[0])                            # and no argument names the preflight file's path

    def test_m05_a_rewrite_of_the_preflight_after_the_last_verification_step_does_not_change_what_runs(self):
        """Deterministic swap (A9-ADD-2): a wrapper rewrites the preflight file after the runner's final verification of it. The approved runner
        executes the text it already verified and proceeds; a runner that re-reads the path (or runs it from its path) would run the rewritten file
        and fail. NOT shown: a swap by a genuinely concurrent process, and the hash-then-use window of check_runner; those remain residual limits."""
        with short_tmp() as tmp:
            pre = Path(tmp) / PREFLIGHT_REL
            c, log = self.cluster(Path(tmp), swap=pre)
            done = c.run("migrate-base", APPROVED_DB)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("fixture hash matches pin", done.stdout + done.stderr)
            self.assertNotEqual(pre.read_bytes(), (ROOT / PREFLIGHT_REL).read_bytes())          # the swap really happened on disk

    def test_m37_every_utility_the_runner_starts_sees_a_wiped_environment(self):
        """Every tool wrapped by _tool, on each command the thirteen cases and the evidence procedure can reach (psql, identity) and on migrate-base.
        NOT shown: tools the runner starts outside _tool (psql and env launches use their own explicit env -i forms)."""
        commands = {"migrate-base": (("migrate-base", APPROVED_DB), {"basename", "cat", "cut", "dirname", "id", "python3", "realpath", "sha256sum", "timeout", "wc"}),
                    "psql": (("psql", APPROVED_DB, "authority_svc", "-At", "-c", "select 1;"), {"dirname", "id", "realpath"}),
                    "identity": (("identity",), {"dirname", "id", "realpath"})}
        for label, (argv, expected) in commands.items():
            with short_tmp() as tmp, self.subTest(label):
                c, log = self.cluster(Path(tmp))
                done = c.run(*argv, env={"G2C1_TEST_LEAK": "marker-value", "G2C1_OTHER": "x"})
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertTrue(expected <= set(self.called(log)), (expected, self.called(log)))
                self.assertEqual(self.leaking(log), [])
                for dump in log.glob("env.*"):
                    self.assertNotIn("G2C1_OTHER", dump.read_text(), dump.name)
                    self.assertIn("PATH", dump.read_text())

    def test_m37_losing_env_i_for_any_single_reachable_tool_is_detected(self):
        """The nine-tool claim of the supplemental review, tested per tool with a mutant of the _tool wrapper that skips env -i for ONE tool."""
        old = '_tool() { local t="$1"; shift; "$TRUSTED_TOOL_DIR/env" -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$TRUSTED_TOOL_DIR/$t" "$@"; }'
        self.assertEqual(RUNNER.read_text(encoding="utf-8").count(old), 1)
        reachable = {"migrate-base": ("migrate-base", APPROVED_DB), "psql": ("psql", APPROVED_DB, "authority_svc", "-At", "-c", "select 1;")}
        for command, argv in reachable.items():
            with short_tmp() as tmp:
                c, log = self.cluster(Path(tmp))
                c.run(*argv)
                tools = [x for x in self.called(log)]
            self.assertTrue(tools)
            for tool in tools:
                new = '_tool() { local t="$1"; shift; if [ "$t" = %s ]; then "$TRUSTED_TOOL_DIR/$t" "$@"; else "$TRUSTED_TOOL_DIR/env" -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$TRUSTED_TOOL_DIR/$t" "$@"; fi; }' % tool
                with short_tmp() as tmp, self.subTest(command=command, tool=tool):
                    c, log = self.cluster(Path(tmp), mutate=lambda text: text.replace(old, new))
                    done = c.run(*argv, env={"G2C1_TEST_LEAK": "marker-value"})
                    self.assertEqual(done.returncode, 0, done.stderr)
                    self.assertEqual(self.leaking(log), [tool])               # the mutant leaks exactly the one tool it was given


class GateACaseConversions(unittest.TestCase):
    """The converted submission shapes, exercised end to end through the real Db, validator and launcher with a SCRIPTED stub. These show the
    harness logic and the payload shapes; they say nothing about PostgreSQL behaviour (nothing here connects to a database)."""

    def run_case(self, case_id, script):
        stub = LaunchStub(script=script)
        case = next(c for c in db_cases.CASES if c.case_id == case_id)
        db = db_cases.Db(SCRATCH, run=stub)
        db.case_id = case_id
        case.body(db)
        return stub

    @staticmethod
    def sql_of(argv):
        return argv[-1] if "-c" in argv else ""

    def test_dbt_08_invalid_inputs_are_sent_to_the_function_as_typed_literals(self):
        def script(argv):
            sql = self.sql_of(argv)
            if "nullif(" in sql and "::numeric" in sql:
                return (3, "", "ERROR:  DW422: INVALID_AMOUNT\n")
            if "post_funding(" in sql and "1.00, " in sql and "nullif" not in sql and "select * from" in sql:
                return (3, "", "ERROR:  DW422: INVALID_REFERENCE\n")
            if "'100000000000.00'" in sql:
                return (3, "", "ERROR:  DW422: INVALID_AMOUNT\n")
            if "count(*) from drawbridge_auth.allocation_event" in sql:
                return (0, "0\n", "")
            return (0, "e|t|1|f\n", "")
        stub = self.run_case("G2C1-DBT-08", script)
        sent = [self.sql_of(a) for a, _ in stub.calls]
        self.assertTrue(any("nullif('NaN', '')::numeric" in s for s in sent))          # an out-of-grammar amount reaches the function, quoted
        self.assertTrue(any("'unié'" in s for s in sent))                                # so does an out-of-grammar reference
        self.assertTrue(any("'tab\there'" in s for s in sent))
        for s in sent:
            snapshot.validate_sql_payload(s)
            self.assertNotRegex(s, r"(?<!:):['\"a-z_]")                                    # no psql variable reference survives

    def test_dbt_11_12_explicit_transaction_blocks_are_registered_whole_and_keep_their_outcome(self):
        def script(argv):
            sql = self.sql_of(argv)
            if sql.startswith("begin;"):
                if "event_kind" in sql:
                    return (3, "", "ERROR:  23514: event version is not contiguous\n")
                return (3, "", "ERROR:  23514: journal imbalance\n")
            if "count(*) from drawbridge_auth.journal_txn" in sql:
                return (0, "0\n", "")
            return (0, "e|t|1|f\n", "")
        for cid in ("G2C1-DBT-11", "G2C1-DBT-12"):
            with self.subTest(cid):
                stub = self.run_case(cid, script)
                blocks = [self.sql_of(a) for a, _ in stub.calls if self.sql_of(a).startswith("begin;")]
                self.assertTrue(blocks)
                for b in blocks:
                    self.assertGreater(len(snapshot._scan(b)), 1)                         # one explicit BEGIN ... COMMIT unit per submission
                    self.assertTrue(b.rstrip().endswith("commit;"))
        self.assertEqual(len([1 for a, _ in stub.calls if self.sql_of(a).startswith("begin;")]), 4)    # DBT-12's four variants
        # DBT-13 (not selectable) still holds free-form SQL: it fails closed at its first free-form submission
        body = next(c.original for c in db_cases.CASES if c.case_id == "G2C1-DBT-13")
        with self.assertRaises(db_cases.UnregisteredSql):
            body(db_cases.Db(SCRATCH, run=LaunchStub(out="e|t|1|f\n")))

    def test_selectable_cases_use_only_registered_operations_and_the_registry_renders_and_validates(self):
        expected = {"G2C1-DBT-02": {"alloc_counts", "alloc_legs", "alloc_balances"}, "G2C1-DBT-03": {"alloc_cash_balance", "alloc_reduction_legs"},
                    "G2C1-DBT-04": {"alloc_event_count"}, "G2C1-DBT-05": {"alloc_event_count"}, "G2C1-DBT-06": set(), "G2C1-DBT-07": set(),
                    "G2C1-DBT-08": {"alloc_event_count", "probe_amount", "probe_reference"}, "G2C1-DBT-11": {"contiguity_block"},
                    "G2C1-DBT-12": {"alloc_header_count", "seed_accounts", "txn_block_one_leg", "txn_block_two_legs"},
                    "G2C1-DBT-14": {"catalog_lint", "exec_privilege", "probe_reader_post", "public_exec_count"}, "G2C1-DBT-18": {"ledger_totals"},
                    "G2C1-DBT-19": set(), "G2C1-DBT-20": set()}
        self.assertEqual(set(expected), set(db_cases.SELECTABLE))
        tree = ast.parse(DB_CASES_PY.read_text(encoding="utf-8"))
        funcs = {}
        for n in tree.body:
            if isinstance(n, ast.FunctionDef):
                for d in n.decorator_list:
                    if isinstance(d, ast.Call) and getattr(d.func, "id", "") == "case":
                        funcs[d.args[0].value] = n
        for cid, want in expected.items():
            fn = funcs[cid]
            used = {c.value for c in ast.walk(fn) if isinstance(c, ast.Constant) and isinstance(c.value, str) and c.value in db_cases.OPERATIONS}
            free = [c.func.attr for c in ast.walk(fn) if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and isinstance(c.func.value, ast.Name)
                    and c.func.value.id == "db" and c.func.attr in ("run", "admin", "scalar", "run_units")]
            with self.subTest(cid):
                self.assertEqual(used, want)
                self.assertEqual(free, [])                      # no free-form SQL call remains in a selectable case
        samples = {"uuid": lambda: str(uuid.uuid4()), "int": lambda: 1, "text": lambda: "x", "numeric": lambda: "5.00", "fn": lambda: "post_funding",
                   "role": lambda: "authority_svc", "account": lambda: "CASH_ALLOCATED", "dir": lambda: "D"}
        for name, op in db_cases.OPERATIONS.items():
            params = {n: samples[k]() for n, k in db_cases.MARKER_RE.findall(op.template)}
            with self.subTest(op=name):
                rendered_op, payload = db_cases.render_operation(name, **params)
                self.assertIs(rendered_op, op)
                self.assertEqual(len(snapshot._scan(payload)), op.statements)
                self.assertIn(op.role, snapshot.PSQL_ROLES)
        with self.assertRaises(db_cases.UnknownOperation):
            db_cases.render_operation("select_anything", a="x")
        with self.assertRaises(TypeError):
            db_cases.OPERATIONS["new"] = None                    # the registry is read-only

    def test_the_injection_fault_sql_builders_are_refused_as_single_payloads_and_are_not_converted_in_gate_a(self):
        # fault_install_sql/fault_remove_sql hold several statements WITHOUT explicit transaction boundaries; the old `-f -` ran each on its own.
        # Converting them means separate units, which belongs with the injection cases (Gate E, injection database not authorized): recorded, not converted.
        for fault in db_cases.FAULT_TRIGGERS:
            for build in (db_cases.fault_install_sql, db_cases.fault_remove_sql):
                with self.subTest(fault=fault, build=build.__name__), self.assertRaises(snapshot.PayloadRefused):
                    snapshot.validate_sql_payload(build(fault))
        sql, _ = db_cases.injected_txn_sql(str(uuid.uuid4()), "T", [("CASH_ALLOCATED", "D", "5.00"), ("PROJECT_CAPITAL", "C", "4.00")], "5.00")
        snapshot.validate_sql_payload(sql)                                  # the explicit-transaction injection unit is accepted


# ======================================================================================================================================
# A9 V02 (SIM-ENG-003-G2C1-A9): case selection, the closed SQL operation registry, target boundaries, diagnostic contradictions and the fresh
# test workspace. Offline only: stub process runners, no database, no PostgreSQL, no SQL. Developer regression tests, NOT independent
# acceptance (A8 C-1 narrow exception): LOOM-2 inspects every material assertion and builds its own negative tests and mutants.
# ======================================================================================================================================
import types

HELD_IDS = ("G2C1-DBT-01", "G2C1-DBT-24", "G2C1-DBT-15", "G2C1-DBT-16", "G2C1-DBT-17", "G2C1-DBT-22", "G2C1-DBT-25", "G2C1-DBT-23")
NOT_SELECTABLE_IDS = HELD_IDS + ("G2C1-DBT-09", "G2C1-DBT-10", "G2C1-DBT-13", "G2C1-DBT-21", "G2C1-DBT-26", "G2C1-DBT-27")
THIRTEEN = ("G2C1-DBT-02", "G2C1-DBT-03", "G2C1-DBT-04", "G2C1-DBT-05", "G2C1-DBT-06", "G2C1-DBT-07", "G2C1-DBT-08", "G2C1-DBT-11", "G2C1-DBT-12",
            "G2C1-DBT-14", "G2C1-DBT-18", "G2C1-DBT-19", "G2C1-DBT-20")


class A9CaseSelector(unittest.TestCase):
    def test_the_selectable_maximum_is_exactly_the_thirteen_and_excludes_every_held_case(self):
        self.assertEqual(db_cases.SELECTABLE, THIRTEEN)
        self.assertEqual(len(set(db_cases.SELECTABLE)), 13)
        self.assertFalse(set(db_cases.SELECTABLE) & set(HELD_IDS))
        self.assertEqual([c.case_id for c in db_cases.CASES], [f"G2C1-DBT-{n:02d}" for n in range(1, 28)])      # every identifier preserved

    def test_valid_selections_are_returned_in_canonical_order_never_command_line_order(self):
        self.assertEqual(db_cases.validate_selection("G2C1-DBT-02"), ("G2C1-DBT-02",))
        self.assertEqual(db_cases.validate_selection("G2C1-DBT-20,G2C1-DBT-02,G2C1-DBT-11"), ("G2C1-DBT-02", "G2C1-DBT-11", "G2C1-DBT-20"))
        self.assertEqual(db_cases.validate_selection(list(reversed(THIRTEEN))), THIRTEEN)
        self.assertEqual(db_cases.validate_selection(tuple(THIRTEEN)), THIRTEEN)

    def test_every_invalid_selection_refuses_the_whole_invocation(self):
        bad = [None, "", ",", "G2C1-DBT-02,", ",G2C1-DBT-02", "G2C1-DBT-02,,G2C1-DBT-03", "g2c1-dbt-02", "DBT-02", "G2C1-DBT-2", "G2C1-DBT-002", "G2C1-DBT-00",
               "G2C1-DBT-28", " G2C1-DBT-02", "G2C1-DBT-02 ", "G2C1-DBT-*", "G2C1-DBT-02;G2C1-DBT-03", "G2C1-DBT-02\nG2C1-DBT-03", "G2C1-DBT-0٢",
               "G2C1-DBT-02,G2C1-DBT-02", ["G2C1-DBT-02", "G2C1-DBT-02"], [], (), ["G2C1-DBT-02", 3], [None], [b"G2C1-DBT-02"], 5, b"G2C1-DBT-02", {"G2C1-DBT-02"},
               "all", "ALL", "*"]
        bad += [i for i in NOT_SELECTABLE_IDS]
        bad += [f"G2C1-DBT-02,{i}" for i in NOT_SELECTABLE_IDS]            # a valid ID next to an unauthorized one: the whole command is refused
        for sel in bad:
            with self.subTest(sel=sel), self.assertRaises(db_cases.SelectionRefused):
                db_cases.validate_selection(sel)

    def test_an_enabled_run_without_a_selection_never_defaults_to_all_cases_and_never_launches(self):
        for cases in (None, "", [], "G2C1-DBT-09", "G2C1-DBT-02,G2C1-DBT-01", "nonsense"):
            stub = LaunchStub()
            ev = evidence_tmp()
            with self.subTest(cases=cases), self.assertRaises(db_cases.SelectionRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, cases=cases, evidence_dir=ev, run=stub)
            self.assertEqual(stub.calls, [])
            self.assertEqual(list(ev.iterdir()), [])               # not even the selection manifest is written for a refused selection

    def test_the_selection_manifest_is_hashed_and_written_before_the_first_case_runs(self):
        ev = evidence_tmp()
        seen = []
        original = db_cases.CASES[:]
        try:
            db_cases.CASES[:] = [db_cases.Case(c.case_id, c.criteria, c.title, (lambda cid: lambda db: seen.append((cid, sorted(x.name for x in ev.iterdir()))))(c.case_id),
                                               c.inject, c.hold, c.original) for c in original]
            report = db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-05,G2C1-DBT-03", evidence_dir=ev, run=LaunchStub(), approved_source=approved_source_table())
        finally:
            db_cases.CASES[:] = original
        self.assertEqual([s[0] for s in seen], ["G2C1-DBT-03", "G2C1-DBT-05"])                       # canonical order
        for _, files in seen:
            self.assertEqual(files, ["selection.json", "selection.json.sha256"])                     # present before any case body
        by = {r["case_id"]: r for r in report}
        self.assertEqual({k for k, v in by.items() if v["status"] == "PASS"}, {"G2C1-DBT-03", "G2C1-DBT-05"})
        self.assertEqual(by["G2C1-DBT-02"]["reason"], "not selected")
        self.assertEqual(by["G2C1-DBT-01"]["status"], "NOT RUN")
        doc = json.loads((ev / "selection.json").read_text())
        digest = hashlib.sha256((ev / "selection.json").read_bytes()).hexdigest()
        self.assertEqual((ev / "selection.json.sha256").read_text(), f"{digest}  selection.json\n")
        self.assertEqual(doc["selected"], ["G2C1-DBT-03", "G2C1-DBT-05"])
        self.assertEqual((doc["database"], doc["runner_sha256"], doc["selectable_maximum"]), (SCRATCH, RUNNER_PIN, list(THIRTEEN)))
        self.assertEqual(doc["registry_sha256"], db_cases.registry_digest())

    def test_the_dispatch_boundary_refuses_a_case_outside_the_plan_a_held_case_and_a_non_selectable_case(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        case = {c.case_id: c for c in db_cases.CASES}
        called = []
        probe = db_cases.Case("G2C1-DBT-02", "x", "x", lambda d: called.append(1), False, None, None)
        for c, plan in ((probe, ()), (probe, ("G2C1-DBT-03",)), (case["G2C1-DBT-01"], ("G2C1-DBT-01",)), (case["G2C1-DBT-09"], ("G2C1-DBT-09",)),
                        (case["G2C1-DBT-25"], ("G2C1-DBT-25",))):
            with self.subTest(case=c.case_id, plan=plan), self.assertRaises(db_cases.SelectionRefused):
                db_cases.dispatch_case(c, db, plan)
        self.assertEqual((called, stub.calls), ([], []))
        db_cases.dispatch_case(probe, db, ("G2C1-DBT-02",))
        self.assertEqual(called, [1])

    def test_conflicting_options_and_the_command_line_refuse_before_any_launch(self):
        def go(argv, env=None):
            err, out = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, env or {}, clear=False), contextlib.redirect_stderr(err), contextlib.redirect_stdout(out), \
                    mock.patch.object(subprocess, "run", side_effect=AssertionError("a process was started")), mock.patch.object(subprocess, "Popen", side_effect=AssertionError("a process was started")):
                return db_cases.main(argv), out.getvalue(), err.getvalue()
        tok = {db_cases.ENABLE_ENV: db_cases.ENABLE_VALUE}
        ev = str(evidence_tmp())
        for argv in (["--db", SCRATCH, "--enable", "--evidence-dir", ev], ["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02", "--inject-db", "drawbridge_g2_scratch_inject_01"],
                     ["--db", SCRATCH, "--cases", "G2C1-DBT-02", "--inject-db", "drawbridge_g2_scratch_inject_01"], ["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-01", "--evidence-dir", ev],
                     ["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02,G2C1-DBT-09", "--evidence-dir", ev], ["--db", SCRATCH, "--enable", "--cases", "", "--evidence-dir", ev],
                     ["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02,G2C1-DBT-02", "--evidence-dir", ev]):
            with self.subTest(argv=argv):
                rc, out, err = go(argv, tok)
                self.assertEqual(rc, 2, (out, err))
                self.assertEqual(out, "")
        self.assertEqual(list(Path(ev).iterdir()), [])


class A9TargetBoundary(unittest.TestCase):
    def test_the_database_cannot_be_reassigned_and_a_forced_change_is_still_refused_by_the_launch_boundary(self):
        stub = LaunchStub(out="3\n")
        db = db_cases.Db(SCRATCH, run=stub)
        with self.assertRaises(AttributeError):
            db.database = "drawbridge_g2_dev"
        self.assertEqual(db.database, SCRATCH)
        db._database = "drawbridge_g2_dev"                          # deliberate attribute tampering: launch_runner validates the target itself
        with self.assertRaises(snapshot.TargetRefused):
            db.op("alloc_event_count", a=str(uuid.uuid4()))
        with self.assertRaises(snapshot.TargetRefused):
            db.runner("migrate-0011", "drawbridge_g2_dev", "0" * 64)
        self.assertEqual(stub.calls, [])

    def test_launch_runner_validates_command_target_role_and_arguments_by_itself(self):
        good_sql = snapshot.RegisteredCall("post_call", dict(fn="post_funding", alloc=str(uuid.uuid4()), ver=1, amt="1.00", auth="AUTH-1", key="KEY-1"))
        for ok in (["identity"], ["status"], ["psql", SCRATCH, "authority_svc", "-At", "-c", good_sql], ["migrate-0011", SCRATCH, "0" * 64], ["migrate-base", SCRATCH], ["bootstrap", SCRATCH]):
            stub = LaunchStub()
            snapshot.launch_runner(ok, run=stub, label="t-ok")
            self.assertEqual(len(stub.calls), 1, ok)
        bad = [["psql", "drawbridge_g2_dev", "authority_svc", "-c", good_sql], ["psql", "drawbridge_g2_scratch_inject_01", "authority_svc", "-c", good_sql],
               ["psql", SCRATCH, "postgres", "-c", good_sql], ["psql", SCRATCH, "drawbridge_owner", "-c", good_sql], ["psql", SCRATCH, "authority_svc", "-f", "-"],
               ["psql", SCRATCH, "authority_svc", "-At"], ["psql", SCRATCH, "authority_svc", "-h", "x", "-c", good_sql], ["psql", SCRATCH, "authority_svc", "-d", "x", "-c", good_sql],
               ["psql", SCRATCH, "authority_svc", "-v", "x=a\\b", "-c", good_sql], ["psql", SCRATCH, "authority_svc", "-F", "x" * 9, "-c", good_sql],
               ["psql", SCRATCH, "authority_svc", "-c"], ["psql", SCRATCH, "authority_svc", "-c", ""], ["psql", SCRATCH, "authority_svc", "-c", "select 1;"], ["psql", SCRATCH, "g2_scratch_admin", "-c", good_sql],
               ["psql", SCRATCH, "authority_svc", "-c", good_sql, "-c", good_sql], ["psql", SCRATCH], ["psql"],
               ["migrate-0011", SCRATCH], ["migrate-0011", "drawbridge_g2_dev", "0" * 64], ["migrate-0011", SCRATCH, "xyz"], ["migrate-base", "drawbridge_g2_dev"],
               ["bootstrap", "postgres"], ["bootstrap"], ["identity", "x"], ["status", SCRATCH], ["init"], ["start"], ["stop"], ["crash-stop"], ["crash-kill"],
               ["frobnicate"], ["psql "], ["PSQL", SCRATCH, "authority_svc", "-c", good_sql], [], "psql", None, ["psql", 5]]
        for argv in bad:
            stub = LaunchStub()
            with self.subTest(argv=argv), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(argv, run=stub, label="t-bad")
            self.assertEqual(stub.calls, [])
        stub = LaunchStub()
        snapshot.launch_runner(["stop"], run=stub, label="t-ctl", allow_control=True)           # only by an explicit authorization that no selectable case passes
        self.assertEqual(len(stub.calls), 1)
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["psql", "drawbridge_g2_scratch_inject_01", "authority_svc", "-c", good_sql], run=LaunchStub(), label="t-inj")
        snapshot.launch_runner(["psql", "drawbridge_g2_scratch_inject_01", "authority_svc", "-c", good_sql], run=LaunchStub(), label="t-inj2", allow_injection=True)

    def test_db_runner_refuses_cluster_control_commands(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        for cmd in ("init", "start", "stop", "crash-stop", "crash-kill", "frobnicate"):
            with self.subTest(cmd), self.assertRaises(snapshot.LaunchRefused):
                db.runner(cmd)
        db.runner("identity")
        self.assertEqual(len(stub.calls), 1)

    def test_no_database_capable_path_exists_outside_launch_runner(self):
        self.assertEqual(functions_containing(DB_CASES_PY, lambda n: isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "launch_runner"),
                         ["_submit", "runner"])
        self.assertEqual(functions_containing(SNAPSHOT_PY, lambda n: isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "plan_runner_command"),
                         ["classify_runner_command", "launch_runner"])


class A9SqlRegistryAndLexer(unittest.TestCase):
    HOSTILE = ("select 1 as €$$; delete from drawbridge_auth.allocation_event; select 1 as €$$;",
               "begin; select 1 as €$a$; commit; delete from t; select 1 as €$a$; commit;",
               "select 1 as  $$; delete from t; select 1 as  $$;", "select 1 as \U0001f600$$; delete from t; select 1 as \U0001f600$$;",
               "select 1 as x$$; delete from t; select 1 as x$$;", "select 1 as x$a$; delete from t; select 1 as x$a$;", "select 1 as é$tag$; delete from t; select 1 as é$tag$;",
               "select $é$a;b$é$;", "select 1; delete from t;", "select $a$x$b$y$a$z$b$; delete from t;", "select 1 as a$$$; delete from t; select 1 as b$$$;",
               "select 1 as a$$$x; delete from t; select 1 as b$$$x;", "select a$$$ ; delete from t; select $$ x$$ ;", "select 1 as a$$$; delete from t; select $$;", "begin; select 1; commit; select 2;",
               "select 1 -- \n; delete from t", "select /* ; */ 1; delete from t;", "select 'a'; select 'b';", "select ∅;", "select U&'\\0041';", "select E'\\x41';")

    def test_the_reported_non_ascii_dollar_tag_payloads_and_their_relatives_are_refused(self):
        for sql in self.HOSTILE:
            with self.subTest(sql=sql), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(sql)

    def test_non_ascii_is_accepted_only_inside_quotes_and_comments(self):
        for sql in ("select '∅€\U0001f600';", "select 1 -- €\n;", "select /* €$$ */ 1;", 'select "a" from t where x = \'é\';'):
            with self.subTest(sql=sql):
                self.assertEqual(snapshot.validate_sql_payload(sql), sql)

    def test_unicode_quote_comment_semicolon_newline_and_delimiter_variants(self):
        refused = ["select 'x;", "select 'x'';", 'select "x;', "select /* x", "select /* /* x */", "select $$ x", "select $t$ x $u$", "select $a$ x $A$;",
                   "select 1;;", ";", "select 1\x00", "select 1\x08", "select 1\r\n", "select 1\\n", "select :a;", "select :'a';", "select :\"a\";", "select :{?a};",
                   "select 1 /* \\ */", "select '\\';", "select 1 where a = 'x'; select 2", "begin; commit; commit;", "select 1 as a$$ ; select 2 as a$$;"]
        for sql in refused:
            with self.subTest(sql=sql), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(sql)
        accepted = ["select 'a\nb';", "select 'it''s';", "select $$a;b$$;", "select $t$a$$b$t$;", "select 1 -- c; d\n;", "select '\t';", "select 'a:b', 1::int;", "select ':a';"]
        for sql in accepted:
            with self.subTest(sql=sql):
                self.assertEqual(snapshot.validate_sql_payload(sql), sql)

    def test_validator_rules_inside_a_block(self):
        for word in ("start transaction", "commit", "end", "rollback", "abort", "savepoint a", "release a", "prepare transaction 'x'", "begin"):
            with self.subTest(word), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(f"begin; select 1; {word}; select 2; commit;")
        for first, last in (("begin", "commit"), ("start transaction", "end"), ("begin isolation level repeatable read read only", "commit")):
            with self.subTest(first=first):
                sql = f"{first}; select 1; {last};"
                self.assertEqual(snapshot.validate_sql_payload(sql), sql)
        for sql in ("select 1; commit;", "begin; select 1;", "begin; select 1; rollback;", "select 1; begin; select 2; commit;"):
            with self.subTest(sql=sql), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(sql)
        with self.assertRaises(snapshot.PayloadRefused):
            snapshot.validate_sql_payload("select 1\x7f;")

    def test_unknown_operations_and_free_form_sql_are_refused_before_any_launch(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        for name in ("select_anything", "", None, 5, "ALLOC_COUNTS", "alloc_counts ", "alloc_counts;select 1", "../x"):
            with self.subTest(name=name), self.assertRaises(db_cases.UnknownOperation):
                db.op(name, a=str(uuid.uuid4()))
        for sql in ("select 1;", "select count(*) from drawbridge_auth.allocation_event;"):
            for call in (lambda s=sql: db.run("g2_scratch_admin", s), lambda s=sql: db.admin(s), lambda s=sql: db.scalar("g2_scratch_admin", s), lambda s=sql: db.run_units("g2_scratch_admin", [s])):
                with self.assertRaises(db_cases.UnregisteredSql):
                    call()
        self.assertEqual(stub.calls, [])

    def test_malformed_parameters_for_every_slot_type_are_refused_before_any_launch(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        a = str(uuid.uuid4())
        bad_calls = [("alloc_counts", dict(a="nope")), ("alloc_counts", dict(a=a.upper())), ("alloc_counts", dict(a=a + "; drop table x")), ("alloc_counts", dict(a=a, extra=1)),
                     ("alloc_counts", {}), ("alloc_counts", dict(a=1)), ("alloc_counts", dict(a=None)),
                     ("exec_privilege", dict(role="postgres")), ("exec_privilege", dict(role="authority_svc'; select 1; --")), ("exec_privilege", dict(role=5)),
                     ("seed_project", dict(project="x\\y")), ("seed_project", dict(project="x\x00y")), ("seed_project", dict(project="\ud800")), ("seed_project", dict(project="x" * 4097)),
                     ("seed_project", dict(project=5)), ("post_call", dict(fn="post_funding", alloc=a, ver=True, amt="1.00", auth="A", key="K")),
                     ("post_call", dict(fn="post_funding", alloc=a, ver=2 ** 63, amt="1.00", auth="A", key="K")), ("post_call", dict(fn="drop table x", alloc=a, ver=1, amt="1.00", auth="A", key="K")),
                     ("txn_block_one_leg", dict(txn=a, a=a, project="P", pid="p", key="k", auth="a", d1="X", m1="5.00", n1="CASH_ALLOCATED")),
                     ("txn_block_one_leg", dict(txn=a, a=a, project="P", pid="p", key="k", auth="a", d1="D", m1="5", n1="CASH_ALLOCATED")),
                     ("txn_block_one_leg", dict(txn=a, a=a, project="P", pid="p", key="k", auth="a", d1="D", m1="5.00", n1="OTHER"))]
        for name, params in bad_calls:
            with self.subTest(name=name, params=params), self.assertRaises(snapshot.PayloadRefused):
                db.op(name, **params)
        self.assertEqual(stub.calls, [])

    def test_hostile_text_values_stay_inside_one_literal_for_every_text_slot_of_every_operation(self):
        hostile = ["'; delete from drawbridge_auth.allocation_event; --", "$$; drop table x; $$", "$a$ x $a$; select 1", "/* ; */", "-- ;\ndelete from t", "a:b :'c' :\"d\"", "x€$$y",
                   " ", "\U0001f600", "tab\there\nnew;line", "'" * 4, "E'x'", "∅"]
        for name, op in db_cases.OPERATIONS.items():
            slots = db_cases.MARKER_RE.findall(op.template)
            text_slots = [n for n, k in slots if k == "text"]
            if not text_slots:
                continue
            for value in hostile:
                params = {n: (str(uuid.uuid4()) if k == "uuid" else 1 if k == "int" else "5.00" if k == "numeric" else {"fn": "post_funding", "role": "authority_svc", "account": "CASH_ALLOCATED", "dir": "D"}.get(k, "x"))
                          for n, k in slots}
                for n in text_slots:
                    params[n] = value
                with self.subTest(op=name, value=value):
                    _, payload = db_cases.render_operation(name, **params)       # still ONE operation with its registered statement count
                    self.assertEqual(len(snapshot._scan(payload)), op.statements)

    def test_a_statement_count_that_differs_from_the_registration_is_refused(self):
        bogus = db_cases.Operation("bogus", "g2_scratch_admin", "begin; select {{a:uuid}}::text; commit;", 4, 1, "none")      # a valid 3-statement block registered as 4
        ops = dict(db_cases.OPERATIONS)
        ops["bogus"] = bogus
        with mock.patch.object(db_cases, "OPERATIONS", types.MappingProxyType(ops)), self.assertRaises(snapshot.PayloadRefused):
            db_cases.render_operation("bogus", a=str(uuid.uuid4()))


class A9Diagnostics(unittest.TestCase):
    def test_exit_status_0_with_a_parsed_error_is_a_failure_never_a_pass(self):
        a = str(uuid.uuid4())
        for err in ("ERROR:  23505: x\n", "psql:<stdin>:1: ERROR:  DW422: y\n", "ERROR:  2350: short\n", "FATAL:  28000: z\n", "ERROR:  23505: x\nDETAIL:  d\n"):
            with self.subTest(err=err), self.assertRaises(db_cases.CaseFailure):
                db_cases.Db(SCRATCH, run=LaunchStub(rc=0, out="3\n", err=err)).op("alloc_event_count", a=a)
        r = db_cases.Result(0, "", "ERROR:  23505: x\n", [("23505", "x", None)], [])
        with self.assertRaises(db_cases.CaseFailure):
            r.state
        with self.assertRaises(db_cases.CaseFailure):
            db_cases.Result(0, "", "ERROR: 2350: x\n", [], ["ERROR: 2350: x"]).message

    def test_unexpected_result_shapes_fail_closed(self):
        a = str(uuid.uuid4())
        for out in ("", "\n", "only|three|fields\n", "e|t|1|f|extra\n", "e|t|1|f\nbad\n", "a b c d\n"):
            with self.subTest(out=out), self.assertRaises(db_cases.CaseFailure):
                db_cases.Db(SCRATCH, run=LaunchStub(out=out)).call("post_funding", a, 1, "1.00", "A", "K")
        for out in ("", "1|2\n", "1\n2|3\n"):
            with self.subTest(out=out), self.assertRaises(db_cases.CaseFailure):
                db_cases.Db(SCRATCH, run=LaunchStub(out=out)).op("alloc_event_count", a=a)
        ok = db_cases.Db(SCRATCH, run=LaunchStub(out="e|t|1|f\n")).call("post_funding", a, 1, "1.00", "A", "K")
        self.assertEqual(ok.rows(), [["e", "t", "1", "f"]])

    def test_incomplete_evidence_fails_closed(self):
        a = str(uuid.uuid4())
        real = snapshot.LaunchResult
        for field_, value in (("stdout_sha256", ""), ("stderr_sha256", "x"), ("stdout_path", None), ("stderr_path", None)):
            def fake(args, _f=field_, _v=value, **kw):
                lr = real(0, "3\n", "", tuple(args), {}, kw["label"], "/x/o", "/x/e", "a" * 64, "b" * 64)
                setattr(lr, _f, _v)
                return lr
            with self.subTest(field=field_), mock.patch.object(snapshot, "launch_runner", side_effect=fake), self.assertRaises(db_cases.CaseFailure):
                db_cases.Db(SCRATCH, run=LaunchStub(), evidence_dir=evidence_tmp()).op("alloc_event_count", a=a)

    def test_constraint_identity_comes_only_from_the_structured_field_and_detail_is_preserved(self):
        with_field = ('ERROR:  23505: duplicate key value violates unique constraint "from_the_message"\nDETAIL:  Key (a)=(1) already exists.\n'
                      'CONSTRAINT NAME:  from_the_field\n')
        d = db_cases.parse_diagnostic_fields(with_field)[0]
        self.assertEqual((d["sqlstate"], d["constraint"], d["detail"]), ("23505", "from_the_field", "Key (a)=(1) already exists."))
        only_message = 'ERROR:  23505: duplicate key value violates unique constraint "named_only_in_prose"\n'
        d2 = db_cases.parse_diagnostic_fields(only_message)[0]
        self.assertIsNone(d2["constraint"])                    # never inferred from the English message text
        self.assertEqual(d2["sqlstate"], "23505")

    def test_dbt_25_diagnostic_logic_is_untouched_and_the_case_stays_deferred(self):
        self.assertEqual(next(c.hold[0] for c in db_cases.CASES if c.case_id == "G2C1-DBT-25"), "DEFERRED")
        self.assertEqual(hashlib.sha256((G2DB / "ledger" / "retry.py").read_bytes()).hexdigest(), RETRY_BASELINE_SHA256)


def home_dependency_findings(source: str) -> list:
    """Line numbers of Path.home() uses and of path-like string constants that name the author's scratch tree, in a Python source text."""
    tree = ast.parse(source)
    homes = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Attribute) and n.attr == "home" and getattr(n.value, "id", "") == "Path"]
    scratch = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and "anvil2-scratch" in n.value and n.value.startswith("/")]
    return sorted(homes + scratch)


def vacuous_assertion_findings(source: str) -> list:
    """Line numbers of assertions that cannot fail: a slice to [:0] compared with the empty list, assertTrue/assertFalse of a constant,
    assertEqual of an expression with itself, and an assertEqual whose two sides are both literals."""
    out = []
    for n in ast.walk(ast.parse(source)):
        if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr.startswith("assert")):
            continue
        args = n.args
        zero_slice = any(isinstance(a, ast.Subscript) and isinstance(a.slice, ast.Slice) and a.slice.lower is None and isinstance(a.slice.upper, ast.Constant) and a.slice.upper.value == 0 for a in args)
        const_truth = n.func.attr in ("assertTrue", "assertFalse") and len(args) >= 1 and isinstance(args[0], ast.Constant)
        same = n.func.attr == "assertEqual" and len(args) >= 2 and ast.dump(args[0]) == ast.dump(args[1])
        both_literal = n.func.attr == "assertEqual" and len(args) >= 2 and isinstance(args[0], (ast.Constant, ast.List, ast.Tuple)) and isinstance(args[1], (ast.Constant, ast.List, ast.Tuple)) and not any(isinstance(x, ast.Name) for a in args[:2] for x in ast.walk(a))
        if zero_slice or const_truth or same or both_literal:
            out.append(n.lineno)
    return sorted(out)


def fake_home():
    """A fresh account-home stand-in (mode 0700) inside a fresh private directory: (home path string, its container)."""
    base = evidence_tmp()
    base = Path(os.path.realpath(base))
    home = base / "home"
    home.mkdir()
    home.chmod(0o700)
    return str(home), base


class A9FreshWorkspace(unittest.TestCase):
    def test_the_suite_has_no_dependency_on_a_preexisting_user_directory(self):
        self.assertEqual(home_dependency_findings(Path(__file__).read_text(encoding="utf-8")), [])
        # the scanner itself can fail: it reports a home-directory use and a path naming the author's scratch tree
        self.assertEqual(home_dependency_findings("import pathlib\nPath.home()\nx = '/home/someone/anvil2-scratch/tmp'\n"), [2, 3])

    def test_the_suite_contains_no_vacuous_assertion(self):
        self.assertEqual(vacuous_assertion_findings(Path(__file__).read_text(encoding="utf-8")), [])
        sample = ("self.assertEqual([x for x in y][:0], [])\nself.assertTrue(True)\nself.assertEqual(a, a)\nself.assertEqual(1, 1)\n"
                  "self.assertEqual(f(), [])\nself.assertTrue(f())\n")
        self.assertEqual(vacuous_assertion_findings(sample), [1, 2, 3, 4])

    def test_the_workspace_override_is_validated_and_confined(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        got = workspace_root(home=home, environ={"G2C1_TEST_WORKSPACE": root})            # an absent approved root is created securely
        self.assertEqual((str(got), oct(os.lstat(root).st_mode & 0o7777)), (root, "0o700"))
        self.assertEqual(str(workspace_root(home=home, environ={"G2C1_TEST_WORKSPACE": root})), root)
        self.assertEqual(str(workspace_root(home=home, environ={})), root)                 # no override: the SAME approved root, never a temporary directory
        for bad in ("", "relative/dir", root + "/", root + "/sub", root + "/../" + APPROVED_SCRATCH_NAME, os.path.join(home, "g2c1-other"), os.path.join(home, "g2c1-a10-scratchX"),
                    os.path.join(home, "g2c1-"), "/tmp", str(base), home, "/tmp/g2c1-a10-scratch", root + "\0", str(ROOT), str(ROOT / "services")):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                workspace_root(home=home, environ={"G2C1_TEST_WORKSPACE": bad})
        self.assertEqual(sorted(os.listdir(home)), [APPROVED_SCRATCH_NAME])

    def test_a_private_workspace_is_created_fresh_and_nothing_pre_existing_is_removed(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        with as_home(home):
            d = new_scratch("g2c1ev")                                                       # the root is created, then a fresh 0700 per-run directory beneath it
            self.assertEqual(Path(os.path.realpath(d)).parent, Path(root))
            self.assertEqual((oct(d.stat().st_mode & 0o777), list(d.iterdir())), ("0o700", []))
            self.assertEqual(str(workspace_root()), root)                                   # entries this run created are known
        home2, _ = fake_home()
        root2 = os.path.join(home2, APPROVED_SCRATCH_NAME)
        os.mkdir(root2, 0o700)
        sentinel = Path(root2) / "pre-existing.txt"
        sentinel.write_text("keep")
        keep_dir = Path(root2) / "pre-existing-dir"
        keep_dir.mkdir()
        with as_home(home2), self.assertRaises(RuntimeError) as ctx:
            new_scratch("g2c1ev")                                                           # unverified existing contents STOP the run
        self.assertIn("STOP", str(ctx.exception))
        self.assertEqual((sentinel.read_text(), keep_dir.is_dir(), sorted(os.listdir(root2))), ("keep", True, ["pre-existing-dir", "pre-existing.txt"]))
        self.assertTrue(d.exists())                                                         # nothing is deleted, not even this run's own directory


class A10WorkspaceRule(unittest.TestCase):
    """C-3 (V09 L-1) and A11 B-5: every guard of the approved-root rule rejects the unsafe input it names, each tested with the root otherwise valid
    (empty, 0700, owned) so that the refusal can only come from the rule under test."""

    def check_refused(self, home, root=None, **kw):
        root = root or os.path.join(home, APPROVED_SCRATCH_NAME)
        with self.assertRaises(RuntimeError):
            workspace_root(home=home, environ={"G2C1_TEST_WORKSPACE": root, **kw.pop("env", {})}, **kw)

    def test_a_root_inside_the_checkout_is_refused_and_so_is_a_checkout_inside_the_root(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        self.check_refused(home, checkout=base)                         # the root is INSIDE the stand-in checkout
        self.assertFalse(os.path.exists(root))                          # refused BEFORE it could be created
        self.check_refused(home, checkout=home)
        os.mkdir(root, 0o700)
        self.check_refused(home, checkout=root)                         # the checkout IS the root
        self.check_refused(home, checkout=Path(root) / "checkout")      # the checkout lies inside the root (a path that does not exist: the root stays empty)
        self.assertEqual(os.listdir(root), [])
        self.assertEqual(str(workspace_root(home=home, checkout=base / "elsewhere", environ={"G2C1_TEST_WORKSPACE": root})), root)

    def test_symbolic_links_are_refused_in_the_root_and_in_the_home(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        real = base / "real-dir"
        real.mkdir(mode=0o700)
        os.symlink(real, root)
        self.check_refused(home)
        self.assertEqual(os.listdir(real), [])
        alias = base / "alias"
        os.symlink(home, alias)
        self.check_refused(str(alias))
        self.check_refused(home, root=os.path.join(str(alias), APPROVED_SCRATCH_NAME))

    def test_ownership_mode_and_unsafe_parents_are_refused_without_repairing_or_deleting_anything(self):
        for mode in (0o755, 0o750, 0o770, 0o777, 0o600, 0o500, 0o701, 0o711):
            home, base = fake_home()
            root = os.path.join(home, APPROVED_SCRATCH_NAME)
            os.mkdir(root, 0o700)
            os.chmod(root, mode)
            with self.subTest(mode=oct(mode)):
                self.check_refused(home)
                self.assertEqual(stat.S_IMODE(os.lstat(root).st_mode), mode)           # not repaired
            os.chmod(root, 0o700)
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        os.mkdir(root, 0o700)
        with mock.patch.object(os, "geteuid", return_value=os.geteuid() + 1):
            self.check_refused(home)
        for parent_mode in (0o775, 0o757, 0o702, 0o720):                                 # group- or other-writable home without the sticky bit (V10 WS-19)
            home, base = fake_home()
            os.chmod(home, parent_mode)
            with self.subTest(parent=oct(parent_mode)):
                self.check_refused(home)
                self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))
            os.chmod(home, 0o700)
        home, base = fake_home()
        os.chmod(base, 0o777)                                                           # an unsafe ancestor further up
        self.check_refused(home)
        os.chmod(base, 0o1777)                                                          # sticky: a shared temporary-style directory is acceptable
        self.assertEqual(str(workspace_root(home=home, environ={})), os.path.join(home, APPROVED_SCRATCH_NAME))
        os.chmod(base, 0o700)

    def test_missing_homes_are_not_created_and_conflicting_overrides_are_refused(self):
        home, base = fake_home()
        missing = str(base / "no-such-home")
        self.check_refused(missing)
        self.assertFalse(os.path.exists(missing))
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        self.check_refused(home, env={"TMPDIR": str(base)})                           # TMPDIR names a different location
        self.check_refused(home, env={"TMPDIR": "/tmp"})
        self.check_refused(home, env={"HOME": str(base)})                             # HOME names a different home
        self.check_refused(home, env={"HOME": "/tmp"})
        self.assertFalse(os.path.exists(root))
        self.assertEqual(str(workspace_root(home=home, environ={"G2C1_TEST_WORKSPACE": root, "TMPDIR": root, "HOME": home})), root)
        self.assertEqual(str(workspace_root(home=home, environ={"TMPDIR": "", "HOME": ""})), root)

    def test_a_root_or_a_home_owned_by_another_account_is_refused_each_on_its_own_account(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        os.mkdir(root, 0o700)
        self.assertEqual(str(workspace_root(home=home, environ={})), root)
        for who in (root, home, str(base)):                                               # str(base): an ancestor ABOVE the home (V10 WS-20)
            with self.subTest(foreign=who), foreign_owner(who):
                self.check_refused(home)

    def test_the_default_home_is_the_account_home_from_the_account_database(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        with mock.patch.object(snapshot, "verified_home", return_value=home):
            self.assertEqual(str(workspace_root(environ={"G2C1_TEST_WORKSPACE": root})), root)
            self.assertEqual(str(workspace_root(environ={})), root)
            with self.assertRaises(RuntimeError):
                workspace_root(environ={"G2C1_TEST_WORKSPACE": os.path.join(str(base), APPROVED_SCRATCH_NAME)})


def as_home(home: str):
    """Act as an account whose home directory is `home`: the account-database lookup AND the environment's HOME agree (a mismatch is refused)."""
    stack = contextlib.ExitStack()
    stack.enter_context(mock.patch.object(snapshot, "verified_home", return_value=home))
    stack.enter_context(mock.patch.dict(os.environ, {"HOME": home}))
    return stack


def foreign_owner(target: str):
    """Make os.lstat report another account as the owner of exactly one path (ownership cannot be changed without privileges)."""
    real = os.lstat

    def fake(path, *a, **k):
        r = real(path, *a, **k)
        if os.fspath(path) == target:
            return os.stat_result((r.st_mode, r.st_ino, r.st_dev, r.st_nlink, r.st_uid + 1, r.st_gid, r.st_size, int(r.st_atime), int(r.st_mtime), int(r.st_ctime)))
        return r
    return mock.patch.object(os, "lstat", side_effect=fake)


class A11WorkspaceNoFallback(unittest.TestCase):
    """A11 B-5 / V10 F-03: the suite never falls back to a system temporary directory, unverified contents stop it, and the socket helper checks length."""

    def test_this_process_uses_the_approved_root_and_nothing_else(self):
        root = str(workspace_root())
        self.assertEqual(root, os.path.join(snapshot.verified_home(), APPROVED_SCRATCH_NAME))
        self.assertEqual(tempfile.gettempdir(), root)
        for made in (evidence_tmp(), Path(scratch_tmp().name), Path(short_tmp().name)):
            self.assertEqual(Path(os.path.realpath(made)).parent, Path(root))
            self.assertEqual(stat.S_IMODE(os.lstat(made).st_mode), 0o700)
        with tempfile.TemporaryFile() as fh:                                              # library temporary files also live under the root
            self.assertTrue(os.path.realpath(f"/proc/self/fd/{fh.fileno()}").startswith(root + "/"))

    def test_an_invalid_root_fails_closed_without_any_fallback(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        os.mkdir(root, 0o700)
        os.chmod(root, 0o755)
        before = sorted(os.listdir(base))
        with as_home(home):
            for make in (lambda: new_scratch(), lambda: scratch_tmp(), lambda: evidence_tmp(), lambda: short_tmp(), workspace_root):
                with self.assertRaises(RuntimeError):
                    make()
        self.assertEqual((sorted(os.listdir(base)), os.listdir(root), stat.S_IMODE(os.lstat(root).st_mode)), (before, [], 0o755))
        os.chmod(root, 0o700)

    def test_contents_left_by_an_earlier_run_stop_the_suite_and_are_left_alone(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        os.mkdir(root, 0o700)
        left = Path(root) / "g2c1t_left_by_a_crashed_run"
        left.mkdir(mode=0o700)
        (left / "data.txt").write_text("unknown")
        with self.assertRaises(RuntimeError) as ctx:
            workspace_root(home=home, environ={})
        self.assertIn("STOP", str(ctx.exception))
        self.assertEqual(((left / "data.txt").read_text(), os.listdir(root)), ("unknown", [left.name]))
        with as_home(home), self.assertRaises(RuntimeError):
            new_scratch()
        self.assertEqual(os.listdir(root), [left.name])

    def test_the_socket_path_length_is_checked_before_use(self):
        t = short_tmp()
        self.assertLessEqual(len(os.fsencode(t.name + SOCKET_SUFFIX)), UNIX_SOCKET_PATH_MAX)
        with mock.patch(f"{__name__}.UNIX_SOCKET_PATH_MAX", 20), self.assertRaises(RuntimeError) as ctx:
            short_tmp()
        self.assertIn("STOP", str(ctx.exception))

    def test_the_test_source_creates_no_temporary_directory_outside_the_helpers(self):
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        bad = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "tempfile"
               and n.attr in ("TemporaryDirectory", "NamedTemporaryFile", "mkstemp")]
        self.assertEqual(bad, [])        # a source-shape guard, complemented by the full suite running with /tmp read-only


class A9EvidenceDirectoryGuards(unittest.TestCase):
    """S15 and D09: focused behavioural tests for the two real low-severity gaps of the controlling review."""

    def test_s15_a_symlinked_evidence_directory_and_a_pre_planted_output_symlink_are_refused(self):
        real = evidence_tmp()
        link = real.parent / (real.name + "-link")
        link.symlink_to(real)
        self.addCleanup(link.unlink)
        stub = LaunchStub()
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["status"], run=stub, evidence_dir=link, label="s15")
        self.assertEqual((stub.calls, list(real.iterdir())), ([], []))
        target = real / "elsewhere.txt"
        target.write_text("untouched")
        (real / "s15b.stdout").symlink_to(target)
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["status"], run=stub, evidence_dir=real, label="s15b")
        self.assertEqual((stub.calls, target.read_text()), ([], "untouched"))

    def test_d09_an_upper_case_or_mixed_case_uuid_is_refused_at_every_boundary(self):
        u = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"                 # fixed (V10 F-06: a random uuid4 made this test nondeterministic)
        mixed = "A1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        stub = LaunchStub(out="3\n")
        db = db_cases.Db(SCRATCH, run=stub)
        for bad in (u.upper(), mixed):
            with self.subTest(bad=bad):
                with self.assertRaises(snapshot.PayloadRefused):
                    db_cases.sql_uuid(bad)
                with self.assertRaises(snapshot.PayloadRefused):
                    db.op("alloc_event_count", a=bad)
                with self.assertRaises(snapshot.PayloadRefused):
                    db.call("post_funding", bad, 1, "1.00", "A", "K")
        self.assertEqual(stub.calls, [])
        db.op("alloc_event_count", a=u)
        self.assertEqual(len(stub.calls), 1)


class SimulatedLedger:
    """A small in-memory model of the posting-function contract, driven ONLY through the real harness (registry, validator, launcher, dispatcher).
    It is a stand-in used to exercise the thirteen converted case bodies offline; it is NOT PostgreSQL and proves nothing about the database."""
    POSTING = re.compile(r"post_(funding|funding_reduction)\('([0-9a-f-]{36})'::uuid, (-?\d+)::bigint, '((?:[^']|'')*)'::numeric, '((?:[^']|'')*)', '((?:[^']|'')*)'\);")

    def __init__(self):
        self.allocs, self.events, self.keys, self.auths = {}, {}, {}, set()
        self.snapshot_json = json.dumps(build_snapshot())

    @staticmethod
    def err(rc, state, message, detail=None):
        return (rc, "", f"ERROR:  {state}: {message}\n" + (f"DETAIL:  {detail}\n" if detail else ""))

    def post(self, kind, alloc, ver, amt, auth, key):
        claim = (kind, alloc, ver, amt, auth)
        if key in self.keys:
            if self.keys[key][0] == claim:
                return (0, f"{self.keys[key][1]}|t{key}|{ver}|t\n", "")
            return self.err(1, "DW409", "IDEMPOTENCY_CONFLICT")
        if len(auth) > 128:
            return self.err(1, "DW422", "INVALID_REFERENCE")
        if alloc not in self.allocs:
            return self.err(1, "DW404", "ALLOCATION_NOT_FOUND")
        if ver <= 0:
            return self.err(1, "DW422", "INVALID_REFERENCE")
        if (kind, auth) in self.auths:
            return self.err(1, "DW409", "DUPLICATE_AUTHORIZATION")
        evs = self.events.setdefault(alloc, [])
        if ver != len(evs) + 1:
            return self.err(1, "DW409", "STALE_VERSION")
        cash = sum(a if k == "funding" else -a for k, a in evs)
        cents = round(float(amt) * 100)
        if kind == "funding_reduction" and cents > cash:
            return self.err(1, "DW422", "AUTHORITY_REDUCTION_BLOCKED", "REDUCTION_EXCEEDS_CASH")
        evs.append(("funding" if kind == "funding" else "reduction", cents))
        self.auths.add((kind, auth))
        eid = f"ev{len(self.keys) + 1}"
        self.keys[key] = (claim, eid)
        return (0, f"{eid}|tx{len(self.keys)}|{ver}|f\n", "")

    def __call__(self, argv):
        if argv[1] == "identity":
            return (0, "live=verified\n", "")
        sql, role = argv[-1], argv[3]
        if "jsonb_build_object" in sql:
            return (0, self.snapshot_json, "")
        m = self.POSTING.search(sql)
        if "drawbridge_auth.post_funding(" in sql and role == "drawbridge_reader":
            return self.err(1, "42501", "permission denied for function post_funding")
        if sql.startswith("select * from drawbridge_auth.post_funding(") and "nullif(" in sql:
            return self.err(1, "DW422", "INVALID_AMOUNT")
        if sql.startswith("select * from drawbridge_auth.post_funding("):
            return self.err(1, "DW422", "INVALID_REFERENCE")
        if m:
            kind, alloc, ver, amt, auth, key = m.group(1), m.group(2), int(m.group(3)), m.group(4).replace("''", "'"), m.group(5).replace("''", "'"), m.group(6).replace("''", "'")
            if float(amt) > 99999999999.99:
                return self.err(1, "DW422", "INVALID_AMOUNT")
            return self.post(kind, alloc, ver, amt, auth, key)
        if sql.startswith("insert into drawbridge_auth.allocation("):
            self.allocs[re.search(r"values \('([0-9a-f-]{36})'", sql).group(1)] = True
            return (0, "", "")
        if sql.startswith("insert into drawbridge_auth.project(") or sql.startswith("insert into drawbridge_auth.journal_account("):
            return (0, "", "")
        a = re.search(r"allocation_id ?= ?'([0-9a-f-]{36})'", sql)
        evs = self.events.get(a.group(1), []) if a else []
        if sql.startswith("select (select count(*) from drawbridge_auth.allocation_event where"):
            return (0, f"{len(evs)},{len(evs)},{2 * len(evs)}\n", "")
        if sql.startswith("select string_agg(account_name||':'||direction||':'||amount"):
            return (0, "CASH_ALLOCATED:D:500000.00,PROJECT_CAPITAL:C:500000.00\n", "")
        if sql.startswith("select string_agg(account_name||'='"):
            return (0, "CASH_ALLOCATED=50000000,DISBURSED=0,PROJECT_CAPITAL=50000000\n", "")
        if sql.startswith("select string_agg(account_name||':'||direction, ','"):
            return (0, "PROJECT_CAPITAL:D,CASH_ALLOCATED:C\n", "")
        if sql.startswith("select balance_cents"):
            return (0, f"{sum(c if k == 'funding' else -c for k, c in evs)}\n", "")
        if sql.startswith("select count(*) from drawbridge_auth.allocation_event where"):
            return (0, f"{len(evs)}\n", "")
        if sql.startswith("select count(*) from drawbridge_auth.journal_txn where"):
            return (0, "0\n", "")
        if sql.startswith("select (select count(*) from drawbridge_auth.allocation_event)"):
            return (0, f"{sum(len(v) for v in self.events.values())},{2 * sum(len(v) for v in self.events.values())}\n", "")
        if sql.startswith("begin;"):
            return self.err(1, "23514", "event version is not contiguous" if "allocation_event" in sql else "journal imbalance")
        if sql.startswith("select proname, provolatile"):
            rows = ["post_funding|v|t|search_path=pg_catalog, drawbridge_auth, pg_temp|p_allocation_id,p_expected_version,p_amount,p_authorization_id,p_idempotency_key",
                    "post_funding_reduction|v|t|search_path=pg_catalog, drawbridge_auth, pg_temp|p_allocation_id,p_expected_version,p_amount,p_authorization_id,p_idempotency_key"]
            rows += [f"g2c1_helper_{i}|i|f|search_path=pg_catalog, pg_temp|p_value" for i in range(9)]
            return (0, "\n".join(rows) + "\n", "")
        if sql.startswith("select has_function_privilege("):
            return (0, "t\n" if "'authority_svc'" in sql else "f\n", "")
        if sql.startswith("select count(*) from pg_proc p, aclexplode"):
            return (0, "0\n", "")
        raise AssertionError(f"the simulated ledger does not know this statement: {sql[:120]!r}")


class A9SelectableCaseSimulation(unittest.TestCase):
    def test_all_thirteen_selectable_cases_pass_end_to_end_against_the_simulated_ledger_through_the_real_dispatcher(self):
        sim = SimulatedLedger()
        stub = LaunchStub(script=sim)
        ev = evidence_tmp()
        report = db_cases.run_all(enabled=True, database=SCRATCH, cases=",".join(THIRTEEN), evidence_dir=ev, run=stub, approved_source=approved_source_table())
        by = {r["case_id"]: r for r in report}
        self.assertEqual({k: v["status"] for k, v in by.items() if k in THIRTEEN}, {k: "PASS" for k in THIRTEEN}, {k: v for k, v in by.items() if v["status"] == "FAIL"})
        self.assertEqual({v["status"] for k, v in by.items() if k not in THIRTEEN}, {"NOT RUN"})
        self.assertGreater(len(stub.calls), 100)
        for argv, kw in stub.calls:
            self.assertEqual(argv[0], str(RUNNER))
            self.assertEqual(set(kw["env"]) - {"PGOPTIONS"}, {"PATH", "HOME", "LANG"})
            if argv[1] == "psql":
                self.assertEqual(argv[2], SCRATCH)
                self.assertNotIn("-f", argv)
        self.assertEqual(len(list(ev.glob("*.stdout"))), len(stub.calls))             # one evidence file pair per launch, plus the selection manifest
        self.assertTrue((ev / "selection.json").is_file())


# ======================================================================================================================================
# A10 (SIM-ENG-003-G2C1-A10), source-only, offline: the SQL registry enforced AT THE LAUNCH BOUNDARY (V09 M-1), behavioural fail-closed result
# tests (V09 M-2, L-5), the workspace path-safety rule (above), and selection-manifest source identity (V09 L-6). Stub process runners only: no
# database, no PostgreSQL, no SQL, no network. Developer regression tests, NOT independent acceptance.
# ======================================================================================================================================
import importlib.util
import pickle


def a_call(name="alloc_event_count", **params):
    params = params or {"a": str(uuid.uuid4())}
    return snapshot.RegisteredCall(name, params)


def psql_args(call, role="g2_scratch_admin", database=SCRATCH):
    return ["psql", database, role, "-At", "-c", call]


class A10LaunchBoundary(unittest.TestCase):
    """M-1: no psql text reaches the runner unless the LAUNCH BOUNDARY itself derived it from the registry. Every test asserts ZERO launches for a refusal."""

    def refused(self, fn, *args, **kw):
        stub = LaunchStub()
        with self.assertRaises(snapshot.LaunchRefused):
            fn(*args, run=stub, **kw) if fn is snapshot.launch_runner else fn(*args, **kw)
        return stub

    def test_plain_sql_text_is_refused_by_launch_runner_for_every_role_and_flag_form(self):
        texts = ("select 1;", "drop table drawbridge_auth.allocation_event;", "delete from drawbridge_auth.allocation_event;", "begin; select 1; commit;",
                 "select event_id from drawbridge_auth.allocation_event;", "")
        for role in snapshot.PSQL_ROLES:
            for text in texts:
                for flags in (["-At"], ["-A", "-t", "-1"], ["-At", "-F", "|", "-v", "VERBOSITY=verbose"]):
                    stub = LaunchStub()
                    with self.subTest(role=role, text=text[:20], flags=flags), self.assertRaises(snapshot.LaunchRefused):
                        snapshot.launch_runner(["psql", SCRATCH, role, *flags, "-c", text], run=stub, label="a10-plain")
                    self.assertEqual(stub.calls, [])

    def test_a_registered_call_launches_exactly_the_registry_rendering_with_its_own_role(self):
        alloc = str(uuid.uuid4())
        stub = LaunchStub(out="3\n")
        done = snapshot.launch_runner(psql_args(a_call("alloc_event_count", a=alloc)), run=stub, label="a10-ok")
        expected = snapshot.render_operation("alloc_event_count", a=alloc)[1]
        argv = stub.calls[0][0]
        self.assertEqual((argv[1:4], argv[-2], argv[-1]), (["psql", SCRATCH, "g2_scratch_admin"], "-c", expected))
        self.assertEqual((done.operation, done.payload_sha256), ("alloc_event_count", hashlib.sha256(expected.encode()).hexdigest()))
        for role in ("authority_svc", "drawbridge_reader"):                                   # the role must be the one registered for the operation
            stub = self.refused(snapshot.launch_runner, psql_args(a_call("alloc_event_count", a=alloc), role=role), label="a10-role")
            self.assertEqual(stub.calls, [])

    def test_forged_and_edited_registered_calls_are_re_derived_not_trusted(self):
        alloc = str(uuid.uuid4())

        class Evil(snapshot.RegisteredCall):
            pass
        evil = Evil("alloc_event_count", {"a": alloc})
        self.assertEqual(self.refused(snapshot.launch_runner, psql_args(evil), label="a10-sub").calls, [])          # a subclass is not trusted by type
        blank = object.__new__(snapshot.RegisteredCall)                                      # built without its constructor: no fields at all
        self.assertEqual(self.refused(snapshot.launch_runner, psql_args(blank), label="a10-blank").calls, [])
        hostile = ("'; delete from drawbridge_auth.allocation_event; --", alloc.upper(), alloc + "\n", 5, None, ["x"], b"x", True)
        for value in hostile:
            forged = object.__new__(snapshot.RegisteredCall)
            object.__setattr__(forged, "_name", "alloc_event_count")
            object.__setattr__(forged, "_params", (("a", value),))
            with self.subTest(value=value):
                self.assertEqual(self.refused(snapshot.launch_runner, psql_args(forged), label="a10-forged").calls, [])
        shapes = (("alloc_event_count", (("a", alloc), ("b", alloc))), ("alloc_event_count", ()), ("alloc_event_count", (("a", alloc, alloc),)), ("alloc_event_count", [("a", alloc)]),
                  ("alloc_event_count", {"a": alloc}), ("no_such_operation", (("a", alloc),)), (None, (("a", alloc),)), ("alloc_event_count", None), ("drop", ()))
        for name, params in shapes:
            forged = object.__new__(snapshot.RegisteredCall)
            object.__setattr__(forged, "_name", name)
            object.__setattr__(forged, "_params", params)
            with self.subTest(name=name, params=params):
                self.assertEqual(self.refused(snapshot.launch_runner, psql_args(forged), label="a10-shape").calls, [])
        for value in (1, "x", None, "select 1", alloc):                                      # not a registered call at all
            self.assertEqual(self.refused(snapshot.launch_runner, psql_args(value) if value != alloc else ["psql", SCRATCH, "g2_scratch_admin", "-c", value], label="a10-type").calls, [])

    def test_contents_edited_after_validation_never_keep_a_stale_authorization(self):
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        call = a_call("alloc_event_count", a=first)
        object.__setattr__(call, "_params", (("a", second),))                                 # an edit after construction (host-level, as a worst case)
        stub = LaunchStub(out="1\n")
        snapshot.launch_runner(psql_args(call), run=stub, label="a10-edit")
        self.assertEqual(stub.calls[0][0][-1], snapshot.render_operation("alloc_event_count", a=second)[1])    # what runs is the registry rendering of what is IN the object
        object.__setattr__(call, "_params", (("a", "x'; delete from drawbridge_auth.journal_leg; --"),))
        self.assertEqual(self.refused(snapshot.launch_runner, psql_args(call), label="a10-edit2").calls, [])

        def mutate_during_run(argv, **kw):
            object.__setattr__(call2, "_params", (("a", "evil"),))
            return subprocess.CompletedProcess(argv, 0)
        call2 = a_call("alloc_event_count", a=first)
        seen = []
        snapshot.launch_runner(psql_args(call2), run=lambda argv, **kw: (seen.append(list(argv)), mutate_during_run(argv, **kw))[1], label="a10-toctou")
        self.assertEqual(seen[0][-1], snapshot.render_operation("alloc_event_count", a=first)[1])      # the launched text was fixed once, before the launch

    def test_a_registered_call_is_immutable_and_cannot_be_copied_or_pickled(self):
        call = a_call()
        for attr, value in (("_name", "x"), ("_params", ()), ("new", 1)):
            with self.subTest(attr=attr), self.assertRaises(AttributeError):
                setattr(call, attr, value)
        with self.assertRaises(AttributeError):
            delattr(call, "_name")
        for fn in (copy.copy, copy.deepcopy, pickle.dumps):
            with self.subTest(fn=fn.__name__), self.assertRaises(TypeError):
                fn(call)
        self.assertEqual(type(call.params), tuple)
        for bad in ((None, {}), ("alloc_event_count", {"a": uuid.uuid4()}), ("alloc_event_count", {"a": str(uuid.uuid4()), "b": "x"}), ("alloc_event_count", {}),
                    ("alloc_event_count", {1: "x"}), ("alloc_event_count", [("a", "x")]), ("select 1", {}), ("alloc_event_count", {"a": "x"})):
            with self.subTest(bad=bad), self.assertRaises(snapshot.PayloadRefused):
                snapshot.RegisteredCall(*bad)

    def test_a_tampered_or_extended_registry_is_refused_at_launch(self):
        real = dict(snapshot.OPERATIONS)
        evil = snapshot.Operation("evil", "g2_scratch_admin", "delete from drawbridge_auth.allocation_event;", 1, None, "x")
        altered = snapshot.Operation("alloc_event_count", "g2_scratch_admin", "delete from drawbridge_auth.allocation_event where allocation_id={{a:uuid}};", 1, None, "x")
        for variant in ({**real, "evil": evil}, {**real, "alloc_event_count": altered}, {k: v for k, v in real.items() if k != "alloc_event_count"}):
            with self.subTest(keys=len(variant)), mock.patch.object(snapshot, "OPERATIONS", types.MappingProxyType(variant)):
                call = object.__new__(snapshot.RegisteredCall)
                object.__setattr__(call, "_name", "evil" if "evil" in variant else "alloc_event_count")
                object.__setattr__(call, "_params", () if "evil" in variant else (("a", str(uuid.uuid4())),))
                self.assertEqual(self.refused(snapshot.launch_runner, psql_args(call), label="a10-reg").calls, [])
        self.assertEqual(snapshot.registry_digest(), snapshot.REGISTRY_SHA256)             # the unmodified registry still matches its pin

    def test_db_runner_is_not_a_generic_sql_interface(self):
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        call = a_call()
        for args in (("psql", SCRATCH, "g2_scratch_admin", "-At", "-c", "drop table drawbridge_auth.allocation_event;"), ("psql", SCRATCH, "g2_scratch_admin", "-At", "-c", call),
                     ("psql",), ("psql", SCRATCH, "g2_scratch_admin", "-c", "select 1;"), ("psql", "postgres", "g2_scratch_admin", "-c", "select 1;")):
            with self.subTest(args=args[:2]), self.assertRaises(snapshot.CommandRefused if args[0] == "psql" else snapshot.LaunchRefused):
                db.runner(*args)
        for args in (("status", call), ("identity", "select 1;"), ("PSQL", SCRATCH, "g2_scratch_admin", "-c", "select 1;"), ()):
            with self.subTest(args=args), self.assertRaises(snapshot.LaunchRefused):
                db.runner(*args)
        self.assertEqual(stub.calls, [])

    def test_db_submit_takes_an_operation_and_parameters_never_text(self):
        stub = LaunchStub(out="1\n")
        db = db_cases.Db(SCRATCH, run=stub)
        hostile = "x'; delete from drawbridge_auth.allocation_event; --"
        for name, params in (("alloc_event_count", {"a": hostile}), ("alloc_event_count", {"a": str(uuid.uuid4()), "extra": "1"}), ("alloc_event_count", {}), ("select 1;", {}),
                             ("delete from drawbridge_auth.allocation_event;", {}), (db_cases.OPERATIONS["alloc_event_count"], {"a": str(uuid.uuid4())}), (None, {}), ("snapshot_read", {"a": "x"})):
            with self.subTest(name=str(name)[:30]), self.assertRaises(snapshot.PayloadRefused):
                db._submit(name, params, None)
        with self.assertRaises(snapshot.PayloadRefused):                                          # the old (operation, payload, options) shape no longer works
            db._submit(db_cases.OPERATIONS["alloc_event_count"], "delete from drawbridge_auth.allocation_event;", None)
        with self.assertRaises(snapshot.PayloadRefused):                                          # an operation that takes no isolation options refuses them
            db._submit("alloc_event_count", {"a": str(uuid.uuid4())}, db_cases.SERIALIZABLE)
        self.assertEqual(stub.calls, [])
        db._submit("alloc_event_count", {"a": str(uuid.uuid4())}, None)
        self.assertEqual(len(stub.calls), 1)

    def test_the_snapshot_read_uses_the_registered_path(self):
        stub = LaunchStub(rc=1, err="ERROR:  42501: permission denied\n")
        with self.assertRaises(snapshot.SnapshotError) as ctx:
            snapshot.fetch_snapshot(SCRATCH, run=stub)
        argv = stub.calls[0][0]
        self.assertEqual((argv[1:4], argv[-1]), (["psql", SCRATCH, snapshot.READER_ROLE], snapshot.SNAPSHOT_SQL))
        self.assertEqual(ctx.exception.evidence.operation, "snapshot_read")
        self.assertIn("snapshot_read", snapshot.OPERATIONS)
        self.assertEqual(snapshot.OPERATIONS["snapshot_read"].template, snapshot.SNAPSHOT_SQL)
        self.assertEqual(snapshot.OPERATIONS["snapshot_read"].role, snapshot.READER_ROLE)
        stub = LaunchStub()
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.fetch_snapshot("drawbridge_g2_dev", run=stub)
        self.assertEqual(stub.calls, [])

    def test_an_imported_second_copy_of_the_module_gets_no_cross_trust(self):
        spec = importlib.util.spec_from_file_location("g2c1_snapshot_second_copy", SNAPSHOT_PY)
        other = importlib.util.module_from_spec(spec)
        sys.modules["g2c1_snapshot_second_copy"] = other      # a dataclass needs its module registered while it is defined
        self.addCleanup(sys.modules.pop, "g2c1_snapshot_second_copy", None)
        spec.loader.exec_module(other)
        self.assertIsNot(other.RegisteredCall, snapshot.RegisteredCall)
        stub = LaunchStub()
        for launch, call in ((other.launch_runner, a_call()), (snapshot.launch_runner, other.RegisteredCall("alloc_event_count", {"a": str(uuid.uuid4())}))):
            with self.subTest(module=launch.__module__), self.assertRaises(snapshot.LaunchRefused if launch is snapshot.launch_runner else other.LaunchRefused):
                launch(psql_args(call), run=stub, label="a10-copy")
        for launch, exc in ((other.launch_runner, other.LaunchRefused), (snapshot.launch_runner, snapshot.LaunchRefused)):
            with self.assertRaises(exc):
                launch(["psql", SCRATCH, "g2_scratch_admin", "-At", "-c", "delete from drawbridge_auth.allocation_event;"], run=stub, label="a10-copy2")
        self.assertEqual(stub.calls, [])
        stub = LaunchStub(out="1\n")
        other.launch_runner(psql_args(other.RegisteredCall("alloc_event_count", {"a": str(uuid.uuid4())})), run=stub, label="a10-copy3")   # the copy works for ITS OWN registered calls
        self.assertEqual(len(stub.calls), 1)

    def test_only_the_registry_path_launches_psql_and_the_selectable_cases_use_only_registered_operations(self):
        self.assertEqual(functions_containing(DB_CASES_PY, lambda n: isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "launch_runner"), ["_submit", "runner"])
        self.assertEqual(functions_containing(SNAPSHOT_PY, lambda n: isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "launch_runner"), ["fetch_snapshot"])
        self.assertEqual(functions_containing(DB_CASES_PY, lambda n: isinstance(n, ast.Name) and n.id == "_submit" or isinstance(n, ast.Attribute) and n.attr == "_submit"), ["op"])

    def test_the_injection_database_name_is_checked_by_the_boundary_under_allow_injection(self):
        call = a_call()
        for name in ("drawbridge_g2_scratch_inject_01", "drawbridge_g2_scratch_inject", "drawbridge_g2_scratch_injectz9"):
            stub = LaunchStub(out="1\n")
            snapshot.launch_runner(psql_args(call, database=name), run=stub, label="a10-inj", allow_injection=True)
            self.assertEqual(len(stub.calls), 1)
            stub = self.refused(snapshot.launch_runner, psql_args(call, database=name), label="a10-inj2")
        for name in ("drawbridge_g2_scratch_inject_01;", "Drawbridge_g2_scratch_inject_01", "drawbridge_g2_scratch_inject-1", "drawbridge_g2_scratch_inject_01 ", "drawbridge_g2_dev_inject_01"):
            with self.subTest(name=name):
                self.assertEqual(self.refused(snapshot.launch_runner, psql_args(call, database=name), label="a10-inj3", allow_injection=True).calls, [])

    def test_lower_layers_refuse_on_their_own(self):
        call = a_call()
        for args, kw in ((["psql", SCRATCH, "g2_scratch_admin", "-F", "\\", "-c", call], {}), (["psql", SCRATCH, "g2_scratch_admin", "-F", "|\\", "-c", call], {}),
                         (["psql", SCRATCH, "g2_scratch_admin", "-v", "x=a\\b", "-c", call], {}), (["stop", "x"], {"allow_control": True}), (["crash-kill", "--force"], {"allow_control": True}),
                         (["status", "x"], {}), (["psql", SCRATCH, "g2_scratch_admin", "-f", "-", "-c", call], {}), (["psql", SCRATCH, "g2_scratch_admin", "-c", call, "-c", call], {}),
                         (["psql", SCRATCH, "g2_scratch_admin", "-At", "-c", call], {"pgoptions": db_cases.SERIALIZABLE}),          # an operation without isolation options refuses them
                         (["psql", SCRATCH, "drawbridge_reader", "-At", "-c", a_call("alloc_balances", a=str(uuid.uuid4()))], {"pgoptions": db_cases.READ_COMMITTED})):
            with self.subTest(args=args[:4]):
                self.assertEqual(self.refused(snapshot.launch_runner, args, label="a10-low", **kw).calls, [])

    def test_render_operation_validates_the_whole_rendering_and_pins_the_statement_count(self):
        real = dict(snapshot.OPERATIONS)
        two = snapshot.Operation("two", "g2_scratch_admin", "begin; select 1; commit;", 2, None, "x")                  # registered as 2 statements, renders 3
        commented = snapshot.Operation("commented", "g2_scratch_admin", "select E'\\x41';", 1, None, "x")             # right count, refused by the payload validator alone
        second = snapshot.Operation("second", "g2_scratch_admin", "select 1; select 2;", 1, None, "x")
        ok = snapshot.Operation("fine", "g2_scratch_admin", "select 1;", 1, None, "x")
        with mock.patch.object(snapshot, "OPERATIONS", types.MappingProxyType({**real, "two": two, "commented": commented, "second": second, "fine": ok})):
            for name in ("two", "commented", "second"):
                with self.subTest(name=name), self.assertRaises(snapshot.PayloadRefused):
                    snapshot.render_operation(name)
            self.assertEqual(snapshot.render_operation("fine")[1], "select 1;")
        with self.assertRaises(snapshot.UnknownOperation):
            snapshot.render_operation("fine")


class A10ValidatorBounds(unittest.TestCase):
    """The size limit and the control-character and backslash rules of the payload validator (defence in depth behind the registry), each with a payload that
    differs from an accepted one only in the rule it tests."""

    def test_the_size_limit_is_exact(self):
        limit = snapshot.MAX_PAYLOAD_BYTES
        head, tail = "select '", "';"
        fits = head + "x" * (limit - len(head) - len(tail)) + tail
        self.assertEqual(len(fits.encode()), limit)
        self.assertEqual(snapshot.validate_sql_payload(fits), fits)
        with self.assertRaises(snapshot.PayloadRefused):
            snapshot.validate_sql_payload(head + "x" * (limit - len(head) - len(tail) + 1) + tail)

    def test_backslash_and_control_characters_are_refused_inside_literals_too(self):
        for text in ("select 'a\\b';", "select 'a\x01b';", "select 'a\x00b';", "select 'a\x7fb';", "select 'a\rb';", "select 'a\x1bb';"):
            with self.subTest(text=text), self.assertRaises(snapshot.PayloadRefused):
                snapshot.validate_sql_payload(text)
        self.assertEqual(snapshot.validate_sql_payload("select 'a\tb\nc';"), "select 'a\tb\nc';")


class A10ResultMappingAndFailClosed(unittest.TestCase):
    """M-2: the reporting layer maps outcomes without ever turning a failure into PASS, a dry run launches nothing, and the evidence and exit-status rules
    hold through run_all and main. Each test fails if the behaviour it names is removed."""

    def run_bodies(self, bodies: dict, cases: str):
        original = db_cases.CASES[:]
        stub = LaunchStub()
        try:
            db_cases.CASES[:] = [db_cases.Case(c.case_id, c.criteria, c.title, bodies.get(c.case_id, c.body), c.inject, c.hold, c.original) for c in original]
            report = db_cases.run_all(enabled=True, database=SCRATCH, cases=cases, evidence_dir=evidence_tmp(), run=stub, approved_source=approved_source_table())
        finally:
            db_cases.CASES[:] = original
        return {r["case_id"]: r for r in report}, stub

    def test_failure_finding_inconclusive_and_unexpected_errors_are_never_reported_as_pass(self):
        def boom(exc):
            def body(db):
                raise exc
            return body
        bodies = {"G2C1-DBT-02": boom(db_cases.CaseFailure("a guard failed")), "G2C1-DBT-03": boom(db_cases.CaseFinding("a finding")),
                  "G2C1-DBT-04": boom(db_cases.CaseInconclusive("not enough evidence")), "G2C1-DBT-05": boom(ValueError("unexpected")),
                  "G2C1-DBT-06": boom(snapshot.LaunchRefused("refused launch")), "G2C1-DBT-07": lambda db: None, "G2C1-DBT-08": boom(AssertionError("plain assertion")),
                  "G2C1-DBT-11": boom(KeyError("k")), "G2C1-DBT-12": boom(db_cases.CaseHeld("held")), "G2C1-DBT-14": boom(RuntimeError("x" * 2000))}
        by, stub = self.run_bodies(bodies, ",".join(sorted(bodies)))
        got = {k: v["status"] for k, v in by.items() if k in bodies}
        self.assertEqual(got, {"G2C1-DBT-02": "FAIL", "G2C1-DBT-03": "FINDING", "G2C1-DBT-04": "INCONCLUSIVE", "G2C1-DBT-05": "FAIL", "G2C1-DBT-06": "FAIL",
                               "G2C1-DBT-07": "PASS", "G2C1-DBT-08": "FAIL", "G2C1-DBT-11": "FAIL", "G2C1-DBT-12": "FAIL", "G2C1-DBT-14": "FAIL"})
        self.assertIn("a guard failed", by["G2C1-DBT-02"]["reason"])
        self.assertIn("ValueError", by["G2C1-DBT-05"]["reason"])
        self.assertLessEqual(len(by["G2C1-DBT-14"]["reason"]), 500)
        self.assertEqual([r["status"] for k, r in by.items() if k not in bodies and r.get("hold") is None], ["NOT RUN"] * len([1 for k, r in by.items() if k not in bodies and r.get("hold") is None]))
        self.assertEqual(stub.calls, [])

    def test_a_dry_run_with_a_selection_launches_nothing_through_run_all_and_main(self):
        stub = LaunchStub()
        report = db_cases.run_all(enabled=False, database=SCRATCH, cases="G2C1-DBT-02,G2C1-DBT-03", run=stub)
        self.assertEqual(stub.calls, [])
        self.assertEqual({r["status"] for r in report}, {"NOT RUN"})
        report = db_cases.run_all(enabled=False, database=SCRATCH, cases="G2C1-DBT-02", run=stub, approved_source=approved_source_table())
        self.assertEqual((stub.calls, {r["status"] for r in report}), ([], {"NOT RUN"}))
        err, out = io.StringIO(), io.StringIO()
        with mock.patch.object(snapshot, "launch_runner", side_effect=AssertionError("a dry run must not launch")) as spy, contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            rc = db_cases.main(["--db", SCRATCH, "--cases", "G2C1-DBT-03,G2C1-DBT-02"])
        self.assertEqual((rc, spy.call_count, {r["status"] for r in json.loads(out.getvalue())}), (0, 0, {"NOT RUN"}))

    def test_run_all_enforces_the_evidence_directory_before_any_launch(self):
        table = approved_source_table()
        base = evidence_tmp()
        good = base / "good"
        good.mkdir(mode=0o700)
        link = base / "link"
        link.symlink_to(good)
        nonempty = base / "nonempty"
        nonempty.mkdir(mode=0o700)
        (nonempty / "old.txt").write_text("keep")
        loose = base / "loose"
        loose.mkdir()
        loose.chmod(0o755)
        afile = base / "afile"
        afile.write_text("x")
        for bad in (None, str(base / "missing"), link, nonempty, loose, afile, ""):
            stub = LaunchStub()
            with self.subTest(bad=str(bad)), self.assertRaises(snapshot.LaunchRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-02", evidence_dir=bad, run=stub, approved_source=table)
            self.assertEqual(stub.calls, [])
        self.assertEqual((list(good.iterdir()), (nonempty / "old.txt").read_text(), list(loose.iterdir())), ([], "keep", []))      # nothing written or removed by the refusals
        stub = LaunchStub()
        db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-19", evidence_dir=good, run=stub, approved_source=table)        # the same directory is accepted once it is valid
        self.assertTrue((good / "selection.json").is_file())

    def test_main_exit_status_follows_the_selected_case_outcomes(self):
        table = str(approved_source_table())

        def go(report):
            err, out = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, {db_cases.ENABLE_ENV: db_cases.ENABLE_VALUE}), mock.patch.object(db_cases, "run_all", return_value=report), \
                    contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                return db_cases.main(["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02,G2C1-DBT-03", "--evidence-dir", str(evidence_tmp()), "--approved-source", table])
        row = lambda cid, status: {"case_id": cid, "status": status}   # noqa: E731
        self.assertEqual(go([row("G2C1-DBT-02", "PASS"), row("G2C1-DBT-03", "PASS"), row("G2C1-DBT-04", "NOT RUN")]), 0)
        for bad in ("FAIL", "FINDING", "INCONCLUSIVE", "NOT RUN", "SKIP", "pass", ""):
            with self.subTest(status=bad):
                self.assertEqual(go([row("G2C1-DBT-02", "PASS"), row("G2C1-DBT-03", bad)]), 1)
        self.assertEqual(go([row("G2C1-DBT-02", "PASS"), row("G2C1-DBT-03", "PASS"), row("G2C1-DBT-04", "FAIL")]), 0)            # an unselected row does not decide the status
        with mock.patch.object(db_cases, "run_all", side_effect=snapshot.LaunchRefused("refused")), contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(db_cases.main(["--db", SCRATCH, "--cases", "G2C1-DBT-02"]), 2)

    def test_typed_slot_bounds_are_pinned_at_both_ends(self):
        u = str(uuid.uuid4())
        self.assertEqual(db_cases.sql_int(2 ** 63 - 1), str(2 ** 63 - 1))
        self.assertEqual(db_cases.sql_int(0), "0")
        for bad in (2 ** 63, -(2 ** 63) - 1, True, False, 1.0, "1", None, b"1", 2 ** 70):
            with self.subTest(int=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_int(bad)
        self.assertEqual(db_cases.sql_text("x" * 4096), "'" + "x" * 4096 + "'")
        for bad in ("x" * 4097, "a\\b", "a\x00b", "a\x01b", "a\x7fb", "a\rb", 5, None, b"a", "\ud800"):
            with self.subTest(text=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_text(bad)
        self.assertEqual(db_cases.sql_text("a'b\n\t"), "'a''b\n\t'")
        for ok in ("0.00", "0.01", "99999999999.99", "5.00", "100.50"):
            self.assertEqual(db_cases.sql_numeric(ok), ok)
        for bad in ("100000000000.00", "1.0", "1.000", ".50", "1", "1.00x", "1.00\n", " 1.00", "1.00 ", "-1.00", "1e3", "1,00", "１.00", "1.0０", 1.0, None, b"1.00", "0x1.00"):
            with self.subTest(numeric=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_numeric(bad)
        self.assertEqual(db_cases.sql_uuid(u), f"'{u}'")
        for bad in (u.upper(), u + "\n", " " + u, "{" + u + "}", u.replace("-", ""), u[:-1], u + "0", u[:8] + "_" + u[9:], None, 5, b"x"):
            with self.subTest(uuid=bad), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_uuid(bad)

    def test_enumerations_are_exactly_the_approved_members(self):
        self.assertEqual(dict(db_cases.ENUMS), {"fn": ("post_funding", "post_funding_reduction"), "role": ("authority_svc", "drawbridge_reader"),
                                                "account": ("CASH_ALLOCATED", "PROJECT_CAPITAL", "DISBURSED"), "dir": ("D", "C")})
        enc = db_cases._ENCODERS
        for kind, members in db_cases.ENUMS.items():
            for m in members:
                self.assertIn(m, enc[kind](m))
        for kind, bad in (("fn", ("pg_sleep", "post_funding ", "post_funding;", "POST_FUNDING", "post_funding_reduction2", "", None, 5, "post_funding()", "drawbridge_auth.post_funding")),
                          ("role", ("g2_scratch_admin", "postgres", "drawbridge_owner", "AUTHORITY_SVC", "authority_svc ", "", None)),
                          ("account", ("cash_allocated", "OTHER", "CASH_ALLOCATED ", "", None, "'; drop table x; --")), ("dir", ("d", "X", "DC", "", None, "D "))):
            for b in bad:
                with self.subTest(kind=kind, value=b), self.assertRaises(snapshot.PayloadRefused):
                    enc[kind](b)
        self.assertEqual(set(snapshot.PSQL_ROLES), {"g2_scratch_admin", "authority_svc", "drawbridge_reader"})
        self.assertEqual({o.role for o in snapshot.OPERATIONS.values()}, set(snapshot.PSQL_ROLES))

    def test_unexpected_shapes_contradictory_evidence_and_unreadable_errors_fail_closed(self):
        u = str(uuid.uuid4())
        call = lambda stub: db_cases.Db(SCRATCH, run=stub, evidence_dir=evidence_tmp()).call("post_funding", u, 1, "5.00", "AUTH", "KEY")   # noqa: E731
        for stub in (LaunchStub(out="a|b|c\n"), LaunchStub(out="a|b|c|d|e\n"), LaunchStub(out="\n"), LaunchStub(out=""), LaunchStub(out="a|b|c|d\nx|y\n"),
                     LaunchStub(rc=0, out="a|b|c|d\n", err="ERROR:  23505: duplicate key\n"), LaunchStub(rc=0, out="a|b|c|d\n", err="FATAL:  57P01: terminated\n"),
                     LaunchStub(rc=0, out="a|b|c|d\n", err="psql: error: connection failed\n"), LaunchStub(rc=0, out="a|b|c|d\n", err="ERROR:  something went wrong\n")):
            with self.subTest(out=stub.out, err=stub.err), self.assertRaises(db_cases.CaseFailure):
                call(stub)
        r = call(LaunchStub(rc=0, out="e|t|1|f\n", err="WARNING:  just a notice\n"))
        self.assertEqual((r.rc, r.errors), (0, []))
        failed = call(LaunchStub(rc=1, out="", err="ERROR:  23505: duplicate key value violates unique constraint\nCONSTRAINT NAME:  uq_x\n"))
        self.assertEqual((failed.rc, failed.state), (1, "23505"))
        for text in ("ERROR:  something went wrong\n", "psql: error: nope\n", ""):
            with self.subTest(text=text), self.assertRaises(db_cases.CaseFailure):
                call(LaunchStub(rc=1, out="", err=text)).state

    def test_selection_manifest_is_written_exclusively_and_its_sidecar_matches(self):
        ev = evidence_tmp()
        digest = db_cases.write_selection_manifest(ev, ("G2C1-DBT-02",), SCRATCH)
        before = (ev / "selection.json").read_bytes()
        self.assertEqual((ev / "selection.json.sha256").read_text(), f"{digest}  selection.json\n")
        self.assertEqual(hashlib.sha256(before).hexdigest(), digest)
        with self.assertRaises(db_cases.SelectionRefused):
            db_cases.write_selection_manifest(ev, ("G2C1-DBT-03",), SCRATCH)
        self.assertEqual((ev / "selection.json").read_bytes(), before)
        link_dir = evidence_tmp()
        (link_dir / "selection.json").symlink_to(ev / "selection.json")
        with self.assertRaises(db_cases.SelectionRefused):
            db_cases.write_selection_manifest(link_dir, ("G2C1-DBT-03",), SCRATCH)


class A10SourceIdentity(unittest.TestCase):
    """L-6 / owner section 9: selection.json binds the executing source; enabled execution needs an owner-approved source table that the executing
    source matches; an UNVERIFIED source (for example a Git-less export) records a null commit and is refused for enabled execution."""
    SOURCES = ("db/migrations/0011_g2c1_funding_ledger.sql", "fixtures/g2c1_synthetic.json", "services/api/app/domain/g2_db/ledger/__init__.py",
               "services/api/app/domain/g2_db/tools/g2c1_durable_cluster.sh", "services/api/app/domain/g2_db/ledger/canonical.py", "services/api/app/domain/g2_db/ledger/manifest.py", "services/api/app/domain/g2_db/ledger/reconcile.py",
               "services/api/app/domain/g2_db/ledger/replay.py", "services/api/app/domain/g2_db/ledger/retry.py", "services/api/app/domain/g2_db/ledger/snapshot.py",
               "services/api/app/domain/g2_db/ledger/tests/db_cases.py")

    def enabled(self, table, **kw):
        stub = LaunchStub(out="")
        ev = evidence_tmp()
        with self.assertRaises(snapshot.LaunchRefused) as ctx:
            db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-19", evidence_dir=ev, run=stub, approved_source=table, **kw)
        self.assertEqual((stub.calls, list(ev.iterdir())), ([], []))          # refused before the manifest and before any launch
        return ctx.exception

    def test_git_blob_identifiers_are_computed_from_content(self):
        self.assertEqual(db_cases.git_blob_id(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a")
        self.assertEqual(db_cases.git_blob_id(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")

    def test_executing_sources_are_the_harness_files_and_run_time_inputs_with_independently_computed_digests(self):
        got = db_cases.executing_sources()
        self.assertEqual(sorted(got), sorted(self.SOURCES))
        for rel, row in got.items():
            data = (ROOT / rel).read_bytes()
            self.assertEqual(row, {"sha256": hashlib.sha256(data).hexdigest(), "blob": hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()})

    def test_an_unverified_source_records_a_null_commit_and_is_allowed_offline_only(self):
        ident = db_cases.unverified_source_identity()
        self.assertEqual((ident["status"], ident["commit"], ident["approved_source_table_sha256"]), ("UNVERIFIED", None, None))
        ev = evidence_tmp()
        db_cases.write_selection_manifest(ev, ("G2C1-DBT-02",), SCRATCH)
        doc = json.loads((ev / "selection.json").read_text())
        self.assertEqual((doc["source_identity"]["status"], doc["source_identity"]["commit"]), ("UNVERIFIED", None))
        err = self.enabled(None)
        self.assertIsInstance(err, db_cases.SourceIdentityRefused)
        self.assertIn("UNVERIFIED", str(err))
        stderr, stdout = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            self.assertEqual(db_cases.main(["--db", SCRATCH, "--cases", "G2C1-DBT-02"]), 0)
        self.assertIn("SOURCE IDENTITY: UNVERIFIED (no commit)", stderr.getvalue())

    def test_a_bound_run_writes_the_full_binding_before_any_launch(self):
        table = approved_source_table()
        raw = table.read_bytes()
        seen = []
        original = db_cases.CASES[:]
        ev = evidence_tmp()
        try:
            db_cases.CASES[:] = [db_cases.Case(c.case_id, c.criteria, c.title, (lambda cid: lambda db: seen.append(sorted(x.name for x in ev.iterdir())))(c.case_id), c.inject, c.hold, c.original) for c in original]
            report = db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-02", evidence_dir=ev, run=LaunchStub(), approved_source=table)
        finally:
            db_cases.CASES[:] = original
        self.assertEqual(seen, [["selection.json", "selection.json.sha256"]])
        self.assertEqual({r["case_id"]: r["status"] for r in report}["G2C1-DBT-02"], "PASS")
        doc = json.loads((ev / "selection.json").read_text())
        self.assertEqual(sorted(doc), ["database", "registry_sha256", "runner_sha256", "schema", "selectable_maximum", "selected", "source_identity"])
        self.assertEqual((doc["schema"], doc["selected"], doc["database"], doc["registry_sha256"], doc["runner_sha256"]),
                         (2, ["G2C1-DBT-02"], SCRATCH, snapshot.REGISTRY_SHA256, snapshot.RUNNER_SHA256))
        ident = doc["source_identity"]
        self.assertEqual((ident["status"], ident["commit"], ident["approved_source_table_sha256"], ident["runner_sha256"]),
                         ("BOUND", "1" * 40, hashlib.sha256(raw).hexdigest(), snapshot.RUNNER_SHA256))
        self.assertEqual(ident["files"], db_cases.executing_sources())
        digest = hashlib.sha256((ev / "selection.json").read_bytes()).hexdigest()
        self.assertEqual((ev / "selection.json.sha256").read_text(), f"{digest}  selection.json\n")

    def test_every_mismatch_or_malformation_of_the_approved_table_refuses_before_any_launch(self):
        good = json.loads(approved_source_table().read_text())
        some = sorted(good["files"])[0]

        def variant(**kw):
            t = json.loads(json.dumps(good))
            t.update(kw)
            return t

        def with_file(rel, row):
            t = json.loads(json.dumps(good))
            t["files"][rel] = row
            return t
        mutated = {
            "sha256 differs": with_file(some, {"sha256": "0" * 64, "blob": good["files"][some]["blob"]}),
            "blob differs": with_file(some, {"sha256": good["files"][some]["sha256"], "blob": "0" * 40}),
            "extra file": with_file("services/api/app/domain/g2_db/ledger/extra.py", good["files"][some]),
            "missing file": variant(files={k: v for k, v in good["files"].items() if k != some}),
            "runner differs": variant(runner_sha256="0" * 64), "registry differs": variant(registry_sha256="0" * 64),
            "unknown key": variant(extra="x"), "wrong schema": variant(schema="other"), "short commit": variant(commit="1" * 39), "upper-case commit": variant(commit="A" * 40),
            "non-string commit": variant(commit=None), "files not a dict": variant(files=[]), "empty files": variant(files={}), "row with extra key": with_file(some, {**good["files"][some], "x": 1}),
            "upper-case sha": with_file(some, {"sha256": good["files"][some]["sha256"].upper(), "blob": good["files"][some]["blob"]}),
        }
        for name, table in mutated.items():
            path = evidence_tmp() / "t.json"
            path.write_text(json.dumps(table))
            with self.subTest(name=name):
                self.assertIsInstance(self.enabled(path), db_cases.SourceIdentityRefused)
        base = evidence_tmp()
        dup = base / "dup.json"
        dup.write_text(json.dumps(good).replace('"schema"', '"schema": "x", "schema"', 1))
        big = base / "big.json"
        big.write_text(json.dumps(good) + " " * 70000)
        junk = base / "junk.json"
        junk.write_text("not json")
        real = base / "real.json"
        real.write_text(json.dumps(good))
        link = base / "link.json"
        link.symlink_to(real)
        for name, path in {"duplicate keys": dup, "oversize": big, "not json": junk, "symbolic link": link, "directory": base, "missing": base / "none.json", "empty path": "", "int": 5}.items():
            with self.subTest(name=name):
                self.assertIsInstance(self.enabled(path), db_cases.SourceIdentityRefused)
        for bad in (None,):
            self.assertIsInstance(self.enabled(bad), db_cases.SourceIdentityRefused)

    def test_main_binds_and_refuses_through_the_command_line(self):
        table = approved_source_table()
        stderr, stdout = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            self.assertEqual(db_cases.main(["--db", SCRATCH, "--cases", "G2C1-DBT-02", "--approved-source", str(table)]), 0)
        self.assertIn("BOUND to the approved table, commit " + "1" * 40, stderr.getvalue())
        with mock.patch.dict(os.environ, {db_cases.ENABLE_ENV: db_cases.ENABLE_VALUE}), mock.patch.object(db_cases, "run_all", return_value=[]) as spy, \
                contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(db_cases.main(["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02", "--evidence-dir", str(evidence_tmp()), "--approved-source", str(table)]), 0)
        self.assertEqual((spy.call_args.kwargs["approved_source"], spy.call_args.kwargs["enabled"], spy.call_args.kwargs["cases"]), (str(table), True, ("G2C1-DBT-02",)))
        bad = evidence_tmp() / "bad.json"
        bad.write_text(json.dumps({**json.loads(table.read_text()), "runner_sha256": "0" * 64}))
        for argv in (["--db", SCRATCH, "--cases", "G2C1-DBT-02", "--approved-source", str(bad)], ["--db", SCRATCH, "--enable", "--cases", "G2C1-DBT-02", "--evidence-dir", str(evidence_tmp())],
                     ["--db", SCRATCH, "--cases", "G2C1-DBT-02", "--approved-source"], ["--db", SCRATCH, "--approved-source", str(table), "--approved-source", str(table)]):
            with self.subTest(argv=argv[2:]), contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(db_cases.main(argv), 2)

    def test_no_commit_identifier_is_built_into_the_harness_sources(self):
        for path in (SNAPSHOT_PY, DB_CASES_PY):
            text = path.read_text(encoding="utf-8")
            self.assertEqual([m for m in re.findall(r"(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])", text)], [], path.name)        # no approved commit or blob id is hardcoded



# ======================================================================================================================================
# A11 (SIM-ENG-003-G2C1-A11), source-only, offline: V10 F-01 (argument-vector snapshot), F-02 (canonical registry digest) and the fourteen V10 real
# mutation gaps. Stub process runners only: no database, no PostgreSQL, no SQL, no network. Developer regression tests, NOT independent acceptance.
# ======================================================================================================================================
import dataclasses


class StatefulIndex(list):
    """V10 F-01 reproduction: shows the acceptance database and admin role while being validated, then something else."""

    def __init__(self, first, later):
        super().__init__(first)
        self.reads, self.later = 0, later

    def __getitem__(self, i):
        self.reads += 1
        return list.__getitem__(self, i) if self.reads <= 6 else self.later[i]


class StatefulIter(list):
    """V10 F-01 reproduction: iterates as one command the first time and as another afterwards."""

    def __init__(self, first, later):
        super().__init__(first)
        self.passes, self.later = 0, later

    def __iter__(self):
        self.passes += 1
        return iter(list(list.__iter__(self)) if self.passes == 1 else self.later)


class Liar(str):
    """A string subclass that claims equality with everything (V10 EN-20)."""

    def __eq__(self, other):
        return True

    __hash__ = str.__hash__


class A11ArgumentIntegrity(unittest.TestCase):
    """F-01: exact list or tuple only, captured once; the validated values are the launched values; refusals launch nothing."""

    def call(self):
        return a_call("alloc_event_count", a="a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")

    def test_exact_list_and_tuple_are_accepted_and_launched_exactly(self):
        for container in (list, tuple):
            stub = LaunchStub(out="1\n")
            c = self.call()
            snapshot.launch_runner(container(["psql", SCRATCH, "g2_scratch_admin", "-At", "-c", c]), run=stub, label="a11-ok")
            self.assertEqual(stub.calls[0][0][1:5], ["psql", SCRATCH, "g2_scratch_admin", "-At"])
            stub = LaunchStub()
            snapshot.launch_runner(container(["status"]), run=stub, label="a11-ok2")
            self.assertEqual(stub.calls[0][0][1:], ["status"])

    def test_subclasses_and_stateful_containers_are_refused_before_any_read_matters(self):
        c = self.call()
        good = ["psql", SCRATCH, "g2_scratch_admin", "-At", "-c", c]

        class PlainList(list):
            pass

        class PlainTuple(tuple):
            pass

        class LenLiar(list):
            def __len__(self):
                return 1
        vectors = [PlainList(good), PlainTuple(good), LenLiar(good),
                   StatefulIndex(good, ["psql", "postgres", "postgres", "-At", "-c", c]),                     # conflicting database and role
                   StatefulIndex(["bootstrap", SCRATCH], ["crash-kill", SCRATCH]),                          # conflicting command
                   StatefulIter(["bootstrap", SCRATCH], ["crash-kill"]), StatefulIter(good, ["psql", "postgres", "postgres", "-c", c]),
                   StatefulIter(["status"], ["init"]), (x for x in good), iter(good), {"psql": 1}, "psql", None, b"psql"]
        for v in vectors:
            for kw in ({}, {"allow_injection": True}, {"allow_control": True}):
                stub = LaunchStub()
                with self.subTest(vector=type(v).__name__, kw=kw), self.assertRaises(snapshot.LaunchRefused):
                    snapshot.launch_runner(v, run=stub, label="a11-sub", **kw)
                self.assertEqual(stub.calls, [])
            with self.subTest(classify=type(v).__name__), self.assertRaises(snapshot.LaunchRefused):
                snapshot.classify_runner_command(v)

    def test_element_and_option_types_are_exact(self):
        c = self.call()
        for args in (["psql", Liar(SCRATCH), "g2_scratch_admin", "-At", "-c", c], [Liar("psql"), SCRATCH, "g2_scratch_admin", "-c", c], [Liar("status")],
                     ["psql", SCRATCH, Liar("g2_scratch_admin"), "-c", c], ["psql", SCRATCH, "g2_scratch_admin", Liar("-At"), "-c", c], ["status", 1], ["status", None],
                     ["psql", SCRATCH, "g2_scratch_admin", "-c", [c]], ["psql", SCRATCH, "g2_scratch_admin", "-c", (c,)]):
            stub = LaunchStub()
            with self.subTest(args=[type(a).__name__ for a in args]), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(args, run=stub, label="a11-type")
            self.assertEqual(stub.calls, [])
        post = a_call("post_call", fn="post_funding", alloc="a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", ver=1, amt="1.00", auth="A", key="K")
        for kw in ({"pgoptions": Liar(db_cases.SERIALIZABLE)}, {"pgoptions": 5}, {"label": Liar("ok")}, {"timeout": True}, {"timeout": "10"}, {"timeout": -1}, {"timeout": 0},
                   {"timeout": 10 ** 9}, {"allow_injection": 1}, {"allow_control": "yes"}, {"allow_injection": None}):
            stub = LaunchStub()
            with self.subTest(kw=kw), self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["psql", SCRATCH, "authority_svc", "-At", "-c", post], run=stub, **({"label": "a11-opt"} | kw))
            self.assertEqual(stub.calls, [])
        for params in ({"a": Liar("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")}, {"a": ["x"]}, {"a": {"x": 1}}, {Liar("a"): "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"}):
            with self.subTest(params=str(params)[:40]), self.assertRaises(snapshot.PayloadRefused):
                snapshot.RegisteredCall("alloc_event_count", params)

    def test_mutating_the_callers_list_after_validation_does_not_change_what_is_launched(self):
        c = self.call()
        args = ["psql", SCRATCH, "g2_scratch_admin", "-At", "-c", c]
        real_check = snapshot.check_runner

        def mutate_then_check(*a, **k):                     # runs AFTER validation and BEFORE dispatch
            args[1], args[2], args[0] = "postgres", "postgres", "init"
            args.append("-f")
            return real_check(*a, **k)
        stub = LaunchStub(out="1\n")
        with mock.patch.object(snapshot, "check_runner", side_effect=mutate_then_check):
            snapshot.launch_runner(args, run=stub, label="a11-mut")
        self.assertEqual(stub.calls[0][0][1:4], ["psql", SCRATCH, "g2_scratch_admin"])
        self.assertNotIn("-f", stub.calls[0][0])
        args2 = ["psql", SCRATCH, "g2_scratch_admin", "-At", "-c", self.call()]

        def mutate_in_run(argv, **kw):
            args2[1] = "postgres"
            return subprocess.CompletedProcess(argv, 0)
        seen = []
        snapshot.launch_runner(args2, run=lambda argv, **kw: (seen.append(list(argv)), mutate_in_run(argv, **kw))[1], label="a11-mut2")
        self.assertEqual(seen[0][2], SCRATCH)

    def test_the_pin_override_is_gone_and_the_runner_hash_is_still_verified(self):
        import inspect
        self.assertNotIn("pin", inspect.signature(snapshot.launch_runner).parameters)
        stub = LaunchStub()
        with self.assertRaises(TypeError):
            snapshot.launch_runner(["status"], run=stub, label="a11-pin", pin="0" * 64)
        other = new_scratch("g2c1pin") / "g2c1_durable_cluster.sh"                        # approved name, other bytes: refused by the hash
        other.write_text("#!/usr/bin/bash -p\nexit 0\n")
        other.chmod(0o755)
        with self.assertRaises(snapshot.LaunchRefused):                                   # a file with another hash cannot be launched
            snapshot.launch_runner(["status"], run=stub, label="a11-pin2", runner=other)
        copy_ = new_scratch("g2c1pin") / "g2c1_durable_cluster.sh"
        copy_.write_bytes(RUNNER.read_bytes())
        copy_.chmod(0o755)
        snapshot.launch_runner(["status"], run=stub, label="a11-pin3", runner=copy_)     # only the approved bytes launch
        self.assertEqual(len(stub.calls), 1)


FIXTURE_REGISTRY_TEXT = ('{"encoding":"g2c1-registry-v2","operations":[{"fields":1,"mutates":"none","name":"alpha","options_ok":false,'
                         '"parameter_schema":[["a","uuid"]],"role":"g2_scratch_admin","statements":1,"template":"select {{a:uuid}};"},'
                         '{"fields":null,"mutates":"x","name":"beta","options_ok":true,"parameter_schema":[["n","int"],["x","text"]],'
                         '"role":"authority_svc","statements":1,"template":"select {{x:text}}, {{n:int}};"}]}')
FIXTURE_REGISTRY_SHA256 = "5a7f534dd1fea0e22b042b58940cef72d127dff9863b667d05bda93cfe258520"   # computed independently with coreutils sha256sum


def fixture_ops():
    return [snapshot.Operation("alpha", "g2_scratch_admin", "select {{a:uuid}};", 1, 1, "none", False),
            snapshot.Operation("beta", "authority_svc", "select {{x:text}}, {{n:int}};", 1, None, "x", True)]


class A11RegistryDigest(unittest.TestCase):
    """F-02: a canonical, versioned, unambiguous registry encoding that covers every security-relevant field, tested against a fixed known answer."""

    def test_the_known_answer_vector(self):
        self.assertEqual(hashlib.sha256(FIXTURE_REGISTRY_TEXT.encode("ascii")).hexdigest(), FIXTURE_REGISTRY_SHA256)
        self.assertEqual(snapshot.canonical_registry_bytes(fixture_ops()).decode("ascii"), FIXTURE_REGISTRY_TEXT)
        self.assertEqual(snapshot.registry_digest(fixture_ops()), FIXTURE_REGISTRY_SHA256)
        self.assertEqual(snapshot.registry_digest(list(reversed(fixture_ops()))), FIXTURE_REGISTRY_SHA256)       # canonical operation order

    def test_every_security_relevant_field_changes_the_digest_on_its_own(self):
        a, b = fixture_ops()
        changes = {"name": "alpha2", "role": "drawbridge_reader", "template": "select {{a:uuid}} ;", "statements": 2, "fields": 2, "options_ok": True, "mutates": "rows"}
        for field, value in changes.items():
            with self.subTest(field=field):
                self.assertNotEqual(snapshot.registry_digest([dataclasses.replace(a, **{field: value}), b]), FIXTURE_REGISTRY_SHA256)
        with self.subTest(field="fields None vs 1"):
            self.assertNotEqual(snapshot.registry_digest([dataclasses.replace(a, fields=None), b]), FIXTURE_REGISTRY_SHA256)
        with self.subTest(field="parameter_schema"):                                     # same text length, different slot type
            rec = snapshot.operation_record(dataclasses.replace(a, template="select {{a:text}};"))
            self.assertEqual(rec["parameter_schema"], [["a", "text"]])
            self.assertNotEqual(snapshot.registry_digest([dataclasses.replace(a, template="select {{a:text}};"), b]), FIXTURE_REGISTRY_SHA256)
        self.assertEqual(sorted(snapshot.operation_record(a)), ["fields", "mutates", "name", "options_ok", "parameter_schema", "role", "statements", "template"])
        self.assertIn(b'"encoding":"g2c1-registry-v2"', snapshot.canonical_registry_bytes([a]))

    def test_ambiguous_concatenations_do_not_collide(self):
        x = snapshot.Operation("op", "ab", "c", 1, None, "none")
        y = snapshot.Operation("op", "a", "bc", 1, None, "none")
        self.assertEqual(x.role + x.template, y.role + y.template)
        self.assertNotEqual(snapshot.registry_digest([x]), snapshot.registry_digest([y]))
        p = snapshot.Operation("op", "r", "t", 1, 1, "none")
        q = snapshot.Operation("op", "r", "t", 11, None, "none")
        self.assertNotEqual(snapshot.registry_digest([p]), snapshot.registry_digest([q]))

    def test_field_types_are_stable_and_wrong_types_are_refused(self):
        a = fixture_ops()[0]
        for field, value in (("statements", True), ("statements", "1"), ("fields", "1"), ("fields", True), ("options_ok", 0), ("name", 5), ("mutates", None), ("role", b"x")):
            with self.subTest(field=field, value=value), self.assertRaises(snapshot.PayloadRefused):
                snapshot.registry_digest([dataclasses.replace(a, **{field: value})])

    def test_the_production_registry_matches_its_pin_and_a_tampered_field_is_refused_at_launch(self):
        self.assertEqual(snapshot.registry_digest(), snapshot.REGISTRY_SHA256)
        real = dict(snapshot.OPERATIONS)
        target = real["alloc_event_count"]
        for field, value in (("template", "delete from drawbridge_auth.allocation_event where allocation_id={{a:uuid}};"), ("role", "authority_svc"),
                             ("options_ok", True), ("statements", 1), ("fields", None), ("mutates", "rows"), ("name", "alloc_event_count")):
            if getattr(target, field) == value:
                continue
            variant = {**real, "alloc_event_count": dataclasses.replace(target, **{field: value})}
            with self.subTest(field=field), mock.patch.object(snapshot, "OPERATIONS", types.MappingProxyType(variant)):
                call = object.__new__(snapshot.RegisteredCall)
                object.__setattr__(call, "_name", "alloc_event_count")
                object.__setattr__(call, "_params", (("a", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),))
                stub = LaunchStub()
                with self.assertRaises(snapshot.LaunchRefused):
                    snapshot.launch_runner(["psql", SCRATCH, value if field == "role" else "g2_scratch_admin", "-At", "-c", call], run=stub, label="a11-dg")
                self.assertEqual(stub.calls, [])


class A11MutationGaps(unittest.TestCase):
    """The V10 real mutation gaps not already covered above (EN-20, EN-18, EN-26, EN-33, R2-12, R2-13, R2-35, R2-37, SI-14). DG-* are in
    A11RegistryDigest; WS-19 and WS-20 are in A10WorkspaceRule."""

    def test_en20_string_subclasses_are_refused_by_every_encoder_and_the_registry(self):
        hostile = Liar("post_funding); drop table drawbridge_auth.allocation_event; --")
        for kind, enc in db_cases._ENCODERS.items():
            with self.subTest(kind=kind), self.assertRaises(snapshot.PayloadRefused):
                enc(hostile)
        for kind in ("fn", "role", "account", "dir"):
            member = db_cases.ENUMS[kind][0]
            with self.subTest(member=member), self.assertRaises(snapshot.PayloadRefused):
                db_cases._ENCODERS[kind](Liar(member))                                    # even a subclass whose text IS a member
        stub = LaunchStub()
        db = db_cases.Db(SCRATCH, run=stub)
        with self.assertRaises(snapshot.PayloadRefused):
            db.call(hostile, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", 1, "1.00", "A", "K")
        self.assertEqual(stub.calls, [])

    def test_en18_an_upper_case_hex_digit_anywhere_in_a_uuid_is_refused(self):
        u = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        letters = [i for i, ch in enumerate(u) if ch in "abcdef"]
        for i in letters:
            bad = u[:i] + u[i].upper() + u[i + 1:]
            with self.subTest(position=i), self.assertRaises(snapshot.PayloadRefused):
                db_cases.sql_uuid(bad)
        self.assertEqual(db_cases.sql_uuid(u), f"'{u}'")
        self.assertTrue(any(i < 8 for i in letters) and any(9 <= i < 13 for i in letters) and any(i > 24 for i in letters))

    def test_en26_the_payload_limit_is_exactly_one_hundred_thousand_bytes(self):
        self.assertEqual(snapshot.MAX_PAYLOAD_BYTES, 100000)
        head, tail = "select '", "';"
        fits = head + "x" * (100000 - len(head) - len(tail)) + tail
        self.assertEqual(snapshot.validate_sql_payload(fits), fits)
        with self.assertRaises(snapshot.PayloadRefused):
            snapshot.validate_sql_payload(head + "x" * (100001 - len(head) - len(tail)) + tail)

    def test_en33_render_sql_refuses_unrecognised_or_malformed_markers(self):
        for template, values in (("select {{a:bogus}};", {"a": "x"}), ("select {{a:uuid}} {{;", {"a": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"}),
                                 ("select 1 }};", {}), ("select {{A:uuid}};", {"A": "x"}), ("select {{a:uuid}};", {}), ("select {{a:uuid}};", {"a": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "b": 1}),
                                 ("select {{a:uuid}}, {{a:text}};", {"a": "x"}), ("select {{ a:uuid }};", {"a": "x"})):
            with self.subTest(template=template), self.assertRaises(snapshot.PayloadRefused):
                db_cases.render_sql(template, **values)
        self.assertEqual(db_cases.render_sql("select {{a:int}};", a=5), "select 5;")

    def test_r2_12_r2_13_evidence_directory_owner_and_every_access_bit(self):
        table = approved_source_table()
        for mode in (0o701, 0o702, 0o704, 0o705, 0o707, 0o710, 0o720, 0o740, 0o750, 0o770, 0o777):
            ev = evidence_tmp()
            os.chmod(ev, mode)
            stub = LaunchStub()
            with self.subTest(mode=oct(mode)), self.assertRaises(snapshot.LaunchRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-19", evidence_dir=ev, run=stub, approved_source=table)
            self.assertEqual((stub.calls, list(ev.iterdir())), ([], []))
            os.chmod(ev, 0o700)
        ev = evidence_tmp()
        real = os.stat

        def foreign(path, *a, **k):
            r = real(path, *a, **k)
            if os.fspath(path) == str(ev):
                return os.stat_result((r.st_mode, r.st_ino, r.st_dev, r.st_nlink, r.st_uid + 1, r.st_gid, r.st_size, int(r.st_atime), int(r.st_mtime), int(r.st_ctime)))
            return r
        stub = LaunchStub()
        with mock.patch.object(os, "stat", side_effect=foreign), self.assertRaises(snapshot.LaunchRefused):
            db_cases.prepare_evidence_dir(ev)
        with mock.patch.object(os, "stat", side_effect=foreign), self.assertRaises(snapshot.LaunchRefused):
            db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-19", evidence_dir=ev, run=stub, approved_source=table)
        self.assertEqual((stub.calls, list(ev.iterdir())), ([], []))
        self.assertEqual(db_cases.prepare_evidence_dir(ev), ev)

    def test_r2_35_a_psql_client_warning_is_kept_fail_closed(self):
        u = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        db = lambda stub: db_cases.Db(SCRATCH, run=stub, evidence_dir=evidence_tmp())   # noqa: E731
        with self.assertRaises(db_cases.CaseFailure):
            db(LaunchStub(rc=0, out="e|t|1|f\n", err="psql: warning: extra command-line argument ignored\n")).call("post_funding", u, 1, "5.00", "AUTH", "KEY")
        with self.assertRaises(db_cases.CaseFailure):
            db(LaunchStub(rc=1, out="", err="psql: warning: something\n")).call("post_funding", u, 1, "5.00", "AUTH", "KEY").state
        self.assertEqual(db_cases.parse_diagnostics("psql: warning: x\n"), ([], ["psql: warning: x"]))

    def test_r2_37_an_enabled_run_without_a_selection_is_refused_before_anything(self):
        table = approved_source_table()
        for cases in (None,):
            ev = evidence_tmp()
            stub = LaunchStub()
            with self.assertRaises(db_cases.SelectionRefused):
                db_cases.run_all(enabled=True, database=SCRATCH, cases=cases, evidence_dir=ev, run=stub, approved_source=table)
            self.assertEqual((stub.calls, list(ev.iterdir())), ([], []))

    def test_si14_the_commit_must_be_exactly_forty_lower_case_hex(self):
        good = json.loads(approved_source_table().read_text())
        for commit in ("1" * 41, "1" * 40 + "\n", "1" * 40 + "x", " " + "1" * 40, "1" * 40 + " ", "g" * 40, "1" * 39):
            path = evidence_tmp() / "t.json"
            path.write_text(json.dumps({**good, "commit": commit}))
            with self.subTest(commit=commit), self.assertRaises(db_cases.SourceIdentityRefused):
                db_cases.load_approved_source(path)
        path = evidence_tmp() / "t.json"
        path.write_text(json.dumps(good))
        self.assertEqual(db_cases.load_approved_source(path)[0]["commit"], "1" * 40)

    def test_dbt20_writes_its_artifact_beneath_the_evidence_directory_only(self):
        sim = SimulatedLedger()
        stub = LaunchStub(script=sim)
        ev = evidence_tmp()
        report = db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-20", evidence_dir=ev, run=stub, approved_source=approved_source_table())
        self.assertEqual({r["case_id"]: r["status"] for r in report}["G2C1-DBT-20"], "PASS")
        art = ev / "G2C1-DBT-20-manifest"
        self.assertEqual(stat.S_IMODE(os.lstat(art).st_mode), 0o700)
        self.assertEqual(sorted(x.name for x in art.iterdir()), sorted(x.name for x in art.iterdir() if x.name.startswith("m.json")))
        self.assertTrue((art / "m.json").is_file())
        data = (art / "m.json").read_bytes()
        self.assertTrue(db_cases.manifest.verify_manifest(data)["ok"])
        db = db_cases.Db(SCRATCH, run=LaunchStub(script=SimulatedLedger()))
        db.case_id = "G2C1-DBT-20"
        with self.assertRaises(db_cases.CaseFailure):                                    # no evidence directory: refused, never a temporary directory
            db_cases.manifest_roundtrip(db)
        ev2 = evidence_tmp()
        os.mkdir(ev2 / "G2C1-DBT-20-manifest", 0o700)                                    # an existing artifact directory is never reused
        db2 = db_cases.Db(SCRATCH, run=LaunchStub(script=SimulatedLedger()), evidence_dir=ev2)
        db2.case_id = "G2C1-DBT-20"
        with self.assertRaises(db_cases.CaseFailure):
            db_cases.manifest_roundtrip(db2)


def metadata(target: str, **changes):
    """MOCKED metadata (disclosed): os.lstat reports `changes` for exactly one path; every other path keeps its real metadata. Used where the
    state (another owner, uid 0, a setgid bit, another device) cannot be created safely without privileges."""
    import types
    real = os.lstat

    def fake(path, *a, **k):
        r = real(path, *a, **k)
        if os.fspath(path) != target:
            return r
        fields = {n: getattr(r, n) for n in ("st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns")}
        fields.update(changes)
        return types.SimpleNamespace(**fields)
    return mock.patch.object(os, "lstat", side_effect=fake)


def moved(r, **changes):
    """A copy of stat metadata as a replaced file would report it (MOCKED, disclosed)."""
    import types
    fields = {n: getattr(r, n) for n in ("st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns")}
    fields.update(changes)
    return types.SimpleNamespace(**fields)


class A12RunnerPathIntegrity(unittest.TestCase):
    """A12 F-A (V11 Medium): the caller's runner value is captured ONCE; only an exact str or the exact concrete path class of this platform is
    accepted; a refused object has none of its conversion methods called; argv[0] is the very string that was verified. Every launch goes to a
    recording stub: nothing is executed and the real runner is never started. Platform scope: Linux / PosixPath only (A12 disposition 3).
    Not claimed: protection against code already running with the harness's privileges, or against a file replaced after the final check and
    before the process starts (F-B residual)."""

    def refused(self, runner, label="a12-r"):
        stub = LaunchStub()
        with self.assertRaises(snapshot.LaunchRefused):
            snapshot.launch_runner(["status"], run=stub, runner=runner, label=label)
        self.assertEqual(stub.calls, [])

    def copy_(self, data=None, mode=0o755, name=None):
        p = evidence_tmp() / (name or snapshot.RUNNER_BASENAME)
        p.write_bytes(RUNNER.read_bytes() if data is None else data)
        p.chmod(mode)
        return p

    def test_the_v11_exploit_objects_are_refused_before_any_conversion_and_before_any_launch(self):
        approved = os.fspath(RUNNER)
        counts = {}

        def flip(key):
            def conv(_self):
                counts[key] = counts.get(key, 0) + 1
                return approved if counts[key] == 1 else "/usr/bin/id"      # the V11 shape: the approved path first, another program after
            return conv
        StrFlip = type("StrFlip", (), {"__str__": flip("obj"), "__fspath__": flip("obj")})
        PathFlip = type("PathFlip", (snapshot.CONCRETE_PATH,), {"__str__": flip("path"), "__fspath__": flip("path")})
        StrSubFlip = type("StrSubFlip", (str,), {"__str__": flip("str"), "__fspath__": flip("str")})
        objects = (StrFlip(), PathFlip(approved), StrSubFlip(approved))
        counts.clear()
        for obj in objects:
            with self.subTest(kind=type(obj).__name__):
                self.refused(obj)
        self.assertEqual(counts, {})                                         # not one conversion was asked of any of them

    def test_other_path_like_objects_subclasses_and_other_types_are_refused(self):
        from pathlib import PurePosixPath
        approved = os.fspath(RUNNER)
        calls = []

        class Like(os.PathLike):
            def __fspath__(self):
                calls.append(1)
                return approved

        class Liar(str):
            def __eq__(self, other):
                return True

            def __ne__(self, other):
                return False

            def __hash__(self):
                return hash(approved)
        PlainPathSub = type("PlainPathSub", (snapshot.CONCRETE_PATH,), {})
        PlainStrSub = type("PlainStrSub", (str,), {})
        for obj in (Like(), PlainPathSub(approved), PlainStrSub(approved), Liar(approved), approved.encode(), None, 7,
                    PurePosixPath(approved), [approved], (approved,)):
            with self.subTest(obj=f"{type(obj).__name__}"):
                self.refused(obj)
        self.assertEqual(calls, [])

    def test_exact_str_and_exact_concrete_path_launch_exactly_the_verified_string(self):
        approved = os.fspath(RUNNER)
        self.assertIs(type(RUNNER), snapshot.CONCRETE_PATH)
        self.assertIsNot(snapshot.CONCRETE_PATH, Path)                       # Path() builds the concrete class; a `type(x) is Path` rule refuses every path
        for runner in (RUNNER, approved, Path(approved)):
            stub = LaunchStub()
            snapshot.launch_runner(["status"], run=stub, runner=runner, label="a12-ok")
            argv0 = stub.calls[0][0][0]
            self.assertIs(type(argv0), str)
            self.assertEqual(argv0, approved)
        self.assertEqual(snapshot.check_runner(approved), approved)
        copy_ = self.copy_()
        seen = []
        real = snapshot.check_runner

        def spy(*a, **k):
            r = real(*a, **k)
            seen.append(r)
            return r
        stub = LaunchStub()
        with mock.patch.object(snapshot, "check_runner", side_effect=spy):
            snapshot.launch_runner(["status"], run=stub, runner=copy_, label="a12-same")
        self.assertEqual(seen, [str(copy_)])
        self.assertIs(stub.calls[0][0][0], seen[0])                           # argv[0] IS the verified string object, not a new conversion

    def test_launch_runner_reads_the_runner_parameter_exactly_once(self):
        import ast
        import inspect
        import textwrap
        fn = ast.parse(textwrap.dedent(inspect.getsource(snapshot.launch_runner))).body[0]
        uses = [n for n in ast.walk(fn) if isinstance(n, ast.Name) and n.id == "runner"]
        self.assertEqual(len(uses), 1)
        checks = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "check_runner"]
        self.assertEqual(len(checks), 1)
        self.assertIs(checks[0].args[0], uses[0])

    def test_file_conditions_are_refused_each_on_its_own(self):
        good = self.copy_()
        snapshot.launch_runner(["status"], run=LaunchStub(), runner=good, label="a12-good")
        name = snapshot.RUNNER_BASENAME
        cases = {
            "wrong file name (byte-identical)": self.copy_(name="runner.sh"),
            "wrong hash": self.copy_(data=RUNNER.read_bytes() + b"#\n"),
            "not executable": self.copy_(mode=0o644),
            "missing": evidence_tmp() / name,
        }
        link = evidence_tmp() / name
        link.symlink_to(good)
        cases["final component is a symbolic link"] = link
        alias = evidence_tmp() / "alias"
        alias.symlink_to(good.parent)
        cases["intermediate component is a symbolic link"] = alias / name
        d = str(good.parent)
        cases["dot component"] = d + "/./" + name
        cases["doubled separator"] = d + "//" + name
        cases["dot-dot component"] = d + "/../" + good.parent.name + "/" + name
        cases["relative"] = name
        cases["empty"] = ""
        cases["NUL"] = d + "/" + name + chr(0)
        for why, runner in cases.items():
            with self.subTest(why):
                self.refused(runner)

    def test_an_executable_or_content_change_between_launches_is_seen_by_the_next_launch(self):
        good = self.copy_()
        snapshot.launch_runner(["status"], run=LaunchStub(), runner=good, label="a12-x1")
        good.chmod(0o644)
        self.refused(good, "a12-x2")
        good.chmod(0o755)
        snapshot.launch_runner(["status"], run=LaunchStub(), runner=good, label="a12-x3")
        good.write_bytes(RUNNER.read_bytes() + b"#\n")
        self.refused(good, "a12-x4")

    def test_the_runner_is_opened_without_following_links_and_checked_against_its_own_descriptor(self):
        good = self.copy_()
        flags = []
        real_open = os.open

        def spy(path, fl, *a, **k):
            if os.fspath(path) == str(good):
                flags.append(fl)
            return real_open(path, fl, *a, **k)
        with mock.patch.object(os, "open", side_effect=spy):
            snapshot.launch_runner(["status"], run=LaunchStub(), runner=good, label="a12-nf")
        self.assertEqual(len(flags), 1)
        self.assertTrue(flags[0] & os.O_NOFOLLOW and flags[0] & os.O_CLOEXEC)
        self.assertEqual(flags[0] & (os.O_WRONLY | os.O_RDWR), 0)

    def test_a_file_replaced_during_verification_is_refused(self):
        """MOCKED metadata (disclosed). A descriptor that is not the checked file, or a path that names a different file (inode, size or
        modification time) after hashing, is refused before any launch. This detects a replacement that already happened by the re-check. It
        does NOT show, and A12 does not claim, protection against a replacement after the final check and before the process starts (F-B)."""
        good = self.copy_()
        real_fstat, real_lstat, real_open = os.fstat, os.lstat, os.open
        with mock.patch.object(os, "fstat", side_effect=lambda fd: moved(real_fstat(fd), st_ino=real_fstat(fd).st_ino + 1)):
            self.refused(good, "a12-i1")
        for change in ("st_ino", "st_size", "st_mtime_ns", "st_mode"):
            opened = []

            def spy_open(path, fl, *a, **k):
                if os.fspath(path) == str(good):
                    opened.append(1)
                return real_open(path, fl, *a, **k)

            def after_open(path, *a, **k):
                r = real_lstat(path, *a, **k)
                if opened and os.fspath(path) == str(good):
                    return moved(r, **{change: getattr(r, change) + 1})
                return r
            with self.subTest(change), mock.patch.object(os, "open", side_effect=spy_open), mock.patch.object(os, "lstat", side_effect=after_open):
                self.refused(good, "a12-i2")
        snapshot.launch_runner(["status"], run=LaunchStub(), runner=good, label="a12-i3")      # the same file, unmocked, still launches


class A12WorkspaceCoverage(unittest.TestCase):
    """A12 F-C (V11 mutants WS-home-owner and WS-sticky-any; developer mutants C3-11 and W-13, whose earlier 'equivalent' classification is
    WITHDRAWN as incorrect): each rule is shown by its actual refusal with the root otherwise valid, and nothing is created on refusal.
    METHOD per test: 'mocked' = os.lstat metadata from `metadata()`; 'real' = a real directory state inside the private sandbox home."""

    def refused(self, home):
        with self.assertRaises(RuntimeError):
            workspace_root(home=home, environ={})

    def accepted(self, home):
        self.assertEqual(str(workspace_root(home=home, environ={})), os.path.join(home, APPROVED_SCRATCH_NAME))

    def test_mocked_home_owned_by_uid_0_is_refused_and_creates_nothing(self):
        self.assertNotEqual(os.geteuid(), 0)                                  # the suite never runs as uid 0
        home, base = fake_home()
        with metadata(home, st_uid=0):
            self.refused(home)
        self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))

    def test_mocked_home_owned_by_the_system_owner_or_another_uid_is_refused(self):
        for owner in {os.lstat("/").st_uid, os.geteuid() + 1} - {os.geteuid()}:
            home, base = fake_home()
            with self.subTest(owner=owner), metadata(home, st_uid=owner):
                self.refused(home)
            self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))

    def test_real_home_owned_by_the_executing_uid_is_accepted(self):
        home, base = fake_home()
        self.assertEqual(os.lstat(home).st_uid, os.geteuid())
        self.accepted(home)

    def test_mocked_setgid_group_writable_parent_is_refused_and_a_sticky_world_writable_parent_is_the_control(self):
        home, base = fake_home()
        with metadata(str(base), st_mode=stat.S_IFDIR | 0o2770):
            self.refused(home)
        self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))
        with metadata(str(base), st_mode=stat.S_IFDIR | 0o2750):              # setgid alone, not writable by group: acceptable
            self.accepted(home)
        home, base = fake_home()
        with metadata(str(base), st_mode=stat.S_IFDIR | 0o1777):              # sticky world-writable (a shared temporary directory): the control
            self.accepted(home)

    def test_real_setgid_group_writable_parent_is_refused(self):
        home, base = fake_home()
        os.chmod(base, 0o2770)
        try:
            self.refused(home)
            self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))
        finally:
            os.chmod(base, 0o700)

    def test_mocked_root_owned_by_another_uid_is_refused_and_left_untouched(self):
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        os.mkdir(root, 0o700)
        with metadata(root, st_uid=os.geteuid() + 1):
            self.refused(home)
        self.assertEqual(os.listdir(root), [])

    def test_real_root_modes_0750_0711_01700_are_refused_and_left_unchanged(self):
        for mode in (0o750, 0o711, 0o1700):
            home, base = fake_home()
            root = os.path.join(home, APPROVED_SCRATCH_NAME)
            os.mkdir(root, 0o700)
            os.chmod(root, mode)
            with self.subTest(mode=oct(mode)):
                self.refused(home)
                self.assertEqual(stat.S_IMODE(os.lstat(root).st_mode), mode)
                self.assertEqual(os.listdir(root), [])

    def test_real_home_modes_0777_and_0770_are_refused(self):
        for mode in (0o777, 0o770):
            home, base = fake_home()
            os.chmod(home, mode)
            with self.subTest(mode=oct(mode)):
                self.refused(home)
                self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))
                self.assertEqual(stat.S_IMODE(os.lstat(home).st_mode), mode)

    def test_real_symbolic_links_as_home_as_root_and_as_an_intermediate_component_are_refused(self):
        home, base = fake_home()
        alias = base / "home-alias"
        alias.symlink_to(home)
        with self.subTest("home"):
            self.refused(str(alias))
        home2, base2 = fake_home()
        target = base2 / "target"
        target.mkdir(mode=0o700)
        os.symlink(target, os.path.join(home2, APPROVED_SCRATCH_NAME))
        with self.subTest("root"):
            self.refused(home2)
        self.assertEqual(os.listdir(target), [])
        base3 = evidence_tmp()
        inner = base3 / "inner"
        inner.mkdir(mode=0o700)
        (inner / "home").mkdir(mode=0o700)
        link = base3 / "inner-link"
        link.symlink_to(inner)
        with self.subTest("intermediate"):
            self.refused(str(link / "home"))
        self.assertFalse(os.path.exists(inner / "home" / APPROVED_SCRATCH_NAME))


class A12IsolationIdentity(unittest.TestCase):
    """A12 F-D and F-I (owner decision: a fresh isolated sandbox HOME per offline run; no deletion). The executing account must be unambiguous
    (real UID equals effective UID) and the root must lie on the verified home's own filesystem. A later run in the same home STOPs."""

    def test_differing_real_and_effective_uids_are_refused_by_the_workspace_and_by_the_launcher(self):
        """MOCKED os.getuid (disclosed)."""
        home, base = fake_home()
        stub = LaunchStub()
        with mock.patch.object(os, "getuid", return_value=os.geteuid() + 1):
            with self.assertRaises(RuntimeError):
                workspace_root(home=home, environ={})
            with self.assertRaises(snapshot.LaunchRefused):
                snapshot.verified_home()
            with self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["status"], run=stub, label="a12-uid")
        self.assertEqual(stub.calls, [])
        self.assertFalse(os.path.exists(os.path.join(home, APPROVED_SCRATCH_NAME)))
        # The other direction (MOCKED os.geteuid): the real UID's own home would pass every other launcher check, so only the UID rule refuses.
        stub = LaunchStub()
        with mock.patch.object(os, "geteuid", return_value=os.getuid() + 1):
            with self.assertRaises(snapshot.LaunchRefused):
                snapshot.verified_home()
            with self.assertRaises(snapshot.LaunchRefused):
                snapshot.launch_runner(["status"], run=stub, label="a12-euid")
        self.assertEqual(stub.calls, [])

    def test_a_root_on_another_filesystem_than_the_home_is_refused(self):
        """MOCKED st_dev (disclosed)."""
        home, base = fake_home()
        root = os.path.join(home, APPROVED_SCRATCH_NAME)
        os.mkdir(root, 0o700)
        with metadata(root, st_dev=os.lstat(home).st_dev + 1):
            with self.assertRaises(RuntimeError):
                workspace_root(home=home, environ={})
        self.assertEqual(os.listdir(root), [])
        self.assertEqual(str(workspace_root(home=home, environ={})), root)

    def test_this_run_is_one_account_and_its_root_shares_the_home_filesystem(self):
        """REAL: the running sandbox."""
        root, home = str(workspace_root()), snapshot.verified_home()
        self.assertEqual(os.getuid(), os.geteuid())
        self.assertEqual(os.lstat(root).st_dev, os.lstat(home).st_dev)
        self.assertEqual(os.path.dirname(root), home)

    def test_a_later_run_in_the_same_home_stops_and_deletes_nothing(self):
        """REAL directories; the 'later run' is a fresh record of created entries, as a new process would have."""
        home, base = fake_home()
        root = str(workspace_root(home=home, environ={}))
        made = tempfile.mkdtemp(dir=root)
        _CREATED[root].add(os.path.basename(made))
        saved = _CREATED.pop(root)
        try:
            with self.assertRaises(RuntimeError) as ctx:
                workspace_root(home=home, environ={})
            self.assertIn("STOP", str(ctx.exception))
            self.assertTrue(os.path.isdir(made))
            self.assertEqual(os.listdir(root), [os.path.basename(made)])
        finally:
            _CREATED[root] = saved


ESCAPE_REGISTRY_SHA256 = "122715fd51701023a4030061a611bf193ebcbe2d9f6313b99b935efc5d005203"   # coreutils sha256sum of escape_registry_bytes()


def escape_registry_bytes() -> bytes:
    """The canonical encoding of `escape_ops()`, written by hand from ASCII pieces (chr(92) is the backslash, chr(34) the double quote), with no
    use of json or of the encoder under test: escaped quote and backslash, control characters, non-ASCII BMP characters, a non-BMP character as
    a UTF-16 surrogate pair, a tab, the exact separators, sorted keys, operations sorted by name, and the exact encoding tag."""
    bs, q = chr(92), chr(34)

    def u(h):
        return bs + "u" + h
    mutates = "a" + bs + q + "b" + bs + bs + "c" + u("0001") + "d" + u("001f") + u("00e9") + u("2205") + u("d83d") + u("de00")
    text = ('{"encoding":"g2c1-registry-v2","operations":[{"fields":null,"mutates":"' + mutates + '","name":"g","options_ok":false,'
            '"parameter_schema":[],"role":"r","statements":1,"template":"s"},{"fields":2,"mutates":"none","name":"h","options_ok":true,'
            '"parameter_schema":[["k","int"]],"role":"q","statements":3,"template":"x' + bs + 't{{k:int}}"}]}')
    return text.encode("ascii")


def escape_ops():
    tricky = "a" + chr(34) + "b" + chr(92) + "c" + chr(1) + "d" + chr(0x1F) + chr(0xE9) + chr(0x2205) + chr(0x1F600)
    return [snapshot.Operation("h", "q", "x" + chr(9) + "{{k:int}}", 3, 2, "none", True),
            snapshot.Operation("g", "r", "s", 1, None, tricky, False)]


class A12DigestEscaping(unittest.TestCase):
    """A12 F-F (V11 DG-ascii-off): the canonical-form clause is pinned by an independently constructed known answer. The production registry
    contract is unchanged. A self-consistent digest is registry completeness only, never owner-approved source identity."""

    def test_the_independent_escaping_known_answer(self):
        expected = escape_registry_bytes()
        self.assertTrue(all(32 <= b < 127 for b in expected))
        self.assertEqual(hashlib.sha256(expected).hexdigest(), ESCAPE_REGISTRY_SHA256)
        self.assertEqual(snapshot.canonical_registry_bytes(escape_ops()), expected)
        self.assertEqual(snapshot.canonical_registry_bytes(list(reversed(escape_ops()))), expected)
        self.assertEqual(snapshot.registry_digest(escape_ops()), ESCAPE_REGISTRY_SHA256)

    def test_separators_and_the_version_tag_are_exact(self):
        data = snapshot.canonical_registry_bytes(escape_ops())
        self.assertTrue(data.startswith(b'{"encoding":"g2c1-registry-v2","operations":['))
        self.assertNotIn(b", ", data)
        self.assertNotIn(b": ", data)
        with mock.patch.object(snapshot, "REGISTRY_ENCODING", "g2c1-registry-v3"):
            self.assertNotEqual(snapshot.registry_digest(escape_ops()), ESCAPE_REGISTRY_SHA256)

    def test_inputs_that_collide_under_plain_concatenation_have_distinct_encodings(self):
        pairs = [(snapshot.Operation("ab", "c", "s", 1, None, "none", False), snapshot.Operation("a", "bc", "s", 1, None, "none", False)),
                 (snapshot.Operation("n", "r", "st", 1, None, "x", False), snapshot.Operation("n", "r", "s", 1, None, "tx", False))]
        for one, two in pairs:
            flat = lambda o: o.name + o.role + o.template + o.mutates           # noqa: E731
            self.assertEqual(flat(one), flat(two))
            self.assertNotEqual(snapshot.canonical_registry_bytes([one]), snapshot.canonical_registry_bytes([two]))
            self.assertNotEqual(snapshot.registry_digest([one]), snapshot.registry_digest([two]))

    def test_the_production_pin_and_the_a11_known_answer_are_unchanged(self):
        self.assertEqual(snapshot.REGISTRY_SHA256, "b945c97f5d2db777d0b7fc693de3ca990ba790c229f41395058ff6d9577092ee")
        self.assertEqual(snapshot.registry_digest(), snapshot.REGISTRY_SHA256)
        self.assertEqual(FIXTURE_REGISTRY_SHA256, "5a7f534dd1fea0e22b042b58940cef72d127dff9863b667d05bda93cfe258520")
        self.assertEqual(snapshot.REGISTRY_ENCODING, "g2c1-registry-v2")


class A12Dbt20Assertions(unittest.TestCase):
    """A12 F-H (V11 B6-drop-corruption-assert, B6-drop-sidecar-assert): DBT-20's own two assertions, through the real dispatcher against the
    in-test SimulatedLedger (NOT PostgreSQL; DBT-20 stays NOT RUN against any database). The case body is unchanged."""

    def run20(self):
        stub = LaunchStub(script=SimulatedLedger())
        ev = evidence_tmp()
        report = db_cases.run_all(enabled=True, database=SCRATCH, cases="G2C1-DBT-20", evidence_dir=ev, run=stub, approved_source=approved_source_table())
        return {r["case_id"]: r for r in report}["G2C1-DBT-20"], stub, ev

    def test_a_correct_run_passes_with_one_registered_submission_and_evidence_under_the_manifest_directory(self):
        row, stub, ev = self.run20()
        self.assertEqual(row["status"], "PASS", row)
        art = ev / "G2C1-DBT-20-manifest"
        self.assertEqual(sorted(x.name for x in art.iterdir()), ["m.json", "m.json.sha256"])
        data = (art / "m.json").read_bytes()
        self.assertEqual(db_cases.manifest.read_sidecar(art / "m.json"), hashlib.sha256(data).hexdigest())
        self.assertEqual(len(stub.calls), 1)
        argv = stub.calls[0][0]
        self.assertEqual(argv[1:4], ["psql", SCRATCH, snapshot.READER_ROLE])
        self.assertEqual(argv.count("-c"), 1)

    def test_a_lenient_corruption_verifier_makes_the_case_fail(self):
        with mock.patch.object(db_cases.manifest, "verify_manifest", return_value={"ok": True}):
            row, stub, ev = self.run20()
        self.assertEqual(row["status"], "FAIL")
        self.assertEqual(row["reason"], "corruption detected")

    def test_an_incorrect_sidecar_makes_the_case_fail(self):
        real = db_cases.manifest.write_manifest

        def wrong_sidecar(document, path):
            info = real(document, path)
            side = Path(str(path) + ".sha256")
            os.chmod(side, 0o600)
            side.write_text("0" * 64 + "  m.json\n", encoding="ascii")
            return info
        with mock.patch.object(db_cases.manifest, "write_manifest", side_effect=wrong_sidecar):
            row, stub, ev = self.run20()
        self.assertEqual(row["status"], "FAIL")
        self.assertEqual(row["reason"], "sidecar")


if __name__ == "__main__":
    unittest.main()
