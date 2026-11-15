#!/usr/bin/bash -p
# G2C1 dedicated DURABLE scratch PostgreSQL 18 cluster runner and guarded psql (SIM-ENG-003-G2C1). SIMULATION ONLY.
#
# STATUS: SOURCE ONLY. Written and statically checked; NOT EXECUTED by the build that wrote it. No cluster has been created or
# started. No SQL has been run. Migration 0011 has not been applied.
#
# Why a separate runner: the imported g2_psql.sh, migrate.sh and pg_runtime.sh accept only the existing cluster under
# build/pg18-g2 (port 54418, fsync off), which has run since October 28 and must not be touched. They are not modified and not
# invoked. THIS script never builds a path under build/pg18-g2, never uses port 54418, and refuses any target that is not the
# cluster below:
#     data   <repo>/build/pg18-g2c1/data       (mode 0700, own directory, never the data directory of another cluster)
#     socket <repo>/build/pg18-g2c1/sock       (unix socket only; listen_addresses empty; no network listener)
#     port   54438                             (names the socket file only; there is no TCP listener)
#     durability: fsync=on, synchronous_commit=on, full_page_writes=on, data checksums
# build/ is ignored by .gitignore; nothing here is tracked output. Unprivileged only: no root, no sudo, no system change.
# There is deliberately NO destroy command: nothing in this script deletes cluster data (rename-never-delete).
#
# usage: g2c1_durable_cluster.sh <command> [args]
#   INVOCATION CONTRACT: execute this file DIRECTLY (its shebang is /usr/bin/bash -p). `bash g2c1_durable_cluster.sh` is refused. See the
#   TRUSTED EXECUTION CONTRACT below. Exit codes: 3 refused (guards, hashes, targets, trust), 4 ledger hash changed, 5 fixture refused,
#   6 ledger does not hold the verified bytes, 7 already applied, 8 ledger status could not be verified (fail closed).
#   init                            create the cluster directory and configuration (does not start it)
#   start | stop | status           pg_ctl on THIS cluster only (stop is a fast, clean shutdown)
#   crash-stop                      immediate shutdown (no checkpoint): the 'server crash' level of C1 section 5
#   crash-kill                      kill -9 of THIS cluster's postmaster (verified by pid file and working directory)
#   identity                        print the recorded and the live cluster identity
#   bootstrap <db>                  <db> must be the owner-approved database. Verifies the approved static bootstrap source (read once), then submits the
#                                   approved EXPANDED plain-SQL text (roles, database) from memory as g2_scratch_admin; no psql meta-command, nothing generated
#   psql <db> <role> [allowed args] guarded psql; verifies the target before every connection. ONLY these arguments are accepted
#                                   (anything else is refused, never passed on): -At -A -t -1 | -F <sep> | -v <name>=<value> |
#                                   -c <sql> | -f -   (stdin). No host, port, user, database, URI, file or positional argument.
#                                   Input (-c text, -v values, stdin) must not contain a backslash, so it cannot hold a psql
#                                   meta-command such as \connect. The connection options are always the runner's own and come last.
#   migrate-base <db>               apply migrations 0001..0010: each read ONCE, verified against its owner-approved SHA-256 and length BEFORE any SQL,
#                                   exactly that set in exactly that order, the verified bytes submitted, the ledger entry re-read and compared; a second run is refused
#   migrate-0011 <db> <sha256>      apply 0011 ONLY if <sha256> equals the file's SHA-256 (the hash the owner approved in the
#                                   migration-hash addendum) and 0001..0010 are recorded; a second run is refused by the ledger
# STARTUP GATE (LOOM-2 V05 F-1, F-3). These are the first statements of the file, before `set -euo pipefail`, and use only Bash reserved words
# and builtins (no external utility, no function of this file). Bash privileged mode (the shebang's -p) is required; a start without it is refused.
case "$-" in *p*) ;; *) echo "REFUSED: the runner must be executed directly (its shebang is /usr/bin/bash -p); it was started without bash privileged mode" >&2; exit 3 ;; esac
# An inherited BASH_XTRACEFD is REFUSED, never unset: unsetting a value that names a live descriptor (1, 2, ...) closes that descriptor.
case "${BASH_XTRACEFD+set}" in set) echo "REFUSED: BASH_XTRACEFD is set in the environment; the runner will not start with an inherited trace descriptor" >&2; exit 3 ;; esac
set -euo pipefail

