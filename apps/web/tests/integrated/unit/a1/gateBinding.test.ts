// A1 gate-binding unit tests (flow-v1 §5). Offline and pure: no model, no network, no provider, no store.
// Evidence and claims come from the integrated fixtures through the same path the flow uses
// (replayEvidence -> groundFacts), so an eligible case here is eligible only because the trusted registry says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatePort } from "../../../../integrated/gateBinding.ts";
import { buildProposal, INTEGRATED_REGISTRY, INTEGRATED_REGISTRY_DIGEST, replayEvidence } from "../../../../integrated/proposalBuilder.ts";
import { gateDigest, proposalDigest } from "../../../../integrated/flowCanonical.ts";
import { GATE_POLICY_VERSION, GATE_TTL_MS, PROOF_IDS } from "../../../../integrated/flowTypes.ts";
import type { FlowProposal, GateBindInput, GateRecord } from "../../../../integrated/flowTypes.ts";
import { groundFacts } from "../../../../src/server/agent.ts";
import type { Claims } from "../../../../src/server/agentPolicy.ts";
import type { Obligation, Registry } from "../../../../src/server/agentRegistry.ts";

const T0 = 1_800_000_000_000;
const FLOW_A = "00000000-0000-4000-8000-000000000001";
const FLOW_B = "00000000-0000-4000-8000-000000000002";
const REQ_A = "00000000-0000-4000-8000-0000000000aa";
const REQ_B = "00000000-0000-4000-8000-0000000000ab";
const BEN = "00000000-0000-4000-8000-0000000000be";
const ALLOW = new Map([[BEN, "Synthetic test supplier"]]);
const BAL = "10000000.00";
const PHASES = ["review", "approve", "submit"] as const;

const DOC_OF: Record<string, string> = { "CASE-SBX-0002": "DOC-SBX-0002-INV", "CASE-PTC-2043": "DOC-PTC-2043-INV", "CASE-E3-OBL-STEEL": "DOC-E3-STEEL-001", "CASE-E3-OBL-ELEC-CO": "DOC-E3-ELEC-001", "CASE-E3-OBL-CONCRETE": "DOC-E3-CONC-001" };

/** The input the flow service would assemble for one case, entirely from server-side sources. */
function inputFor(caseId = "CASE-SBX-0002", over: Partial<GateBindInput> = {}, flowId = FLOW_A, requestId = REQ_A): GateBindInput {
  const built = buildProposal(caseId, flowId, requestId, ALLOW);
  assert.ok(built.ok, `buildProposal ${caseId}: ${built.ok ? "" : built.code}`);
  const ev = replayEvidence(DOC_OF[caseId])!;
  const claims = groundFacts(ev.facts, ev.text);
  assert.ok(typeof claims !== "string", `groundFacts ${caseId}`);
  return { flow_id: flowId, proposal: built.proposal, proposal_digest: proposalDigest(built.proposal), evidence_source: "FIXTURE_REPLAY", evidence_text: ev.text, claims: claims as Claims, registry: INTEGRATED_REGISTRY, balance_usd: BAL, now_ms: T0, ...over };
}
/** Same transaction with one proposal field changed and its digest recomputed (what a changed flow record looks like). */
function withProposal(i: GateBindInput, change: Partial<FlowProposal>): GateBindInput {
  const proposal = { ...i.proposal, ...change };
  return { ...i, proposal, proposal_digest: proposalDigest(proposal), flow_id: proposal.flow_id };
}
const reg = (mutate: (r: Registry) => void): Registry => { const r = structuredClone(INTEGRATED_REGISTRY) as Registry; mutate(r); return r; };
const sbx = (r: Registry): Obligation => r.obligations.find((o) => o.case_id === "CASE-SBX-0002")!;
const later = (i: GateBindInput, ms: number): GateBindInput => ({ ...i, now_ms: i.now_ms + ms });
/** A record with fields replaced and gate_digest recomputed: what someone who can write the store could produce. */
function reforge(r: GateRecord, change: Partial<GateRecord>): GateRecord {
  const { gate_digest: _old, ...body } = { ...r, ...change };
  return { ...body, gate_digest: gateDigest(body) };
}
const code = (c: ReturnType<typeof gatePort.revalidate>) => (c.ok ? "OK" : c.code);
function eligible(i: GateBindInput = inputFor()): GateRecord {
  const g = gatePort.evaluateAndBind(i);
  assert.equal(g.decision, "ELIGIBLE_FOR_HUMAN_REVIEW", g.rule);
  return g;
}

