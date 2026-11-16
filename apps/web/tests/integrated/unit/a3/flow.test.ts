// A3 unit tests (contract flow-v1.1 sections 6 and 7): durable store, compare-and-swap state machine, human approval
// binding, single create attempt, restart and failure injection. Every provider call here is a mock or a mocked
// transport: this suite makes NO network request.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvalMac, authorizationDigest, gateDigest } from "../../../../integrated/flowCanonical.ts";
import { createFlowService } from "../../../../integrated/flowService.ts";
import { LEGAL_PAIRS, openFlowStore } from "../../../../integrated/flowStore.ts";
import { GATE_TTL_MS, INTENT_STALE_MS, isLegal, LEGAL_TRANSITIONS, PROOF_IDS, PROVIDER_STATUS_TO_STATE, TERMINAL_STATES } from "../../../../integrated/flowTypes.ts";
import type { FlowOp, FlowState, GateRecord, ProviderCallResult } from "../../../../integrated/flowTypes.ts";
import { classifyCreate, classifyRead, MOCK_ALLOWLIST, mockProvider, providerBody, sandboxProvider } from "../../../../integrated/paymentAdapter.ts";
import type { MockScript } from "../../../../integrated/paymentAdapter.ts";
import { transition } from "../../../../integrated/stateMachine.ts";
import { AWX_BASE, SandboxClient } from "../../../../src/server/awx.ts";
import type { FetchLike } from "../../../../src/server/awx.ts";
import { SYNTHETIC_REGISTRY } from "../../../../src/server/agentRegistry.ts";
import { evaluate } from "../../../../src/server/agentPolicy.ts";
import { APPROVAL_TTL_MS } from "../../../../src/server/transfers.ts";
import { BEN, BEN_LABEL, CASE, DOC, drive, EVIDENCE, fakeAudit, OPERATOR, rawSql, submit, T0, TEST_APPROVAL_KEY, world, writeFileSync } from "./support.ts";
import type { World } from "./support.ts";

const CHILD = join(fileURLToPath(new URL(".", import.meta.url)), "child.ts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function runChild(w: World, flowId: string, crash: string): Promise<{ signal: string | null; out: { ok: boolean; code: string; state: string | null } | null }> {
  return new Promise((resolve, rejectP) => {
    const p = spawn(process.execPath, ["--no-warnings", CHILD, w.dir, flowId, crash, String(w.clock.t)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rejectP);
    p.on("close", (c, signal) => (c !== 0 && signal === null ? rejectP(new Error(`child failed (${c}): ${err}`)) : resolve({ signal, out: out.trim() ? JSON.parse(out.trim()) : null })));
  });
}
const state = (w: World, id: string) => w.rec(id).state;

// ------------------------------------------------------------------------------------------------------------
// The governed path
// ------------------------------------------------------------------------------------------------------------

test("A3-01 eligible flow: review -> exact approval -> validate -> intent -> ONE create -> PROCESSING read-back; paid only after a PAID read", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const f = w.rec(id);
  assert.deepEqual([f.state, f.authorization!.operator_id, f.version], ["HUMAN_APPROVED", OPERATOR, 5]);
  assert.match(f.proposal.provider_request_id, UUID);
  assert.notEqual(f.gate_consumed_at_ms, null);
  assert.equal(w.provider.calls().create, 0, "approval is not a transfer");

  assert.deepEqual(await submit(w, id), { ok: true, code: "SUBMITTED" });
  const s = w.rec(id);
  assert.deepEqual([s.state, s.submission.create_reported_status, s.submission.last_provider_status, s.submission.create_http_status], ["SUBMITTED", "PROCESSING", null, 201]);
  assert.notEqual(s.authorization_consumed_at_ms, null);
  assert.deepEqual([w.provider.calls().validate, w.provider.calls().create], [1, 1]);

  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PROCESSING" });
  w.provider.setStatus(f.proposal.provider_request_id, "PAID");
  assert.equal(state(w, id), "PROVIDER_PROCESSING", "nothing is paid until the provider is READ saying so");
  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PAID" });
  assert.equal(w.provider.calls().create, 1);
  assert.deepEqual(w.types(id).filter((t) => t !== "GATE_REASON_MISMATCH"), ["FLOW_CREATED", "EVIDENCE_ATTACHED", "GATE_EVALUATED", "HUMAN_REVIEW_REQUESTED", "HUMAN_APPROVED", "SUBMIT_INTENT_RECORDED", "PROVIDER_CREATE_ACCEPTED", "PROVIDER_READ", "PROVIDER_READ"]);
  const order = w.types(id);
  assert.ok(order.indexOf("SUBMIT_INTENT_RECORDED") < order.indexOf("PROVIDER_CREATE_ACCEPTED"), "the intent is recorded before the create result");

  const v = w.svc.getFlowView(id)!;
  assert.deepEqual([v.state, v.terminal, v.proposal.amount_display, v.proposal.beneficiary_id_suffix, v.audit.verified, v.provider_mode], ["PROVIDER_PAID", true, "5.00", BEN.slice(-4), true, "mock"]);
  assert.equal("beneficiary_id" in v.proposal, false);
  assert.deepEqual(v.echo, { proposal_digest: f.proposal_digest, gate_digest: f.gate!.gate_digest, authorization_digest: f.authorization!.authorization_digest });
  assert.equal(v.balance_display, "10000000.00");
  assert.ok(!JSON.stringify(v).includes(EVIDENCE), "no evidence text in the read model");
  assert.equal(w.svc.listFlowViews().length, 1);
});

test("A3-02 a create response never sets a PROVIDER_* state; each read status maps exactly as the contract table says", async () => {
  for (const [status, to] of Object.entries(PROVIDER_STATUS_TO_STATE)) {
    const w = world();
    w.provider.script.createStatus = status;
    const id = await drive(w, "HUMAN_APPROVED");
    await submit(w, id);
    assert.equal(state(w, id), "SUBMITTED", `create accepted with ${status} is still only SUBMITTED`);
    assert.equal(w.rec(id).submission.last_provider_status, null);
    assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: true, code: to });
    assert.equal(w.rec(id).submission.last_provider_status, status);
    if (status !== "PAID") assert.notEqual(state(w, id), "PROVIDER_PAID");
  }
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  await submit(w, id);
  const req = w.rec(id).proposal.provider_request_id;
  w.provider.setStatus(req, "SETTLED_PROBABLY");
  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: false, code: "UNRECOGNIZED_PROVIDER_STATUS" });
  assert.equal(state(w, id), "SUBMITTED");
  w.provider.setStatus(req, "PAID");
  await w.svc.reconcile(OPERATOR, id);
  const before = w.rec(id);
  w.provider.setStatus(req, "FAILED");
  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: false, code: "PROVIDER_STATUS_REGRESSION" });
  assert.deepEqual([state(w, id), w.rec(id).version, w.rec(id).submission.last_provider_status], ["PROVIDER_PAID", before.version, "PAID"]);
  assert.equal(w.types(id).at(-1), "PROVIDER_STATUS_REGRESSION");
  w.provider.setStatus(req, "PAID");
  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PAID" });
  assert.equal(w.types(id).at(-1), "PROVIDER_READ_CONFIRMED");
});

// ------------------------------------------------------------------------------------------------------------
// HOLD / REVIEW / bad gate records / no client authority
// ------------------------------------------------------------------------------------------------------------

test("A3-03 HOLD and REVIEW are terminal: no review, approval, submit or re-evaluation, through the service directly", async () => {
  assert.deepEqual(world().svc.createFlow(OPERATOR, "CASE-NOT-REGISTERED"), { ok: false, code: "UNKNOWN_CASE" });
  assert.equal(world().svc.createFlow("agent:evidence", CASE).code, "HUMAN_OPERATOR_REQUIRED");
  for (const decision of ["HOLD", "REVIEW"] as const) {
    const w = world();
    w.gate.decision = decision;
    w.gate.proofs = { ...w.gate.proofs, D: "MISSING" };
    const id = await drive(w, "GATE");
    const st = decision === "HOLD" ? "GATE_HOLD" : "GATE_REVIEW";
    const f = w.rec(id);
    assert.equal(f.state, st);
    assert.ok(TERMINAL_STATES.includes(st));
    assert.equal((await w.svc.requestHumanReview(OPERATOR, id)).code, "WRONG_STATE");
    assert.equal((await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest)).code, "WRONG_STATE");
    assert.equal((await w.svc.submit(OPERATOR, id, "f".repeat(64))).code, "WRONG_STATE");
    assert.equal((await w.svc.reconcile(OPERATOR, id)).code, "WRONG_STATE");
    w.gate.decision = "ELIGIBLE_FOR_HUMAN_REVIEW"; // the gate changing its mind later does not resurrect this flow
    assert.equal((await w.svc.evaluateGate(OPERATOR, id)).code, "WRONG_STATE");
    assert.deepEqual([state(w, id), w.provider.calls().create, w.provider.calls().validate], [st, 0, 0]);
  }
});

test("A3-04 a gate record that is not a well-formed result for THIS flow is refused and not stored", async () => {
  const redigest = (g: GateRecord): GateRecord => {
    const { gate_digest: _old, ...rest } = g;
    return { ...rest, gate_digest: gateDigest(rest) };
  };
  const bad: [string, (g: GateRecord) => GateRecord][] = [
    ["GATE_RECORD_INVALID", (g) => ({ ...g, decision: "HOLD" })], // digest no longer matches
    ["GATE_RECORD_NOT_FOR_THIS_FLOW", (g) => redigest({ ...g, flow_id: "11111111-1111-4111-8111-111111111111" })],
    ["GATE_RECORD_NOT_FOR_THIS_FLOW", (g) => redigest({ ...g, proposal_digest: "9".repeat(64) })],
    ["GATE_RECORD_NOT_FOR_THIS_FLOW", (g) => redigest({ ...g, evidence_digest: "8".repeat(64) })],
    ["POLICY_VERSION_CHANGED", (g) => redigest({ ...g, policy_version: "other" as never })],
    ["GATE_RECORD_INCONSISTENT", (g) => redigest({ ...g, proof_states: { ...g.proof_states, J: "UNKNOWN" } })],
    ["GATE_RECORD_INCONSISTENT", (g) => redigest({ ...g, gate_refused: true })],
    ["GATE_RECORD_INCONSISTENT", (g) => redigest({ ...g, document_binding: "UNTRUSTED_REFERENCE" })],
    ["GATE_RECORD_INVALID", (g) => redigest({ ...g, expires_at_ms: g.expires_at_ms + 1 })], // lifetime longer than the contract TTL
    ["GATE_RECORD_INVALID", (g) => redigest({ ...g, decision: "ALLOW_TO_PAY" as never })],
    ["GATE_RECORD_INVALID", () => null as never],
  ];
  for (const [codeWanted, mutate] of bad) {
    const w = world();
    w.gate.mutate = mutate;
    const id = await drive(w, "EVIDENCE_READY");
    assert.deepEqual(await w.svc.evaluateGate(OPERATOR, id), { ok: false, code: codeWanted });
    assert.deepEqual([state(w, id), w.rec(id).gate], ["EVIDENCE_READY", null]);
  }
  const w = world();
  w.gate.throws = true;
  const id = await drive(w, "EVIDENCE_READY");
  assert.equal((await w.svc.evaluateGate(OPERATOR, id)).code, "GATE_UNAVAILABLE");
  assert.equal(w.types(id).at(-1), "REFUSED");
});

