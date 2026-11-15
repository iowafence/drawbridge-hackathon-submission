"""Command line for replay, reconciliation and the manifest (SIM-ENG-003-G2C1). SIMULATION ONLY.

    cli.py replay    --db <name> [--out <new file>]
    cli.py reconcile --db <name>
    cli.py export    --db <name> --out <new manifest file>
    cli.py verify    --manifest <file> [--expected-head ALLOCATION=SHA256 ...] [--expected-count ALLOCATION=N ...]

replay, reconcile and export read the ledger through snapshot.fetch_snapshot (one read-only snapshot, role drawbridge_reader)
and require the dedicated G2C1 cluster, which the source-only pass does not start. verify reads a file only.
Nothing here posts, repairs or authorizes anything. Output files are created exclusively and never overwritten.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ledger import manifest, reconcile, replay, snapshot  # noqa: E402
from ledger.canonical import CanonicalError, sha256_hex  # noqa: E402


def _pairs(values, what: str, *, integer: bool) -> dict:
    out: dict = {}
    for item in values or []:
        key, sep, value = item.partition("=")
        if not sep:
            raise CanonicalError(f"{what}: expected ALLOCATION=VALUE")
        out[key] = int(value) if integer else value
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="g2c1-ledger", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("replay", "reconcile", "export"):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True)
        if name != "reconcile":
            p.add_argument("--out", required=(name == "export"))
    v = sub.add_parser("verify")
    v.add_argument("--manifest", required=True)
    v.add_argument("--expected-head", action="append")
    v.add_argument("--expected-count", action="append")
    args = parser.parse_args(argv)
    try:
        if args.command == "verify":
            data = Path(args.manifest).read_bytes()
            side = Path(args.manifest + ".sha256")
            result = manifest.verify_manifest(
                data, expected_file_sha256=manifest.read_sidecar(args.manifest) if side.exists() else None,
                expected_heads=_pairs(args.expected_head, "--expected-head", integer=False) or None,
                expected_counts=_pairs(args.expected_count, "--expected-count", integer=True) or None)
            print(json.dumps(result, sort_keys=True, indent=2))
            return 0 if result["ok"] else 1
        snap = snapshot.fetch_snapshot(args.db)
        if args.command == "reconcile":
            result = reconcile.reconcile(snap, require_snapshot_proof=True)
            print(json.dumps(result, sort_keys=True, indent=2))
            return 0 if result["outcome"] == "PASS" else 1
        if args.command == "replay":
            doc = replay.replay(snap)
            data = replay.replay_bytes(doc)
            if args.out:
                with Path(args.out).open("xb") as handle:
                    handle.write(data)
            print(f"{sha256_hex(data)}  replay.json  ({len(doc['allocations'])} allocations)")
            return 0
        doc = manifest.build_manifest(snap)
        info = manifest.write_manifest(doc, args.out)
        print(json.dumps({"manifest": args.out, **info, "limitations": list(manifest.LIMITATIONS)}, sort_keys=True, indent=2))
        return 0
    except (CanonicalError, snapshot.SnapshotError, reconcile.ReconcileError, OSError) as exc:
        print(f"REFUSED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