# ================================================================================================================================
# TRUSTED EXECUTION CONTRACT (LOOM-2 V04 F-1, V05 F-1/F-2/F-3). What is enforced, and what is ASSUMED. Read the assumptions.
# SUPPORTED INVOCATION, required: execute this file DIRECTLY (./g2c1_durable_cluster.sh <command>), so the kernel honours the shebang
# /usr/bin/bash -p. Bash privileged mode is required. Bash then, before the first line of this file, does not process $BASH_ENV or $ENV,
# does not import exported shell functions, and ignores SHELLOPTS, BASHOPTS, CDPATH and GLOBIGNORE.
# ENFORCED IN THIS FILE (defense in depth; each is tested offline):
#  1. The first statements refuse a start without privileged mode and refuse any inherited BASH_XTRACEFD (never unset it: that closes the descriptor).
#  2. Every utility is called through a function that runs the absolute path /usr/bin/<tool> under `env -i`; nothing is looked up through the
#     caller's PATH. Each tool, its directory, $BASH and the PostgreSQL binaries must exist, be executable and not be writable by the invoking user.
#  3. LD_*, GCONV_PATH, LOCPATH and NLSPATH are refused; other shell-behaviour variables are discarded.
# ASSUMPTIONS, NOT ENFORCED (the runner cannot enforce them from inside itself):
#  a. The interpreter and utility paths are trusted: /usr/bin, /usr/lib/postgresql/18/bin and /usr/bin/bash are root-owned and unmodified,
#     and the kernel honours the shebang.
#  b. The SUPPORTED LAUNCHER excludes hostile inherited environment and loader state. A caller that exports BASH_ENV or other hostile state is
#     outside the supported invocation.
#  c. Code inside this script cannot stop $BASH_ENV from executing before script initialization when the file is invoked incorrectly
#     (`bash script`, `sh script`): bash runs $BASH_ENV, imports exported functions and honours SHELLOPTS before the first line. The startup
#     gate refuses such a start where it can, but a hostile BASH_ENV can run `set -p` and defeat it. The refusal is a convenience, not a boundary.
#  d. Code inside this script cannot stop the dynamic loader from running before line one. A library injected through LD_PRELOAD (or similar)
#     executes inside the interpreter before this file is read; it can erase its own variable, so the LD_* refusal above only catches an
#     unsophisticated attempt. It is not a protection against a hostile launcher.
#  e. A compromised operating system or a host administrator is outside scope. Nothing here protects against either.
# NOT CLAIMED: safety against an arbitrary hostile environment. That stronger guarantee would require a separately reviewed trusted launch boundary.
# ================================================================================================================================
[ -z "$(declare -F)" ] || { echo "REFUSED: shell functions are present at start (they must not be inherited)" >&2; exit 3; }
refuse_start() { echo "REFUSED: $*" >&2; exit 3; }
case "$-" in *p*) ;; *) refuse_start "the runner must be executed directly (its shebang is /usr/bin/bash -p); it was started without bash privileged mode, so \$BASH_ENV, exported functions or SHELLOPTS may already have acted" ;; esac
while IFS= read -r _v; do
  case "$_v" in LD_*|GCONV_PATH|LOCPATH|NLSPATH) refuse_start "the environment variable $_v can change how programs are loaded and is refused" ;; esac