test("A3-05 no caller-supplied authority: the store refuses every illegal move, in code and in raw SQL", async () => {
  const w = world();
  w.gate.decision = "HOLD";
  const id = await drive(w, "GATE");
  const f = w.rec(id);
  const store = openFlowStore(w.deps.dataDir, w.deps.audit.ddl);
  const all = [...new Set(LEGAL_PAIRS.flat())];
  // the compare-and-swap refuses every operation out of a HOLD, whatever the caller claims
  for (const op of Object.keys(LEGAL_TRANSITIONS) as FlowOp[]) for (const to of all) {
    if (op === "create_flow") continue;
    const r = transition(store, w.deps.audit, { flow_id: id, op, from: "GATE_HOLD", expected_version: f.version, to, event: { type: "FORGED", actor: OPERATOR, data: {} }, at_ms: T0 });
    assert.equal(r.ok, false, `${op} GATE_HOLD -> ${to}`);
  }
  // a legal-looking operation with a stale state or version is refused and writes nothing
  assert.deepEqual(transition(store, w.deps.audit, { flow_id: id, op: "attach_evidence", from: "DRAFT", expected_version: 1, to: "EVIDENCE_READY", event: { type: "X_EVENT", actor: OPERATOR, data: {} }, at_ms: T0 }), { ok: false, code: "WRONG_STATE" });
  assert.deepEqual(transition(store, w.deps.audit, { flow_id: id, op: "expire", from: "GATE_ELIGIBLE", expected_version: f.version, to: "EXPIRED", set: { proposal_json: "{}" }, event: { type: "X_EVENT", actor: OPERATOR, data: {} }, at_ms: T0 }), { ok: false, code: "STORE_FIELD_REFUSED" });
  store.close();
  const n = w.events(id).length;
  // and so does the database, for statements that bypass the code entirely
  const refused = (sql: string) => assert.throws(() => rawSql(w, sql), /FLOW_|ATTEMPT_|AUTHORIZATION_|constraint/, sql);
  refused(`UPDATE flow SET state='PROVIDER_PAID', version=version+1 WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET state='HUMAN_APPROVED', version=version+1 WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET state='GATE_ELIGIBLE', version=version+1 WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET state='GATE_ELIGIBLE' WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET proposal_json='{}', version=version+1 WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET gate_json='{"decision":"ELIGIBLE_FOR_HUMAN_REVIEW"}' WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET evidence_text='edited', version=version+1 WHERE flow_id='${id}'`);
  refused(`UPDATE flow SET last_provider_status='PAID' WHERE flow_id='${id}'`);
  refused(`DELETE FROM flow WHERE flow_id='${id}'`);
  refused(`INSERT INTO flow_authorization VALUES ('${id}','${f.gate!.gate_digest}','${"a".repeat(64)}','${f.proposal_digest}','human:x',1,2,3,'${"d".repeat(64)}')`);
  refused(`INSERT INTO flow_submit_attempt VALUES ('${id}','${f.proposal.provider_request_id}','att','${"a".repeat(64)}',1,'mock')`);
  refused(`INSERT INTO flow (flow_id, created_at_ms, created_by, proposal_json, proposal_digest, provider_request_id, obligation_id, state, version, audit_head, updated_at_ms)
           VALUES ('99999999-9999-4999-8999-999999999999',1,'human:x','{}','${"b".repeat(64)}','88888888-8888-4888-8888-888888888888','C','PROVIDER_PAID',1,'${"0".repeat(64)}',1)`);
  assert.deepEqual([state(w, id), w.rec(id).version, w.events(id).length], ["GATE_HOLD", f.version, n]);
  // the contract table itself: nothing leaves a terminal state, and only a provider read reaches a PROVIDER_* outcome
  for (const t of TERMINAL_STATES) for (const op of Object.keys(LEGAL_TRANSITIONS) as FlowOp[]) for (const to of all) assert.equal(isLegal(op, t, to), false);
  for (const op of Object.keys(LEGAL_TRANSITIONS) as FlowOp[]) if (op !== "record_provider_read") assert.ok(!LEGAL_TRANSITIONS[op].to.some((s) => /^PROVIDER_(SCHEDULED|PROCESSING|FAILED|PAID)$/.test(s)));
});

// ------------------------------------------------------------------------------------------------------------
// Human approval binding (P3, P5) and the R5 allowlist re-check
// ------------------------------------------------------------------------------------------------------------

test("A3-06 approval needs a human actor and the exact shown digests, re-checks the gate and the allowlist, and is single use", async () => {
  const w = world();
  const id = await drive(w, "AWAITING_HUMAN");
  const f = w.rec(id);
  const [pd, gd] = [f.proposal_digest, f.gate!.gate_digest];
  const other = await drive(w, "AWAITING_HUMAN");
  const cases: [string, () => Promise<{ ok: boolean; code: string }>][] = [
    ["HUMAN_OPERATOR_REQUIRED", () => w.svc.approve("agent:evidence", id, pd, gd)],
    ["HUMAN_OPERATOR_REQUIRED", () => w.svc.approve("server", id, pd, gd)],
    ["HUMAN_OPERATOR_REQUIRED", () => w.svc.approve(undefined as never, id, pd, gd)],
    ["PROPOSAL_DIGEST_MISMATCH", () => w.svc.approve(OPERATOR, id, "0".repeat(64), gd)],
    ["PROPOSAL_DIGEST_MISMATCH", () => w.svc.approve(OPERATOR, id, undefined, gd)],
    ["PROPOSAL_DIGEST_MISMATCH", () => w.svc.approve(OPERATOR, id, w.rec(other).proposal_digest, gd)], // another flow's digest
    ["GATE_DIGEST_MISMATCH", () => w.svc.approve(OPERATOR, id, pd, "0".repeat(64))],
    ["GATE_DIGEST_MISMATCH", () => w.svc.approve(OPERATOR, id, pd, w.rec(other).gate!.gate_digest)],
    ["GATE_DIGEST_MISMATCH", () => w.svc.approve(OPERATOR, id, pd, null)],
  ];
  for (const [want, run] of cases) {
    assert.deepEqual(await run(), { ok: false, code: want });
    assert.deepEqual([state(w, id), w.rec(id).authorization], ["AWAITING_HUMAN", null]);
  }
  for (const c of ["REGISTRY_DRIFT", "EVIDENCE_CHANGED", "POLICY_VERSION_CHANGED", "PROPOSAL_CHANGED", "GATE_REEVALUATION_MISMATCH", "GATE_RECORD_TAMPERED"]) {
    w.gate.revalidate = c;
    assert.deepEqual(await w.svc.approve(OPERATOR, id, pd, gd), { ok: false, code: c });
  }
  w.gate.revalidate = null;
  w.gate.throws = true;
  assert.equal((await w.svc.approve(OPERATOR, id, pd, gd)).code, "GATE_REVALIDATION_FAILED");
  w.gate.throws = false;
  w.allowlist.delete(BEN); // R5: removed from the allowlist after review
  assert.equal((await w.svc.approve(OPERATOR, id, pd, gd)).code, "BENEFICIARY_NOT_ALLOWLISTED");
  w.allowlist.set(BEN, "Some other label");
  assert.equal((await w.svc.approve(OPERATOR, id, pd, gd)).code, "BENEFICIARY_NOT_ALLOWLISTED");
  w.allowlist.set(BEN, BEN_LABEL);
  assert.equal(state(w, id), "AWAITING_HUMAN");

  assert.deepEqual(await w.svc.approve(OPERATOR, id, pd, gd), { ok: true, code: "HUMAN_APPROVED" });
  const a = w.rec(id).authorization!;
  assert.deepEqual([a.flow_id, a.proposal_digest, a.gate_digest, a.operator_id, a.expires_at_ms - a.approved_at_ms, a.flow_version], [id, pd, gd, OPERATOR, APPROVAL_TTL_MS, f.version]);
  assert.ok(w.gate.revalidations.includes("approve") && w.gate.revalidations.includes("review"));
  // replay, a late rejection and a second approval are all refused
  assert.equal((await w.svc.approve(OPERATOR, id, pd, gd)).code, "WRONG_STATE");
  assert.equal(w.svc.reject(OPERATOR, id, pd).code, "WRONG_STATE");
  assert.equal(w.events(id).filter((e) => e.type === "HUMAN_APPROVED").length, 1);
  assert.ok(w.events(id).filter((e) => e.type === "REFUSED").length >= cases.length + 9, "every refusal is on the audit chain");
  // rejection
  assert.equal(w.svc.reject("server", other, w.rec(other).proposal_digest).code, "HUMAN_OPERATOR_REQUIRED");
  assert.equal(w.svc.reject(OPERATOR, other, pd).code, "PROPOSAL_DIGEST_MISMATCH");
  assert.deepEqual(w.svc.reject(OPERATOR, other, w.rec(other).proposal_digest), { ok: true, code: "HUMAN_REJECTED" });
  assert.equal((await w.svc.approve(OPERATOR, other, w.rec(other).proposal_digest, w.rec(other).gate!.gate_digest)).code, "WRONG_STATE");
});

test("A3-07 expiry is lazy and final: an expired gate before approval and an expired approval before submit both end EXPIRED", async () => {
  for (const stage of ["GATE", "AWAITING_HUMAN"] as const) {
    const w = world();
    const id = await drive(w, stage);
    const f = w.rec(id);
    w.clock.t += GATE_TTL_MS;
    const r = stage === "GATE" ? await w.svc.requestHumanReview(OPERATOR, id) : await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest);
    assert.deepEqual([r, state(w, id)], [{ ok: false, code: "GATE_EXPIRED" }, "EXPIRED"]);
    assert.equal((await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest)).code, "WRONG_STATE");
  }
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  w.clock.t += APPROVAL_TTL_MS;
  assert.deepEqual([await submit(w, id), state(w, id)], [{ ok: false, code: "APPROVAL_EXPIRED" }, "EXPIRED"]);
  assert.equal((await submit(w, id)).code, "WRONG_STATE");
  assert.deepEqual([w.provider.calls().validate, w.provider.calls().create], [0, 0]);
  // one millisecond before expiry the approval still works
  const v = world();
  const vid = await drive(v, "HUMAN_APPROVED");
  v.clock.t += APPROVAL_TTL_MS - 1;
  assert.equal((await submit(v, vid)).code, "SUBMITTED");
});

// ------------------------------------------------------------------------------------------------------------
// Submit preconditions
// ------------------------------------------------------------------------------------------------------------

