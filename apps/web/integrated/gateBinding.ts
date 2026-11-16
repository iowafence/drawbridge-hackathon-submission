// DRAWBRIDGE integrated flow — contract flow-v1 §5. OWNER: A1 (gate binding).
// GatePort: binds one run of the deterministic 11-proof gate to one exact transaction. Server-only, pure,
// deterministic, no I/O, no state. Never throws: evaluateAndBind fails closed to HOLD, revalidate to ok:false.
//
// The gate result is ADVISORY ELIGIBILITY FOR HUMAN REVIEW. It is not an approval, not a payment instruction and
// not authority to pay. This file calls agentPolicy.evaluate and never re-implements it. Its own checks can only
// add HOLDs; they never upgrade a result. It reads no verdict from a caller: `record` passed to revalidate is the
// server-stored record, and even then it is recomputed, not believed.
//
// Single use (one gate authorizes at most once) is enforced by the flow store, keyed on gate_digest. This port
// has no state, so it cannot see consumption; it makes gate_digest unique per flow and evaluation so that the
// store's rule is sufficient.
import { evaluate } from "../src/server/agentPolicy.ts";
import type { Claims, ProofState } from "../src/server/agentPolicy.ts";
import { documentDigest, reconcile, validateRegistry } from "../src/server/agentRegistry.ts";
import { toMinor } from "../src/server/policy.ts";
import { CanonicalError, flowDigest, gateDigest, proposalDigest, proposalProblem } from "./flowCanonical.ts";
import { GATE_POLICY_VERSION, GATE_TTL_MS, PROOF_IDS } from "./flowTypes.ts";
import type { GateBindInput, GateCheck, GatePort, GateRecord, ProofStates } from "./flowTypes.ts";
import { E3_RESERVED_BENEFICIARY_ID, flowBinding } from "./proposalBuilder.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_KEYS = ["flow_id", "proposal_digest", "evidence_source", "evidence_digest", "document_id", "document_binding", "registry_digest", "claims_digest", "policy_version", "decision", "rule", "gate_refused", "proof_states", "balance_minor", "evaluated_at_ms", "expires_at_ms", "gate_digest"];
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const timeOk = (t: unknown): t is number => typeof t === "number" && Number.isSafeInteger(t) && t > 0;
const unknownStates = (): ProofStates => Object.fromEntries(PROOF_IDS.map((id) => [id, "UNKNOWN"])) as ProofStates;

function seal(body: Omit<GateRecord, "gate_digest">): GateRecord {
  return Object.freeze({ ...body, proof_states: Object.freeze({ ...body.proof_states }), gate_digest: gateDigest(body) });
}

/** A HOLD record built only from values that are safe to encode. Used when binding itself cannot complete. */
function failClosed(input: GateBindInput | null | undefined, code: string): GateRecord {
  const at = timeOk(input?.now_ms) ? input.now_ms : 0;
  return seal({
    flow_id: typeof input?.flow_id === "string" && UUID4.test(input.flow_id) ? input.flow_id : "",
    proposal_digest: "",
    evidence_source: input?.evidence_source === "FIXTURE_REPLAY" ? "FIXTURE_REPLAY" : "AGENT_RUN",
    evidence_digest: "",
    document_id: null,
    document_binding: "NONE",
    registry_digest: "",
    claims_digest: null,
    policy_version: GATE_POLICY_VERSION,
    decision: "HOLD",
    rule: `P-BIND ${code}`,
    gate_refused: true,
    proof_states: unknownStates(),
    balance_minor: null,
    evaluated_at_ms: at,
    expires_at_ms: at === 0 ? 0 : at + GATE_TTL_MS,
  });
}

