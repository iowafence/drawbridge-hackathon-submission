"""One consistent read-only database snapshot for replay, reconciliation and the manifest (C1-A1 C-11f), and the shared launcher.

SIMULATION ONLY. The reader connects as `drawbridge_reader` through the G2C1 guarded runner and reads the three
drawbridge_read views inside a SINGLE `REPEATABLE READ READ ONLY` transaction, in a SINGLE statement, so the three views cannot
tear under a concurrent posting. The same statement reports `transaction_read_only` and `transaction_isolation`; this module
refuses a result that does not show `on` and `repeatable read`.

This module cannot post: the reader role holds SELECT on the views only. It never connects to the existing build/pg18-g2 cluster;
the runner it calls refuses every target except the dedicated G2C1 cluster. The `run` parameter exists so offline tests can
substitute a fake process runner; the default runs the real runner and therefore REQUIRES the G2C1 cluster.

SHARED LAUNCHER (SIM-ENG-003-G2C1-A8, functional harness Gate A). Every launch of the approved runner, from this module and from
tests/db_cases.py, goes through `launch_runner`:
  * the runner file is executed DIRECTLY (its shebang is `/usr/bin/bash -p`); never `bash <runner>`, never a shell, never `shell=True`;
  * before every launch the file must be a regular, non-symbolic-link, executable file whose SHA-256 is the approved runner hash;
  * the environment is an explicit dictionary (PATH, HOME, LANG and, only when it is one of the three values the runner accepts,
    PGOPTIONS): nothing is inherited from the caller;
  * standard output and standard error go to FILES (never a pipe that can close); standard input is the null device;
  * the exact exit status and the SHA-256 of both output files are returned.
A database is accepted only if it is exactly the acceptance database; any other name is refused BEFORE any launch.

REGISTERED SQL AT THE LAUNCH BOUNDARY (SIM-ENG-003-G2C1-A10). A psql `-c` value is accepted ONLY as a RegisteredCall: an operation name and typed
parameters, never SQL text. `launch_runner` reads the call once and RE-DERIVES the statement itself from the registry in this module (template,
slot grammar and limits, statement count, registered role, isolation options, the pinned registry digest); a plain string, a subclass, a half-built
or edited object, an unknown operation or an invalid parameter is refused before any launch. The claim is limited to the governed harness
interfaces: it does not defend against code that already executes with the harness's own privileges, and PostgreSQL's reading of a payload is not
established by any offline check.
"""
from __future__ import annotations

import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import tempfile
import types
from dataclasses import dataclass, field
from pathlib import Path

RUNNER = Path(__file__).resolve().parents[1] / "tools" / "g2c1_durable_cluster.sh"
RUNNER_SHA256 = "f99374307cd3ade7b0dff6cfb754a28d0cf4d515c394d1f60c63e4b216973414"   # the owner-approved runner (A5, A6); nothing else may be launched
RUNNER_BASENAME = "g2c1_durable_cluster.sh"   # A12 F-A: the only file name a runner path may end in
CONCRETE_PATH = type(Path())                  # A12 F-A: the exact concrete path class of this platform (PosixPath here); never Path itself, never a subclass
ACCEPTANCE_DATABASE = "drawbridge_g2_scratch"
READER_ROLE = "drawbridge_reader"
# The only PGOPTIONS values the runner's `psql` command accepts (validate_caller_pgoptions); anything else is refused here first.
ALLOWED_PGOPTIONS = frozenset({
    "-c default_transaction_isolation=serializable",
    "-c default_transaction_isolation=read\\ committed",
    "-c default_transaction_isolation=repeatable\\ read",
})
LABEL_RE = re.compile(r"[A-Za-z0-9._-]{1,120}")
INJECT_DB_RE = re.compile(r"drawbridge_g2_scratch_inject[a-z0-9_]*")
PSQL_ROLES = ("g2_scratch_admin", "authority_svc", "drawbridge_reader")   # the roles the harness may use through the runner's psql command
READ_COMMANDS = ("identity", "status")
CONTROL_COMMANDS = ("init", "start", "stop", "crash-stop", "crash-kill")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
PSQL_FLAGS = ("-At", "-A", "-t", "-1")
MAX_PAYLOAD_BYTES = 100_000


class SnapshotError(RuntimeError):
    """The snapshot could not be read, or it does not prove a read-only repeatable-read read."""


class LaunchRefused(RuntimeError):
    """A launch was refused BEFORE the runner was started (target, runner identity, environment, evidence file or payload)."""


class TargetRefused(LaunchRefused):
    """The database name is not the acceptance database (missing, unknown, historical, an injection database or any override)."""


class PayloadRefused(LaunchRefused):
    """The SQL payload failed whole-payload validation and was never submitted."""


class CommandRefused(LaunchRefused):
    """The runner command, its arguments or its role are not permitted by the interface (refused before any launch)."""


def classify_runner_command(args, *, allow_injection: bool = False, allow_control: bool = False, pgoptions: str | None = None) -> str:
    """Validate a runner argument vector BEFORE any launch and return the command class: 'psql', 'read', 'database' or 'control'. See
    plan_runner_command for what is verified."""
    return plan_runner_command(args, allow_injection=allow_injection, allow_control=allow_control, pgoptions=pgoptions)[0]


def capture_vector(args) -> tuple:
    """A11 F-01: the single read of a caller's argument vector. Only an EXACT `list` or `tuple` is accepted (a subclass could return different values
    on each read); its elements are copied once into a new tuple and every element must be an exact `str` or an exact `RegisteredCall` (whose own
    fields are an immutable name and an immutable tuple of (str, str | int) pairs). Nothing else is read from the caller's container afterwards."""
    if type(args) is not list and type(args) is not tuple:
        raise CommandRefused("the runner arguments must be an exact built-in list or tuple (no subclass)")
    captured = tuple(args)
    if any(type(a) is not str and type(a) is not RegisteredCall for a in captured):
        raise CommandRefused("every runner argument must be an exact string (or the registered call of psql -c)")
    return captured


