#!/usr/bin/env python3
"""G2B-R1 fixture-hash preflight (RC-3). Tooling only: it never touches the database and never changes the SQL normalization pin.

usage: fixture_preflight.py <approved-digest-file> <fixture-file>
The approved-digest file must be EXACTLY 64 lowercase hex characters plus one newline (65 bytes): a missing, empty, two-line, uppercase, short, CRLF,
space-padded or newline-less file is refused. The fixture is hashed once; its digest must equal the approved digest.
Prints the (verified) fixture digest on stdout and exits 0; otherwise prints REFUSED on stderr and exits 5. migrate.sh and run_g2a.sh call it with the
fixed repository paths only, as their first action, before any database connection."""
import hashlib
import re
import sys


def refuse(msg):
    sys.stderr.write("REFUSED: %s\n" % msg)
    sys.exit(5)


def main(argv):
    if len(argv) != 3:
        refuse("usage: fixture_preflight.py <approved-digest-file> <fixture-file>")
    approved_path, fixture_path = argv[1], argv[2]
    try:
        raw = open(approved_path, "rb").read()
    except OSError as e:
        refuse("approved corpus digest file unreadable (%s): %s" % (approved_path, e.strerror))
    if not re.fullmatch(rb"[0-9a-f]{64}\n", raw):
        refuse("approved corpus digest file %s is not exactly one line of 64 lowercase hex characters ending in a newline" % approved_path)
    approved = raw[:64].decode("ascii")
    try:
        data = open(fixture_path, "rb").read()
    except OSError as e:
        refuse("corpus fixture unreadable (%s): %s" % (fixture_path, e.strerror))
    actual = hashlib.sha256(data).hexdigest()
    if actual != approved:
        refuse("corpus fixture %s sha256 %s differs from the approved digest %s" % (fixture_path, actual, approved))
    sys.stdout.write(actual + "\n")


main(sys.argv)