function bind(input: GateBindInput): GateRecord {
  if (!plain(input)) return failClosed(null, "INPUT_NOT_OBJECT");
  if (!timeOk(input.now_ms)) return failClosed(input, "CLOCK_INVALID");
  if (input.evidence_source !== "AGENT_RUN" && input.evidence_source !== "FIXTURE_REPLAY") return failClosed(input, "EVIDENCE_SOURCE_INVALID");
  if (typeof input.evidence_text !== "string") return failClosed(input, "EVIDENCE_NOT_TEXT");

  // Problems found here force HOLD. The first one names the rule.
  let forced: string | null = null;
  const force = (code: string) => { forced ??= code; };

  const proposal = input.proposal;
  const problem = plain(proposal) ? proposalProblem(proposal) : "PROPOSAL_SHAPE";
  if (problem) return failClosed(input, problem);
  let pDigest = "";
  try {
    pDigest = proposalDigest(proposal);
  } catch (e) {
    return failClosed(input, e instanceof CanonicalError ? e.code : "PROPOSAL_UNDIGESTABLE");
  }
  if (input.proposal_digest !== pDigest) force("PROPOSAL_DIGEST_MISMATCH");
  if (input.flow_id !== proposal.flow_id) force("FLOW_ID_MISMATCH");

  let registryDigest = "";
  try {
    registryDigest = flowDigest("registry", input.registry);
  } catch (e) {
    force(e instanceof CanonicalError ? `REGISTRY_${e.code}` : "REGISTRY_UNDIGESTABLE");
  }

  // Untrusted model output. If it cannot be digested it is treated as "no usable analysis", which the gate holds.
  let claims: Claims | null = input.claims ?? null;
  let claimsDigest: string | null = null;
  if (claims !== null) {
    try {
      claimsDigest = flowDigest("claims", claims);
    } catch (e) {
      force(e instanceof CanonicalError ? `CLAIMS_${e.code}` : "CLAIMS_UNDIGESTABLE");
      claims = null;
    }
  }

  let balanceMinor: string | null = null;
  const balance = typeof input.balance_usd === "string" ? input.balance_usd : null;
  if (balance !== null) {
    try {
      balanceMinor = toMinor(balance).toString();
    } catch {
      balanceMinor = null; // the gate reports proof I UNKNOWN for an unusable balance
    }
  }

  // The gate. Called exactly once.
  const e = evaluate(input.evidence_text, claims, input.registry, balanceMinor === null ? null : balance);

  // Transaction binding: the proposal must be the payment of the obligation the registered document evidences.
  if (e.document.binding !== "REGISTERED_DOCUMENT") force("DOCUMENT_NOT_REGISTERED");
  else if (e.document.case_id !== proposal.obligation_id) force("OBLIGATION_MISMATCH");
  else {
    const obligation = validateRegistry(input.registry) === null ? input.registry.obligations.find((o) => o.case_id === proposal.obligation_id) : undefined;
    if (!obligation) force("OBLIGATION_NOT_IN_REGISTRY");
    else {
      const rec = reconcile(obligation);
      if (obligation.reference !== proposal.reference) force("REFERENCE_MISMATCH");
      else if (obligation.payee !== proposal.payee) force("PAYEE_MISMATCH");
      else if (obligation.currency !== proposal.currency) force("CURRENCY_MISMATCH");
      else if (!rec.ok || rec.net.toString() !== proposal.amount_minor) force("AMOUNT_MISMATCH");
    }
  }

  // Beneficiary binding (A8-01): the proposal's beneficiary must be the one the binding fixture assigns to this
  // exact obligation. The label must equal the bound label; an E3 case must carry the reserved (non-provider) id
  // and no other case may. Whether the id is the allowlist's unique entry for that label cannot be seen from here
  // (this port is given no allowlist); the flow enforces that half by requiring the stored proposal to equal a
  // fresh buildProposal, which resolves through resolveBeneficiary.
  const bound = flowBinding(proposal.obligation_id);
  if (!bound) force("BINDING_MISSING");
  else if (proposal.beneficiary_label !== bound.beneficiary_label) force("BENEFICIARY_MISMATCH");
  else if (bound.e3_no_provider_beneficiary !== (proposal.beneficiary_id === E3_RESERVED_BENEFICIARY_ID)) force("BENEFICIARY_MISMATCH");

  const proof_states = Object.fromEntries(PROOF_IDS.map((id) => [id, e.proofs.find((p) => p.id === id)?.state ?? "UNKNOWN"])) as Record<(typeof PROOF_IDS)[number], ProofState>;
  const gateRefused = e.proofs.some((p) => p.id === "R");
  let decision = e.decision;
  let rule = e.rule;
  // An eligible decision must also be eligible on its face; anything else is held.
  if (decision === "ELIGIBLE_FOR_HUMAN_REVIEW" && (gateRefused || !PROOF_IDS.every((id) => proof_states[id] === "VERIFIED"))) force("PROOFS_INCOMPLETE");
  if (forced !== null) {
    if (decision !== "HOLD") rule = `P-BIND ${forced}`; // a gate HOLD keeps the gate's own, more specific rule
    decision = "HOLD";
  }

  return seal({
    flow_id: proposal.flow_id,
    proposal_digest: pDigest,
    evidence_source: input.evidence_source,
    evidence_digest: e.document.digest || documentDigest(input.evidence_text),
    document_id: e.document.document_id,
    document_binding: e.document.binding,
    registry_digest: registryDigest,
    claims_digest: claimsDigest,
    policy_version: GATE_POLICY_VERSION,
    decision,
    rule,
    gate_refused: gateRefused,
    proof_states,
    balance_minor: balanceMinor,
    evaluated_at_ms: input.now_ms,
    expires_at_ms: input.now_ms + GATE_TTL_MS,
  });
}