def plan_runner_command(args, *, allow_injection: bool = False, allow_control: bool = False, pgoptions: str | None = None) -> tuple:
    """Validate a runner argument vector BEFORE any launch and return (class, argument strings, operation info). Database-bearing commands must
    name exactly the acceptance database (an injection name only with allow_injection); cluster-control commands are refused unless
    allow_control; everything else is refused. For `psql` (A10 R1) the vector must match the runner's closed argument allowlist AND carry exactly
    one `-c` whose value is a RegisteredCall: the SQL text is DERIVED here from the registry (operation, template, typed parameters, limits,
    statement count), the psql role must be the role registered for that operation, and PGOPTIONS is allowed only for an operation that takes
    isolation options. SQL text supplied by a caller is refused. The returned argument strings are the only thing that is launched.
    A11 F-01: the vector must be an EXACT built-in list or tuple (no subclass), it is captured ONCE into an immutable tuple of exact-type elements,
    and both validation and the returned launch vector use only that captured tuple; the caller's container is never read again."""
    args = capture_vector(args)
    if pgoptions is not None and type(pgoptions) is not str:
        raise CommandRefused("PGOPTIONS must be a string or None")
    if type(allow_injection) is not bool or type(allow_control) is not bool:
        raise CommandRefused("the injection and control flags must be booleans")
    if not args or type(args[0]) is not str or any(type(a) is not str and type(a) is not RegisteredCall for a in args):
        raise CommandRefused("the runner arguments must be a non-empty list of strings")
    if args[0] != "psql" and any(type(a) is not str for a in args):
        raise CommandRefused("only a psql command carries a registered call")
    if args[0] != "psql" and pgoptions is not None:
        raise CommandRefused("PGOPTIONS applies only to registered psql operations")
    command, rest = args[0], list(args[1:])

    def db_ok(name):
        if allow_injection and type(name) is str and INJECT_DB_RE.fullmatch(name):
            return name
        return require_acceptance_target(name)
    if command in READ_COMMANDS:
        if rest:
            raise CommandRefused(f"{command} takes no arguments")
        return "read", tuple(args), None
    if command in CONTROL_COMMANDS:
        if not allow_control:
            raise CommandRefused(f"{command} is a cluster-control command and is not permitted by this interface")
        if rest:
            raise CommandRefused(f"{command} takes no arguments")
        return "control", tuple(args), None
    if command in ("bootstrap", "migrate-base"):
        if len(rest) != 1:
            raise CommandRefused(f"{command} takes exactly one database")
        db_ok(rest[0])
        return "database", tuple(args), None
    if command == "migrate-0011":
        if len(rest) != 2 or not SHA256_RE.fullmatch(rest[1]):
            raise CommandRefused("migrate-0011 takes a database and a SHA-256")
        db_ok(rest[0])
        return "database", tuple(args), None
    if command == "psql":
        if len(rest) < 3:
            raise CommandRefused("psql takes a database, a role and arguments")
        if type(rest[0]) is not str or type(rest[1]) is not str:
            raise CommandRefused("the psql database and role must be strings")
        db_ok(rest[0])
        if rest[1] not in PSQL_ROLES:
            raise CommandRefused(f"role {rest[1]!r} is not permitted")
        argv, i, calls, out = rest[2:], 0, [], list(args[:3])
        while i < len(argv):
            a = argv[i]
            if type(a) is not str:
                raise CommandRefused("a registered call may appear only as the value of -c")
            if a in PSQL_FLAGS:
                out.append(a)
                i += 1
            elif a == "-F":
                if i + 1 >= len(argv) or type(argv[i + 1]) is not str or not 1 <= len(argv[i + 1]) <= 8 or "\\" in argv[i + 1]:
                    raise CommandRefused("malformed -F")
                out += [a, argv[i + 1]]
                i += 2
            elif a == "-v":
                if i + 1 >= len(argv) or type(argv[i + 1]) is not str or re.fullmatch(r"(VERBOSITY=(default|verbose|terse|sqlstate)|[a-z][a-z0-9_]{0,31}=[^\\]{0,4096})", argv[i + 1]) is None:
                    raise CommandRefused("malformed -v")
                out += [a, argv[i + 1]]
                i += 2
            elif a == "-c":
                if i + 1 >= len(argv):
                    raise CommandRefused("malformed -c")
                calls.append(argv[i + 1])
                out += [a, None]
                i += 2
            else:
                raise CommandRefused(f"psql argument {a!r} is not permitted (no -f, no host, port, user, database or file)")
        if len(calls) != 1:
            raise CommandRefused("psql needs exactly one -c registered call (one request is one transaction)")
        op, text = derive_registered_payload(calls[0])
        if rest[1] != op.role:
            raise CommandRefused(f"operation {op.name} runs as role {op.role!r}, not {rest[1]!r}")
        if pgoptions is not None and not op.options_ok:
            raise PayloadRefused(f"operation {op.name} does not take isolation options")
        out[out.index(None)] = text
        return "psql", tuple(out), {"operation": op.name, "role": op.role, "statements": op.statements, "payload_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    raise CommandRefused(f"unknown runner command {command!r}")

def require_acceptance_target(database) -> str:
    """Exact match only: no case folding, trailing characters, whitespace, quoting or prefix match. Raised before any launch."""
    if type(database) is not str:
        raise TargetRefused("a database must be selected explicitly (--db drawbridge_g2_scratch); there is no default")
    if database != ACCEPTANCE_DATABASE:
        raise TargetRefused(f"refused: {database!r} is not the acceptance database {ACCEPTANCE_DATABASE!r}")
    return database


def verified_home() -> str:
    """The executing account's home directory from the account database: absolute, no symbolic-link component, owned by the account. The real
    and effective UIDs must be equal (A12 F-D/F-I): a process whose identities differ is refused rather than resolved to either account."""
    if os.getuid() != os.geteuid():
        raise LaunchRefused("the real and effective UIDs differ; the executing account is ambiguous")
    home = pwd.getpwuid(os.getuid()).pw_dir
    if not os.path.isabs(home) or os.path.realpath(home) != home:
        raise LaunchRefused("the account home directory is not an absolute path without symbolic links")
    try:
        st = os.stat(home)
    except OSError as exc:
        raise LaunchRefused("the account home directory cannot be read") from exc
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise LaunchRefused("the account home directory is not a directory owned by the executing account")
    return home


def capture_runner(runner) -> str:
    """Read the caller's runner value exactly ONCE and return one canonical pathname string (A12 F-A). Only an exact built-in `str` or an exact
    instance of the platform's concrete path class is accepted, checked by `type(...) is`, so no subclass, no other os.PathLike object and no
    object with its own conversion methods is ever converted: a refused value has none of its methods called. The string must be absolute,
    free of NUL, normalized, without a symbolic link in any component (it equals its own realpath), and end in the approved runner file name."""
    kind = type(runner)
    if kind is str:
        path = runner
    elif kind is CONCRETE_PATH:
        path = os.fspath(runner)            # the platform class's own conversion, evaluated once; never a caller-defined method
    else:
        raise LaunchRefused(f"the runner must be an exact str or {CONCRETE_PATH.__name__}, not {kind.__name__}")
    if type(path) is not str or not path or "\x00" in path:
        raise LaunchRefused("the runner path is not a usable string")
    if not os.path.isabs(path):
        raise LaunchRefused("the runner path must be absolute")
    if os.path.normpath(path) != path:
        raise LaunchRefused("the runner path must be normalized (no '.', '..' or repeated separator)")
    if os.path.realpath(path) != path:
        raise LaunchRefused("the runner path has a symbolic-link component")
    if os.path.basename(path) != RUNNER_BASENAME:
        raise LaunchRefused(f"the runner file name must be exactly {RUNNER_BASENAME}")
    return path


def _identity(st) -> tuple:
    return (st.st_dev, st.st_ino, st.st_size, st.st_mode, st.st_mtime_ns)


def check_runner(runner, pin: str = RUNNER_SHA256) -> str:
    """Capture the runner path once, verify the file it names, and RETURN that same captured string: the caller launches exactly this value and
    never converts its own object again (A12 F-A). The file must be a regular, non-symbolic-link, executable file; it is opened with O_NOFOLLOW,
    the open descriptor must be the same file (device and inode) as the path, its bytes must hash to the pin, and the path must still name the same
    file (device, inode, size, mode, modification time) after hashing. Raised before any launch.
    RESIDUAL (A12 F-B, documented, not eliminated): the runner is then executed BY PATHNAME, so an actor able to replace the file between this
    final check and the process start is not prevented; these checks only narrow that window and detect a replacement that already happened."""
    path = capture_runner(runner)
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise LaunchRefused("the runner file cannot be read") from exc
    if stat.S_ISLNK(st.st_mode):
        raise LaunchRefused("the runner is a symbolic link")
    if not stat.S_ISREG(st.st_mode) or not (st.st_mode & 0o111) or not os.access(path, os.X_OK):
        raise LaunchRefused("the runner is not an executable regular file; it must be executed directly, not through an interpreter")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise LaunchRefused("the runner file cannot be read") from exc
    try:
        fst = os.fstat(fd)
        if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            raise LaunchRefused("the runner file changed between its check and its opening")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                break
            digest.update(chunk)
    except OSError as exc:
        raise LaunchRefused("the runner file cannot be read") from exc
    finally:
        os.close(fd)
    have = digest.hexdigest()
    if have != pin:
        raise LaunchRefused(f"the runner SHA-256 {have} is not the approved runner {pin}")
    try:
        after = os.lstat(path)
    except OSError as exc:
        raise LaunchRefused("the runner file disappeared after hashing") from exc
    if _identity(after) != _identity(st) or _identity(after)[:2] != (fst.st_dev, fst.st_ino):
        raise LaunchRefused("the runner file changed while it was being verified")
    return path


def launch_environment(pgoptions: str | None = None) -> dict:
    """An explicit, minimal environment (the same keys as the approved clean launcher, plus a closed-list PGOPTIONS)."""
    env = {"PATH": "/usr/bin:/bin", "HOME": verified_home(), "LANG": "C.UTF-8"}
    if pgoptions is not None:
        if type(pgoptions) is not str or pgoptions not in ALLOWED_PGOPTIONS:
            raise LaunchRefused(f"PGOPTIONS {pgoptions!r} is not one of the values the runner accepts")
        env["PGOPTIONS"] = pgoptions
    return env


@dataclass
class LaunchResult:
    rc: int
    out: str
    err: str
    argv: tuple
    env: dict
    label: str
    stdout_path: str | None = None
    stderr_path: str | None = None
    stdout_sha256: str = ""
    stderr_sha256: str = ""
    operation: str | None = None
    payload_sha256: str | None = None

    @property
    def returncode(self) -> int:
        return self.rc

    @property
    def stdout(self) -> str:
        return self.out

    @property
    def stderr(self) -> str:
        return self.err


def _open_output(evidence_dir, label: str, suffix: str):
    if evidence_dir is None:
        return tempfile.TemporaryFile("w+b"), None
    d = Path(evidence_dir)
    if d.is_symlink() or not d.is_dir():
        raise LaunchRefused("the evidence directory must be an existing directory, not a symbolic link")
    path = d / f"{label}.{suffix}"
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError as exc:
        raise LaunchRefused(f"evidence file {path.name} already exists; nothing is overwritten") from exc
    return os.fdopen(fd, "w+b"), str(path)


def _read_back(handle) -> bytes:
    handle.flush()
    handle.seek(0)
    return handle.read()


def launch_runner(args, *, pgoptions: str | None = None, evidence_dir=None, label: str = "run", run=subprocess.run,
                  runner: Path = RUNNER, timeout: float = 120, allow_injection: bool = False,
                  allow_control: bool = False) -> LaunchResult:
    """Execute the approved runner directly with an explicit environment and file-captured output. Returns the exact exit status. The
    command, its target database and its psql arguments are validated HERE, independently of every caller, before any launch. The argument
    vector is captured once (exact list or tuple only) and only the validated capture is launched (A11 F-01). There is no pin override: the file
    launched must always have the approved runner SHA-256 (A11 B-3). The runner value is captured once by check_runner, and argv[0] is the very
    string it verified (A12 F-A); `runner` is not read anywhere else in this function. The path-swap window between that check and the process
    start remains (A12 F-B)."""
    _cls, plain, info = plan_runner_command(args, allow_injection=allow_injection, allow_control=allow_control, pgoptions=pgoptions)
    if type(label) is not str or LABEL_RE.fullmatch(label) is None:
        raise LaunchRefused("the launch label is not a safe file-name component")
    if type(timeout) not in (int, float) or not 0 < timeout <= 3600:
        raise LaunchRefused("the timeout must be a positive number of seconds")
    verified_path = check_runner(runner, RUNNER_SHA256)
    env = launch_environment(pgoptions)
    argv = (verified_path, *plain)
    fo, po = _open_output(evidence_dir, label, "stdout")
    try:
        fe, pe = _open_output(evidence_dir, label, "stderr")
    except LaunchRefused:
        fo.close()
        raise
    try:
        try:
            done = run(list(argv), env=env, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise LaunchRefused(f"the runner did not finish within {timeout} seconds") from exc
        rc = done.returncode
        if type(rc) is not int:
            raise LaunchRefused("the process runner returned no integer exit status")
        raw_out, raw_err = _read_back(fo), _read_back(fe)
    finally:
        fo.close()
        fe.close()
    try:
        out, err = raw_out.decode("utf-8"), raw_err.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise LaunchRefused("the runner output is not valid UTF-8; the evidence is unreadable") from exc
    return LaunchResult(rc, out, err, argv, env, label, po, pe, hashlib.sha256(raw_out).hexdigest(), hashlib.sha256(raw_err).hexdigest(),
                        info["operation"] if info else None, info["payload_sha256"] if info else None)


# ------------------------------------------------------------------------------------------------ whole-payload SQL validation
_DOLLAR_OPEN = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
_TXN_FIRST = ("BEGIN", "START")
_TXN_LAST = ("COMMIT", "END")
_TXN_FORBIDDEN_INSIDE = ("BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "PREPARE")


def _scan(sql: str) -> list:
    """Split a payload into top-level statements with literals, quoted identifiers and comments blanked out. Raises PayloadRefused on an
    unterminated construct or on a psql-interpolation form outside a literal (these never reach the server through -c)."""
    stmts, cur, i, n = [], [], 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            j = i + 1
            while True:
                k = sql.find("'", j)
                if k < 0:
                    raise PayloadRefused("unterminated string literal")
                if k + 1 < n and sql[k + 1] == "'":
                    j = k + 2
                    continue
                break
            cur.append("''")
            i = k + 1
        elif ch == '"':
            j = i + 1
            while True:
                k = sql.find('"', j)
                if k < 0:
                    raise PayloadRefused("unterminated quoted identifier")
                if k + 1 < n and sql[k + 1] == '"':
                    j = k + 2
                    continue
                break
            cur.append('""')
            i = k + 1
        elif ch == "-" and sql.startswith("--", i):
            k = sql.find("\n", i)
            i = n if k < 0 else k + 1
            cur.append(" ")
        elif ch == "/" and sql.startswith("/*", i):
            depth, j = 1, i + 2
            while depth:
                a, b = sql.find("/*", j), sql.find("*/", j)
                if b < 0:
                    raise PayloadRefused("unterminated block comment")
                if 0 <= a < b:
                    depth, j = depth + 1, a + 2
                else:
                    depth, j = depth - 1, b + 2
            cur.append(" ")
            i = j
        elif ch == "$" and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] in "_$" or ord(sql[i - 1]) > 127)) and (m := _DOLLAR_OPEN.match(sql, i)):
            k = sql.find(m.group(0), m.end())
            if k < 0:
                raise PayloadRefused("unterminated dollar-quoted string")
            cur.append("$$")
            i = k + len(m.group(0))
        elif ch == ";":
            stmts.append("".join(cur).strip())
            cur = []
            i += 1
        else:
            if ch == ":" and i + 1 < n and (i == 0 or sql[i - 1] != ":") and (sql[i + 1] in "'\"{" or sql[i + 1].isalpha() or sql[i + 1] == "_"):
                raise PayloadRefused("psql variable interpolation (:name, :'name', :\"name\", :{?name}) is not available through -c and is refused")
            if ord(ch) > 127:
                # PostgreSQL treats every code point above 0x7f as an identifier character; a scanner that guesses is not a boundary. Non-ASCII
                # text is allowed only INSIDE quoted literals and comments; anywhere else the payload is refused (X-1).
                raise PayloadRefused("a non-ASCII character outside a quoted literal or comment is refused")
            cur.append(ch)
            i += 1
    tail = "".join(cur).strip()
    if tail:
        stmts.append(tail)
    return stmts


