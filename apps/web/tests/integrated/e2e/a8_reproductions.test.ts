// Reproductions of review findings A8-01 (probe X1) and A8-02 (probe X2) against the REAL merged modules, written as
// assertions of the SECURE behaviour, plus regressions around them. Offline: mock provider, network guard.
//
//   A8-01  a store writer redirects an eligible obligation to another allowlisted beneficiary
//   A8-02  a store writer rolls a used approval back and gets a second provider create
//
// REPRO-X1 and REPRO-X2 are the review probes step for step. They FAIL on candidate 1e10588 and must pass on the fix.
// Only black-box outcomes are asserted: ok, state, create attempts and provider records. Refusal codes are the
// builders' choice and are not asserted.
import "../support/netGuard.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { FlowService, FlowState } from "../../../integrated/flowTypes.ts";
import { ATTACKER_BEN, ATTACKER_LABEL, driveTo, e3Cases, ELIGIBLE_CASE, flowOf, newWorld, OPERATOR, redirectBeneficiary, rollBackToApproved, service } from "../support/a8Service.ts";
import type { Stage } from "../support/a8Service.ts";
import { BEN_ID, BEN_LABEL, E3_RESERVED_BENEFICIARY_ID } from "../support/fixtures.ts";
import type { CreateMode } from "../support/mockProvider.ts";
import { networkAttempts } from "../support/netGuard.ts";
import type { World } from "../support/port.ts";

const GENUINE: [string, string] = [BEN_ID, BEN_LABEL];
const ATTACKER: [string, string] = [ATTACKER_BEN, ATTACKER_LABEL];
const creates = (w: World) => w.provider.createAttempts().length;
const sentTo = (w: World) => w.provider.records().map((r) => r.beneficiary_id);
const NOT_PAST_APPROVAL: FlowState[] = ["DRAFT", "EVIDENCE_READY", "GATE_HOLD", "GATE_REVIEW", "GATE_ELIGIBLE", "AWAITING_HUMAN", "HUMAN_APPROVED", "HUMAN_REJECTED", "EXPIRED"];

/** Push a flow as far as the system will let it go, the way the operator would, using whatever digests the system
 *  itself now shows. Returns what each step answered. Nothing here is an assertion. */
async function pushThrough(svc: FlowService, id: string): Promise<{ review: boolean; approve: boolean; submit: boolean }> {
  const review = (await svc.requestHumanReview(OPERATOR, id)).ok;
  const f = flowOf(svc, id);
  const approve = (await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest ?? "")).ok;
  const submit = (await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest ?? "")).ok;
  return { review, approve, submit };
}
/** The secure outcome of a redirected payment: nothing was approved for it and nothing was sent. */
function assertNothingSent(w: World, svc: FlowService, id: string, steps: { review: boolean; approve: boolean; submit: boolean }, why: string): void {
  assert.deepEqual(steps, { review: false, approve: false, submit: false }, `${why}: review, approve and submit are all refused`);
  assert.equal(creates(w), 0, `${why}: 0 provider creates`);
  assert.deepEqual(sentTo(w), [], `${why}: no provider record`);
  assert.ok(NOT_PAST_APPROVAL.includes(flowOf(svc, id).state), `${why}: the flow never passed approval (${flowOf(svc, id).state})`);
}

/** Fail-closed at evaluation, in either of the two accepted forms: the gate answers HOLD (GATE_HOLD), or the
 *  evaluation itself is refused and the flow stays in EVIDENCE_READY. It is never eligible and never REVIEW. */
function assertNotEligibleAtEvaluation(svc: FlowService, id: string, evaluated: { ok: boolean }, why: string): void {
  const f = flowOf(svc, id);
  assert.notEqual(f.state, "GATE_ELIGIBLE", `${why}: not eligible`);
  assert.ok(f.state === "GATE_HOLD" || f.state === "EVIDENCE_READY", `${why}: HOLD, or evaluation refused with the flow left in EVIDENCE_READY (${f.state})`);
  if (f.state === "GATE_HOLD") assert.equal(f.gate?.decision, "HOLD", `${why}: gate decision`);
  else assert.deepEqual([evaluated.ok, f.gate], [false, null], `${why}: a refused evaluation reports failure and binds no gate record`);
}

