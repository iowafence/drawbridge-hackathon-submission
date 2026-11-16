// flow-v1 contract pins. OWNER: A7. Any failure here means a lane changed frozen bytes or contract semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationDigest, canonicalText, flowDigest, gateDigest, proposalDigest, proposalProblem, CanonicalError } from "../../../integrated/flowCanonical.ts";
import { GATE_PINNED_SOURCES, isLegal, LEGAL_TRANSITIONS, PROOF_IDS, PROVIDER_STATUS_TO_STATE, TERMINAL_STATES } from "../../../integrated/flowTypes.ts";
import type { FlowOp, FlowProposal, FlowState } from "../../../integrated/flowTypes.ts";
import { readIntegratedFlags } from "../../../integrated/flags.ts";
import { KNOWN_PROVIDER_STATUS, APPROVAL_TTL_MS } from "../../../src/server/transfers.ts";

const WEB = join(import.meta.dirname, "..", "..", "..");

const P: FlowProposal = {
  flow_id: "00000000-0000-4000-8000-000000000001",
  obligation_id: "CASE-SBX-0002",
  payee: "Prairie Test Concrete LLC",
  beneficiary_id: "00000000-0000-4000-8000-0000000000be",
  beneficiary_label: "Synthetic test supplier",
  amount_minor: "500",
  currency: "USD",
  reference: "DB-SBX-0002",
  transfer_method: "LOCAL",
  reason: "goods_purchased",
  provider_request_id: "00000000-0000-4000-8000-0000000000aa",
};

test("gate sources are byte-identical to reviewed 6063b1c", () => {
  for (const [rel, want] of Object.entries(GATE_PINNED_SOURCES)) {
    assert.equal(createHash("sha256").update(readFileSync(join(WEB, rel))).digest("hex"), want, rel);
  }
});

test("golden digest vectors (independently reproduced in Python json.dumps sort_keys/compact/ensure_ascii=False)", () => {
  assert.equal(proposalDigest(P), "26cc5c482744cbb694c0780813435db8a96e17919d7a0adfadcad98db05ece27");
  assert.equal(flowDigest("claims", { a: null, b: [1, true, "x"], c: { d: "é" } }), "5952249edacd81246c11914420e027ea787eaab6523845f8a6b9d5f4edae2b51");
  assert.equal(flowDigest("registry", {}), "f98108e4f2362718f72fa90e627ff8dfd8c75e103c34a3ee4870a5da0964d464");
});

const GATE = {
  flow_id: P.flow_id, proposal_digest: "26cc5c482744cbb694c0780813435db8a96e17919d7a0adfadcad98db05ece27", evidence_source: "FIXTURE_REPLAY" as const,
  evidence_digest: "1".repeat(64), document_id: "DOC-SBX-0002-INV", document_binding: "REGISTERED_DOCUMENT" as const, registry_digest: "2".repeat(64),
  claims_digest: null, policy_version: "agentPolicy.evaluate/11-proof/v1@6063b1c" as const, decision: "ELIGIBLE_FOR_HUMAN_REVIEW" as const, rule: "P-ALL VERIFIED",
  gate_refused: false, proof_states: Object.fromEntries(PROOF_IDS.map((id) => [id, "VERIFIED"])) as Record<(typeof PROOF_IDS)[number], "VERIFIED">,
  balance_minor: "1000000000", evaluated_at_ms: 1763240000000, expires_at_ms: 1763240600000,
};
const AUTH = { flow_id: P.flow_id, proposal_digest: GATE.proposal_digest, gate_digest: "3".repeat(64), operator_id: "human:operator", approved_at_ms: 1763240100000, expires_at_ms: 1763240700000, flow_version: 5 };

test("flow-v1.1 gate and authorization golden vectors (uppercase proof-id keys encode; Python-reproduced)", () => {
  assert.equal(gateDigest(GATE), "b9fd4502103dcc829c004076e32f314ccfe1eafdea9e041534a9db5e2782cfd8");
  assert.equal(authorizationDigest(AUTH), "b385dc9b438e60fe01eb94a88c01224e0d90b0bcedfbd29c7c9f6757498fcaa7");
  assert.notEqual(gateDigest({ ...GATE, proof_states: { ...GATE.proof_states, I: "UNKNOWN" as "VERIFIED" } }), gateDigest(GATE), "each proof state is bound");
  assert.notEqual(gateDigest({ ...GATE, balance_minor: null }), gateDigest(GATE));
  assert.notEqual(authorizationDigest({ ...AUTH, flow_version: 6 }), authorizationDigest(AUTH));
});

test("every bound field changes the proposal digest; domains separate", () => {
  const base = proposalDigest(P);
  const alt: Record<string, string> = { flow_id: "00000000-0000-4000-8000-000000000002", obligation_id: "CASE-SBX-0003", payee: "Other LLC", beneficiary_id: "00000000-0000-4000-8000-0000000000bf", beneficiary_label: "Other", amount_minor: "501", currency: "USX", reference: "DB-SBX-0003", transfer_method: "SWIFT", reason: "other_reason", provider_request_id: "00000000-0000-4000-8000-0000000000ab" };
  for (const k of Object.keys(P)) assert.notEqual(proposalDigest({ ...P, [k]: alt[k] } as FlowProposal), base, k);
  assert.notEqual(flowDigest("gate", P), flowDigest("proposal", P));
});

