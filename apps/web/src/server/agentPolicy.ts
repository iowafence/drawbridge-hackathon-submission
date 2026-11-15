// Positive-proof eligibility gate for the evidence agent. Server-only, pure and deterministic.
//
// Design rule: UNTRUSTED inputs can only block. The evidence text and everything a model says about it are untrusted.
// They are never the reason a requirement is satisfied. A requirement is VERIFIED only when a TRUSTED source (the
// read-only registry, a provider read, or a fixed policy constant) establishes it by exact comparison. This file
// contains no natural-language pattern: it does not look for words such as "approved" or "disputed" anywhere.
//
// Eligibility needs every proof A-J and S to be VERIFIED. In particular S requires the submitted text to be exactly a
// source document registered for the obligation, so a new or edited document can never be eligible on its own.
import { findByReference, findRegisteredDocument, documentDigest, key, quantityThousandths, reconcile, validateRegistry } from "./agentRegistry.ts";
import type { Obligation, Registry } from "./agentRegistry.ts";
import { DEMO_CAP_MINOR, fromMinor, PROPOSAL, toMinor } from "./policy.ts";

export type ProofState = "VERIFIED" | "MISSING" | "CONTRADICTED" | "UNTRUSTED" | "UNKNOWN";
export type Proof = {
  id: string;
  requirement: string;
  /** What the untrusted side (document as read by the model) claims, if anything. */
  claimed: string | null;
  source_type: "TRUSTED_REGISTRY" | "PROVIDER_READ" | "STATIC_POLICY" | "NONE";
  source_id: string | null;
  /** The trusted field or value the proof rests on. */
  evidence: string | null;
  state: ProofState;
  trust: "TRUSTED" | "UNTRUSTED";
  conflict: "NONE" | "CONFLICT";
  reason: string;
};

/** A fact the model extracted, already checked against the document text by the controller. */
export type Claim = { value: string; quote: string | null; start: number | null; end: number | null; grounding: "QUOTED" | "QUOTE_NOT_FOUND" | "VALUE_NOT_IN_QUOTE" };
export type AmountClaim = Claim & { kind: string };
export type Adverse = { kind: string; summary: string; quote: string | null; grounding: Claim["grounding"] };
export type Claims = { reference: Claim | null; payee: Claim | null; currency: Claim | null; amounts: AmountClaim[]; adverse: Adverse[] };

export type Decision = "HOLD" | "REVIEW" | "ELIGIBLE_FOR_HUMAN_REVIEW";
export type Evaluation = {
  decision: Decision;
  rule: string;
  reason: string;
  proofs: Proof[];
  document: { digest: string; document_id: string | null; case_id: string | null; binding: "REGISTERED_DOCUMENT" | "UNTRUSTED_REFERENCE" | "NONE" };
  adverse: Adverse[];
};

const AMOUNT_KINDS = ["NET_PAYABLE", "TOTAL_DUE", "SUBTOTAL", "UNIT_PRICE", "QUANTITY", "RETAINAGE", "TAX", "CREDIT", "ORIGINAL_CONTRACT", "REVISED_CONTRACT", "OTHER"] as const;
export const isAmountKind = (k: string) => (AMOUNT_KINDS as readonly string[]).includes(k);

const quoted = (c: Claim | null): c is Claim => !!c && c.grounding === "QUOTED";

const GROUNDINGS = ["QUOTED", "QUOTE_NOT_FOUND", "VALUE_NOT_IN_QUOTE"];
const claimOk = (c: unknown): boolean => c === null || (!!c && typeof c === "object" && typeof (c as Claim).value === "string" && GROUNDINGS.includes((c as Claim).grounding) && ((c as Claim).grounding !== "QUOTED" || typeof (c as Claim).quote === "string"));
/** Structural check of the untrusted claims object. Anything else is "no usable analysis". */
export function claimsUsable(c: unknown): c is Claims {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const x = c as Claims;
  return claimOk(x.reference) && claimOk(x.payee) && claimOk(x.currency) && x.reference !== undefined && x.payee !== undefined && x.currency !== undefined
    && Array.isArray(x.amounts) && x.amounts.every((a) => !!a && claimOk(a) && typeof a.kind === "string")
    && Array.isArray(x.adverse) && x.adverse.every((a) => !!a && typeof a === "object" && typeof a.kind === "string" && typeof a.summary === "string");
}

