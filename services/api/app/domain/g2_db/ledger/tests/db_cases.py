"""PREPARED database cases for G2C1 (SIM-ENG-003-G2C1). SIMULATION ONLY. NEVER EXECUTED by the builder.

Status of every case in this file: NOT RUN. These cases need the dedicated G2C1 cluster with migration 0011 applied. The cluster
is not started and 0011 is not applied in the source-only pass, so no case here has been run. They were written without being
executed and MAY CONTAIN DEFECTS. They are the builder's developer-side material, not acceptance: LOOM-2 writes and runs its own
independent tests (task D, section 7). A case that has not run proves nothing; this file reports NOT RUN until a person with the
authority to start the cluster runs it on purpose.

To run (only under a separate owner execution authorization, on the G2C1 cluster only, against the acceptance database):
    G2C1_DB_CASES=RUN_AGAINST_G2C1_CLUSTER_ONLY python3 -I -B db_cases.py --enable --db drawbridge_g2_scratch --evidence-dir <new dir>
Without both the flag and the environment variable, run_all() and main() connect to nothing and report NOT RUN.

Gate A source repair (SIM-ENG-003-G2C1-A8; source-only, nothing here was run against a database): the harness no longer starts the runner
through `bash <runner>`; every launch is direct, with an explicit environment and file-captured output (snapshot.launch_runner). The
database is never defaulted: `--db drawbridge_g2_scratch` is mandatory and any other name is refused before any launch. SQL is submitted
only as one validated `-c` argument per unit (the old `-f -` path is not used); cases that depend on streamed input, parallel sessions or
client termination are DEFERRED, and DBT-01 and DBT-24 are EXCLUDED (see HELD below). All 27 case identifiers are preserved and all 27
remain NOT RUN.

Case-selection and execution safety (A9 V02): an enabled run needs an explicit `--cases` selection (never defaulted to all cases), the whole
command is refused if any identifier is invalid, held or outside the selectable maximum of thirteen candidates (a ceiling, not an authorization),
and the exact selection is written, hashed, to the evidence directory before any launch. SQL is submitted only as REGISTERED operations
(OPERATIONS): reviewed templates with strictly typed slots. A10: the registry is enforced at the launch boundary: `launch_runner` accepts a psql
`-c` only as a RegisteredCall (operation name and typed parameters) and re-derives the SQL text itself; `Db.runner` refuses `psql`; no caller-supplied
SQL text is accepted by the governed interfaces (this does not defend against code that already runs with the harness's privileges). The target
database is validated at the command line, `run_all`, `launch_runner`, `Db.runner` and `Db.database` (read-only). Contradictory results (exit status 0 with a PostgreSQL ERROR), wrong result
shapes and incomplete evidence fail closed. Nothing here has been run against a database.

Hardening pass (LOOM-2 V01 findings F-2 to F-5): the READ COMMITTED option string, the psql diagnostic parser and the TRUNCATE
expectations were repaired, fault-injection and defect-injection cases were added, and F-1 (fresh-allocation race) has a dedicated
case. Still NOT RUN and still NOT acceptance evidence. Cases that inject faults or defects (G2C1-DBT-26, -27) run ONLY when the
operator selects a separate throwaway database with --inject-db, sets the opt-in environment variable, and the live server and a catalog marker
confirm it (see "injection gate" below); otherwise they report NOT RUN. Results are PASS, FAIL, FINDING or INCONCLUSIVE as observed. Where PostgreSQL behaviour is not yet established (which of 23505 and 40001 a SERIALIZABLE
race raises; whether a deadlock can occur) the case RECORDS what it observed and never asserts the unverified expectation, and no
deadlock-avoidance claim is made without the observed zero count over the stated iterations.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
import uuid
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
G2DB = HERE.parents[1]
ROOT = HERE.parents[6]
sys.path.insert(0, str(G2DB))

from ledger import canonical, manifest, reconcile, replay, retry, snapshot  # noqa: E402

RUNNER = G2DB / "tools" / "g2c1_durable_cluster.sh"
ENABLE_ENV = "G2C1_DB_CASES"
ENABLE_VALUE = "RUN_AGAINST_G2C1_CLUSTER_ONLY"
# psql run with `-f -` prefixes the FIRST line of a diagnostic with "psql:<file>:<line>: " (LOOM-2 V01 F-3); with VERBOSITY=verbose the
# line is "ERROR:  <SQLSTATE>: <message>". The optional prefix is accepted; the SQLSTATE and message are preserved exactly.
PREFIX = r"(?:psql:[^\n]*?:\d+:\s+)?"
ERR_RE = re.compile(r"^" + PREFIX + r"ERROR:\s+([0-9A-Z]{5}):\s+(.*)$")
DETAIL_RE = re.compile(r"^" + PREFIX + r"DETAIL:\s+(.*)$")
# Any line that LOOKS like a server or client diagnostic. If one is present and is not read by ERR_RE, the evidence is unreadable.
DIAG_RE = re.compile(r"^" + PREFIX + r"(?:ERROR|FATAL|PANIC):")
CLIENT_ERR_RE = re.compile(r"^psql: (?:error|warning):")
SERIALIZABLE = "-c default_transaction_isolation=serializable"
# libpq splits PGOPTIONS on whitespace; a backslash escapes a space. Single quotes are NOT quoting characters (LOOM-2 V01 F-2).
READ_COMMITTED = "-c default_transaction_isolation=read\\ committed"
INJECT_DB_PREFIX = "drawbridge_g2_scratch_inject"
FIXTURE = json.loads((ROOT / "fixtures/g2c1_synthetic.json").read_text(encoding="utf-8"))
PROJECT = FIXTURE["project"]["project_id"]
RUN = uuid.uuid4().hex[:8].upper()   # ledger tables are append-only: every run uses fresh references


class CaseFailure(AssertionError):
    pass


class CaseFinding(AssertionError):
    """The observed behaviour is a recorded FINDING (not PASS, not an integrity failure). The case result is 'FINDING'."""


class CaseInconclusive(AssertionError):
    """The arrangement the case needs (for example genuine overlap of two writers) did not occur. The result is 'INCONCLUSIVE':
    never PASS, and never evidence that the feared behaviour is absent."""


class CaseHeld(RuntimeError):
    """The case is EXCLUDED, DEFERRED or gate-gated by the owner (A8). It is reported NOT RUN and never reaches a database."""


class DeferredByN9(CaseHeld):
    """The operation needs streamed standard input, parallel sessions or client termination, which cannot be expressed as validated `-c`
    submissions without changing what the case tests. It is refused here and needs a separately reviewed execution path (A8 C-4)."""


# Cases that never run under Gate A and are NOT RUN in every report (owner decisions of A8: C-2, C-3, C-4; A8 section 6.1 for DBT-23).
HELD = {
    "G2C1-DBT-01": ("EXCLUDED", "A8 C-2: attempts a second application of migration 0011; excluded from execution (the accepted scratch database must not be used for it) "
                                "unless a separate owner record authorizes an isolated test environment; kept for historical traceability"),
    "G2C1-DBT-24": ("EXCLUDED", "A8 C-3: lists the historical cluster's processes and directory; the first-application metadata exception does not extend here; "
                                "no historical-cluster listing, connection or inspection is authorized; kept for historical traceability"),
    "G2C1-DBT-15": ("DEFERRED", "A8 C-4: parallel sessions released by a streamed advisory-lock holder; needs a separately reviewed execution path (Gate D)"),
    "G2C1-DBT-16": ("DEFERRED", "A8 C-4: parallel sessions released by a streamed advisory-lock holder; needs a separately reviewed execution path (Gate D)"),
    "G2C1-DBT-17": ("DEFERRED", "A8 C-4: parallel sessions released by a streamed advisory-lock holder; needs a separately reviewed execution path (Gate D)"),
    "G2C1-DBT-22": ("DEFERRED", "A8 C-4: a client killed mid-statement over a streamed session; needs a separately reviewed execution path"),
    "G2C1-DBT-25": ("DEFERRED", "A8 C-4: F-1 fresh-allocation race over parallel sessions; F-1 stays OPEN; needs a separately reviewed execution path (Gate D)"),
    "G2C1-DBT-23": ("GATE-F", "A8 section 6.1: stop, start and crash commands; restart and crash durability is Gate F and needs its own record"),
}


def split_pgoptions(text: str) -> list:
    """Split a PGOPTIONS / libpq `options` string the way libpq does: on unescaped whitespace; backslash escapes the next character."""
    out, cur, i = [], [], 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            cur.append(text[i + 1])
            i += 2
            continue
        if ch.isspace():
            if cur:
                out.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
        i += 1
    if cur:
        out.append("".join(cur))
    return out


def check(condition: bool, message: str) -> None:
    if not condition:
        raise CaseFailure(message)


@dataclass
class Result:
    rc: int
    out: str
    err: str
    errors: list = field(default_factory=list)   # (sqlstate, message, detail)
    unparsed: list = field(default_factory=list)  # diagnostic lines that could not be read as "ERROR: <SQLSTATE>: <message>"
    diagnostics: list = field(default_factory=list)   # dicts: sqlstate, message, detail, constraint, table, schema (additive; read from the verbose fields only)
    evidence: dict | None = None   # case, database, role, invocation (argv), exit status, output file paths and SHA-256 values

    def _readable(self) -> None:
        if self.rc == 0 and (self.errors or self.unparsed):
            raise CaseFailure(f"contradictory result: exit status 0 together with a PostgreSQL diagnostic ({(self.errors or self.unparsed)[:1]!r})")
        """Fail closed (LOOM-2 V01 F-3): when the expected error evidence cannot be read, the case FAILS; it never reads as 'no error'
        and never as the expected error."""
        if self.unparsed:
            raise CaseFailure(f"error evidence unreadable (unparsed diagnostics {self.unparsed[:2]!r})")
        if self.rc != 0 and not self.errors:
            raise CaseFailure(f"psql exited {self.rc} but no SQLSTATE diagnostic could be read; stderr={self.err[:200]!r}")

    @property
    def state(self):
        self._readable()
        return self.errors[0][0] if self.errors else None

    @property
    def message(self):
        self._readable()
        return self.errors[0][1] if self.errors else None

    @property
    def detail(self):
        self._readable()
        return self.errors[0][2] if self.errors else None

    def rows(self):
        return [line.split("|") for line in self.out.splitlines() if line and "|" in line]


def parse_diagnostics(stderr: str) -> tuple:
    """Return (errors, unparsed). errors: (sqlstate, message, detail) in output order. DETAIL is attached only when it is the line
    immediately after its ERROR line (verbose order: ERROR, DETAIL, HINT, CONTEXT, LOCATION). unparsed: every diagnostic-looking
    line that does not carry a five-character SQLSTATE, so a caller can fail closed."""
    errors, unparsed, lines = [], [], stderr.splitlines()
    for i, line in enumerate(lines):
        m = ERR_RE.match(line)
        if m:
            d = DETAIL_RE.match(lines[i + 1]) if i + 1 < len(lines) else None
            errors.append((m.group(1), m.group(2), d.group(1) if d else None))
        elif DIAG_RE.match(line) or CLIENT_ERR_RE.match(line):
            unparsed.append(line)
    return errors, unparsed


def parse_errors(stderr: str) -> list:
    return parse_diagnostics(stderr)[0]


CONSTRAINT_RE = re.compile(r"^" + PREFIX + r"CONSTRAINT NAME:\s+(.*)$")
TABLE_RE = re.compile(r"^" + PREFIX + r"TABLE NAME:\s+(.*)$")
SCHEMA_RE = re.compile(r"^" + PREFIX + r"SCHEMA NAME:\s+(.*)$")


def parse_diagnostic_fields(stderr: str) -> list:
    """Per server error: the SQLSTATE and message (from the verbose ERROR line only), and the DETAIL, CONSTRAINT NAME, TABLE NAME and SCHEMA
    NAME lines that FOLLOW it before the next ERROR line, when psql prints them. Nothing is inferred from message text."""
    out, cur = [], None
    for line in stderr.splitlines():
        m = ERR_RE.match(line)
        if m:
            cur = {"sqlstate": m.group(1), "message": m.group(2), "detail": None, "constraint": None, "table": None, "schema": None}
            out.append(cur)
            continue
        if cur is None:
            continue
        for key, rx in (("detail", DETAIL_RE), ("constraint", CONSTRAINT_RE), ("table", TABLE_RE), ("schema", SCHEMA_RE)):
            m = rx.match(line)
            if m and cur[key] is None:
                cur[key] = m.group(1)
    return out


INJECT_DB_RE = snapshot.INJECT_DB_RE

# The registry core (encoders, templates, the operation table, the registry digest and the renderer) lives in snapshot.py so that
# snapshot.launch_runner can re-derive every psql payload independently (A10 R1). These names are re-exported unchanged.
UUID_RE, MARKER_RE, POSTING_FUNCTIONS, NUMERIC_RE, ENUMS = snapshot.UUID_RE, snapshot.MARKER_RE, snapshot.POSTING_FUNCTIONS, snapshot.NUMERIC_RE, snapshot.ENUMS
sql_uuid, sql_int, sql_text, sql_numeric = snapshot.sql_uuid, snapshot.sql_int, snapshot.sql_text, snapshot.sql_numeric
_ENCODERS, render_sql = snapshot._ENCODERS, snapshot.render_sql
UnknownOperation, Operation, OPERATIONS = snapshot.UnknownOperation, snapshot.Operation, snapshot.OPERATIONS
registry_digest, render_operation = snapshot.registry_digest, snapshot.render_operation

def prepare_evidence_dir(path) -> Path:
    """An existing, empty directory owned by the executing account, not a symbolic link, with no group or other access."""
    if path is None:
        raise snapshot.LaunchRefused("an evidence directory is required (--evidence-dir)")
    d = Path(path)
    if d.is_symlink() or not d.is_dir():
        raise snapshot.LaunchRefused("the evidence directory must be an existing directory, not a symbolic link")
    st = os.stat(d)
    if st.st_uid != os.getuid() or (st.st_mode & 0o077) != 0:
        raise snapshot.LaunchRefused("the evidence directory must be owned by the executing account with mode 0700")
    if any(d.iterdir()):
        raise snapshot.LaunchRefused("the evidence directory must be empty; nothing is reused or overwritten")
    return d



# ----------------------------------------------------------------------------------------------------------------------------------
class UnregisteredSql(snapshot.PayloadRefused):
    """Free-form SQL text is not accepted: only registered operations (Db.op) can be submitted."""




class Db:
    """Every statement goes through the G2C1 guarded runner (launched directly, snapshot.launch_runner), which verifies the target before
    each connection. The target is never defaulted: only the acceptance database is accepted (an injection database only with
    injection=True and only by the injection gate), it is validated at construction, and it cannot be reassigned. SQL is submitted only as
    a registered operation (Db.op)."""

    def __init__(self, database, *, injection: bool = False, evidence_dir=None, run=subprocess.run, runner: Path = snapshot.RUNNER):
        if injection:
            if type(database) is not str or INJECT_DB_RE.fullmatch(database) is None or database == snapshot.ACCEPTANCE_DATABASE:
                raise snapshot.TargetRefused(f"refused: {database!r} is not an injection database name")
        else:
            snapshot.require_acceptance_target(database)
        self._database, self._injection = database, bool(injection)
        self.evidence_dir = evidence_dir
        self.case_id = "NO-CASE"
        self._run, self._runner, self._seq = run, runner, 0

    @property
    def database(self) -> str:
        return self._database

    @property
    def injection(self) -> bool:
        return self._injection

    def _label(self, kind: str) -> str:
        self._seq += 1
        return f"{self.case_id}-{self._seq:04d}-{kind}"

    def command(self, *args, **kw):
        """The old streamed-process form is gone: it relied on `-f -` and on a held-open standard input (N-9)."""
        raise DeferredByN9("a streamed `-f -` session is not available; the case needs a separately reviewed execution path (A8 C-4)")

    def runner(self, *args) -> "snapshot.LaunchResult":
        """A non-psql runner command (identity, migrate-0011, ...), classified and target-checked by launch_runner; control commands are refused.
        `psql` is refused here (A10 R1): SQL is submitted only as a registered operation through Db.op."""
        if args and args[0] == "psql":
            raise snapshot.CommandRefused("psql is not available through Db.runner: submit a registered operation with Db.op")
        return snapshot.launch_runner(list(args), evidence_dir=self.evidence_dir, label=self._label("runner-" + str(args[0] if args else "none")),
                                      run=self._run, runner=self._runner, allow_injection=self._injection)

    def snapshot(self) -> dict:
        return snapshot.fetch_snapshot(self._database, run=self._run, runner=self._runner, evidence_dir=self.evidence_dir, label=self._label("snapshot"))

    def _submit(self, name: str, params: dict, options, timeout: int = 120) -> Result:
        """Submit ONE registered operation. There is no payload parameter: the boundary derives the SQL text from (name, params) itself."""
        op = OPERATIONS.get(name) if type(name) is str else None
        if op is None:
            raise UnknownOperation(f"{name!r} is not a registered SQL operation")
        if options is not None and not op.options_ok:
            raise snapshot.PayloadRefused(f"operation {op.name} does not take isolation options")
        launched = snapshot.launch_runner(["psql", self._database, op.role, "-At", "-F", "|", "-v", "VERBOSITY=verbose", "-c", snapshot.RegisteredCall(name, params)],
                                          pgoptions=options, evidence_dir=self.evidence_dir, label=self._label(op.name), run=self._run, runner=self._runner,
                                          timeout=timeout, allow_injection=self._injection)
        errors, unparsed = parse_diagnostics(launched.err)
        if launched.rc == 0 and (errors or unparsed):
            raise CaseFailure(f"{op.name}: contradictory result, exit status 0 together with a PostgreSQL diagnostic: {(errors or unparsed)[:1]!r}")
        if self.evidence_dir is not None and not (launched.stdout_path and launched.stderr_path and len(launched.stdout_sha256) == 64 and len(launched.stderr_sha256) == 64):
            raise CaseFailure(f"{op.name}: incomplete evidence (an output file or digest is missing)")
        if launched.rc == 0 and op.fields is not None:
            lines = launched.out.splitlines()
            if not any(line.strip() for line in lines) or any(line.strip() and len(line.split("|")) != op.fields for line in lines):
                raise CaseFailure(f"{op.name}: unexpected result shape (expected {op.fields} field(s) per line): {launched.out[:120]!r}")
        evidence = {"case": self.case_id, "database": self._database, "role": op.role, "operation": op.name, "invocation": list(launched.argv),
                    "exit_status": launched.rc, "stdout": launched.stdout_path, "stderr": launched.stderr_path,
                    "stdout_sha256": launched.stdout_sha256, "stderr_sha256": launched.stderr_sha256}
        return Result(launched.rc, launched.out, launched.err, errors, unparsed, parse_diagnostic_fields(launched.err), evidence)

    def op(self, name: str, *, options: str | None = None, timeout: int = 120, **params) -> Result:
        """Submit ONE registered operation as ONE validated `-c` argument."""
        return self._submit(name, params, options, timeout)

    def value(self, name: str, **params) -> str:
        r = self.op(name, **params)
        check(r.rc == 0, f"{name} failed: {r.err[:300]}")
        return r.out.strip()

    def run(self, *args, **kw):
        raise UnregisteredSql("free-form SQL is not accepted: submit a registered operation with Db.op (A9 R3)")

    admin = scalar = run_units = run

    def call(self, fn: str, allocation: str, version: int, amount: str, auth: str, key: str, options: str | None = SERIALIZABLE) -> Result:
        return self.op("post_call", options=options, fn=fn, alloc=allocation, ver=version, amt=amount, auth=auth, key=key)

    def seed_allocation(self, label: str) -> str:
        alloc = str(uuid.uuid4())
        r = self.op("seed_project", project=PROJECT)
        if r.rc == 0:
            r = self.op("seed_allocation", a=alloc, project=PROJECT)
        check(r.rc == 0, f"seed failed: {r.err[:300]}")
        return alloc


def ref(prefix: str, n: int | str) -> str:
    return f"G2C1-{prefix}-{RUN}-{n}"


@dataclass
class Case:
    case_id: str
    criteria: str
    title: str
    body: Callable | None = None
    inject: bool = False   # fault / defect injection: runs ONLY in a throwaway database named drawbridge_g2_scratch_inject*
    hold: tuple | None = None   # (category, reason) from HELD: never run under Gate A; the registered body refuses before any launch
    original: Callable | None = None   # the preserved case function (unchanged); reachable only to read, never through CASES when held


CASES: list = []


def case(case_id: str, criteria: str, title: str, *, inject: bool = False):
    def register(fn):
        hold = HELD.get(case_id)
        body = fn
        if hold is not None:
            def body(db, *args, _hold=hold, **kw):   # noqa: ARG001 - a held case refuses before touching anything
                raise CaseHeld(f"{_hold[0]}: {_hold[1]}")
        CASES.append(Case(case_id, criteria, title, body, inject, hold, fn))
        return fn
    return register


def is_inject_db(database: str) -> bool:
    return database.startswith(INJECT_DB_PREFIX)


def require_clean_db(db: "Db") -> None:
    """Whole-database checks (replay, reconciliation, manifest, restart) must not run where defects were injected on purpose."""
    check(not is_inject_db(db.database), "this case reads the whole ledger and must not run in an injection database")


# --------------------------------------------------------------------------------------------------------- AT-1
@case("G2C1-DBT-01", "AT-1", "0011 applies once; a second run is refused by the ledger; no earlier object changed")
def apply_once(db: Db):
    sha = canonical.sha256_hex((ROOT / "db/migrations/0011_g2c1_funding_ledger.sql").read_bytes())
    done = db.runner("migrate-0011", db.database, sha)
    check(done.returncode == 7, f"second apply must exit 7, got {done.returncode}: {done.stderr[:200]}")
    wrong = db.runner("migrate-0011", db.database, "0" * 64)
    check(wrong.returncode == 3 and "not the owner-approved hash" in wrong.stderr, "a wrong hash must be refused before any connection")
    check(db.scalar("g2_scratch_admin", "select count(*) from drawbridge_auth.schema_migration where file_name like '0011%';") == "1", "ledger row")
    # "no earlier object changed": every recorded earlier migration still carries the SHA-256 of the file in the repository.
    for f in sorted((ROOT / "db/migrations").glob("00[01][0-9]_*.sql")):
        if f.name.startswith("0011"):
            continue
        have = db.scalar("g2_scratch_admin", f"select file_sha256 from drawbridge_auth.schema_migration where file_name = '{f.name}';")
        check(have == canonical.sha256_hex(f.read_bytes()), f"{f.name}: recorded hash differs from the file")
    # Not covered here: the FIRST apply itself (it is the operation under review) and any change to objects outside the ledger.


# --------------------------------------------------------------------------------------------------------- AT-2
@case("G2C1-DBT-02", "AT-2, AT-3", "post_funding creates one event, one header, two legs; versions start at 1")
def funding_shape(db: Db):
    a = db.seed_allocation("shape")
    r = db.call("post_funding", a, 1, "500000.00", ref("AUTH", "S1"), ref("IDEM", "S1"))
    check(r.rc == 0 and r.rows()[0][3] == "f", f"first posting: {r.err[:200]}")
    counts = db.value("alloc_counts", a=a)
    check(counts == "1,1,2", f"counts {counts}")
    legs = db.value("alloc_legs", a=a)
    check(legs == "CASH_ALLOCATED:D:500000.00,PROJECT_CAPITAL:C:500000.00", legs)
    bal = db.value("alloc_balances", a=a)
    check(bal == "CASH_ALLOCATED=50000000,DISBURSED=0,PROJECT_CAPITAL=50000000", bal)


@case("G2C1-DBT-03", "AT-2, AT-5", "post_funding_reduction: leg pattern reversed; a reduction to exactly zero is accepted")
def reduction_and_zero(db: Db):
    a = db.seed_allocation("zero")
    check(db.call("post_funding", a, 1, "1000.00", ref("AUTH", "Z1"), ref("IDEM", "Z1")).rc == 0, "funding")
    r = db.call("post_funding_reduction", a, 2, "1000.00", ref("AUTH", "Z2"), ref("IDEM", "Z2"))
    check(r.rc == 0, f"reduction to zero: {r.err[:200]}")
    legs = db.value("alloc_reduction_legs", a=a)
    check(legs == "PROJECT_CAPITAL:D,CASH_ALLOCATED:C", legs)
    check(db.value("alloc_cash_balance", a=a) == "0", "cash zero")


@case("G2C1-DBT-04", "AT-5, AT-21", "a reduction above CASH returns DW422 / AUTHORITY_REDUCTION_BLOCKED / REDUCTION_EXCEEDS_CASH and writes nothing")
def reduction_exceeds(db: Db):
    a = db.seed_allocation("exceeds")
    check(db.call("post_funding", a, 1, "10.00", ref("AUTH", "X1"), ref("IDEM", "X1")).rc == 0, "funding")
    before = db.value("alloc_event_count", a=a)
    r = db.call("post_funding_reduction", a, 2, "10.01", ref("AUTH", "X2"), ref("IDEM", "X2"))
    check((r.state, r.message, r.detail) == ("DW422", "AUTHORITY_REDUCTION_BLOCKED", "REDUCTION_EXCEEDS_CASH"), str(r.errors))
    check(db.value("alloc_event_count", a=a) == before, "wrote something")
    nofunds = db.seed_allocation("nofunds")
    r2 = db.call("post_funding_reduction", nofunds, 1, "0.01", ref("AUTH", "X3"), ref("IDEM", "X3"))
    check(r2.state == "DW422", "reduction on an unfunded allocation")


# --------------------------------------------------------------------------------------------------------- AT-3, AT-4
@case("G2C1-DBT-05", "AT-4", "identical duplicate submission returns the same event, replayed = true, writes nothing (even after the stream moved)")
def duplicate_identical(db: Db):
    a = db.seed_allocation("dup")
    first = db.call("post_funding", a, 1, "20.00", ref("AUTH", "D1"), ref("IDEM", "D1"))
    check(first.rc == 0, first.err[:200])
    check(db.call("post_funding", a, 2, "5.00", ref("AUTH", "D2"), ref("IDEM", "D2")).rc == 0, "second event moves the stream")
    again = db.call("post_funding", a, 1, "20.00", ref("AUTH", "D1"), ref("IDEM", "D1"))
    check(again.rc == 0 and again.rows()[0][3] == "t" and again.rows()[0][0] == first.rows()[0][0], f"replay: {again.out} {again.err[:200]}")
    check(db.value("alloc_event_count", a=a) == "2", "replay wrote")


@case("G2C1-DBT-06", "AT-4", "same key with a different claim: IDEMPOTENCY_CONFLICT (also across allocations); same authorization under a new key: DUPLICATE_AUTHORIZATION")
def duplicate_conflicting(db: Db):
    a, b = db.seed_allocation("c1"), db.seed_allocation("c2")
    check(db.call("post_funding", a, 1, "20.00", ref("AUTH", "C1"), ref("IDEM", "C1")).rc == 0, "setup")
    for args in ((a, 2, "21.00", ref("AUTH", "C1"), ref("IDEM", "C1")), (b, 1, "20.00", ref("AUTH", "C1"), ref("IDEM", "C1")),
                 (a, 1, "20.00", ref("AUTH", "C9"), ref("IDEM", "C1"))):
        r = db.call("post_funding", *args)
        check((r.state, r.message) == ("DW409", "IDEMPOTENCY_CONFLICT"), f"{args}: {r.errors}")
    r = db.call("post_funding", a, 2, "20.00", ref("AUTH", "C1"), ref("IDEM", "C2"))
    check((r.state, r.message) == ("DW409", "DUPLICATE_AUTHORIZATION"), str(r.errors))
    r = db.call("post_funding", b, 1, "20.00", ref("AUTH", "C1"), ref("IDEM", "C3"))
    check((r.state, r.message) == ("DW409", "DUPLICATE_AUTHORIZATION"), "global posting identity: " + str(r.errors))
    r = db.call("post_funding_reduction", a, 2, "5.00", ref("AUTH", "C1"), ref("IDEM", "C4"))
    check(r.rc == 0, "a reduction uses its own identity prefix: " + r.err[:200])


@case("G2C1-DBT-07", "AT-3", "stale, skipped and zero versions are refused STALE_VERSION / INVALID_REFERENCE; versions stay contiguous")
def stale_version(db: Db):
    a = db.seed_allocation("stale")
    check(db.call("post_funding", a, 1, "1.00", ref("AUTH", "V1"), ref("IDEM", "V1")).rc == 0, "setup")
    for version in (1, 3, 9):
        r = db.call("post_funding", a, version, "1.00", ref("AUTH", f"V{version}x"), ref("IDEM", f"V{version}x"))
        check((r.state, r.message) == ("DW409", "STALE_VERSION"), f"version {version}: {r.errors}")
    for version in (0, -1):
        r = db.call("post_funding", a, version, "1.00", ref("AUTH", "Vz"), ref("IDEM", "Vz"))
        check(r.state == "DW422" and r.message == "INVALID_REFERENCE", f"version {version}: {r.errors}")
    r = db.call("post_funding", ("c2c10000-0000-4000-8000-0000000000ff"), 1, "1.00", ref("AUTH", "Vn"), ref("IDEM", "Vn"))
    check((r.state, r.message) == ("DW404", "ALLOCATION_NOT_FOUND"), str(r.errors))


# --------------------------------------------------------------------------------------------------------- AT-18
@case("G2C1-DBT-08", "AT-18", "invalid money and references are refused as INVALID_AMOUNT / INVALID_REFERENCE before any numeric-range error")
def invalid_inputs(db: Db):
    a = db.seed_allocation("invalid")
    for i, text in enumerate(FIXTURE["limits"]["invalid_amount_texts"]):
        if text == "1e3":
            continue   # a valid NUMERIC (1000) for the database; the application-side parser refuses it before any call
        r = db.op("probe_amount", options=SERIALIZABLE, alloc=a, amt=text, auth=ref("AUTH", f"I{i}"), key=ref("IDEM", f"I{i}"))
        # Every remaining text casts to numeric (or NULL): the REFUSAL must come from the function, so 22P02 (a cast error) is NOT accepted.
        check((r.state, r.message) == ("DW422", "INVALID_AMOUNT"), f"amount {text!r}: {r.errors}")
    for i, bad in enumerate(FIXTURE["invalid_references"]):
        r = db.op("probe_reference", options=SERIALIZABLE, alloc=a, auth=bad, key=ref("IDEM", f"R{i}"))
        check((r.state, r.message) == ("DW422", "INVALID_REFERENCE"), f"authorization {bad!r}: {r.errors}")
    check(db.value("alloc_event_count", a=a) == "0", "invalid input wrote")
    mx = FIXTURE["limits"]["max_txn_amount"]
    check(db.call("post_funding", a, 1, mx, ref("AUTH", "MAX"), ref("IDEM", "MAX")).rc == 0, "the per-transaction maximum is accepted")
    r = db.call("post_funding", a, 2, FIXTURE["limits"]["over_txn_amount"], ref("AUTH", "OVR"), ref("IDEM", "OVR"))
    check((r.state, r.message) == ("DW422", "INVALID_AMOUNT"), str(r.errors))


@case("G2C1-DBT-09", "AT-18", "the aggregate cap is reached by postings; reaching it exactly is accepted, one cent more is refused by the deferred trigger")
def aggregate_cap(db: Db):
    a = db.seed_allocation("cap")
    mx = FIXTURE["limits"]["max_txn_amount"]
    for n in range(1, FIXTURE["limits"]["max_postings_before_next_exceeds"] + 1):
        r = db.call("post_funding", a, n, mx, ref("AUTH", f"P{n}"), ref("IDEM", f"P{n}"))
        check(r.rc == 0, f"posting {n}: {r.err[:200]}")
    check(db.scalar("drawbridge_reader", f"select balance_cents from drawbridge_read.ledger_account_balance where allocation_id='{a}' and account_name='CASH_ALLOCATED';")
          == str(900 * canonical.MAX_TXN_CENTS), "900 maximum postings")
    r = db.call("post_funding", a, 901, mx, ref("AUTH", "P901"), ref("IDEM", "P901"))
    check(r.state == "23514" and "AGGREGATE_BALANCE_EXCEEDED" in (r.message or ""), f"901st maximum posting: {r.errors}")
    remainder = FIXTURE["limits"]["remainder_to_cap"]
    check(db.call("post_funding", a, 901, remainder, ref("AUTH", "PR"), ref("IDEM", "PR")).rc == 0, "reaching the cap exactly")
    check(db.scalar("drawbridge_reader", f"select balance_cents from drawbridge_read.ledger_account_balance where allocation_id='{a}' and account_name='CASH_ALLOCATED';")
          == str(canonical.MAX_BALANCE_CENTS), "balance equals MAX_BALANCE_ABS x 100")
    r = db.call("post_funding", a, 902, "0.01", ref("AUTH", "PX"), ref("IDEM", "PX"))
    check(r.state == "23514" and "AGGREGATE_BALANCE_EXCEEDED" in (r.message or ""), f"one cent more: {r.errors}")


# --------------------------------------------------------------------------------------------------------- AT-6, AT-13, AT-19, AT-22
# F-4: what each outcome means. A TRUNCATE can be stopped by (a) the append-only BEFORE TRUNCATE trigger -> SQLSTATE 23001 (the
# intended mechanism); (b) PostgreSQL's own foreign-key rule ("cannot truncate a table referenced in a foreign key constraint") ->
# 0A000, an UNSUPPORTED RESET OPERATION refused before any trigger runs; (c) a missing privilege -> 42501 (authorization failure; an
# administrator should never see it); (d) success -> the table was emptied, a FAILURE of the invariant. Which of (a) and (b) applies
# to a single FK-referenced table cannot be known without running PostgreSQL, so a single-table TRUNCATE accepts exactly {23001,
# 0A000} and records which one it saw. Truncating the whole referencing set in ONE statement satisfies the FK rule and therefore
# must reach the trigger: that statement is required to give 23001, and it is the evidence for the trigger path.
TRUNCATE_ALTERNATIVES = {"23001": "append-only trigger", "0A000": "unsupported reset: foreign-key rule, trigger not reached"}
LEDGER_TABLES = ("allocation_event", "journal_txn", "journal_leg", "journal_account")
# 0A000 is PostgreSQL's refusal to truncate a table that a foreign key REFERENCES. Only journal_txn and journal_account are referenced
# (by journal_leg and allocation_event; migration 0011 lines 186, 192, 228). For allocation_event and journal_leg no such rule can
# apply, so the ONLY explanation for a refusal is the append-only trigger: 23001 is required and 0A000 is a FAILURE there.
# An offline test re-derives FK_REFERENCED from the migration text so this table cannot drift from the schema.
FK_REFERENCED = ("journal_txn", "journal_account")
TRUNCATE_EXPECTED = {t: ({"23001", "0A000"} if t in FK_REFERENCED else {"23001"}) for t in LEDGER_TABLES}
NO_TRUNCATE_TRIGGER_COUNT_SQL = ("select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace "
                                 "where n.nspname = 'drawbridge_auth' and c.relname in ('allocation_event','journal_txn','journal_leg','journal_account') "
                                 "and t.tgname = c.relname || '_no_truncate' and not t.tgisinternal and t.tgenabled = 'O' "
                                 "and (t.tgtype & 1) = 0 and (t.tgtype & 2) <> 0 and (t.tgtype & 32) <> 0;")


@case("G2C1-DBT-10", "AT-6", "events, headers, legs, accounts reject UPDATE/DELETE/TRUNCATE; TRUNCATE outcome distinguished (trigger vs foreign-key rule vs privilege); the service role has no DML; the reader sees views only")
def immutability_and_roles(db: Db):
    a = db.seed_allocation("imm")
    check(db.call("post_funding", a, 1, "3.00", ref("AUTH", "M1"), ref("IDEM", "M1")).rc == 0, "setup")

    def counts():
        return db.scalar("g2_scratch_admin", "select " + "||','||".join(f"(select count(*) from drawbridge_auth.{t})" for t in LEDGER_TABLES) + ";")
    before = counts()
    seen = {}
    # Presence of the four BEFORE TRUNCATE statement triggers, read from the catalog (not inferred from one refused statement).
    check(db.scalar("g2_scratch_admin", NO_TRUNCATE_TRIGGER_COUNT_SQL) == "4", "each of the four ledger tables must carry an enabled BEFORE TRUNCATE statement trigger")
    for table in LEDGER_TABLES:
        for stmt in (f"update drawbridge_auth.{table} set created_at = now();", f"delete from drawbridge_auth.{table};"):
            r = db.admin(stmt)
            check(r.state == "23001", f"{stmt} -> {r.errors}")
        r = db.admin(f"truncate drawbridge_auth.{table};")
        check(r.rc != 0, f"truncate {table} SUCCEEDED: the table was emptied")
        allowed = TRUNCATE_EXPECTED[table]
        check(r.state in allowed, f"truncate {table}: {r.errors}; permitted SQLSTATEs for this table: {sorted(allowed)} "
                                  + ("(0A000 cannot occur: no foreign key references this table, so only the append-only trigger can refuse)" if r.state == "0A000" else
                                     "(42501 would be an authorization failure; anything else is unexplained)"))
        seen[table] = r.state
        for role in ("authority_svc", "drawbridge_reader"):
            r = db.run(role, f"select count(*) from drawbridge_auth.{table};")
            check(r.state == "42501", f"{role} select on {table} -> {r.errors}")
            r = db.run(role, f"insert into drawbridge_auth.{table} default values;")
            check(r.state == "42501", f"{role} insert on {table} -> {r.errors}")
    # The foreign-key rule is satisfied when every referencing table is named in the same statement, so this one MUST reach the trigger.
    r = db.admin("truncate " + ", ".join(f"drawbridge_auth.{t}" for t in LEDGER_TABLES) + ";")
    check(r.state == "23001", f"truncate of the whole set must be refused by the append-only trigger (23001): {r.errors}")
    check(counts() == before, "a refused statement changed a ledger table")
    check(db.run("drawbridge_reader", "select count(*) from drawbridge_read.ledger_event_stream;").rc == 0, "reader views")
    r = db.run("drawbridge_reader", "select * from drawbridge_auth.post_funding(gen_random_uuid(), 1, 1.00, 'X', 'Y');")
    check(r.state == "42501", "reader cannot execute the posting function: " + str(r.errors))
    r = db.admin("select * from drawbridge_auth.post_funding(gen_random_uuid(), 1, 1.00, 'X', 'Y');")
    check(r.state == "42501", "the scratch administrator is never an application path: " + str(r.errors))
    print("single-table TRUNCATE outcomes (23001 = trigger, 0A000 = foreign-key rule):", json.dumps(seen, sort_keys=True), file=sys.stderr)


@case("G2C1-DBT-11", "AT-8 F09, AT-3", "a skipped version inserted directly by the scratch administrator is refused by the contiguity trigger")
def contiguity(db: Db):
    a = db.seed_allocation("contig")
    check(db.call("post_funding", a, 1, "1.00", ref("AUTH", "G1"), ref("IDEM", "G1")).rc == 0, "setup")
    txn, ev = str(uuid.uuid4()), str(uuid.uuid4())
    auth, key = ref("AUTH", "G3"), ref("IDEM", "G3")
    r = db.op("contiguity_block", txn=txn, ev=ev, a=a, project=PROJECT, pid=f"FUNDING:{auth}", key=key, auth=auth)
    check(r.state == "23514" and "contiguous" in (r.message or ""), str(r.errors))


@case("G2C1-DBT-12", "AT-8 F03, AT-2", "an unbalanced or incomplete journal transaction is refused at commit (deferred trigger)")
def journal_imbalance(db: Db):
    a = db.seed_allocation("imbal")
    r = db.op("seed_accounts", a=a, project=PROJECT)
    check(r.rc == 0, r.err[:200])

    def block(tag: str, legs: list) -> Result:
        txn, auth, key = str(uuid.uuid4()), ref("AUTH", tag), ref("IDEM", tag)
        params = dict(txn=txn, a=a, project=PROJECT, pid=f"FUNDING:{auth}", key=key, auth=auth)
        for n, (name, direction, amount) in enumerate(legs, 1):
            params.update({f"n{n}": name, f"d{n}": direction, f"m{n}": amount})
        return db.op("txn_block_one_leg" if len(legs) == 1 else "txn_block_two_legs", **params)
    cases = (("one leg", [("CASH_ALLOCATED", "D", "5.00")]),
             ("unequal legs", [("CASH_ALLOCATED", "D", "5.00"), ("PROJECT_CAPITAL", "C", "4.99")]),
             ("reversed pattern", [("PROJECT_CAPITAL", "D", "5.00"), ("CASH_ALLOCATED", "C", "5.00")]),
             ("header total differs", [("CASH_ALLOCATED", "D", "4.00"), ("PROJECT_CAPITAL", "C", "4.00")]))
    for i, (label, legs) in enumerate(cases):
        r = block(f"B{i}", legs)
        check(r.state == "23514", f"{label}: {r.errors}")
    check(db.value("alloc_header_count", a=a) == "0", "a refused transaction left a header")


@case("G2C1-DBT-13", "AT-19", "the leg-pattern trigger fails closed for a kind other than the two funding kinds (constraint dropped inside a rolled-back transaction)")
def leg_pattern_fail_closed(db: Db):
    a = db.seed_allocation("kind")
    txn = str(uuid.uuid4())
    sql = f"""