done < <(compgen -e)
unset _v BASH_ENV ENV SHELLOPTS BASHOPTS CDPATH GLOBIGNORE POSIXLY_CORRECT PS4 PROMPT_COMMAND 2>/dev/null || true
PATH=/usr/bin:/bin; export PATH
hash -r
readonly TRUSTED_TOOL_DIR=/usr/bin
_tool() { local t="$1"; shift; "$TRUSTED_TOOL_DIR/env" -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$TRUSTED_TOOL_DIR/$t" "$@"; }
cat() { _tool cat "$@"; }
sha256sum() { _tool sha256sum "$@"; }
cut() { _tool cut "$@"; }
wc() { _tool wc "$@"; }
realpath() { _tool realpath "$@"; }
basename() { _tool basename "$@"; }
dirname() { _tool dirname "$@"; }
id() { _tool id "$@"; }
grep() { _tool grep "$@"; }
head() { _tool head "$@"; }
readlink() { _tool readlink "$@"; }
ls() { _tool ls "$@"; }
mkdir() { _tool mkdir "$@"; }
chmod() { _tool chmod "$@"; }
timeout() { _tool timeout "$@"; }
python3() { _tool python3 "$@"; }
for _t in env cat sha256sum cut wc realpath basename dirname id grep head readlink ls mkdir chmod timeout python3; do
  [ -f "$TRUSTED_TOOL_DIR/$_t" ] && [ -x "$TRUSTED_TOOL_DIR/$_t" ] && [ ! -w "$TRUSTED_TOOL_DIR/$_t" ] \
    || refuse_start "the tool $TRUSTED_TOOL_DIR/$_t is missing, not executable, or writable by the invoking user"
done
[ ! -w "$TRUSTED_TOOL_DIR" ] || refuse_start "the tool directory $TRUSTED_TOOL_DIR is writable by the invoking user"
[ -x "$BASH" ] && [ ! -w "$BASH" ] || refuse_start "the interpreter $BASH is not executable or is writable by the invoking user"
unset _t

# The caller's environment is NOT trusted. PGOPTIONS is captured once (the public psql command validates it against a closed list);
# every other variable that this script reads as a knob is discarded. Nothing from the caller's environment reaches psql: it is
# always started under env -i (see run_psql).
CALLER_PGOPTIONS="${PGOPTIONS-}"
unset PGOPTIONS G2C1_PSQL_LANG G2C1_PSQL_APPNAME G2C1_PSQL_QUIET G2C1_QUERY_TIMEOUT

# Physical (symlink-resolved) paths only: ROOT is derived from the physical location of this script.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF="$HERE/g2c1_durable_cluster.sh"
ROOT="$(cd "$HERE/../../../../../.." && pwd -P)"
BASE="$ROOT/build/pg18-g2c1"
DATA="$BASE/data"; SOCK="$BASE/sock"; LOG="$BASE/postgres.log"; IDENT="$BASE/identity.txt"
readonly PORT=54438
BIN=/usr/lib/postgresql/18/bin
ADMIN=g2_scratch_admin
APPROVED_FILE="0011_g2c1_funding_ledger.sql"
# ---- OWNER-APPROVED HASH TABLE (SIM-ENG-003-G2C1-A4 / A5) BEGIN ---------------------------------------------------------------
# Every SQL artifact the first application may submit is bound HERE to an exact SHA-256 and length. The runner verifies the very bytes
# it then submits (read once into memory; see load_verified). A bytes-versus-digest mismatch refuses BEFORE any SQL. The caller cannot
# supply, override or extend this table (the environment is not trusted). Changing it is a source change and needs a new review.
APPROVED_APPLY_DB="drawbridge_g2_scratch"
APPROVED_BASE=(   # "<file name> <bytes> <sha256>", in the one permitted execution order
  "0001_g2a_schema_foundation.sql 3013 e50c307c8be6c4277f571326456e66c32b30dbbdc0331113d5d1da53aa758a8f"
  "0002_g2a_normalization_v1.sql 4407 4d17e34b480309d1bd7eac525c79f5d332be47d7a8df67e32c925e3e897463bb"
  "0003_g2a_project_allocation_counterparty.sql 3797 a31849651dd7abe9747dba4cc8874034108821e2ede0d37b19b968ad8b5f2416"
  "0004_g2a_rc1_usd_only.sql 607 2b74341439e92092cdaaf7f69c2fce8cf0b85d8d6a9e84826efefa9cd6bdfc95"
  "0005_g2b_evidence_lineage_registries.sql 8917 02b70dec7f423e395333cdeb3272bf88b96410e8943e74e2602c167934a62aa3"
  "0006_g2b_obligation_history_guard.sql 20919 2813d9b4774c3a041fd604e4fba46824bd2a4b96345ecc71687b9826ec15f56e"
  "0007_g2b_protected_functions.sql 23766 c962abaff3cb0e67ece51171ede8665587f5e5866860ff8c3d8da586c0905df1"
  "0008_g2b_r1_trusted_source_document.sql 26791 0d00b43a3296d04380b75244979baef8d560db4c95f44aa12d87222e1d354fca"
  "0009_g2b_r2_u2_referential_integrity.sql 4785 8ac2d1001f9dfef2e3999d1c45a90bba22595589f4d1a198779ffee0ac0616ea"
  "0010_g2b_r2_byte_input_boundary.sql 19298 9cc685a4c8507e43e82e544b97daf0e1efe4a2302ddd68f2ab8575c6d536ae3d"
)
APPROVED_BOOTSTRAP_SRC="services/api/app/domain/g2_db/bootstrap/0000_cluster_bootstrap.sql 2754 9aad0443bce2e51c4b308b2b9f12d6a1274b4131acf69c828b20f34ff844a3ba"
APPROVED_BOOTSTRAP_EXPANDED="2153 28b30b1c5f91bf70888f3de282667fd7d2f8ed244ce561fd543dd78a254d740f"
APPROVED_PREFLIGHT="services/api/app/domain/g2_db/fixture_preflight.py 1829 c0e6ab1ad144fe06fed10ea72b053be15489b3ce798a5782711a287c7575bfc8"
APPROVED_CORPUS_SHA256="868c9e701a811c10fe8ca1ca02f656aea0eed85c74329ae63194684813188a4f"
# ---- OWNER-APPROVED HASH TABLE END ----------------------------------------------------------------------------------------------
CLEAN=("$TRUSTED_TOOL_DIR/env" -i PATH=/usr/bin:/bin LANG=C.UTF-8)
# trust_bin <name>: a PostgreSQL binary is used only if it and its directory are not writable by the invoking user (fail closed).
trust_bin() { [ -f "$BIN/$1" ] && [ -x "$BIN/$1" ] && [ ! -w "$BIN/$1" ] && [ ! -w "$BIN" ] || die "$BIN/$1 is missing, not executable, or writable by the invoking user"; }

die() { echo "REFUSED: $*" >&2; exit 3; }

# ---- path guards -----------------------------------------------------------------------------------------------------
# guard_paths is substantive: it inspects the file system, so a planted symbolic link cannot redirect the cluster. It runs before
# every command (below). Every path that already exists must (a) not be a symbolic link and (b) resolve, physically, to
# $ROOT/build or to $ROOT/build/pg18-g2c1 or a path beneath the latter. The existing cluster (build/pg18-g2) is outside that set,
# so no link, however placed, can make this script act on it.
guard_paths() {
  local p rp
  [ ! -L "${BASH_SOURCE[0]}" ] || die "this script must not be a symbolic link"
  for p in "$ROOT/build" "$BASE" "$DATA" "$SOCK" "$LOG" "$IDENT" "$DATA/postgresql.conf" "$DATA/postmaster.pid"; do
    if [ -L "$p" ]; then die "$p is a symbolic link"; fi
    if [ -e "$p" ]; then
      rp="$(realpath -e -- "$p")" || die "cannot resolve $p"
      case "$rp" in
        "$ROOT/build"|"$ROOT/build/pg18-g2c1"|"$ROOT/build/pg18-g2c1/"*) ;;
        *) die "$p resolves outside build/pg18-g2c1 ($rp)" ;;
      esac
      case "$rp" in
        "$ROOT/build/pg18-g2c1"*) ;;
        "$ROOT/build") [ "$p" = "$ROOT/build" ] || die "$p resolves to the build directory itself" ;;
      esac
    fi
  done
}