test("A1-00 eligible binding: all 11 proofs VERIFIED, record shaped and digested per flow-v1, revalidates in every phase", () => {
  const i = inputFor();
  const g = eligible(i);
  assert.deepEqual(Object.keys(g.proof_states), [...PROOF_IDS]);
  assert.ok(PROOF_IDS.every((id) => g.proof_states[id] === "VERIFIED"));
  assert.deepEqual(
    [g.flow_id, g.proposal_digest, g.evidence_source, g.document_id, g.document_binding, g.registry_digest, g.policy_version, g.rule, g.gate_refused, g.balance_minor, g.evaluated_at_ms, g.expires_at_ms],
    [FLOW_A, proposalDigest(i.proposal), "FIXTURE_REPLAY", "DOC-SBX-0002-INV", "REGISTERED_DOCUMENT", INTEGRATED_REGISTRY_DIGEST, GATE_POLICY_VERSION, "P-ALL VERIFIED", false, "1000000000", T0, T0 + GATE_TTL_MS],
  );
  assert.equal(GATE_TTL_MS, 600_000);
  const { gate_digest, ...body } = g;
  assert.equal(gate_digest, gateDigest(body));
  assert.equal(Object.keys(g).length, 17);
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.proof_states) && Object.isFrozen(gatePort));
  for (const phase of PHASES) assert.deepEqual(gatePort.revalidate(g, later(i, 1000), phase), { ok: true }, phase);
  assert.deepEqual(gatePort.revalidate(JSON.parse(JSON.stringify(g)), later(i, 1000), "approve"), { ok: true }, "survives a JSON round trip through a store");
  // deterministic, and every bound input moves the digest
  assert.deepEqual(gatePort.evaluateAndBind(inputFor()), g);
  const others = [later(i, 1), inputFor("CASE-SBX-0002", {}, FLOW_B), inputFor("CASE-SBX-0002", {}, FLOW_A, REQ_B), { ...i, evidence_source: "AGENT_RUN" as const }, { ...i, balance_usd: "9999999.00" }, { ...i, registry: reg((r) => { r.authorities.push("PM-SYNTH-09"); }) }];
  assert.equal(new Set([g.gate_digest, ...others.map((o) => gatePort.evaluateAndBind(o).gate_digest)]).size, others.length + 1);
});

test("A1-00b the result is advisory: no approval, authorization, transfer or payment vocabulary, and the port has exactly two functions", () => {
  const g = eligible();
  assert.deepEqual(Object.keys(gatePort).sort(), ["evaluateAndBind", "revalidate"]);
  assert.equal(g.proof_states.J, "VERIFIED", "J: human review still required");
  assert.doesNotMatch(JSON.stringify(g), /approved_by|authorization|operator|transfer_id|PAID|ALLOW|SUBMITTED/);
  assert.deepEqual(Object.keys(gatePort.revalidate(g, inputFor(), "approve")), ["ok"], "revalidation returns a check, not an approval");
});

test("A1-01 no gate result: an absent, empty or malformed record is refused in every phase", () => {
  const i = inputFor();
  for (const phase of PHASES) {
    for (const r of [null, undefined, {}, [], "ELIGIBLE_FOR_HUMAN_REVIEW", 1, { decision: "ELIGIBLE_FOR_HUMAN_REVIEW" }]) assert.equal(code(gatePort.revalidate(r as unknown as GateRecord, i, phase)), "GATE_RECORD_TAMPERED", `${phase} ${JSON.stringify(r)}`);
  }
});

test("A1-02 HOLD result: recorded with its proof states and refused in every phase", () => {
  const i = inputFor("CASE-PTC-2043");
  const g = gatePort.evaluateAndBind(i);
  assert.equal(g.decision, "HOLD");
  assert.deepEqual([g.proof_states.S, g.proof_states.E, g.proof_states.F, g.proof_states.G], ["VERIFIED", "MISSING", "MISSING", "CONTRADICTED"], "registered document; missing waiver, pending approval, open dispute");
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, later(i, 1), phase)), "GATE_NOT_ELIGIBLE", phase);
  // the three E3 cases hold through the real gate: funding-blocked (H) and far above the demo cap (I)
  for (const c of ["CASE-E3-OBL-STEEL", "CASE-E3-OBL-ELEC-CO", "CASE-E3-OBL-CONCRETE"]) {
    const e3 = inputFor(c);
    const h = gatePort.evaluateAndBind(e3);
    assert.deepEqual([h.decision, h.proof_states.H, h.proof_states.I, h.document_binding], ["HOLD", "CONTRADICTED", "CONTRADICTED", "REGISTERED_DOCUMENT"], c);
    assert.doesNotMatch(h.rule, /^P-BIND/, "held by the gate itself, not by a binding override");
    for (const phase of PHASES) assert.equal(code(gatePort.revalidate(h, e3, phase)), "GATE_NOT_ELIGIBLE", `${c} ${phase}`);
  }
});