begin;
alter table drawbridge_auth.journal_txn drop constraint journal_txn_g2c1_funding_only;
insert into drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind, total_amount,
  posting_identity, identity_generation, reverses_ref, reversed_kind_ref, idempotency_key, authorization_ref)
  values ('{txn}', '{PROJECT}', '{a}', '∅', '∅', 'USD', 'SETTLEMENT', 1.00, 'SETTLEMENT:{ref("X", "K")}', 1, '∅', '∅', '{ref("IDEM", "K1")}', '{ref("AUTH", "K1")}');
commit;
"""
    r = db.admin(sql)
    check(r.state == "23514" and "unsupported journal kind" in (r.message or ""), str(r.errors))
    still = db.scalar("g2_scratch_admin", "select count(*) from pg_constraint where conname = 'journal_txn_g2c1_funding_only';")
    check(still == "1", "the transaction must roll back the dropped constraint")
    check(db.scalar("g2_scratch_admin", "select count(*) from drawbridge_auth.journal_txn where identity_generation <> 1;") == "0", "identity_generation is 1 on every row")


@case("G2C1-DBT-14", "AT-13, AT-16, AT-22", "catalog lint: VOLATILE, SECURITY DEFINER with fixed search_path, argument names, grants; no p_authorization_id value changes a permission outcome")
def catalog_lint(db: Db):
    rows = db.op("catalog_lint").rows()
    check(len(rows) >= 10, "functions present")
    for name, vol, secdef, config, args in rows:
        if secdef == "t":
            check("search_path=" in config, f"{name}: SECURITY DEFINER without fixed search_path")
        check(not re.search(r"(authorized|verified|force|override|admin)", args, re.I), f"{name}: flag-like argument {args}")
        if name in ("post_funding", "post_funding_reduction"):
            check(vol == "v", f"{name} must be VOLATILE")
            check(args == "p_allocation_id,p_expected_version,p_amount,p_authorization_id,p_idempotency_key", args)
    for role, expect in (("authority_svc", "t"), ("drawbridge_reader", "f")):
        got = db.value("exec_privilege", role=role)
        check(got == expect, f"EXECUTE for {role}")
    public = db.value("public_exec_count")
    check(public == "0", "EXECUTE must not be granted to PUBLIC")
    # (1) Privilege half: the reader holds no EXECUTE, so it is refused for EVERY label. This shows only that a label cannot GRANT a
    #     privilege; it says nothing about an authorized caller (that is half 2).
    a = db.seed_allocation("label")
    for i, label in enumerate(("ADMIN", "FORCE", "OVERRIDE", "AUTHORIZED", "x" * 128, "a.b:c-d_e")):
        r = db.op("probe_reader_post", alloc=a, auth=label, key=ref("IDEM", f"L{i}"))
        check(r.state == "42501", f"label {label[:12]!r} must not grant permission: {r.errors}")
    # (2) Behaviour half (LOOM-2 V01 F-5): an AUTHORIZED caller (authority_svc) gets the SAME outcome for a flag-like label as for an
    #     ordinary one: success at first use, DUPLICATE_AUTHORIZATION at second use under a new key, INVALID_REFERENCE for an
    #     out-of-grammar label. No label changes what is allowed.
    outcomes = {}
    for i, label in enumerate(("ORDINARY-1", "ADMIN", "FORCE", "OVERRIDE", "AUTHORIZED", "SUPERUSER", "a.b:c-d_e", "x" * 129)):
        al = db.seed_allocation(f"lab{i}")
        first = db.call("post_funding", al, 1, "1.00", label, ref("IDEM", f"LB{i}a"))
        again = db.call("post_funding", al, 2, "1.00", label, ref("IDEM", f"LB{i}b"))
        outcomes[label[:12]] = ((first.state, first.message), (again.state, again.message))
    ordinary = outcomes["ORDINARY-1"]
    check(ordinary == ((None, None), ("DW409", "DUPLICATE_AUTHORIZATION")), f"ordinary label outcome: {ordinary}")
    for label, got in outcomes.items():
        if label.startswith("x"):
            check(got[0] == ("DW422", "INVALID_REFERENCE"), f"out-of-grammar label: {got}")
        else:
            check(got == ordinary, f"label {label!r} changed the outcome: {got} != {ordinary}")


# --------------------------------------------------------------------------------------------------------- AT-7, AT-15, AT-16, AT-17
def advisory_holders_sql(gate: int) -> str:
    return ("select count(*) from pg_locks where locktype = 'advisory' and granted and mode = 'ExclusiveLock' "
            f"and classid = 0 and objid = {int(gate)} and objsubid = 1;")


def advisory_waiters_sql(gate: int) -> str:
    return ("select count(*) from pg_locks where locktype = 'advisory' and not granted "
            f"and classid = 0 and objid = {int(gate)} and objsubid = 1;")


def wait_for_count(db, sql: str, at_least: int, timeout: float = 30.0, poll: float = 0.2, sleep=time.sleep, clock=time.monotonic) -> int:
    """Poll `sql` (a single count) until it reaches `at_least` or `timeout` passes. Returns the LAST observed count, so a caller can
    tell a satisfied barrier from a timed-out one. No fixed sleep stands in for evidence."""
    deadline, last = clock() + timeout, 0
    while True:
        last = int(db.scalar("g2_scratch_admin", sql))
        if last >= at_least or clock() >= deadline:
            return last
        sleep(poll)


class ParallelResults(list):
    """The results of parallel(), plus the barrier evidence that was OBSERVED on the server before release."""
    barrier: dict


def barrier_complete(barrier: dict) -> bool:
    return bool(barrier.get("holder_observed")) and barrier.get("waiters_observed") == barrier.get("expected")


def parallel(db: Db, jobs: list, options: str, gate: int) -> "ParallelResults":
    """Run each job (a function taking `options`) in its own thread / psql process. The jobs are parked on one advisory lock held by a
    third session and released together. BEFORE the release the server is asked (pg_locks) whether the lock is held and whether every
    job is waiting; that observation is returned as `.barrier` (nothing is inferred from elapsed time). A job that never reaches the gate
    is still released after the timeout so that the processes end, and the barrier is then reported incomplete."""
    results = ParallelResults([None] * len(jobs))
    holder = subprocess.Popen(db.command("g2_scratch_admin", None, None), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    holder.stdin.write(f"select pg_advisory_lock({gate});\n")
    holder.stdin.flush()
    held = wait_for_count(db, advisory_holders_sql(gate), 1)

    def work(i, job):
        results[i] = job(options)
    threads = [threading.Thread(target=work, args=(i, j)) for i, j in enumerate(jobs)]
    for t in threads:
        t.start()
    waiters = wait_for_count(db, advisory_waiters_sql(gate), len(jobs))
    results.barrier = {"gate": gate, "expected": len(jobs), "holder_observed": held >= 1, "waiters_observed": waiters}
    holder.stdin.close()
    for t in threads:
        t.join(timeout=300)
    holder.wait(timeout=30)
    return results


def require_barrier(results) -> None:
    """For cases whose claim does not depend on overlap but whose arrangement does: an incomplete barrier is INCONCLUSIVE, not a pass."""
    if not barrier_complete(results.barrier):
        raise CaseInconclusive(f"the start barrier was not observed to be complete: {results.barrier}")


def gated_call(db: Db, gate: int, *args):
    def job(options):
        sql = (f"select pg_advisory_lock_shared({gate});\n"
               "select event_id, txn_id, version, replayed from drawbridge_auth." + args[0] + "(:'alloc'::uuid, :ver::bigint, :'amt'::numeric, :'auth', :'key');")
        return db.run("authority_svc", sql, options=options,
                      variables={"alloc": args[1], "ver": str(args[2]), "amt": args[3], "auth": args[4], "key": args[5]})
    return job


APPROVED_LOSS = {("40001", None)} | {("23505", c) for c in retry.RETRIABLE_UNIQUE_CONSTRAINTS}


def loser_key(r: "Result") -> tuple:
    """(sqlstate, constraint-or-outcome) of a failed call, from the diagnostics only."""
    if r.state == "23505":
        return ("23505", retry.extract_constraint_name(r.message))
    return (r.state, r.message if r.state and r.state.startswith("DW") else None)


@case("G2C1-DBT-15", "AT-7, AT-15, AT-16", "WARM allocation (accounts exist), concurrent writers for the same version, at READ COMMITTED and SERIALIZABLE: one winner, losers within the approved set, no gap, no duplicate (the fresh-allocation race is DBT-25)")
def concurrent_same_version(db: Db):
    observed = {}
    for label, options, gate in (("READ COMMITTED", READ_COMMITTED, 701), ("SERIALIZABLE", SERIALIZABLE, 702)):
        a = db.seed_allocation("race")
        check(db.call("post_funding", a, 1, "1.00", ref("AUTH", f"{gate}-w"), ref("IDEM", f"{gate}-w")).rc == 0, "warm-up posting")
        jobs = [gated_call(db, gate, "post_funding", a, 2, "1.00", ref("AUTH", f"{gate}-{i}"), ref("IDEM", f"{gate}-{i}")) for i in range(8)]
        results = parallel(db, jobs, options, gate)
        require_barrier(results)
        wins = [r for r in results if r.rc == 0]
        check(len(wins) == 1, f"{label}: exactly one winner, got {len(wins)}")
        check(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.allocation_event where allocation_id='{a}';") == "2", f"{label}: events")
        check(db.scalar("g2_scratch_admin", f"select string_agg(version::text, ',' order by version) from drawbridge_auth.allocation_event where allocation_id='{a}';") == "1,2", f"{label}: versions")
        losers = sorted({loser_key(r) for r in results if r.rc != 0}, key=str)
        if label == "READ COMMITTED":
            check(losers == [("DW409", "STALE_VERSION")], f"{label}: losers {losers}")
        else:
            # AT-15: an unexpected 23505 is a FAILURE. Allowed: 40001, 23505 on the three approved constraints, or a stable STALE_VERSION.
            bad = [x for x in losers if x not in APPROVED_LOSS and x != ("DW409", "STALE_VERSION")]
            check(not bad, f"{label}: loser outcomes outside the approved set: {bad}")
        check(all(r.state != "40P01" for r in results if r.rc != 0), "deadlock observed")
        observed[label] = losers
    print("observed loser errors:", json.dumps(observed, default=str), file=sys.stderr)


@case("G2C1-DBT-16", "AT-17", "writers on different allocations reusing one idempotency key or one authorization: AT MOST one winner per key and per identity, losers within the approved set, zero deadlocks")
def cross_allocation(db: Db, iterations: int = 20):
    deadlocks, outcomes = 0, set()
    for n in range(iterations):
        a, b = db.seed_allocation("x1"), db.seed_allocation("x2")
        for tag, al in (("a", a), ("b", b)):   # warm both allocations: accounts exist, so the fresh-allocation race (DBT-25) is not mixed in
            check(db.call("post_funding", al, 1, "1.00", ref("AUTH", f"XW{tag}{n}"), ref("IDEM", f"XW{tag}{n}")).rc == 0, "warm-up")
        gate = 710 + (n % 5)
        shared_key, shared_auth = ref("IDEM", f"XK{n}"), ref("AUTH", f"XA{n}")
        jobs = [gated_call(db, gate, "post_funding", a, 2, "1.00", ref("AUTH", f"XA-a{n}"), shared_key),
                gated_call(db, gate, "post_funding", b, 2, "1.00", ref("AUTH", f"XA-b{n}"), shared_key),
                gated_call(db, gate, "post_funding", a, 2, "1.00", shared_auth, ref("IDEM", f"XK-c{n}")),
                gated_call(db, gate, "post_funding", b, 2, "1.00", shared_auth, ref("IDEM", f"XK-d{n}"))]
        results = parallel(db, jobs, SERIALIZABLE, gate)
        require_barrier(results)
        deadlocks += sum(1 for r in results if r.state == "40P01")
        for r in results:
            if r.rc != 0:
                outcomes.add(loser_key(r))
        check(int(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where idempotency_key = '{shared_key}';")) <= 1, "at most one winner per key")
        check(int(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where posting_identity = 'FUNDING:{shared_auth}';")) <= 1, "at most one winner per authorization")
        # Without the retry wrapper a legitimate 40001 can leave an allocation with no second event, so only the upper bound is asserted.
        for al in (a, b):
            check(int(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.allocation_event where allocation_id = '{al}';")) <= 2, "more than one posting won for one version")
        bad = [x for x in outcomes if x not in APPROVED_LOSS and x[0] != "DW409"]
        check(not bad, f"loser outcomes outside the approved set: {bad}")
    check(deadlocks == 0, f"{deadlocks} deadlocks over {iterations} iterations")
    print("observed loser errors:", sorted(outcomes), file=sys.stderr)


@case("G2C1-DBT-17", "AT-15", "the bounded retry wrapper under two concurrent submissions of the SAME claim, each wrapped: at most 3 attempts; one writes and the other ends as replayed = true; records whether a retry occurred (it does NOT require one)")
def bounded_retry_real(db: Db):
    a = db.seed_allocation("retry")
    check(db.call("post_funding", a, 1, "9.00", ref("AUTH", "RT0"), ref("IDEM", "RT0")).rc == 0, "setup (warm allocation)")
    gate = 720
    logs: list = [None, None]

    def wrapped(i):
        def job(options):
            attempts = []

            def operation(attempt):
                attempts.append(attempt)
                if attempt == 1:   # the first attempt is released by the gate so the two submissions truly overlap
                    r = gated_call(db, gate, "post_funding", a, 2, "4.00", ref("AUTH", "RT1"), ref("IDEM", "RT1"))(options)
                else:
                    r = db.call("post_funding", a, 2, "4.00", ref("AUTH", "RT1"), ref("IDEM", "RT1"))
                if r.rc != 0:
                    raise retry.PsqlError(r.state or "XX000", r.message or r.err)
                return r.rows()[0]
            try:
                row = retry.call_with_bounded_retry(operation)
                logs[i] = ("OK", row, attempts)
            except retry.RetryExhausted as exc:
                logs[i] = ("EXHAUSTED", exc.final_sqlstate, attempts)
            except retry.PsqlError as exc:
                logs[i] = ("FINAL", f"{exc.sqlstate}:{exc.message}", attempts)
            return Result(0, "", "")
        return job
    require_barrier(parallel(db, [wrapped(0), wrapped(1)], SERIALIZABLE, gate))
    check(all(entry is not None for entry in logs), "a wrapped job did not finish")
    check(all(len(entry[2]) <= retry.MAX_ATTEMPTS for entry in logs), f"attempt bound exceeded: {logs}")
    check(all(entry[0] == "OK" for entry in logs), f"a wrapped submission did not end OK: {logs}")
    replayed = sorted(entry[1][3] for entry in logs)
    check(replayed == ["f", "t"], f"exactly one writer and one replay expected, got {replayed}: {logs}")
    check(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.allocation_event where allocation_id='{a}';") == "2", "events")
    print("wrapper attempt logs:", json.dumps(logs, default=str), "| a retry occurred:", any(len(e[2]) > 1 for e in logs), file=sys.stderr)


# --------------------------------------------------------------------------------------------------------- AT-9, AT-10, AT-11, AT-20
@case("G2C1-DBT-18", "AT-9", "replay is byte-identical across two runs and writes nothing")
def replay_deterministic(db: Db):
    require_clean_db(db)
    a = db.seed_allocation("replay")
    for n in range(1, 4):
        check(db.call("post_funding", a, n, "7.00", ref("AUTH", f"RP{n}"), ref("IDEM", f"RP{n}")).rc == 0, "setup")
    before = db.value("ledger_totals")
    first = replay.replay_bytes(replay.replay(db.snapshot()))
    second = replay.replay_bytes(replay.replay(db.snapshot()))
    check(first == second, "two runs differ")
    check(db.value("ledger_totals") == before, "replay wrote")


@case("G2C1-DBT-19", "AT-10", "reconciliation PASS on a clean ledger (defect injection is DBT-27, in a separate throwaway database)")
def reconciliation_clean(db: Db):
    require_clean_db(db)
    result = reconcile.reconcile(db.snapshot(), require_snapshot_proof=True)
    check(result["outcome"] == "PASS", json.dumps(result["discrepancies"])[:500])


@case("G2C1-DBT-20", "AT-11", "manifest export verifies; a corrupted copy fails with a position; a dropped tail is detected only against the recorded head")
def manifest_roundtrip(db: Db):
    require_clean_db(db)
    snap = db.snapshot()
    doc = manifest.build_manifest(snap)
    data = manifest.manifest_bytes(doc)
    check(manifest.verify_manifest(data)["ok"], "fresh export verifies")
    bad = bytearray(data)
    bad[len(bad) // 2] ^= 1
    check(not manifest.verify_manifest(bytes(bad))["ok"], "corruption detected")
    # A11 B-6: the local artifact is written beneath the governed evidence directory (a new 0700 subdirectory, created exclusively), never in a
    # system temporary directory. Same file, same format, same checks; no database action.
    check(db.evidence_dir is not None, "DBT-20 writes its manifest artifact beneath the evidence directory, which is required")
    out_dir = Path(db.evidence_dir) / f"{db.case_id}-manifest"
    try:
        os.mkdir(out_dir, 0o700)
    except OSError as exc:
        raise CaseFailure(f"the DBT-20 artifact directory could not be created exclusively: {exc.__class__.__name__}") from exc
    info = manifest.write_manifest(doc, out_dir / "m.json")
    check(manifest.read_sidecar(out_dir / "m.json") == info["manifest_sha256"], "sidecar")


@case("G2C1-DBT-21", "AT-20", "replay and reconciliation read one read-only snapshot: writes are refused and a concurrent posting causes no torn read")
def snapshot_isolation(db: Db):
    # Mode proof (not privilege): the transaction reports read-only and repeatable read. A privilege error (42501) is NOT accepted as proof.
    r = db.run("drawbridge_reader", "begin isolation level repeatable read read only; select current_setting('transaction_read_only')||','||current_setting('transaction_isolation'); commit;")
    check(r.rc == 0 and r.out.strip() == "on,repeatable read", f"snapshot mode: {r.out!r} {r.errors}")
    check("READ ONLY" in snapshot.SNAPSHOT_SQL and "REPEATABLE READ" in snapshot.SNAPSHOT_SQL, "snapshot.py must request the same mode")
    a = db.seed_allocation("snap")
    check(db.call("post_funding", a, 1, "4.00", ref("AUTH", "SN0"), ref("IDEM", "SN0")).rc == 0, "setup")
    reader = threading.Thread(target=lambda: results.append(db.run("drawbridge_reader", """begin isolation level repeatable read read only;
        select count(*) from drawbridge_read.ledger_event_stream;
        select pg_sleep(3);
        select count(*) from drawbridge_read.ledger_event_stream;
        select count(*) from drawbridge_read.ledger_reconciliation where event_id is not null;
        commit;""")))
    results: list = []
    reader.start()
    time.sleep(1.0)
    check(db.call("post_funding", a, 2, "4.00", ref("AUTH", "SN1"), ref("IDEM", "SN1")).rc == 0, "concurrent posting")
    reader.join(timeout=60)
    counts = [line for line in results[0].out.splitlines() if line.strip().isdigit()]
    check(len(counts) == 3 and counts[0] == counts[1] == counts[2], f"torn read: {counts}")
    # The real wrapper: snapshots taken by snapshot.py while postings commit must each reconcile without a torn-read discrepancy.
    # (A discrepancy caused by a genuine defect elsewhere would also fail here; run this case where the ledger is clean.)
    require_clean_db(db)
    writer = threading.Thread(target=lambda: [db.call("post_funding", a, n, "1.00", ref("AUTH", f"SW{n}"), ref("IDEM", f"SW{n}")) for n in range(3, 23)])
    writer.start()
    try:
        for _ in range(6):
            outcome = reconcile.reconcile(db.snapshot(), require_snapshot_proof=True)
            check(outcome["outcome"] == "PASS", "a snapshot taken during postings did not reconcile: " + json.dumps(outcome["discrepancies"])[:300])
    finally:
        writer.join(timeout=300)


# --------------------------------------------------------------------------------------------------------- AT-12, AT-23
@case("G2C1-DBT-22", "AT-8 F01-F04, F12, AT-12", "rollback and client-crash levels: a fault or a killed client leaves no header, leg or event")
def rollback_and_client_crash(db: Db):
    a = db.seed_allocation("crash")
    before = db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where allocation_id='{a}';")
    proc = subprocess.Popen(db.command("authority_svc", SERIALIZABLE, {"alloc": a, "auth": ref("AUTH", "CC"), "key": ref("IDEM", "CC")}),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proc.stdin.write("begin;\nselect * from drawbridge_auth.post_funding(:'alloc'::uuid, 1, 2.00, :'auth', :'key');\nselect pg_sleep(30);\n")
    proc.stdin.flush()
    time.sleep(3)
    subprocess.run(["/usr/bin/pkill", "-9", "-P", str(proc.pid)], check=False)   # the psql child of the runner: the actual client
    proc.kill()
    proc.wait(timeout=30)
    time.sleep(2)
    check(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where allocation_id='{a}';") == before, "killed client left a header")
    check(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.allocation_event where allocation_id='{a}';") == "0", "killed client left an event")
    r = db.admin(f"begin; select * from drawbridge_auth.allocation_event where allocation_id='{a}'; rollback;")
    check(r.rc == 0, "sanity")


@case("G2C1-DBT-23", "AT-12, AT-9", "clean restart: committed state and replay survive; server crash with commits in flight: acknowledged commits present, nothing partial, reconciliation PASS (probabilistic evidence)")
def restart_and_server_crash(db: Db, iterations: int = 5):
    require_clean_db(db)
    def runner(command):
        done = db.runner(command)
        check(done.returncode == 0, f"{command}: {done.stderr[:200]}")
    a = db.seed_allocation("restart")
    check(db.call("post_funding", a, 1, "6.00", ref("AUTH", "RS1"), ref("IDEM", "RS1")).rc == 0, "setup")
    before = replay.replay_bytes(replay.replay(db.snapshot()))
    runner("stop")
    runner("start")
    check(before == replay.replay_bytes(replay.replay(db.snapshot())), "replay changed across a clean restart")
    acknowledged = []
    for i in range(iterations):
        alloc = db.seed_allocation(f"crash{i}")
        stop = threading.Event()

        def writer():
            n = 1
            while not stop.is_set() and n < 200:
                r = db.call("post_funding", alloc, n, "1.00", ref("AUTH", f"CR{i}-{n}"), ref("IDEM", f"CR{i}-{n}"))
                if r.rc == 0:
                    acknowledged.append((alloc, n))
                    n += 1
                else:
                    return
        t = threading.Thread(target=writer)
        t.start()
        time.sleep(1.5)
        runner("crash-kill" if i % 2 == 0 else "crash-stop")
        stop.set()
        t.join(timeout=60)
        runner("start")
    present = {(r[0], int(r[1])) for r in (line.split("|") for line in db.admin("select allocation_id, version from drawbridge_auth.allocation_event;").out.splitlines() if "|" in line)}
    missing = [x for x in acknowledged if x not in present]
    check(not missing, f"acknowledged commits missing after crash recovery: {missing[:5]}")
    check(reconcile.reconcile(db.snapshot(), require_snapshot_proof=True)["outcome"] == "PASS", "reconciliation after crash recovery")
    print(f"crash iterations={iterations} acknowledged_commits={len(acknowledged)} (probabilistic evidence, not a proof; no power-loss claim)", file=sys.stderr)


@case("G2C1-DBT-24", "AT-23", "runtime safety: the existing cluster is untouched (process and directory listings before and after) and this cluster's facts verify")
def runtime_safety(db: Db):
    def snapshot_old():
        ps = subprocess.run(["/bin/ps", "-eo", "pid,args"], capture_output=True, text=True, check=False).stdout
        old = sorted(l.strip() for l in ps.splitlines() if "pg18-g2/data" in l)
        # Names only: a long listing carries live modification times and would differ without any interference.
        listing = subprocess.run(["/bin/ls", "-A", str(ROOT / "build/pg18-g2")], capture_output=True, text=True, check=False).stdout
        return old, listing
    before = snapshot_old()
    done = db.runner("identity")
    check(done.returncode == 0 and "live=verified" in done.stdout, done.stdout + done.stderr)
    facts = db.scalar("g2_scratch_admin", "select current_setting('fsync')||','||current_setting('synchronous_commit')||','||current_setting('full_page_writes')||','||current_setting('data_checksums')||','||current_setting('listen_addresses')||','||current_setting('port');")
    check(facts == "on,on,on,on,,54438", facts)
    check(snapshot_old() == before, "the existing cluster's processes or directory changed")


# --------------------------------------------------------------------------------------------------------- F-1 (LOOM-2 V01)
# The fresh-allocation race. Two concurrent writers, the SAME fresh allocation, NO ledger accounts yet, SERIALIZABLE. The loser may
# surface (a) 40001, (b) 23505 on one of the three approved constraints, (c) 23505 on journal_account_name_uk (NOT approved), (d) a
# stable DW409 STALE_VERSION, or (e) something else. This case RECORDS the actual SQLSTATE and constraint name and classifies each
# outcome with f1_verdict(). It does NOT widen the approved retry list (retry.RETRIABLE_UNIQUE_CONSTRAINTS is untouched) and it does
# not decide what to do about (c): if (c) is observed the case ends as FINDING and the choice is a separate OWNER decision.
F1_ITERATIONS = 20
F1_VERDICTS = {
    "OBSERVED_40001": "40001: retried by the approved rule; expected final state = sequential outcome. Acceptable.",
    "OBSERVED_23505_APPROVED": "23505 on one of the three approved constraints: retried by the approved rule. Acceptable.",
    "F1_CONFIRMED_OWNER_DECISION_REQUIRED": "23505 on journal_account_name_uk: NOT retriable under the approved rule (wrapper returns DEFECT_UNEXPECTED_UNIQUE). "
                                            "F-1 is confirmed. APEX and the owner must decide; this harness changes nothing.",
    "STABLE_REFUSAL_STALE_VERSION": "DW409 STALE_VERSION: the loser saw the winner's committed state. Stable and final. Acceptable.",
    "DEFECT_UNEXPECTED_UNIQUE": "23505 on any other constraint: a defect (AT-15). FAIL.",
    "UNEXPECTED": "any other outcome: FAIL.",
}


def f1_verdict(state, message) -> str:
    """Classify one LOSER outcome from its SQLSTATE and message text only (the constraint name is parsed from the message)."""
    constraint = retry.extract_constraint_name(message or "")
    if state == "40001":
        return "OBSERVED_40001"
    if state == "23505":
        if constraint in retry.RETRIABLE_UNIQUE_CONSTRAINTS:
            return "OBSERVED_23505_APPROVED"
        if constraint == "journal_account_name_uk":
            return "F1_CONFIRMED_OWNER_DECISION_REQUIRED"
        return "DEFECT_UNEXPECTED_UNIQUE"
    if state == "DW409" and message == "STALE_VERSION":
        return "STABLE_REFUSAL_STALE_VERSION"
    return "UNEXPECTED"


OVERLAP_VERDICTS = ("OBSERVED_40001", "OBSERVED_23505_APPROVED", "F1_CONFIRMED_OWNER_DECISION_REQUIRED")


def iteration_overlap(barrier_ok: bool, loser_verdicts: list) -> str:
    """OVERLAPPED: the start barrier was observed complete AND a loser failed in a way that needs overlap (a serialization failure or a
    unique violation). A loser that answers STALE_VERSION saw the winner's COMMITTED state, i.e. did not overlap; the iteration then
    exercised nothing and is NOT_OVERLAPPED. BARRIER_FAILED: the server never showed both writers parked."""
    if not barrier_ok:
        return "BARRIER_FAILED"
    return "OVERLAPPED" if any(v in OVERLAP_VERDICTS for v in loser_verdicts) else "NOT_OVERLAPPED"


def summarize_f1(records: list) -> dict:
    """records: one dict per iteration with keys overlap, verdicts. Returns counts and the conclusion the case must report."""
    counts = {"iterations": len(records)}
    for kind in ("OVERLAPPED", "NOT_OVERLAPPED", "BARRIER_FAILED"):
        counts[kind.lower()] = sum(1 for r in records if r["overlap"] == kind)
    verdicts = [v for r in records for v in r["verdicts"]]
    if any(v in ("DEFECT_UNEXPECTED_UNIQUE", "UNEXPECTED") for v in verdicts):
        counts["conclusion"] = "FAIL"
    elif "F1_CONFIRMED_OWNER_DECISION_REQUIRED" in verdicts:
        counts["conclusion"] = "FINDING"
    elif counts["overlapped"] == 0:
        counts["conclusion"] = "INCONCLUSIVE"
    else:
        counts["conclusion"] = "NO_FINDING_OBSERVED_NOT_PROOF_OF_ABSENCE"
    return counts


@case("G2C1-DBT-25", "AT-7, AT-15 (F-1)", "FRESH allocation, two concurrent writers, SERIALIZABLE, 20 iterations: barrier and overlap are OBSERVED; SQLSTATE, constraint and committed result recorded per writer; INCONCLUSIVE when no iteration overlapped; sequential control")
def fresh_allocation_race(db: Db):
    records: list = []
    detail: list = []
    for n in range(F1_ITERATIONS):
        a = db.seed_allocation(f"f1-{n}")
        check(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_account where allocation_id = '{a}';") == "0", "allocation must be fresh (no accounts)")
        gate = 730 + (n % 5)
        auth = [ref("AUTH", f"F1-{n}-{i}") for i in range(2)]
        key = [ref("IDEM", f"F1-{n}-{i}") for i in range(2)]
        jobs = [gated_call(db, gate, "post_funding", a, 1, "1.00", auth[i], key[i]) for i in range(2)]
        results = parallel(db, jobs, SERIALIZABLE, gate)
        barrier_ok = barrier_complete(results.barrier)
        wins = [r for r in results if r.rc == 0]
        writers, verdicts = [], []
        for i, r in enumerate(results):
            if r.rc == 0:
                writers.append({"writer": i, "outcome": "COMMITTED", "replayed": r.rows()[0][3], "event_id": r.rows()[0][0]})
            else:
                verdict = f1_verdict(r.state, r.message)
                verdicts.append(verdict)
                writers.append({"writer": i, "outcome": "FAILED", "sqlstate": r.state, "constraint": retry.extract_constraint_name(r.message or ""),
                                "message": r.message, "verdict": verdict, "wrapper": retry.classify(retry.PsqlError(r.state, r.message or ""))})
        # Final committed state: integrity is NOT negotiable whichever way the loser failed.
        check(len(wins) <= 1, f"iteration {n}: more than one writer won")
        events = db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.allocation_event where allocation_id = '{a}';")
        versions = db.scalar("g2_scratch_admin", f"select coalesce(string_agg(version::text, ',' order by version), '') from drawbridge_auth.allocation_event where allocation_id = '{a}';")
        accounts = db.scalar("g2_scratch_admin", f"select count(*)||','||count(distinct account_name) from drawbridge_auth.journal_account where allocation_id = '{a}';")
        txns = db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where allocation_id = '{a}';")
        legs = db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_leg where allocation_id = '{a}';")
        check((events, versions) in (("1", "1"), ("0", "")), f"iteration {n}: events={events} versions={versions}")
        check(txns == events and legs == str(2 * int(events)), f"iteration {n}: txns={txns} legs={legs} events={events}")
        check(accounts == ("3,3" if events == "1" else "0,0"), f"iteration {n}: accounts {accounts} (all-or-nothing, no duplicates)")
        check(len(wins) == int(events), f"iteration {n}: acknowledged winners {len(wins)} != committed events {events}")
        for i in range(2):   # idempotency and posting identity: at most one committed header per key and per identity
            c = int(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where idempotency_key = '{key[i]}' or posting_identity = 'FUNDING:{auth[i]}';"))
            check(c <= 1, f"iteration {n}: key/identity {i} committed {c} times")
        overlap = iteration_overlap(barrier_ok, verdicts)
        records.append({"overlap": overlap, "verdicts": verdicts})
        detail.append({"iteration": n, "barrier": results.barrier, "overlap": overlap, "writers": writers,
                       "committed": {"events": events, "versions": versions, "accounts": accounts, "headers": txns, "legs": legs}})
    # Sequential behaviour preserved on a fresh allocation: A at version 1 wins; B at version 1 is STALE_VERSION; B at version 2 wins.
    a = db.seed_allocation("f1-seq")
    check(db.call("post_funding", a, 1, "1.00", ref("AUTH", "F1S-A"), ref("IDEM", "F1S-A")).rc == 0, "sequential writer A")
    rb = db.call("post_funding", a, 1, "1.00", ref("AUTH", "F1S-B"), ref("IDEM", "F1S-B"))
    check((rb.state, rb.message) == ("DW409", "STALE_VERSION"), f"sequential writer B at version 1: {rb.errors}")
    check(db.call("post_funding", a, 2, "1.00", ref("AUTH", "F1S-B"), ref("IDEM", "F1S-B")).rc == 0, "sequential writer B at version 2")
    check(db.scalar("g2_scratch_admin", f"select string_agg(version::text, ',' order by version) from drawbridge_auth.allocation_event where allocation_id='{a}';") == "1,2", "sequential versions")
    summary = summarize_f1(records)
    print("F-1 per-iteration evidence (barrier, overlap, each writer's SQLSTATE/constraint/outcome, committed state):", json.dumps(detail, sort_keys=True, default=str), file=sys.stderr)
    print("F-1 summary:", json.dumps(summary, sort_keys=True), file=sys.stderr)
    if summary["conclusion"] == "FAIL":
        raise CaseFailure("a loser outcome fell outside every known category: " + json.dumps(summary))
    if summary["conclusion"] == "FINDING":
        raise CaseFinding("F-1 CONFIRMED: " + json.dumps(summary, sort_keys=True) + " -- " + F1_VERDICTS["F1_CONFIRMED_OWNER_DECISION_REQUIRED"])
    if summary["conclusion"] == "INCONCLUSIVE":
        raise CaseInconclusive("no iteration was observed to overlap (barrier failures: %d, non-overlapped: %d); this run says NOTHING about F-1: %s"
                               % (summary["barrier_failed"], summary["not_overlapped"], json.dumps(summary, sort_keys=True)))


# --------------------------------------------------------------------------------------------------------- F01-F04, F16 (injection)
# COVERAGE LIMITATION (LOOM-2 V02 N-5). The function inserts both legs with ONE INSERT ... VALUES statement. PostgreSQL queues AFTER ROW
# triggers and runs them after the whole statement, so a trigger "after leg 1" and a trigger "after leg 2" fire at the same point and are
# NOT distinct fault boundaries. D's F02 and F03 are therefore covered by ONE case, "F02/F03", labelled "after the two-leg INSERT
# statement". A fault strictly between the two legs would need the production statement to be split, which is not done here to make the
# test narrative look complete, and migration 0011 is not changed. F02 and F03 are NOT independently verified.
FAULT_COVERAGE_LIMITATION = ("F02 and F03 share one boundary (after the single two-leg INSERT statement); they are not independently verified. "
                             "No fault is injected strictly between the two legs or strictly between account creation and the header.")
FAULT_SQLSTATES = {"F01": "G2F01", "F23": "G2F23", "F04": "G2F04"}
FAULT_LABELS = {"F01": "after the header insert", "F23": "after the two-leg INSERT statement (D's F02 and F03, one boundary)",
                "F04": "after the event insert, before commit"}
FAULT_TRIGGERS = {   # fault -> (table, optional WHEN clause): AFTER INSERT ROW triggers
    "F01": ("journal_txn", None),
    "F23": ("journal_leg", None),
    "F04": ("allocation_event", None),
}


def fault_install_sql(fault: str) -> str:
    table, when = FAULT_TRIGGERS[fault]
    low = fault.lower()
    return (f"create function drawbridge_auth.g2c1_fault_{low}() returns trigger language plpgsql as $f$ begin "
            f"raise exception 'G2C1 injected fault {fault}' using errcode = '{FAULT_SQLSTATES[fault]}'; end $f$;\n"
            f"grant execute on function drawbridge_auth.g2c1_fault_{low}() to drawbridge_owner;\n"
            f"create trigger zz_fault_{low} after insert on drawbridge_auth.{table} for each row"
            + (f" when ({when})" if when else "") + f" execute function drawbridge_auth.g2c1_fault_{low}();\n")


def fault_remove_sql(fault: str) -> str:
    table, _ = FAULT_TRIGGERS[fault]
    low = fault.lower()
    return (f"drop trigger if exists zz_fault_{low} on drawbridge_auth.{table};\n"
            f"drop function if exists drawbridge_auth.g2c1_fault_{low}();\n")


# ---- injection gate (LOOM-2 V02 N-6). A name prefix alone never authorizes fault or defect injection. ALL of these must hold:
#   1. explicit selection: --inject-db NAME, a database different from the acceptance database (--db) and not a default/system name;
#   2. deliberate operator opt-in: environment G2C1_INJECTION_OPTIN equals "DESTROY-THROWAWAY-DATABASE:<NAME>" (the name is part of the
#      value, so an opt-in for one database cannot be replayed against another);
#   3. the prefix drawbridge_g2_scratch_inject (necessary, not sufficient);
#   4. the live server (every connection also passes the runner's own verify_cluster) reports: current_database() = NAME, data_directory =
#      <repo>/build/pg18-g2c1/data exactly, port 54438, empty listen_addresses, fsync on, never the historical cluster;
#   5. a catalog marker the operator placed at creation: the database comment equals INJECTION_MARKER; and it is not a template.
# Operator step (NOT executed by this file): COMMENT ON DATABASE <NAME> IS 'G2C1-THROWAWAY-INJECTION-DATABASE-V1';  (as g2_scratch_admin).
INJECT_OPTIN_ENV = "G2C1_INJECTION_OPTIN"
INJECTION_MARKER = "G2C1-THROWAWAY-INJECTION-DATABASE-V1"
EXPECTED_DATA_DIRECTORY = str(ROOT / "build" / "pg18-g2c1" / "data")
RESERVED_DATABASES = ("postgres", "template0", "template1", "drawbridge_g2_dev", "drawbridge_g2_test", "drawbridge_g2_scratch")
INJECTION_FACTS_SQL = ("select current_database()||'|'||current_setting('data_directory')||'|'||current_setting('port')||'|'||"
                       "current_setting('listen_addresses')||'|'||current_setting('fsync')||'|'||coalesce(shobj_description(d.oid, 'pg_database'), '')||'|'||"
                       "d.datistemplate::text from pg_database d where d.datname = current_database();")


def inject_optin_value(name: str) -> str:
    return f"DESTROY-THROWAWAY-DATABASE:{name}"


def injection_precheck(name, acceptance_database, environ) -> list:
    """The conditions that need no database contact. An empty list means 'may proceed to the live check'."""
    fails = []
    if type(name) is not str or not name:
        return ["no injection database selected (--inject-db)"]
    if not name.startswith(INJECT_DB_PREFIX):
        fails.append(f"'{name}' does not carry the prefix {INJECT_DB_PREFIX}")
    if name in RESERVED_DATABASES or name == acceptance_database:
        fails.append(f"'{name}' is a default, system or acceptance database")
    if environ.get(INJECT_OPTIN_ENV) != inject_optin_value(name):
        fails.append(f"no deliberate opt-in: set {INJECT_OPTIN_ENV}={inject_optin_value(name)}")
    return fails


def injection_live_failures(name: str, facts: str) -> list:
    """Judge the server-reported facts (INJECTION_FACTS_SQL output). Pure, so every rejection is testable offline."""
    parts = facts.split("|")
    if len(parts) != 7:
        return [f"identity facts unreadable ({facts!r})"]
    dbname, datadir, port, listen, fsync, comment, istemplate = parts
    fails = []
    if dbname != name:
        fails.append(f"connected database '{dbname}' is not the selected '{name}'")
    if datadir != EXPECTED_DATA_DIRECTORY:
        fails.append(f"data directory '{datadir}' is not the G2C1 cluster ({EXPECTED_DATA_DIRECTORY})")
    if "pg18-g2/" in datadir + "/" or port == "54418":
        fails.append("this is the historical G2 cluster")
    if port != "54438":
        fails.append(f"port {port} is not 54438")
    if listen != "":
        fails.append("the server listens on a network address")
    if fsync != "on":
        fails.append("fsync is not on")
    if comment != INJECTION_MARKER:
        fails.append("the database does not carry the throwaway-injection marker comment")
    if istemplate != "false":
        fails.append("the database is a template")
    return fails


ACCEPTANCE_DATABASE = {"name": None}   # set by run_all: the database the ordinary cases use


def require_inject_db(db: "Db") -> None:
    """Called first by every injection case. Refuses before ANY database call unless the cheap conditions hold, then verifies the live
    identity and marker. Raises CaseFailure listing every unmet condition."""
    fails = injection_precheck(db.database, ACCEPTANCE_DATABASE["name"], os.environ)
    if not fails:
        fails = injection_live_failures(db.database, db.scalar("g2_scratch_admin", INJECTION_FACTS_SQL))
    check(not fails, "injection refused: " + "; ".join(fails))


@case("G2C1-DBT-26", "AT-8 F01, F02/F03, F04", "fault injected after the header / after the two-leg statement (F02 and F03 are ONE boundary) / after the event: the whole posting rolls back (no account, header, leg, event, key or identity), a control posting succeeds, and the same claim then succeeds",
      inject=True)
def fault_injection(db: Db):
    require_inject_db(db)
    print("fault coverage limitation:", FAULT_COVERAGE_LIMITATION, file=sys.stderr)
    for fault, sqlstate in FAULT_SQLSTATES.items():
        low = fault.lower()
        check(db.admin(fault_install_sql(fault)).rc == 0, f"{fault}: install")
        try:
            # control: with the trigger DISABLED the same arrangement posts normally (a negative test must also pass its control)
            table = FAULT_TRIGGERS[fault][0]
            check(db.admin(f"alter table drawbridge_auth.{table} disable trigger zz_fault_{low};").rc == 0, f"{fault}: disable")
            c = db.seed_allocation(f"{low}-control")
            check(db.call("post_funding", c, 1, "2.00", ref("AUTH", f"{fault}C"), ref("IDEM", f"{fault}C")).rc == 0, f"{fault}: control posting must succeed with the fault disabled")
            check(db.admin(f"alter table drawbridge_auth.{table} enable always trigger zz_fault_{low};").rc == 0, f"{fault}: enable")
            # fault armed: fresh allocation, no accounts
            a = db.seed_allocation(f"{low}-fault")
            r = db.call("post_funding", a, 1, "2.00", ref("AUTH", f"{fault}X"), ref("IDEM", f"{fault}X"))
            check(r.state == sqlstate and f"injected fault {fault}" in (r.message or ""), f"{fault}: expected {sqlstate}, got {r.errors}")
            left = db.scalar("g2_scratch_admin", "select (select count(*) from drawbridge_auth.journal_account where allocation_id='%s')||','||(select count(*) from drawbridge_auth.journal_txn where allocation_id='%s')||','||(select count(*) from drawbridge_auth.journal_leg where allocation_id='%s')||','||(select count(*) from drawbridge_auth.allocation_event where allocation_id='%s');" % (a, a, a, a))
            check(left == "0,0,0,0", f"{fault}: rows left behind (accounts,headers,legs,events) = {left}")
            check(db.scalar("g2_scratch_admin", f"select count(*) from drawbridge_auth.journal_txn where idempotency_key='{ref('IDEM', fault + 'X')}' or posting_identity='FUNDING:{ref('AUTH', fault + 'X')}';") == "0", f"{fault}: key or identity reserved by a rolled-back posting")
            # with the fault removed (disabled), the very same claim posts and is NOT a replay
            check(db.admin(f"alter table drawbridge_auth.{table} disable trigger zz_fault_{low};").rc == 0, f"{fault}: disable again")
            again = db.call("post_funding", a, 1, "2.00", ref("AUTH", f"{fault}X"), ref("IDEM", f"{fault}X"))
            check(again.rc == 0 and again.rows()[0][3] == "f", f"{fault}: the same claim must now post as a first write: {again.out} {again.errors}")
        finally:
            db.admin(fault_remove_sql(fault))
        gone = db.scalar("g2_scratch_admin", f"select count(*) from pg_trigger where tgname = 'zz_fault_{low}';")
        check(gone == "0", f"{fault}: the injected trigger was not removed")


def injected_txn_sql(a: str, tag: str, legs: list, total: str) -> tuple:
    """Header + legs inserted by the scratch administrator with triggers and foreign keys OFF (session_replication_role = replica),
    inside the throwaway injection database only. Returns (sql, txn_id)."""
    txn, auth, key = str(uuid.uuid4()), ref("AUTH", tag), ref("IDEM", tag)
    text = ("begin;\nset local session_replication_role = replica;\n"
            "insert into drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind, total_amount, "
            "posting_identity, identity_generation, reverses_ref, reversed_kind_ref, idempotency_key, authorization_ref) values "
            f"('{txn}', '{PROJECT}', '{a}', '∅', '∅', 'USD', 'FUNDING', {total}, 'FUNDING:{auth}', 1, '∅', '∅', '{key}', '{auth}');\n")
    for n, (name, direction, amount) in enumerate(legs, 1):
        text += ("insert into drawbridge_auth.journal_leg (txn_id, leg_no, account_id, account_name, project_id, allocation_id, obligation_ref, "
                 "exposure_ref, currency, kind, posting_identity, identity_generation, reverses_ref, direction, amount) "
                 f"select '{txn}', {n}, account_id, account_name, project_id, allocation_id, '∅', '∅', 'USD', 'FUNDING', 'FUNDING:{auth}', 1, '∅', "
                 f"'{direction}', {amount} from drawbridge_auth.journal_account where allocation_id = '{a}' and account_name = '{name}';\n")
    return text + "commit;\n", txn


def discrepancies_for(snap: dict, txn_ids: set) -> list:
    out = reconcile.reconcile(snap, require_snapshot_proof=True)["discrepancies"]
    return [d for d in out if d.get("txn_id") in txn_ids]


@case("G2C1-DBT-27", "AT-10 F16", "defects injected by the scratch administrator in the throwaway database (unbalanced header, header without event, extra leg) are each reported by reconciliation; an untouched posting is not",
      inject=True)
def defect_injection(db: Db):
    require_inject_db(db)
    clean, damaged = db.seed_allocation("f16-clean"), db.seed_allocation("f16-dmg")
    rc = db.call("post_funding", clean, 1, "3.00", ref("AUTH", "F16C"), ref("IDEM", "F16C"))
    rd = db.call("post_funding", damaged, 1, "3.00", ref("AUTH", "F16D"), ref("IDEM", "F16D"))
    check(rc.rc == 0 and rd.rc == 0, "setup postings")
    clean_txn, damaged_txn = rc.rows()[0][1], rd.rows()[0][1]
    check(discrepancies_for(db.snapshot(), {clean_txn, damaged_txn}) == [], "control: untouched postings must reconcile")
    unbalanced_sql, unbalanced = injected_txn_sql(damaged, "F16U", [("CASH_ALLOCATED", "D", "5.00"), ("PROJECT_CAPITAL", "C", "4.00")], "5.00")
    orphan_sql, orphan = injected_txn_sql(damaged, "F16O", [("CASH_ALLOCATED", "D", "5.00"), ("PROJECT_CAPITAL", "C", "5.00")], "5.00")
    for sql in (unbalanced_sql, orphan_sql):
        r = db.admin(sql)
        check(r.rc == 0, f"injection failed: {r.err[:300]}")
    extra = db.admin("begin;\nset local session_replication_role = replica;\n"
                     "insert into drawbridge_auth.journal_leg (txn_id, leg_no, account_id, account_name, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind, posting_identity, identity_generation, reverses_ref, direction, amount) "
                     f"select '{damaged_txn}', 3, account_id, account_name, project_id, allocation_id, '∅', '∅', 'USD', 'FUNDING', 'FUNDING:{ref('AUTH', 'F16D')}', 1, '∅', 'D', 1.00 "
                     f"from drawbridge_auth.journal_account where allocation_id = '{damaged}' and account_name = 'CASH_ALLOCATED';\ncommit;\n")
    check(extra.rc == 0, f"extra-leg injection failed: {extra.err[:300]}")
    found = discrepancies_for(db.snapshot(), {clean_txn, damaged_txn, unbalanced, orphan})
    codes = {(d["code"], d["txn_id"]) for d in found}
    check(("TRANSACTION_IMBALANCE", unbalanced) in codes, f"unbalanced header not reported: {sorted(codes)}")
    check(("TRANSACTION_WITHOUT_EVENT", orphan) in codes, f"header without event not reported: {sorted(codes)}")
    check(("LEG_PATTERN_INVALID", damaged_txn) in codes, f"extra leg not reported: {sorted(codes)}")
    check(not any(t == clean_txn for _, t in codes), "the untouched posting was reported (false positive)")


# ======================================================================================================================================
# CASE SELECTION (A9 V02, R1). The selectable maximum is a CEILING, not an authorization: every execution still needs its own exact-hash
# owner authorization. Enforced here, at the dispatcher, and again at the command line.
# ======================================================================================================================================
SELECTABLE = ("G2C1-DBT-02", "G2C1-DBT-03", "G2C1-DBT-04", "G2C1-DBT-05", "G2C1-DBT-06", "G2C1-DBT-07", "G2C1-DBT-08",
              "G2C1-DBT-11", "G2C1-DBT-12", "G2C1-DBT-14", "G2C1-DBT-18", "G2C1-DBT-19", "G2C1-DBT-20")
CASE_ID_RE = re.compile(r"G2C1-DBT-(0[1-9]|1[0-9]|2[0-7])")


class SelectionRefused(snapshot.LaunchRefused):
    """The case selection is missing, empty, malformed, unknown, duplicated, held, outside the selectable maximum, or conflicts with another option."""


def validate_selection(selection) -> tuple:
    """The whole selection or nothing: any invalid element refuses the entire invocation (never a silent removal), and no selection never means all."""
    if selection is None:
        raise SelectionRefused("an explicit, non-empty case selection is required (--cases); absence is never read as all cases")
    if type(selection) is str:
        ids = selection.split(",")
    elif type(selection) in (list, tuple):
        ids = list(selection)
    else:
        raise SelectionRefused("the selection must be a comma-separated string or a list of case identifiers")
    if not ids or any(type(i) is not str or i == "" for i in ids):
        raise SelectionRefused("the selection is empty or contains an empty or non-string element")
    known = [c.case_id for c in CASES]
    bad = [i for i in ids if CASE_ID_RE.fullmatch(i) is None]
    if bad:
        raise SelectionRefused(f"malformed case identifiers: {bad!r}")
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise SelectionRefused(f"unknown case identifiers: {unknown!r}")
    if len(set(ids)) != len(ids):
        raise SelectionRefused(f"duplicate case identifiers: {sorted({i for i in ids if ids.count(i) > 1})!r}")
    held = [i for i in ids if HELD.get(i) is not None]
    if held:
        raise SelectionRefused(f"held cases cannot be selected (the whole command is refused, nothing is dropped): {held!r}")
    outside = [i for i in ids if i not in SELECTABLE]
    if outside:
        raise SelectionRefused(f"cases outside the selectable maximum: {outside!r}")
    return tuple(i for i in known if i in set(ids))      # canonical ascending order, never the command-line order


class SourceIdentityRefused(SelectionRefused):
    """The executing source is not verified against an owner-approved source table (enabled execution refuses an UNVERIFIED or mismatching source)."""


SOURCE_TABLE_SCHEMA = "g2c1-approved-source-v1"
SOURCE_TABLE_KEYS = frozenset({"schema", "commit", "runner_sha256", "registry_sha256", "files"})
MAX_SOURCE_TABLE_BYTES = 65536
_HEX40, _HEX64 = re.compile(r"[0-9a-f]{40}"), re.compile(r"[0-9a-f]{64}")


def git_blob_id(data: bytes) -> str:
    """The Git blob identifier of a file's bytes (computed from content, so an archive export without Git metadata can still be compared)."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()  # noqa: S324 - an identifier that must equal Git's, not a security hash