test("CANON-1 refuses ambiguous values (fail closed)", () => {
  const bad: [unknown, string][] = [
    [{ a: undefined }, "CANON_UNDEFINED"], [{ a: 1.5 }, "CANON_NUMBER_NOT_SAFE_INTEGER"], [{ a: -0 }, "CANON_NUMBER_NOT_SAFE_INTEGER"],
    [{ a: 2 ** 53 }, "CANON_NUMBER_NOT_SAFE_INTEGER"], [{ a: NaN }, "CANON_NUMBER_NOT_SAFE_INTEGER"], [{ a: 1n }, "CANON_TYPE_REFUSED"],
    [{ a: new Date(0) }, "CANON_NOT_PLAIN_OBJECT"], [{ "1a": 1 }, "CANON_KEY_INVALID"], [{ "a-b": 1 }, "CANON_KEY_INVALID"], [{ a: "é" }, "CANON_STRING_NOT_NFC"],
    [{ a: "\uD800" }, "CANON_STRING_NOT_WELL_FORMED"], [[undefined], "CANON_UNDEFINED"],
  ];
  for (const [v, code] of bad) assert.throws(() => canonicalText(v), (e: unknown) => e instanceof CanonicalError && e.code === code, code);
  assert.notEqual(flowDigest("claims", { a: null }), flowDigest("claims", {}), "absent and null differ");
});

test("proposal field rules", () => {
  assert.equal(proposalProblem(P), null);
  assert.equal(proposalProblem({ ...P, amount_minor: "05" }), "INVALID_AMOUNT");
  assert.equal(proposalProblem({ ...P, amount_minor: "5.00" }), "INVALID_AMOUNT");
  assert.equal(proposalProblem({ ...P, currency: "EUR" as "USD" }), "CURRENCY_NOT_APPROVED");
  assert.equal(proposalProblem({ ...P, provider_request_id: "not-a-uuid" }), "INVALID_PROVIDER_REQUEST_ID");
  assert.equal(proposalProblem({ ...P, extra: "x" } as FlowProposal), "PROPOSAL_SHAPE");
});

test("state machine table: closed, terminal states have no exits, provider states only from reads", () => {
  const exits = new Set<FlowState>();
  for (const r of Object.values(LEGAL_TRANSITIONS)) for (const f of r.from) if (f) exits.add(f);
  for (const t of TERMINAL_STATES) assert.equal(exits.has(t), false, `${t} must be terminal`);
  for (const op of Object.keys(LEGAL_TRANSITIONS) as FlowOp[]) {
    for (const to of LEGAL_TRANSITIONS[op].to) if (to.startsWith("PROVIDER_") && to !== "PROVIDER_REFUSED") assert.equal(op, "record_provider_read");
  }
  assert.equal(isLegal("approve", "GATE_HOLD", "HUMAN_APPROVED"), false);
  assert.equal(isLegal("approve", "GATE_REVIEW", "HUMAN_APPROVED"), false);
  assert.equal(isLegal("record_submit_intent", "AWAITING_HUMAN", "SUBMIT_INTENT_RECORDED"), false);
  assert.equal(isLegal("record_create_accepted", "SUBMITTED", "SUBMITTED"), false);
  assert.equal(isLegal("record_provider_read", "SUBMITTED", "PROVIDER_PAID"), true);
  assert.equal(PROOF_IDS.length, 11);
  assert.equal(APPROVAL_TTL_MS, 600_000);
});

test("provider status map covers exactly transfers.ts KNOWN_PROVIDER_STATUS", () => {
  assert.deepEqual(Object.keys(PROVIDER_STATUS_TO_STATE).sort(), [...KNOWN_PROVIDER_STATUS].sort());
  assert.equal(PROVIDER_STATUS_TO_STATE.PROCESSING, "PROVIDER_PROCESSING");
  assert.equal(PROVIDER_STATUS_TO_STATE.SENT, "PROVIDER_PROCESSING", "SENT is not PAID");
});

test("flags fail closed", () => {
  const root = "/repo";
  assert.equal(readIntegratedFlags({}, root), "INTEGRATED_FLOW_DISABLED");
  assert.equal(readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "true" }, root), "FLAG_MALFORMED DB_INTEGRATED_FLOW_ENABLED");
  assert.equal(readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "1" }, root), "INTEGRATED_STORAGE_NOT_CONFIGURED");
  assert.equal(readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_DATA_DIR: "/repo/x" }, root), "INTEGRATED_STORAGE_INSIDE_REPOSITORY");
  assert.equal(readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_DATA_DIR: "/d/a/b", DRAWBRIDGE_DATA_DIR: "/d/a" }, root), "INTEGRATED_STORAGE_OVERLAPS_HISTORIC_CHAIN");
  assert.equal(readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_DATA_DIR: "/d/i", DB_INTEGRATED_PROVIDER_MODE: "production" }, root), "PROVIDER_MODE_INVALID");
  assert.equal(readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_DATA_DIR: "/d/i", DB_INTEGRATED_PROVIDER_MODE: "sandbox" }, root), "SANDBOX_TRANSFER_CREDENTIAL_NOT_CONFIGURED");
  const ok = readIntegratedFlags({ DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_DATA_DIR: "/d/i", DB_INTEGRATED_SUBMIT_RELEASE: "x" }, root);
  assert.ok(typeof ok === "object" && ok.providerMode === "mock" && ok.submitRelease === null && !ok.ledger && !ok.e3 && !ok.externalAudit);
});
