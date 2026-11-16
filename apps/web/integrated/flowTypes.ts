// DRAWBRIDGE integrated flow — contract flow-v1 shared types. OWNER: A7 (contract). Lanes import; lanes never edit.
// Normative text: contracts/integrated/flow-v1.md. If this file and the document disagree, STOP and ask A7.
//
// Design principle: model investigates; deterministic policy evaluates; human authorizes; provider executes once;
// reconciliation reports what the provider actually says.
import type { Claims, Decision, ProofState } from "../src/server/agentPolicy.ts";
import type { Registry } from "../src/server/agentRegistry.ts";

export const FLOW_CONTRACT_VERSION = "flow-v1" as const;
/** Revision of the frozen contract text/code. flow-v1.1: CANON-1 key fix, FlowView echo, action ops, runtime surface. */
export const FLOW_CONTRACT_REVISION = "flow-v1.2" as const;

/** The 11 published proofs, in published order. `R` (gate refusal) is reported separately as `gate_refused`. */
export const PROOF_IDS = ["S", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type ProofId = (typeof PROOF_IDS)[number];
export type ProofStates = Record<ProofId, ProofState>;

/** Gate policy identity. Pinned to the reviewed sources at 6063b1c by tests/integrated/a7/contract_pins.test.ts.
 *  Any byte change to a pinned file requires a new version string and a contract change. */
export const GATE_POLICY_VERSION = "agentPolicy.evaluate/11-proof/v1@6063b1c" as const;
export const GATE_PINNED_SOURCES: Record<string, string> = {
  "src/server/agentPolicy.ts": "cc46038615f6d07612b105ba70f8ba270dc1673fad44527b41118d83dc8cdd0e",
  "src/server/agentRegistry.ts": "777d2035ce05d04af250f81631b1db50f9209f5fac055322d089f931a5175aa1",
  "src/server/policy.ts": "f3d8ec3856e13368c221211526b3c8deee7d1be9fcb91940cbfdc09eebde3cc3",
  "fixtures/sandbox_proposal_v1.json": "045563830db000d47731fff0fc103ca407b3e0f82b5aabbeadb7f63b928e0731",
};

/** Gate result lifetime (server clock). Approval lifetime is the existing transfers.ts APPROVAL_TTL_MS (10 min). */
export const GATE_TTL_MS = 10 * 60_000;
/** A SUBMIT_INTENT_RECORDED flow older than this with no recorded outcome is presumed crashed -> SUBMISSION_UNCERTAIN. */
export const INTENT_STALE_MS = 60_000;

export type EvidenceSource = "AGENT_RUN" | "FIXTURE_REPLAY";
export type ProviderMode = "mock" | "sandbox";

export type FlowState =
  | "DRAFT"
  | "EVIDENCE_READY"
  | "GATE_HOLD"
  | "GATE_REVIEW"
  | "GATE_ELIGIBLE"
  | "AWAITING_HUMAN"
  | "HUMAN_APPROVED"
  | "HUMAN_REJECTED"
  | "EXPIRED"
  | "SUBMIT_INTENT_RECORDED"
  | "SUBMITTED"
  | "SUBMISSION_UNCERTAIN"
  | "PROVIDER_REFUSED"
  | "PROVIDER_SCHEDULED"
  | "PROVIDER_PROCESSING"
  | "PROVIDER_FAILED"
  | "PROVIDER_PAID";

export const TERMINAL_STATES: readonly FlowState[] = ["GATE_HOLD", "GATE_REVIEW", "HUMAN_REJECTED", "EXPIRED", "PROVIDER_REFUSED", "PROVIDER_FAILED", "PROVIDER_PAID"];

export type FlowOp =
  | "create_flow"
  | "attach_evidence"
  | "evaluate_gate"
  | "request_human_review"
  | "approve"
  | "reject"
  | "expire"
  | "record_submit_intent"
  | "record_create_accepted"
  | "record_create_refused"
  | "record_create_uncertain"
  | "recover_stale_intent"
  | "record_provider_read";

/** The ONLY legal state moves. Everything else is denied (A3 enforces with compare-and-swap; A4 tests exhaustively). */
export const LEGAL_TRANSITIONS: Record<FlowOp, { from: readonly (FlowState | null)[]; to: readonly FlowState[] }> = {
  create_flow: { from: [null], to: ["DRAFT"] },
  attach_evidence: { from: ["DRAFT"], to: ["EVIDENCE_READY"] },
  evaluate_gate: { from: ["EVIDENCE_READY"], to: ["GATE_HOLD", "GATE_REVIEW", "GATE_ELIGIBLE"] },
  request_human_review: { from: ["GATE_ELIGIBLE"], to: ["AWAITING_HUMAN"] },
  approve: { from: ["AWAITING_HUMAN"], to: ["HUMAN_APPROVED"] },
  reject: { from: ["AWAITING_HUMAN"], to: ["HUMAN_REJECTED"] },
  expire: { from: ["GATE_ELIGIBLE", "AWAITING_HUMAN", "HUMAN_APPROVED"], to: ["EXPIRED"] },
  record_submit_intent: { from: ["HUMAN_APPROVED"], to: ["SUBMIT_INTENT_RECORDED"] },
  record_create_accepted: { from: ["SUBMIT_INTENT_RECORDED"], to: ["SUBMITTED"] },
  record_create_refused: { from: ["SUBMIT_INTENT_RECORDED"], to: ["PROVIDER_REFUSED"] },
  record_create_uncertain: { from: ["SUBMIT_INTENT_RECORDED"], to: ["SUBMISSION_UNCERTAIN"] },
  recover_stale_intent: { from: ["SUBMIT_INTENT_RECORDED"], to: ["SUBMISSION_UNCERTAIN"] },
  record_provider_read: {
    from: ["SUBMITTED", "SUBMISSION_UNCERTAIN", "PROVIDER_SCHEDULED", "PROVIDER_PROCESSING"],
    to: ["PROVIDER_SCHEDULED", "PROVIDER_PROCESSING", "PROVIDER_FAILED", "PROVIDER_PAID"],
  },
};

export function isLegal(op: FlowOp, from: FlowState | null, to: FlowState): boolean {
  const r = LEGAL_TRANSITIONS[op];
  return !!r && r.from.includes(from) && r.to.includes(to);
}

/** Provider status (transfers.ts KNOWN_PROVIDER_STATUS, verbatim) -> flow state, applied ONLY to a provider READ
 *  (GET by id / by request_id) whose record matches. A create response never sets a PROVIDER_* state. */
export const PROVIDER_STATUS_TO_STATE: Record<string, "PROVIDER_SCHEDULED" | "PROVIDER_PROCESSING" | "PROVIDER_FAILED" | "PROVIDER_PAID"> = {
  SCHEDULED: "PROVIDER_SCHEDULED",
  IN_APPROVAL: "PROVIDER_PROCESSING",
  OVERDUE: "PROVIDER_PROCESSING",
  PROCESSING: "PROVIDER_PROCESSING",
  SENT: "PROVIDER_PROCESSING",
  CANCELLATION_REQUESTED: "PROVIDER_PROCESSING",
  APPROVAL_BLOCKED: "PROVIDER_FAILED",
  APPROVAL_RECALLED: "PROVIDER_FAILED",
  APPROVAL_REJECTED: "PROVIDER_FAILED",
  FAILED: "PROVIDER_FAILED",
  CANCELLED: "PROVIDER_FAILED",
  PAID: "PROVIDER_PAID",
};

/** Digest input for the exact transaction. Every field is always present (no optional keys). */
export type FlowProposal = {
  flow_id: string; // UUID v4, lowercase
  obligation_id: string; // registry Obligation.case_id
  payee: string; // registry Obligation.payee, verbatim
  beneficiary_id: string; // provider beneficiary UUID, resolved server-side from the allowlist
  beneficiary_label: string; // allowlist label the binding fixture names
  amount_minor: string; // decimal integer string, ^[1-9][0-9]{0,17}$ ; equals reconcile(obligation).net
  currency: "USD";
  reference: string; // registry Obligation.reference ; ^[A-Za-z0-9-]{1,32}$
  transfer_method: "LOCAL";
  reason: string; // ^[a-z_]{3,40}$
  provider_request_id: string; // UUID v4, lowercase, unique across the store
};

export type GateRecord = {
  flow_id: string;
  proposal_digest: string;
  evidence_source: EvidenceSource;
  evidence_digest: string; // agentRegistry.documentDigest(evidence_text)
  document_id: string | null; // Evaluation.document.document_id
  document_binding: "REGISTERED_DOCUMENT" | "UNTRUSTED_REFERENCE" | "NONE";
  registry_digest: string;
  claims_digest: string | null; // null when claims are null
  policy_version: typeof GATE_POLICY_VERSION;
  decision: Decision; // "HOLD" | "REVIEW" | "ELIGIBLE_FOR_HUMAN_REVIEW"
  rule: string; // Evaluation.rule verbatim
  gate_refused: boolean; // Evaluation.proofs contains id "R"
  proof_states: ProofStates;
  balance_minor: string | null; // sandbox USD available used for proof I, as minor-unit integer string
  evaluated_at_ms: number;
  expires_at_ms: number; // evaluated_at_ms + GATE_TTL_MS
  gate_digest: string; // digest("gate", record without gate_digest)
};

export type AuthorizationRecord = {
  flow_id: string;
  proposal_digest: string;
  gate_digest: string;
  operator_id: string; // "human:<session name>"
  approved_at_ms: number;
  expires_at_ms: number; // approved_at_ms + transfers.APPROVAL_TTL_MS
  flow_version: number; // flow version at approval (CAS input)
  authorization_digest: string; // digest("authorization", record without authorization_digest)
};

export type LedgerBinding = {
  allocation_id: string;
  funding_check_version: string;
  funding_checked_at_ms: number;
  reduction_event_id: string | null;
  reduced_at_ms: number | null;
};

export type SubmissionRecord = {
  attempt_id: string | null; // UUID; set atomically with SUBMIT_INTENT_RECORDED
  attempt_recorded_at_ms: number | null;
  provider_mode: ProviderMode | null;
  provider_transfer_id: string | null;
  create_http_status: number | null;
  create_reported_status: string | null; // what the create response said; never promoted to a PROVIDER_* state
  last_provider_status: string | null; // from a matching READ only
  last_provider_read_at_ms: number | null;
};

/** The canonical durable flow record (FlowRecordV1). Persisted by A3; displayed by A6 through FlowView. */
export type FlowRecordV1 = {
  contract: typeof FLOW_CONTRACT_VERSION;
  flow_id: string;
  created_at_ms: number;
  created_by: string;
  proposal: FlowProposal;
  proposal_digest: string;
  gate: GateRecord | null;
  gate_consumed_at_ms: number | null; // set once, by approve; a consumed gate can never authorize again
  authorization: AuthorizationRecord | null;
  authorization_consumed_at_ms: number | null; // set once, by record_submit_intent
  ledger: LedgerBinding | null; // only when DB_INTEGRATED_LEDGER_ENABLED=1
  submission: SubmissionRecord;
  state: FlowState;
  version: number; // starts at 1, +1 on every committed transition
  audit_head: string; // hash of the newest audit event for this flow
};

/** Read model handed to UI. Contains no secret, credential, raw provider payload or evidence text beyond the
 *  registered document id and digest. */
export type FlowView = {
  flow_id: string;
  state: FlowState;
  version: number;
  terminal: boolean;
  proposal: Omit<FlowProposal, "beneficiary_id"> & { beneficiary_id_suffix: string; amount_display: string };
  gate: (Pick<GateRecord, "decision" | "rule" | "gate_refused" | "proof_states" | "evidence_source" | "document_id" | "document_binding" | "evaluated_at_ms" | "expires_at_ms" | "policy_version"> & {
    proof_reasons: Record<ProofId, string>;
  }) | null;
  authorization: Pick<AuthorizationRecord, "operator_id" | "approved_at_ms" | "expires_at_ms"> | null;
  ledger: (LedgerBinding & { label: "drawn against allocation" }) | null;
  submission: SubmissionRecord;
  audit: { count: number; head: string; verified: boolean; code: string | null };
  /** Server-computed digests the UI renders into forms as echoes. The server re-derives and compares; an echo is
   *  never authority. null when that stage does not exist yet. */
  echo: { proposal_digest: string; gate_digest: string | null; authorization_digest: string | null };
  /** Sandbox USD available used for proof I, display text, or null. Sandbox test funds, never project cash. */
  balance_display: string | null;
  provider_mode: ProviderMode;
  flags: { ledger: boolean; e3: boolean; external_audit: boolean };
};

// ---------------------------------------------------------------------------------------------------------------
// Ports. Lanes implement these; A3's flow service consumes them through dependency injection; A7 wires them.
// ---------------------------------------------------------------------------------------------------------------

export type GateBindInput = {
  flow_id: string;
  proposal: FlowProposal;
  proposal_digest: string;
  evidence_source: EvidenceSource;
  evidence_text: string;
  claims: Claims | null;
  registry: Registry;
  balance_usd: string | null; // exact decimal text from the provider READ role, or null
  now_ms: number;
};

export type GateCheck = { ok: true } | { ok: false; code: string };

/** A1. Pure and deterministic. Never throws (fail closed to HOLD / ok:false). */
export interface GatePort {
  evaluateAndBind(input: GateBindInput): GateRecord;
  /** Re-run agentPolicy.evaluate on server-held inputs and require an identical ELIGIBLE binding; check TTL; check
   *  the proposal still matches the registry obligation. Used by request_human_review, approve, record_submit_intent. */
  revalidate(record: GateRecord, input: GateBindInput, phase: "review" | "approve" | "submit"): GateCheck;
}

export type ProviderTransferBody = {
  beneficiary_id: string;
  transfer_amount: string; // policy.fromMinor(amount_minor)
  transfer_currency: "USD";
  source_currency: "USD";
  transfer_method: "LOCAL";
  reason: string;
  reference: string;
  request_id: string; // = proposal.provider_request_id
};

export type ProviderCallResult = { kind: "HTTP"; status: number; body: unknown } | { kind: "TRANSPORT_ERROR"; code: string };

/** A3. mock implementation is the default; sandbox implementation wraps the awx.ts transfer-role client. */
export interface ProviderPort {
  readonly mode: ProviderMode;
  validate(body: ProviderTransferBody): Promise<ProviderCallResult>; // provider validate endpoint (creates nothing)
  create(body: ProviderTransferBody): Promise<ProviderCallResult>; // provider create endpoint — at most once per flow
  readById(providerTransferId: string): Promise<ProviderCallResult>; // provider read by transfer id
  readByRequestId(requestId: string): Promise<ProviderCallResult>; // provider read by request id
}

/** A2 (optional). Funding is not cash; a reduction is "drawn against allocation", never "paid". */
export interface LedgerPort {
  checkFunding(input: { flow_id: string; allocation_id: string; amount_minor: string }): Promise<{ ok: true; funding_check_version: string; available_minor: string } | { ok: false; code: string }>;
  postReduction(input: { flow_id: string; allocation_id: string; amount_minor: string; idempotency_key: string; authorization_id: string }): Promise<{ ok: true; reduction_event_id: string; reduced_at_ms: number; replayed: boolean } | { ok: false; code: string }>;
}

/** Minimal synchronous SQL surface (node:sqlite DatabaseSync satisfies it). */
export interface SqlTx {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export type FlowAuditInput = {
  flow_id: string;
  type: string; // ^[A-Z][A-Z0-9_]{2,63}$
  actor: string; // "human:<name>" | "server" | "system:recovery"
  from_state: FlowState | null;
  to_state: FlowState | null; // null for audit-only events (refusals, reads that change nothing)
  flow_version: number; // version AFTER this event's transition (unchanged for audit-only)
  data: Record<string, string | number | boolean | null>; // no credential-like keys, strings <= 300 chars
  at_ms: number;
};

export type FlowAuditEvent = FlowAuditInput & { chain: "DB_INTEGRATED_FLOW_V1"; seq: number; prev: string; hash: string };

/** A5. append() is called by A3 INSIDE A3's open transaction so state and audit commit atomically. */
export interface AuditPort {
  readonly ddl: readonly string[];
  append(tx: SqlTx, ev: FlowAuditInput): FlowAuditEvent;
  verify(tx: SqlTx, flowId?: string): { ok: true; count: number; head: string } | { ok: false; code: string; at_seq: number | null };
}

// ---------------------------------------------------------------------------------------------------------------
// Flow service surface (A3 implements; A7 wires; A4 tests black-box). Result has the transfers.ts Result shape.
// ---------------------------------------------------------------------------------------------------------------

export type FlowResult = { ok: boolean; code: string };

/** flow-v1.1: the only `op` values /sandbox/flow/action accepts. Anything else is 400 UNKNOWN_OPERATION. */
export const FLOW_ACTION_OPS = ["create_flow", "attach_evidence", "evaluate_gate", "request_human_review", "approve", "reject", "submit", "reconcile"] as const;
export type FlowActionOp = (typeof FLOW_ACTION_OPS)[number];
/** Ops that require verifyPassphrase step-up in the same request. */
export const STEP_UP_OPS: readonly FlowActionOp[] = ["approve", "reject", "submit"];

export type EvidenceRef = { kind: "FIXTURE_REPLAY"; document_id: string } | { kind: "AGENT_RUN"; run_id: string };

export type FlowDeps = {
  /** flow-v1.2 R11: server-held approval secret, >= 32 random bytes, generated in process memory by flowRuntime
   *  (crypto.randomBytes(32)) once per process. NEVER persisted, logged, exported, put in a FlowView, an audit event,
   *  an error or the store. approve() stores approvalMac(key, authorization_digest); submit() refuses with
   *  AUTHORIZATION_NOT_SERVER_ISSUED unless it verifies. A missing/short key refuses approve and submit (fail closed).
   *  Consequence by design: an approval does not survive a restart or cross processes; it expires instead. */
  approvalKey: Uint8Array;
  dataDir: string;
  providerMode: ProviderMode;
  submitRelease: string | null;
  gate: GatePort;
  provider: ProviderPort;
  audit: AuditPort;
  ledger: LedgerPort | null;
  registry: Registry;
  allowlist: Map<string, string>;
  /** A1 buildProposal, already bound to registry and binding fixture. */
  buildProposal: (caseId: string, flowId: string, providerRequestId: string, allowlist: Map<string, string>) => { ok: true; proposal: FlowProposal } | { ok: false; code: string };
  /** A1 replayEvidence: registered text + raw facts (grounded by A3 via agent.ts groundFacts). */
  replayEvidence: (documentId: string) => { text: string; facts: unknown } | null;
  /** A7 wires agentRuntime.getRun. Returns null when unknown/evicted. */
  runLookup: (runId: string) => { evidence: string; claims: Claims | null } | null;
  /** READ-role sandbox USD available (exact decimal text) or null; mock mode returns "10000000.00". */
  balanceUsd: () => Promise<string | null>;
  ledgerAllocationFor: (caseId: string) => string | null;
  now: () => number;
  uuid: () => string; // crypto.randomUUID in production; deterministic in tests
};

export interface FlowService {
  createFlow(actor: string, caseId: unknown): FlowResult & { flow_id?: string };
  attachEvidence(actor: string, flowId: unknown, src: EvidenceRef): FlowResult;
  evaluateGate(actor: string, flowId: unknown): Promise<FlowResult>;
  requestHumanReview(actor: string, flowId: unknown): Promise<FlowResult>;
  /** Caller must have completed verifyPassphrase step-up in the same request. */
  approve(actor: string, flowId: unknown, shownProposalDigest: unknown, shownGateDigest: unknown): Promise<FlowResult>;
  reject(actor: string, flowId: unknown, shownProposalDigest: unknown): FlowResult;
  /** Caller must have completed verifyPassphrase step-up in the same request. */
  submit(actor: string, flowId: unknown, shownAuthorizationDigest: unknown): Promise<FlowResult>;
  reconcile(actor: string, flowId: unknown): Promise<FlowResult>;
  getFlow(flowId: unknown): FlowRecordV1 | null;
  getFlowView(flowId: unknown): FlowView | null;
  listFlowViews(): FlowView[];
}

/** flow-v1.1: the A7 runtime surface (integrated/flowRuntime.ts) that A6 pages call. Server-only.
 *  `cookieToken` is the raw db_operator cookie value read with next/headers cookies(). A page that gets a string
 *  (refusal code) or a null session must render 404 / sign-in, never flow data. */
export type FlowPageSession = { operator: string; csrf: string };
export interface FlowRuntimeSurface {
  session(cookieToken: string | undefined): FlowPageSession | null;
  views(): FlowView[] | string;
  view(flowId: string): FlowView | null | string;
}
