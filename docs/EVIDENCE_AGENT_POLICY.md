# Evidence agent: positive-proof policy specification

This is the specification of the eligibility gate in `apps/web/src/server/agentPolicy.ts`. It is written so that a
reviewer can derive test cases from it without reading the implementation.

## 1. Principle

**Untrusted inputs can only block. Only trusted sources can satisfy a requirement.**

| Input | Trust | What it can do |
|---|---|---|
| The submitted evidence text | Untrusted | Identify itself (by exact content) as a registered document; nothing else |
| Anything a model says: extracted claims, adverse findings, recommendation, rationale | Untrusted | Claims are compared with the registry and can cause a contradiction. Adverse findings block. The recommendation and rationale are never read by the gate |
| The registry (obligation, approval, document manifest, dispute status, registered documents) | Trusted, read-only, **synthetic** | The only source that can verify proofs S and A to H |
| The Airwallex sandbox balance read | Trusted provider read | Used in proof I only |
| Fixed policy constants (10.00 USD demo cap, 100.00 USD reserve) | Trusted | Proof I |

The gate applies no pattern to natural language. It never looks for words such as "approved", "attached" or
"disputed". A statement in a document or by a model that payment is approved, that documents are attached, or that
there is no dispute has no effect on any proof.

The registry is fixture data standing in for systems of record. It is not a real approval system. The gate is exactly
as trustworthy as the registry: if a registry record is wrong, the decision is wrong.

## 2. Proof states

`VERIFIED`, `MISSING`, `CONTRADICTED`, `UNTRUSTED`, `UNKNOWN`. Only `VERIFIED` satisfies a requirement.

- `VERIFIED`: established by a trusted source through exact comparison.
- `MISSING`: the trusted source shows the requirement is not met, or the model extracted no supported value to compare.
- `CONTRADICTED`: a trusted source and a claim disagree, or the trusted source records a negative.
- `UNTRUSTED`: everything matches, but the record was reached only through a reference read from an unregistered
  document, so nothing has been proven.
- `UNKNOWN`: no trusted record or reading is available.

## 3. Binding a document to an obligation

1. The evidence is canonicalised: CRLF and lone CR become LF; each line is trimmed with JavaScript `trim()` (so any
   Unicode white space at the start or end of a line is ignored, including a non-breaking space or a byte-order
   mark); runs of spaces and tabs inside a line collapse to one space; empty lines are dropped. Nothing else is
   normalised: case, punctuation, digits, line order and any character inside a line are significant. Registered
   texts are canonicalised the same way before comparison.
2. If the canonical text is byte-for-byte a document registered for an obligation, the binding is
   `REGISTERED_DOCUMENT` and that obligation is the record. This is the only trusted binding.
3. Otherwise, if the model extracted a reference that is tied to an excerpt of the document and exactly one obligation
   has that reference, the binding is `UNTRUSTED_REFERENCE`. Positive results under this binding are `UNTRUSTED`.
4. Otherwise there is no record and proofs A to H are `UNKNOWN`.

Consequence: **any new or edited document, however small the edit, cannot be eligible.**

### 3a. Registry validity

Before anything else the gate checks the registry structurally and refuses to decide (`HOLD`, rule
`P-R REGISTRY_INVALID`, every requirement reported and none verified) if any of the following is not true:

- Every field has its declared type. `authorities`, `conditions`, `required_documents`, `documents`, `line_items` and
  `registered_documents` are real lists; names, references, currency, kind and funding source are non-empty strings.
- Case IDs, references, document IDs and registered texts (in canonical form) are each unique across the registry.
- A document type appears at most once in an obligation's manifest.
- A registered text is at least 20 characters in canonical form.

So ambiguity is never resolved by order: a text registered under two obligations, two obligations with one
reference, or a document type listed twice all stop the gate. The shipped registry is frozen at load.

The gate never throws. A malformed claims object (anything that is not the `Claims` shape in section 8, including a
missing or non-list `adverse` or `amounts`, or a claim marked `QUOTED` without a quote) is treated as no usable
analysis. Evidence that is not text, or any internal error, is a `HOLD` with rule `P-R …`.

## 4. The proofs

| ID | Requirement | VERIFIED only when |
|---|---|---|
| S | Evidence source | The submitted text is exactly a registered document |
| A | Payee identity | The extracted payee equals the recorded payee, where both are trimmed, inner white space collapsed, trailing `. , ; :` removed and lower-cased. Never a substring. This normalisation applies to proof A only |
| B | Exact obligation amount | See section 5 |
| C | Currency | The record's currency is exactly `USD` and the extracted currency, trimmed, is exactly that |
| D | Payment reference | The extracted reference, trimmed, is exactly the recorded reference (case-sensitive) |
| E | Required documents present | At least one document is required, and every document type listed in the manifest or required by the approval has a manifest entry with status exactly `RECEIVED`. No required documents at all is `UNKNOWN` |
| F | Valid affirmative approval | An approval record exists with status exactly `APPROVED`, an empty conditions list, an authority that is an element of the registry's authorities, a payee and currency byte-identical to the obligation's, an amount equal to the net payable in cents, and all its required documents `RECEIVED` |
| G | Dispute status cleared | The dispute register status is exactly `CLEAR`. No record is `UNKNOWN`, not clearance |
| H | Funding restrictions | Funding source is `SANDBOX_DEMO`. `E3_PROJECT` is `CONTRADICTED` (the synthetic project is funding-blocked) |
| I | Financial policy | Net payable is at most 10.00 USD and sandbox available minus net payable is at least 100.00 USD. An unreadable balance is `UNKNOWN` |
| J | Human review still required | Always: the strongest outcome only permits a human to review |

