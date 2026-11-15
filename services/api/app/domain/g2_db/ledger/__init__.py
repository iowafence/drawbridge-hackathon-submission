"""SIM-ENG-003-G2C1 funding-ledger tooling: canonical forms, bounded retry, replay, reconciliation, manifest. SIMULATION ONLY.

ERRATUM E-F9 (LOOM-2 V01 finding F-9) for db/migrations/0011_g2c1_funding_ledger.sql, sha256
0b8ddcc61650a3535b4377929250c17f2be2539b63c02075b1ab4cc7452743b6. The comment in the migration header (lines 16-18) says G1S 4.1
constrains the leg mirror columns only through the 4.4 single CHECK. That rationale is inaccurate: G1S 4.1 (line 463) itself names
mirror_of_txn_id, mirror_of_leg_no and direction_swapped as journal_leg columns, and 4.4 RO-9(a) names them again. The omission of
those columns from 0011 stands on the owner's approval (C1-A2 section 5; C1-A1 C-2b: 0011 introduces no G1S 4.4 structure), not on
4.1 being silent. This is a documentary error, not a schema or contract defect: the columns are nullable, constrained only by the
4.4 RO-9 CHECK, and can be added with RO-9 in the exposure slice. The migration bytes are deliberately NOT changed (that would be a new
hash); the erratum travels with this candidate. Pinned by test_migration_bytes_unchanged_and_erratum_recorded.
"""
