#!/usr/bin/env bash
# Clean-checkout, offline reproduction of every web test suite (flow-v1 lane A4).
#
#   scripts/integrated/cleanroom.sh [<commit-ish>]      default: HEAD
#
# What it does:
#   1. exports <commit-ish> with `git archive` into a brand-new private directory (never the working tree, never a
#      shared path), so untracked and ignored files cannot influence the result;
#   2. installs the exact lockfile with `npm ci --offline` (npm cache only; nothing is downloaded);
#   3. runs typecheck and every suite with the network unshared (bubblewrap) and all live-credential variables unset;
#   4. prints one line per suite with the runner's own totals, and writes full logs next to the export.
# It makes no provider call, opens no project data directory, and deletes nothing. Exit status is non-zero if any
# suite fails or if the network could not be unshared (set A4_ALLOW_NETWORK=1 to run anyway; the in-test network
# guard still applies to the integrated suites, and the summary says the run was not network-isolated).
set -euo pipefail

rev="${1:-HEAD}"
repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${rev}^{commit}")"
tree="$(git -C "$repo" rev-parse "${sha}^{tree}")"
work="$(mktemp -d "${TMPDIR:-/tmp}/db-cleanroom-XXXXXXXX")"
export_dir="$work/export"
logs="$work/logs"
mkdir -p "$export_dir" "$logs" "$work/tmp" "$work/home"

git -C "$repo" archive --format=tar "$sha" | tar -x -C "$export_dir"
web="$export_dir/apps/web"

if command -v bwrap >/dev/null 2>&1 && bwrap --dev-bind / / --unshare-net -- true 2>/dev/null; then
  isolate=(bwrap --dev-bind / / --unshare-net --)
  network="unshared (bubblewrap)"
elif [ "${A4_ALLOW_NETWORK:-0}" = "1" ]; then
  isolate=()
  network="NOT ISOLATED (A4_ALLOW_NETWORK=1)"
else
  echo "cleanroom: cannot unshare the network (bubblewrap unavailable). Set A4_ALLOW_NETWORK=1 to run without isolation." >&2
  exit 2
fi

# a minimal environment: no provider, model, operator or data-directory configuration reaches the tests
clean=(env -i "PATH=$PATH" "HOME=$work/home" "TMPDIR=$work/tmp" "npm_config_cache=${npm_config_cache:-$HOME/.npm}" LANG=C.UTF-8)

echo "cleanroom: commit $sha"
echo "cleanroom: tree   $tree"
echo "cleanroom: export $export_dir"
echo "cleanroom: node $(node --version), npm $(npm --version); network $network"

(cd "$web" && "${clean[@]}" npm ci --offline --no-audit --no-fund >"$logs/npm_ci.log" 2>&1) || { echo "cleanroom: npm ci --offline failed (see $logs/npm_ci.log)"; exit 3; }

fail=0
run() {
  local name="$1"; shift
  local rc=0
  (cd "$web" && "${isolate[@]}" "${clean[@]}" "$@" >"$logs/$name.log" 2>&1) || rc=$?
  local totals
  totals="$(grep -E '^# (tests|pass|fail|cancelled|skipped|todo) ' "$logs/$name.log" | sed 's/^# //' | tr '\n' ' ' || true)"
  printf 'cleanroom: %-16s exit %s  %s\n' "$name" "$rc" "${totals:-(no test totals)}"
  grep -E '^ok .*# SKIP' "$logs/$name.log" | sed 's/^/cleanroom:     SKIPPED: /' || true
  [ "$rc" -eq 0 ] || fail=1
}
run typecheck        npm run typecheck
run test             npm test
run test_sandbox     npm run test:sandbox
run test_agent       npm run test:agent
run test_integrated  npm run test:integrated

echo "cleanroom: logs $logs"
if [ "$fail" -ne 0 ]; then echo "cleanroom: RESULT FAIL"; exit 1; fi
echo "cleanroom: RESULT all suites exited 0 (skipped tests listed above are NOT passes)"