test("A3-08 submit fails closed before any intent: wrong human, wrong digest, drift, allowlist, validation, provider mode", async () => {
  const cases: [string, (w: World, id: string) => Promise<{ ok: boolean; code: string }>][] = [
    ["HUMAN_OPERATOR_REQUIRED", (w, id) => submit(w, id, "server")],
    ["OPERATOR_MISMATCH", (w, id) => submit(w, id, "human:someone-else")],
    ["AUTHORIZATION_DIGEST_MISMATCH", (w, id) => w.svc.submit(OPERATOR, id, "2".repeat(64))],
    ["AUTHORIZATION_DIGEST_MISMATCH", (w, id) => w.svc.submit(OPERATOR, id, undefined)],
    ["AUTHORIZATION_DIGEST_MISMATCH", (w, id) => w.svc.submit(OPERATOR, id, w.rec(id).gate!.gate_digest)],
    ["BENEFICIARY_NOT_ALLOWLISTED", (w, id) => (w.allowlist.delete(BEN), submit(w, id))], // R5
    ["REGISTRY_DRIFT", (w, id) => ((w.gate.revalidate = "REGISTRY_DRIFT"), submit(w, id))],
    ["GATE_REEVALUATION_MISMATCH", (w, id) => ((w.gate.decision = "HOLD"), submit(w, id))],
    ["GATE_REVALIDATION_FAILED", (w, id) => ((w.gate.throws = true), submit(w, id))],
    ["PROVIDER_VALIDATION_FAILED", (w, id) => ((w.provider.script.validate = "REFUSE_400"), submit(w, id))],
    ["PROVIDER_VALIDATION_FAILED", (w, id) => ((w.provider.script.validate = "TRANSPORT"), submit(w, id))],
  ];
  for (const [want, run] of cases) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    assert.deepEqual(await run(w, id), { ok: false, code: want }, want);
    const f = w.rec(id);
    assert.deepEqual([f.state, f.submission.attempt_id, f.authorization_consumed_at_ms, w.provider.calls().create], ["HUMAN_APPROVED", null, null, 0], want);
    assert.equal(w.types(id).at(-1), "REFUSED");
  }
  // an authorization from another flow cannot submit this one
  const w = world();
  const a = await drive(w, "HUMAN_APPROVED");
  const b = await drive(w, "HUMAN_APPROVED");
  assert.equal((await w.svc.submit(OPERATOR, b, w.rec(a).authorization!.authorization_digest)).code, "AUTHORIZATION_DIGEST_MISMATCH");
  assert.ok(w.gate.revalidations.includes("submit") === false, "refused before the gate was even asked");
  // a mock-mode service handed a sandbox provider (or the reverse) refuses
  const m = world(undefined, { provider: sandboxProvider({ client: () => ({ request: async (method: string, path: string) => {
    if (method === "GET" && path.startsWith("/transfers?request_id=")) return { status: 200, body: { items: [], has_more: false } }; // fixture: empty provider lookup
    throw new Error("never built"); // validate, create and read-by-id still cannot be reached
  } }) as never }) });
  const mid = await drive(m, "HUMAN_APPROVED");
  assert.equal((await submit(m, mid)).code, "PROVIDER_MODE_MISMATCH");
});

// ------------------------------------------------------------------------------------------------------------
// Replay and concurrency: exactly one create attempt (P5, P6)
// ------------------------------------------------------------------------------------------------------------

test("A3-09 twelve simultaneous submits in one process: exactly one intent and one create", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const digest = w.rec(id).authorization!.authorization_digest;
  const results = await Promise.all(Array.from({ length: 12 }, () => w.svc.submit(OPERATOR, id, digest)));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "DUPLICATE_SUBMISSION"), JSON.stringify(results));
  assert.deepEqual([w.provider.calls().create, w.provider.records().length, state(w, id)], [1, 1, "SUBMITTED"]);
  assert.equal(w.events(id).filter((e) => e.type === "SUBMIT_INTENT_RECORDED").length, 1);
  // replay after completion and a browser refresh of the submit form
  for (let i = 0; i < 3; i++) assert.equal((await w.svc.submit(OPERATOR, id, digest)).code, "DUPLICATE_SUBMISSION");
  assert.equal(w.provider.calls().create, 1);
});

test("A3-10 eight separate OS processes racing to submit the same flow: exactly one create", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const outs = (await Promise.all(Array.from({ length: 8 }, () => runChild(w, id, "none")))).map((r) => r.out!);
  assert.equal(outs.filter((o) => o.ok).length, 1, JSON.stringify(outs));
  assert.ok(outs.filter((o) => !o.ok).every((o) => o.code === "DUPLICATE_SUBMISSION"), JSON.stringify(outs));
  assert.deepEqual([w.provider.calls().create, w.provider.records().length, state(w, id)], [1, 1, "SUBMITTED"]);
  assert.equal(w.svc.getFlowView(id)!.audit.verified, true);
});

test("A3-11 concurrent approvals and approve-versus-reject: one decision commits; one gate result authorizes once", async () => {
  const w = world();
  const id = await drive(w, "AWAITING_HUMAN");
  const f = w.rec(id);
  const rs = await Promise.all([w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), Promise.resolve(w.svc.reject(OPERATOR, id, f.proposal_digest)), w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), w.svc.approve("human:second", id, f.proposal_digest, f.gate!.gate_digest)]);
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  assert.equal(w.events(id).filter((e) => e.type === "HUMAN_APPROVED" || e.type === "HUMAN_REJECTED").length, 1);
});

// ------------------------------------------------------------------------------------------------------------
// Failure injection at the provider (P6)
// ------------------------------------------------------------------------------------------------------------

test("A3-12 every unclear create answer is SUBMISSION_UNCERTAIN, is never retried, and resolves only by a matching read", async () => {
  const scripts: [NonNullable<MockScript["create"]>, boolean][] = [
    ["TIMEOUT_AFTER_SEND", true], ["HTTP_500_AFTER_SEND", true], ["HTTP_409_AFTER_SEND", true], ["MALFORMED_201", true], ["WRONG_ECHO_201", true],
    ["TIMEOUT_BEFORE_SEND", false], ["HTTP_500_BEFORE_SEND", false], ["HTTP_429_BEFORE_SEND", false],
  ];
  for (const [script, created] of scripts) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    w.provider.script.create = script;
    assert.deepEqual(await submit(w, id), { ok: false, code: "SUBMISSION_UNCERTAIN" }, script);
    assert.equal(state(w, id), "SUBMISSION_UNCERTAIN", script);
    w.provider.script.create = "ACCEPT"; // even if the provider would now accept, nothing asks it again
    for (let i = 0; i < 3; i++) assert.equal((await submit(w, id)).code, "DUPLICATE_SUBMISSION");
    assert.equal(w.provider.calls().create, 1, script);
    const r = await w.svc.reconcile(OPERATOR, id);
    if (created) {
      assert.deepEqual([r, state(w, id)], [{ ok: true, code: "PROVIDER_PROCESSING" }, "PROVIDER_PROCESSING"], script);
      assert.match(w.rec(id).submission.provider_transfer_id!, UUID);
    } else {
      assert.deepEqual([r, state(w, id)], [{ ok: false, code: "PROVIDER_HAS_NO_RECORD_FOR_REQUEST_ID" }, "SUBMISSION_UNCERTAIN"], `${script}: absence at the provider is not proof`);
      assert.equal(w.types(id).at(-1), "PROVIDER_READ_NO_CHANGE");
    }
    assert.equal(w.provider.calls().create, 1, script);
  }
  // a second create for a request id the provider already holds answers "duplicate": uncertain, never "accepted"
  assert.equal(classifyCreate({ kind: "HTTP", status: 400, body: { code: "request_id_duplicate" } }, "x").kind, "UNCERTAIN");
});

test("A3-13 a definite refusal is PROVIDER_REFUSED: terminal, not paid, never retried, nothing to reconcile", async () => {
  for (const script of ["REFUSE_400", "REFUSE_422"] as const) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    w.provider.script.create = script;
    assert.deepEqual(await submit(w, id), { ok: false, code: "PROVIDER_REFUSED" });
    w.provider.script.create = "ACCEPT";
    assert.equal((await submit(w, id)).code, "DUPLICATE_SUBMISSION");
    assert.equal((await w.svc.reconcile(OPERATOR, id)).code, "WRONG_STATE");
    assert.deepEqual([state(w, id), w.provider.calls().create, w.provider.records().length], ["PROVIDER_REFUSED", 1, 0]);
  }
});

test("A3-14 a read that fails, finds nothing, finds several or does not match this flow is audit-only", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  w.provider.script.create = "TIMEOUT_AFTER_SEND";
  await submit(w, id);
  const req = w.rec(id).proposal.provider_request_id;
  const version = w.rec(id).version;
  const expectNoChange = async (want: string) => {
    assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: false, code: want });
    assert.deepEqual([state(w, id), w.rec(id).version, w.rec(id).submission.last_provider_status], ["SUBMISSION_UNCERTAIN", version, null]);
  };
  w.provider.script.read = "TRANSPORT";
  await expectNoChange("MOCK_E_NETWORK");
  w.provider.script.read = "HTTP_503";
  await expectNoChange("RECONCILE_HTTP_STATUS");
  w.provider.script.read = "OK";
  const orig = { ...w.provider.records()[0] };
  for (const patch of [{ transfer_amount: "500.00" }, { transfer_amount: "5.001" }, { transfer_amount: "not money" }, { transfer_currency: "EUR" }, { beneficiary_id: "someone-else" }, { id: "not-a-uuid" }]) {
    w.provider.alter(req, { ...patch, status: "PAID" });
    await expectNoChange(patch.id ? "UNRECOGNIZED_PROVIDER_RESPONSE" : "PROVIDER_RECORD_MISMATCH"); // a mismatched record saying PAID is not our payment
    w.provider.alter(req, orig);
  }
  w.provider.duplicate(req);
  await expectNoChange("PROVIDER_HAS_MULTIPLE_RECORDS");
  assert.equal(w.provider.calls().create, 1);
  // once the transfer id is known, a record under a different id is a mismatch
  const v = world();
  const vid = await drive(v, "HUMAN_APPROVED");
  await submit(v, vid);
  const p = v.rec(vid).proposal;
  assert.equal(classifyRead({ kind: "HTTP", status: 200, body: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "PAID", request_id: p.provider_request_id, transfer_amount: "5.00", transfer_currency: "USD" } }, p, v.rec(vid).submission.provider_transfer_id).kind, "NO_CHANGE");
  assert.equal((await v.svc.reconcile(OPERATOR, vid)).code, "PROVIDER_PROCESSING");
});

// ------------------------------------------------------------------------------------------------------------
// Crash and restart: a real SIGKILL of a separate process at each of the three points (P6)
// ------------------------------------------------------------------------------------------------------------

test("A3-15 crash BEFORE the intent: HUMAN_APPROVED, nothing sent; the approval is still usable exactly once after restart", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  assert.equal((await runChild(w, id, "beforeIntent")).signal, "SIGKILL");
  const r = world(w.dir, { clock: w.clock }); // restart
  const f = r.rec(id);
  assert.deepEqual([f.state, f.submission.attempt_id, f.authorization_consumed_at_ms, r.provider.calls().create], ["HUMAN_APPROVED", null, null, 0]);
  assert.equal((await submit(r, id)).code, "SUBMITTED");
  assert.equal((await submit(r, id)).code, "DUPLICATE_SUBMISSION");
  assert.equal(r.provider.calls().create, 1);
});

