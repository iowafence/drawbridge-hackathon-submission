# DRAWBRIDGE — Airwallex read-only sandbox provider (reviewer guide)

See `NOTICE` (all rights reserved; provided for hackathon review and evaluation).

## What this is

A standalone, **sandbox-only** Airwallex client (`scripts/awx_client.py`). `ReadOnlyClient` may only log in and call `GET /global_accounts`, `GET /balances/current` and `GET /beneficiaries`. It refuses any environment other than `sandbox`, any base URL other than `https://api.sandbox.airwallex.com/api/v1`, any method or path outside its allowlist, a credential file not named `.env.read`, and one readable by group or others, all **before** any network access. Errors are fixed codes; tokens and keys are never printed. There is no payment, transfer or executor client.

**Scope note:** this guide covers the standalone Python client in this directory only. The separate `/sandbox` screen
in `apps/web` has its own TypeScript sandbox adapter; see `docs/AIRWALLEX_SANDBOX_INTEGRATION.md`.

**What it is not:** the DRAWBRIDGE Incident Room (E3) screens and the PostgreSQL funding ledger do **not** call Airwallex; the UI shows synthetic scenario data. This Python client implements no payment, transfer or token refresh.

## Evidence

`evidence/sandbox_smoke_2026-11-14_sanitized.txt`: on 2026-11-14 the client authenticated to the sandbox (**HTTP 201**) and read current balances (**HTTP 200**, 46 currency entries). Statuses, expiry metadata, currency codes and field names only; no amounts, token or key.

## Reproduce

Requirements: Python 3 standard library only (verified with Python 3.14.4); no third-party packages.

1. Offline boundary tests (no network, no credentials):

```bash
cd tests/provider
python3 -m unittest -v test_client_permission_boundary test_credential_isolation
```

Expected: **30 collected, 29 pass, 0 fail, 1 skip.** The skipped test (`ProjectCredentialFiles.test_modes_and_key_separation`) checks real project credential files and runs only when `.env.read`, `.env.setup` and `.env.executor` all exist; with only `.env.read` present (step 2) it still skips.

2. Live read-only check with **your own Airwallex sandbox** credentials (read access is enough). In this directory:

```bash
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

Expected: login `http_status` 201, then 200 for `GET /global_accounts` and `GET /balances/current`, and `READ-ONLY SANDBOX PREFLIGHT PASSED; NO BANKING WRITES`. Only the response shape is printed. Never commit `.env.read`.
