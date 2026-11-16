// DRAWBRIDGE integrated flow — contract flow-v1 §5. OWNER: A1 (gate binding).
// Integrated registry, server-side proposal construction and fixture replay. Server-only, pure, no I/O after load.
//
// The client supplies only a case id. Every field of the proposal is derived here from the trusted registry
// obligation, the binding fixture and the server's beneficiary allowlist. Nothing in this file is authority to pay.
import registryDoc from "../fixtures/integrated/agent_registry_integrated_v1.json" with { type: "json" };
import bindingsDoc from "../fixtures/integrated/flow_bindings_v1.json" with { type: "json" };
import replayDoc from "../fixtures/integrated/replay_facts_v1.json" with { type: "json" };
import { reconcile, validateRegistry } from "../src/server/agentRegistry.ts";
import type { Registry } from "../src/server/agentRegistry.ts";
import { flowDigest, proposalProblem } from "./flowCanonical.ts";
import type { FlowProposal } from "./flowTypes.ts";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

/** The integrated registry: every v1 obligation unchanged, plus CASE-SBX-0002 and the three E3 cases. Deep-frozen. */
export const INTEGRATED_REGISTRY: Registry = deepFreeze(structuredClone(registryDoc) as unknown as Registry);
const REGISTRY_PROBLEM: string | null = validateRegistry(INTEGRATED_REGISTRY);
/** flowDigest("registry", <parsed integrated registry JSON>). Empty when the fixture cannot be digested (then
 *  nothing can be built or bound). */
export const INTEGRATED_REGISTRY_DIGEST: string = (() => {
  try {
    return flowDigest("registry", INTEGRATED_REGISTRY);
  } catch {
    return "";
  }
})();

/** Reserved beneficiary for E3 cases. It is not a provider beneficiary and must never appear in any allowlist, so
 *  an E3 flow can never pass the allowlist check that precedes human review. */
export const E3_RESERVED_BENEFICIARY_ID = "00000000-0000-4000-8000-0000000e3000";

export type FlowBinding = { beneficiary_label: string; reason: string; ledger_allocation_key: string | null; e3_no_provider_beneficiary: boolean };
const BINDINGS = deepFreeze(structuredClone(bindingsDoc) as unknown as Record<string, FlowBinding>);
const REPLAY = deepFreeze(structuredClone(replayDoc) as unknown as Record<string, unknown>);

function bindingOk(b: unknown): b is FlowBinding {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const x = b as FlowBinding;
  return Object.keys(x).sort().join(",") === "beneficiary_label,e3_no_provider_beneficiary,ledger_allocation_key,reason"
    && typeof x.beneficiary_label === "string" && typeof x.reason === "string" && typeof x.e3_no_provider_beneficiary === "boolean"
    && (x.ledger_allocation_key === null || typeof x.ledger_allocation_key === "string");
}

/** The binding fixture entry for a case, or null. Read-only. */
export function flowBinding(caseId: string): FlowBinding | null {
  return typeof caseId === "string" && Object.hasOwn(BINDINGS, caseId) && bindingOk(BINDINGS[caseId]) ? BINDINGS[caseId] : null;
}

/** The one rule that maps a registry case to its beneficiary: the binding fixture names a label; the beneficiary
 *  is the UNIQUE allowlist entry with exactly that label (zero or several matches is a refusal); an E3 case maps
 *  to the reserved id, which no allowlist may contain. Pure; never throws. buildProposal uses this and nothing
 *  else, so a caller comparing a stored proposal against this result is comparing against the same rule. */
