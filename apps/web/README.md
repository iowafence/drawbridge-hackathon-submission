# DRAWBRIDGE Incident Room (front end)

> **Scope note (2026-11-15).** Everything below describes the six Incident Room screens, which are synthetic and
> unchanged. The app now also serves a separate, operator-protected `/sandbox` screen that calls the Airwallex
> **sandbox** from the server and has working approval controls for one sandbox test transfer. See
> `docs/AIRWALLEX_SANDBOX_INTEGRATION.md` in the repository root. `npm run dev` and `npm run start` bind to 127.0.0.1.

Synthetic, read-only, five-screen demonstration. It shows a construction treasury incident from fixture data.
It is not a financial authority. It has no backend, no bank connection, no credentials and no write path.

## Run locally

Requires Node 22.18 or newer and npm.

    cd apps/web
    npm install            # public registry; install scripts are disabled by .npmrc
    npm run dev            # http://localhost:3100  (redirects to /overview?s=S0)

Production-style run:

    npm run build
    npm run start          # http://localhost:3100

Clean-room local review from a fresh checkout:

    cd apps/web
    npm ci
    npm run cleanroom      # restores canonical S0/S1 bytes, then checks and builds
    npm run start          # serves only the local synthetic demo on port 3100

`npm run reset:fixtures` is deterministic and restores only `fixtures/s0.json` and `fixtures/s1.json`
from `fixtures/canonical/`. It cannot approve, reserve, claim or send money.

Checks:

    npm run typecheck
    npm test               # contract and fixture tests (node:test)

## Screens and routes

| Route | Screen |
|---|---|
| /overview | 1. Treasury overview: CASH, AVAIL, NEW_RESERVABLE, DISPATCHABLE_NOW, wallet, shortfall, forecast |
| /payables | 2. Obligations and exclusions |
| /incident | 3. Incident detail: the unresolved concrete transfer |
| /approvals | 4. Approval queue (disabled preview) |
| /recorder | 5. Flight recorder and reconciliation |

Add `?s=S0` (known holds) or `?s=S1` (unknown exposure blocks new commitment). The scenario is in the URL, so a
link always shows the same state.

## Structure

- `fixtures/` facts only (S0, S1), with `canonical/` as the reset source. Every derived figure is computed in `src/contract/derive.ts`.
- `src/contract/` types, exact money (integer cents, no floats), derivation, invariant self-check.
- `src/data/adapter.ts` the read-only boundary. It accepts only provenance `SYNTHETIC_FIXTURE` and refuses a
  fixture that breaks the contract identities.
- `src/app/` the five screens. `src/components/` shared shell and figures.
- `tests/` contract tests.

## Rules for this lane

No credentials, no provider calls, no browser access to any banking API, no approval or send control that works.
The approval button is disabled on purpose. See docs/phase2/04_ANVIL3_PLATFORM_UI.md.
