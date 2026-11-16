// Candidate-4 reproductions against the REAL merged modules. Offline: simulated provider in memory, network guard.
//
//   A8-11  the read-only request-id lookup treats provider answers it does not recognise as "no record". Three
//          shapes, each from a provider that DOES hold the earlier transfer. Secure outcome: the approval or the
//          submission is refused and no further create call is made. These FAIL on candidate 3 (76367b0).
//   R-3    RESIDUAL, OBSERVED / NOT PROTECTED (A8-10). The first create was accepted, or is still in flight, but
//          the provider's lookup does not show it; the whole data folder is restored; a fresh approval follows.
//          These tests record what happens. They are not protection and are not expected to change on candidate 4.
//
// Wording: "create calls" are calls the SYSTEM made. "Transfers" is used only for the simulated provider's own
// books. Two create calls are NOT two transfers unless the provider's books say so, and whether the real provider
// deduplicates on request id, or how soon its lookup shows a new transfer, is UNVERIFIED.
import "../support/netGuard.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { FlowService } from "../../../integrated/flowTypes.ts";
import { copyDataDir, driveTo, flowOf, newWorld, OPERATOR, restoreDataDir, service } from "../support/a8Service.ts";
import type { DataDirCopy } from "../support/a8Service.ts";
import { BEN_ID, BEN_LABEL } from "../support/fixtures.ts";
import { networkAttempts } from "../support/netGuard.ts";
import type { World } from "../support/port.ts";
import { SimulatedProvider } from "../support/simulatedProvider.ts";
import type { LookupShape } from "../support/simulatedProvider.ts";

const GENUINE: [string, string][] = [[BEN_ID, BEN_LABEL]];

/** From wherever the flow stands, do what a good-faith operator would do next, with the digests the system shows,
 *  until a step is refused or the flow has been submitted. Nothing here is an assertion. */