test("A1-03 REVIEW result: refused in every phase, and never upgraded by later conditions", () => {
  for (const bal of [null, "", "abc", "1e9"]) {
    const i = inputFor("CASE-SBX-0002", { balance_usd: bal });
    const g = gatePort.evaluateAndBind(i);
    assert.deepEqual([g.decision, g.proof_states.I, g.balance_minor], ["REVIEW", "UNKNOWN", null], `balance ${bal}`);
    for (const phase of PHASES) {
      assert.equal(code(gatePort.revalidate(g, i, phase)), "GATE_NOT_ELIGIBLE", phase);
      assert.equal(code(gatePort.revalidate(g, { ...i, balance_usd: BAL }, phase)), "GATE_NOT_ELIGIBLE", `${phase}: a readable balance later does not upgrade an old REVIEW`);
    }
  }
});

test("A1-04 amount mismatch: held at binding, refused at revalidation", () => {
  const i = inputFor();
  for (const amount of ["501", "499", "5", "50000", "1"]) {
    const g = gatePort.evaluateAndBind(withProposal(i, { amount_minor: amount }));
    assert.deepEqual([g.decision, g.rule], ["HOLD", "P-BIND AMOUNT_MISMATCH"], amount);
    assert.ok(PROOF_IDS.every((id) => g.proof_states[id] === "VERIFIED"), "the obligation's proofs stand; this transaction is what is held");
  }
  for (const amount of ["5.00", "0500", "0", "-500", "", "5e2"]) assert.deepEqual([gatePort.evaluateAndBind(withProposal(i, { amount_minor: amount })).decision, gatePort.evaluateAndBind(withProposal(i, { amount_minor: amount })).rule], ["HOLD", "P-BIND INVALID_AMOUNT"], amount);
  assert.equal(gatePort.evaluateAndBind(withProposal(i, { amount_minor: 500 as unknown as string })).decision, "HOLD", "a number is not an amount");
  const g = eligible(i);
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, withProposal(i, { amount_minor: "501" }), phase)), "PROPOSAL_CHANGED", phase);
  // the registry amount moves (with a matching approval): the old proposal no longer binds, and the old record drifts
  const raised = reg((r) => { const o = sbx(r); o.amount.line_items[0].unit_price = "9.00"; o.amount.net_payable = "9.00"; o.approval!.amount = "9.00"; });
  assert.equal(gatePort.evaluateAndBind({ ...i, registry: raised }).rule, "P-B CONTRADICTED", "the document's own figure no longer reconciles");
  assert.equal(code(gatePort.revalidate(g, { ...i, registry: raised }, "approve")), "REGISTRY_DRIFT");
});

test("A1-05 payee or beneficiary mismatch: held at binding, refused at revalidation, unresolvable at construction", () => {
  const i = inputFor();
  assert.equal(gatePort.evaluateAndBind(withProposal(i, { payee: "Prairie Test Concrete Inc" })).rule, "P-BIND PAYEE_MISMATCH");
  assert.equal(gatePort.evaluateAndBind(withProposal(i, { payee: "prairie test concrete llc" })).rule, "P-BIND PAYEE_MISMATCH", "exact, not case-insensitive");
  assert.equal(gatePort.evaluateAndBind(withProposal(i, { beneficiary_id: "not-a-uuid" })).rule, "P-BIND INVALID_BENEFICIARY_ID");
  const g = eligible(i);
  const other = "00000000-0000-4000-8000-0000000000bf";
  for (const phase of PHASES) {
    assert.equal(code(gatePort.revalidate(g, withProposal(i, { beneficiary_id: other }), phase)), "PROPOSAL_CHANGED", `${phase} beneficiary id`);
    assert.equal(code(gatePort.revalidate(g, withProposal(i, { beneficiary_label: "Someone else" }), phase)), "PROPOSAL_CHANGED", `${phase} beneficiary label`);
    assert.equal(code(gatePort.revalidate(g, withProposal(i, { payee: "Prairie Test Concrete Inc" }), phase)), "PROPOSAL_CHANGED", `${phase} payee`);
    assert.equal(code(gatePort.revalidate(g, { ...i, proposal: { ...i.proposal, beneficiary_id: other } }, phase)), "PROPOSAL_CHANGED", `${phase} proposal edited under an unchanged digest`);
  }
  // the registry payee is renamed after gating
  const renamed = reg((r) => { sbx(r).payee = "Prairie Test Concrete Inc"; sbx(r).approval!.payee = "Prairie Test Concrete Inc"; });
  assert.equal(code(gatePort.revalidate(g, { ...i, registry: renamed }, "approve")), "REGISTRY_DRIFT");
  assert.notEqual(gatePort.evaluateAndBind({ ...i, registry: renamed }).decision, "ELIGIBLE_FOR_HUMAN_REVIEW");
});