// --------------------------------------------------------------------------------------------------------------- A8-01

test("REPRO-X1 (A8-01) a proposal redirected to another allowlisted beneficiary before evaluation is not eligible (HOLD or evaluation refused), is refused at review, approve and submit, and is never sent", async () => {
  // the review probe, step for step: two-entry allowlist; create; attach; rewrite proposal_json + proposal_digest
  const w = newWorld("x1", [GENUINE, ATTACKER]);
  const svc = service(w);
  const id = await driveTo(svc, "EVIDENCE_READY");
  const forged = redirectBeneficiary(w, id, { beneficiary_id: ATTACKER_BEN, beneficiary_label: ATTACKER_LABEL });
  assert.deepEqual([flowOf(svc, id).proposal.beneficiary_id, flowOf(svc, id).proposal.beneficiary_label, flowOf(svc, id).proposal.obligation_id], [forged.beneficiary_id, ATTACKER_LABEL, ELIGIBLE_CASE], "fixture: the store now holds the redirected proposal");
  assertNotEligibleAtEvaluation(svc, id, await svc.evaluateGate(OPERATOR, id), "X1");
  assertNothingSent(w, svc, id, await pushThrough(svc, id), "X1");
});

test("A8-01 regression: beneficiary id swapped while the bound label is kept is not eligible and never sent", async () => {
  const w = newWorld("x1-id", [GENUINE, ATTACKER]);
  const svc = service(w);
  const id = await driveTo(svc, "EVIDENCE_READY");
  redirectBeneficiary(w, id, { beneficiary_id: ATTACKER_BEN });
  assertNotEligibleAtEvaluation(svc, id, await svc.evaluateGate(OPERATOR, id), "id swap, label kept");
  assertNothingSent(w, svc, id, await pushThrough(svc, id), "id swap, label kept");
});

test("A8-01 regression: label swapped while the genuine id is kept is not eligible and never sent", async () => {
  const w = newWorld("x1-label", [GENUINE, ATTACKER]);
  const svc = service(w);
  const id = await driveTo(svc, "EVIDENCE_READY");
  redirectBeneficiary(w, id, { beneficiary_label: ATTACKER_LABEL });
  assertNotEligibleAtEvaluation(svc, id, await svc.evaluateGate(OPERATOR, id), "label swap, id kept");
  assertNothingSent(w, svc, id, await pushThrough(svc, id), "label swap, id kept");
});

test("A8-01 regression: when two allowlist entries carry the bound label, the binding does not resolve uniquely: not eligible, redirected or not", async () => {
  for (const redirect of [true, false]) {
    // the flow is created while the label is unique; the server then restarts over an allowlist where it is not
    const w = newWorld("x1-dup", [GENUINE]);
    const id = await driveTo(service(w), "EVIDENCE_READY");
    w.set({ beneficiaries: [GENUINE, [ATTACKER_BEN, BEN_LABEL]] });
    const svc = service(w);
    if (redirect) redirectBeneficiary(w, id, { beneficiary_id: ATTACKER_BEN });
    const why = `duplicate label, ${redirect ? "id redirected to the second entry" : "proposal untouched"}`;
    assertNotEligibleAtEvaluation(svc, id, await svc.evaluateGate(OPERATOR, id), why);
    assertNothingSent(w, svc, id, await pushThrough(svc, id), why);
  }
});

test("A8-01 regression: a two-entry allowlist does not disturb the honest flow, which pays the bound beneficiary once", async () => {
  const w = newWorld("x1-honest", [GENUINE, ATTACKER]);
  const svc = service(w);
  const id = await driveTo(svc, "HUMAN_APPROVED");
  const out = await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest);
  assert.equal(out.ok, true, out.code);
  assert.deepEqual([flowOf(svc, id).state, creates(w), sentTo(w)], ["SUBMITTED", 1, [BEN_ID]]);
});