test("A3-16 crash AFTER the intent, BEFORE the network call: the intent survives; recovery marks it UNCERTAIN and never creates", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  assert.equal((await runChild(w, id, "afterIntent")).signal, "SIGKILL");
  const r = world(w.dir, { clock: w.clock }); // restart immediately: the intent is younger than INTENT_STALE_MS
  assert.equal(state(r, id), "SUBMIT_INTENT_RECORDED", "the committed intent survived the kill");
  assert.match(r.rec(id).submission.attempt_id!, UUID);
  assert.deepEqual(await r.svc.reconcile(OPERATOR, id), { ok: false, code: "SUBMISSION_IN_FLIGHT" });
  assert.equal((await submit(r, id)).code, "DUPLICATE_SUBMISSION");
  r.clock.t += INTENT_STALE_MS;
  const r2 = world(w.dir, { clock: r.clock }); // a later restart recovers the stale intent on the way in
  assert.equal(state(r2, id), "SUBMISSION_UNCERTAIN");
  assert.equal(r2.types(id).at(-1), "STALE_INTENT_RECOVERED");
  assert.equal((await submit(r2, id)).code, "DUPLICATE_SUBMISSION");
  assert.deepEqual([await r2.svc.reconcile(OPERATOR, id), state(r2, id)], [{ ok: false, code: "PROVIDER_HAS_NO_RECORD_FOR_REQUEST_ID" }, "SUBMISSION_UNCERTAIN"]);
  assert.deepEqual([r2.provider.calls().create, r2.provider.records().length], [0, 0], "recovery and reconciliation never create");
});

test("A3-17 crash AFTER the network call, BEFORE the answer is recorded: one transfer exists; a read finds it; nothing is resent", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  assert.equal((await runChild(w, id, "afterCreate")).signal, "SIGKILL");
  const r = world(w.dir, { clock: w.clock });
  assert.deepEqual([state(r, id), r.provider.calls().create, r.rec(id).submission.provider_transfer_id], ["SUBMIT_INTENT_RECORDED", 1, null]);
  r.clock.t += INTENT_STALE_MS;
  // reconcile on a stale intent first records recover_stale_intent, then only reads
  assert.deepEqual(await r.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PROCESSING" });
  assert.deepEqual(r.types(id).slice(-3), ["SUBMIT_INTENT_RECORDED", "STALE_INTENT_RECOVERED", "PROVIDER_READ"]);
  assert.equal((await submit(r, id)).code, "DUPLICATE_SUBMISSION");
  const r3 = world(w.dir, { clock: r.clock }); // a third restart changes nothing
  assert.deepEqual([state(r3, id), r3.provider.calls().create, r3.svc.getFlowView(id)!.audit.verified], ["PROVIDER_PROCESSING", 1, true]);
});

test("A3-18 an answer that arrives after stale-intent recovery does not overwrite UNCERTAIN; only a read moves the flow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbflow-a3-"));
  const clock = { t: T0 };
  let other: World | null = null;
  const w = world(dir, { clock, hooks: { afterCreate: () => {
    clock.t += INTENT_STALE_MS; // the create took longer than the stale window ...
    other = world(dir, { clock }); // ... and another process started and recovered the intent
  } } });
  const id = await drive(w, "HUMAN_APPROVED");
  assert.deepEqual(await submit(w, id), { ok: false, code: "SUBMISSION_UNCERTAIN" });
  assert.equal(state(w, id), "SUBMISSION_UNCERTAIN");
  assert.deepEqual(w.types(id).slice(-3), ["SUBMIT_INTENT_RECORDED", "STALE_INTENT_RECOVERED", "LATE_CREATE_RESPONSE"]);
  assert.equal(w.provider.calls().create, 1);
  assert.deepEqual(await other!.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PROCESSING" });
  assert.equal(w.provider.calls().create, 1);
});

// ------------------------------------------------------------------------------------------------------------
// Store durability and the audit port
// ------------------------------------------------------------------------------------------------------------