def validate_sql_payload(sql) -> str:
    """Whole-payload validation BEFORE any launch. One -c argument is one request: it is accepted only as exactly one statement, or as an
    explicit transaction block (first statement BEGIN/START, last COMMIT/END, no other transaction control inside). It is NOT claimed
    that -c is atomic against partial effects of arbitrary SQL, and no multi-statement payload without explicit boundaries is accepted
    (the old `-f -` path ran each statement on its own)."""
    if type(sql) is not str:
        raise PayloadRefused("the SQL payload must be a string")
    if not sql.strip():
        raise PayloadRefused("the SQL payload is empty")
    try:
        encoded = sql.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise PayloadRefused("the SQL payload is not valid UTF-8") from exc
    if len(encoded) > MAX_PAYLOAD_BYTES:
        raise PayloadRefused("the SQL payload is too large")
    for ch in sql:
        if ch == "\\":
            raise PayloadRefused("the SQL payload contains a backslash (a psql meta-command or escape); the runner refuses it as well")
        if ord(ch) == 0 or (ord(ch) < 32 and ch not in "\n\t") or ord(ch) == 127:
            raise PayloadRefused("the SQL payload contains a control character")
    stmts = _scan(sql)
    if not stmts or any(not s for s in stmts):
        raise PayloadRefused("the SQL payload contains an empty statement")
    if len(stmts) > 1:
        words = [s.split(None, 1)[0].upper() for s in stmts]
        if words[0] not in _TXN_FIRST or words[-1] not in _TXN_LAST or any(w in _TXN_FORBIDDEN_INSIDE for w in words[1:-1]):
            raise PayloadRefused("a multi-statement payload must be one explicit transaction block (BEGIN ... COMMIT); submit separate units separately")
    return sql


