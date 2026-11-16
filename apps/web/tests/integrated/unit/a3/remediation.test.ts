// A3 remediation tests for the cold review findings A8-02 (approval replay after a store rollback) and the flow side
// of A8-01 (beneficiary not bound to the obligation). Builder-side unit tests with this lane's fakes; the black-box
// reproductions of the reviewer's probes belong to the test lane. Offline: the provider is the mock.
//
// Threat model used here: an untrusted writer of the store file who can drop every trigger and rewrite any row, in
// the same server process and within the approval lifetime.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { authorizationDigest, gateDigest, proposalDigest } from "../../../../integrated/flowCanonical.ts";
import type { FlowProposal, GateRecord } from "../../../../integrated/flowTypes.ts";
import type { MockScript } from "../../../../integrated/paymentAdapter.ts";
import { APPROVAL_TTL_MS } from "../../../../src/server/transfers.ts";
import { BEN, BEN_LABEL, CASE, DOC, drive, OPERATOR, submit, world } from "./support.ts";
import type { World } from "./support.ts";

const ATTACKER = "11111111-1111-4111-8111-111111111111";
const ATTACKER_LABEL = "Attacker supplies";

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
const q = (v: unknown) => JSON.stringify(v).replaceAll("'", "''");
/** Roll a flow back to HUMAN_APPROVED as if no submit had ever happened: attempt row gone, every submit column NULL. */
const ROLLBACK_TO_APPROVED = (id: string) => `DELETE FROM flow_submit_attempt WHERE flow_id='${id}';
  UPDATE flow SET state='HUMAN_APPROVED', attempt_id=NULL, attempt_recorded_at_ms=NULL, provider_mode=NULL, authorization_consumed_at_ms=NULL,
    provider_transfer_id=NULL, create_http_status=NULL, create_reported_status=NULL, last_provider_status=NULL, last_provider_read_at_ms=NULL, version=version+1 WHERE flow_id='${id}'`;
const calls = (w: World) => [w.provider.calls().validate, w.provider.calls().create];

// ------------------------------------------------------------------------------------------------------------
// A8-02: single-use approval and one create attempt despite a store rollback
// ------------------------------------------------------------------------------------------------------------

test("A3-R01 (A8-02) rollback after SUBMISSION_UNCERTAIN, SUBMITTED or PROVIDER_REFUSED: the same approval cannot reach validate, intent or create again", async () => {
  const cases: [NonNullable<MockScript["create"]>, string, number][] = [
    ["TIMEOUT_AFTER_SEND", "SUBMISSION_UNCERTAIN", 1], ["HTTP_500_BEFORE_SEND", "SUBMISSION_UNCERTAIN", 0], ["HTTP_429_BEFORE_SEND", "SUBMISSION_UNCERTAIN", 0],
    ["ACCEPT", "SUBMITTED", 1], ["REFUSE_400", "PROVIDER_REFUSED", 0], ["REFUSE_422", "PROVIDER_REFUSED", 0],
  ];
  for (const [script, reached, records] of cases) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    const digest = w.rec(id).authorization!.authorization_digest;
    w.provider.script.create = script;
    await submit(w, id);
    assert.deepEqual([w.rec(id).state, calls(w), w.provider.records().length], [reached, [1, 1], records], script);

    untrustedWrite(w, ROLLBACK_TO_APPROVED(id));
    const rolled = w.rec(id);
    assert.deepEqual([rolled.state, rolled.submission.attempt_id, rolled.authorization_consumed_at_ms, rolled.authorization!.authorization_digest], ["HUMAN_APPROVED", null, null, digest], `${script}: the store now says the approval was never used`);
    w.provider.script.create = "ACCEPT"; // the provider would accept; it must not be asked
    for (let i = 0; i < 3; i++) assert.deepEqual(await w.svc.submit(OPERATOR, id, digest), { ok: false, code: "AUTHORIZATION_ALREADY_CONSUMED" }, script);
    const after = w.rec(id);
    assert.deepEqual([after.state, after.submission.attempt_id, calls(w), w.provider.records().length], ["HUMAN_APPROVED", null, [1, 1], records], `${script}: no second validate, intent or create`);
    const last = w.events(id).at(-1)!;
    assert.deepEqual([last.type, last.data.op, last.data.code], ["REFUSED", "submit", "AUTHORIZATION_ALREADY_CONSUMED"], "the refusal is audited");
    assert.ok(w.gate.revalidations.filter((p) => p === "submit").length === 1, "refused before the gate was asked again");
    // the flow then simply expires
    w.clock.t += APPROVAL_TTL_MS;
    assert.deepEqual([await w.svc.submit(OPERATOR, id, digest), w.rec(id).state, calls(w)], [{ ok: false, code: "APPROVAL_EXPIRED" }, "EXPIRED", [1, 1]]);
  }
});