test("A3-19 no durable store, no service: every operation refuses INTEGRATED_STORE_UNAVAILABLE; there is no in-memory fallback", async () => {
  const blocked = join(mkdtempSync(join(tmpdir(), "dbflow-a3-")), "not-a-directory");
  writeFileSync(blocked, "a file where the data directory should be");
  for (const dataDir of ["relative/dir", ":memory:", blocked]) {
    const w = world(undefined, { dataDir });
    const U = { ok: false, code: "INTEGRATED_STORE_UNAVAILABLE" };
    assert.deepEqual(w.svc.createFlow(OPERATOR, CASE), U);
    assert.deepEqual(w.svc.attachEvidence(OPERATOR, "x", { kind: "FIXTURE_REPLAY", document_id: DOC }), U);
    assert.deepEqual(await w.svc.evaluateGate(OPERATOR, "x"), U);
    assert.deepEqual(await w.svc.requestHumanReview(OPERATOR, "x"), U);
    assert.deepEqual(await w.svc.approve(OPERATOR, "x", "a", "b"), U);
    assert.deepEqual(w.svc.reject(OPERATOR, "x", "a"), U);
    assert.deepEqual(await w.svc.submit(OPERATOR, "x", "a"), U);
    assert.deepEqual(await w.svc.reconcile(OPERATOR, "x"), U);
    assert.deepEqual([w.svc.getFlow("x"), w.svc.getFlowView("x"), w.svc.listFlowViews()], [null, null, []]);
  }
  assert.throws(() => openFlowStore("relative"), /INTEGRATED_STORE_UNAVAILABLE/);
  const junk = mkdtempSync(join(tmpdir(), "dbflow-a3-"));
  writeFileSync(join(junk, "flow-v1.sqlite"), "this is not a database, not at all, definitely not an sqlite file!!");
  assert.throws(() => openFlowStore(junk), /INTEGRATED_STORE_UNAVAILABLE/);

  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const before = w.rec(id);
  assert.equal(statSync(w.deps.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(w.deps.dataDir, "flow-v1.sqlite")).mode & 0o777, 0o600);
  const s = openFlowStore(w.deps.dataDir, w.deps.audit.ddl);
  assert.equal((s.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((s.db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
  assert.equal((s.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  s.close();
  assert.deepEqual(world(w.dir, { clock: w.clock }).rec(id), before, "the record survives a restart unchanged");
  chmodSync(w.deps.dataDir, 0o755);
  world(w.dir, { clock: w.clock });
  assert.equal(statSync(w.deps.dataDir).mode & 0o777, 0o700, "the data directory is returned to 0700");
  rawSql(w, "INSERT INTO flow_legal_transition VALUES ('GATE_HOLD','HUMAN_APPROVED')");
  assert.equal(world(w.dir, { clock: w.clock }).svc.createFlow(OPERATOR, CASE).code, "INTEGRATED_STORE_UNAVAILABLE", "a widened transition table on disk is refused");
});

test("A3-20 state and audit commit together: a failed audit append rolls the transition back; a broken chain refuses everything", async () => {
  const w = world();
  const id = await drive(w, "AWAITING_HUMAN");
  const f = w.rec(id);
  w.audit.failOnType = "HUMAN_APPROVED";
  assert.deepEqual(await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: "AUDIT_FIELD_REFUSED" });
  assert.deepEqual([state(w, id), w.rec(id).authorization, w.rec(id).gate_consumed_at_ms], ["AWAITING_HUMAN", null, null], "no approval without its audit event");
  w.audit.failOnType = null;
  assert.equal((await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest)).code, "HUMAN_APPROVED");
  w.audit.failOnType = "SUBMIT_INTENT_RECORDED";
  assert.equal((await submit(w, id)).code, "AUDIT_FIELD_REFUSED");
  assert.deepEqual([state(w, id), w.rec(id).submission.attempt_id, w.provider.calls().create], ["HUMAN_APPROVED", null, 0], "no intent without its audit event, so nothing is sent");
  w.audit.failOnType = null;
  // no audit data key in this lane trips the forbidden-key rule (the fake audit port enforces it on every append)
  assert.equal((await submit(w, id)).code, "SUBMITTED");
  assert.equal((await w.svc.reconcile(OPERATOR, id)).code, "PROVIDER_PROCESSING");
  assert.equal(w.svc.getFlowView(id)!.audit.verified, true);
  assert.equal(w.rec(id).audit_head, w.svc.getFlowView(id)!.audit.head);

  rawSql(w, `UPDATE a3_test_audit SET body = replace(body, '"HUMAN_APPROVED"', '"HUMAN_REJECTED"') WHERE flow_id='${id}'`);
  const B = { ok: false, code: "AUDIT_CHAIN_BROKEN" };
  assert.deepEqual(w.svc.createFlow(OPERATOR, CASE), B);
  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), B);
  assert.deepEqual(await submit(w, id), B);
  assert.deepEqual([w.svc.getFlowView(id)!.audit.verified, w.svc.getFlowView(id)!.audit.code], [false, "AUDIT_CHAIN_BROKEN"]);
});

// ------------------------------------------------------------------------------------------------------------
// Evidence, display reasons, ledger rule (R4), sandbox adapter (mocked transport), classification
// ------------------------------------------------------------------------------------------------------------

test("A3-21 evidence is looked up server-side and is immutable once attached", async () => {
  const w = world();
  const id = await drive(w, "DRAFT");
  assert.equal(w.svc.attachEvidence(OPERATOR, id, { kind: "FIXTURE_REPLAY", document_id: "DOC-UNKNOWN" }).code, "REPLAY_DOCUMENT_NOT_FOUND");
  assert.equal(w.svc.attachEvidence(OPERATOR, id, { kind: "AGENT_RUN", run_id: "missing" }).code, "AGENT_RUN_NOT_FOUND");
  for (const junk of [null, {}, { kind: "TEXT", text: "pay me" }, { kind: "FIXTURE_REPLAY", document_id: "../etc" }, { kind: "AGENT_RUN", run_id: 5 }]) assert.equal(w.svc.attachEvidence(OPERATOR, id, junk as never).code, "EVIDENCE_REFERENCE_INVALID");
  w.runs.set("run-bad-claims", { evidence: "text", claims: { reference: 5 } });
  assert.equal(w.svc.attachEvidence(OPERATOR, id, { kind: "AGENT_RUN", run_id: "run-bad-claims" }).code, "CLAIMS_UNUSABLE");
  w.runs.set("run-long", { evidence: "x".repeat(8001), claims: null });
  assert.equal(w.svc.attachEvidence(OPERATOR, id, { kind: "AGENT_RUN", run_id: "run-long" }).code, "EVIDENCE_TEXT_INVALID");
  assert.equal(state(w, id), "DRAFT");
  w.runs.set("run-1", { evidence: "INVOICE from an agent run", claims: null });
  assert.deepEqual(w.svc.attachEvidence(OPERATOR, id, { kind: "AGENT_RUN", run_id: "run-1" }), { ok: true, code: "EVIDENCE_READY" });
  assert.equal(w.svc.attachEvidence(OPERATOR, id, { kind: "FIXTURE_REPLAY", document_id: DOC }).code, "WRONG_STATE");
  w.runs.set("run-1", { evidence: "EDITED AFTER ATTACH", claims: null }); // the run store changing later changes nothing here
  await w.svc.evaluateGate(OPERATOR, id);
  assert.equal(w.rec(id).gate!.evidence_source, "AGENT_RUN");
  assert.ok(!JSON.stringify(w.events(id)).includes("INVOICE from an agent run"), "evidence text is never written to the audit chain");
  assert.equal(w.svc.createFlow(OPERATOR, CASE).ok, true);
  w.proposalPatch.amount_minor = "5.5";
  assert.equal(w.svc.createFlow(OPERATOR, CASE).code, "INVALID_AMOUNT");
  w.proposalPatch.amount_minor = "500";
  w.proposalPatch.flow_id = "11111111-1111-4111-8111-111111111111"; // a builder that ignores the ids it was given
  assert.equal(w.svc.createFlow(OPERATOR, CASE).code, "PROPOSAL_SHAPE");
});

test("A3-22 proof reasons are display-only: kept when the published gate reproduces the record exactly, empty and flagged otherwise", async () => {
  // fake gate result that the published gate does not reproduce on this registry -> empty reasons + audit flag
  const w = world();
  const id = await drive(w, "GATE");
  assert.ok(w.types(id).includes("GATE_REASON_MISMATCH"));
  assert.ok(PROOF_IDS.every((k) => w.svc.getFlowView(id)!.gate!.proof_reasons[k] === ""));
  assert.equal(state(w, id), "GATE_ELIGIBLE", "the reason text has no effect on the decision");
  // a gate port that IS the published gate on the published synthetic registry -> reasons kept
  const v = world();
  v.deps.registry = SYNTHETIC_REGISTRY;
  const real = v.deps.gate.evaluateAndBind;
  v.gate.mutate = null;
  v.deps.gate.evaluateAndBind = (input) => {
    const ev = evaluate(input.evidence_text, input.claims, input.registry, input.balance_usd);
    const g = real(input);
    const { gate_digest: _d, ...rest } = g;
    const out = { ...rest, decision: ev.decision, rule: ev.rule, document_binding: ev.document.binding, document_id: ev.document.document_id, proof_states: Object.fromEntries(PROOF_IDS.map((k) => [k, ev.proofs.find((p) => p.id === k)!.state])) as GateRecord["proof_states"] };
    return { ...out, gate_digest: gateDigest(out) };
  };
  const svc = createFlowService(v.deps);
  const c = svc.createFlow(OPERATOR, CASE);
  svc.attachEvidence(OPERATOR, c.flow_id!, { kind: "FIXTURE_REPLAY", document_id: DOC });
  const r = await svc.evaluateGate(OPERATOR, c.flow_id!);
  assert.equal(r.ok, true);
  const view = svc.getFlowView(c.flow_id!)!;
  assert.ok(!v.types(c.flow_id!).includes("GATE_REASON_MISMATCH"));
  assert.ok(PROOF_IDS.every((k) => view.gate!.proof_reasons[k].length > 0), JSON.stringify(view.gate!.proof_reasons));
  assert.notEqual(view.state, "GATE_ELIGIBLE", "an unregistered text is not eligible on the published registry");
});

test("A3-23 ledger rule (R4): one reduction, only after an accepted create or the first matching read out of UNCERTAIN; never a payment authority", async () => {
  const accepted = world(undefined, { ledger: true });
  const id = await drive(accepted, "HUMAN_APPROVED");
  assert.equal(accepted.ledger.reductions.length, 0, "no reduction at funding check, review or approval");
  await submit(accepted, id);
  const f = accepted.rec(id);
  assert.deepEqual(accepted.ledger.reductions, [{ flow_id: id, idempotency_key: f.proposal.provider_request_id, authorization_id: f.authorization!.authorization_digest }]);
  assert.deepEqual([f.ledger!.allocation_id, f.ledger!.reduction_event_id], ["ALLOC-SBX-0002", "red-1"]);
  assert.equal(accepted.svc.getFlowView(id)!.ledger!.label, "drawn against allocation");
  await accepted.svc.reconcile(OPERATOR, id);
  await accepted.svc.reconcile(OPERATOR, id);
  assert.equal(accepted.ledger.reductions.length, 1, "later reads never post again");
  assert.ok(accepted.ledger.checks >= 3, "funding is checked at review, approval and submit");

  for (const script of ["REFUSE_400", "TIMEOUT_BEFORE_SEND", "HTTP_500_AFTER_SEND"] as const) {
    const w = world(undefined, { ledger: true });
    const wid = await drive(w, "HUMAN_APPROVED");
    w.provider.script.create = script;
    await submit(w, wid);
    assert.equal(w.ledger.reductions.length, 0, `${script}: no reduction on refused or uncertain`);
    if (script === "HTTP_500_AFTER_SEND") {
      await w.svc.reconcile(OPERATOR, wid); // the first matching read out of UNCERTAIN
      assert.equal(w.ledger.reductions.length, 1);
      await w.svc.reconcile(OPERATOR, wid);
      assert.equal(w.ledger.reductions.length, 1);
    } else if (script === "TIMEOUT_BEFORE_SEND") {
      await w.svc.reconcile(OPERATOR, wid); // no record: still uncertain, still no reduction
      assert.equal(w.ledger.reductions.length, 0);
    }
  }
  const v = world(undefined, { ledger: true });
  const vid = await drive(v, "HUMAN_APPROVED");
  v.provider.script.validate = "REFUSE_400";
  await submit(v, vid);
  assert.equal(v.ledger.reductions.length, 0, "no reduction on validation failure");
  v.provider.script.validate = "OK";
  v.ledger.fund = "INSUFFICIENT_FUNDING";
  assert.deepEqual([await submit(v, vid), state(v, vid), v.provider.calls().create], [{ ok: false, code: "INSUFFICIENT_FUNDING" }, "HUMAN_APPROVED", 0]);
  v.ledger.fund = null;
  v.ledger.reduce = "LEDGER_DOWN"; // a ledger failure is audit-only and never changes payment state
  assert.equal((await submit(v, vid)).code, "SUBMITTED");
  assert.deepEqual([state(v, vid), v.rec(vid).ledger!.reduction_event_id, v.types(vid).at(-1)], ["SUBMITTED", null, "LEDGER_REDUCTION_FAILED"]);
  const n = world(undefined, { ledger: true });
  n.ledger.fund = "INSUFFICIENT_FUNDING";
  const nid = await drive(n, "GATE");
  assert.deepEqual([await n.svc.requestHumanReview(OPERATOR, nid), state(n, nid)], [{ ok: false, code: "INSUFFICIENT_FUNDING" }, "GATE_ELIGIBLE"]);
});

function sandboxWorld(route: (url: string, body: Record<string, unknown> | null) => { status: number; json?: unknown } | "timeout", o: { release?: (id: string, digest: string) => string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dbflow-a3-"));
  const cred = join(dir, ".env.transfer");
  writeFileSync(cred, `AWX_ENV=sandbox\nAWX_BASE_URL=${AWX_BASE}\nAWX_TRANSFER_CLIENT_ID=SENTINEL-CLIENT\nAWX_TRANSFER_API_KEY=SENTINEL-KEY-0123456789\n`);
  chmodSync(cred, 0o600);
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url === `${AWX_BASE}/authentication/login`) return new Response(JSON.stringify({ token: "SENTINEL-TOKEN", expires_at: "2099-01-01T00:00:00+0000" }), { status: 201 });
    calls.push({ url, method: String(init.method), body });
    const r = route(url, body);
    if (r === "timeout") throw new Error("socket hang up");
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  };
  let client: SandboxClient | null = null;
  const w = world(dir, { providerMode: "sandbox", provider: sandboxProvider({ client: () => (client ??= new SandboxClient("transfer", { envPath: cred, fetchImpl })) }) });
  return { w, calls, creates: () => calls.filter((c) => c.url.endsWith("/transfers/create")), o };
}
const PID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("A3-24 sandbox adapter (mocked transport only): owner release for the exact transaction, exact body, sandbox host only, store-wide limit of one", async () => {
  const { w, calls, creates } = sandboxWorld((url, body) => (url.includes("/transfers?request_id=") ? { status: 200, json: { items: [], has_more: false } } : url.endsWith("/transfers/validate") ? { status: 200 } : url.endsWith("/transfers/create")
    ? { status: 201, json: { id: PID, status: "PROCESSING", request_id: body!.request_id, transfer_amount: 5.0, transfer_currency: "USD" } }
    : { status: 200, json: { id: PID, status: "PROCESSING", request_id: decodeURIComponent(url).includes(PID) ? (calls.find((c) => c.url.endsWith("/transfers/create"))!.body!.request_id) : "", transfer_amount: "5.00", transfer_currency: "USD" } }));
  const id = await drive(w, "HUMAN_APPROVED");
  const f = w.rec(id);
  const ad = f.authorization!.authorization_digest;
  assert.equal((await submit(w, id)).code, "OWNER_RELEASE_MISSING");
  for (const wrong of [`${id}:${"0".repeat(64)}`, `${f.proposal.provider_request_id}:${ad}`, ad, `${id}:${f.proposal_digest}`]) {
    w.deps.submitRelease = wrong;
    assert.equal((await submit(w, id)).code, "OWNER_RELEASE_MISSING");
  }
  // Owner ruling (candidate 3): the approval-time request-id lookup is the ONE provider contact allowed before the
  // owner release. It is a read for exactly this flow's bound request id. Nothing else, and no write, may appear.
  const lookup = { url: `${AWX_BASE}/transfers?request_id=${f.proposal.provider_request_id}`, method: "GET", body: null };
  assert.deepEqual(calls, [lookup], "exactly one read-only approval-time lookup for this flow's request id; no validate, no create and no other provider contact without the owner release");
  w.deps.submitRelease = `${id}:${ad}`;
  assert.deepEqual(await submit(w, id), { ok: true, code: "SUBMITTED" });
  // `calls` is cumulative: entry 0 is the approval-time lookup asserted above; the submit adds exactly
  // lookup -> validate -> lookup -> create, each with this flow's request id and the exact transfer body.
  const transferBody = providerBody(f.proposal);
  assert.deepEqual(calls, [
    lookup, // approve
    lookup, // submit: before validate
    { url: `${AWX_BASE}/transfers/validate`, method: "POST", body: transferBody },
    lookup, // submit: after the durable intent, before create
    { url: `${AWX_BASE}/transfers/create`, method: "POST", body: transferBody },
  ], "approval lookup, then exactly lookup, validate, lookup, create; any additional, missing or unexpected call fails");
  assert.deepEqual(creates()[0].body, { beneficiary_id: BEN, transfer_amount: "5.00", transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reason: "goods_purchased", reference: "DB-SBX-0002", request_id: f.proposal.provider_request_id });
  assert.deepEqual(creates()[0].body, providerBody(f.proposal));
  assert.ok(calls.every((c) => c.url.startsWith(`${AWX_BASE}/`)));
  assert.equal(w.rec(id).submission.provider_mode, "sandbox");
  assert.deepEqual(await w.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PROCESSING" });
  assert.equal(calls.at(-1)!.url, `${AWX_BASE}/transfers/${PID}`);
  assert.equal((await submit(w, id)).code, "DUPLICATE_SUBMISSION");
  // sandbox mode: at most one submit attempt in the whole store, ever (mirrors the historic workflow's limit)
  const second = await drive(w, "HUMAN_APPROVED");
  w.deps.submitRelease = `${second}:${w.rec(second).authorization!.authorization_digest}`;
  assert.equal((await submit(w, second)).code, "SUBMISSION_LIMIT_REACHED");
  assert.throws(() => rawSql(w, `INSERT INTO flow_submit_attempt VALUES ('${second}','${w.rec(second).proposal.provider_request_id}','att-2','${w.rec(second).authorization!.authorization_digest}',1,'sandbox')`), /SUBMISSION_LIMIT_REACHED/);
  assert.equal(creates().length, 1);
  assert.ok(!JSON.stringify(w.events(id)).includes("SENTINEL"), "no credential material on the audit chain");
});

test("A3-25 sandbox adapter: validation must be 200; timeout, 5xx, 409, 429, duplicate and malformed are UNCERTAIN; 4xx is a definite refusal; missing credential fails closed", async () => {
  const outcomes: [{ status: number; json?: unknown } | "timeout", FlowState][] = [
    ["timeout", "SUBMISSION_UNCERTAIN"], [{ status: 500 }, "SUBMISSION_UNCERTAIN"], [{ status: 502 }, "SUBMISSION_UNCERTAIN"], [{ status: 409 }, "SUBMISSION_UNCERTAIN"], [{ status: 429 }, "SUBMISSION_UNCERTAIN"],
    [{ status: 400, json: { code: "request_id_duplicate" } }, "SUBMISSION_UNCERTAIN"], [{ status: 201, json: { id: PID, status: "PROCESSING", request_id: "not-ours" } }, "SUBMISSION_UNCERTAIN"],
    [{ status: 201, json: { id: PID, status: "MYSTERY" } }, "SUBMISSION_UNCERTAIN"], [{ status: 200, json: {} }, "SUBMISSION_UNCERTAIN"],
    [{ status: 400, json: { code: "invalid_argument" } }, "PROVIDER_REFUSED"], [{ status: 401 }, "PROVIDER_REFUSED"], [{ status: 403 }, "PROVIDER_REFUSED"], [{ status: 404 }, "PROVIDER_REFUSED"], [{ status: 422, json: {} }, "PROVIDER_REFUSED"],
  ];
  for (const [reply, want] of outcomes) {
    const { w, creates } = sandboxWorld((url) => (url.endsWith("/transfers/validate") ? { status: 200 } : url.endsWith("/transfers/create") ? reply : { status: 200, json: { items: [], has_more: false } }));
    const id = await drive(w, "HUMAN_APPROVED");
    w.deps.submitRelease = `${id}:${w.rec(id).authorization!.authorization_digest}`;
    await submit(w, id);
    assert.equal(state(w, id), want, JSON.stringify(reply));
    assert.equal((await submit(w, id)).code, "DUPLICATE_SUBMISSION");
    if (want === "SUBMISSION_UNCERTAIN") assert.deepEqual([await w.svc.reconcile(OPERATOR, id), state(w, id)], [{ ok: false, code: "PROVIDER_HAS_NO_RECORD_FOR_REQUEST_ID" }, "SUBMISSION_UNCERTAIN"]);
    assert.equal(creates().length, 1, JSON.stringify(reply));
  }
  for (const v of [{ status: 400, json: { code: "invalid_argument" } }, { status: 500 }, { status: 201 }, "timeout"] as const) {
    const { w, creates } = sandboxWorld((url) => (url.includes("/transfers?request_id=") ? { status: 200, json: { items: [], has_more: false } } : url.endsWith("/transfers/validate") ? v : { status: 201 }));
    const id = await drive(w, "HUMAN_APPROVED");
    w.deps.submitRelease = `${id}:${w.rec(id).authorization!.authorization_digest}`;
    assert.deepEqual([await submit(w, id), state(w, id), w.rec(id).submission.attempt_id, creates().length], [{ ok: false, code: "PROVIDER_VALIDATION_FAILED" }, "HUMAN_APPROVED", null, 0]);
  }
  // no transfer credential configured: the default sandbox provider cannot validate, so no intent is ever recorded
  const saved = process.env.AWX_TRANSFER_ENV_FILE;
  delete process.env.AWX_TRANSFER_ENV_FILE;
  try {
    const p = sandboxProvider();
    const body = providerBody({ flow_id: "11111111-1111-4111-8111-111111111111", obligation_id: CASE, payee: "p", beneficiary_id: BEN, beneficiary_label: BEN_LABEL, amount_minor: "500", currency: "USD", reference: "R", transfer_method: "LOCAL", reason: "goods_purchased", provider_request_id: "22222222-2222-4222-8222-222222222222" });
    assert.deepEqual(await p.validate(body), { kind: "TRANSPORT_ERROR", code: "AWX_E_CRED_FILE_NOT_CONFIGURED" });
    assert.deepEqual(await p.create(body), { kind: "TRANSPORT_ERROR", code: "AWX_E_CRED_FILE_NOT_CONFIGURED" });
    assert.equal(p.mode, "sandbox");
  } finally {
    if (saved !== undefined) process.env.AWX_TRANSFER_ENV_FILE = saved;
  }
});

test("A3-26 classification rules and the mock provider's own behavior", async () => {
  const req = "22222222-2222-4222-8222-222222222222";
  const acc = (status: number, body: unknown): ProviderCallResult => ({ kind: "HTTP", status, body });
  assert.equal(classifyCreate(acc(201, { id: PID, status: "PROCESSING", request_id: req }), req).kind, "ACCEPTED");
  assert.equal(classifyCreate(acc(200, { id: PID, status: "PAID", request_id: req }), req).kind, "ACCEPTED");
  for (const r of [null, undefined, {}, { kind: "OTHER" }, acc(201, null), acc(201, { id: "x", status: "PROCESSING", request_id: req }), acc(201, { id: PID, status: "DONE", request_id: req }), acc(201, { id: PID, status: "PROCESSING" }), acc(202, { id: PID, status: "PROCESSING", request_id: req }), acc(301, {}), acc(408, {}), acc(503, {}), { kind: "TRANSPORT_ERROR", code: "x" }, { kind: "HTTP", status: "201", body: {} }]) {
    assert.equal(classifyCreate(r as never, req).kind, "UNCERTAIN", JSON.stringify(r));
  }
  for (const s of [400, 401, 403, 404, 422]) assert.equal(classifyCreate(acc(s, { code: "nope" }), req).kind, "REFUSED");
  assert.deepEqual([...MOCK_ALLOWLIST], [["00000000-0000-4000-8000-0000000000be", "Synthetic test supplier"]]);
  const m = mockProvider();
  const body = providerBody({ flow_id: "11111111-1111-4111-8111-111111111111", obligation_id: CASE, payee: "p", beneficiary_id: BEN, beneficiary_label: BEN_LABEL, amount_minor: "123456", currency: "USD", reference: "R", transfer_method: "LOCAL", reason: "goods_purchased", provider_request_id: req });
  assert.equal(body.transfer_amount, "1234.56");
  assert.equal(m.mode, "mock");
  const first = await m.create(body);
  assert.equal(classifyCreate(first, req).kind, "ACCEPTED");
  assert.equal(classifyCreate(await m.create(body), req).kind, "UNCERTAIN", "the provider's own idempotency answers duplicate");
  assert.deepEqual([m.records().length, m.calls().create], [1, 2]);
  assert.throws(() => mockProvider({ stateFile: "relative.json" }), /MOCK_STATE_PATH_NOT_ABSOLUTE/);
  void fakeAudit;
});

// ------------------------------------------------------------------------------------------------------------
// Owner directive 8: state persistence before provider execution, and consumed gate / authorization replay
// ------------------------------------------------------------------------------------------------------------

test("A3-27 the submit intent is committed and visible from a SECOND connection before provider.create is entered", async () => {
  const w = world();
  const inner = w.deps.provider;
  type Seen = { state: string; version: number; attempt_id: string | null; consumed: number | null; attempts: number; intentEvents: number };
  const look = (id: string): Seen => {
    // a brand new connection: it can only see what has been COMMITTED by the service's connection
    const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(join(w.deps.dataDir, "flow-v1.sqlite"));
    try {
      const row = db.prepare("SELECT state, version, attempt_id, authorization_consumed_at_ms AS consumed FROM flow WHERE flow_id = ?").get(id) as { state: string; version: number; attempt_id: string | null; consumed: number | null };
      const attempts = (db.prepare("SELECT count(*) AS n FROM flow_submit_attempt WHERE flow_id = ?").get(id) as { n: number }).n;
      const intentEvents = (db.prepare("SELECT count(*) AS n FROM a3_test_audit WHERE flow_id = ? AND body LIKE '%\"SUBMIT_INTENT_RECORDED\"%'").get(id) as { n: number }).n;
      return { ...row, attempts: Number(attempts), intentEvents: Number(intentEvents) };
    } finally {
      db.close();
    }
  };
  let atValidate: Seen | null = null, atCreate: Seen | null = null, flowId = "";
  w.deps.provider = {
    mode: "mock",
    validate: async (b) => ((atValidate = look(flowId)), inner.validate(b)),
    create: async (b) => ((atCreate = look(flowId)), inner.create(b)),
    readById: (x) => inner.readById(x),
    readByRequestId: (x) => inner.readByRequestId(x),
  };
  const svc = createFlowService(w.deps);
  flowId = await drive({ ...w, svc }, "HUMAN_APPROVED");
  const approvedVersion = svc.getFlow(flowId)!.version;
  assert.deepEqual(await svc.submit(OPERATOR, flowId, svc.getFlow(flowId)!.authorization!.authorization_digest), { ok: true, code: "SUBMITTED" });
  assert.deepEqual(atValidate, { state: "HUMAN_APPROVED", version: approvedVersion, attempt_id: null, consumed: null, attempts: 0, intentEvents: 0 }, "validate runs before any intent exists");
  assert.equal(atCreate!.state, "SUBMIT_INTENT_RECORDED");
  assert.deepEqual([atCreate!.version, atCreate!.attempts, atCreate!.intentEvents], [approvedVersion + 1, 1, 1]);
  assert.match(atCreate!.attempt_id!, UUID);
  assert.notEqual(atCreate!.consumed, null, "the authorization is already consumed, durably, when create is entered");
  assert.equal(w.provider.calls().create, 1);
});

test("A3-28 a consumed gate result and a consumed authorization cannot be replayed, through the service or in the database", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const f = w.rec(id);
  const [pd, gd, ad] = [f.proposal_digest, f.gate!.gate_digest, f.authorization!.authorization_digest];
  assert.notEqual(f.gate_consumed_at_ms, null);
  // consumed gate: no second approval for this flow, by any human, and no second authorization row for this gate result
  for (const who of [OPERATOR, "human:second"]) assert.equal((await w.svc.approve(who, id, pd, gd)).code, "WRONG_STATE");
  assert.throws(() => rawSql(w, `INSERT INTO flow_authorization VALUES ('${id}','${gd}','${"c".repeat(64)}','${pd}','human:second',1,2,3,'${"d".repeat(64)}')`), /AUTHORIZATION_|constraint/);
  assert.throws(() => rawSql(w, `UPDATE flow SET gate_consumed_at_ms = NULL WHERE flow_id='${id}'`), /FLOW_/);
  assert.throws(() => rawSql(w, `UPDATE flow_authorization SET expires_at_ms = expires_at_ms + 999999 WHERE flow_id='${id}'`), /AUTHORIZATION_IMMUTABLE/);
  assert.throws(() => rawSql(w, `DELETE FROM flow_authorization WHERE flow_id='${id}'`), /AUTHORIZATION_IMMUTABLE/);
  // a gate result belongs to one flow: a second flow cannot be approved with the first flow's digests
  const other = await drive(w, "AWAITING_HUMAN");
  assert.equal((await w.svc.approve(OPERATOR, other, pd, gd)).code, "PROPOSAL_DIGEST_MISMATCH");
  assert.equal((await w.svc.approve(OPERATOR, other, w.rec(other).proposal_digest, gd)).code, "GATE_DIGEST_MISMATCH");

  // consumed authorization: one submit, then every replay is refused and nothing more is sent
  assert.equal((await w.svc.submit(OPERATOR, id, ad)).code, "SUBMITTED");
  assert.notEqual(w.rec(id).authorization_consumed_at_ms, null);
  for (let i = 0; i < 3; i++) assert.equal((await w.svc.submit(OPERATOR, id, ad)).code, "DUPLICATE_SUBMISSION");
  assert.throws(() => rawSql(w, `INSERT INTO flow_submit_attempt VALUES ('${id}','${f.proposal.provider_request_id}','att-2','${ad}',1,'mock')`), /ATTEMPT_|constraint/);
  assert.throws(() => rawSql(w, `UPDATE flow SET authorization_consumed_at_ms = NULL WHERE flow_id='${id}'`), /FLOW_/);
  assert.throws(() => rawSql(w, `DELETE FROM flow_submit_attempt WHERE flow_id='${id}'`), /ATTEMPT_IMMUTABLE/);
  // the authorization of flow A cannot submit flow B, even after B is approved
  const fo = w.rec(other);
  await w.svc.approve(OPERATOR, other, fo.proposal_digest, fo.gate!.gate_digest);
  assert.equal((await w.svc.submit(OPERATOR, other, ad)).code, "AUTHORIZATION_DIGEST_MISMATCH");
  assert.equal(w.provider.calls().create, 1);
});

// ------------------------------------------------------------------------------------------------------------
// Owner proof list (flow-v1.1.1): fourth crash boundary, two service instances, non-WAL store, forged gate record
// ------------------------------------------------------------------------------------------------------------

test("A3-29 crash AFTER the provider read answered, BEFORE the reconcile write: state unchanged, nothing resent, the next read records it", async () => {
  for (const script of ["ACCEPT", "TIMEOUT_AFTER_SEND"] as const) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    w.provider.script.create = script;
    await submit(w, id);
    const before = w.rec(id);
    assert.equal(before.state, script === "ACCEPT" ? "SUBMITTED" : "SUBMISSION_UNCERTAIN");
    const reads = w.provider.calls().readById + w.provider.calls().readByRequestId;
    assert.equal((await runChild(w, id, "afterRead")).signal, "SIGKILL");
    const r = world(w.dir, { clock: w.clock }); // restart
    assert.equal(r.provider.calls().readById + r.provider.calls().readByRequestId, reads + 1, "the read reached the provider before the kill");
    assert.deepEqual(r.rec(id), before, "no partial reconcile write survived");
    assert.equal(r.provider.calls().create, 1);
    assert.equal((await submit(r, id)).code, "DUPLICATE_SUBMISSION");
    assert.deepEqual(await r.svc.reconcile(OPERATOR, id), { ok: true, code: "PROVIDER_PROCESSING" });
    assert.deepEqual([r.provider.calls().create, r.svc.getFlowView(id)!.audit.verified], [1, true]);
  }
});