const REQUIREMENTS: [string, string][] = [["S", "Evidence source is a registered document"], ["A", "Payee identity"], ["B", "Exact obligation amount"], ["C", "Currency"], ["D", "Payment reference"], ["E", "Required documents present"], ["F", "Valid affirmative approval"], ["G", "Dispute status cleared"], ["H", "Funding restrictions satisfied"], ["I", "Financial policy satisfied"]];
/** A refusal to decide. Every requirement is reported, and none is verified. */
const refusal = (rule: string, reason: string, digest: string): Evaluation => {
  const blank = { claimed: null, source_type: "NONE" as const, source_id: null, evidence: null, trust: "UNTRUSTED" as const };
  return {
    decision: "HOLD", rule, reason,
    proofs: [
      { id: "R", requirement: "Gate inputs are usable", ...blank, state: "CONTRADICTED", conflict: "CONFLICT", reason },
      ...REQUIREMENTS.map(([id, requirement]) => ({ id, requirement, ...blank, state: "UNKNOWN" as const, conflict: "NONE" as const, reason: "Not evaluated: the gate refused to decide." })),
    ],
    document: { digest, document_id: null, case_id: null, binding: "NONE" }, adverse: [],
  };
};

/** The gate. Never throws: any malformed input, invalid registry or internal error is a HOLD. */
export function evaluate(evidence: string, claims: Claims | null, registry: Registry, balanceUsd: string | null): Evaluation {
  try {
    if (typeof evidence !== "string") return refusal("P-R EVIDENCE_NOT_TEXT", "The evidence is not text.", "");
    const invalid = validateRegistry(registry);
    if (invalid) return refusal("P-R REGISTRY_INVALID", `The trusted registry is not well formed (${invalid}). The gate does not decide on an invalid or ambiguous registry.`, documentDigest(evidence));
    if (claims !== null && !claimsUsable(claims)) return decide(evidence, null, registry, null);
    return decide(evidence, claims, registry, typeof balanceUsd === "string" ? balanceUsd : null);
  } catch {
    return refusal("P-R GATE_ERROR_FAILED_CLOSED", "The gate could not complete and failed closed.", "");
  }
}

