// A1 proposal-builder and integrated-fixture tests (flow-v1 §5). Offline and pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProposal, E3_RESERVED_BENEFICIARY_ID, flowBinding, INTEGRATED_REGISTRY, INTEGRATED_REGISTRY_DIGEST, replayEvidence } from "../../../../integrated/proposalBuilder.ts";
import { flowDigest, proposalDigest, proposalProblem } from "../../../../integrated/flowCanonical.ts";
import { groundFacts } from "../../../../src/server/agent.ts";
import { evaluate } from "../../../../src/server/agentPolicy.ts";
import type { Claims } from "../../../../src/server/agentPolicy.ts";
import { reconcile, SYNTHETIC_REGISTRY, validateRegistry } from "../../../../src/server/agentRegistry.ts";

const WEB = join(import.meta.dirname, "..", "..", "..", "..");
const json = (rel: string) => JSON.parse(readFileSync(join(WEB, rel), "utf8"));
const FLOW = "00000000-0000-4000-8000-000000000001";
const REQ = "00000000-0000-4000-8000-0000000000aa";
const BEN = "00000000-0000-4000-8000-0000000000be";
const ALLOW = new Map([[BEN, "Synthetic test supplier"]]);
const E3 = ["CASE-E3-OBL-STEEL", "CASE-E3-OBL-ELEC-CO", "CASE-E3-OBL-CONCRETE"];

test("A1-F1 integrated registry: valid, deep-frozen, digested, and a strict superset of the v1 registry", () => {
  assert.equal(validateRegistry(INTEGRATED_REGISTRY), null);
  const raw = json("fixtures/integrated/agent_registry_integrated_v1.json");
  assert.deepEqual(INTEGRATED_REGISTRY, raw);
  assert.equal(INTEGRATED_REGISTRY_DIGEST, flowDigest("registry", raw), "digest of the parsed fixture JSON");
  assert.match(INTEGRATED_REGISTRY_DIGEST, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(INTEGRATED_REGISTRY) && Object.isFrozen(INTEGRATED_REGISTRY.obligations) && Object.isFrozen(INTEGRATED_REGISTRY.obligations[0].amount.line_items[0]));
  assert.throws(() => { (INTEGRATED_REGISTRY.obligations[0] as { payee: string }).payee = "x"; }, TypeError);
  const v1 = json("fixtures/agent_registry_synthetic_v1.json");
  assert.deepEqual(INTEGRATED_REGISTRY.obligations.slice(0, v1.obligations.length), v1.obligations, "every v1 obligation is present and unchanged");
  assert.deepEqual(INTEGRATED_REGISTRY.authorities, v1.authorities);
  assert.deepEqual(INTEGRATED_REGISTRY.obligations.slice(0, v1.obligations.length), SYNTHETIC_REGISTRY.obligations);
  assert.deepEqual(INTEGRATED_REGISTRY.obligations.slice(v1.obligations.length).map((o) => o.case_id), ["CASE-SBX-0002", ...E3]);
});

test("A1-F2 CASE-SBX-0002 is exactly the contract's demonstration payable", () => {
  const o = INTEGRATED_REGISTRY.obligations.find((x) => x.case_id === "CASE-SBX-0002")!;
  assert.deepEqual([o.reference, o.payee, o.currency, o.kind, o.funding_source, o.amount.net_payable], ["DB-SBX-0002", "Prairie Test Concrete LLC", "USD", "PAYABLE", "SANDBOX_DEMO", "5.00"]);
  const rec = reconcile(o);
  assert.ok(rec.ok && rec.net === 500n, "net recomputed from line items");
  assert.deepEqual([o.approval!.status, o.approval!.authority, o.approval!.conditions, o.approval!.amount, o.approval!.payee, o.approval!.currency], ["APPROVED", "PM-SYNTH-01", [], "5.00", o.payee, "USD"]);
  assert.ok(o.documents.length > 0 && o.documents.every((d) => d.status === "RECEIVED") && o.approval!.required_documents.every((t) => o.documents.some((d) => d.type === t)));
  assert.equal(o.dispute!.status, "CLEAR");
  assert.deepEqual(o.registered_documents.map((d) => d.document_id), ["DOC-SBX-0002-INV"]);
});