# An initialised cluster must be recognisably THIS one before pg_ctl is pointed at it (pg_ctl does not use the socket).
cluster_recorded() {
  [ -e "$DATA/PG_VERSION" ] || die "cluster not initialised"
  grep -qxF "data_directory=$DATA" "$IDENT" 2>/dev/null || die "identity file does not record this data directory"
  grep -qxF "port=$PORT" "$IDENT" 2>/dev/null || die "identity file does not record port $PORT"
  grep -qxF "port = $PORT" "$DATA/postgresql.conf" 2>/dev/null || die "postgresql.conf does not set port $PORT"
  grep -qxF "unix_socket_directories = '$SOCK'" "$DATA/postgresql.conf" 2>/dev/null || die "postgresql.conf does not set the G2C1 socket directory"
  grep -qxF "fsync = on" "$DATA/postgresql.conf" 2>/dev/null || die "postgresql.conf does not set fsync = on"
}

# ---- static guards, evaluated before any command -------------------------------------------------------------------
[ "$(id -u)" -ne 0 ] || die "must not run as root"
guard_paths

# ---- target verification: facts come from THIS socket, which lies under $BASE and so cannot be the existing cluster -----
verify_cluster() {
  [ -S "$SOCK/.s.PGSQL.$PORT" ] || die "G2C1 cluster socket absent (the cluster is not started)"
  local cf vdd vlisten vsd vport vfsync vsync vfpw vcks vnum
  trust_bin psql
  cf="$("${CLEAN[@]}" "$BIN/psql" -X -q -At -F'|' -h "$SOCK" -p "$PORT" -U "$ADMIN" -d postgres -c \
     "select current_setting('data_directory'), current_setting('listen_addresses'), current_setting('unix_socket_directories'), current_setting('port'), current_setting('fsync'), current_setting('synchronous_commit'), current_setting('full_page_writes'), current_setting('data_checksums'), current_setting('server_version_num')")" \
     || die "cannot read cluster facts"
  IFS='|' read -r vdd vlisten vsd vport vfsync vsync vfpw vcks vnum <<<"$cf"
  [ "$vdd" = "$DATA" ] && [ "$vlisten" = "" ] && [ "$vsd" = "$SOCK" ] && [ "$vport" = "$PORT" ] \
    && [ "$vfsync" = "on" ] && [ "$vsync" = "on" ] && [ "$vfpw" = "on" ] && [ "$vcks" = "on" ] && [ "${vnum:0:2}" = "18" ] \
    || die "target verification failed ($cf)"
}

check_db() { [[ "$1" =~ ^(postgres|template1|drawbridge_g2_(dev|test|scratch)[a-z0-9_]*)$ ]] || die "database name '$1' is not a G2 scratch database"; }
check_apply_db() { [ "$1" = "$APPROVED_APPLY_DB" ] || die "database '$1' is not the owner-approved apply target ($APPROVED_APPLY_DB)"; check_db "$1"; }
check_role() { [[ "$1" =~ ^(g2_scratch_admin|drawbridge_migrator|authority_svc|drawbridge_reader)$ ]] || die "role '$1' is not a G2 scratch role"; }

run_psql() { # run_psql <db> <role> [args]  (verified, environment wiped: no credential or DATABASE_URL can reach psql)
  local db="$1" role="$2"; shift 2
  check_db "$db"; check_role "$role"; verify_cluster
  trust_bin psql
  local clean=("$TRUSTED_TOOL_DIR/env" -i PATH=/usr/bin:/bin LANG=C.UTF-8 ${PGOPTIONS:+PGOPTIONS="$PGOPTIONS"})
  local tmo=(); [ -z "${G2C1_QUERY_TIMEOUT:-}" ] || tmo=(timeout "$G2C1_QUERY_TIMEOUT")   # set only by the runner itself, for status queries
  [ -n "${G2C1_PSQL_QUIET:-}" ] || echo "[g2c1] db=$db role=$role socket-only port=$PORT cluster=pg18-g2c1" >&2
  # The runner's own connection options come LAST, so no earlier argument could outvote them; validate_psql_args also guarantees
  # that no caller argument names a host, port, user or database in the first place.
  "${tmo[@]}" "${clean[@]}" "$BIN/psql" -X -q -v ON_ERROR_STOP=1 "$@" -h "$SOCK" -p "$PORT" -U "$role" -d "$db"
}

