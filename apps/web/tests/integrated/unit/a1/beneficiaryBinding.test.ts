// A1 remediation tests for A8-01: the gate binds the beneficiary to the exact registered obligation.
// Offline and pure. The attacker here is A8's: someone who can rewrite the stored proposal (and recompute its
// digest) before or after evaluation, with a second entry present on the beneficiary allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatePort } from "../../../../integrated/gateBinding.ts";
import { buildProposal, E3_RESERVED_BENEFICIARY_ID, flowBinding, INTEGRATED_REGISTRY, replayEvidence, resolveBeneficiary } from "../../../../integrated/proposalBuilder.ts";
import { gateDigest, proposalDigest, proposalProblem } from "../../../../integrated/flowCanonical.ts";
import { PROOF_IDS } from "../../../../integrated/flowTypes.ts";
import type { FlowProposal, GateBindInput, GateRecord } from "../../../../integrated/flowTypes.ts";
import { groundFacts } from "../../../../src/server/agent.ts";
import type { Claim, Claims } from "../../../../src/server/agentPolicy.ts";
import type { Registry } from "../../../../src/server/agentRegistry.ts";

const T0 = 1_800_000_000_000;
const FLOW = "00000000-0000-4000-8000-000000000001";
const REQ = "00000000-0000-4000-8000-0000000000aa";
const BEN = "00000000-0000-4000-8000-0000000000be";
const ATTACKER = "11111111-1111-4111-8111-111111111111";
const ATTACKER_LABEL = "Attacker supplies";
/** A8 probe X1's allowlist: the genuine test beneficiary plus a second, attacker-controlled entry. */
const ALLOW2 = new Map([[BEN, "Synthetic test supplier"], [ATTACKER, ATTACKER_LABEL]]);
const PHASES = ["review", "approve", "submit"] as const;
const E3 = ["CASE-E3-OBL-STEEL", "CASE-E3-OBL-ELEC-CO", "CASE-E3-OBL-CONCRETE"];

function inputFor(caseId: string, documentId: string, allowlist: Map<string, string> = ALLOW2): GateBindInput {
  const built = buildProposal(caseId, FLOW, REQ, allowlist);
  assert.ok(built.ok, `buildProposal ${caseId}: ${built.ok ? "" : built.code}`);
  const ev = replayEvidence(documentId)!;
  const claims = groundFacts(ev.facts, ev.text);
  assert.ok(typeof claims !== "string");
  return { flow_id: FLOW, proposal: built.proposal, proposal_digest: proposalDigest(built.proposal), evidence_source: "FIXTURE_REPLAY", evidence_text: ev.text, claims: claims as Claims, registry: INTEGRATED_REGISTRY, balance_usd: "10000000.00", now_ms: T0 };
}
const sbx = () => inputFor("CASE-SBX-0002", "DOC-SBX-0002-INV");
/** The stored proposal rewritten and its digest recomputed, as a store writer would leave it. */
function tampered(i: GateBindInput, change: Partial<FlowProposal>): GateBindInput {
  const proposal = { ...i.proposal, ...change };
  assert.equal(proposalProblem(proposal), null, "the rewritten proposal is still well formed, so only the binding can stop it");
  return { ...i, proposal, proposal_digest: proposalDigest(proposal) };
}
function reforge(r: GateRecord, change: Partial<GateRecord>): GateRecord {
  const { gate_digest: _old, ...body } = { ...r, ...change };
  return { ...body, gate_digest: gateDigest(body) };
}
const allVerified = Object.fromEntries(PROOF_IDS.map((id) => [id, "VERIFIED"])) as GateRecord["proof_states"];
const code = (c: ReturnType<typeof gatePort.revalidate>) => (c.ok ? "OK" : c.code);
const held = (i: GateBindInput, rule: string, why: string): GateRecord => {
  const g = gatePort.evaluateAndBind(i);
  assert.deepEqual([g.decision, g.rule], ["HOLD", rule], why);
  return g;
};

test("A1-B1 two-entry allowlist: the bound beneficiary is still resolved, and the genuine transaction is still eligible", () => {
  const r = resolveBeneficiary("CASE-SBX-0002", ALLOW2);
  assert.deepEqual(r, { ok: true, beneficiary_id: BEN, beneficiary_label: "Synthetic test supplier" });
  const i = sbx();
  assert.deepEqual([i.proposal.beneficiary_id, i.proposal.beneficiary_label], [BEN, "Synthetic test supplier"]);
  const g = gatePort.evaluateAndBind(i);
  assert.deepEqual([g.decision, g.rule], ["ELIGIBLE_FOR_HUMAN_REVIEW", "P-ALL VERIFIED"]);
  for (const phase of PHASES) assert.deepEqual(gatePort.revalidate(g, i, phase), { ok: true }, phase);
  // entry order in the allowlist does not matter
  const reversed = new Map([...ALLOW2].reverse());
  assert.deepEqual(resolveBeneficiary("CASE-SBX-0002", reversed), r);
  assert.deepEqual(buildProposal("CASE-SBX-0002", FLOW, REQ, reversed), buildProposal("CASE-SBX-0002", FLOW, REQ, ALLOW2));
});