test("A1-06 reference mismatch: held at binding, refused at revalidation", () => {
  const i = inputFor();
  for (const ref of ["DB-SBX-0001", "DB-SBX-0003", "db-sbx-0002", "PTC-2041"]) assert.equal(gatePort.evaluateAndBind(withProposal(i, { reference: ref })).rule, "P-BIND REFERENCE_MISMATCH", ref);
  assert.equal(gatePort.evaluateAndBind(withProposal(i, { reference: "DB SBX 0002" })).rule, "P-BIND INVALID_REFERENCE");
  const g = eligible(i);
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, withProposal(i, { reference: "DB-SBX-0003" }), phase)), "PROPOSAL_CHANGED", phase);
  // evidence for one obligation cannot make another obligation's payment eligible
  const cross = gatePort.evaluateAndBind({ ...i, evidence_text: replayEvidence("DOC-PTC-2041-INV")!.text, claims: groundFacts(replayEvidence("DOC-PTC-2041-INV")!.facts, replayEvidence("DOC-PTC-2041-INV")!.text) as Claims });
  assert.deepEqual([cross.decision, cross.rule], ["HOLD", "P-BIND OBLIGATION_MISMATCH"]);
  assert.ok(PROOF_IDS.every((id) => cross.proof_states[id] === "VERIFIED"), "PTC-2041 is itself fully verified; it is simply not this transaction");
});

test("A1-07 expired gate: ten minutes for review and approve; at submit the authorization lifetime governs", () => {
  const i = inputFor();
  const g = eligible(i);
  for (const phase of ["review", "approve"] as const) {
    assert.deepEqual(gatePort.revalidate(g, later(i, GATE_TTL_MS - 1), phase), { ok: true }, `${phase}: one millisecond before expiry`);
    assert.equal(code(gatePort.revalidate(g, later(i, GATE_TTL_MS), phase)), "GATE_EXPIRED", `${phase}: at the expiry instant`);
    assert.equal(code(gatePort.revalidate(g, later(i, 86_400_000), phase)), "GATE_EXPIRED", `${phase}: a day later`);
  }
  assert.deepEqual(gatePort.revalidate(g, later(i, GATE_TTL_MS + 60_000), "submit"), { ok: true }, "flow-v1 §5: the gate TTL is not re-applied at submit");
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, later(i, -1), phase)), "GATE_EXPIRED", `${phase}: a clock before the evaluation is never accepted`);
  for (const t of [NaN, 0, -1, 1.5, Infinity, "1800000000000", null]) assert.equal(code(gatePort.revalidate(g, { ...i, now_ms: t as number }, "approve")), "GATE_INPUT_INVALID", String(t));
  // a lifetime other than ten minutes is not a record this port produced, even with a consistent digest
  assert.equal(code(gatePort.revalidate(reforge(g, { expires_at_ms: g.expires_at_ms + 1 }), i, "approve")), "GATE_RECORD_TAMPERED");
  assert.equal(code(gatePort.revalidate({ ...g, expires_at_ms: g.expires_at_ms + 3_600_000 }, i, "approve")), "GATE_RECORD_TAMPERED");
  // an unusable clock at binding is a HOLD that is already expired
  const bad = gatePort.evaluateAndBind({ ...i, now_ms: NaN });
  assert.deepEqual([bad.decision, bad.rule, bad.evaluated_at_ms, bad.expires_at_ms], ["HOLD", "P-BIND CLOCK_INVALID", 0, 0]);
});

test("A1-08 replayed gate: a record is usable only for the flow, request and evaluation it was made for", () => {
  const a = inputFor();
  const ga = eligible(a);
  const b = inputFor("CASE-SBX-0002", {}, FLOW_B, REQ_B);
  const gb = eligible(b);
  assert.notEqual(ga.gate_digest, gb.gate_digest);
  for (const phase of PHASES) {
    assert.equal(code(gatePort.revalidate(ga, b, phase)), "PROPOSAL_CHANGED", `${phase}: flow A's result replayed into flow B`);
    assert.equal(code(gatePort.revalidate(gb, a, phase)), "PROPOSAL_CHANGED", `${phase}: flow B's result replayed into flow A`);
    assert.equal(code(gatePort.revalidate(ga, withProposal(a, { provider_request_id: REQ_B }), phase)), "PROPOSAL_CHANGED", `${phase}: same flow, new provider request ID`);
    assert.equal(code(gatePort.revalidate(reforge(ga, { flow_id: FLOW_B }), a, phase)), "PROPOSAL_CHANGED", `${phase}: record relabelled to another flow`);
    assert.equal(code(gatePort.revalidate(reforge(ga, { flow_id: FLOW_B }), b, phase)), "PROPOSAL_CHANGED", `${phase}: relabelled record offered to that flow`);
  }
  // an old eligible record replayed after its lifetime
  assert.equal(code(gatePort.revalidate(ga, later(a, GATE_TTL_MS + 1), "approve")), "GATE_EXPIRED");
  // re-dating an old record to look fresh changes nothing about what it is checked against
  const redated = reforge(ga, { evaluated_at_ms: T0 + 3_600_000, expires_at_ms: T0 + 3_600_000 + GATE_TTL_MS });
  assert.equal(code(gatePort.revalidate(redated, { ...later(a, 3_600_001), registry: reg((r) => { sbx(r).dispute!.status = "OPEN"; }) }, "approve")), "REGISTRY_DRIFT");
});