# ---- the public `psql` command: closed allowlist, no pass-through (LOOM-2 V02 N-1) -----------------------------------
PSQL_ARGS=()
PSQL_READS_STDIN=0
validate_psql_args() {
  PSQL_ARGS=(); PSQL_READS_STDIN=0
  local a v name val used=0
  while [ "$#" -gt 0 ]; do
    a="$1"; shift
    case "$a" in
      -At|-A|-t|-1) PSQL_ARGS+=("$a") ;;
      -F)
        [ "$#" -ge 1 ] || die "-F needs a value"; v="$1"; shift
        [ -n "$v" ] && [ "${#v}" -le 8 ] || die "-F value must be 1 to 8 characters"
        case "$v" in *\\*) die "-F value must not contain a backslash" ;; esac
        [[ "$v" =~ [[:cntrl:]] ]] && die "-F value must not contain a control character"
        PSQL_ARGS+=(-F "$v") ;;
      -v)
        [ "$#" -ge 1 ] || die "-v needs NAME=VALUE"; v="$1"; shift
        [[ "$v" == *=* ]] || die "-v needs NAME=VALUE"
        name="${v%%=*}"; val="${v#*=}"
        if [ "$name" = "VERBOSITY" ]; then
          case "$val" in default|verbose|terse|sqlstate) ;; *) die "-v VERBOSITY value not allowed" ;; esac
        else
          [[ "$name" =~ ^[a-z][a-z0-9_]{0,31}$ ]] || die "-v variable name '$name' is not allowed (lower-case user variables and VERBOSITY only)"
        fi
        case "$val" in *\\*) die "-v value must not contain a backslash" ;; esac
        [ "${#val}" -le 4096 ] || die "-v value too long"
        PSQL_ARGS+=(-v "$name=$val") ;;
      -c)
        [ "$#" -ge 1 ] || die "-c needs a command"; v="$1"; shift
        [ -n "$v" ] || die "-c command is empty"
        case "$v" in *\\*) die "-c text must not contain a backslash (psql meta-commands are not supported here)" ;; esac
        PSQL_ARGS+=(-c "$v"); used=1 ;;
      -f)
        [ "$#" -ge 1 ] && [ "$1" = "-" ] || die "-f accepts only '-' (standard input); a file path is refused"
        shift; PSQL_ARGS+=(-f -); PSQL_READS_STDIN=1; used=1 ;;
      *) die "psql argument '$a' is not allowed (no host, port, user, database, URI, file or positional argument is accepted)" ;;
    esac
  done
  [ "$used" -eq 1 ] || die "give -c <sql> or -f - ; an interactive session is not supported"
}

validate_caller_pgoptions() {
  case "$CALLER_PGOPTIONS" in
    ""|"-c default_transaction_isolation=serializable"|"-c default_transaction_isolation=read\\ committed"|"-c default_transaction_isolation=repeatable\\ read") ;;
    *) die "PGOPTIONS is not on the allowed list (only default_transaction_isolation is accepted)" ;;
  esac
}

guard_stdin() { # pass standard input through line by line; stop at the first line holding a backslash
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in *\\*) echo "REFUSED: input contains a backslash (psql meta-commands such as \\connect are not supported); input stopped" >&2; return 1 ;; esac
    printf '%s\n' "$line"
  done
}

q() { # migrator running as the owner role, one statement stream
  PGOPTIONS="-c role=drawbridge_owner" G2C1_PSQL_QUIET=1 run_psql "$DB" drawbridge_migrator "$@"
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# ---- ledger status (LOOM-2 V04 finding F-2; owner decision, V03 ballot B-5R): every migration-ledger status query FAILS CLOSED. ------
# A status query that fails, times out, prints nothing where a value is required, prints more than one line, or prints anything that is not
# exactly the expected shape stops the run (exit 8) BEFORE any migration is applied. There is no fallback to "not applied" and no retry.
# (The earlier `[ "$(q ...)" = t ]` form swallowed the query's failure: `set -e` does not trip inside a command substitution in a test.)
refuse_ledger() { echo "REFUSED: the migration ledger status could not be verified ($*); nothing further was applied" >&2; exit 8; }
ledger_read() { # ledger_read <bool|count|hash|hash_or_empty> <read-only select>  -> LR_OUT
  local shape="$1" sql="$2" out rc=0 re
  case "$shape" in
    bool) re='^[tf]$' ;;
    count) re='^[0-9]{1,9}$' ;;
    hash) re='^[0-9a-f]{64}$' ;;
    hash_or_empty) re='^([0-9a-f]{64})?$' ;;
    *) refuse_ledger "internal: unknown result shape" ;;
  esac
  out="$(G2C1_QUERY_TIMEOUT=60 G2C1_PSQL_QUIET=1 q -At -c "$sql")" || rc=$?
  [ "$rc" -eq 0 ] || refuse_ledger "the status query failed or timed out, exit status $rc"
  [[ "$out" =~ $re ]] || refuse_ledger "the status query returned an unexpected result"
  LR_OUT="$out"
}

apply_file() { # apply_file <path> [expected_sha256]   (one transaction, then the ledger row; refuses a changed or repeated file)
  # The file is opened and read ONCE into memory. The SHA-256 that is checked, recorded and (when given) compared with the approved
  # value is computed over exactly those bytes, and exactly those bytes are fed to psql on stdin. The file path is never given to
  # psql, so a replacement or edit of the file after this read cannot change what is applied.
  local f="$1" want="${2:-}" n h have content
  [ ! -L "$f" ] || die "$f is a symbolic link"
  [ -f "$f" ] || die "$f is not a regular file"
  case "$(realpath -e -- "$f")" in "$ROOT/db/migrations/"*) ;; *) die "$f is outside db/migrations";; esac
  n="$(basename "$f")"
  content="$(cat -- "$f"; printf x)"; content="${content%x}"
  # An empty migration is never applied and never recorded (LOOM-2 V02 N-3). This check precedes every database call.
  [ -n "$content" ] || die "$n is empty; an empty migration is refused (nothing was submitted or recorded)"
  h="$(printf '%s' "$content" | sha256sum | cut -d' ' -f1)"
  [ "$h" = "$(sha_of "$f")" ] || die "$n changed while it was being read (or contains a NUL byte); nothing was applied"
  [ -z "$want" ] || [ "$h" = "$want" ] || die "the bytes read from $n are not the owner-approved hash; nothing was applied"
  have=""
  ledger_read bool "select to_regclass('drawbridge_auth.schema_migration') is not null"
  if [ "$LR_OUT" = "t" ]; then
    ledger_read hash_or_empty "select file_sha256 from drawbridge_auth.schema_migration where file_name='$n'"
    have="$LR_OUT"
  fi
  if [ -n "$have" ]; then
    [ "$have" = "$h" ] || { echo "REFUSED: $n changed after being applied" >&2; exit 4; }
    echo "skip   $n (already recorded)"; return 0
  fi
  printf '%s' "$content" | q -1 -v corpus_sha256="${CORPUS_SHA:-}" -f - \
     -c "insert into drawbridge_auth.schema_migration(file_name,file_sha256) values ('$n','$h')"
  ledger_read hash "select file_sha256 from drawbridge_auth.schema_migration where file_name='$n'"
  [ "$LR_OUT" = "$h" ] || { echo "REFUSED: the ledger records '$LR_OUT' for $n, not the verified bytes' SHA-256 $h" >&2; exit 6; }
  echo "applied $n  sha256=$h"
}