for (const stage of ["GATE_ELIGIBLE", "AWAITING_HUMAN", "HUMAN_APPROVED"] as Stage[]) {
  test(`A8-01 regression: a proposal redirected after evaluation, at ${stage}, with every recomputable record kept consistent, is refused at every later step and never sent`, async () => {
    const w = newWorld("x1-late", [GENUINE, ATTACKER]);
    const svc = service(w);
    const id = await driveTo(svc, stage);
    redirectBeneficiary(w, id, { beneficiary_id: ATTACKER_BEN, beneficiary_label: ATTACKER_LABEL });
    assert.equal(flowOf(svc, id).proposal.beneficiary_id, ATTACKER_BEN, "fixture: the store now holds the redirected proposal");
    const steps = await pushThrough(svc, id);
    // steps that the flow had already passed honestly are refused as wrong-state; the remaining ones must refuse too
    assert.deepEqual(steps, { review: false, approve: false, submit: false }, `${stage}: every remaining step is refused`);
    assert.equal(creates(w), 0, `${stage}: 0 provider creates`);
    assert.deepEqual(sentTo(w), [], `${stage}: no provider record`);
    assert.ok(NOT_PAST_APPROVAL.includes(flowOf(svc, id).state), `${stage}: no intent was recorded (${flowOf(svc, id).state})`);
    assert.equal(flowOf(svc, id).submission.attempt_id, null);
  });
}

test("A8-01 regression: an E3 project obligation pointed at a real allowlisted beneficiary is still not eligible and never sent", async () => {
  const cases = e3Cases();
  assert.ok(cases.length >= 1, "the integrated registry carries E3 obligations");
  for (const caseId of cases) {
    const w = newWorld("x1-e3", [GENUINE, ATTACKER]);
    const svc = service(w);
    const id = await driveTo(svc, "EVIDENCE_READY", caseId);
    assert.equal(flowOf(svc, id).proposal.beneficiary_id, E3_RESERVED_BENEFICIARY_ID, `${caseId}: built with the reserved id`);
    redirectBeneficiary(w, id, { beneficiary_id: BEN_ID, beneficiary_label: BEN_LABEL });
    assertNotEligibleAtEvaluation(svc, id, await svc.evaluateGate(OPERATOR, id), `E3 ${caseId}`);
    assertNothingSent(w, svc, id, await pushThrough(svc, id), `E3 ${caseId}`);
  }
});

// --------------------------------------------------------------------------------------------------------------- A8-02

/** Approve honestly, submit once with the provider scripted to `first`, and return the authorization digest. */
async function usedOnce(w: World, svc: FlowService, first: CreateMode): Promise<{ id: string; digest: string }> {
  const id = await driveTo(svc, "HUMAN_APPROVED");
  const digest = flowOf(svc, id).authorization?.authorization_digest as string;
  w.provider.script({ create: first });
  await svc.submit(OPERATOR, id, digest);
  w.provider.script({ create: "ACCEPT" });
  return { id, digest };
}

test("REPRO-X2 (A8-02) an approval already used for a create that ended SUBMISSION_UNCERTAIN cannot be used again after the store is rolled back to HUMAN_APPROVED: the second submit is refused and creates stays 1", async () => {
  // the review probe, step for step, in ONE server process (same service instance, same approval key)
  const w = newWorld("x2", [GENUINE]);
  const svc = service(w);
  const { id, digest } = await usedOnce(w, svc, "TIMEOUT_AFTER_SEND");
  assert.deepEqual([flowOf(svc, id).state, creates(w)], ["SUBMISSION_UNCERTAIN", 1], "fixture: one create, outcome uncertain");
  rollBackToApproved(w, id);
  assert.deepEqual([flowOf(svc, id).state, flowOf(svc, id).submission.attempt_id], ["HUMAN_APPROVED", null], "fixture: the store shows an unused approval again");
  const second = await svc.submit(OPERATOR, id, digest);
  assert.equal(second.ok, false, `the second submit is refused (${second.code})`);
  assert.equal(creates(w), 1, "no second provider create");
  assert.equal(w.provider.records().length, 1);
  assert.equal((await svc.submit(OPERATOR, id, digest)).ok, false, "and it stays refused");
  assert.equal(creates(w), 1);
});

