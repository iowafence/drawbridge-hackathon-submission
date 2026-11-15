# Airwallex sandbox integration

Status (2026-11-15), run locally on 127.0.0.1 by the account owner against the Airwallex **sandbox**:

- **Live balance read:** `GET /balances/current` HTTP 200; the data reached `/sandbox`.
- **Policy:** ALLOW (`P-6 WITHIN_RESERVE`) for the 5.00 USD synthetic proposal.
- **Human approval:** recorded for the exact request by the signed-in operator.
- **Validation:** `POST /transfers/validate` HTTP 200.
- **Creation:** one sandbox transfer, `POST /transfers/create` HTTP 201, provider ID
  `cd93a12c-4ce0-4d2d-b097-187f311594d9`, status in the response `SCHEDULED`.
- **Status read:** `GET /transfers/{id}` HTTP 200, status `PROCESSING`, record matches. **Not reported as paid.**
- Evidence: `docs/evidence/airwallex_sandbox_transfer_2026-11-15_sanitized.md`.

Nothing here changes the synthetic E3 scenario, its $1,300,000.00 week-two gap, or its ready-to-send amount of $0.00.
The sandbox screen and the E3 scenario share no data and no decision engine.

## What it adds

A separate screen, `/sandbox`, served by the same Next.js app. It links to the Incident Room; the six Incident Room
screens are unchanged and do not link to it.

1. **Live sandbox balances.** After operator sign-in, the server calls `GET /api/v1/balances/current` on
   `https://api.sandbox.airwallex.com` and shows the provider's own decimal text. Labelled AIRWALLEX SANDBOX · NOT
   PROJECT CASH · SANDBOX / TEST DATA. If the read fails, a fixed error code is shown and nothing is substituted.
2. **Policy decision.** Deterministic code evaluates one synthetic supplier-payment proposal
   (`apps/web/fixtures/sandbox_proposal_v1.json`: 5.00 USD, reserve threshold 100.00 USD, demo cap 10.00 USD) against
   the sandbox USD available balance and returns ALLOW or HOLD with the exact rule and reason. ALLOW is a
   recommendation; it authorizes nothing.
3. **Human-approved transfer workflow.** `DRAFT → REVIEW_REQUIRED → HUMAN_APPROVED → VALIDATED →
   SUBMITTED_TO_AIRWALLEX → PROVIDER_STATUS_RECONCILED`, using `POST /transfers/validate`, `POST /transfers/create`
   and `GET /transfers/{id}` (or `GET /transfers?request_id=`).
4. **Integration audit trail.** A new hash-chained JSONL file. It is not the E3 recorder events and not the G2C1 chain.

## Controls (all enforced on the server)

- Sandbox host is hard-coded. A production or custom base URL in a credential file is refused before any network use.
- Each role has a fixed operation allowlist. The read role has no POST. The transfer role has exactly five: validate, create, two transfer reads and a beneficiary list read.
- Credentials are read on the server from owner-only files outside the repository. No client component exists and no
  browser-exposed environment variable is used.
- Every action needs an operator session (HttpOnly, SameSite=Strict cookie), a same-origin request to a loopback
  host (127.0.0.1 or localhost) and a CSRF token.
  Approve, reject and submit also need the passphrase again in the same request.
- Only an authenticated human operator can approve or submit. A human cannot approve what the policy holds.
- The destination must be on the owner's beneficiary allowlist. Amount, currency, reference and method come from the
  fixed proposal; there is no free-form entry. The amount is integer minor units; 10.00 USD cap in code.
- Approval binds to a SHA-256 digest of beneficiary, amount, currency, reference, request ID, reason and method, and
  expires after 10 minutes.
- A create request additionally needs `AWX_SUBMIT_RELEASE="<request_id>:<digest>"` set by the owner for that one
  transaction, and at most one create request is ever sent per audit chain.
- One-time submission: an exclusive lock file plus a recorded `SUBMISSION_ATTEMPTED` event before the call.
- A timeout, 5xx, 409, 429, duplicate-request error or unrecognized response stops in `OUTCOME_UNKNOWN`. It is never
  retried; the only way forward is to read the provider's record. A 201 from create is recorded as
  `CREATE_ACCEPTED_NOT_PAID`. PAID is shown only if the provider reports PAID.

## Server configuration (never commit these)

| Variable | Purpose |
|---|---|
| `DRAWBRIDGE_OPERATOR_SCRYPT` | scrypt hash of the operator passphrase. Create with `node scripts/operator-hash.mjs` |
| `AWX_READ_ENV_FILE` | absolute path of an owner-only (`chmod 600`) file named `.env.read` |
| `AWX_TRANSFER_ENV_FILE` | absolute path of an owner-only file named `.env.transfer` holding `AWX_ENV=sandbox`, `AWX_TRANSFER_CLIENT_ID`, `AWX_TRANSFER_API_KEY`. Use a **restricted sandbox key scoped to Transfers (view and edit) only**, not the admin key |
| `AWX_ALLOWED_BENEFICIARIES` | `<beneficiary uuid>=<label>;…` sandbox test beneficiaries only. In the settings file, wrap the value in double quotes: the start script reads the file as shell |
| `DRAWBRIDGE_DATA_DIR` | absolute directory for the audit file, outside the repository |
| `AWX_SUBMIT_RELEASE` | owner release of one exact transaction |

Run: `cd apps/web && npm run build && bash scripts/start-sandbox.sh` (127.0.0.1:3102; settings are read from a
mode-600 file, default `~/.config/drawbridge/sandbox-server.env`), then open `/sandbox`.
Bind to localhost. This operator login is a single shared passphrase for a local demonstration, not a user system.

## Preparation tool

`node scripts/sandbox-prepare.ts beneficiaries` lists existing sandbox beneficiaries (non-sensitive fields only).
`node scripts/sandbox-prepare.ts prepare <beneficiary uuid>` drafts the fixed proposal, requests review and runs a
non-executing provider pre-validation, recorded as `agent:prepare-cli`. It cannot approve, submit or create anything.

## Tests

`npm run test:sandbox` (17 tests, all provider calls mocked, no network). The existing suite `npm test` is unchanged.

## Known limitations

- Reviewed by a fresh-context agent on the same account, not by a third party.
- **Truncation and stale lock:** removing trailing events from the audit file leaves a valid shorter chain and is not
  detected. A crash while writing can leave `audit.lock` in the data directory; delete it by hand to resume.
- **Where the human gate lives:** at the HTTP endpoint (session, CSRF, passphrase re-entry). The preparation tool
  does not approve or submit, but a process running as the same OS user could call the workflow code directly.
- **Audit-chain trust:** approval and submission state are read from the local audit file. Its hash links have no
  secret key, so a process running as the same OS user could rewrite the chain, including a forged approval. The
  protection is file permissions and a trusted workstation.
- The provider status names are taken from Airwallex's public documentation and have not been observed live.
- The audit file is local, single-host and not externally anchored. Sessions are in server memory and end on restart.
- No sandbox status simulation is implemented. No beneficiary is created by this code.