test("A3-R02 (A8-02) rollback further, to AWAITING_HUMAN with the authorization erased: no new approval for a flow whose create was already attempted", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  w.provider.script.create = "TIMEOUT_AFTER_SEND";
  await submit(w, id);
  untrustedWrite(w, `DELETE FROM flow_submit_attempt WHERE flow_id='${id}'; DELETE FROM flow_authorization WHERE flow_id='${id}';
    UPDATE flow SET state='AWAITING_HUMAN', authorization_json=NULL, gate_consumed_at_ms=NULL, attempt_id=NULL, attempt_recorded_at_ms=NULL, provider_mode=NULL, authorization_consumed_at_ms=NULL, create_http_status=NULL, version=version+1 WHERE flow_id='${id}'`);
  const f = w.rec(id);
  assert.deepEqual([f.state, f.authorization, f.gate_consumed_at_ms], ["AWAITING_HUMAN", null, null]);
  w.provider.script.create = "ACCEPT";
  // a genuine human, genuinely approving again, would mint a NEW authorization digest: the request id and the flow are remembered too
  assert.deepEqual(await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: "CREATE_ALREADY_ATTEMPTED" });
  assert.deepEqual([w.rec(id).state, w.rec(id).authorization, calls(w)], ["AWAITING_HUMAN", null, [1, 1]]);
  // even an authorization this process is tricked into issuing some other way cannot be submitted: forge one with the real key
  const { approvalMac } = await import("../../../../integrated/flowCanonical.ts");
  const rest = { flow_id: id, proposal_digest: f.proposal_digest, gate_digest: f.gate!.gate_digest, operator_id: OPERATOR, approved_at_ms: w.clock.t, expires_at_ms: w.clock.t + APPROVAL_TTL_MS, flow_version: f.version };
  const a = { ...rest, authorization_digest: authorizationDigest(rest) };
  untrustedWrite(w, `INSERT INTO flow_authorization VALUES ('${id}','${a.gate_digest}','${a.authorization_digest}','${a.proposal_digest}','${OPERATOR}',${a.approved_at_ms},${a.expires_at_ms},${a.flow_version},'${approvalMac(w.deps.approvalKey, a.authorization_digest)}');
    UPDATE flow SET authorization_json='${q(a)}', gate_consumed_at_ms=${w.clock.t}, state='HUMAN_APPROVED', version=version+1 WHERE flow_id='${id}'`);
  assert.deepEqual(await w.svc.submit(OPERATOR, id, a.authorization_digest), { ok: false, code: "CREATE_ALREADY_ATTEMPTED" }, "a fresh digest with a VALID MAC is still refused: the request id and the flow were spent");
  assert.deepEqual(calls(w), [1, 1]);
  // a brand new flow for the same case is a different transaction (new request id, new approval) and is unaffected
  const fresh = await drive(w, "HUMAN_APPROVED");
  assert.equal((await submit(w, fresh)).code, "SUBMITTED");
  assert.equal(w.provider.calls().create, 2);
  assert.notEqual(w.rec(fresh).proposal.provider_request_id, f.proposal.provider_request_id);
});

test("A3-R03 (A8-02) the in-memory record is shared by every service in the process that holds the same key, and concurrency still gives one create", async () => {
  const a = world();
  const b = world(a.dir, { clock: a.clock }); // second service instance, same key object, same store file
  const id = await drive(a, "HUMAN_APPROVED");
  const digest = a.rec(id).authorization!.authorization_digest;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).svc.submit(OPERATOR, id, digest)));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "DUPLICATE_SUBMISSION"), JSON.stringify(results));
  assert.equal(a.provider.calls().create, 1);
  untrustedWrite(a, ROLLBACK_TO_APPROVED(id));
  const validatesBefore = a.provider.calls().validate;
  // whichever instance is asked, and however many times at once, the rolled-back approval is refused
  const replays = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).svc.submit(OPERATOR, id, digest)));
  assert.ok(replays.every((r) => !r.ok && r.code === "AUTHORIZATION_ALREADY_CONSUMED"), JSON.stringify(replays));
  assert.deepEqual([a.provider.calls().create, a.provider.calls().validate], [1, validatesBefore], "no replay reached validate or create");
});