# load_verified <path> <expected_sha256> <expected_bytes>
# Reads the file ONCE into LV_CONTENT, computes the SHA-256 of exactly those bytes (LV_HASH) and refuses, before any SQL and before any
# database contact, unless they equal the owner-approved digest and length. The caller then submits LV_CONTENT itself, never the path, so
# the bytes that were verified are the bytes that are submitted. A second read must hash equal (detects a change between the reads and
# a NUL byte, which a shell variable cannot hold).
load_verified() {
  local f="$1" want="$2" size="$3" again
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "no owner-approved SHA-256 for $(basename "$f"); nothing was read for execution"
  [[ "$size" =~ ^[0-9]+$ ]] || die "no owner-approved length for $(basename "$f")"
  [ ! -L "$f" ] || die "$f is a symbolic link"
  [ -f "$f" ] || die "$f is not a regular file"
  case "$(realpath -e -- "$f")" in "$ROOT"/*) ;; *) die "$f is outside the execution root";; esac
  LV_CONTENT="$(cat -- "$f"; printf x)"; LV_CONTENT="${LV_CONTENT%x}"
  [ -n "$LV_CONTENT" ] || die "$(basename "$f") is empty; an empty artifact is refused (nothing was submitted)"
  LV_HASH="$(printf '%s' "$LV_CONTENT" | sha256sum | cut -d' ' -f1)"
  again="$(sha_of "$f")"
  [ "$LV_HASH" = "$again" ] || die "$(basename "$f") changed while it was being read (or contains a NUL byte); nothing was applied"
  [ "$LV_HASH" = "$want" ] || die "the bytes read from $(basename "$f") are not the owner-approved SHA-256; nothing was applied"
  [ "$(printf '%s' "$LV_CONTENT" | wc -c)" = "$size" ] || die "$(basename "$f") is not the owner-approved length; nothing was applied"
}

# The complete executable bootstrap SQL for the one approved database, as plain SQL (no psql meta-command, no generated statement).
# It is the expansion of the approved static bootstrap file; its exact bytes are bound by APPROVED_BOOTSTRAP_EXPANDED.
bootstrap_expanded_sql() {
  cat <<'G2C1_BOOTSTRAP_SQL'
-- G2C1 cluster bootstrap, EXPANDED for the one approved database drawbridge_g2_scratch (SIM-ENG-003-G2C1, SIMULATION ONLY).
-- Plain SQL only: no psql meta-command, no generated statement, no variable. It is the complete expansion of
-- services/api/app/domain/g2_db/bootstrap/0000_cluster_bootstrap.sql (SHA-256 9aad0443bce2e51c4b308b2b9f12d6a1274b4131acf69c828b20f34ff844a3ba) for db = drawbridge_g2_scratch.
-- Deliberate difference: CREATE DATABASE is unconditional, so an existing database makes the run fail closed instead of being reused.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drawbridge_owner') THEN
    CREATE ROLE drawbridge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- migrator: operator-controlled DDL role. Member of the owner (SET only) so DDL runs as the owner. Not a service role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drawbridge_migrator') THEN
    CREATE ROLE drawbridge_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authority_svc') THEN
    CREATE ROLE authority_svc LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drawbridge_reader') THEN
    CREATE ROLE drawbridge_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT drawbridge_owner TO drawbridge_migrator WITH INHERIT FALSE, SET TRUE;
CREATE DATABASE drawbridge_g2_scratch TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' OWNER drawbridge_owner;
REVOKE ALL ON DATABASE drawbridge_g2_scratch FROM PUBLIC;
GRANT CONNECT ON DATABASE drawbridge_g2_scratch TO drawbridge_migrator, authority_svc, drawbridge_reader;
GRANT CREATE ON DATABASE drawbridge_g2_scratch TO drawbridge_owner;
ALTER DATABASE drawbridge_g2_scratch SET client_encoding = 'UTF8';
ALTER ROLE drawbridge_migrator SET client_encoding = 'UTF8';
ALTER ROLE authority_svc SET client_encoding = 'UTF8';
ALTER ROLE drawbridge_reader SET client_encoding = 'UTF8';
G2C1_BOOTSTRAP_SQL
}

case "${1:-}" in
  init)
    [ ! -e "$DATA/PG_VERSION" ] || { echo "already initialised: $DATA"; exit 0; }
    if [ -e "$BASE" ] && [ -n "$(ls -A "$BASE" 2>/dev/null)" ]; then die "$BASE exists and is not empty; nothing is overwritten"; fi
    mkdir -p "$BASE" "$SOCK"; chmod 700 "$BASE" "$SOCK"
    trust_bin initdb
    "${CLEAN[@]}" "$BIN/initdb" -D "$DATA" -U "$ADMIN" --auth-local=trust --auth-host=reject \
        -E UTF8 --locale-provider=builtin --locale=C.UTF-8 --data-checksums >/dev/null
    cat >> "$DATA/postgresql.conf" <<CONF
listen_addresses = ''
port = $PORT
unix_socket_directories = '$SOCK'
unix_socket_permissions = 0700
fsync = on
synchronous_commit = on
full_page_writes = on
log_lock_waits = on
deadlock_timeout = 1s
log_statement = 'none'
CONF
    set -o noclobber
    {
      echo "cluster=pg18-g2c1"
      echo "data_directory=$DATA"
      echo "socket_directory=$SOCK"
      echo "port=$PORT"
      echo "listen_addresses=(empty; unix socket only)"
      echo "durability=fsync=on synchronous_commit=on full_page_writes=on data_checksums=on"
      echo "directory_mode=0700"
      echo "created_by_user=$(id -un) uid=$(id -u)"
      echo "scratch_admin_role=$ADMIN (this cluster only)"
      echo "credentials=none (local trust, unix socket)"
      echo "data=synthetic only"
    } > "$IDENT"
    echo "initialised $DATA (not started)" ;;
  start)
    cluster_recorded
    trust_bin pg_ctl
    "${CLEAN[@]}" "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w start >/dev/null && echo started ;;
  stop)
    cluster_recorded
    trust_bin pg_ctl
    "${CLEAN[@]}" "$BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null && echo stopped ;;
  crash-stop)
    cluster_recorded
    trust_bin pg_ctl
    "${CLEAN[@]}" "$BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null && echo "stopped (immediate)" ;;
  crash-kill)
    cluster_recorded
    [ -r "$DATA/postmaster.pid" ] || die "no postmaster.pid for this cluster"
    pid="$(head -n 1 "$DATA/postmaster.pid")"
    [[ "$pid" =~ ^[0-9]+$ ]] || die "malformed pid file"
    [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$DATA" ] || die "pid $pid is not the postmaster of $DATA"
    kill -9 "$pid" && echo "killed postmaster $pid of $DATA" ;;
  status)
    cluster_recorded
    trust_bin pg_ctl
    "${CLEAN[@]}" "$BIN/pg_ctl" -D "$DATA" status | head -1 ;;
  identity)
    [ -r "$IDENT" ] && cat "$IDENT"
    if [ -S "$SOCK/.s.PGSQL.$PORT" ]; then verify_cluster && echo "live=verified"; else echo "live=not running"; fi ;;
  bootstrap)
    # Hash-to-apply (owner decision, V02 ballot B-2/B-4): the approved static source is read once and verified; the SQL that is submitted is
    # the approved EXPANDED text (no meta-command, nothing generated at run time), verified by its own digest, and submitted from memory.
    DB="${2:?db}"; check_apply_db "$DB"
    read -r BS_REL BS_LEN BS_SHA <<<"$APPROVED_BOOTSTRAP_SRC"
    load_verified "$ROOT/$BS_REL" "$BS_SHA" "$BS_LEN"
    read -r EX_LEN EX_SHA <<<"$APPROVED_BOOTSTRAP_EXPANDED"
    EXP="$(bootstrap_expanded_sql; printf x)"; EXP="${EXP%x}"
    [ "$(printf '%s' "$EXP" | sha256sum | cut -d' ' -f1)" = "$EX_SHA" ] || die "the expanded bootstrap SQL is not the owner-approved text; nothing was submitted"
    [ "$(printf '%s' "$EXP" | wc -c)" = "$EX_LEN" ] || die "the expanded bootstrap SQL is not the owner-approved length; nothing was submitted"
    case "$EXP" in *\\*) die "the expanded bootstrap SQL contains a backslash (a psql meta-command); nothing was submitted" ;; esac
    echo "[g2c1] bootstrap source sha256=$LV_HASH expanded sha256=$EX_SHA db=$DB" >&2
    printf '%s' "$EXP" | G2C1_PSQL_QUIET=1 run_psql postgres "$ADMIN" -f - ;;
  psql)
    [ "$#" -ge 3 ] || die "usage: psql <db> <role> [psql args]"
    DB="$2"; ROLE="$3"; shift 3
    check_db "$DB"; check_role "$ROLE"
    validate_psql_args "$@"; validate_caller_pgoptions
    if [ "$PSQL_READS_STDIN" -eq 1 ]; then
      guard_stdin | PGOPTIONS="$CALLER_PGOPTIONS" run_psql "$DB" "$ROLE" "${PSQL_ARGS[@]}"
    else
      PGOPTIONS="$CALLER_PGOPTIONS" run_psql "$DB" "$ROLE" "${PSQL_ARGS[@]}" </dev/null
    fi ;;
  migrate-base)
    # Every base migration is read once and verified against its owner-approved digest and length BEFORE any SQL or database contact;
    # the verified bytes are what is submitted. The set and the order are exactly APPROVED_BASE. A second run is refused.
    DB="${2:?db}"; check_apply_db "$DB"
    BASE_NAMES=(); BASE_CONTENT=(); BASE_HASH=()
    ACTUAL=()
    for f in "$ROOT"/db/migrations/*.sql; do
      n="$(basename "$f")"
      [[ "$n" =~ ^[0-9]{4}_ ]] || die "unexpected migration file name '$n'"
      [ "$((10#${n%%_*}))" -le 10 ] || continue
      ACTUAL+=("$n")
    done
    WANT_NAMES=(); for row in "${APPROVED_BASE[@]}"; do read -r n _ _ <<<"$row"; WANT_NAMES+=("$n"); done
    [ "${ACTUAL[*]}" = "${WANT_NAMES[*]}" ] || die "the base migration files are not exactly the owner-approved set in the approved order; nothing was applied"
    for row in "${APPROVED_BASE[@]}"; do
      read -r n size want <<<"$row"
      load_verified "$ROOT/db/migrations/$n" "$want" "$size"
      BASE_NAMES+=("$n"); BASE_CONTENT+=("$LV_CONTENT"); BASE_HASH+=("$LV_HASH")
    done
    HERE_G2="$ROOT/services/api/app/domain/g2_db"
    read -r PF_REL PF_LEN PF_SHA <<<"$APPROVED_PREFLIGHT"
    load_verified "$ROOT/$PF_REL" "$PF_SHA" "$PF_LEN"
    CORPUS_SHA="$(python3 -I -c "$LV_CONTENT" "$ROOT/contracts/normalization_corpus_v1.sha256" "$ROOT/fixtures/normalization_corpus_v1.json")" || exit 5
    [ "$CORPUS_SHA" = "$APPROVED_CORPUS_SHA256" ] || die "the fixture corpus digest is not the owner-approved digest; nothing was applied"
    # ---- from here on the database is contacted; everything that will be submitted has already been verified ----
    G2C1_PSQL_QUIET= run_psql "$DB" drawbridge_migrator -At -c "select 1" >/dev/null
    ledger_read bool "select to_regclass('drawbridge_auth.schema_migration') is not null"
    if [ "$LR_OUT" = "t" ]; then
      ledger_read count "select count(*) from drawbridge_auth.schema_migration"
      [ "$LR_OUT" = "0" ] || { echo "REFUSED: the migration ledger is not empty (a second run of migrate-base is refused)" >&2; exit 7; }
    fi
    for i in "${!BASE_NAMES[@]}"; do
      n="${BASE_NAMES[$i]}"; h="${BASE_HASH[$i]}"
      printf '%s' "${BASE_CONTENT[$i]}" | q -1 -v corpus_sha256="$CORPUS_SHA" -f - \
         -c "insert into drawbridge_auth.schema_migration(file_name,file_sha256) values ('$n','$h')"
      ledger_read hash "select file_sha256 from drawbridge_auth.schema_migration where file_name='$n'"
      [ "$LR_OUT" = "$h" ] || { echo "REFUSED: the ledger records '$LR_OUT' for $n, not the verified bytes' SHA-256 $h" >&2; exit 6; }
      echo "applied $n  sha256=$h"
    done
    ledger_read hash "select corpus_sha256 from drawbridge_auth.normalization_pin where normalization_version='v1'"
    PIN="$LR_OUT"
    [ "$PIN" = "$CORPUS_SHA" ] || { echo "REFUSED: fixture sha256 $CORPUS_SHA differs from pinned $PIN" >&2; exit 5; }
    echo "fixture hash matches pin: $CORPUS_SHA" ;;
  migrate-0011)
    DB="${2:?db}"; APPROVED="${3:?approved sha256 of $APPROVED_FILE}"; check_apply_db "$DB"
    [[ "$APPROVED" =~ ^[0-9a-f]{64}$ ]] || die "approved hash is not 64 lower-case hex characters"
    F="$ROOT/db/migrations/$APPROVED_FILE"
    [ ! -L "$F" ] || die "$APPROVED_FILE is a symbolic link"
    [ ! -L "$ROOT/db/migrations" ] && [ ! -L "$ROOT/db" ] || die "db/migrations is a symbolic link"
    [ -f "$F" ] || die "$APPROVED_FILE is absent"
    [ "$(sha_of "$F")" = "$APPROVED" ] || die "the file's SHA-256 is not the owner-approved hash; nothing was applied"
    for row in "${APPROVED_BASE[@]}"; do   # the ledger must hold each base migration with its OWNER-APPROVED digest (not merely the file on disk)
      read -r n _ want <<<"$row"
      ledger_read hash_or_empty "select file_sha256 from drawbridge_auth.schema_migration where file_name='$n'"
      [ "$LR_OUT" = "$want" ] || die "$n is not recorded with its owner-approved SHA-256; apply migrate-base first"
    done
    ledger_read hash_or_empty "select file_sha256 from drawbridge_auth.schema_migration where file_name='$APPROVED_FILE'"
    if [ -n "$LR_OUT" ]; then
      echo "REFUSED: $APPROVED_FILE is already recorded in the migration ledger (a second run is refused)" >&2; exit 7
    fi
    apply_file "$F" "$APPROVED" ;;   # re-checks the approved hash over the very bytes that are applied
  *)
    echo "usage: $0 init|start|stop|crash-stop|crash-kill|status|identity|bootstrap|psql|migrate-base|migrate-0011" >&2; exit 2 ;;
esac