test("A1-B2 A8 probe X1 at the gate: beneficiary id and label rewritten to the attacker's allowlisted entry is HOLD at evaluation and refused in every phase", () => {
  const x1 = tampered(sbx(), { beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL });
  assert.ok(ALLOW2.get(x1.proposal.beneficiary_id) === x1.proposal.beneficiary_label, "the pair IS on the allowlist: an allowlist membership check alone passes it");
  const g = held(x1, "P-BIND BENEFICIARY_MISMATCH", "X1");
  assert.ok(PROOF_IDS.every((id) => g.proof_states[id] === "VERIFIED"), "the obligation's 11 proofs all stand; it is the beneficiary that is held");
  assert.equal(g.proposal_digest, x1.proposal_digest, "the HOLD is recorded against the tampered transaction");
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, x1, phase)), "GATE_NOT_ELIGIBLE", phase);
});

test("A1-B3 label swapped to the attacker's, id kept: HOLD", () => {
  held(tampered(sbx(), { beneficiary_label: ATTACKER_LABEL }), "P-BIND BENEFICIARY_MISMATCH", "attacker label");
  for (const label of ["synthetic test supplier", "Synthetic test supplier ", "Synthetic test supplier.", "Synthetic", "E3 steel subcontractor (no provider beneficiary)", "x"]) {
    held(tampered(sbx(), { beneficiary_label: label }), "P-BIND BENEFICIARY_MISMATCH", `label "${label}" is not exactly the bound label`);
  }
});

test("A1-B4 id swapped to the attacker's, label kept: not the bound beneficiary under the one resolution rule, and refused against an existing gate result", () => {
  const genuine = sbx();
  const swapped = tampered(genuine, { beneficiary_id: ATTACKER });
  // The resolution rule (the one buildProposal uses) does not give the attacker's id for this case...
  const r = resolveBeneficiary("CASE-SBX-0002", ALLOW2);
  assert.ok(r.ok && r.beneficiary_id === BEN && r.beneficiary_id !== swapped.proposal.beneficiary_id);
  // ...so the tampered stored proposal is not equal to a fresh buildProposal, which is the flow's check.
  const fresh = buildProposal("CASE-SBX-0002", FLOW, REQ, ALLOW2);
  assert.ok(fresh.ok);
  assert.notDeepEqual(swapped.proposal, fresh.proposal);
  assert.notEqual(swapped.proposal_digest, proposalDigest(fresh.proposal));
  // Swapped AFTER evaluation: the existing gate result does not cover it.
  const g = gatePort.evaluateAndBind(genuine);
  assert.equal(g.decision, "ELIGIBLE_FOR_HUMAN_REVIEW");
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, swapped, phase)), "PROPOSAL_CHANGED", phase);
  // LIMIT, stated so nobody assumes otherwise: this port is given no allowlist. Swapped BEFORE evaluation with the
  // bound label kept, the gate alone cannot tell the two ids apart. That half of A8-01 is closed by the flow
  // requiring stored proposal === buildProposal(...) at every phase, asserted above, not by evaluateAndBind.
  assert.equal(gatePort.evaluateAndBind(swapped).decision, "ELIGIBLE_FOR_HUMAN_REVIEW");
});