SNAPSHOT_SQL = """\
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'txn_read_only', current_setting('transaction_read_only'),
  'txn_isolation', current_setting('transaction_isolation'),
  'events', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.allocation_id, s.version), '[]'::jsonb)
               FROM drawbridge_read.ledger_event_stream s),
  'balances', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.allocation_id, b.account_name), '[]'::jsonb)
                 FROM drawbridge_read.ledger_account_balance b),
  'reconciliation', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.txn_id), '[]'::jsonb)
                       FROM drawbridge_read.ledger_reconciliation r)
)::text;
COMMIT;
"""


UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MARKER_RE = re.compile(r"\{\{([a-z_][a-z0-9_]*):(uuid|int|text|numeric|fn|role|account|dir)\}\}")
POSTING_FUNCTIONS = ("post_funding", "post_funding_reduction")
NUMERIC_RE = re.compile(r"[0-9]{1,11}\.[0-9]{2}")
ENUMS = {"fn": POSTING_FUNCTIONS, "role": ("authority_svc", "drawbridge_reader"), "account": ("CASH_ALLOCATED", "PROJECT_CAPITAL", "DISBURSED"), "dir": ("D", "C")}


def sql_uuid(value) -> str:
    """A UUID literal: lower-case hyphenated text only; the caller's template adds the cast."""
    if type(value) is not str or UUID_RE.fullmatch(value) is None:
        raise PayloadRefused(f"not a lower-case hyphenated UUID: {value!r}")
    return "'" + value + "'"


