# Integrated mock flow backend (prototype)

This adds an **integrated transaction flow** that carries one synthetic obligation through evidence, the deterministic
11-proof gate, a separate human approval, at most one provider submission, and a provider status read-back. It runs
against a **mock provider**. It is a prototype for review, not a production financial system, and it is **not** an
end-to-end, browser-controlled payment application.

Code: `apps/web/integrated/` (server-only modules), `apps/web/src/app/sandbox/flow/` (action route and preview pages),
`apps/web/src/components/integrated/` (stepper UI), `apps/web/fixtures/integrated/` (synthetic data),
`apps/web/tests/integrated/` (tests). Audit threat model: `docs/integrated/AUDIT_THREAT_MODEL.md`.

## 1. What the integrated mock backend does

- **One flow ID per transaction.** The server builds the exact proposal (payee, beneficiary, amount, reference,
  provider request ID) from a synthetic registry, a binding fixture and a beneficiary allowlist. The browser supplies
  only a case ID.
- **Evidence.** A registered synthetic document plus recorded extracted facts are attached (`FIXTURE_REPLAY`). No model
  is called by this backend.
- **Deterministic gate.** The reviewed 11-proof gate (`agentPolicy.evaluate`) is bound to the exact proposal. The
  beneficiary must be the one the registry obligation resolves to. *Eligible* means eligible for human review only.
- **Human approval.** An authenticated operator re-enters their passphrase to approve the exact proposal and gate
  digests. The server signs the approval with a per-process key and re-checks everything at submit.
- **Single submission.** The submit intent is committed, and recorded in a separate append-only submission history,
  **before** the single provider create call. An approval cannot be reused: an in-process record, the submission
  history file, and a read-only request-ID lookup at the provider are all checked before approval and before submit.
  An uncertain create is never retried; only a provider status read moves it.
- **Mock provider.** `DB_INTEGRATED_PROVIDER_MODE=mock` (the default) uses a local mock with no network. The
  previously recorded Airwallex sandbox transfer (see the main README) was a **separate** demonstration and was not
  made by this flow.
- **Audit.** Every state change appends to a local hash-chained audit trail.
- **Isolation lint.** `tests/integrated/a7/` checks that integrated code cannot import the model agent, the transfer
  role or other restricted modules.

## 2. Install and run locally

Requirements: Node 22.5+ and npm. From `apps/web`:

```bash
npm ci
npm run build
export DEMO_PASSPHRASE='choose-a-local-demo-passphrase'     # 12+ characters, your shell only
eval "export $(node scripts/integrated/mock-demo.mjs hash)"  # sets DRAWBRIDGE_OPERATOR_SCRYPT for this shell
export DB_INTEGRATED_FLOW_ENABLED=1 DB_INTEGRATED_PROVIDER_MODE=mock
export DB_INTEGRATED_DATA_DIR=/tmp/drawbridge-mock-demo       # absolute, outside the repository, fresh per run
npx next start --hostname 127.0.0.1 --port 3191
```

Do not set any `AWX_*` variable for this flow. Without `DB_INTEGRATED_FLOW_ENABLED=1`, or with any malformed flag,
the integrated routes return 404: the default is fail-closed. Integrated storage refuses to sit inside the repository
or to overlap the historic sandbox data directory.

## 3. Reproduce the mock workflow

In a second shell (with the same `DEMO_PASSPHRASE` and `DB_INTEGRATED_DATA_DIR`), from `apps/web`:

```bash
node scripts/integrated/mock-demo.mjs run
```

The script drives the **real** server endpoints through sign-in, `create_flow`, `attach_evidence`, `evaluate_gate`,
`request_human_review`, `approve`, `submit`, a replayed `submit`, and `reconcile`, printing each server response,
the flow state and the mock-provider create count. Expected: state `PROVIDER_PROCESSING`, the replayed submit refused
as `DUPLICATE_SUBMISSION`, and **one** mock create call.

Attack reproductions, as tests:

```bash
npm run test:integrated                                                    # the whole integrated suite
node --test --test-name-pattern="REPRO-X1" tests/integrated/e2e/a8_reproductions.test.ts
#   beneficiary swap: a store writer redirects the payment to another allowlisted beneficiary; refused, 0 creates
node --test --test-name-pattern="REPRO-A8-09" tests/integrated/e2e/a8_09_reproductions.test.ts
#   restart replay: after a create, the database is rolled back to awaiting-approval, the server restarts and a human
#   re-approves; refused, no second create
```

## 4. The UI flow pages are previews

`/sandbox/flow` and `/sandbox/flow/<id>` render **labelled UI fixture previews**. They are **not wired to live flow
state** in this build: a live flow ID returns 404, and the index does not list live flows. There is no browser form to
create a flow or attach evidence. The live flow is reachable only through the action endpoint, as the demo script uses
it. That script reads the two echo digests (shown on screen in a wired UI) read-only from the server's store; the
server re-verifies them.

## 5. Scope and separation

- The integrated backend uses a **mock provider**, not Airwallex. It performs no actual payment execution.
- The Evidence Analysis Agent (`/agent`, live Claude Opus 5.5 inference) and the earlier Airwallex sandbox transfer
  (`/sandbox`) are **separate** components. The integrated flow does not call the model and did not make that transfer.
- The E3 Incident Room scenario is separate and does not feed this flow.

## 6. Known limitations and residual risks

**Financial-execution safety against actual Airwallex behaviour is NOT verified.** These are UNVERIFIED: Airwallex
request-ID duplicate suppression, how soon a create becomes visible to `GET /transfers?request_id=`, and the exact list
response shape. The accepted shape `{items, has_more: false}` is a pinned assumption; a mismatch fails closed, which
costs liveness, not safety.

Open residuals (NOT resolved). Each needs a writer who controls the **whole** integrated data folder, followed by a
restart or another process and a fresh human approval:

| ID | Preconditions | Provider create calls | Possible financial effect |
|---|---|---|---|
| R-1 | Database and submission history restored together; the provider holds no record (first create refused, or never received) | 2 | at most 1 transfer |
| R-2 | Mock mode; the mock provider's state file (inside the data folder) also restored or erased | 2 | none (mock) |
| R-3 | First create accepted but not yet visible to the lookup, or still in flight | 2 | 1 transfer if the provider deduplicates the request ID; possibly 2 otherwise. **Unverified.** Two create calls are not evidence of two transfers |

The test suite contains observed-behaviour tests for these, titled `RESIDUAL R-1 — OBSERVED / NOT PROTECTED`,
`MOCK-MODE LIMIT` and `RESIDUAL R-3 — OBSERVED / NOT PROTECTED`. They assert what happens; they are not protections.

Other limitations:

- **The isolation scanner is defense-in-depth lint, not a sandbox** or a code-execution isolation guarantee. Known gaps:
  a computed-key bypass through a listed keyed access (E-1), N6, N16 and N23 are not addressed, nothing outside
  `integrated/` is scanned, and imports are resolved as Node resolves them, not as the bundler does. `.cts` files are
  still permitted (E-2, no escape found). Review of every change under `integrated/` remains the real control.
- Some alternate request-ID response shapes are still read as absent (A8-12). This is deferred until the real provider
  contract is verified.
- Liveness by design: a crash between the history write and the database commit permanently blocks that flow; a
  corrupted history blocks approvals store-wide; a failed post-intent lookup leaves the flow `SUBMISSION_UNCERTAIN`.
- The single-use record in memory is per process; restarts and other processes rely on the approval key changing and
  on the submission history.
- The audit chain is local and keyless: it detects accidental edits but not a same-user rewrite.
- The reviews behind this code were internal, fresh-context agent reviews (verdict PASS WITH FINDINGS), **not a
  third-party audit or certification**.
- Source comments cite internal lane labels (A1 to A8), contract section numbers and the internal contract
  `contracts/integrated/flow-v1.md`. That contract and the internal review documents are not included.