test("A3-30 two service instances on the same store file, eight parallel submits each: the provider sees exactly one create", async () => {
  const a = world();
  const b = world(a.dir, { clock: a.clock }); // a second service with its own connection to the same file
  const id = await drive(a, "HUMAN_APPROVED");
  const digest = a.rec(id).authorization!.authorization_digest;
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).svc.submit(OPERATOR, id, digest)));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "DUPLICATE_SUBMISSION"), JSON.stringify(results));
  assert.deepEqual([a.provider.calls().create, b.provider.calls().create, a.provider.records().length], [1, 1, 1], "both instances count the same single create");
  assert.deepEqual([state(a, id), state(b, id)], ["SUBMITTED", "SUBMITTED"]);
  assert.equal(a.events(id).filter((e) => e.type === "SUBMIT_INTENT_RECORDED").length, 1);
});

test("A3-31 a store that cannot be put in WAL with synchronous=FULL is refused, and stale intents found at open fail closed", async () => {
  // a valid database in rollback-journal mode that the process cannot write: WAL cannot be enabled, so it is refused
  const dir = mkdtempSync(join(tmpdir(), "dbflow-a3-"));
  const file = join(dir, "flow-v1.sqlite");
  const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(file);
  db.exec("PRAGMA journal_mode = DELETE; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)");
  db.close();
  chmodSync(file, 0o400);
  assert.throws(() => openFlowStore(dir), /INTEGRATED_STORE_UNAVAILABLE/);
  assert.deepEqual(world(undefined, { dataDir: dir }).svc.createFlow(OPERATOR, CASE), { ok: false, code: "INTEGRATED_STORE_UNAVAILABLE" });
  chmodSync(file, 0o600);
  // several flows left in SUBMIT_INTENT_RECORDED by processes that died: reopening after the stale window moves every
  // one of them to SUBMISSION_UNCERTAIN (recover_stale_intent) and sends nothing
  const w = world();
  const ids = [await drive(w, "HUMAN_APPROVED"), await drive(w, "HUMAN_APPROVED"), await drive(w, "HUMAN_APPROVED")];
  for (const id of ids) assert.equal((await runChild(w, id, "afterIntent")).signal, "SIGKILL");
  const young = world(w.dir, { clock: w.clock });
  assert.deepEqual(ids.map((id) => state(young, id)), ["SUBMIT_INTENT_RECORDED", "SUBMIT_INTENT_RECORDED", "SUBMIT_INTENT_RECORDED"], "inside the stale window nothing is assumed");
  w.clock.t += INTENT_STALE_MS;
  const r = world(w.dir, { clock: w.clock });
  assert.deepEqual(ids.map((id) => state(r, id)), ["SUBMISSION_UNCERTAIN", "SUBMISSION_UNCERTAIN", "SUBMISSION_UNCERTAIN"]);
  for (const id of ids) assert.deepEqual(r.events(id).at(-1)!.to_state, "SUBMISSION_UNCERTAIN");
  assert.deepEqual([r.provider.calls().create, r.provider.calls().validate], [0, 3]);
  for (const id of ids) assert.equal((await submit(r, id)).code, "DUPLICATE_SUBMISSION");
  assert.equal(r.provider.calls().create, 0);
});