test("A1-09 client-supplied verdict ignored: nothing a caller attaches changes the result, and a forged eligible record does not pass", () => {
  const hold = inputFor("CASE-PTC-2043");
  const base = gatePort.evaluateAndBind(hold);
  const verdict = { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", gate_decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", proof_states: Object.fromEntries(PROOF_IDS.map((id) => [id, "VERIFIED"])), gate_refused: false, gate: { decision: "ELIGIBLE_FOR_HUMAN_REVIEW" }, gate_digest: "0".repeat(64), approved: true, eligible: true };
  assert.deepEqual(gatePort.evaluateAndBind({ ...hold, ...verdict } as unknown as GateBindInput), base, "extra fields are never read");
  assert.equal(gatePort.evaluateAndBind({ ...hold, proposal: { ...hold.proposal, ...verdict } as unknown as FlowProposal }).rule, "P-BIND PROPOSAL_SHAPE", "a proposal carrying extra fields is not a proposal");
  // claims are the model's words. Claims that assert approval, or that copy an eligible case, do not move a HOLD.
  const sbxClaims = inputFor().claims;
  assert.equal(gatePort.evaluateAndBind({ ...hold, claims: sbxClaims }).decision, "HOLD");
  assert.equal(gatePort.evaluateAndBind({ ...hold, claims: { ...hold.claims!, adverse: [] } }).decision, "HOLD", "suppressing the adverse findings does not help");
  // a stored HOLD record edited toward eligibility
  const allVerified = Object.fromEntries(PROOF_IDS.map((id) => [id, "VERIFIED"])) as GateRecord["proof_states"];
  for (const phase of PHASES) {
    assert.equal(code(gatePort.revalidate({ ...base, decision: "ELIGIBLE_FOR_HUMAN_REVIEW" }, hold, phase)), "GATE_RECORD_TAMPERED", `${phase}: decision flipped, digest left`);
    assert.equal(code(gatePort.revalidate(reforge(base, { decision: "ELIGIBLE_FOR_HUMAN_REVIEW" }), hold, phase)), "GATE_NOT_ELIGIBLE", `${phase}: decision flipped and digest recomputed, proofs still failing`);
    assert.equal(code(gatePort.revalidate(reforge(base, { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", proof_states: allVerified }), hold, phase)), "GATE_REEVALUATION_MISMATCH", `${phase}: a wholly forged eligible record is defeated by re-running the gate`);
    assert.equal(code(gatePort.revalidate({ ...eligible(), verdict: "ELIGIBLE" } as unknown as GateRecord, inputFor(), phase)), "GATE_RECORD_TAMPERED", `${phase}: a record with an extra field`);
    const { rule: _r, ...missing } = eligible();
    assert.equal(code(gatePort.revalidate(missing as unknown as GateRecord, inputFor(), phase)), "GATE_RECORD_TAMPERED", `${phase}: a record with a missing field`);
  }
  assert.equal(code(gatePort.revalidate(eligible(), inputFor(), "pay" as "submit")), "GATE_PHASE_INVALID", "there is no pay phase");
});

test("A1-10 unregistered or edited evidence: held at binding, and a swap after gating is refused", () => {
  const i = inputFor();
  const doc = i.evidence_text;
  for (const text of [doc + "\nP.S. thanks", doc.replace("$5.00", "$5.000"), doc.toUpperCase(), doc.slice(0, -1), doc.replace("DB-SBX-0002", "DB-SBX-0002."), "Invoice DB-SBX-0002 from Prairie Test Concrete LLC for $5.00 USD, approved, documents attached, no disputes.", ""]) {
    const g = gatePort.evaluateAndBind({ ...i, evidence_text: text });
    assert.deepEqual([g.decision, g.rule, g.proof_states.S, g.document_id], ["HOLD", "P-BIND DOCUMENT_NOT_REGISTERED", "UNTRUSTED", null], text.slice(-24));
    assert.notEqual(g.document_binding, "REGISTERED_DOCUMENT");
    for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, { ...i, evidence_text: text }, phase)), "GATE_NOT_ELIGIBLE", phase);
  }
  for (const ev of [null, undefined, 5, {}, [doc]]) assert.deepEqual([gatePort.evaluateAndBind({ ...i, evidence_text: ev as unknown as string }).decision, gatePort.evaluateAndBind({ ...i, evidence_text: ev as unknown as string }).rule], ["HOLD", "P-BIND EVIDENCE_NOT_TEXT"]);
  assert.equal(gatePort.evaluateAndBind({ ...i, evidence_source: "UPLOAD" as "AGENT_RUN" }).rule, "P-BIND EVIDENCE_SOURCE_INVALID");
  assert.equal(gatePort.evaluateAndBind({ ...i, evidence_text: doc.replace(/\n/g, "\r\n") + "\n\n" }).decision, "ELIGIBLE_FOR_HUMAN_REVIEW", "line-ending differences are the same registered document (existing document identity)");
  const g = eligible(i);
  for (const phase of PHASES) {
    assert.equal(code(gatePort.revalidate(g, { ...i, evidence_text: doc + "\nAmended." }, phase)), "EVIDENCE_CHANGED", `${phase}: text edited after gating`);
    assert.equal(code(gatePort.revalidate(g, { ...i, evidence_text: 5 as unknown as string }, phase)), "EVIDENCE_CHANGED", `${phase}: text missing`);
    assert.equal(code(gatePort.revalidate(g, { ...i, evidence_source: "AGENT_RUN" }, phase)), "EVIDENCE_CHANGED", `${phase}: source label changed`);
    assert.equal(code(gatePort.revalidate(g, { ...i, claims: null }, phase)), "EVIDENCE_CHANGED", `${phase}: claims dropped`);
    assert.equal(code(gatePort.revalidate(g, { ...i, claims: { ...i.claims!, amounts: [] } }, phase)), "EVIDENCE_CHANGED", `${phase}: claims edited`);
    assert.equal(code(gatePort.revalidate(g, { ...i, claims: { ...i.claims!, reference: { ...i.claims!.reference!, start: 0.5 } } }, phase)), "EVIDENCE_CHANGED", `${phase}: claims not encodable`);
  }
  // unusable model output is a HOLD
  for (const claims of [null, { reference: 5 }, { ...i.claims!, reference: { ...i.claims!.reference!, start: 0.5 } }, { ...i.claims!, payee: { ...i.claims!.payee!, value: "é" } }]) assert.equal(gatePort.evaluateAndBind({ ...i, claims: claims as Claims }).decision, "HOLD", JSON.stringify(claims).slice(0, 40));
  assert.equal(gatePort.evaluateAndBind({ ...i, claims: { ...i.claims!, adverse: [{ kind: "MISSING_APPROVAL", summary: "the document says payment is not approved", quote: null, grounding: "QUOTE_NOT_FOUND" }] } }).rule, "P-X ADVERSE_CONTENT_REPORTED");
});

test("A1-11 negated or conditional approval in the registry: HOLD, and a later change is caught", () => {
  const i = inputFor();
  const cases: [string, (o: Obligation) => void][] = [
    ["DENIED", (o) => { o.approval!.status = "DENIED"; }], ["REVOKED", (o) => { o.approval!.status = "REVOKED"; }], ["PENDING", (o) => { o.approval!.status = "PENDING"; }], ["NOT APPROVED", (o) => { o.approval!.status = "NOT APPROVED"; }],
    ["conditional", (o) => { o.approval!.conditions = ["RECEIPT_OF_LIEN_WAIVER"]; }], ["absent", (o) => { o.approval = null; }],
    ["other payee", (o) => { o.approval!.payee = "Prairie Test Concrete Inc"; }], ["other amount", (o) => { o.approval!.amount = "4.00"; }], ["unknown authority", (o) => { o.approval!.authority = "SOMEONE-ELSE"; }],
    ["open dispute", (o) => { o.dispute!.status = "OPEN"; }], ["missing waiver", (o) => { o.documents[1].status = "MISSING"; }],
  ];
  const g = eligible(i);
  for (const [why, m] of cases) {
    const r = reg((x) => m(sbx(x)));
    const h = gatePort.evaluateAndBind({ ...i, registry: r });
    assert.equal(h.decision, "HOLD", why);
    assert.notEqual(h.registry_digest, g.registry_digest, why);
    for (const phase of PHASES) {
      assert.equal(code(gatePort.revalidate(h, { ...i, registry: r }, phase)), "GATE_NOT_ELIGIBLE", `${phase}: ${why}`);
      assert.equal(code(gatePort.revalidate(g, { ...i, registry: r }, phase)), "REGISTRY_DRIFT", `${phase}: ${why} after gating`);
    }
  }
  for (const s of ["DENIED", "REVOKED"]) assert.equal(gatePort.evaluateAndBind({ ...i, registry: reg((x) => { sbx(x).approval!.status = s; }) }).proof_states.F, "CONTRADICTED", s);
});

test("A1-12 registry drift: any change to the registry version invalidates the result in every phase", () => {
  const i = inputFor();
  const g = eligible(i);
  const drifts: [string, unknown][] = [
    ["dispute date bumped, still CLEAR", reg((r) => { sbx(r).dispute!.as_of = "2026-11-16"; })],
    ["registered document text edited", reg((r) => { sbx(r).registered_documents[0].text += "\nAmended."; })],
    ["second registered document added", reg((r) => { sbx(r).registered_documents.push({ document_id: "DOC-SBX-0002-ALT", text: "SYNTHETIC TEST DOCUMENT - an alternate registered text" }); })],
    ["an unrelated obligation changed", reg((r) => { r.obligations[0].dispute!.status = "OPEN"; })],
    ["authority list changed", reg((r) => { r.authorities.push("PM-SYNTH-02"); })],
    ["obligation removed", reg((r) => { r.obligations = r.obligations.filter((o) => o.case_id !== "CASE-SBX-0002"); })],
    ["registry made ambiguous", reg((r) => { r.obligations.push(structuredClone(r.obligations[0])); })],
    ["provenance changed", reg((r) => { r.provenance = "OTHER"; })],
    ["junk", { obligations: "none" }], ["empty", {}], ["absent", null], ["undigestable", reg((r) => { (r as unknown as Record<string, unknown>)["bad-key"] = 2; })],
  ];
  for (const [why, r] of drifts) {
    for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, { ...i, registry: r as Registry }, phase)), "REGISTRY_DRIFT", `${phase}: ${why}`);
    assert.notEqual(gatePort.evaluateAndBind({ ...i, registry: r as Registry }).gate_digest, g.gate_digest, why);
  }
  for (const r of [{ obligations: "none" }, {}, null, reg((x) => { (x as unknown as Record<string, unknown>)["bad-key"] = 2; })]) assert.equal(gatePort.evaluateAndBind({ ...i, registry: r as Registry }).decision, "HOLD");
  assert.deepEqual(gatePort.revalidate(g, { ...i, registry: reg(() => {}) }, "approve"), { ok: true }, "identical content is the same registry version");
  // stale: gated against an older version; the current version would itself be eligible, and the old result is still refused
  const older = reg((r) => { sbx(r).dispute!.as_of = "2026-11-14"; });
  const stale = eligible({ ...i, registry: older });
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(stale, i, phase)), "REGISTRY_DRIFT", `${phase}: stale snapshot`);
  // a record whose registry digest was never computed cannot pass even against the same bad registry
  assert.equal(code(gatePort.revalidate(reforge(g, { registry_digest: "" }), i, "approve")), "REGISTRY_DRIFT");
});