def executing_sources() -> dict:
    """The harness sources and inputs that execute or are read at run time (the ledger package and the modules this file imports, snapshot.py, this
    file, the synthetic fixture, the runner and migration 0011; A11 F-04): repository-relative path to the SHA-256 and Git blob id of the bytes on
    disk. Computed from the files, never from evidence or from the manifest (no self-reference). None of these files is changed by this harness."""
    out = {}
    for path in ([Path(m.__file__).resolve() for m in (canonical, manifest, reconcile, replay, retry, snapshot)] + [Path(__file__).resolve()]
                 + [(G2DB / "ledger" / "__init__.py").resolve(), (ROOT / "fixtures" / "g2c1_synthetic.json").resolve(), RUNNER.resolve(),
                    (ROOT / "db" / "migrations" / "0011_g2c1_funding_ledger.sql").resolve()]):
        try:
            rel, data = path.relative_to(ROOT).as_posix(), path.read_bytes()
        except (ValueError, OSError) as exc:
            raise SourceIdentityRefused(f"an executing source cannot be read inside the checkout: {path.name}") from exc
        out[rel] = {"sha256": hashlib.sha256(data).hexdigest(), "blob": git_blob_id(data)}
    return dict(sorted(out.items()))


def unverified_source_identity() -> dict:
    """What a run without an owner-approved source table records: UNVERIFIED and a null commit. Offline testing may use it; enabled execution may not."""
    return {"status": "UNVERIFIED", "commit": None, "files": executing_sources(), "runner_sha256": snapshot.RUNNER_SHA256, "approved_source_table_sha256": None}


