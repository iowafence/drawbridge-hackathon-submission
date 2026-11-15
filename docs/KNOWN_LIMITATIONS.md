# Known limitations and untested claims

## Whole system

- **Synthetic only, except the sandbox screen.** All Incident Room (E3) data, ledger data and authorizations are
  synthetic. The `/sandbox` screen shows Airwallex sandbox test data. Nothing here is a payment authority,
  an approval, a bank balance or real money.
- **Not integrated.** The E3 scenario screens, the funding ledger and the Airwallex components are separate. The E3
  screens do not read the ledger or call Airwallex. The ledger does not call Airwallex. The `/sandbox` screen calls
  the Airwallex sandbox but shares no data or decision engine with the E3 scenario.
- **Local only.** There is no hosted deployment.
- **Agents.** The "agent findings" shown in the UI are fixture text. No AI model is called at runtime.
- **Reviews are not third-party audits.** "Independent" reviews were fresh-context agents on the same account and
  model family as the builder.
- **Internal references.** Source comments and the original component READMEs cite internal governance documents,
  review IDs and Git history that are not included (for example `G1S`, `C1-A1`, `LOOM-2 V04`, `AWX-P2-…`,
  `docs/phase2/…`).

## UI (`apps/web/`)

- After `next dev` has run once, `npm run typecheck` (and `next build`) can fail with TS2344 in the generated
  `.next/dev/types/app/eligibility/page.ts`. A clean checkout type-checks and builds. Workaround: type-check before
  starting the dev server, or delete `.next/`.
- In this repository `npm test` reports 2 skipped tests (`UI-B3`, `UI-B4`). They compare files with an internal
  commit that is not published. The pinned-hash checks `UI-B1` and `UI-B2` still run.
- The Approvals and Eligibility screens keep their earlier layout; only Command, Incident, Payables and Recorder
  were redesigned.
- `next dev` regenerates an `apps/web/AGENTS.md`; it is ignored and is not part of the source.

## Airwallex provider (`providers/airwallex/`)

- Sandbox only, read only: login plus `GET /global_accounts`, `GET /balances/current` and `GET /beneficiaries`.
  There is no payment, transfer, beneficiary-creation, token-refresh or production path.
- It was exercised against the sandbox once (2026-11-14).
- The credential-file test skips unless all three role files exist, which a reviewer normally does not have.

## Airwallex sandbox screen (`/sandbox`)

- Sandbox only. One 5.00 USD test transfer was created; its last status read was PROCESSING. It is not claimed as paid.
- Single-operator passphrase login on a local server; sessions are in memory. Not a multi-user identity system.
- The audit chain is a local file without a secret key and is not externally anchored. The same OS account could
  rewrite it, including a forged approval.
- Truncating the end of the audit file is not detected: removing trailing events leaves a valid shorter chain, which
  would also reset the one-create limit for a new request.
- If the server stops while writing an audit event, a stale `audit.lock` file in the data directory blocks every
  later write (`AUDIT_LOCKED`) until it is deleted by hand.
- The human-approval gate is enforced at the HTTP endpoint. A process running as the same OS user could call the
  workflow code directly.
- The policy reads the sandbox balance at approval time; it is not re-read at submission.
- One fixed synthetic proposal; no free-form payments. No beneficiary creation, cancellation or status simulation.
- Provider status names come from Airwallex documentation; only SCHEDULED and PROCESSING have been observed.
- Full details: `docs/AIRWALLEX_SANDBOX_INTEGRATION.md`.

## Funding ledger

- **Gate C covered 13 selected database cases, once, in one scratch environment.**
- 14 held cases were **NOT RUN**: DBT-01, 09, 10, 13, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27.
- **Untested:**
  - concurrency (F-1, DBT-25, Gate D);
  - streamed and parallel paths (N-9);
  - durability and crash/restart (DBT-23, Gate F);
  - injection (DBT-26, DBT-27).
- Runner identity is checked by path and then executed. That is **not atomic** (F-B, open).
- Gate C review findings: 4 Low and 7 Info (see `docs/EVIDENCE_SUMMARY.md`). Unevidenced items include DBT-12
  deferral timing, the DBT-20 "fails with a position" claim, and the direct allocation row count.
- **The database run cannot be reproduced from this repository alone.** Reproducing it needs a dedicated
  PostgreSQL 18 cluster created by `g2c1_durable_cluster.sh` and operator approval of migration digests. The sealed
  Gate C evidence is not published.
- The offline suite is reproducible, with conditions:
  - it writes only to `$HOME/g2c1-a10-scratch`;
  - it refuses to run if `HOME` or `TMPDIR` point elsewhere;
  - it refuses a second run until that directory is moved aside.
- The runner assumes `/usr/bin/bash`, `/usr/bin` utilities and `/usr/lib/postgresql/18/bin`. Its trusted-execution
  contract is written at the top of the script. A hostile or compromised host is out of scope.
- Funding only. Exposures, reservations, settlement, return, reversal, approvals, dispatch and provider tables are not
  implemented in the ledger.
- Erratum E-F9: one rationale comment in the header of `0011_g2c1_funding_ledger.sql` is inaccurate. The erratum is
  recorded in `services/api/app/domain/g2_db/ledger/__init__.py`. The migration bytes are deliberately unchanged
  because they are hash-pinned.