export function resolveBeneficiary(caseId: string, allowlist: Map<string, string>): { ok: true; beneficiary_id: string; beneficiary_label: string } | { ok: false; code: string } {
  try {
    if (REGISTRY_PROBLEM !== null || !/^[0-9a-f]{64}$/.test(INTEGRATED_REGISTRY_DIGEST)) return { ok: false, code: "INTEGRATED_REGISTRY_INVALID" };
    if (typeof caseId !== "string") return { ok: false, code: "PROPOSAL_INPUT_INVALID" };
    if (!(allowlist instanceof Map)) return { ok: false, code: "ALLOWLIST_INVALID" };
    for (const [id, label] of allowlist) if (typeof id !== "string" || typeof label !== "string") return { ok: false, code: "ALLOWLIST_INVALID" };
    if (allowlist.has(E3_RESERVED_BENEFICIARY_ID)) return { ok: false, code: "E3_RESERVED_BENEFICIARY_IN_ALLOWLIST" };
    if (!INTEGRATED_REGISTRY.obligations.some((o) => o.case_id === caseId)) return { ok: false, code: "UNKNOWN_CASE" };
    if (!Object.hasOwn(BINDINGS, caseId)) return { ok: false, code: "BINDING_MISSING" };
    const binding = BINDINGS[caseId];
    if (!bindingOk(binding)) return { ok: false, code: "BINDING_MALFORMED" };
    if (binding.e3_no_provider_beneficiary) return { ok: true, beneficiary_id: E3_RESERVED_BENEFICIARY_ID, beneficiary_label: binding.beneficiary_label };
    const matches = [...allowlist].filter(([, label]) => label === binding.beneficiary_label);
    if (matches.length !== 1) return { ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" };
    return { ok: true, beneficiary_id: matches[0][0], beneficiary_label: binding.beneficiary_label };
  } catch {
    return { ok: false, code: "PROPOSAL_BUILD_FAILED_CLOSED" };
  }
}

/** Build the exact transaction for a registry case. Never throws; every problem is a fixed refusal code. */
export function buildProposal(caseId: string, flowId: string, providerRequestId: string, allowlist: Map<string, string>): { ok: true; proposal: FlowProposal } | { ok: false; code: string } {
  try {
    if (REGISTRY_PROBLEM !== null || !/^[0-9a-f]{64}$/.test(INTEGRATED_REGISTRY_DIGEST)) return { ok: false, code: "INTEGRATED_REGISTRY_INVALID" };
    if (typeof caseId !== "string" || typeof flowId !== "string" || typeof providerRequestId !== "string") return { ok: false, code: "PROPOSAL_INPUT_INVALID" };
    const resolved = resolveBeneficiary(caseId, allowlist);
    if (!resolved.ok) return resolved;
    const obligation = INTEGRATED_REGISTRY.obligations.find((o) => o.case_id === caseId);
    if (!obligation) return { ok: false, code: "UNKNOWN_CASE" };
    const binding = BINDINGS[caseId];
    const beneficiaryId = resolved.beneficiary_id;
    const rec = reconcile(obligation);
    if (!rec.ok || rec.net <= 0n) return { ok: false, code: "AMOUNT_NOT_RECONCILED" };
    if (obligation.currency !== "USD") return { ok: false, code: "CURRENCY_NOT_APPROVED" };

    const proposal: FlowProposal = {
      flow_id: flowId,
      obligation_id: obligation.case_id,
      payee: obligation.payee,
      beneficiary_id: beneficiaryId,
      beneficiary_label: binding.beneficiary_label,
      amount_minor: rec.net.toString(),
      currency: "USD",
      reference: obligation.reference,
      transfer_method: "LOCAL",
      reason: binding.reason,
      provider_request_id: providerRequestId,
    };
    const problem = proposalProblem(proposal);
    if (problem) return { ok: false, code: problem };
    return { ok: true, proposal: Object.freeze(proposal) };
  } catch {
    return { ok: false, code: "PROPOSAL_BUILD_FAILED_CLOSED" };
  }
}

/** Registered document text plus the raw replay facts recorded for it (FACTS_SCHEMA shape; the caller grounds them
 *  against the text). Null unless the document is registered in the integrated registry AND has replay facts. */
export function replayEvidence(documentId: string): { text: string; facts: unknown } | null {
  try {
    if (typeof documentId !== "string" || REGISTRY_PROBLEM !== null || !Object.hasOwn(REPLAY, documentId)) return null;
    for (const o of INTEGRATED_REGISTRY.obligations) {
      const d = o.registered_documents.find((x) => x.document_id === documentId);
      if (d) return { text: d.text, facts: structuredClone(REPLAY[documentId]) };
    }
    return null;
  } catch {
    return null;
  }
}