test("A1-13 policy-version change: a result produced under another gate policy is refused", () => {
  const i = inputFor();
  const g = eligible(i);
  assert.equal(g.policy_version, "agentPolicy.evaluate/11-proof/v1@6063b1c");
  for (const v of ["agentPolicy.evaluate/11-proof/v2@abcdef0", "agentPolicy.evaluate/11-proof/v0@6063b1c", "drawbridge-gate-11proof-v1", ""]) {
    const old = reforge(g, { policy_version: v as GateRecord["policy_version"] });
    for (const phase of PHASES) assert.equal(code(gatePort.revalidate(old, i, phase)), "POLICY_VERSION_CHANGED", `${phase}: ${v}`);
  }
  assert.equal(code(gatePort.revalidate({ ...g, policy_version: "x" as GateRecord["policy_version"] }, i, "approve")), "GATE_RECORD_TAMPERED", "policy version is inside the digest");
});

test("A1-14 duplicate consumption: gate_digest is a sufficient single-use key (the store enforces it; this port is stateless)", () => {
  // The port cannot see consumption. What it guarantees is that the store's rule "one gate_digest authorizes at
  // most once" (flow-v1 §6) is sufficient: the digest is unique per flow, request and evaluation, stable across
  // serialization, and cannot be re-minted for the same record. The guard below is that store rule in miniature.
  const consumed = new Set<string>();
  const authorizeOnce = (g: GateRecord, i: GateBindInput): string => {
    const c = gatePort.revalidate(g, i, "approve");
    if (!c.ok) return c.code;
    if (consumed.has(g.gate_digest)) return "GATE_ALREADY_CONSUMED";
    consumed.add(g.gate_digest);
    return "OK";
  };
  const i = inputFor();
  const g = eligible(i);
  assert.equal(authorizeOnce(g, i), "OK");
  assert.equal(authorizeOnce(g, i), "GATE_ALREADY_CONSUMED", "second use of the same record");
  assert.equal(authorizeOnce(JSON.parse(JSON.stringify(g)), i), "GATE_ALREADY_CONSUMED", "a re-serialized copy is the same gate");
  assert.equal(authorizeOnce(Object.fromEntries(Object.entries(g).reverse()) as GateRecord, i), "GATE_ALREADY_CONSUMED", "key order does not make a new gate");
  // every way of making the consumed record look new either keeps its digest or stops it revalidating
  for (const change of [{ evaluated_at_ms: T0 + 1, expires_at_ms: T0 + 1 + GATE_TTL_MS }, { balance_minor: "999" }, { rule: "P-ALL VERIFIED " }, { evidence_source: "AGENT_RUN" as const }]) {
    const variant = reforge(g, change);
    assert.notEqual(variant.gate_digest, g.gate_digest);
    assert.equal(variant.proposal_digest, g.proposal_digest);
  }
  assert.equal(authorizeOnce(reforge(g, { rule: "P-ALL VERIFIED " }), i), "GATE_REEVALUATION_MISMATCH");
  assert.equal(authorizeOnce(reforge(g, { evidence_source: "AGENT_RUN" }), i), "EVIDENCE_CHANGED");
  // two evaluations of the same flow are two gates: each has its own digest, so each can be consumed once at most
  const g2 = eligible(later(i, 5));
  assert.notEqual(g2.gate_digest, g.gate_digest);
  assert.equal(authorizeOnce(g2, later(i, 5)), "OK");
  assert.equal(authorizeOnce(g2, later(i, 5)), "GATE_ALREADY_CONSUMED");
  assert.equal(consumed.size, 2);
});