def sql_int(value) -> str:
    """A bigint literal: an int (not a bool) inside the 64-bit range."""
    if type(value) is not int or not -(2 ** 63) <= value < 2 ** 63:
        raise PayloadRefused(f"not a bigint: {value!r}")
    return str(value)


def sql_text(value) -> str:
    """A text literal: a string without NUL, backslash or control characters other than tab and newline, at most 4096 characters; the
    only escaping needed (and the only escaping applied) is the doubling of the single quote, which is exact because no backslash
    can occur. The caller's template adds any cast, so out-of-grammar values can still be sent to the database on purpose."""
    if type(value) is not str or len(value) > 4096:
        raise PayloadRefused("a text literal must be a string of at most 4096 characters")
    for ch in value:
        if ch == "\\" or ord(ch) == 0 or (ord(ch) < 32 and ch not in "\n\t") or ord(ch) == 127:
            raise PayloadRefused(f"a text literal contains a forbidden character: {ch!r}")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise PayloadRefused("a text literal is not valid UTF-8") from exc
    return "'" + value.replace("'", "''") + "'"


def sql_numeric(value) -> str:
    """A money literal in the fixed grammar NNN.NN (up to eleven digits and exactly two decimals)."""
    if type(value) is not str or NUMERIC_RE.fullmatch(value) is None:
        raise PayloadRefused(f"not a numeric literal of the form NN.NN: {value!r}")
    return value


def _sql_enum(kind: str):
    def encode(value) -> str:
        if type(value) is not str or value not in ENUMS[kind]:
            raise PayloadRefused(f"{value!r} is not one of {ENUMS[kind]}")
        return value if kind == "fn" else "'" + value + "'"      # a function name is an identifier; the others are quoted literals
    return encode


_ENCODERS = {"uuid": sql_uuid, "int": sql_int, "text": sql_text, "numeric": sql_numeric,
             "fn": _sql_enum("fn"), "role": _sql_enum("role"), "account": _sql_enum("account"), "dir": _sql_enum("dir")}


def render_sql(template: str, **values) -> str:
    """Fill `{{name:type}}` markers with literals validated by TYPE (uuid, int, text). Every marker needs a value of exactly its declared type, an
    unused value or an unknown marker is refused, and the rendered payload is validated as a whole by the caller before any launch."""
    if type(template) is not str:
        raise PayloadRefused("the template must be a string")
    seen = {}
    for name, kind in MARKER_RE.findall(template):
        if seen.setdefault(name, kind) != kind:
            raise PayloadRefused(f"marker {name} is used with two types")
    if set(seen) != set(values):
        raise PayloadRefused(f"template markers {sorted(seen)} do not match the supplied values {sorted(values)}")
    if "{{" in MARKER_RE.sub("", template) or "}}" in MARKER_RE.sub("", template):
        raise PayloadRefused("an unrecognised marker remains in the template")
    return MARKER_RE.sub(lambda m: _ENCODERS[m.group(2)](values[m.group(1)]), template)



