// A6 UI fixture generator (contract flow-v1). Writes fixtures/integrated/ui/flow_views_v1.json.
// Usage (from apps/web): node tests/integrated/unit/a6/generate_ui_fixtures.ts [--check]
//
// Every gate section of every fixture is produced by calling the REAL, byte-pinned gate
// (agentPolicy.evaluate) on the REAL shipped synthetic registry and registered documents. Nothing about a decision, a
// proof state or a proof reason is typed in by hand. The non-gate parts (state, authorization, submission, audit) are
// hand-authored states of the frozen FlowView shape so the stepper can be exercised in every state before A3 merges.
// Those parts are labelled UI_FIXTURE everywhere they are shown, and digests in them are placeholders, not real digests.
//
// --check regenerates in memory and exits 1 if the committed file differs (drift detection; used by the a6 tests).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../../../../src/server/agentPolicy.ts";
import type { AmountClaim, Claim, Claims, Evaluation } from "../../../../src/server/agentPolicy.ts";
import { SYNTHETIC_REGISTRY } from "../../../../src/server/agentRegistry.ts";
import type { Obligation } from "../../../../src/server/agentRegistry.ts";
import { GATE_POLICY_VERSION, GATE_TTL_MS, PROOF_IDS } from "../../../../integrated/flowTypes.ts";
import type { FlowState, FlowView, ProofId, ProviderMode, SubmissionRecord } from "../../../../integrated/flowTypes.ts";

const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
export const UI_FIXTURE_PATH = join(webRoot, "fixtures/integrated/ui/flow_views_v1.json");

/** Mock-mode balance fixed by contract flow-v1 §6 (evaluateGate). A fixed test value, never a provider or project figure. */
const MOCK_BALANCE = "10000000.00";
/** contract §12: MOCK_ALLOWLIST entry */
const MOCK_BENEFICIARY = { id: "00000000-0000-4000-8000-0000000000be", label: "Synthetic test supplier" };
const T0 = Date.UTC(2026, 10, 15, 22, 0, 0); // 2026-11-15 16:00 CST, fixed so the file is deterministic
const APPROVAL_TTL_MS = 10 * 60_000; // transfers.ts APPROVAL_TTL_MS (contract §3)

const q = (value: string): Claim => ({ value, quote: value, start: 0, end: value.length, grounding: "QUOTED" });
const amt = (kind: string, value: string): AmountClaim => ({ kind, ...q(value) });
/** Claims a fully cooperative model would extract: exactly the registry's values. The worst case for the gate. */
const cooperative = (o: Obligation, extra: Partial<Claims> = {}): Claims => ({
  reference: q(o.reference), payee: q(o.payee), currency: q(o.currency), amounts: [amt("NET_PAYABLE", o.amount.net_payable)], adverse: [], ...extra,
});
const byRef = (ref: string) => SYNTHETIC_REGISTRY.obligations.find((o) => o.reference === ref)!;
const example = (key: string) => (SYNTHETIC_REGISTRY as unknown as { examples?: { key: string; text: string }[] }).examples
  ?? (JSON.parse(readFileSync(join(webRoot, "fixtures/agent_registry_synthetic_v1.json"), "utf8")) as { examples: { key: string; text: string }[] }).examples;