test("A1-F3 E3 cases carry the E3 amounts, are funding-blocked, and hold through the real gate", () => {
  const cents: Record<string, [string, bigint]> = { "CASE-E3-OBL-STEEL": ["REQ-STEEL-001", 42_000_000n], "CASE-E3-OBL-ELEC-CO": ["REQ-ELEC-001", 18_500_000n], "CASE-E3-OBL-CONCRETE": ["REQ-CONC-001", 31_000_000n] };
  const e3 = json("fixtures/cash_crisis_evidence_v1.json");
  for (const c of E3) {
    const o = INTEGRATED_REGISTRY.obligations.find((x) => x.case_id === c)!;
    const rec = reconcile(o);
    assert.ok(rec.ok && rec.net === cents[c][1], c);
    assert.deepEqual([o.reference, o.funding_source, o.registered_documents.length], [cents[c][0], "E3_PROJECT", 1], c);
    const src = e3.decisions.S0.find((d: { request_id: string }) => d.request_id === o.reference);
    assert.deepEqual([BigInt(src.amount_cents), `CASE-E3-${src.obligation_id}`, src.party], [rec.ok && rec.net, c, o.payee], `${c}: matches the E3 fixture`);
    const ev = replayEvidence(o.registered_documents[0].document_id)!;
    const e = evaluate(ev.text, groundFacts(ev.facts, ev.text) as Claims, INTEGRATED_REGISTRY, "10000000.00");
    const st = (id: string) => e.proofs.find((p) => p.id === id)!.state;
    assert.deepEqual([e.decision, st("S"), st("H"), st("I")], ["HOLD", "VERIFIED", "CONTRADICTED", "CONTRADICTED"], c);
    assert.equal(evaluate(ev.text, groundFacts(ev.facts, ev.text) as Claims, INTEGRATED_REGISTRY, "999999999999.00").decision, "HOLD", `${c}: no balance lifts it`);
  }
  assert.ok(!INTEGRATED_REGISTRY.obligations.some((o) => /FRAMING/.test(o.case_id)), "OBL-FRAMING is not added in flow-v1");
});

test("A1-F4 replay facts: every registered document has facts in FACTS_SCHEMA shape that ground against its own text", () => {
  const facts = json("fixtures/integrated/replay_facts_v1.json");
  const docs = INTEGRATED_REGISTRY.obligations.flatMap((o) => o.registered_documents.map((d) => ({ o, d })));
  assert.deepEqual(Object.keys(facts).sort(), docs.map((x) => x.d.document_id).sort());
  const eligibleCases: string[] = [];
  for (const { o, d } of docs) {
    const ev = replayEvidence(d.document_id)!;
    assert.equal(ev.text, d.text);
    assert.deepEqual(Object.keys(ev.facts as object).sort(), ["adverse_findings", "amounts", "currency", "payee", "reference"]);
    const claims = groundFacts(ev.facts, ev.text);
    assert.ok(typeof claims !== "string", `${d.document_id}: ${claims}`);
    const c = claims as Claims;
    for (const x of [c.reference, c.payee, c.currency, ...c.amounts, ...c.adverse]) assert.equal(x!.grounding, "QUOTED", `${d.document_id}: every fact is quoted from the document`);
    assert.doesNotThrow(() => flowDigest("claims", c));
    if (evaluate(ev.text, c, INTEGRATED_REGISTRY, "10000000.00").decision === "ELIGIBLE_FOR_HUMAN_REVIEW") eligibleCases.push(o.case_id);
  }
  assert.deepEqual(eligibleCases.sort(), ["CASE-PTC-2041", "CASE-RTE-0101", "CASE-SBX-0002"], "the facts are faithful: held cases stay held");
  // the returned facts are a copy; the fixture cannot be edited through them
  const a = replayEvidence("DOC-SBX-0002-INV")!;
  (a.facts as { amounts: unknown[] }).amounts.length = 0;
  assert.equal((replayEvidence("DOC-SBX-0002-INV")!.facts as { amounts: unknown[] }).amounts.length, 1);
  for (const id of ["DOC-NOPE", "", "__proto__", "constructor", "toString", null, undefined, 5, {}]) assert.equal(replayEvidence(id as string), null, String(id));
});

