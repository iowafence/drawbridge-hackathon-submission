# DRAWBRIDGE evidence summary (sanitized)

This is a sanitized summary of the internal evidence behind this submission. The sealed evidence directories, raw
per-launch database output, cluster logs, agent session records and internal governance documents are **not**
published. They contain host paths and operational detail. No raw banking response is included anywhere in this
repository.

"Independent" in this document means a **fresh-context review agent on the same account and model family as the
builder**. It is not a third-party audit.

## 1. Source provenance

Every component source file in this repository is byte-identical to the internal source listed here. This was
checked file by file against the Git blob, or against the release manifest for the provider. The internal Git history
was not imported.

| Component | Internal source | Commit | Tree |
|---|---|---|---|
| UI (`apps/web/`, 53 files) | branch `ui/erp-redesign` | `f2dcc7a4963807604a5b53c064dafff4300ca04b` | `679b9e7ab90cc79a704ebb9b4adacc0a94efd591` |
| Funding ledger (28 files) | accepted A12 source baseline | `8b5d9e8d23966172719e49816ed7211962352c76` | `138931f7c6d9fa9e1ef500e0aa8d81f3b14fda66` |
| Airwallex provider (6 source files + `.env.example`) | `main` | `f88af200a3e76b31c1f6129bfeae04e2ca64a24a` | n/a |

The provider directory also contains three files written for publication: `NOTICE`, `REVIEWER_GUIDE.md` and the
sanitized smoke evidence. Their hashes are pinned in the root manifest.

## 2. Funding ledger: Gate C database run (13 selected cases)

One run, 2026-11-14, in an isolated PostgreSQL 18.6 scratch cluster. Unix socket only, no TCP listener, synthetic data.
The source was the A12 baseline above (tree `138931f7…14fda66`). 13 single-case invocations, 137 runner launches in total.

| # | Case | Result |
|---|---|---|
| I-01 | DBT-02 funding posts one balanced event | PASS |
| I-02 | DBT-03 funding then reduction | PASS |
| I-03 | DBT-04 reduction beyond cash refused (`DW422 AUTHORITY_REDUCTION_BLOCKED`) | PASS |
| I-04 | DBT-05 idempotent replay returns the same event | PASS |
| I-05 | DBT-06 idempotency conflict / duplicate authorization refused | PASS |
| I-06 | DBT-07 stale version / invalid reference / unknown allocation refused | PASS |
| I-07 | DBT-08 invalid amounts refused; maximum accepted; overflow refused | PASS |
| I-08 | DBT-11 non-contiguous version blocked by trigger | PASS (guard held) |
| I-09 | DBT-12 incomplete / unbalanced / wrong-pattern journals blocked | PASS (guard held) |
| I-10 | DBT-14 catalog lint, execute grants, reader denied, label limits | PASS |
| I-11 | DBT-18 totals stable; snapshots byte-identical | PASS |
| I-12 | DBT-19 reconciliation PASS; 0 violations on recomputation | PASS |
| I-13 | DBT-20 manifest export verifies; corruption detected | PASS (limited, see GC-F4) |

**13/13 selected cases PASS.**

**14 held cases NOT RUN:** DBT-01, 09, 10, 13, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27.

Planned and observed writes matched: 21 allocation events, 21 journal headers, 42 legs, 51 accounts. All allocations
were contiguous, debits equalled credits on every transaction, and no forged or unbalanced row committed. The scratch
database is mutated test evidence; it is stopped and preserved, not published.

## 3. Gate C independent review (V14)

**Verdict: PASS WITH FINDINGS. 0 Critical, 0 High, 0 Medium, 4 Low, 7 Info. No material blocker.**

| ID | Severity | Finding (summary) |
|---|---|---|
| GC-F1 | Low | In two segments the next invocation started automatically 22–28 ms after the script's verdict. The procedure required a recorded operator decision first. No effect on any outcome |
| GC-F2 | Low | The continuation checker was written after the first invocation, so it was not pre-registered. The reviewer re-derived all 13 launch counts independently, and they match |
| GC-F3 | Low | The checker does not record per-launch exit status, has no reference for per-launch digests, and lists SQLSTATEs without judging them |
| GC-F4 | Low | Some planned expectations are not asserted by the case bodies. The reviewer verified most of them from raw evidence. Two remain unevidenced: DBT-12 deferral timing, and the DBT-20 "fails with a position" claim |
| GC-F5 | Info | Some read-only launch command lines were recorded without exact argument boundaries |
| GC-F6 | Info | "No untrusted concurrent writer" is an operator assertion, not an observation |
| GC-F7 | Info | A preflight record outside the Gate C evidence has no sidecar, a truncated line and a stale label |
| GC-F8 | Info | One wrapper record (I-01) is missing; this was not disclosed by the operator |
| GC-F9 | Info | The allocation row count (21) is inferred from launch outcomes; it was not read directly |
| GC-F10 | Info | Absence of `/proc` reads during Gate C is shown only by the scripts and the operator's statement |
| GC-F11 | Info | SQL text is logged for failed statements only; the 85 successful launches are reconstructed from the registry |

Also carried from earlier reviews:
- **F-B (open):** checking the runner by path and then executing it is not atomic.
- **N-9 (open):** streamed and parallel paths are untested.
- **F-1 / DBT-25 (open):** concurrency is untested.

**What the PASS establishes:** the synthetic behaviour of these 13 cases, once, in one isolated scratch environment.
**What it does not establish:** concurrency, streamed or parallel paths, durability or crash/restart, injection
resistance, the 14 held cases, atomic runner identity, or anything about production or real money.

The sealed Gate C evidence index (`SHA256SUMS.txt`, 496 entries) has SHA-256
`042631d9203173276cba992d345ace1ad0d17bc71c0174a67d26b24a33dd310d`. It was re-verified (496/496 OK) during
publication preflight. The evidence itself is retained internally and is not published.

## 4. Funding ledger: offline suite

`services/api/app/domain/g2_db/ledger/tests/test_g2c1_offline.py`, run against the staged repository with network
disabled and PostgreSQL hidden:

- **Ran 432 tests, OK (skipped=1)** without Git metadata (the skip is `test_owned_paths_only`).
- **Ran 432 tests, OK** in a Git checkout of this repository.

This matches the count recorded for the A12 baseline. These are builder-side offline checks; they open no database
connection.

## 5. UI

| Check | Result |
|---|---|
| `npm test` in this repository (no internal history) | 106 tests: 104 pass, 0 fail, 2 skipped (UI-B3, UI-B4 need the internal commit) |
| `npm test` on the same files with read access to the internal commit | 106 tests: 106 pass |
| `npm run typecheck` on a clean checkout | exit 0 |
| Dev server from the staged source | `/overview` (Command), `/incident`, `/payables`, `/recorder` all HTTP 200 |
| Responsive and accessibility sweep (internal, 2026-11-14; not re-run for this summary) | 13 routes × 3 widths (1440, 820, 375) = 39 clean; 0 axe violations; 0 enabled release controls |

## 6. Airwallex provider

| Check | Result |
|---|---|
| Offline boundary tests | 30 collected, 29 pass, 0 fail, 1 skipped |
| Sandbox smoke, 2026-11-14 | login HTTP 201; `GET /balances/current` HTTP 200 (46 currency entries). Sanitized record in `providers/airwallex/evidence/` |
| Credential review | No credential, token or key appears in this repository. The credentials used for the internal run were regenerated afterwards |
