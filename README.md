# DRAWBRIDGE

**Demo video:** [Watch the DRAWBRIDGE Demo (4:12)](https://drive.google.com/file/d/1AbEwaq3Op9TUT1PVn7-exSrqh524vsEf/view?usp=drive_link)

Copyright 2026 Iowa Fence Inc. All rights reserved. See `NOTICE`. No open-source license is granted.

DRAWBRIDGE is a treasury-control prototype for a construction contractor. Its rule is: **AI investigates and explains,
deterministic code decides eligibility, a person approves, and nothing moves until the controls say so.**

This repository is a curated hackathon submission. It contains three **separate** components, plus one integration
screen added on 2026-11-15:

| Component | Path | What it is | Data |
|---|---|---|---|
| Airwallex sandbox screen | `apps/web/src/app/sandbox/`, `apps/web/src/server/` | Operator-protected `/sandbox` page: live sandbox balance read, deterministic reserve policy, human-approved sandbox transfer, local audit chain | Live Airwallex **sandbox** test data |
| Evidence Analysis Agent | `apps/web/src/app/sandbox/agent/`, `apps/web/src/server/agent*.ts` | Operator-protected `/agent` page: Claude Opus 5.5 (or optional local Ollama) analyses synthetic evidence with read-only tools; a positive-proof gate over a synthetic trusted registry decides. **No financial authority** | Synthetic evidence; live model inference |
| Incident Room UI | `apps/web/` | Next.js demo of a cash-crisis incident: Command, Incident, Payables, Recorder (plus Approvals and Eligibility) | Synthetic fixtures only |
| Airwallex read-only provider | `providers/airwallex/` | Standalone, sandbox-only Airwallex client restricted to login and three read endpoints | Your own sandbox credentials, if you choose to run the live preflight |
| Funding ledger (G2C1) | `db/migrations/`, `services/api/app/domain/g2_db/`, `fixtures/`, `contracts/` | PostgreSQL double-entry funding ledger schema, hash-pinned cluster runner, Python replay/reconcile/manifest tooling | Synthetic |

**The six Incident Room screens (the E3 scenario) are synthetic and do not call Airwallex or read the ledger. The
ledger does not call Airwallex.** The `/sandbox` screen talks to the Airwallex **sandbox** only; it shares no data,
balance or decision engine with the E3 scenario. Nothing here is connected to a real bank account or real money.

### Runtime AI: the Evidence Analysis Agent

`/agent` runs a real model at request time (Claude Opus 5.5 through the Claude API; the page shows the provider, the
model ID the API reported, latency and request IDs). The model reads synthetic evidence, may call up to two read-only
tools, extracts typed claims and recommends. Nothing the document or the model says is treated as proof: a
deterministic gate decides HOLD, REVIEW or ELIGIBLE FOR HUMAN REVIEW, and eligibility requires eleven proofs verified
from a trusted, read-only **synthetic** registry (registered source document, obligation, approval record, document
manifest, dispute status) plus the provider-read balance. The agent cannot create, approve or submit a payment and
has no access to the transfer workflow or its credential. This is separate from the payment workflow below, in which
a human approved one sandbox transfer. Details: `docs/EVIDENCE_AGENT.md`; gate specification:
`docs/EVIDENCE_AGENT_POLICY.md`.

### E3 scenario and Airwallex sandbox, side by side

| | Incident Room (E3 scenario) | Airwallex sandbox (`/sandbox`) |
|---|---|---|
| Data | Synthetic fixtures | Live Airwallex sandbox test data |
| Decision | Funding controls block disbursement. **Ready to send: $0.00** | A separate 5.00 USD synthetic proposal **passes** a reserve policy on the sandbox balance (ALLOW) |
| Human step | Approval controls disabled by design | An authenticated operator approved the exact request |
| Provider | None | Airwallex validated the request (HTTP 200) and created one sandbox transfer (HTTP 201) |
| Outcome | Nothing moves | Provider status read back as **PROCESSING**. It is **not** reported as paid |

These are two demonstrations of the same rule (deterministic code decides, a person approves), **not** one integrated
payment system. No E3 obligation was paid, and no E3 figure uses a sandbox balance. Evidence:
`docs/evidence/airwallex_sandbox_transfer_2026-11-15_sanitized.md`. Design, controls and limits:
`docs/AIRWALLEX_SANDBOX_INTEGRATION.md`.

Demo video: [Watch the DRAWBRIDGE Demo (4:12)](https://drive.google.com/file/d/1AbEwaq3Op9TUT1PVn7-exSrqh524vsEf/view?usp=drive_link)

---

## 1. What DRAWBRIDGE demonstrates

- **Incident Room (UI).** A synthetic commercial build hits a week-two funding gap ($1,300,000.00 when the owner draw is
  delayed; no gap when it arrives on time). The screens show which commitments are stopped and why, which payables are
  eligible or excluded, the approval dependencies, bounded agent findings, and a hash-chained evidence trail (Recorder).
  "Ready to send" is $0.00 in both cases and every release control is disabled by design.
- **Airwallex provider.** A permission boundary in code: the client refuses production hosts, any method or path outside
  its allowlist, and any credential file other than an owner-only `.env.read`, all before any network access.
- **Funding ledger.** An append-only double-entry ledger in PostgreSQL (allocation events, journal headers and legs,
  database-enforced balance, contiguity and idempotency rules, read-only views), plus offline tooling that replays,
  reconciles and exports a hash-chained manifest of the ledger.

## 2. Run the UI locally

Requires Node.js 22.18 or newer and npm (verified with Node 22.23.1). Run from a fresh clone:

```bash
cd apps/web
npm ci                 # installs the exact lockfile versions; install scripts are disabled by apps/web/.npmrc
npm run typecheck      # run BEFORE starting the dev server (see Known limitations)
npm test
npm run dev            # http://localhost:3100
```

Production-style run (also verified on a clean checkout): `npm run build && npm run start` (port 3100).

Screens: `/overview` (Command), `/incident`, `/payables`, `/recorder`; also `/approvals` and `/eligibility`.
Parameters: `?d=delayed` or `?d=on_time` (draw case), `?s=S1` (spending-blocked scenario), `/overview?tour=1` … `6`
(guided tour).

If the dev server reports "Too many open files", start it with `ulimit -Sn 16384` and `WATCHPACK_POLLING=1000`.

Sandbox integration tests (all provider calls mocked, no network): `npm run test:sandbox`, expected **17 tests, 17 pass**.
Evidence agent tests (scripted model, no network): `npm run test:agent`, expected **17 tests, 17 pass**.

Expected `npm test` result in this repository: **106 tests, 104 pass, 0 fail, 2 skipped.** The two skipped tests
(`UI-B3`, `UI-B4`) re-check pinned files against the original internal commit
`f88af200a3e76b31c1f6129bfeae04e2ca64a24a`, which is deliberately not part of this repository's history. They skip
automatically when that commit is unavailable. The other baseline tests (`UI-B1`, `UI-B2`) check the same files
against SHA-256 pins in `apps/web/tests/ui-baseline.json` and do run.

`apps/web/README.md` and `apps/web/UI_BASELINE.md` are the original component documents, copied unchanged. They refer
to internal documents (`docs/phase2/…`) and Git history that are not included here.

## 3. Run the offline provider tests

Python 3 standard library only (verified with Python 3.14.4). No network, no credentials:

```bash
cd providers/airwallex/tests/provider
python3 -m unittest -v test_client_permission_boundary test_credential_isolation
```

Expected: **30 collected, 29 pass, 0 fail, 1 skipped.** The skipped test
(`ProjectCredentialFiles.test_modes_and_key_separation`) runs only when `.env.read`, `.env.setup` and `.env.executor`
all exist in `providers/airwallex/`; a reviewer normally has none of them.

## 4. Reproduce the read-only Airwallex sandbox preflight (optional)

Apart from the `/sandbox` screen (which needs server-side configuration and makes no call without it), this is the
only part of the repository that makes network calls. It needs **your own Airwallex sandbox** API
credentials (read access is enough) and performs one token login (POST) and two GETs. It never creates, pays,
transfers or converts anything, and it refuses any non-sandbox host.

```bash
cd providers/airwallex
umask 077
cat > .env.read <<'ENV'
AWX_ENV=sandbox
AWX_BASE_URL=https://api.sandbox.airwallex.com/api/v1
AWX_READ_CLIENT_ID=<your sandbox client id>
AWX_READ_API_KEY=<your sandbox api key>
ENV
chmod 600 .env.read
python3 scripts/run_readonly_preflight.py
```

Expected: login `http_status` 201, then 200 for `GET /global_accounts` and `GET /balances/current`, and
`READ-ONLY SANDBOX PREFLIGHT PASSED; NO BANKING WRITES`. Only status codes and response shape are printed.
**Never commit `.env.read`** (it is ignored by `.gitignore`). Details: `providers/airwallex/REVIEWER_GUIDE.md`.

Our own run on 2026-11-14 is recorded, sanitized, in
`providers/airwallex/evidence/sandbox_smoke_2026-11-14_sanitized.txt` (statuses, currency codes and field names only;
no amounts, token or key).

## 5. The separate G2C1 funding-ledger architecture

| Layer | Files | Role |
|---|---|---|
| Base schema (G2A/G2B) | `db/migrations/0001` … `0010` | Protected schemas and migration ledger; reference normalization; project, allocation and counterparty; evidence lineage; obligations; protected functions |
| Funding ledger | `db/migrations/0011_g2c1_funding_ledger.sql` | `allocation_event`, `journal_account`, `journal_txn`, `journal_leg`; `post_funding` and `post_funding_reduction`; deferred constraint triggers for balanced legs, contiguous versions and fresh headers; idempotency and duplicate-authorization rules; three read-only views (`ledger_event_stream`, `ledger_account_balance`, `ledger_reconciliation`) |
| Cluster runner | `services/api/app/domain/g2_db/tools/g2c1_durable_cluster.sh` | Creates and drives a **dedicated local PostgreSQL 18 scratch cluster** (unix socket only, no TCP listener); applies only migration files whose SHA-256 matches its built-in approved table |
| Bootstrap and preflight | `services/api/app/domain/g2_db/bootstrap/`, `fixture_preflight.py`, `contracts/`, `fixtures/normalization_corpus_v1.json` | Cluster roles and the pinned normalization corpus checked before migration |
| Tooling | `services/api/app/domain/g2_db/ledger/*.py` | Canonical forms, bounded retry, replay, reconciliation, hash-chained manifest export and verification, read-only snapshot, static lint, CLI |
| Tests | `services/api/app/domain/g2_db/ledger/tests/` | `test_g2c1_offline.py` (offline suite, no database); `db_cases.py` (database cases, need a running cluster) |

Money is integer cents; amounts, authorization ids and idempotency keys are **labels** for identity, not authority.

### Run the offline ledger suite

Needs Python 3 and `/usr/bin/bash`. **PostgreSQL is not needed** (verified with PostgreSQL hidden). The suite opens no
database connection and makes no network call.

The suite guards its workspace strictly. Read these rules before running it:

- It writes only under `$HOME/g2c1-a10-scratch` and refuses any other location. `HOME` must be your real account home
  directory, and `TMPDIR` and `G2C1_TEST_WORKSPACE` must be unset (or point exactly at that directory).
- A run leaves about 530 per-test directories there. **A second run refuses to start** until you move
  `$HOME/g2c1-a10-scratch` aside. The suite never deletes anything itself.
- It must be started from outside the repository.

```bash
REPO="$(pwd)"                    # the repository root
cd "$HOME"
env -u TMPDIR -u G2C1_TEST_WORKSPACE python3 -I -B -m unittest discover \
  -s "$REPO/services/api/app/domain/g2_db/ledger/tests" -p 'test_g2c1_offline.py'
```

Expected: **Ran 432 tests, OK (skipped=1)** when the repository is not a Git checkout (for example a downloaded
archive), where `test_owned_paths_only` skips. In a Git clone that test runs too: 432 tests, OK. This is the same
count recorded for the accepted source baseline. If you prefer not to write into your home directory, run the
command inside a sandbox that gives it a private home (we used `bwrap` with a tmpfs home).

The **database cases** (Gate C) are **not** reproducible from this suite alone. They need a dedicated PostgreSQL 18
cluster created by the runner and operator-approved migration digests. See `docs/EVIDENCE_SUMMARY.md`.

## 6. Implemented versus simulated

| Claim | Status |
|---|---|
| UI screens, money formatting, derivation and fixture validation | Implemented and tested; **all data synthetic** |
| Approve / reserve / send on the Incident Room (E3) screens | **Not implemented.** Controls are disabled by design |
| Airwallex sandbox login and read-only GETs | Implemented; verified once in the sandbox on 2026-11-14 |
| Airwallex sandbox transfer (validate, create once, read status) from `/sandbox` | Implemented; one 5.00 USD sandbox transfer created on 2026-11-15, last status read PROCESSING, not reported as paid |
| Airwallex production access, beneficiary creation, token refresh, cancellation, status simulation | **Not implemented** |
| Funding ledger schema and tooling | Implemented as source; offline suite passes; 13 selected database cases passed once in an isolated scratch cluster (see evidence) |
| E3 scenario ↔ Airwallex, UI ↔ ledger, ledger ↔ Airwallex | **Not connected** |
| `/sandbox` screen ↔ Airwallex sandbox | Connected, server-side only, operator sign-in required |
| Concurrency, durability/crash recovery, injection resistance, production readiness | **Not established** |
| AI on the Incident Room (E3) screens | The "agent findings" there are synthetic fixture text. No model is called |
| Evidence Analysis Agent (`/agent`) | Implemented: live Claude Opus 5.5 inference with client tool use (or local Ollama when selected), excerpt checks and a positive-proof gate over a synthetic trusted registry. Recommends only; no financial authority |

## 7. Known limitations and untested claims

See `docs/KNOWN_LIMITATIONS.md` for the full list. In short:

- Synthetic data only; local only; no hosted deployment; not a payment system.
- The ledger has passed only 13 selected database cases, once. 14 held cases were **NOT RUN**. Concurrency,
  durability, crash/restart and injection are untested.
- The Gate C review is a same-account, fresh-context agent review, **not a third-party audit**. Its finding is PASS
  WITH FINDINGS: 4 Low, 7 Info.
- The Airwallex sandbox transfer is one 5.00 USD test transfer whose last status read was PROCESSING. It is not
  claimed as paid, and it did not pay any E3 obligation.
- The sandbox audit chain is a local file without a secret key; the same OS account could rewrite it.
- Source comments cite internal review and governance identifiers (for example `G1S`, `LOOM-2 V04`, `AWX-P2-…`).
  Those documents are not included.

## 8. Demo video

[Watch the DRAWBRIDGE Demo (4:12)](https://drive.google.com/file/d/1AbEwaq3Op9TUT1PVn7-exSrqh524vsEf/view?usp=drive_link)

## Repository contents and provenance

All component source files are byte-identical to the internal source commits listed in `docs/EVIDENCE_SUMMARY.md`.
This repository was assembled without importing internal Git history.