async function operatorCarriesOn(svc: FlowService, id: string): Promise<{ submitted: boolean; path: string[] }> {
  const path: string[] = [];
  let submitted = false;
  for (let i = 0; i < 6; i++) {
    const f = flowOf(svc, id);
    let ok: boolean;
    if (f.state === "EVIDENCE_READY") ok = (await svc.evaluateGate(OPERATOR, id)).ok && flowOf(svc, id).state === "GATE_ELIGIBLE";
    else if (f.state === "GATE_ELIGIBLE") ok = (await svc.requestHumanReview(OPERATOR, id)).ok;
    else if (f.state === "AWAITING_HUMAN") ok = (await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok;
    else if (f.state === "HUMAN_APPROVED") ok = submitted = (await svc.submit(OPERATOR, id, f.authorization?.authorization_digest ?? "")).ok;
    else break;
    path.push(`${f.state}:${ok ? "ok" : "refused"}`);
    if (!ok || submitted) break;
  }
  return { submitted, path };
}
function restart(w: World, p: SimulatedProvider): FlowService {
  w.rotateApprovalKey();
  return service(w, p);
}
/** An honest flow whose one create the provider ACCEPTED, plus the snapshot of the whole data folder taken before the
 *  approval. After this the provider's books hold exactly one transfer for the flow's request id. */
async function acceptedOnce(label: string): Promise<{ w: World; p: SimulatedProvider; id: string; pre: DataDirCopy; requestId: string }> {
  const w = newWorld(label, GENUINE);
  const p = new SimulatedProvider();
  const svc = service(w, p);
  const id = await driveTo(svc, "AWAITING_HUMAN");
  const pre = copyDataDir(w);
  const f = flowOf(svc, id);
  assert.equal((await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok, true);
  assert.equal((await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest)).ok, true);
  const requestId = flowOf(svc, id).proposal.provider_request_id;
  assert.deepEqual([flowOf(svc, id).state, p.createCalls, p.transfers.filter((t) => t.request_id === requestId).length], ["SUBMITTED", 1, 1], "fixture: one create call, accepted, one transfer on the provider's books");
  assert.notEqual(requestId, requestId.toUpperCase(), "fixture: the request id contains letters, so an upper-case copy differs");
  return { w, p, id, pre, requestId };
}

// --------------------------------------------------------------------------------------------------------- A8-11
// The provider HOLDS the earlier transfer in every one of these. Local knowledge of it is gone (whole data folder
// restored, server restarted), so the lookup is the only thing that can stop a second create, and "no record" is
// the wrong reading of each answer. `point` is which of the three lookups first receives the shape: the one at
// approval, the one at submit before validation, or the one after the intent is recorded, immediately before create.
const SHAPES: [string, LookupShape][] = [
  ["(a) 200 list with a pagination cursor and NO has_more", "CURSOR_WITHOUT_HAS_MORE"],
  ["(b) record keyed client_request_id, no request_id field", "KEYED_CLIENT_REQUEST_ID"],
  ["(c) record whose request_id matches ours only case-insensitively", "REQUEST_ID_UPPERCASE"],
];
const POINTS: [string, 1 | 2 | 3][] = [["at approval", 1], ["at submit, before validation", 2], ["after the intent, before create", 3]];
for (const [name, shape] of SHAPES) {
  for (const [where, point] of POINTS) {
    test(`SIMULATED-PROVIDER A8-11 ${name} | first seen ${where} | the provider holds the earlier transfer | refused, 0 extra create calls`, async (t) => {
      const { w, p, id, pre, requestId } = await acceptedOnce("a811");
      restoreDataDir(w, pre);
      p.arm(shape, point);
      const validatesBefore = p.validateCalls;
      const svc = restart(w, p);
      const went = await operatorCarriesOn(svc, id);
      t.diagnostic(`${shape} @lookup ${point}: path ${went.path.join(" -> ")}; create calls ${p.createCalls} (was 1); transfers on the provider's books ${p.transfers.length} (was 1); state ${flowOf(svc, id).state}`);
      assert.equal(went.submitted, false, `${shape} ${where}: approve or submit is refused [${went.path.join(" -> ")}]`);
      assert.equal(p.createCalls, 1, `${shape} ${where}: 0 extra create calls`);
      assert.equal(p.transfers.filter((x) => x.request_id === requestId).length, 1, `${shape} ${where}: the provider's books are unchanged`);
      if (point < 3) assert.equal(p.validateCalls, validatesBefore, `${shape} ${where}: refused before anything was validated`);
      assert.notEqual(flowOf(svc, id).state, "SUBMITTED", `${shape} ${where}: the flow is not presented as submitted again`);
    });
  }
}

test("SIMULATED-PROVIDER A8-11 control: a well-formed answer that shows the earlier transfer is refused at approval, 0 extra create calls", async () => {
  const { w, p, id, pre } = await acceptedOnce("a811-control");
  restoreDataDir(w, pre);
  const lookups = p.lookupCalls;
  const went = await operatorCarriesOn(restart(w, p), id);
  assert.deepEqual([went.submitted, went.path, p.createCalls, p.transfers.length, p.lookupCalls - lookups], [false, ["AWAITING_HUMAN:refused"], 1, 1, 1]);
});

test("SIMULATED-PROVIDER A8-11 control: well-formed empty answers do not block an honest flow, which makes exactly one create call", async () => {
  const w = newWorld("a811-honest", GENUINE);
  const p = new SimulatedProvider();
  const svc = service(w, p);
  const id = await driveTo(svc, "HUMAN_APPROVED");
  assert.equal((await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest)).ok, true);
  assert.deepEqual([flowOf(svc, id).state, p.createCalls, p.transfers.length, p.lookupCalls], ["SUBMITTED", 1, 1, 3]);
});