test("A3-32 a gate record written straight into the store by an untrusted writer does not become authority", async () => {
  const forge = (g: GateRecord, patch: Partial<GateRecord>): GateRecord => {
    const { gate_digest: _d, ...rest } = { ...g, ...patch };
    return { ...rest, gate_digest: gateDigest(rest) };
  };
  const eligible = (g: GateRecord) => forge(g, { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", gate_refused: false, document_binding: "REGISTERED_DOCUMENT", document_id: DOC, proof_states: Object.fromEntries(PROOF_IDS.map((k) => [k, "VERIFIED"])) as GateRecord["proof_states"] });

  // (a) the obligation really is HOLD and the flow already holds its HOLD record: the database refuses the overwrite
  const h = world();
  h.gate.decision = "HOLD";
  h.gate.proofs = { ...h.gate.proofs, E: "MISSING" };
  const hid = await drive(h, "GATE");
  const forgedA = eligible(h.rec(hid).gate!);
  assert.throws(() => rawSql(h, `UPDATE flow SET gate_json='${JSON.stringify(forgedA)}', gate_digest='${forgedA.gate_digest}', state='GATE_ELIGIBLE', version=version+1 WHERE flow_id='${hid}'`), /FLOW_FIELD_ALREADY_SET|FLOW_ILLEGAL_TRANSITION/);
  assert.equal(state(h, hid), "GATE_HOLD");

  // (b) the strongest writer: drops the triggers and rewrites the HOLD flow into a self-consistent ELIGIBLE one that
  // is awaiting a human. The record hashes correctly, so only a fresh gate evaluation on the server-held inputs can
  // tell. The gate port (here answering as the real gate would for a HOLD obligation) refuses, and so does the flow.
  rawSql(h, `DROP TRIGGER flow_set_once; DROP TRIGGER flow_legal; DROP TRIGGER flow_state_evidence;
             UPDATE flow SET gate_json='${JSON.stringify(forgedA)}', gate_digest='${forgedA.gate_digest}', state='AWAITING_HUMAN', version=version+1 WHERE flow_id='${hid}'`);
  const fa = h.rec(hid);
  assert.deepEqual([fa.state, fa.gate!.decision], ["AWAITING_HUMAN", "ELIGIBLE_FOR_HUMAN_REVIEW"], "the forged record is in place and self-consistent");
  assert.deepEqual(await h.svc.approve(OPERATOR, hid, fa.proposal_digest, fa.gate!.gate_digest), { ok: false, code: "GATE_REEVALUATION_MISMATCH" });
  assert.deepEqual([state(h, hid), h.rec(hid).authorization, h.provider.calls().create], ["AWAITING_HUMAN", null, 0]);
  assert.ok(h.gate.revalidations.includes("approve"), "the refusal came from the fresh gate re-check");

  // (c) a forged record that is NOT self-consistent, or is for other evidence, is refused by this lane before the gate is asked
  for (const [want, sql] of [
    ["GATE_RECORD_TAMPERED", (g: GateRecord) => `gate_json='${JSON.stringify({ ...g, rule: "edited" })}'`],
    ["EVIDENCE_CHANGED", (_g: GateRecord) => `evidence_text='INVOICE edited after the gate ran'`],
    ["EVIDENCE_CHANGED", (_g: GateRecord) => `evidence_text='edited', evidence_digest='${"a".repeat(64)}'`],
    ["CLAIMS_CHANGED", (_g: GateRecord) => `claims_json='{"reference":null,"payee":null,"currency":null,"amounts":[],"adverse":[]}'`],
  ] as const) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const f = w.rec(id);
    const asked = w.gate.revalidations.length;
    rawSql(w, `DROP TRIGGER flow_set_once; DROP TRIGGER flow_version; UPDATE flow SET ${sql(f.gate!)} WHERE flow_id='${id}'`);
    assert.deepEqual(await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: want }, want);
    assert.deepEqual([state(w, id), w.rec(id).authorization, w.gate.revalidations.length], ["AWAITING_HUMAN", null, asked], want);
  }
  // (d) the same edits after approval are refused at submit, before validate, intent or create
  for (const sql of [`evidence_text='INVOICE edited after approval'`, `claims_json='{"reference":null,"payee":null,"currency":null,"amounts":[],"adverse":[]}'`]) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    rawSql(w, `DROP TRIGGER flow_set_once; DROP TRIGGER flow_version; UPDATE flow SET ${sql} WHERE flow_id='${id}'`);
    const r = await submit(w, id);
    assert.ok(["EVIDENCE_CHANGED", "CLAIMS_CHANGED"].includes(r.code), r.code);
    assert.deepEqual([state(w, id), w.rec(id).submission.attempt_id, w.provider.calls().validate, w.provider.calls().create], ["HUMAN_APPROVED", null, 0, 0]);
  }
  // (e) an approved flow whose obligation stops being eligible is refused at submit by the fresh re-check
  const s = world();
  const sid = await drive(s, "HUMAN_APPROVED");
  s.gate.decision = "HOLD";
  assert.deepEqual([await submit(s, sid), s.provider.calls().create], [{ ok: false, code: "GATE_REEVALUATION_MISMATCH" }, 0]);
});

