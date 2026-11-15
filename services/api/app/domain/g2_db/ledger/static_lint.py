"""Offline STATIC checks for migration 0011 and the G2C1 runner (SIM-ENG-003-G2C1). SIMULATION ONLY.

This is NOT a PostgreSQL parse. It reads the migration as text, scans it with a small tokenizer (comments, quoted strings,
quoted identifiers, dollar quoting) and checks structure and the rules this slice must keep. A PASS here means the text is
well-formed at that level and contains the required objects and no forbidden construct. It does NOT mean PostgreSQL accepts the
file: that is NOT VERIFIED until the migration is applied by an authorized runner after the owner's migration-hash approval.

It never opens a database connection and never executes SQL.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .retry import RETRIABLE_UNIQUE_CONSTRAINTS


class LintError(Exception):
    """The text cannot be tokenized."""


def tokenize(sql: str) -> list:
    """List of (kind, text, depth) where kind in code, comment, string, ident, dollar_open, dollar_close, dollar_body_marker.
    Dollar-quoted bodies are returned as CODE (the plpgsql bodies are code and must balance too); depth is the dollar nesting."""
    out, i, n, stack = [], 0, len(sql), []
    code_start = 0

    def flush(end: int) -> None:
        nonlocal code_start
        if end > code_start:
            out.append(("code", sql[code_start:end], len(stack)))
        code_start = end

    while i < n:
        c = sql[i]
        if sql.startswith("--", i):
            flush(i)
            j = sql.find("\n", i)
            j = n if j < 0 else j
            out.append(("comment", sql[i:j], len(stack))); i = code_start = j
        elif sql.startswith("/*", i):
            flush(i)
            j = sql.find("*/", i + 2)
            if j < 0:
                raise LintError("unterminated block comment")
            out.append(("comment", sql[i:j + 2], len(stack))); i = code_start = j + 2
        elif c == "'":
            flush(i)
            j = i + 1
            while True:
                if j >= n:
                    raise LintError("unterminated string literal")
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2; continue
                    break
                j += 1
            out.append(("string", sql[i:j + 1], len(stack))); i = code_start = j + 1
        elif c == '"':
            flush(i)
            j = sql.find('"', i + 1)
            if j < 0:
                raise LintError("unterminated quoted identifier")
            out.append(("ident", sql[i:j + 1], len(stack))); i = code_start = j + 1
        elif c == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                tag = m.group(0)
                flush(i)
                if stack and stack[-1] == tag:
                    stack.pop(); out.append(("dollar_close", tag, len(stack)))
                else:
                    out.append(("dollar_open", tag, len(stack))); stack.append(tag)
                i = code_start = i + len(tag)
            else:
                i += 1
        else:
            i += 1
    flush(n)
    if stack:
        raise LintError(f"unterminated dollar quote {stack[-1]}")
    return out


def balanced(tokens: list) -> bool:
    """Parentheses balance in code, separately inside every dollar body and at top level."""
    stacks = [[0]]
    for kind, text, _ in tokens:
        if kind == "dollar_open":
            stacks.append([0])
        elif kind == "dollar_close":
            if stacks[-1][0] != 0:
                return False
            stacks.pop()
        elif kind == "code":
            for ch in text:
                if ch == "(":
                    stacks[-1][0] += 1
                elif ch == ")":
                    stacks[-1][0] -= 1
                    if stacks[-1][0] < 0:
                        return False
    return stacks == [[0]]


def top_level_statements(tokens: list) -> list:
    """Statements at dollar depth 0, split on ';', comments dropped, strings/idents/dollar bodies kept as placeholders."""
    statements, current = [], []
    for kind, text, depth in tokens:
        if kind == "comment":
            continue
        if depth > 0 or kind in ("dollar_open", "dollar_close"):
            current.append(" <BODY> " if kind != "dollar_close" and depth > 0 else "")
            continue
        if kind == "string":
            current.append(" <STR> ")
        elif kind == "ident":
            current.append(" <IDENT> ")
        else:
            parts = text.split(";")
            for k, part in enumerate(parts):
                current.append(part)
                if k < len(parts) - 1:
                    statements.append(" ".join("".join(current).split()))
                    current = []
    tail = " ".join("".join(current).split())
    if tail:
        statements.append(tail)
    return [s for s in statements if s]


def code_text(tokens: list, *, bodies: bool = True) -> str:
    return " ".join(text for kind, text, depth in tokens if kind == "code" and (bodies or depth == 0))


FORBIDDEN_ANYWHERE = [
    (r"\bDROP\s+(TABLE|FUNCTION|TRIGGER|SCHEMA|VIEW|TYPE|CONSTRAINT|COLUMN|ROLE|INDEX|DATABASE|EXTENSION)\b", "DROP"),
    (r"\bALTER\s+TABLE\b", "ALTER TABLE (0011 is additive: nothing from 0001..0010 is altered)"),
    (r"\bON\s+CONFLICT\b", "ON CONFLICT (plain INSERT only, C1 D-7)"),
    (r"\bTRUNCATE\s+TABLE\b", "TRUNCATE statement"),
    (r"\bCREATE\s+(ROLE|USER|DATABASE|EXTENSION|SCHEMA)\b", "role, database, extension or schema creation"),
    (r"\b(DISABLE|ENABLE)\s+(ALWAYS\s+|REPLICA\s+)?(TRIGGER|RULE)\b", "trigger toggling"),
    (r"\bsession_replication_role\b", "session_replication_role"),
    (r"\bSET\s+(SESSION\s+)?(ROLE|SESSION\s+AUTHORIZATION)\b", "role switching"),
    (r"\b(double\s+precision|float[48]?|real)\b", "binary floating point type"),
    (r"\b(COPY|dblink|postgres_fdw|lo_import|lo_export|pg_read_file|pg_sleep)\b", "external or file access"),
    (r"\bSECURITY\s+INVOKER\b", "SECURITY INVOKER"),
    (r"\bEXECUTE\s+(?!FUNCTION\b|ON\b|format\s*\()", "dynamic SQL other than the fixed trigger loop"),
    (r"\b(transfer_exposure|funding_authority|payment_event|reservation|settlement|disbursement)\b", "deferred structure (C1 D-1 / C-2b)"),
    (r"\b(UNLOGGED|TEMP|TEMPORARY)\b", "unlogged or temporary table"),
]
ALLOWED_NON_ASCII = {"∅"}


def lint_migration(path) -> dict:
    """Return {ok, findings, inventory, sha256, bytes}. Findings are explicit strings; ok is True when there are none."""
    raw = Path(path).read_bytes()
    text = raw.decode("utf-8")
    findings: list = []
    tokens = tokenize(text)
    if not balanced(tokens):
        findings.append("unbalanced parentheses or dollar bodies")
    bad_chars = sorted({ch for ch in text if ord(ch) > 127 and ch not in ALLOWED_NON_ASCII})
    if bad_chars:
        findings.append(f"unexpected non-ASCII characters: {bad_chars}")
    if "\r" in text or "\t" in text:
        findings.append("carriage return or tab present")
    if re.search(r"[ \t]+\n", text):
        findings.append("trailing whitespace")
    if not text.endswith("\n") or text.endswith("\n\n"):
        findings.append("file must end with exactly one newline")
    code_all = code_text(tokens)
    code_top = code_text(tokens, bodies=False)
    for pattern, label in FORBIDDEN_ANYWHERE:
        if re.search(pattern, code_all, re.IGNORECASE):
            findings.append(f"forbidden construct: {label}")
    # statements at top level must be DDL or the single precondition DO block; no DML, no transaction control
    stmts = top_level_statements(tokens)
    allowed_start = re.compile(r"^(DO|CREATE|REVOKE|GRANT)\b", re.IGNORECASE)
    for s in stmts:
        if not allowed_start.match(s):
            findings.append(f"unexpected top-level statement: {s[:60]}")
    if re.search(r"\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\s*;", code_top, re.IGNORECASE):
        findings.append("top-level transaction control (the runner supplies the single transaction)")

    inv = {
        "types": re.findall(r"CREATE\s+TYPE\s+(drawbridge_auth\.\w+)", code_all),
        "tables": re.findall(r"CREATE\s+TABLE\s+(drawbridge_auth\.\w+)", code_all),
        "views": re.findall(r"CREATE\s+VIEW\s+(drawbridge_read\.\w+)", code_all),
        "indexes": re.findall(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)", code_all),
        "triggers": re.findall(r"CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)", code_all),
        "constraints": re.findall(r"CONSTRAINT\s+(\w+)\s+(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)", code_all),
        "functions": [],
    }
    inv["trigger_loop"] = {"tables": re.findall(r"ARRAY\[([^\]]*)\]", " ".join(t for k, t, d in tokens if k in ("code", "string"))),
                           "per_table_triggers": ["_no_update", "_no_delete", "_no_truncate"]}
    # functions: header analysis
    for m in re.finditer(r"CREATE\s+FUNCTION\s+(drawbridge_auth\.\w+)\s*\(", code_all):
        name = m.group(1)
        header = _function_header(text, name)
        sig = {"name": name, "header": header}
        sig["security_definer"] = bool(re.search(r"\bSECURITY\s+DEFINER\b", header, re.IGNORECASE))
        sig["search_path"] = bool(re.search(r"\bSET\s+search_path\s*=\s*pg_catalog", header, re.IGNORECASE))
        vol = re.search(r"\b(VOLATILE|STABLE|IMMUTABLE)\b", header, re.IGNORECASE)
        sig["volatility"] = vol.group(1).upper() if vol else "VOLATILE (default)"
        inv["functions"].append(sig)
        if not sig["search_path"]:
            findings.append(f"{name}: no fixed search_path")
        if sig["security_definer"] and not sig["search_path"]:
            findings.append(f"{name}: SECURITY DEFINER without a fixed search_path")
    names = {f["name"] for f in inv["functions"]}
    for fn in ("post_funding", "post_funding_reduction"):
        f = next((x for x in inv["functions"] if x["name"] == f"drawbridge_auth.{fn}"), None)
        if f is None:
            findings.append(f"missing function {fn}")
            continue
        if f["volatility"] not in ("VOLATILE", "VOLATILE (default)") or "VOLATILE" not in f["header"].upper() or not f["security_definer"]:
            findings.append(f"{fn}: must be explicitly VOLATILE and SECURITY DEFINER")
    # duplicate names
    for key in ("tables", "indexes", "triggers", "constraints"):
        dup = sorted({x for x in inv[key] if inv[key].count(x) > 1})
        if dup:
            findings.append(f"duplicate {key}: {dup}")
    # the retry allowlist must name real UNIQUE constraints of this file
    for name in RETRIABLE_UNIQUE_CONSTRAINTS:
        if not re.search(rf"CONSTRAINT\s+{name}\s+UNIQUE\b", code_all):
            findings.append(f"retriable constraint {name} is not defined as a UNIQUE constraint")
    # grants: exactly the permitted set
    grants = [s for s in stmts if re.match(r"^GRANT\b", s, re.IGNORECASE)]
    expected_grants = {
        "GRANT SELECT ON drawbridge_read.ledger_event_stream, drawbridge_read.ledger_account_balance, drawbridge_read.ledger_reconciliation TO drawbridge_reader",
        "GRANT EXECUTE ON FUNCTION drawbridge_auth.post_funding(uuid, bigint, numeric, text, text), drawbridge_auth.post_funding_reduction(uuid, bigint, numeric, text, text) TO authority_svc",
    }
    got = {re.sub(r"\s+", " ", g).strip() for g in grants}
    if got != {re.sub(r"\s+", " ", g).strip() for g in expected_grants}:
        findings.append(f"grants differ from the permitted set: {sorted(got)}")
    # no parameter acts as a flag or switch (G1S 9.2 lint, C1-A1 E-3): parameter names of every function
    for m in re.finditer(r"CREATE\s+FUNCTION\s+drawbridge_auth\.\w+\s*\(([^)]*)\)", code_all):
        for param in [p.strip() for p in m.group(1).split(",") if p.strip()]:
            pname = param.split()[0]
            if re.search(r"(authorized|verified|force|override|admin)", pname, re.IGNORECASE):
                findings.append(f"flag-like parameter name: {pname}")
    return {"ok": not findings, "findings": findings, "inventory": inv, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "function_names": sorted(names), "caveat": "static text checks only; NOT a PostgreSQL parse; syntax NOT VERIFIED by the server"}


def _function_header(text: str, name: str) -> str:
    """Text from CREATE FUNCTION <name> up to the dollar-quote that opens its body."""
    start = text.index(f"CREATE FUNCTION {name}")
    m = re.search(r"\bAS\s+\$[A-Za-z_]*\$", text[start:])
    if m is None:
        raise LintError(f"no body found for {name}")
    return text[start:start + m.start()]


FORBIDDEN_SHELL = [
    (r"\bsudo\b", "sudo"), (r"\brm\s+-", "rm with flags"), (r"\brm\s", "rm"), (r"\bmv\b", "mv"), (r"\bcurl\b|\bwget\b", "network fetch"),
    (r"pg18-g2(?!c1)", "path or name of the existing cluster"), (r"build/pg18-g2/", "existing cluster directory"),
    (r"\bdropdb\b|\bdrop\s+database\b", "drop database"), (r"\bpg_resetwal\b|\bpg_upgrade\b", "cluster surgery"),
    (r"\blisten_addresses\s*=\s*'[^']", "network listener"), (r"\bfsync\s*=\s*off\b", "fsync off"),
]


def lint_runner(path) -> dict:
    """Static checks on tools/g2c1_durable_cluster.sh. Syntax is checked separately by `bash -n` (which executes nothing)."""
    text = Path(path).read_text(encoding="utf-8")
    findings: list = []
    for line_no, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for pattern, label in FORBIDDEN_SHELL:
            if re.search(pattern, line):
                findings.append(f"line {line_no}: {label}")
    for required in ('PORT=54438', 'BASE="$ROOT/build/pg18-g2c1"', 'fsync = on', 'synchronous_commit = on', 'full_page_writes = on',
                     '--data-checksums', "listen_addresses = ''", 'unix_socket_permissions = 0700', "set -euo pipefail",
                     '[ "$(id -u)" -ne 0 ]', "guard_paths()", 'realpath -e -- "$p"', "cluster_recorded()", "readonly PORT=54438",
                     "-f -", "env -i"):
        if required not in text:
            findings.append(f"missing required text: {required}")
    code_lines = "\n".join(l for l in text.splitlines() if not l.strip().startswith("#"))
    if code_lines.count("kill -9") != 1:
        findings.append("kill -9 must appear exactly once (crash-kill, own postmaster only)")
    if re.search(r"\b(destroy|retire|rm)\b", re.sub(r"#.*", "", text)):
        findings.append("a destroy/remove command is present")
    if re.search(r"-h\s+[^\"\s$]", text):
        findings.append("psql host argument that is not the socket variable")
    return {"ok": not findings, "findings": findings, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