test("A1-F5 binding fixture: a case_id map with exactly the four contract fields", () => {
  const b = json("fixtures/integrated/flow_bindings_v1.json");
  assert.deepEqual(Object.keys(b).sort(), ["CASE-PTC-2043", "CASE-SBX-0002", ...E3].sort());
  for (const [c, v] of Object.entries(b) as [string, Record<string, unknown>][]) {
    assert.deepEqual(Object.keys(v).sort(), ["beneficiary_label", "e3_no_provider_beneficiary", "ledger_allocation_key", "reason"], c);
    assert.ok(INTEGRATED_REGISTRY.obligations.some((o) => o.case_id === c), `${c} is a registry case`);
    assert.equal(v.e3_no_provider_beneficiary, E3.includes(c), c);
    assert.deepEqual(flowBinding(c), v);
  }
  assert.equal(flowBinding("CASE-PTC-2041"), null);
  assert.equal(flowBinding("__proto__"), null);
});

test("A1-P1 buildProposal derives every field server-side; the contract's golden proposal digest is reproduced", () => {
  const r = buildProposal("CASE-SBX-0002", FLOW, REQ, ALLOW);
  assert.ok(r.ok);
  assert.deepEqual(r.proposal, { flow_id: FLOW, obligation_id: "CASE-SBX-0002", payee: "Prairie Test Concrete LLC", beneficiary_id: BEN, beneficiary_label: "Synthetic test supplier", amount_minor: "500", currency: "USD", reference: "DB-SBX-0002", transfer_method: "LOCAL", reason: "goods_purchased", provider_request_id: REQ });
  assert.equal(proposalDigest(r.proposal), "26cc5c482744cbb694c0780813435db8a96e17919d7a0adfadcad98db05ece27", "flow-v1 §4 golden vector");
  assert.equal(proposalProblem(r.proposal), null);
  assert.ok(Object.isFrozen(r.proposal));
  // a second allowlist entry with a different label does not disturb the binding
  const two = new Map([...ALLOW, ["00000000-0000-4000-8000-0000000000bf", "Another supplier"]]);
  const r2 = buildProposal("CASE-SBX-0002", FLOW, REQ, two);
  assert.ok(r2.ok && r2.proposal.beneficiary_id === BEN);
  // the held demonstration case can be built (so its HOLD can be shown); it is the gate that stops it
  const held = buildProposal("CASE-PTC-2043", FLOW, REQ, ALLOW);
  assert.ok(held.ok && held.proposal.reference === "PTC-2043" && held.proposal.amount_minor === "500");
});