test("A3-R04 (A8-02 limit, documented) another process or a restart has no in-memory record, and is stopped by the rotated approval key instead", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const digest = w.rec(id).authorization!.authorization_digest;
  w.provider.script.create = "TIMEOUT_AFTER_SEND";
  await submit(w, id);
  untrustedWrite(w, ROLLBACK_TO_APPROVED(id));
  const restarted = world(w.dir, { clock: w.clock, approvalKey: new Uint8Array(32).fill(8) }); // a restart: new key, empty memory
  restarted.provider.script.create = "ACCEPT";
  assert.deepEqual(await restarted.svc.submit(OPERATOR, id, digest), { ok: false, code: "AUTHORIZATION_NOT_SERVER_ISSUED" });
  assert.deepEqual([restarted.rec(id).state, calls(restarted)], ["HUMAN_APPROVED", [1, 1]]);
});

test("A3-R05 (A8-02) an intent that failed to commit sent nothing and spends nothing; a committed intent spends the approval before create is entered", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const digest = w.rec(id).authorization!.authorization_digest;
  w.audit.failOnType = "SUBMIT_INTENT_RECORDED"; // the intent transaction rolls back
  assert.equal((await w.svc.submit(OPERATOR, id, digest)).code, "AUDIT_FIELD_REFUSED");
  assert.deepEqual([w.rec(id).state, w.provider.calls().create], ["HUMAN_APPROVED", 0]);
  w.audit.failOnType = null;
  // the approval is spent in memory by the time create runs: a replay attempted from INSIDE the provider call is refused
  const inner = w.deps.provider;
  let during: { ok: boolean; code: string } | null = null;
  let replayed = false;
  const svc = w.svc;
  w.deps.provider = { mode: "mock", validate: (b) => inner.validate(b), readById: (x) => inner.readById(x), readByRequestId: (x) => inner.readByRequestId(x),
    create: async (b) => {
      // Exactly ONE replay, from inside the first create call. Bounded on purpose: on code without the in-memory
      // record the replay is accepted and reaches create again; that second call must simply be counted (and fail
      // the assertion below), not replay once more.
      if (!replayed) {
        replayed = true;
        untrustedWrite(w, ROLLBACK_TO_APPROVED(id)); // the writer rolls the row back while create is in flight
        during = await svc.submit(OPERATOR, id, digest);
      }
      return inner.create(b);
    } };
  const { createFlowService } = await import("../../../../integrated/flowService.ts");
  const wrapped = createFlowService(w.deps);
  await wrapped.submit(OPERATOR, id, digest);
  assert.equal(replayed, true, "the replay was attempted");
  assert.equal(w.provider.calls().create, 1, "the replay from inside create must not reach the provider a second time");
  assert.deepEqual(during, { ok: false, code: "AUTHORIZATION_ALREADY_CONSUMED" });
});

// ------------------------------------------------------------------------------------------------------------
// A8-01 (flow side): the stored beneficiary must be the one bound to the obligation
// ------------------------------------------------------------------------------------------------------------

/** Rewrites the stored proposal (and its digest, so the row stays self-consistent). */
function rewriteProposal(w: World, id: string, patch: Partial<FlowProposal>): FlowProposal {
  const p = { ...w.rec(id).proposal, ...patch };
  untrustedWrite(w, `UPDATE flow SET proposal_json='${q(p)}', proposal_digest='${proposalDigest(p)}' WHERE flow_id='${id}'`);
  return p;
}
/** Also rewrites the stored gate record so it binds the rewritten proposal and still hashes to its own digest. */
function rebindGate(w: World, id: string): GateRecord {
  const f = w.rec(id);
  const { gate_digest: _d, ...rest } = { ...f.gate!, proposal_digest: f.proposal_digest };
  const g = { ...rest, gate_digest: gateDigest(rest) };
  untrustedWrite(w, `UPDATE flow SET gate_json='${q(g)}', gate_digest='${g.gate_digest}' WHERE flow_id='${id}'`);
  return g;
}