test("A1-15 fresh re-evaluation: the balance is read again and must still satisfy proof I", () => {
  const i = inputFor();
  const g = eligible(i);
  for (const phase of PHASES) {
    assert.equal(code(gatePort.revalidate(g, { ...i, balance_usd: "104.99" }, phase)), "GATE_REEVALUATION_MISMATCH", `${phase}: reserve would be breached now`);
    assert.equal(code(gatePort.revalidate(g, { ...i, balance_usd: null }, phase)), "GATE_REEVALUATION_MISMATCH", `${phase}: balance unreadable now`);
    assert.equal(code(gatePort.revalidate(g, { ...i, balance_usd: "abc" }, phase)), "GATE_REEVALUATION_MISMATCH", `${phase}: balance unusable now`);
    assert.deepEqual(gatePort.revalidate(g, { ...i, balance_usd: "105.00" }, phase), { ok: true }, `${phase}: a different balance that still satisfies the policy`);
  }
  assert.equal(gatePort.evaluateAndBind({ ...i, balance_usd: "104.99" }).rule, "P-I CONTRADICTED");
});

test("A1-16 fail closed: nothing throws, whatever is passed", () => {
  const i = inputFor();
  const g = eligible(i);
  const junk: unknown[] = [null, undefined, 5, "x", [], {}, { flow_id: FLOW_A }, { ...i, proposal: null }, { ...i, proposal: "x" }, { ...i, proposal_digest: null }, { ...i, flow_id: FLOW_B }, { ...i, registry: undefined }, { ...i, now_ms: "now" }, { ...i, balance_usd: 5 }, { ...i, claims: "ELIGIBLE" }, { ...i, claims: 7 }];
  for (const j of junk) {
    const r = gatePort.evaluateAndBind(j as GateBindInput);
    assert.notEqual(r.decision, "ELIGIBLE_FOR_HUMAN_REVIEW", JSON.stringify(j)?.slice(0, 60));
    assert.equal(Object.keys(r).length, 17);
    const { gate_digest, ...body } = r;
    assert.equal(gate_digest, gateDigest(body), "a fail-closed record is still a well-formed record");
    for (const phase of PHASES) assert.equal(gatePort.revalidate(g, j as GateBindInput, phase).ok, false, `${phase} ${JSON.stringify(j)?.slice(0, 60)}`);
  }
  assert.equal(gatePort.evaluateAndBind({ ...i, proposal_digest: "0".repeat(64) }).rule, "P-BIND PROPOSAL_DIGEST_MISMATCH");
  assert.equal(gatePort.evaluateAndBind({ ...i, flow_id: FLOW_B }).rule, "P-BIND FLOW_ID_MISMATCH");
  const hostile = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
  assert.equal(gatePort.evaluateAndBind(hostile as GateBindInput).decision, "HOLD");
  assert.equal(gatePort.revalidate(hostile as GateRecord, i, "approve").ok, false);
  assert.equal(gatePort.revalidate(g, hostile as GateBindInput, "approve").ok, false);
});