# ======================================================================================================================================
# THE CLOSED SQL OPERATION REGISTRY (A9 V02, R3; enforced at the launch boundary by A10 R1). The security boundary for SQL is NOT a lexer or a statement splitter: enabled execution
# submits only these reviewed templates, with strictly typed slots. launch_runner accepts a psql payload ONLY as a RegisteredCall (operation name and typed
# parameters) and RE-DERIVES the SQL text itself from this registry; no caller-supplied SQL text reaches the runner (Db.run/admin/scalar raise UnregisteredSql).
# A template's structure is fixed by this source; the number of statements is pinned per operation and re-checked after rendering.
# ======================================================================================================================================
class UnknownOperation(PayloadRefused):
    """The operation name is not in the registry (fail closed)."""

@dataclass(frozen=True)
class Operation:
    name: str
    role: str
    template: str
    statements: int          # 1 for a single statement; N for a whole explicit BEGIN ... COMMIT block
    fields: int | None       # '|'-separated fields expected on every stdout line when the exit status is 0 (None: no rows)
    mutates: str             # what a successful run changes ("none" for a read)
    options_ok: bool = False  # may the caller pass one of the closed PGOPTIONS isolation values


_PROJECT_SLOT = "{{project:text}}"
_LEG_COLS = ("insert into drawbridge_auth.journal_leg (txn_id, leg_no, account_id, account_name, project_id, allocation_id, obligation_ref, "
             "exposure_ref, currency, kind, posting_identity, identity_generation, reverses_ref, direction, amount) ")


def _leg(n: int) -> str:
    return (_LEG_COLS + "select {{txn:uuid}}, " + str(n) + ", account_id, account_name, project_id, allocation_id, '∅', '∅', 'USD', 'FUNDING', {{pid:text}}, 1, '∅', "
            "{{d" + str(n) + ":dir}}, {{m" + str(n) + ":numeric}} from drawbridge_auth.journal_account where allocation_id = {{a:uuid}} and account_name = {{n" + str(n) + ":account}};\n")


_TXN_HEADER = ("begin;\ninsert into drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind, total_amount, "
               "posting_identity, identity_generation, reverses_ref, reversed_kind_ref, idempotency_key, authorization_ref) values "
               "({{txn:uuid}}, {{project:text}}, {{a:uuid}}, '∅', '∅', 'USD', 'FUNDING', 5.00, {{pid:text}}, 1, '∅', '∅', {{key:text}}, {{auth:text}});\n")