test("A3-R06 (A8-01) two-entry allowlist: a proposal redirected to the other allowlisted beneficiary before evaluation never reaches the gate", async () => {
  const w = world();
  w.allowlist.set(ATTACKER, ATTACKER_LABEL);
  const id = await drive(w, "EVIDENCE_READY");
  const p = rewriteProposal(w, id, { beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL });
  assert.deepEqual([w.rec(id).proposal.beneficiary_id, w.rec(id).proposal_digest, w.allowlist.get(ATTACKER)], [ATTACKER, proposalDigest(p), ATTACKER_LABEL], "the rewritten proposal is self-consistent and its beneficiary IS on the allowlist");
  assert.deepEqual(await w.svc.evaluateGate(OPERATOR, id), { ok: false, code: "BENEFICIARY_BINDING_MISMATCH" });
  const f = w.rec(id);
  assert.deepEqual([f.state, f.gate, w.gate.evaluations], ["EVIDENCE_READY", null, 0], "no gate result exists, so the flow can never be GATE_ELIGIBLE");
  assert.deepEqual([w.events(id).at(-1)!.type, w.events(id).at(-1)!.data.code], ["REFUSED", "BENEFICIARY_BINDING_MISMATCH"], "the refusal is audited");
  assert.equal((await w.svc.requestHumanReview(OPERATOR, id)).code, "WRONG_STATE");
  assert.equal((await w.svc.approve(OPERATOR, id, f.proposal_digest, "0".repeat(64))).code, "WRONG_STATE");
  assert.equal((await w.svc.submit(OPERATOR, id, "0".repeat(64))).code, "WRONG_STATE");
  assert.deepEqual([calls(w), w.provider.records().length], [[0, 0], 0]);
  // an untouched flow in the same two-entry world is unaffected
  const ok = await drive(w, "HUMAN_APPROVED");
  assert.equal((await submit(w, ok)).code, "SUBMITTED");
  assert.equal(w.provider.records()[0].beneficiary_id, BEN);
});

test("A3-R07 (A8-01) the same redirect made later, with the gate record rewritten to match, is refused at review and at approve", async () => {
  for (const stage of ["GATE", "AWAITING_HUMAN"] as const) {
    const w = world();
    w.allowlist.set(ATTACKER, ATTACKER_LABEL);
    const id = await drive(w, stage);
    rewriteProposal(w, id, { beneficiary_id: ATTACKER, beneficiary_label: ATTACKER_LABEL });
    const g = rebindGate(w, id);
    const f = w.rec(id);
    const r = stage === "GATE" ? await w.svc.requestHumanReview(OPERATOR, id) : await w.svc.approve(OPERATOR, id, f.proposal_digest, g.gate_digest);
    assert.deepEqual(r, { ok: false, code: "BENEFICIARY_BINDING_MISMATCH" }, stage);
    assert.deepEqual([w.rec(id).state, w.rec(id).authorization, calls(w)], [stage === "GATE" ? "GATE_ELIGIBLE" : "AWAITING_HUMAN", null, [0, 0]], stage);
  }
});