// ----------------------------------------------------------------------------------------------------------- R-3
// NOT protection. The observed values are asserted exactly. If one changes, rewrite the test; do not delete it.
// "Possible financial effect" is stated only as far as the simulated provider's own books show it.
for (const dedup of [true, false]) {
  const model = `UNVERIFIED provider property modelled: request-id dedup ${dedup ? "ON" : "OFF"}`;

  test(`RESIDUAL R-3 — OBSERVED / NOT PROTECTED | SIMULATED-PROVIDER | first create ACCEPTED but not visible to the lookup (lag) | whole data folder restored, restart, fresh approval | ${model} | observed: 2 create calls, ${dedup ? 1 : 2} transfer${dedup ? "" : "s"} on the simulated provider's books`, async (t) => {
    const { w, p, id, pre, requestId } = await acceptedOnce("r3-lag");
    p.dedup = dedup;
    p.lookupLags = true; // the provider accepted the transfer; its request-id lookup does not show it
    restoreDataDir(w, pre);
    const svc = restart(w, p);
    const went = await operatorCarriesOn(svc, id);
    const observed = { path: went.path, resubmitAccepted: went.submitted, createCalls: p.createCalls, transfersOnProviderBooks: p.transfers.filter((x) => x.request_id === requestId).length, state: flowOf(svc, id).state };
    t.diagnostic(`R-3 lag, dedup ${dedup ? "ON" : "OFF"}: ${JSON.stringify(observed)}`);
    assert.deepEqual(observed, dedup
      ? { path: ["AWAITING_HUMAN:ok", "HUMAN_APPROVED:refused"], resubmitAccepted: false, createCalls: 2, transfersOnProviderBooks: 1, state: "SUBMISSION_UNCERTAIN" }
      : { path: ["AWAITING_HUMAN:ok", "HUMAN_APPROVED:ok"], resubmitAccepted: true, createCalls: 2, transfersOnProviderBooks: 2, state: "SUBMITTED" },
    dedup
      ? "OBSERVED: a second create CALL is made. A provider that deduplicates on request id books ONE transfer; the system ends uncertain. Possible financial effect under this model: none beyond the first transfer"
      : "OBSERVED: a second create CALL is made. A provider that does NOT deduplicate books TWO transfers. Possible financial effect under this model: a duplicate payment. Whether the real provider behaves this way is UNVERIFIED");
  });

  test(`RESIDUAL R-3 — OBSERVED / NOT PROTECTED | SIMULATED-PROVIDER | first create still IN FLIGHT | whole data folder restored, second server instance, fresh approval | ${model} | observed: 2 create calls, ${dedup ? 1 : 2} transfer${dedup ? "" : "s"} on the simulated provider's books`, async (t) => {
    const w = newWorld("r3-flight", GENUINE);
    const p = new SimulatedProvider();
    p.dedup = dedup;
    const first = service(w, p);
    const id = await driveTo(first, "AWAITING_HUMAN");
    const pre = copyDataDir(w);
    const f = flowOf(first, id);
    assert.equal((await first.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok, true);
    const requestId = f.proposal.provider_request_id;
    p.holdCreates = true;
    const inFlight = first.submit(OPERATOR, id, flowOf(first, id).authorization?.authorization_digest).then((o) => o.code, (e: unknown) => `threw ${String(e).slice(0, 80)}`);
    for (let i = 0; i < 2000 && p.createCalls < 1; i++) await new Promise((r) => setTimeout(r, 2));
    assert.deepEqual([p.createCalls, p.transfers.length], [1, 0], "fixture: the first create call has been made and has not yet reached the provider's books");
    restoreDataDir(w, pre); // while the first server instance is still waiting for the provider
    p.holdCreates = false; // only the first call is held; the second goes straight through
    const second = restart(w, p);
    const went = await operatorCarriesOn(second, id);
    p.releaseCreates(); // now the first, delayed create arrives at the provider
    const firstOutcome = await inFlight;
    const observed = { secondPath: went.path, secondSubmitAccepted: went.submitted, createCalls: p.createCalls, transfersOnProviderBooks: p.transfers.filter((x) => x.request_id === requestId).length };
    t.diagnostic(`R-3 in flight, dedup ${dedup ? "ON" : "OFF"}: ${JSON.stringify(observed)}; the first instance's own submit ended: ${firstOutcome}`);
    assert.deepEqual(observed, { secondPath: ["AWAITING_HUMAN:ok", "HUMAN_APPROVED:ok"], secondSubmitAccepted: true, createCalls: 2, transfersOnProviderBooks: dedup ? 1 : 2 },
      dedup
        ? "OBSERVED: two create CALLS. A provider that deduplicates on request id books ONE transfer (the later arrival is refused as a duplicate)"
        : "OBSERVED: two create CALLS and, with no provider dedup, TWO transfers on the simulated provider's books. Whether the real provider behaves this way is UNVERIFIED");
  });
}

test("A8-11-R3-NET these reproductions attempted no real network connection", () => {
  assert.deepEqual(networkAttempts(), []);
});