A claim counts only if it is tied to an exact excerpt of the document that contains the claimed value; otherwise it is
treated as absent (`MISSING`) or, for amounts, as an unsupported figure (`CONTRADICTED`).

## 5. Amounts

All arithmetic is on integers (cents; quantities in thousandths). No floating point.

`net = sum(unit_price x quantity) - retainage + tax - credits`

Proof B is `VERIFIED` only when all of the following hold:

- Each line's unit price times quantity is exact to the cent, and the components add up to the recorded net payable.
  If a retainage percent is recorded, the retainage equals that percent of the subtotal exactly.
- The record kind is `PAYABLE` and the net is greater than zero. A credit memo, a zero or a negative net is never a
  disbursement.
- At least one extracted figure of kind `NET_PAYABLE` or `TOTAL_DUE` exists and equals the net.
- **Every** extracted figure reconciles with its trusted counterpart: `SUBTOTAL`, `UNIT_PRICE`, `QUANTITY`,
  `RETAINAGE`, `TAX`, and `CREDIT` (only when a credit is recorded). A figure of kind `ORIGINAL_CONTRACT`,
  `REVISED_CONTRACT`, `OTHER` or any unknown kind has no trusted counterpart and makes B `CONTRADICTED`. So does a
  figure not supported by an excerpt. The gate never picks one figure and ignores another.

## 6. Decision

1. No usable model analysis: `HOLD`.
2. Any proof `MISSING` or `CONTRADICTED`: `HOLD`.
3. Otherwise, any adverse finding reported by the model: `HOLD`.
4. Otherwise, any proof `UNTRUSTED` or `UNKNOWN`: `REVIEW` (not eligible).
5. Otherwise: `ELIGIBLE_FOR_HUMAN_REVIEW`.

`ELIGIBLE_FOR_HUMAN_REVIEW` is a label. It creates no payment, no approval and no audit event.

Decimal amounts in the registry, in claims and for the balance are strings of the form `-?digits[.digits]` with no
sign prefix other than `-`, no spaces, no separators and no exponent, and with no non-zero digit beyond the second
decimal place. Quantities allow up to three decimal places. Anything else is not a number: in the registry it makes
proof B `CONTRADICTED`, in a claim it fails to reconcile, and as a balance it is `UNKNOWN`.

## 7. What the gate does not do, and the residual risk

The gate does not understand prose, and it does not check that a registered document's text agrees with its own
record. For a registered document, the registry is the sole authority. Consequences that are real and accepted:

- **Contents of a registered document.** Proofs A to D need the model to find the record's values in the text; they
  do not need the model to report everything else in it. If a registered document also contains a different total,
  a different payee, a "do not pay" notice or a dispute, the trusted records say approved, received and clear, and
  the model stays silent, the result is eligible. Adverse findings are a model-dependent control that can only add a
  hold. This risk is bounded by the fact that only documents placed in the registry can be eligible at all.
- **Registry correctness and currency.** The gate checks the registry's structure and uniqueness (section 3a), not
  its truth. There is no staleness check: a dispute cleared long ago, or an approval that has since lapsed, counts
  as current. Approval records carry no date or expiry.
- **HOLD versus REVIEW for an unregistered document** depends on what the model reports. Neither is eligible.
- **The balance** is read once per run.
- **Trusted values and the model.** For a registered document, proof reasons returned to the model by
  `evaluate_payment_eligibility` include recorded values. For an unregistered document they do not, but the proof
  states still reveal whether the claimed values match a record.
- It does not verify the provider, the model, or the human who reviews afterwards.

## 8. Interface for test authors

```ts
import { evaluate } from "apps/web/src/server/agentPolicy.ts";
import type { Claims, Claim, AmountClaim, Adverse, Evaluation } from "apps/web/src/server/agentPolicy.ts";
import { SYNTHETIC_REGISTRY, documentDigest, canonicalDocument, reconcile } from "apps/web/src/server/agentRegistry.ts";
import type { Registry, Obligation } from "apps/web/src/server/agentRegistry.ts";

evaluate(evidence: string, claims: Claims | null, registry: Registry, balanceUsd: string | null): Evaluation
// Evaluation: { decision: "HOLD" | "REVIEW" | "ELIGIBLE_FOR_HUMAN_REVIEW", rule, reason, proofs: Proof[], document, adverse }
// Proof: { id, requirement, claimed, source_type, source_id, evidence, state, trust, conflict, reason }
// Claim: { value, quote, start, end, grounding: "QUOTED" | "QUOTE_NOT_FOUND" | "VALUE_NOT_IN_QUOTE" }
// AmountClaim: Claim & { kind }      Adverse: { kind, summary, quote, grounding }
// Claims: { reference: Claim | null, payee: Claim | null, currency: Claim | null, amounts: AmountClaim[], adverse: Adverse[] }
// Registry: { provenance, authorities: string[], obligations: Obligation[] }
// Obligation: { case_id, reference, payee, currency, kind, funding_source,
//   amount: { line_items: { description, unit_price, quantity }[], retainage, retainage_percent?, tax, credits, net_payable },
//   approval: { approval_id, status, authority, payee, amount, currency, conditions: string[], required_documents: string[] } | null,
//   documents: { type, status }[], dispute: { status, as_of } | null, registered_documents: { document_id, text }[] }
```

A test may build its own `Registry` (for example `structuredClone(SYNTHETIC_REGISTRY)` and edit it, or write one from
scratch) and its own `Claims`. Constructing `Claims` directly models the worst-case model: one that claims whatever
would be needed for eligibility. The full path with a model is `runAgent(evidence, { model, balanceUsd, registry }, id)`
in `apps/web/src/server/agent.ts`, where `model` is a `ModelProvider` and can be scripted.