def _no_duplicate_keys(pairs):
    keys = [k for k, _ in pairs]
    if len(set(keys)) != len(keys):
        raise SourceIdentityRefused("the approved source table repeats a key")
    return dict(pairs)


def load_approved_source(path) -> tuple:
    """Read an owner-approved source table (a small JSON file supplied at invocation): a regular file, not a symbolic link, strict schema, no
    repeated keys. Returns (table, SHA-256 of its bytes). Nothing is defaulted and no commit is built into this source."""
    if type(path) is not str and not isinstance(path, Path):
        raise SourceIdentityRefused("the approved source table path is missing")
    p = Path(path)
    try:
        st = os.lstat(p)
    except OSError as exc:
        raise SourceIdentityRefused("the approved source table cannot be read") from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or st.st_size > MAX_SOURCE_TABLE_BYTES:
        raise SourceIdentityRefused("the approved source table must be a regular file (not a symbolic link) of at most 64 KiB")
    raw = p.read_bytes()
    try:
        table = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_keys)
    except (UnicodeDecodeError, ValueError) as exc:
        raise SourceIdentityRefused("the approved source table is not valid JSON") from exc
    if type(table) is not dict or set(table) != SOURCE_TABLE_KEYS or table["schema"] != SOURCE_TABLE_SCHEMA:
        raise SourceIdentityRefused("the approved source table does not have the exact schema")
    if type(table["commit"]) is not str or not _HEX40.fullmatch(table["commit"]):
        raise SourceIdentityRefused("the approved source table needs a 40-hex commit")
    for key in ("runner_sha256", "registry_sha256"):
        if type(table[key]) is not str or not _HEX64.fullmatch(table[key]):
            raise SourceIdentityRefused(f"the approved source table needs a 64-hex {key}")
    files = table["files"]
    if type(files) is not dict or not files or any(type(k) is not str or type(v) is not dict or set(v) != {"sha256", "blob"}
                                                    or type(v["sha256"]) is not str or not _HEX64.fullmatch(v["sha256"])
                                                    or type(v["blob"]) is not str or not _HEX40.fullmatch(v["blob"]) for k, v in files.items()):
        raise SourceIdentityRefused("the approved source table files must map a path to exactly a SHA-256 and a blob id")
    return table, hashlib.sha256(raw).hexdigest()