test("A3-R08 (A8-01) at submit: a binding that changed after approval, an id swap that keeps the label, and a duplicate-label allowlist are all refused before validate", async () => {
  // the binding source now names a different beneficiary for this obligation
  const w = world();
  w.allowlist.set(ATTACKER, ATTACKER_LABEL);
  const id = await drive(w, "HUMAN_APPROVED");
  w.proposalPatch.beneficiary_id = ATTACKER;
  w.proposalPatch.beneficiary_label = ATTACKER_LABEL;
  assert.deepEqual([await submit(w, id), w.rec(id).state, w.rec(id).submission.attempt_id, calls(w)], [{ ok: false, code: "BENEFICIARY_BINDING_MISMATCH" }, "HUMAN_APPROVED", null, [0, 0]]);
  // the builder can no longer resolve the binding at all: its own refusal code is passed through
  const u = world();
  const uid = await drive(u, "HUMAN_APPROVED");
  u.deps.buildProposal = () => ({ ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" });
  const usvc = (await import("../../../../integrated/flowService.ts")).createFlowService(u.deps);
  assert.deepEqual([await usvc.submit(OPERATOR, uid, u.rec(uid).authorization!.authorization_digest), calls(u)], [{ ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" }, [0, 0]]);
  u.deps.buildProposal = () => { throw new Error("builder down"); };
  const usvc2 = (await import("../../../../integrated/flowService.ts")).createFlowService(u.deps);
  assert.deepEqual([await usvc2.submit(OPERATOR, uid, u.rec(uid).authorization!.authorization_digest), calls(u)], [{ ok: false, code: "BENEFICIARY_BINDING_MISMATCH" }, [0, 0]]);

  // duplicate label: two allowlist ids carry the bound label, so the label does not resolve to one beneficiary
  for (const stage of ["EVIDENCE_READY", "GATE", "AWAITING_HUMAN", "HUMAN_APPROVED"] as const) {
    const d = world();
    const did = await drive(d, stage);
    d.allowlist.set(ATTACKER, BEN_LABEL); // same label, different id
    const f = d.rec(did);
    const r = stage === "EVIDENCE_READY" ? await d.svc.evaluateGate(OPERATOR, did) : stage === "GATE" ? await d.svc.requestHumanReview(OPERATOR, did)
      : stage === "AWAITING_HUMAN" ? await d.svc.approve(OPERATOR, did, f.proposal_digest, f.gate!.gate_digest) : await submit(d, did);
    assert.deepEqual([r, d.rec(did).state, calls(d)], [{ ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" }, f.state, [0, 0]], stage);
  }
  // id swap with the label kept (possible only with a duplicate label): the pair is on the allowlist, the binding is not unique
  const s = world();
  s.allowlist.set(ATTACKER, BEN_LABEL);
  const c = s.svc.createFlow(OPERATOR, CASE);
  s.svc.attachEvidence(OPERATOR, c.flow_id!, { kind: "FIXTURE_REPLAY", document_id: DOC });
  rewriteProposal(s, c.flow_id!, { beneficiary_id: ATTACKER });
  assert.deepEqual([await s.svc.evaluateGate(OPERATOR, c.flow_id!), s.rec(c.flow_id!).state, s.gate.evaluations], [{ ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" }, "EVIDENCE_READY", 0]);
  // a rewritten obligation id (pointing the flow at another case's binding) does not match the immutable column
  const o = world();
  const oid = await drive(o, "EVIDENCE_READY");
  rewriteProposal(o, oid, { obligation_id: "CASE-OTHER-0001" });
  assert.deepEqual([await o.svc.evaluateGate(OPERATOR, oid), o.gate.evaluations], [{ ok: false, code: "BENEFICIARY_BINDING_MISMATCH" }, 0]);
  // the allowlist membership check from flow-v1.1 R5 is still there and still answers first
  const r5 = world();
  const rid = await drive(r5, "HUMAN_APPROVED");
  r5.allowlist.delete(BEN);
  assert.equal((await submit(r5, rid)).code, "BENEFICIARY_NOT_ALLOWLISTED");
});

test("A3-R09 (A8-01) an obligation whose bound beneficiary is not on the allowlist is still evaluated by the gate, and can go no further", async () => {
  // the E3 shape: the builder binds a reserved beneficiary id that is never allowlisted
  const w = world();
  const RESERVED = "00000000-0000-4000-8000-0000000e3000";
  w.proposalPatch.beneficiary_id = RESERVED;
  w.proposalPatch.beneficiary_label = "E3 steel subcontractor (no provider beneficiary)";
  const real = w.deps.buildProposal;
  w.deps.buildProposal = (c, f, r) => real(c, f, r, new Map([[BEN, BEN_LABEL]])); // this lane's fake builder insists on the mock entry
  w.gate.decision = "HOLD";
  w.gate.proofs = { ...w.gate.proofs, H: "CONTRADICTED", I: "CONTRADICTED" };
  const svc = (await import("../../../../integrated/flowService.ts")).createFlowService(w.deps);
  const c = svc.createFlow(OPERATOR, CASE);
  svc.attachEvidence(OPERATOR, c.flow_id!, { kind: "FIXTURE_REPLAY", document_id: DOC });
  assert.deepEqual(await svc.evaluateGate(OPERATOR, c.flow_id!), { ok: true, code: "GATE_HOLD" });
  assert.deepEqual([svc.getFlow(c.flow_id!)!.gate!.decision, svc.getFlow(c.flow_id!)!.proposal.beneficiary_id, w.gate.evaluations], ["HOLD", RESERVED, 1]);
  // and if a gate ever called such a flow eligible, review still refuses it: the beneficiary is not on the allowlist
  const v = world();
  v.proposalPatch.beneficiary_id = RESERVED;
  v.proposalPatch.beneficiary_label = "E3 steel subcontractor (no provider beneficiary)";
  const vreal = v.deps.buildProposal;
  v.deps.buildProposal = (cc, f, r) => vreal(cc, f, r, new Map([[BEN, BEN_LABEL]]));
  const vsvc = (await import("../../../../integrated/flowService.ts")).createFlowService(v.deps);
  const vc = vsvc.createFlow(OPERATOR, CASE);
  vsvc.attachEvidence(OPERATOR, vc.flow_id!, { kind: "FIXTURE_REPLAY", document_id: DOC });
  assert.equal((await vsvc.evaluateGate(OPERATOR, vc.flow_id!)).code, "GATE_ELIGIBLE");
  assert.deepEqual([await vsvc.requestHumanReview(OPERATOR, vc.flow_id!), vsvc.getFlow(vc.flow_id!)!.state, calls(v)], [{ ok: false, code: "BENEFICIARY_NOT_ALLOWLISTED" }, "GATE_ELIGIBLE", [0, 0]]);
});