test("A1-P2 buildProposal refusals: unknown or unbound case, unresolved beneficiary, bad identifiers, bad allowlist", () => {
  const refused = (code: string, ...args: unknown[]) => assert.deepEqual((buildProposal as (...a: unknown[]) => unknown)(...args), { ok: false, code }, `${code} ${JSON.stringify(args[0])}`);
  for (const c of ["CASE-NOPE", "", "case-sbx-0002", "DB-SBX-0002", "__proto__", "constructor"]) refused("UNKNOWN_CASE", c, FLOW, REQ, ALLOW);
  for (const c of ["CASE-PTC-2041", "CASE-RTE-0101"]) refused("BINDING_MISSING", c, FLOW, REQ, ALLOW);
  // zero matches, and more than one match
  refused("BENEFICIARY_BINDING_UNRESOLVED", "CASE-SBX-0002", FLOW, REQ, new Map());
  refused("BENEFICIARY_BINDING_UNRESOLVED", "CASE-SBX-0002", FLOW, REQ, new Map([[BEN, "Some other supplier"]]));
  refused("BENEFICIARY_BINDING_UNRESOLVED", "CASE-SBX-0002", FLOW, REQ, new Map([[BEN, "synthetic test supplier"]]));
  refused("BENEFICIARY_BINDING_UNRESOLVED", "CASE-SBX-0002", FLOW, REQ, new Map([[BEN, "Synthetic test supplier"], ["00000000-0000-4000-8000-0000000000bf", "Synthetic test supplier"]]));
  refused("INVALID_BENEFICIARY_ID", "CASE-SBX-0002", FLOW, REQ, new Map([["not-a-uuid", "Synthetic test supplier"]]));
  refused("INVALID_FLOW_ID", "CASE-SBX-0002", "nope", REQ, ALLOW);
  refused("INVALID_FLOW_ID", "CASE-SBX-0002", FLOW.toUpperCase().replace("0000-4", "AAAA-4"), REQ, ALLOW);
  refused("INVALID_PROVIDER_REQUEST_ID", "CASE-SBX-0002", FLOW, "nope", ALLOW);
  refused("INVALID_PROVIDER_REQUEST_ID", "CASE-SBX-0002", FLOW, "00000000-0000-1000-8000-0000000000aa", ALLOW);
  for (const bad of [null, undefined, 5, {}, ["CASE-SBX-0002"]]) { refused("PROPOSAL_INPUT_INVALID", bad, FLOW, REQ, ALLOW); refused("PROPOSAL_INPUT_INVALID", "CASE-SBX-0002", bad, REQ, ALLOW); refused("PROPOSAL_INPUT_INVALID", "CASE-SBX-0002", FLOW, bad, ALLOW); }
  for (const bad of [null, undefined, {}, [[BEN, "Synthetic test supplier"]], { [BEN]: "Synthetic test supplier" }, new Map([[BEN, 5]]), new Map([[5, "Synthetic test supplier"]])]) refused("ALLOWLIST_INVALID", "CASE-SBX-0002", FLOW, REQ, bad);
});

test("A1-P3 E3 cases use the reserved beneficiary, which no allowlist may contain", () => {
  assert.equal(E3_RESERVED_BENEFICIARY_ID, "00000000-0000-4000-8000-0000000e3000");
  const amounts: Record<string, string> = { "CASE-E3-OBL-STEEL": "42000000", "CASE-E3-OBL-ELEC-CO": "18500000", "CASE-E3-OBL-CONCRETE": "31000000" };
  for (const c of E3) {
    for (const allow of [ALLOW, new Map<string, string>()]) {
      const r = buildProposal(c, FLOW, REQ, allow);
      assert.ok(r.ok, c);
      assert.deepEqual([r.proposal.beneficiary_id, r.proposal.amount_minor, proposalProblem(r.proposal)], [E3_RESERVED_BENEFICIARY_ID, amounts[c], null], c);
      assert.ok(!allow.has(r.proposal.beneficiary_id), "so the allowlist check before human review can never pass");
    }
    // even an allowlist entry carrying the E3 label does not give an E3 case a real beneficiary
    const sneaky = buildProposal(c, FLOW, REQ, new Map([[BEN, flowBinding(c)!.beneficiary_label]]));
    assert.ok(sneaky.ok && sneaky.proposal.beneficiary_id === E3_RESERVED_BENEFICIARY_ID);
  }
  for (const c of ["CASE-SBX-0002", ...E3]) assert.deepEqual(buildProposal(c, FLOW, REQ, new Map([...ALLOW, [E3_RESERVED_BENEFICIARY_ID, "anything"]])), { ok: false, code: "E3_RESERVED_BENEFICIARY_IN_ALLOWLIST" }, c);
});
