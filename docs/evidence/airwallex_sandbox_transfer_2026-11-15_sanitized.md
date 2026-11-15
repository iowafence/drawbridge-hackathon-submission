# Airwallex sandbox transfer evidence, 2026-11-15 (sanitized)

Source: the local integration audit chain written by the `/sandbox` workflow on the owner's workstation, exported
with a one-off script (which is why booleans print as `True`/`False`). The chain was
re-read and its hash links verified (13 of 13 events) before this export. Sanitization: the beneficiary's provider ID
and the approval digests are omitted, so this table cannot be re-hashed by a reader; no credential, token, account
number or routing value was ever recorded in the chain. Screenshots: `sandbox_signed_in_2026-11-15.png` (taken after the transfer, from a view-only session; the USD balance
shows 9999995) and `sandbox_signed_out_2026-11-15.png` (no data without sign-in).

**Sandbox only. Test data. No real money moved. The transfer is NOT reported as paid.**

## Result

| Item | Value |
|---|---|
| Environment | `https://api.sandbox.airwallex.com` |
| Balance read | `GET /api/v1/balances/current` HTTP 200 (46 currency entries; USD available 10000000 sandbox test funds) |
| Beneficiary lookup | `GET /api/v1/beneficiaries` HTTP 200; the existing sandbox test beneficiary for US / USD / LOCAL / ACH |
| Policy decision | ALLOW, rule `P-6 WITHIN_RESERVE` (5.00 USD proposal, 100.00 USD reserve, 10.00 USD demo cap) |
| Human approval | Recorded as `human:operator`, with the passphrase re-entered for the decision |
| Validation | `POST /api/v1/transfers/validate` HTTP 200 |
| Creation | `POST /api/v1/transfers/create` HTTP 201, provider status in the response: `SCHEDULED` |
| Request ID | `e7f2a730-2789-44d1-88cf-30c9158e4b67` |
| Provider transfer ID | `cd93a12c-4ce0-4d2d-b097-187f311594d9` |
| Status read | `GET /api/v1/transfers/{id}` HTTP 200, provider status `PROCESSING`; request ID, amount and currency match |
| Paid? | **Not reported as paid.** `PROCESSING` is the last status read from the provider |

Exactly one create request was sent. The owner's one-time release was removed afterwards, and the workflow's limit of
one create per audit chain is reached, so this chain cannot create another transfer.

## Two requests appear in the chain

Request `aa4c5645` was prepared by the preparation tool (`agent:prepare-cli`), pre-validated, then approved and
formally validated by the operator, but **never submitted**. The operator then drafted request `e7f2a730` in the UI
and took it through review, approval, validation, submission and the status read. Event 5 is a refused repeat of the
approval action on the first request.

## Events

| # | Time (UTC) | Event | Actor | Request | Detail | Event hash |
|---|---|---|---|---|---|---|
| 1 | 2026-11-15T15:53:59.380Z | `DRAFT_CREATED` | agent:prepare-cli | `aa4c5645` | proposal_id=SBX-PROP-0001 · beneficiary_label=US USD LOCAL (sandbox ACH test) · amount_minor=500 · currency=USD · reference=DB-SBX-0001 · reason=goods_purchased · transfer_method=LOCAL · state=DRAFT | `41b88e8d3628610a…` |
| 2 | 2026-11-15T15:53:59.381Z | `REVIEW_REQUESTED` | agent:prepare-cli | `aa4c5645` | state=REVIEW_REQUIRED | `90ca3aca99f5e475…` |
| 3 | 2026-11-15T15:54:01.063Z | `PREVALIDATION_RESULT` | agent:prepare-cli | `aa4c5645` | http_status=200 · code=PROVIDER_PREVALIDATION_PASSED · policy=ALLOW · policy_rule=P-6 WITHIN_RESERVE · creates_transfer=False | `84123b251531e7b2…` |
| 4 | 2026-11-15T16:05:34.609Z | `HUMAN_APPROVED` | human:operator | `aa4c5645` | state=HUMAN_APPROVED · policy_rule=P-6 WITHIN_RESERVE · expires_at=2026-11-15T16:15:34.609Z | `6c7d429019e8be38…` |
| 5 | 2026-11-15T16:05:35.268Z | `REFUSED` | human:operator | `aa4c5645` | op=decide · code=WRONG_STATE | `5f51f679af7b7948…` |
| 6 | 2026-11-15T16:06:28.801Z | `VALIDATION_RESULT` | human:operator | `aa4c5645` | state=VALIDATED · http_status=200 · code=PROVIDER_VALIDATION_PASSED | `aabef94dbe1b873c…` |
| 7 | 2026-11-15T16:16:59.791Z | `DRAFT_CREATED` | human:operator | `e7f2a730` | proposal_id=SBX-PROP-0001 · beneficiary_label=US USD LOCAL (sandbox ACH test) · amount_minor=500 · currency=USD · reference=DB-SBX-0001 · reason=goods_purchased · transfer_method=LOCAL · state=DRAFT | `7e0db85749055550…` |
| 8 | 2026-11-15T16:17:09.866Z | `REVIEW_REQUESTED` | human:operator | `e7f2a730` | state=REVIEW_REQUIRED | `98e74acc22f584b5…` |
| 9 | 2026-11-15T16:19:50.470Z | `HUMAN_APPROVED` | human:operator | `e7f2a730` | state=HUMAN_APPROVED · policy_rule=P-6 WITHIN_RESERVE · expires_at=2026-11-15T16:29:50.470Z | `0230137c7849ed8c…` |
| 10 | 2026-11-15T16:20:23.647Z | `VALIDATION_RESULT` | human:operator | `e7f2a730` | state=VALIDATED · http_status=200 · code=PROVIDER_VALIDATION_PASSED | `be829abec090b1cd…` |
| 11 | 2026-11-15T16:20:44.095Z | `SUBMISSION_ATTEMPTED` | human:operator | `e7f2a730` | state=SUBMITTING | `413ef4a4820f104d…` |
| 12 | 2026-11-15T16:20:45.463Z | `PROVIDER_RESPONSE` | server | `e7f2a730` | state=SUBMITTED_TO_AIRWALLEX · http_status=201 · provider_transfer_id=cd93a12c-4ce0-4d2d-b097-187f311594d9 · provider_status=SCHEDULED · code=CREATE_ACCEPTED_NOT_PAID | `69cf47d268f11aa0…` |
| 13 | 2026-11-15T16:21:11.482Z | `RECONCILIATION_RESULT` | human:operator | `e7f2a730` | state=PROVIDER_STATUS_RECONCILED · http_status=200 · provider_transfer_id=cd93a12c-4ce0-4d2d-b097-187f311594d9 · provider_status=PROCESSING · code=PROVIDER_RECORD_MATCHES | `7b4e1ab181b80fd9…` |

## Limits of this evidence

- The audit chain is a local file. Its hash links detect an edited or removed event in the middle of the chain, but
  not removal of trailing events. It has no secret key and is not externally anchored: anyone with the same
  operating-system account could rewrite the whole chain.
- "Human approval" means an authenticated operator session plus the passphrase re-entered for that action, on a
  single-operator local server. It is not a multi-user identity system.
- The provider-side record can be checked independently only by the account owner in the Airwallex sandbox console.
- The integration was reviewed by a fresh-context agent on the same account, not by a third party.