_OPS = (
    Operation("seed_project", "g2_scratch_admin", "insert into drawbridge_auth.project(project_id, project_label) values (" + _PROJECT_SLOT + ", 'G2C1 synthetic project') on conflict do nothing;",
              1, None, "one project row, once (on conflict do nothing); committed"),
    Operation("seed_allocation", "g2_scratch_admin", "insert into drawbridge_auth.allocation(allocation_id, project_id, currency, basis) values ({{a:uuid}}, " + _PROJECT_SLOT + ", 'USD', 'PRE_DEBIT');",
              1, None, "one allocation row; committed"),
    Operation("post_call", "authority_svc", "select event_id, txn_id, version, replayed from drawbridge_auth.{{fn:fn}}({{alloc:uuid}}::uuid, {{ver:int}}::bigint, {{amt:text}}::numeric, {{auth:text}}, {{key:text}});",
              1, 4, "on success one event, one header, two legs (and the three accounts on the first posting); committed; a refusal writes nothing", True),
    Operation("probe_amount", "authority_svc", "select * from drawbridge_auth.post_funding({{alloc:uuid}}::uuid, 1, nullif({{amt:text}}, '')::numeric, {{auth:text}}, {{key:text}});",
              1, None, "none expected: an out-of-grammar amount must be refused by the function", True),
    Operation("probe_reference", "authority_svc", "select * from drawbridge_auth.post_funding({{alloc:uuid}}::uuid, 1, 1.00, {{auth:text}}, {{key:text}});",
              1, None, "none expected: an out-of-grammar reference must be refused by the function", True),
    Operation("probe_reader_post", "drawbridge_reader", "select * from drawbridge_auth.post_funding({{alloc:uuid}}::uuid, 1, 1.00, {{auth:text}}, {{key:text}});",
              1, None, "none expected: the reader holds no EXECUTE and must be refused (42501)"),
    Operation("alloc_counts", "g2_scratch_admin", "select (select count(*) from drawbridge_auth.allocation_event where allocation_id={{a:uuid}})||','||"
              "(select count(*) from drawbridge_auth.journal_txn where allocation_id={{a:uuid}})||','||(select count(*) from drawbridge_auth.journal_leg where allocation_id={{a:uuid}});", 1, 1, "none"),
    Operation("alloc_legs", "g2_scratch_admin", "select string_agg(account_name||':'||direction||':'||amount, ',' order by leg_no) from drawbridge_auth.journal_leg where allocation_id={{a:uuid}};", 1, 1, "none"),
    Operation("alloc_balances", "drawbridge_reader", "select string_agg(account_name||'='||balance_cents, ',' order by account_name) from drawbridge_read.ledger_account_balance where allocation_id={{a:uuid}};", 1, 1, "none"),
    Operation("alloc_reduction_legs", "g2_scratch_admin", "select string_agg(account_name||':'||direction, ',' order by leg_no) from drawbridge_auth.journal_leg l join drawbridge_auth.journal_txn t using (txn_id) "
              "where t.allocation_id={{a:uuid}} and t.kind='FUNDING_REDUCTION';", 1, 1, "none"),
    Operation("alloc_cash_balance", "drawbridge_reader", "select balance_cents from drawbridge_read.ledger_account_balance where allocation_id={{a:uuid}} and account_name='CASH_ALLOCATED';", 1, 1, "none"),
    Operation("alloc_event_count", "g2_scratch_admin", "select count(*) from drawbridge_auth.allocation_event where allocation_id={{a:uuid}};", 1, 1, "none"),
    Operation("alloc_header_count", "g2_scratch_admin", "select count(*) from drawbridge_auth.journal_txn where allocation_id = {{a:uuid}};", 1, 1, "none"),
    Operation("ledger_totals", "g2_scratch_admin", "select (select count(*) from drawbridge_auth.allocation_event)||','||(select count(*) from drawbridge_auth.journal_leg);", 1, 1, "none"),
    Operation("seed_accounts", "g2_scratch_admin", "insert into drawbridge_auth.journal_account(project_id, allocation_id, currency, account_name, account_type, normal_balance) values "
              "(" + _PROJECT_SLOT + ", {{a:uuid}}, 'USD', 'CASH_ALLOCATED', 'ASSET', 'D'), (" + _PROJECT_SLOT + ", {{a:uuid}}, 'USD', 'PROJECT_CAPITAL', 'CAPITAL', 'C'), "
              "(" + _PROJECT_SLOT + ", {{a:uuid}}, 'USD', 'DISBURSED', 'ASSET', 'D');", 1, None, "three account rows for one allocation; committed (DBT-12 setup)"),
    Operation("contiguity_block", "g2_scratch_admin", "begin;\ninsert into drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind, total_amount, "
              "posting_identity, identity_generation, reverses_ref, reversed_kind_ref, idempotency_key, authorization_ref) values "
              "({{txn:uuid}}, {{project:text}}, {{a:uuid}}, '∅', '∅', 'USD', 'FUNDING', 2.00, {{pid:text}}, 1, '∅', '∅', {{key:text}}, {{auth:text}});\n"
              "insert into drawbridge_auth.allocation_event (event_id, project_id, allocation_id, currency, version, event_kind, amount, authorization_id, idempotency_key, content_digest, txn_id) values "
              "({{ev:uuid}}, {{project:text}}, {{a:uuid}}, 'USD', 3, 'FUNDING', 2.00, {{auth:text}}, {{key:text}}, decode(repeat('00', 32), 'hex'), {{txn:uuid}});\ncommit;",
              4, None, "none expected: the skipped version must be refused and the block rolled back; **if the guard failed, forged rows would commit permanently**"),
    Operation("txn_block_one_leg", "g2_scratch_admin", _TXN_HEADER + _leg(1) + "commit;", 4, None,
              "none expected: refused at commit by the deferred trigger; **if the guard failed, an unbalanced journal would commit permanently**"),
    Operation("txn_block_two_legs", "g2_scratch_admin", _TXN_HEADER + _leg(1) + _leg(2) + "commit;", 5, None,
              "none expected: refused at commit by the deferred trigger; **if the guard failed, an unbalanced journal would commit permanently**"),
    Operation("catalog_lint", "g2_scratch_admin", "select proname, provolatile, prosecdef, coalesce(array_to_string(proconfig, ','), ''), coalesce(array_to_string(proargnames, ','), '') "
              "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'drawbridge_auth' and (proname like 'post_funding%' or proname like 'g2c1_%' or proname like 'trg_%') order by 1;",
              1, 5, "none"),
    Operation("exec_privilege", "g2_scratch_admin", "select has_function_privilege({{role:role}}, 'drawbridge_auth.post_funding(uuid,bigint,numeric,text,text)', 'execute');", 1, 1, "none"),
    Operation("public_exec_count", "g2_scratch_admin", "select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
              "where p.oid = 'drawbridge_auth.post_funding(uuid,bigint,numeric,text,text)'::regprocedure and a.grantee = 0;", 1, 1, "none"),
    Operation("snapshot_read", READER_ROLE, SNAPSHOT_SQL, 3, None, "none"),
)
OPERATIONS = types.MappingProxyType({o.name: o for o in _OPS})
assert len(OPERATIONS) == len(_OPS)


REGISTRY_ENCODING = "g2c1-registry-v2"     # A11 F-02: the version tag of the canonical registry encoding


def operation_record(o) -> dict:
    """The canonical record of ONE registered operation: every security-relevant field, under an explicit name, with a type-stable value. The parameter
    schema is the sorted list of [slot name, slot type] pairs declared by the template's markers."""
    if (type(o.name) is not str or type(o.role) is not str or type(o.template) is not str or type(o.statements) is not int
            or not (o.fields is None or type(o.fields) is int) or type(o.options_ok) is not bool or type(o.mutates) is not str):
        raise PayloadRefused(f"operation {o.name!r} has a field of the wrong type; the registry cannot be encoded")
    return {"name": o.name, "role": o.role, "template": o.template, "statements": o.statements, "fields": o.fields, "options_ok": o.options_ok,
            "parameter_schema": sorted([name, kind] for name, kind in set(MARKER_RE.findall(o.template))), "mutates": o.mutates}