function evaluateAndBind(input: GateBindInput): GateRecord {
  try {
    return bind(input);
  } catch {
    try {
      return failClosed(input, "GATE_BINDING_ERROR_FAILED_CLOSED");
    } catch {
      return failClosed(null, "GATE_BINDING_ERROR_FAILED_CLOSED");
    }
  }
}

function revalidate(record: GateRecord, input: GateBindInput, phase: "review" | "approve" | "submit"): GateCheck {
  const no = (code: string): GateCheck => ({ ok: false, code });
  try {
    if (phase !== "review" && phase !== "approve" && phase !== "submit") return no("GATE_PHASE_INVALID");
    if (!plain(input) || !timeOk(input.now_ms)) return no("GATE_INPUT_INVALID");

    // 1. The stored record must be exactly a gate record and hash to its own digest.
    if (!plain(record) || Object.keys(record).sort().join(",") !== [...RECORD_KEYS].sort().join(",")) return no("GATE_RECORD_TAMPERED");
    const { gate_digest: stored, ...body } = record;
    let recomputed: string;
    try {
      recomputed = gateDigest(body);
    } catch {
      return no("GATE_RECORD_TAMPERED");
    }
    if (typeof stored !== "string" || !HEX64.test(stored) || recomputed !== stored) return no("GATE_RECORD_TAMPERED");
    if (!timeOk(record.evaluated_at_ms) || record.expires_at_ms !== record.evaluated_at_ms + GATE_TTL_MS) return no("GATE_RECORD_TAMPERED");

    // 2. Policy identity, then the recorded decision. Only an eligible record can ever pass.
    if (record.policy_version !== GATE_POLICY_VERSION) return no("POLICY_VERSION_CHANGED");
    if (record.decision !== "ELIGIBLE_FOR_HUMAN_REVIEW" || record.gate_refused !== false || record.document_binding !== "REGISTERED_DOCUMENT"
      || !plain(record.proof_states) || !PROOF_IDS.every((id) => record.proof_states[id] === "VERIFIED")) return no("GATE_NOT_ELIGIBLE");

    // 3. Lifetime. At submit the authorization lifetime governs instead (flow-v1 §5), but a clock that runs
    //    before the evaluation is never accepted.
    if (input.now_ms < record.evaluated_at_ms) return no("GATE_EXPIRED");
    if (phase !== "submit" && input.now_ms >= record.expires_at_ms) return no("GATE_EXPIRED");

    // 4. The exact transaction.
    if (!plain(input.proposal) || proposalProblem(input.proposal) !== null) return no("PROPOSAL_CHANGED");
    const pDigest = proposalDigest(input.proposal);
    if (pDigest !== record.proposal_digest || input.proposal_digest !== record.proposal_digest) return no("PROPOSAL_CHANGED");
    if (input.flow_id !== record.flow_id || input.proposal.flow_id !== record.flow_id) return no("PROPOSAL_CHANGED");

    // 5. The server-held evidence: text, source label and the claims that were evaluated.
    if (typeof input.evidence_text !== "string" || documentDigest(input.evidence_text) !== record.evidence_digest) return no("EVIDENCE_CHANGED");
    if (input.evidence_source !== record.evidence_source) return no("EVIDENCE_CHANGED");
    let claimsDigest: string | null = null;
    try {
      claimsDigest = input.claims === null || input.claims === undefined ? null : flowDigest("claims", input.claims);
    } catch {
      return no("EVIDENCE_CHANGED");
    }
    if (claimsDigest !== record.claims_digest) return no("EVIDENCE_CHANGED");

    // 6. The registry version.
    let registryDigest: string;
    try {
      registryDigest = flowDigest("registry", input.registry);
    } catch {
      return no("REGISTRY_DRIFT");
    }
    if (!HEX64.test(record.registry_digest) || registryDigest !== record.registry_digest) return no("REGISTRY_DRIFT");

    // 7. Run the gate again, now, with the freshly read balance. It must reach the same eligible binding.
    const fresh = evaluateAndBind(input);
    const same = fresh.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" && fresh.rule === record.rule && fresh.gate_refused === false
      && fresh.document_id === record.document_id && fresh.document_binding === record.document_binding
      && fresh.proposal_digest === record.proposal_digest && fresh.evidence_digest === record.evidence_digest
      && fresh.registry_digest === record.registry_digest && fresh.claims_digest === record.claims_digest
      && PROOF_IDS.every((id) => fresh.proof_states[id] === "VERIFIED" && fresh.proof_states[id] === record.proof_states[id]);
    if (!same) return no("GATE_REEVALUATION_MISMATCH");
    return { ok: true };
  } catch {
    return no("GATE_REVALIDATION_FAILED_CLOSED");
  }
}

/** The A1 port. Stateless and frozen. */
export const gatePort: GatePort = Object.freeze({ evaluateAndBind, revalidate });
