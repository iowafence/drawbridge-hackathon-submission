# Evidence Analysis Agent (`/agent`)

A runtime AI agent that reads synthetic, unstructured payment evidence, may call read-only tools, and recommends an
action. **It has no financial authority.** Deterministic code makes the decision, and a human must approve anything
that follows. It is separate from the Airwallex transfer workflow, which it cannot reach and which is unchanged.

`/agent` redirects to `/sandbox/agent`, so the page shares the operator sign-in used by `/sandbox`.

## Flow

```
unstructured synthetic evidence
  -> live model inference (Claude Opus 5.5 through the Claude API; local Ollama only if the operator selects it)
  -> read-only tool request      (validated by the controller: name allowlist, arguments, at most two)
  -> tool result returned to the model
  -> typed claims and a recommendation from the model (untrusted)
  -> excerpt check               (each claim must be tied to an exact excerpt that contains the claimed value)
  -> positive-proof gate         (eleven proofs; only trusted records can verify them)
  -> HOLD / REVIEW / ELIGIBLE FOR HUMAN REVIEW
```

## The gate in one paragraph

What a document says and what a model says are never proof. Eligibility needs eleven proofs, each `VERIFIED` by a
trusted source: the submitted text is exactly a registered document; payee, exact amount, currency and reference
match the trusted obligation record; the document manifest shows every required document received; an unconditional
approval record matches the payee, amount and currency exactly; the dispute register shows clear; funding is not
restricted; the cap and reserve hold on the provider-read balance; and a human review is still required. The trusted
records are a **synthetic, read-only registry** (`apps/web/fixtures/agent_registry_synthetic_v1.json`). It is fixture
data standing in for systems of record, not a real approval system. Untrusted inputs can only block. A new or edited
document can never be eligible. The gate applies no pattern to natural language. Full specification:
`docs/EVIDENCE_AGENT_POLICY.md`.

## Model providers

| Provider | How it is used | Notes |
|---|---|---|
| **Claude API** (default) | Official Anthropic TypeScript SDK, Messages API, client tool use, structured final answer. Model `claude-opus-5-5` with adaptive thinking (no thinking budget, no forced tool choice), effort `medium` | The key is read from an owner-only file named `.env.anthropic` (path in `DRAWBRIDGE_ANTHROPIC_ENV_FILE`) into memory. It is never put in the process environment, the browser, logs or the run record. The API host is pinned and SDK logging is off. The runtime refuses to call Claude while any `ANTHROPIC_*` variable is set in the server environment, because the SDK reads several of them |
| **Local Ollama** (optional fallback) | `http://127.0.0.1:11434` only. Default model `qwen2.5:7b` | Selected explicitly per run. It never receives the Anthropic key. Much weaker; not re-verified live against the current gate |

The provider is chosen by the operator for each run. **There is no automatic switch and no fallback to another
model**: if Claude is selected and fails or declines, the run fails closed to HOLD. Only `claude-opus-5-5` is
permitted; any other configured Claude model name is refused, not replaced. The page shows "Powered by Claude
API" only for a run in which a Claude call actually succeeded, and shows the model ID the API reported.

## Tools (all read-only)

| Tool | What it does |
|---|---|
| `get_airwallex_sandbox_balance` | Reads the sandbox USD available balance through the existing read-role adapter. Test funds, not project cash |
| `get_synthetic_scenario_constraints` | Returns the published constraints and the list of proofs eligibility requires |
| `evaluate_payment_eligibility` | Runs the gate on the facts the model extracted and returns the state of every proof. Advisory: the gate is run again on the final answer |

Any other tool name is refused and recorded. No tool takes a URL, path, command or amount to move, and none can
write to the registry. A third tool request ends the run closed.

## Input limits

Evidence longer than 8,000 characters (after unifying line endings) is refused whole before any model call: no part
of it is analysed, stored or shown as a registered document.

## Verified behaviour

See the live results recorded in the release notes for this feature and re-run them with
`node scripts/agent-live-check.ts anthropic` (needs the key file and the read credential).

## Tests

`npm run test:agent` runs two offline suites with no network:

- `tests/agent/policy.test.ts` (8 tests): the gate alone, with claims constructed directly so that the worst-case
  model is assumed. Cases A to K, trusted negatives, exact amount reconciliation, funding and reserve, the
  untrusted-only-blocks property, more than 100 wordings that reached eligibility in two earlier reviews, and
  invalid, ambiguous or malformed registries and claims (the gate never throws and never decides on them).
- `tests/agent/agent.test.ts` (9 tests): excerpt grounding, fail-closed paths, oversized evidence, the tool allowlist,
  recommendation independence, prompt injection, HTTP authorization, isolation from the payment code, and both
  adapters.

## Limitations

- The registry is synthetic fixture data. The gate is exactly as trustworthy as the registry.
- Only documents registered in the fixture can be eligible, so a free-typed document always ends in HOLD or REVIEW.
  That is intended: untrusted text cannot establish eligibility.
- The gate does not understand prose and does not check that a registered document agrees with its own record. If a
  registered document contains a conflicting total, a different payee or a stop notice that the model fails to
  report, and the trusted records say approved, received and clear, the result is eligible. Adverse findings are a
  model-dependent control that can only add a hold.
- No staleness check: a dispute status or approval is taken as current, and approvals have no expiry.
- An independent holdout of 617 cases written from the specification passes; the first scoring round found one High
  (a document type listed twice in the manifest) and four Medium issues, all fixed before the second round.
- Excerpt checks show where the model read a value; they do not prove the model interpreted it correctly.
- The model's rationale is displayed, not verified, apart from withholding it when it contains a number found in
  neither the document nor a tool result.
- Runs are kept in server memory (last 30), are not bound to a session, and are not written to the audit chain.
- Evidence text is sent to the Anthropic API when Claude is selected. Use synthetic documents only.
- No rate limit on inference for a signed-in operator.
- Reviews are by fresh-context agents on the same account, not by a third party.