function decide(evidence: string, claims: Claims | null, registry: Registry, balanceUsd: string | null): Evaluation {
  const digest = documentDigest(evidence);
  const registered = findRegisteredDocument(registry, evidence);
  let record: Obligation | null = registered?.obligation ?? null;
  let binding: Evaluation["document"]["binding"] = registered ? "REGISTERED_DOCUMENT" : "NONE";
  if (!record && claims && quoted(claims.reference)) {
    record = findByReference(registry, claims.reference.value);
    if (record) binding = "UNTRUSTED_REFERENCE"; // the lookup key came from the untrusted document
  }
  const trusted = binding === "REGISTERED_DOCUMENT";
  const src = record ? `registry:${record.case_id}` : null;
  const proofs: Proof[] = [];
  const add = (id: string, requirement: string, state: ProofState, reason: string, extra: Partial<Proof> = {}) =>
    proofs.push({ id, requirement, claimed: null, source_type: record ? "TRUSTED_REGISTRY" : "NONE", source_id: src, evidence: null, trust: state === "VERIFIED" ? "TRUSTED" : "UNTRUSTED", conflict: state === "CONTRADICTED" ? "CONFLICT" : "NONE", state, reason, ...extra });
  /** A positive result reached through an untrusted lookup key is downgraded: it is not proof. */
  const pos = (): ProofState => (trusted ? "VERIFIED" : "UNTRUSTED");
  const via = trusted ? "" : " The record was found only through a reference read from an unregistered document, so this is not proof.";

  // S. evidence source
  add("S", "Evidence source is a registered document", registered ? "VERIFIED" : "UNTRUSTED",
    registered ? `The submitted text is exactly registered document ${registered.document_id}.` : "The submitted text is not a document registered in the trusted intake manifest. New or edited evidence cannot establish eligibility.",
    { source_type: registered ? "TRUSTED_REGISTRY" : "NONE", source_id: registered ? `registry:${registered.obligation.case_id}` : null, evidence: registered ? `registered_documents.${registered.document_id} sha256 ${digest.slice(0, 16)}…` : null, claimed: `sha256 ${digest.slice(0, 16)}…` });

  const noRecord = (id: string, requirement: string, claimed: string | null) => add(id, requirement, "UNKNOWN", "No trusted record was found for this evidence.", { claimed });
  /** `same` decides equality: proof A uses the stated normalisation; references and currency are compared exactly. */
  const compare = (id: string, requirement: string, claim: Claim | null, recorded: string, field: string, same: (a: string, b: string) => boolean) => {
    if (!claim) return add(id, requirement, "MISSING", "The model extracted no value for this from the document.", { evidence: `${field} = ${recorded}` });
    if (claim.grounding !== "QUOTED") return add(id, requirement, "MISSING", "The extracted value is not supported by an excerpt of the document, so it was rejected.", { claimed: claim.value, evidence: `${field} = ${recorded}` });
    // under an untrusted binding the recorded value is not disclosed in the reason, which is returned to the model
    if (!same(claim.value, recorded)) return add(id, requirement, "CONTRADICTED", trusted ? `The document says "${claim.value}" but the trusted record says "${recorded}".` : `The document says "${claim.value}", which does not match the trusted record.`, { claimed: claim.value, evidence: `${field} = ${recorded}` });
    return add(id, requirement, pos(), `Matches the trusted record exactly.${via}`, { claimed: claim.value, evidence: `${field} = ${recorded}` });
  };

  const rec = record ? reconcile(record) : null;

  // A. payee
  if (!record) noRecord("A", "Payee identity", claims?.payee?.value ?? null);
  else compare("A", "Payee identity", claims?.payee ?? null, record.payee, "payee", (a, b) => key(a) === key(b));

  // B. exact obligation amount
  if (!record) noRecord("B", "Exact obligation amount", claims?.amounts.map((a) => `${a.kind} ${a.value}`).join(", ") || null);
  else {
    const claimedText = claims?.amounts.map((a) => `${a.kind} ${a.value}`).join(", ") || null;
    const ev = `amount.net_payable = ${record.amount.net_payable}`;
    if (!rec || !rec.ok) add("B", "Exact obligation amount", "CONTRADICTED", `The recorded amounts do not reconcile: ${rec && !rec.ok ? rec.reason : "unknown"}.`, { claimed: claimedText, evidence: ev });
    else if (record.kind !== "PAYABLE" || rec.net <= 0n) add("B", "Exact obligation amount", "CONTRADICTED", `The record is a ${record.kind} with net ${fromMinor(rec.net)}. It is not a disbursement.`, { claimed: claimedText, evidence: ev });
    else {
      const amounts = claims?.amounts ?? [];
      const problems: string[] = [];
      let netClaims = 0;
      for (const a of amounts) {
        if (a.grounding !== "QUOTED") { problems.push(`${a.kind} ${a.value} is not supported by an excerpt of the document`); continue; }
        let ok = false;
        try {
          if (a.kind === "QUANTITY") ok = rec.quantities.includes(quantityThousandths(a.value));
          else {
            const m = toMinor(a.value);
            if (a.kind === "NET_PAYABLE" || a.kind === "TOTAL_DUE") { ok = m === rec.net; netClaims++; }
            else if (a.kind === "SUBTOTAL") ok = m === rec.subtotal;
            else if (a.kind === "UNIT_PRICE") ok = rec.unitPrices.includes(m);
            else if (a.kind === "RETAINAGE") ok = m === rec.retainage;
            else if (a.kind === "TAX") ok = m === rec.tax;
            else if (a.kind === "CREDIT") ok = rec.credits > 0n && m === rec.credits;
            else ok = false; // contract values and "other" figures have no trusted counterpart to reconcile against
          }
        } catch {
          ok = false;
        }
        if (!ok) problems.push(`${a.kind} ${a.value} does not reconcile with the trusted record`);
      }
      if (problems.length) add("B", "Exact obligation amount", "CONTRADICTED", `${problems.join("; ")}.`, { claimed: claimedText, evidence: ev });
      else if (netClaims === 0) add("B", "Exact obligation amount", "MISSING", "The model extracted no net payable or total due amount from the document.", { claimed: claimedText, evidence: ev });
      else add("B", "Exact obligation amount", pos(), `Every figure read from the document reconciles with the record; net payable ${fromMinor(rec.net)} recomputed from its components.${via}`, { claimed: claimedText, evidence: ev });
    }
  }

  // C. currency, D. reference
  if (!record) { noRecord("C", "Currency", claims?.currency?.value ?? null); noRecord("D", "Payment reference", claims?.reference?.value ?? null); }
  else {
    const exact = (a: string, b: string) => a.trim() === b.trim();
    if (record.currency !== "USD") add("C", "Currency", "CONTRADICTED", `The recorded currency is ${record.currency}; only USD is permitted.`, { claimed: claims?.currency?.value ?? null, evidence: `currency = ${record.currency}` });
    else compare("C", "Currency", claims?.currency ?? null, record.currency, "currency", exact);
    compare("D", "Payment reference", claims?.reference ?? null, record.reference, "reference", exact);
  }

  // E. required documents present, from the trusted manifest only
  if (!record) noRecord("E", "Required documents present", null);
  else {
    const required = [...new Set([...(record.approval?.required_documents ?? []), ...record.documents.map((d) => d.type)])];
    const received = (t: string) => { const entries = record!.documents.filter((d) => d.type === t); return entries.length > 0 && entries.every((d) => d.status === "RECEIVED"); };
    const notReceived = required.filter((t) => !received(t));
    const ev = `documents = ${record.documents.map((d) => `${d.type}:${d.status}`).join(", ") || "none"}`;
    if (required.length === 0) add("E", "Required documents present", "UNKNOWN", "The record lists no required documents, so completeness cannot be established.", { evidence: ev });
    else if (notReceived.length) add("E", "Required documents present", "MISSING", `Not received according to the manifest: ${notReceived.join(", ")}.`, { evidence: ev });
    else add("E", "Required documents present", pos(), `All ${required.length} required documents are recorded as received.${via}`, { evidence: ev });
  }

  // F. valid affirmative approval, bound to this exact obligation
  if (!record) noRecord("F", "Valid affirmative approval", null);
  else {
    const ap = record.approval;
    const ev = ap ? `approval ${ap.approval_id}: status ${ap.status}, authority ${ap.authority}, payee ${ap.payee}, amount ${ap.amount} ${ap.currency}, conditions ${ap.conditions.length}` : "approval = none";
    let amountOk = false;
    try {
      amountOk = !!ap && !!rec && rec.ok && toMinor(ap.amount) === rec.net;
    } catch {
      amountOk = false;
    }
    if (!ap) add("F", "Valid affirmative approval", "MISSING", "No approval record exists for this obligation.", { evidence: ev });
    else if (ap.status === "DENIED" || ap.status === "REVOKED") add("F", "Valid affirmative approval", "CONTRADICTED", `The approval record status is ${ap.status}.`, { evidence: ev });
    else if (ap.status !== "APPROVED") add("F", "Valid affirmative approval", "MISSING", `The approval record status is ${ap.status}, not APPROVED.`, { evidence: ev });
    else if (ap.conditions.length !== 0) add("F", "Valid affirmative approval", "MISSING", `The approval is conditional (${ap.conditions.join(", ")}). A conditional approval is not an approval.`, { evidence: ev });
    else if (!registry.authorities.includes(ap.authority)) add("F", "Valid affirmative approval", "CONTRADICTED", `Approving authority ${ap.authority} is not a recognised authority.`, { evidence: ev });
    else if (ap.payee !== record.payee) add("F", "Valid affirmative approval", "CONTRADICTED", `The approval is for payee "${ap.payee}", not "${record.payee}".`, { evidence: ev });
    else if (!amountOk || ap.currency !== record.currency) add("F", "Valid affirmative approval", "CONTRADICTED", `The approval is for ${ap.amount} ${ap.currency}, which is not the net payable ${record.amount.net_payable} ${record.currency}.`, { evidence: ev });
    else if (ap.required_documents.some((t) => { const entries = record!.documents.filter((d) => d.type === t); return entries.length === 0 || entries.some((d) => d.status !== "RECEIVED"); })) add("F", "Valid affirmative approval", "MISSING", "The approval requires documents that the manifest does not record as received.", { evidence: ev });
    else add("F", "Valid affirmative approval", pos(), `Approval ${ap.approval_id} by ${ap.authority} is unconditional and matches the payee, amount and currency exactly.${via}`, { evidence: ev });
  }

  // G. dispute clearance from the trusted register (absence of a dispute is not clearance)
  if (!record) noRecord("G", "Dispute status cleared", null);
  else if (!record.dispute) add("G", "Dispute status cleared", "UNKNOWN", "No dispute status is recorded. Absence of a record is not clearance.", { evidence: "dispute = none" });
  else if (record.dispute.status !== "CLEAR") add("G", "Dispute status cleared", "CONTRADICTED", `The dispute register shows ${record.dispute.status} as of ${record.dispute.as_of}.`, { evidence: `dispute.status = ${record.dispute.status}` });
  else add("G", "Dispute status cleared", pos(), `The dispute register shows CLEAR as of ${record.dispute.as_of}.${via}`, { evidence: `dispute.status = CLEAR (${record.dispute.as_of})` });

  // H. funding restrictions
  if (!record) noRecord("H", "Funding restrictions satisfied", null);
  else if (record.funding_source === "SANDBOX_DEMO") add("H", "Funding restrictions satisfied", pos(), `Funding source is the sandbox demonstration account.${via}`, { evidence: "funding_source = SANDBOX_DEMO" });
  else if (record.funding_source === "E3_PROJECT") add("H", "Funding restrictions satisfied", "CONTRADICTED", "The obligation belongs to the synthetic E3 project, which is funding-blocked (ready to send 0.00). A sandbox balance does not lift a project restriction.", { evidence: "funding_source = E3_PROJECT" });
  else add("H", "Funding restrictions satisfied", "UNKNOWN", `Funding source ${record.funding_source} is not recognised.`, { evidence: `funding_source = ${record.funding_source}` });

  // I. financial policy on trusted numbers only: the recorded net payable and the provider-read balance
  if (!record || !rec || !rec.ok) add("I", "Financial policy satisfied", "UNKNOWN", "No reconciled trusted amount is available to test against the policy.", { source_type: "STATIC_POLICY", source_id: "policy:demo-cap-and-reserve" });
  else {
    const reserve = toMinor(PROPOSAL.reserve_threshold);
    let available: bigint | null = null;
    try {
      available = balanceUsd === null ? null : toMinor(balanceUsd);
    } catch {
      available = null;
    }
    const ev = `cap ${fromMinor(DEMO_CAP_MINOR)}, reserve ${fromMinor(reserve)}, sandbox available ${available === null ? "unavailable" : fromMinor(available)}`;
    const base = { source_type: "PROVIDER_READ" as const, source_id: "airwallex-sandbox:balances/current", evidence: ev, claimed: null };
    if (rec.net > DEMO_CAP_MINOR) add("I", "Financial policy satisfied", "CONTRADICTED", `Net payable ${fromMinor(rec.net)} exceeds the demo cap ${fromMinor(DEMO_CAP_MINOR)} USD.`, base);
    else if (available === null) add("I", "Financial policy satisfied", "UNKNOWN", "The sandbox balance could not be read, so the reserve test cannot be done.", base);
    else if (available - rec.net < reserve) add("I", "Financial policy satisfied", "CONTRADICTED", `Sandbox available ${fromMinor(available)} minus ${fromMinor(rec.net)} is below the reserve ${fromMinor(reserve)} USD.`, base);
    else add("I", "Financial policy satisfied", pos(), `Within the demo cap, and the sandbox reserve holds after ${fromMinor(rec.net)} USD.${via}`, base);
  }

  // J. the outcome of this gate is never an authorization
  add("J", "Human review still required", "VERIFIED", "Enforced by design: the strongest outcome of this gate is eligibility for a human to review. It creates no payment and no approval.", { source_type: "STATIC_POLICY", source_id: "policy:no-authority", trust: "TRUSTED" });

  const adverse = claims?.adverse ?? [];
  const doc = { digest, document_id: registered?.document_id ?? null, case_id: record?.case_id ?? null, binding };
  if (!claims) return { decision: "HOLD", rule: "P-0 AGENT_FAILED_CLOSED", reason: "The model produced no usable analysis, so nothing is eligible.", proofs, document: doc, adverse };
  const hard = proofs.filter((p) => p.state === "MISSING" || p.state === "CONTRADICTED");
  if (hard.length) return { decision: "HOLD", rule: `P-${hard[0].id} ${hard[0].state}`, reason: hard.map((p) => `${p.id} ${p.requirement}: ${p.reason}`).join(" "), proofs, document: doc, adverse };
  if (adverse.length) return { decision: "HOLD", rule: "P-X ADVERSE_CONTENT_REPORTED", reason: `The model reported content in the evidence that conflicts with eligibility: ${adverse.map((a) => `${a.kind} (${a.summary})`).join("; ")}. A report like this can only block; it is never needed for a hold that the trusted records already require.`, proofs, document: doc, adverse };
  const soft = proofs.filter((p) => p.state !== "VERIFIED");
  if (soft.length) return { decision: "REVIEW", rule: `P-${soft[0].id} ${soft[0].state}`, reason: `Not eligible. ${soft.map((p) => `${p.id} ${p.requirement}: ${p.reason}`).join(" ")}`, proofs, document: doc, adverse };
  return { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", reason: `Every requirement is verified from trusted records for ${record!.case_id}: ${fromMinor((rec as { net: bigint }).net)} ${record!.currency} to ${record!.payee}. A human must still review and approve. No payment was created.`, proofs, document: doc, adverse };
}