def verify_source_identity(table: dict, table_sha256: str) -> dict:
    """Compare the executing sources, the runner pin and the registry digest with the approved table: every difference refuses (before any launch)."""
    have, problems = executing_sources(), []
    if set(have) != set(table["files"]):
        problems.append(f"file set differs: missing {sorted(set(table['files']) - set(have))}, extra {sorted(set(have) - set(table['files']))}")
    for rel in sorted(set(have) & set(table["files"])):
        if have[rel] != table["files"][rel]:
            problems.append(f"{rel} differs from the approved source")
    if table["runner_sha256"] != snapshot.RUNNER_SHA256:
        problems.append("the runner SHA-256 differs")
    if table["registry_sha256"] != registry_digest():
        problems.append("the operation-set digest differs")
    if problems:
        raise SourceIdentityRefused("the executing source is not the owner-approved source: " + "; ".join(problems))
    return {"status": "BOUND", "commit": table["commit"], "files": have, "runner_sha256": snapshot.RUNNER_SHA256, "approved_source_table_sha256": table_sha256}


def write_selection_manifest(evidence_dir, ids: tuple, database: str, identity: dict | None = None) -> str:
    """The exact selection, the target, the operation-set digest, the harness source identity and the pinned runner, hashed, written exclusively
    BEFORE any launch. Returns its SHA-256 (also written to selection.json.sha256)."""
    doc = json.dumps({"schema": 2, "selected": list(ids), "database": database, "selectable_maximum": list(SELECTABLE),
                      "registry_sha256": registry_digest(), "runner_sha256": snapshot.RUNNER_SHA256,
                      "source_identity": identity if identity is not None else unverified_source_identity()}, sort_keys=True, indent=1) + "\n"
    digest = hashlib.sha256(doc.encode()).hexdigest()
    d = Path(evidence_dir)
    for name, text in (("selection.json", doc), ("selection.json.sha256", f"{digest}  selection.json\n")):
        try:
            fd = os.open(d / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except OSError as exc:
            raise SelectionRefused(f"the selection manifest could not be written ({exc.__class__.__name__}); nothing was launched") from exc
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
    return digest


def dispatch_case(c: "Case", target: "Db", plan: tuple) -> None:
    """The dispatch boundary: a case body is entered only if it is in the validated plan, not held, and inside the selectable maximum."""
    if c.case_id not in plan or c.hold is not None or c.case_id not in SELECTABLE:
        raise SelectionRefused(f"{c.case_id} is not an authorized selection")
    target.case_id = c.case_id
    c.body(target)


def run_all(enabled: bool = False, database=None, inject_database: str | None = None, *, cases=None, evidence_dir=None, run=subprocess.run,
            runner: Path = snapshot.RUNNER, approved_source=None) -> list:
    """With enabled=False nothing connects: every case is reported NOT RUN. There is no default database and, for an enabled run, no default
    selection: when enabled, the database must be exactly the acceptance database and `cases` must be an explicit valid selection, otherwise
    this raises BEFORE any launch. Held cases (EXCLUDED, DEFERRED, GATE-F) are never selectable. Unselected cases are reported NOT RUN. An enabled run
    also needs an owner-approved source table that the executing sources match (A10 R7); an UNVERIFIED source refuses before the manifest and any launch."""
    report = []
    if enabled and inject_database is not None:
        raise SelectionRefused("an injection database is not accepted together with --enable")
    if enabled and cases is None:
        raise SelectionRefused("an enabled run needs an explicit case selection; it never defaults to all cases")
    plan = validate_selection(cases) if cases is not None else ()
    if enabled or database is not None:
        snapshot.require_acceptance_target(database)
    identity = None
    if approved_source is not None:
        identity = verify_source_identity(*load_approved_source(approved_source))
    if enabled and identity is None:
        raise SourceIdentityRefused("an enabled run needs an owner-approved source table (--approved-source); an UNVERIFIED source is refused")
    if enabled:
        prepare_evidence_dir(evidence_dir)
        write_selection_manifest(evidence_dir, plan, database, identity)
    db = Db(database, evidence_dir=evidence_dir, run=run, runner=runner) if database is not None else None
    ACCEPTANCE_DATABASE["name"] = database
    for c in CASES:
        row = {"case_id": c.case_id, "criteria": c.criteria, "title": c.title}
        if c.hold is not None:
            row.update(status="NOT RUN", hold=c.hold[0], reason=f"{c.hold[0]}: {c.hold[1]}")
            report.append(row)
            continue
        if not enabled:
            row.update(status="NOT RUN", reason="database execution is not authorized in the source-only pass")
            report.append(row)
            continue
        if c.case_id not in plan:
            row.update(status="NOT RUN", reason="not selected")
            report.append(row)
            continue
        try:
            dispatch_case(c, db, plan)
            row.update(status="PASS", reason="observed")
        except CaseInconclusive as exc:
            row.update(status="INCONCLUSIVE", reason=str(exc)[:900])
        except CaseFinding as exc:
            row.update(status="FINDING", reason=str(exc)[:900])
        except CaseFailure as exc:
            row.update(status="FAIL", reason=str(exc)[:500])
        except Exception as exc:  # noqa: BLE001 - an unexpected error (including a refused launch) is a FAIL, never a silent skip
            row.update(status="FAIL", reason=f"{type(exc).__name__}: {str(exc)[:400]}")
        report.append(row)
    return report


KNOWN_FLAGS = ("--enable", "--db", "--inject-db", "--evidence-dir", "--cases", "--approved-source")


def parse_argv(argv: list) -> dict:
    """Strict: only the six known flags, each at most once, each value present and not itself a flag. Anything else is refused before any
    command (no host, port, user, database or other override exists)."""
    opts, i = {}, 0
    while i < len(argv):
        flag = argv[i]
        if flag not in KNOWN_FLAGS or flag in opts:
            raise snapshot.TargetRefused(f"unsupported or repeated argument {flag!r}")
        if flag == "--enable":
            opts[flag] = True
            i += 1
            continue
        if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
            raise snapshot.TargetRefused(f"{flag} needs a value")
        opts[flag] = argv[i + 1]
        i += 2
    return opts


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        opts = parse_argv(argv)
        if "--db" not in opts:
            raise snapshot.TargetRefused("--db drawbridge_g2_scratch is required; there is no default database")
        database = snapshot.require_acceptance_target(opts["--db"])
        if "--inject-db" in opts and ("--enable" in opts or "--cases" in opts):
            raise SelectionRefused("--inject-db conflicts with --enable and --cases")
        if "--enable" in opts and "--cases" not in opts:
            raise SelectionRefused("--enable requires an explicit --cases selection; it never defaults to all cases")
        selected = validate_selection(opts["--cases"]) if "--cases" in opts else None
        if "--enable" in opts and "--approved-source" not in opts:
            raise SourceIdentityRefused("--enable requires --approved-source (an owner-approved source table); an UNVERIFIED source is refused")
        identity = verify_source_identity(*load_approved_source(opts["--approved-source"])) if "--approved-source" in opts else None
    except snapshot.LaunchRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    enable = "--enable" in opts
    if enable and os.environ.get(ENABLE_ENV) != ENABLE_VALUE:
        print(f"REFUSED: set {ENABLE_ENV}={ENABLE_VALUE} to run against the G2C1 cluster", file=sys.stderr)
        return 3
    if selected is not None:
        print("SELECTED CASES: " + ",".join(selected), file=sys.stderr)
    print("SOURCE IDENTITY: " + ("UNVERIFIED (no commit)" if identity is None else f"BOUND to the approved table, commit {identity['commit']}"), file=sys.stderr)
    try:
        report = run_all(enabled=enable, database=database, inject_database=opts.get("--inject-db"), cases=selected, evidence_dir=opts.get("--evidence-dir"),
                         approved_source=opts.get("--approved-source"))
    except snapshot.LaunchRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    if not enable:
        return 0
    return 0 if all(r["status"] == "PASS" for r in report if r["case_id"] in (selected or ())) else 1


if __name__ == "__main__":
    sys.exit(main())