const exampleText = (key: string) => example(key).find((e) => e.key === key)!.text;

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const uuid = (seed: string) => { const h = hex(seed); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const usd = (minor: bigint) => `${minor / 100n}.${String(minor % 100n).padStart(2, "0")} USD`;
const toMinor = (d: string) => { const [i, f = ""] = d.split("."); return BigInt(i) * 100n + BigInt((f + "00").slice(0, 2)); };

type Spec = {
  id: string;
  label: string;
  description: string;
  obligation: Obligation;
  evidence: string | null; // null: no evidence attached yet
  claims: Claims | null;
  state: FlowState;
  approved?: boolean;
  submission?: Partial<SubmissionRecord>;
  /** Balance passed to the gate. Default: the contract's fixed mock-mode value. null = unreadable sandbox balance. */
  balance?: string | null;
  mode?: ProviderMode;
  note?: string;
};

function gateView(e: Evaluation, at: number): NonNullable<FlowView["gate"]> {
  const proof_states = {} as Record<ProofId, (typeof e.proofs)[number]["state"]>;
  const proof_reasons = {} as Record<ProofId, string>;
  for (const id of PROOF_IDS) {
    const p = e.proofs.find((x) => x.id === id);
    if (!p) throw new Error(`gate output missing proof ${id}`);
    proof_states[id] = p.state;
    proof_reasons[id] = p.reason;
  }
  return {
    decision: e.decision, rule: e.rule, gate_refused: e.proofs.some((p) => p.id === "R"), proof_states, proof_reasons,
    evidence_source: "FIXTURE_REPLAY", document_id: e.document.document_id, document_binding: e.document.binding,
    evaluated_at_ms: at, expires_at_ms: at + GATE_TTL_MS, policy_version: GATE_POLICY_VERSION,
  };
}

function build(s: Spec): FlowView & { fixture: { id: string; label: string; description: string; gate_reason: string | null; gate_balance_input: string | null; note: string | null } } {
  const flow_id = uuid(`flow:${s.id}`);
  const net = toMinor(s.obligation.amount.net_payable);
  const evaluation = s.evidence === null ? null : evaluate(s.evidence, s.claims, SYNTHETIC_REGISTRY, s.balance === undefined ? MOCK_BALANCE : s.balance);
  const gateAt = T0 + 60_000;
  const approvedAt = gateAt + 120_000;
  const submission: SubmissionRecord = {
    attempt_id: null, attempt_recorded_at_ms: null, provider_mode: null, provider_transfer_id: null, create_http_status: null,
    create_reported_status: null, last_provider_status: null, last_provider_read_at_ms: null, ...s.submission,
  };
  const hasGate = !["DRAFT", "EVIDENCE_READY"].includes(s.state);
  const events = 1 + (s.evidence ? 1 : 0) + (hasGate ? 1 : 0) + (s.approved ? 2 : 0) + (submission.attempt_id ? 2 : 0) + (submission.last_provider_status ? 1 : 0) + (s.state === "EXPIRED" ? 1 : 0);
  const mode: ProviderMode = s.mode ?? "mock";
  return {
    fixture: { id: s.id, label: s.label, description: s.description, gate_reason: evaluation?.reason ?? null, gate_balance_input: s.balance === undefined ? MOCK_BALANCE : s.balance, note: s.note ?? null },
    flow_id,
    state: s.state,
    version: events,
    terminal: ["GATE_HOLD", "GATE_REVIEW", "HUMAN_REJECTED", "EXPIRED", "PROVIDER_REFUSED", "PROVIDER_FAILED", "PROVIDER_PAID"].includes(s.state),
    proposal: {
      flow_id, obligation_id: s.obligation.case_id, payee: s.obligation.payee, beneficiary_label: MOCK_BENEFICIARY.label,
      beneficiary_id_suffix: MOCK_BENEFICIARY.id.slice(-4), amount_minor: String(net), amount_display: usd(net), currency: "USD",
      reference: s.obligation.reference, transfer_method: "LOCAL", reason: "supplier_invoice", provider_request_id: uuid(`req:${s.id}`),
    },
    gate: evaluation && hasGate ? gateView(evaluation, gateAt) : null,
    authorization: s.approved ? { operator_id: "human:operator", approved_at_ms: approvedAt, expires_at_ms: approvedAt + APPROVAL_TTL_MS } : null,
    ledger: null,
    submission: { ...submission, provider_mode: submission.attempt_id ? mode : null },
    audit: { count: events, head: hex(`audit-head:${s.id}`), verified: true, code: null },
    // flow-v1.1 echo: PLACEHOLDER digests (not computed by flowCanonical); null where that stage does not exist yet.
    echo: {
      proposal_digest: hex(`placeholder-proposal:${s.id}`),
      gate_digest: evaluation && hasGate ? hex(`placeholder-gate:${s.id}`) : null,
      authorization_digest: s.approved ? hex(`placeholder-authorization:${s.id}`) : null,
    },
    // flow-v1.1: the balance text the gate actually received for proof I (fixed contract value in mock mode), or null.
    balance_display: evaluation && hasGate ? (s.balance === undefined ? MOCK_BALANCE : s.balance) : null,
    provider_mode: mode,
    flags: { ledger: false, e3: false, external_audit: false },
  };
}

const A = byRef("PTC-2041"); // registered, approved, cleared
const B = byRef("PTC-2043"); // open dispute, approval pending
const after = (ms: number) => T0 + 60_000 + 120_000 + ms;
const sent = (seed: string, extra: Partial<SubmissionRecord> = {}): Partial<SubmissionRecord> => ({
  attempt_id: uuid(`attempt:${seed}`), attempt_recorded_at_ms: after(30_000), provider_transfer_id: uuid(`transfer:${seed}`),
  create_http_status: 201, create_reported_status: "PROCESSING", ...extra,
});
const docA = A.registered_documents[0].text;
const docB = B.registered_documents[0].text;

export const SPECS: Spec[] = [
  { id: "evidence-ready", label: "Evidence attached, gate not run", description: "Registered document attached by fixture replay; the gate has not evaluated yet.", obligation: A, evidence: docA, claims: cooperative(A), state: "EVIDENCE_READY" },
  { id: "awaiting-human", label: "Eligible for human review", description: "All 11 proofs VERIFIED. A human must now review and approve the exact proposal; nothing is approved yet.", obligation: A, evidence: docA, claims: cooperative(A), state: "AWAITING_HUMAN" },
  { id: "human-approved", label: "Human approved, not submitted", description: "An operator approved the exact proposal digest. No transfer has been requested.", obligation: A, evidence: docA, claims: cooperative(A), state: "HUMAN_APPROVED", approved: true },
  { id: "submitted", label: "Submitted to mock provider", description: "The mock provider accepted one create request (HTTP 201). No provider read yet.", obligation: A, evidence: docA, claims: cooperative(A), state: "SUBMITTED", approved: true, submission: sent("submitted") },
  { id: "processing", label: "Provider read: PROCESSING", description: "A provider read returned PROCESSING for the matching record. Not settled.", obligation: A, evidence: docA, claims: cooperative(A), state: "PROVIDER_PROCESSING", approved: true, submission: sent("processing", { last_provider_status: "PROCESSING", last_provider_read_at_ms: after(90_000) }) },
  { id: "uncertain", label: "Submission uncertain", description: "The create call timed out after the intent was recorded. No retry; reconciliation by read only.", obligation: A, evidence: docA, claims: cooperative(A), state: "SUBMISSION_UNCERTAIN", approved: true, submission: { attempt_id: uuid("attempt:uncertain"), attempt_recorded_at_ms: after(30_000) } },
  { id: "paid-mock", label: "Mock provider read: PAID", description: "The mock provider's read returned PAID. In mock mode no money exists or moves.", obligation: A, evidence: docA, claims: cooperative(A), state: "PROVIDER_PAID", approved: true, submission: sent("paid", { last_provider_status: "PAID", last_provider_read_at_ms: after(300_000) }) },
  { id: "expired", label: "Approval expired", description: "The approval was not used within its 10-minute lifetime.", obligation: A, evidence: docA, claims: cooperative(A), state: "EXPIRED", approved: true },
  { id: "hold-dispute", label: "HOLD: open dispute, pending approval", description: "Registered document for PTC-2043; the registry shows an open dispute and no affirmative approval.", obligation: B, evidence: docB, claims: cooperative(B), state: "GATE_HOLD" },
  { id: "hold-edited", label: "HOLD: edited copy of a registered invoice", description: "The PTC-2041 invoice with one added line. Any edit breaks the registered-document binding.", obligation: A, evidence: exampleText("c"), claims: cooperative(A, { amounts: [amt("NET_PAYABLE", "5.00"), amt("TOTAL_DUE", "5000")] }), state: "GATE_HOLD", note: "Rule shown is the gate's own. In the integrated flow A1 additionally forces HOLD for any non-registered binding (rule P-BIND <code>); the proof states are unchanged." },
  { id: "review-balance-unknown", label: "REVIEW: sandbox balance unreadable", description: "Registered, approved, cleared invoice, but the sandbox balance read failed, so proof I is UNKNOWN. Not eligible.", obligation: A, evidence: docA, claims: cooperative(A), state: "GATE_REVIEW", balance: null, mode: "sandbox" },
];

export function generate() {
  const views = SPECS.map(build);
  for (const v of views) {
    if (v.gate && v.state === "GATE_HOLD" && v.gate.decision !== "HOLD") throw new Error(`${v.fixture.id}: gate said ${v.gate.decision}, fixture expects HOLD`);
    if (v.gate && v.state === "GATE_REVIEW" && v.gate.decision !== "REVIEW") throw new Error(`${v.fixture.id}: gate said ${v.gate.decision}, fixture expects REVIEW`);
    if (v.gate && !["GATE_HOLD", "GATE_REVIEW"].includes(v.state) && v.gate.decision !== "ELIGIBLE_FOR_HUMAN_REVIEW") throw new Error(`${v.fixture.id}: gate said ${v.gate.decision}, fixture state ${v.state} requires ELIGIBLE`);
  }
  return {
    contract: "flow-v1",
    kind: "UI_FIXTURE",
    provenance:
      "A6 UI fixtures. Gate sections are the output of the real agentPolicy.evaluate on the shipped synthetic registry with a fixed mock-mode balance. State, authorization, submission, audit and echo sections are hand-authored FlowView states for UI testing; their digests (including every echo digest) and ids are placeholders, not flowCanonical output. Not a record of any flow, approval or transfer.",
    mock_balance_usd: MOCK_BALANCE,
    views,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = JSON.stringify(generate(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const cur = readFileSync(UI_FIXTURE_PATH, "utf8");
    if (cur !== text) { console.error("UI fixtures drifted from the gate; regenerate"); process.exit(1); }
    console.log("UI fixtures match the gate");
  } else {
    writeFileSync(UI_FIXTURE_PATH, text);
    console.log(`wrote ${UI_FIXTURE_PATH} (${SPECS.length} views)`);
  }
}
