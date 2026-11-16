// A6 presentation vocabulary for the integrated flow (contract flow-v1). Pure text: no decision, digest or status is
// computed here. Every label states what a recorded server state means AND what it does not mean (contract §1).
import type { FlowState, ProofId } from "../../../integrated/flowTypes.ts";

/** Requirement names exactly as published in docs/EVIDENCE_AGENT_POLICY.md §4. */
export const PROOF_LABELS: Record<ProofId, string> = {
  S: "Evidence source",
  A: "Payee identity",
  B: "Exact obligation amount",
  C: "Currency",
  D: "Payment reference",
  E: "Required documents present",
  F: "Valid affirmative approval",
  G: "Dispute status cleared",
  H: "Funding restrictions",
  I: "Financial policy (cap and reserve)",
  J: "Human review still required",
};

export const PROOF_STATE_HELP: Record<string, string> = {
  VERIFIED: "Established by a trusted source through exact comparison",
  MISSING: "Trusted source shows the requirement is not met, or nothing supported was extracted",
  CONTRADICTED: "A trusted source records a negative, or disagrees with a claim",
  UNTRUSTED: "Matches only through an unregistered document; nothing is proven",
  UNKNOWN: "No trusted record or reading is available",
};

export type StateCopy = { label: string; means: string; notMeans: string | null; tone: "neutral" | "ok" | "warn" | "danger" };

export const STATE_COPY: Record<FlowState, StateCopy> = {
  DRAFT: { label: "Draft", means: "Flow created from a registry obligation. No evidence attached.", notMeans: null, tone: "neutral" },
  EVIDENCE_READY: { label: "Evidence attached", means: "Evidence is stored server-side. The gate has not evaluated it yet.", notMeans: null, tone: "neutral" },
  GATE_HOLD: { label: "HOLD", means: "The deterministic gate refused. This flow can never be approved or submitted.", notMeans: null, tone: "danger" },
  GATE_REVIEW: { label: "REVIEW (not eligible)", means: "Some proofs are untrusted or unknown. This flow can never be approved or submitted.", notMeans: null, tone: "warn" },
  GATE_ELIGIBLE: { label: "Eligible for human review", means: "All 11 proofs verified. A human may now review.", notMeans: "Not allowed to pay. Not approved.", tone: "ok" },
  AWAITING_HUMAN: { label: "Awaiting human approval", means: "Waiting for an authenticated operator to approve or reject this exact proposal.", notMeans: "Not approved. Nothing has been sent.", tone: "warn" },
  HUMAN_APPROVED: { label: "Human approved", means: "One operator approved this exact proposal and gate result.", notMeans: "No transfer has been requested or made.", tone: "ok" },
  HUMAN_REJECTED: { label: "Rejected by human", means: "The operator rejected this proposal. The flow is closed.", notMeans: null, tone: "danger" },
  EXPIRED: { label: "Expired", means: "The gate result or approval passed its 10-minute lifetime before use. The flow is closed.", notMeans: null, tone: "danger" },
  SUBMIT_INTENT_RECORDED: { label: "Submit intent recorded", means: "The single create attempt was recorded durably before any provider call.", notMeans: "Not confirmed by the provider.", tone: "warn" },
  SUBMITTED: { label: "Submitted (accepted by provider)", means: "The provider accepted the one create request.", notMeans: "Not scheduled, not processing, not paid.", tone: "warn" },
  SUBMISSION_UNCERTAIN: { label: "Submission outcome unknown", means: "The create call may or may not have reached the provider. There will be no retry; only a provider read can resolve it.", notMeans: "Not failed and not sent: unknown.", tone: "danger" },
  PROVIDER_REFUSED: { label: "Refused by provider", means: "The provider refused the create request. Nothing was created.", notMeans: null, tone: "danger" },
  PROVIDER_SCHEDULED: { label: "Provider: scheduled", means: "A provider read returned SCHEDULED for the matching record.", notMeans: "Not settled.", tone: "warn" },
  PROVIDER_PROCESSING: { label: "Provider: processing", means: "A provider read returned an in-progress status for the matching record.", notMeans: "Not settled. Not paid.", tone: "warn" },
  PROVIDER_FAILED: { label: "Provider: failed", means: "A provider read returned a failed, cancelled or rejected status.", notMeans: null, tone: "danger" },
  PROVIDER_PAID: { label: "Provider read: PAID", means: "A provider read returned PAID for the matching record.", notMeans: null, tone: "ok" },
};

export const DECISION_COPY: Record<string, string> = {
  HOLD: "HOLD",
  REVIEW: "REVIEW (not eligible)",
  ELIGIBLE_FOR_HUMAN_REVIEW: "ELIGIBLE FOR HUMAN REVIEW (not authority to pay)",
};

/** Deterministic, timezone-fixed time text so server and tests agree. */
export function timeText(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "not recorded";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