test("A1-B5 duplicate-label or missing-label allowlists resolve to nothing", () => {
  const dup = new Map([[BEN, "Synthetic test supplier"], [ATTACKER, "Synthetic test supplier"]]);
  for (const allow of [dup, new Map([[ATTACKER, ATTACKER_LABEL]]), new Map<string, string>()]) {
    assert.deepEqual(resolveBeneficiary("CASE-SBX-0002", allow), { ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" });
    assert.deepEqual(buildProposal("CASE-SBX-0002", FLOW, REQ, allow), { ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" });
  }
  const refusals: [string, unknown, unknown][] = [
    ["UNKNOWN_CASE", "CASE-NOPE", ALLOW2], ["UNKNOWN_CASE", "__proto__", ALLOW2], ["BINDING_MISSING", "CASE-PTC-2041", ALLOW2], ["PROPOSAL_INPUT_INVALID", null, ALLOW2],
    ["ALLOWLIST_INVALID", "CASE-SBX-0002", null], ["ALLOWLIST_INVALID", "CASE-SBX-0002", { [BEN]: "Synthetic test supplier" }], ["ALLOWLIST_INVALID", "CASE-SBX-0002", new Map([[BEN, 5]])],
    ["E3_RESERVED_BENEFICIARY_IN_ALLOWLIST", "CASE-SBX-0002", new Map([...ALLOW2, [E3_RESERVED_BENEFICIARY_ID, "x"]])],
  ];
  for (const [c, caseId, allow] of refusals) assert.deepEqual((resolveBeneficiary as (...a: unknown[]) => unknown)(caseId, allow), { ok: false, code: c }, `${c} ${String(caseId)}`);
  // buildProposal and resolveBeneficiary are the same rule for every bound case
  for (const c of ["CASE-SBX-0002", "CASE-PTC-2043", ...E3]) {
    const r = resolveBeneficiary(c, ALLOW2);
    const b = buildProposal(c, FLOW, REQ, ALLOW2);
    assert.ok(r.ok && b.ok && b.proposal.beneficiary_id === r.beneficiary_id && b.proposal.beneficiary_label === r.beneficiary_label && r.beneficiary_label === flowBinding(c)!.beneficiary_label, c);
  }
});

/** A registry in which an E3 case is made fully eligible on its own terms, so that the beneficiary rule is the only
 *  thing left to hold it. It exists only in this test; the shipped E3 cases hold at proofs H and I regardless. */
function e3MadeEligible(): { registry: Registry; input: GateBindInput } {
  const registry = structuredClone(INTEGRATED_REGISTRY) as Registry;
  const o = registry.obligations.find((x) => x.case_id === "CASE-E3-OBL-STEEL")!;
  o.funding_source = "SANDBOX_DEMO";
  o.amount = { line_items: [{ description: "test", unit_price: "5.00", quantity: "1" }], retainage: "0.00", tax: "0.00", credits: "0.00", net_payable: "5.00" };
  o.approval = { approval_id: "T-1", status: "APPROVED", authority: "PM-SYNTH-01", payee: o.payee, amount: "5.00", currency: "USD", conditions: [], required_documents: ["PAY_APPLICATION"] };
  o.documents = [{ type: "PAY_APPLICATION", status: "RECEIVED" }];
  o.dispute = { status: "CLEAR", as_of: "2026-11-15" };
  const q = (value: string): Claim => ({ value, quote: value, start: 0, end: value.length, grounding: "QUOTED" });
  const claims: Claims = { reference: q(o.reference), payee: q(o.payee), currency: q("USD"), amounts: [{ kind: "NET_PAYABLE", ...q("5.00") }], adverse: [] };
  const built = buildProposal("CASE-E3-OBL-STEEL", FLOW, REQ, ALLOW2);
  assert.ok(built.ok);
  const proposal = { ...built.proposal, amount_minor: "500" };
  return { registry, input: { flow_id: FLOW, proposal, proposal_digest: proposalDigest(proposal), evidence_source: "FIXTURE_REPLAY", evidence_text: o.registered_documents[0].text, claims, registry, balance_usd: "10000000.00", now_ms: T0 } };
}

test("A1-B6 E3 case with a non-reserved beneficiary id: HOLD by the binding, even if every proof were verified", () => {
  // shipped registry: held by the gate itself, with or without tampering
  for (const [c, d] of [["CASE-E3-OBL-STEEL", "DOC-E3-STEEL-001"], ["CASE-E3-OBL-ELEC-CO", "DOC-E3-ELEC-001"], ["CASE-E3-OBL-CONCRETE", "DOC-E3-CONC-001"]]) {
    const i = inputFor(c, d);
    assert.equal(i.proposal.beneficiary_id, E3_RESERVED_BENEFICIARY_ID);
    for (const x of [i, tampered(i, { beneficiary_id: BEN }), tampered(i, { beneficiary_id: BEN, beneficiary_label: "Synthetic test supplier" }), tampered(i, { beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL })]) assert.equal(gatePort.evaluateAndBind(x).decision, "HOLD", c);
  }
  // hypothetical registry where the E3 case passes all 11 proofs: only the beneficiary rule is left
  const { input } = e3MadeEligible();
  const base = gatePort.evaluateAndBind(input);
  assert.deepEqual([base.decision, base.rule], ["ELIGIBLE_FOR_HUMAN_REVIEW", "P-ALL VERIFIED"], "control: with the reserved id nothing else holds it (the reserved id is on no allowlist, which stops it before review)");
  held(tampered(input, { beneficiary_id: BEN }), "P-BIND BENEFICIARY_MISMATCH", "E3 with the genuine supplier's id, E3 label kept");
  held(tampered(input, { beneficiary_id: ATTACKER }), "P-BIND BENEFICIARY_MISMATCH", "E3 with the attacker's id, E3 label kept");
  held(tampered(input, { beneficiary_id: BEN, beneficiary_label: "Synthetic test supplier" }), "P-BIND BENEFICIARY_MISMATCH", "E3 rewritten to a real allowlisted pair");
  held(tampered(input, { beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL }), "P-BIND BENEFICIARY_MISMATCH", "E3 rewritten to the attacker's pair");
});

test("A1-B7 non-E3 case with the reserved beneficiary id: HOLD", () => {
  const g = held(tampered(sbx(), { beneficiary_id: E3_RESERVED_BENEFICIARY_ID }), "P-BIND BENEFICIARY_MISMATCH", "reserved id, bound label kept");
  assert.ok(PROOF_IDS.every((id) => g.proof_states[id] === "VERIFIED"));
  held(tampered(sbx(), { beneficiary_id: E3_RESERVED_BENEFICIARY_ID, beneficiary_label: flowBinding("CASE-E3-OBL-STEEL")!.beneficiary_label }), "P-BIND BENEFICIARY_MISMATCH", "reserved id with an E3 label");
});

test("A1-B8 an obligation with no binding cannot be eligible, however complete its proofs", () => {
  // CASE-PTC-2041 is fully verified in the registry but has no beneficiary binding; a store writer hand-builds a proposal for it.
  const ev = replayEvidence("DOC-PTC-2041-INV")!;
  const proposal: FlowProposal = { flow_id: FLOW, obligation_id: "CASE-PTC-2041", payee: "Prairie Test Concrete LLC", beneficiary_id: BEN, beneficiary_label: "Synthetic test supplier", amount_minor: "500", currency: "USD", reference: "PTC-2041", transfer_method: "LOCAL", reason: "goods_purchased", provider_request_id: REQ };
  const i: GateBindInput = { flow_id: FLOW, proposal, proposal_digest: proposalDigest(proposal), evidence_source: "FIXTURE_REPLAY", evidence_text: ev.text, claims: groundFacts(ev.facts, ev.text) as Claims, registry: INTEGRATED_REGISTRY, balance_usd: "10000000.00", now_ms: T0 };
  assert.equal(proposalProblem(proposal), null);
  const g = held(i, "P-BIND BINDING_MISSING", "unbound obligation");
  assert.ok(PROOF_IDS.every((id) => g.proof_states[id] === "VERIFIED"));
  held({ ...i, proposal: { ...proposal, beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL }, proposal_digest: proposalDigest({ ...proposal, beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL }) }, "P-BIND BINDING_MISSING", "unbound obligation, attacker pair");
  for (const phase of PHASES) assert.equal(code(gatePort.revalidate(g, i, phase)), "GATE_NOT_ELIGIBLE", phase);
});

test("A1-B9 tampering after evaluation is caught by revalidate at review, approve and submit, including when the gate record is forged to match", () => {
  const genuine = sbx();
  const g = gatePort.evaluateAndBind(genuine);
  assert.equal(g.decision, "ELIGIBLE_FOR_HUMAN_REVIEW");
  const attacks: [string, Partial<FlowProposal>][] = [
    ["label and id to the attacker's pair", { beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL }],
    ["label only", { beneficiary_label: ATTACKER_LABEL }],
    ["reserved id", { beneficiary_id: E3_RESERVED_BENEFICIARY_ID }],
  ];
  for (const [why, change] of attacks) {
    const t = tampered(genuine, change);
    for (const phase of PHASES) {
      // (a) proposal rewritten, genuine gate record left in place
      assert.equal(code(gatePort.revalidate(g, t, phase)), "PROPOSAL_CHANGED", `${phase}: ${why}, record untouched`);
      // (b) gate record also re-pointed at the tampered proposal, digest recomputed: the proposal check now
      //     passes, and the fresh bind inside revalidate is what refuses it
      const repointed = reforge(g, { proposal_digest: t.proposal_digest });
      assert.equal(code(gatePort.revalidate(repointed, t, phase)), "GATE_REEVALUATION_MISMATCH", `${phase}: ${why}, record re-pointed`);
      // (c) the HOLD that a real evaluation of the tampered proposal produces, forged up to eligible
      const forged = reforge(gatePort.evaluateAndBind(t), { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", proof_states: allVerified });
      assert.equal(code(gatePort.revalidate(forged, t, phase)), "GATE_REEVALUATION_MISMATCH", `${phase}: ${why}, HOLD record forged to eligible`);
    }
  }
  for (const phase of PHASES) assert.deepEqual(gatePort.revalidate(g, genuine, phase), { ok: true }, `${phase}: the genuine transaction is unaffected`);
});