def canonical_registry_bytes(operations) -> bytes:
    """Deterministic, unambiguous encoding: a JSON object {"encoding", "operations"} with the operations sorted by name, every key sorted, no
    insignificant whitespace and ASCII escaping. Field boundaries are JSON structure, never concatenation."""
    records = sorted((operation_record(o) for o in operations), key=lambda r: r["name"])
    return json.dumps({"encoding": REGISTRY_ENCODING, "operations": records}, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def registry_digest(operations=None) -> str:
    """SHA-256 of the canonical registry encoding (of the live registry unless an operation list is given). Recorded in the selection manifest and
    pinned below. Registry completeness only: a modified source with a matching modified digest is NOT owner authorization (that is the separately
    approved source table and a separate exact-hash record)."""
    return hashlib.sha256(canonical_registry_bytes(OPERATIONS.values() if operations is None else operations)).hexdigest()


def render_operation(name, **params):
    """(operation, payload) for a REGISTERED operation. An unknown name, a missing or extra or mistyped parameter, a payload the structural
    validator refuses, or a statement count other than the registered one, is refused before any launch."""
    op = OPERATIONS.get(name) if type(name) is str else None
    if op is None:
        raise UnknownOperation(f"{name!r} is not a registered SQL operation")
    payload = validate_sql_payload(render_sql(op.template, **params))
    if len(_scan(payload)) != op.statements:
        raise PayloadRefused(f"operation {name} rendered a different number of statements than registered ({op.statements})")
    return op, payload


class RegisteredCall:
    """A request to run ONE registered operation with typed parameters: an operation NAME and parameter VALUES, never SQL text. It is
    immutable once built, cannot be copied or pickled, and is never trusted by type: `launch_runner` reads its two fields exactly once and
    RE-DERIVES the statement from the registry (name, template, slot grammar and limits, statement count, role). A forged or edited object can
    therefore only ask for a registered operation with valid parameters. The protection is for the governed harness interfaces; it is not a
    defence against code that already executes with the harness's own privileges."""
    __slots__ = ("_name", "_params")

    def __init__(self, name, params=None):
        params = {} if params is None else params
        if type(name) is not str or type(params) is not dict or any(type(k) is not str or type(v) not in (str, int) for k, v in params.items()):
            raise PayloadRefused("a registered call needs an operation name and a dictionary of str to str or int parameters")
        render_operation(name, **params)                 # refuse an unknown operation or an invalid parameter at construction, too
        object.__setattr__(self, "_name", name)
        object.__setattr__(self, "_params", tuple(sorted(params.items())))

    def __setattr__(self, key, value):
        raise AttributeError("a RegisteredCall is immutable")

    def __delattr__(self, key):
        raise AttributeError("a RegisteredCall is immutable")

    def __reduce__(self):
        raise TypeError("a RegisteredCall cannot be copied or pickled")

    def __repr__(self):
        return f"RegisteredCall({object.__getattribute__(self, '_name')!r})"

    @property
    def name(self) -> str:
        return object.__getattribute__(self, "_name")

    @property
    def params(self) -> tuple:
        return object.__getattribute__(self, "_params")


def derive_registered_payload(call) -> tuple:
    """The launch-boundary derivation: (operation, SQL text) from a RegisteredCall, independent of the caller. Raises before any launch for
    anything else (plain text, a subclass, a half-built object, an unknown operation, an invalid parameter) or for a registry that no longer
    matches the digest pinned in this source."""
    if type(call) is not RegisteredCall:
        raise PayloadRefused("a psql payload must be a RegisteredCall (a registered operation with typed parameters); SQL text is refused before any launch")
    try:
        name, params = object.__getattribute__(call, "_name"), object.__getattribute__(call, "_params")
    except AttributeError as exc:
        raise PayloadRefused("the registered call is incomplete") from exc
    if type(params) is not tuple or any(type(p) is not tuple or len(p) != 2 or type(p[0]) is not str or type(p[1]) not in (str, int) for p in params):
        raise PayloadRefused("the registered call parameters are malformed")
    if registry_digest() != REGISTRY_SHA256:
        raise PayloadRefused("the operation registry does not match the digest pinned in this source")
    return render_operation(name, **dict(params))


REGISTRY_SHA256 = "b945c97f5d2db777d0b7fc693de3ca990ba790c229f41395058ff6d9577092ee"   # the pinned canonical digest (encoding g2c1-registry-v2) of the reviewed registry



class SnapshotError(RuntimeError):
    """The snapshot could not be read, or it does not prove a read-only repeatable-read read."""


def parse_snapshot_output(text: str) -> dict:
    """psql prints command tags and the JSON line; exactly one line must be a JSON object."""
    objects = [line for line in text.splitlines() if line.startswith("{")]
    if len(objects) != 1:
        raise SnapshotError(f"expected exactly one JSON result line, found {len(objects)}")
    try:
        doc = json.loads(objects[0])
    except ValueError as exc:
        raise SnapshotError(f"result is not valid JSON: {exc}") from exc
    if doc.get("txn_read_only") != "on" or doc.get("txn_isolation") != "repeatable read":
        raise SnapshotError("the read did not run in a read-only repeatable-read transaction")
    for key in ("events", "balances", "reconciliation"):
        if type(doc.get(key)) is not list:
            raise SnapshotError(f"result lacks the '{key}' list")
    return doc


SQLSTATE_RE = re.compile(r"^(?:psql:[^\n]*?:\d+:\s+)?ERROR:\s+([0-9A-Z]{5}):\s+(.*)$", re.M)


def fetch_snapshot(db: str, *, run=subprocess.run, runner: Path = RUNNER, evidence_dir=None, label: str = "snapshot") -> dict:
    """Read the snapshot through the approved runner. The SQL is the fixed SNAPSHOT_SQL, submitted through the registered operation `snapshot_read` as ONE `-c`
    argument (an explicit BEGIN ... COMMIT block, so the transaction boundaries are the same as before). Only the acceptance database is
    accepted, and a refusal happens before any launch. The SQLSTATE is read only from the verbose `ERROR:` line, never from the text."""
    try:
        require_acceptance_target(db)
        done = launch_runner(["psql", db, READER_ROLE, "-At", "-v", "VERBOSITY=verbose", "-c", RegisteredCall("snapshot_read")], evidence_dir=evidence_dir,
                             label=label, run=run, runner=runner)
    except LaunchRefused as exc:
        raise SnapshotError(f"refused before any database contact: {exc}") from exc
    if done.rc != 0:
        m = SQLSTATE_RE.search(done.err)
        err = SnapshotError(f"reader failed (exit {done.rc}, SQLSTATE {m.group(1) if m else 'not readable'}): {done.err.strip()[:500]}")
        err.exit_status, err.sqlstate, err.evidence = done.rc, (m.group(1) if m else None), done
        raise err
    return parse_snapshot_output(done.out)