const AFTER: [string, CreateMode, FlowState, number][] = [
  ["SUBMITTED", "ACCEPT", "SUBMITTED", 1],
  ["PROVIDER_REFUSED", "REFUSE_422", "PROVIDER_REFUSED", 0],
  ["SUBMISSION_UNCERTAIN with nothing sent", "TIMEOUT_BEFORE_SEND", "SUBMISSION_UNCERTAIN", 0],
];
for (const [name, first, state, records] of AFTER) {
  test(`A8-02 regression: rollback after ${name} does not buy a second create`, async () => {
    const w = newWorld("x2-after", [GENUINE]);
    const svc = service(w);
    const { id, digest } = await usedOnce(w, svc, first);
    assert.deepEqual([flowOf(svc, id).state, creates(w), w.provider.records().length], [state, 1, records], "fixture: the approval was used for exactly one create attempt");
    rollBackToApproved(w, id);
    assert.equal(flowOf(svc, id).state, "HUMAN_APPROVED", "fixture: rolled back");
    const second = await svc.submit(OPERATOR, id, digest);
    assert.equal(second.ok, false, `the second submit is refused (${second.code})`);
    assert.equal(creates(w), 1, "no second provider create");
    assert.equal(w.provider.records().length, records, "the provider holds nothing new");
    // the rolled-back flow cannot be re-approved into a fresh authorization either
    const f = flowOf(svc, id);
    assert.equal((await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok, false, "no second approval");
    assert.equal(creates(w), 1);
  });
}

test("A8-02 regression: a second flow for the same obligation is not blocked by the first flow's used approval", async () => {
  const w = newWorld("x2-other", [GENUINE]);
  const svc = service(w);
  const first = await usedOnce(w, svc, "TIMEOUT_AFTER_SEND");
  rollBackToApproved(w, first.id);
  const id = await driveTo(svc, "HUMAN_APPROVED");
  const out = await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest);
  assert.equal(out.ok, true, out.code);
  assert.equal(creates(w), 2, "one create per flow: two flows, two request ids");
  assert.equal(new Set(w.provider.createAttempts().map((e) => e.request_id)).size, 2);
});

test("X2b (kept): the same rollback after a server restart (new approval key) is refused, creates stays 1", async () => {
  const w = newWorld("x2b", [GENUINE]);
  const { id, digest } = await usedOnce(w, service(w), "TIMEOUT_AFTER_SEND");
  rollBackToApproved(w, id);
  w.rotateApprovalKey();
  const restarted = service(w);
  assert.equal((await restarted.submit(OPERATOR, id, digest)).ok, false);
  assert.equal(creates(w), 1);
});

test("X3 (kept): three concurrent submits of one approval create exactly once", async () => {
  const w = newWorld("x3", [GENUINE]);
  const svc = service(w);
  const id = await driveTo(svc, "HUMAN_APPROVED");
  const digest = flowOf(svc, id).authorization?.authorization_digest;
  w.provider.script({ delayMs: 30 });
  const outs = await Promise.all([svc.submit(OPERATOR, id, digest), svc.submit(OPERATOR, id, digest), svc.submit(OPERATOR, id, digest)]);
  assert.equal(creates(w), 1);
  assert.equal(outs.filter((o) => o.ok).length, 1, "exactly one submit succeeds");
  assert.equal(flowOf(svc, id).state, "SUBMITTED");
});

test("X3b (kept): two server instances with different keys on one store, submitting at once, create exactly once", async () => {
  const w = newWorld("x3b", [GENUINE]);
  const issuer = service(w);
  const id = await driveTo(issuer, "HUMAN_APPROVED");
  const digest = flowOf(issuer, id).authorization?.authorization_digest;
  w.rotateApprovalKey();
  const other = service(w);
  w.provider.script({ delayMs: 30 });
  const [mine, theirs] = await Promise.all([issuer.submit(OPERATOR, id, digest), other.submit(OPERATOR, id, digest)]);
  assert.equal(creates(w), 1);
  assert.deepEqual([mine.ok, theirs.ok], [true, false], "only the instance that issued the approval can use it");
});

test("A8-NET the A8 reproductions attempted no real network connection", () => {
  assert.deepEqual(networkAttempts(), []);
});