// ------------------------------------------------------------------------------------------------------------
// flow-v1.2 R11 (finding F-A7-01): approvals must be issued by this server process
// ------------------------------------------------------------------------------------------------------------

/** The strongest store writer: removes every trigger, then runs its statements. */
function untrustedWrite(w: World, sql: string): void {
  const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(join(w.deps.dataDir, "flow-v1.sqlite"));
  try {
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) db.exec(`DROP TRIGGER "${t.name}"`);
    db.exec(sql);
  } finally {
    db.close();
  }
}
/** Variant D of the A7 probe: a self-consistent AuthorizationRecord inserted without any human approval. */
function forgeApproval(w: World, id: string, mac: string): string {
  const f = w.rec(id);
  const rest = { flow_id: id, proposal_digest: f.proposal_digest, gate_digest: f.gate!.gate_digest, operator_id: OPERATOR, approved_at_ms: w.clock.t, expires_at_ms: w.clock.t + APPROVAL_TTL_MS, flow_version: f.version };
  const a = { ...rest, authorization_digest: authorizationDigest(rest) };
  untrustedWrite(w, `INSERT INTO flow_authorization VALUES ('${id}','${a.gate_digest}','${a.authorization_digest}','${a.proposal_digest}','${OPERATOR}',${a.approved_at_ms},${a.expires_at_ms},${a.flow_version},'${mac}');
    UPDATE flow SET authorization_json='${JSON.stringify(a)}', gate_consumed_at_ms=${w.clock.t}, state='HUMAN_APPROVED', version=version+1 WHERE flow_id='${id}'`);
  return a.authorization_digest;
}
const NOT_ISSUED = { ok: false, code: "AUTHORIZATION_NOT_SERVER_ISSUED" };

test("A3-33 (F-A7-01) a forged authorization record is refused before validate, intent or create, whatever MAC the writer supplies", async () => {
  const donor = world();
  const donorId = await drive(donor, "HUMAN_APPROVED");
  const copied = (() => {
    const s = openFlowStore(donor.deps.dataDir, donor.deps.audit.ddl);
    try {
      return s.approvalMac(donorId)!.approval_mac; // a genuine MAC, issued for a different flow
    } finally {
      s.close();
    }
  })();
  const macs: [string, (digestOf: string) => string][] = [
    ["a made-up MAC", () => "ab".repeat(32)],
    ["a MAC computed with a key the writer invented", (d) => approvalMac(new Uint8Array(32).fill(9), d)],
    ["a genuine MAC copied from another flow", () => copied],
    ["the authorization digest itself", (d) => d],
  ];
  for (const [label, make] of macs) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const f = w.rec(id);
    const rest = { flow_id: id, proposal_digest: f.proposal_digest, gate_digest: f.gate!.gate_digest, operator_id: OPERATOR, approved_at_ms: w.clock.t, expires_at_ms: w.clock.t + APPROVAL_TTL_MS, flow_version: f.version };
    const digest = forgeApproval(w, id, make(authorizationDigest(rest)));
    const forged = w.rec(id);
    assert.deepEqual([forged.state, forged.authorization!.authorization_digest], ["HUMAN_APPROVED", digest], `${label}: the forged record is in place and self-consistent`);
    assert.deepEqual(await w.svc.submit(OPERATOR, id, digest), NOT_ISSUED, label);
    const after = w.rec(id);
    assert.deepEqual([after.state, after.submission.attempt_id, after.authorization_consumed_at_ms, w.provider.calls().validate, w.provider.calls().create], ["HUMAN_APPROVED", null, null, 0, 0], label);
    const last = w.events(id).at(-1)!;
    assert.deepEqual([last.type, last.data.op, last.data.code], ["REFUSED", "submit", "AUTHORIZATION_NOT_SERVER_ISSUED"], "the refusal is audited");
    assert.ok(!w.gate.revalidations.includes("submit"), "refused before the gate, the ledger or the provider were asked");
  }
  // an authorization row that is missing altogether (only the JSON column forged) is refused the same way
  const w = world();
  const id = await drive(w, "AWAITING_HUMAN");
  const f = w.rec(id);
  const rest = { flow_id: id, proposal_digest: f.proposal_digest, gate_digest: f.gate!.gate_digest, operator_id: OPERATOR, approved_at_ms: w.clock.t, expires_at_ms: w.clock.t + APPROVAL_TTL_MS, flow_version: f.version };
  const a = { ...rest, authorization_digest: authorizationDigest(rest) };
  untrustedWrite(w, `UPDATE flow SET authorization_json='${JSON.stringify(a)}', gate_consumed_at_ms=1, state='HUMAN_APPROVED', version=version+1 WHERE flow_id='${id}'`);
  assert.deepEqual([await w.svc.submit(OPERATOR, id, a.authorization_digest), w.provider.calls().validate, w.provider.calls().create], [NOT_ISSUED, 0, 0]);
  // a genuine approval whose stored MAC is then altered, or moved under a genuine record of another flow, is refused
  const g = world();
  const gid = await drive(g, "HUMAN_APPROVED");
  untrustedWrite(g, `UPDATE flow_authorization SET approval_mac='${copied}' WHERE flow_id='${gid}'`);
  assert.deepEqual([await submit(g, gid), g.provider.calls().create], [NOT_ISSUED, 0]);
  // and the genuine, untouched path still works
  assert.equal((await submit(donor, donorId)).code, "SUBMITTED");
});

test("A3-34 (R11) an approval does not survive a restart with a new key or cross to a process with another key: unsubmittable, then EXPIRED", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const restarted = world(w.dir, { clock: w.clock, approvalKey: new Uint8Array(32).fill(8) }); // new process, new key
  assert.deepEqual(await submit(restarted, id), NOT_ISSUED);
  assert.deepEqual([state(restarted, id), restarted.provider.calls().validate, restarted.provider.calls().create], ["HUMAN_APPROVED", 0, 0]);
  w.clock.t += APPROVAL_TTL_MS;
  assert.deepEqual([await submit(restarted, id), state(restarted, id)], [{ ok: false, code: "APPROVAL_EXPIRED" }, "EXPIRED"]);
  assert.equal(restarted.provider.calls().create, 0);
  // a new flow approved under the new key submits normally, once
  const fresh = await drive(restarted, "HUMAN_APPROVED");
  assert.equal((await submit(restarted, fresh)).code, "SUBMITTED");
  assert.equal(restarted.provider.calls().create, 1);
  // the multi-process race with DIFFERENT keys: no process but the approver's can submit at all
  const m = world();
  const mid = await drive(m, "HUMAN_APPROVED");
  const others = await Promise.all([1, 2, 3].map((i) => submit(world(m.dir, { clock: m.clock, approvalKey: new Uint8Array(32).fill(100 + i) }), mid)));
  assert.deepEqual(others, [NOT_ISSUED, NOT_ISSUED, NOT_ISSUED]);
  assert.equal(m.provider.calls().create, 0);
  assert.equal((await submit(m, mid)).code, "SUBMITTED");
  assert.equal(m.provider.calls().create, 1);
});

test("A3-35 (R11) a missing or short approval key refuses approve and submit; nothing is written or sent", async () => {
  for (const bad of [undefined, null, new Uint8Array(0), new Uint8Array(31).fill(7), "0".repeat(64), Array.from({ length: 32 }, () => 7)]) {
    const w = world(undefined, { approvalKey: TEST_APPROVAL_KEY });
    const id = await drive(w, "AWAITING_HUMAN");
    const f = w.rec(id);
    w.deps.approvalKey = bad as never;
    assert.deepEqual(await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: "APPROVAL_KEY_INVALID" });
    assert.deepEqual([state(w, id), w.rec(id).authorization, w.rec(id).gate_consumed_at_ms], ["AWAITING_HUMAN", null, null]);
    w.deps.approvalKey = TEST_APPROVAL_KEY;
    assert.equal((await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest)).code, "HUMAN_APPROVED");
    w.deps.approvalKey = bad as never;
    assert.deepEqual(await submit(w, id), { ok: false, code: "APPROVAL_KEY_INVALID" });
    assert.deepEqual([state(w, id), w.rec(id).submission.attempt_id, w.provider.calls().validate, w.provider.calls().create], ["HUMAN_APPROVED", null, 0, 0]);
  }
});

test("A3-36 (R11) the approval key never reaches the store, the audit chain, a record, a view or a result", async () => {
  const key = new Uint8Array(randomBytes(32));
  const w = world(undefined, { approvalKey: key, ledger: true });
  const id = await drive(w, "HUMAN_APPROVED");
  await w.svc.submit("human:someone-else", id, w.rec(id).authorization!.authorization_digest); // a refusal
  const results = [await submit(w, id), await w.svc.reconcile(OPERATOR, id)];
  const other = await drive(w, "AWAITING_HUMAN");
  forgeApproval(w, other, "ab".repeat(32));
  results.push(await w.svc.submit(OPERATOR, other, w.rec(other).authorization!.authorization_digest));
  const forms = [Buffer.from(key), Buffer.from(Buffer.from(key).toString("hex")), Buffer.from(Buffer.from(key).toString("hex").toUpperCase()), Buffer.from(Buffer.from(key).toString("base64")), Buffer.from(Buffer.from(key).toString("base64url")), Buffer.from(JSON.stringify(Array.from(key)).slice(1, -1))];
  const files = readdirSync(w.deps.dataDir);
  assert.ok(files.includes("flow-v1.sqlite"));
  for (const name of files) {
    const bytes = readFileSync(join(w.deps.dataDir, name));
    for (const form of forms) assert.equal(bytes.includes(form), false, `${name} holds the approval key`);
  }
  const shown = Buffer.from(JSON.stringify([results, w.rec(id), w.svc.getFlowView(id), w.svc.listFlowViews(), w.events(id), w.events(other)]));
  for (const form of forms) assert.equal(shown.includes(form), false, "a result, record, view or audit event holds the approval key");
  assert.equal(JSON.stringify([w.svc.getFlowView(id), w.rec(id)]).includes("approval_mac"), false, "the MAC is not part of the record or the view");
  // what IS stored is the contract MAC of the digest, in its own column
  const s = openFlowStore(w.deps.dataDir, w.deps.audit.ddl);
  assert.deepEqual({ ...s.approvalMac(id) }, { authorization_digest: w.rec(id).authorization!.authorization_digest, approval_mac: approvalMac(key, w.rec(id).authorization!.authorization_digest) });
  s.close();
  // SEC-C5 golden vector, through the same helper this lane calls
  assert.equal(approvalMac(new Uint8Array(32).fill(7), "b385dc9b438e60fe01eb94a88c01224e0d90b0bcedfbd29c7c9f6757498fcaa7"), "967056a4a7775a80699c3b0a941057b2e24a8bd0700918c36a2b25213379aeb3");
});
