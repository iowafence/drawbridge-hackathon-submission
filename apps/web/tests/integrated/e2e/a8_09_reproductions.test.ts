// Reproductions of review finding A8-09 (probe "R2 residual") against the REAL merged modules, written as assertions
// of the SECURE behaviour, plus variants, fail-closed cases and kept behaviour. Offline: mock provider, network guard.
//
//   A8-09  after one provider create, a store writer rolls the flow database back to before the approval, the server
//          restarts (new approval key, empty in-memory state), a human approves again in good faith, and the same
//          obligation gets a SECOND provider create.
//
// REPRO-A8-09 is the review probe step for step. It FAILS on candidate 0121ba8 and must pass on the fix.
// Only black-box outcomes are asserted: ok, state, validate and create counts, provider records. No refusal codes,
// and nothing about where or how the server keeps its submission history.
import "../support/netGuard.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowService, FlowState, ProviderPort } from "../../../integrated/flowTypes.ts";
import { mockProvider } from "../../../integrated/paymentAdapter.ts";
import type { DataDirCopy } from "../support/a8Service.ts";
import { copyDataDir, copyStore, damageOutsideStore, driveTo, filesOutsideStore, flowOf, newWorld, OPERATOR, restoreDataDir, restoreStore, rollBackTo, service } from "../support/a8Service.ts";
import { BEN_ID, BEN_LABEL } from "../support/fixtures.ts";
import type { CreateMode } from "../support/mockProvider.ts";
import { networkAttempts } from "../support/netGuard.ts";
import type { World } from "../support/port.ts";

const GENUINE: [string, string][] = [[BEN_ID, BEN_LABEL]];
const creates = (w: World) => w.provider.createAttempts().length;
const validates = (w: World) => w.provider.journal().filter((e) => e.op === "validate").length;
const records = (w: World) => w.provider.records().length;

/** A real restart: the in-memory approval key and everything else the old process held in memory are gone. */
function restart(w: World): FlowService {
  w.rotateApprovalKey();
  return service(w);
}
/** Approve honestly, submit once with the provider scripted to `first`, then put the provider back to ACCEPT. */
async function submittedOnce(w: World, svc: FlowService, first: CreateMode): Promise<string> {
  const id = await driveTo(svc, "HUMAN_APPROVED");
  w.provider.script({ create: first });
  await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest);
  w.provider.script({ create: "ACCEPT" });
  return id;
}
/** From wherever the flow now stands, do what a good-faith operator would do next, step by step, with the digests
 *  the system itself shows, until a step is refused or the flow has been submitted. Nothing here is an assertion. */
async function operatorCarriesOn(svc: FlowService, id: string): Promise<{ approved: boolean; submitted: boolean; path: string[] }> {
  const path: string[] = [];
  let approved = false;
  let submitted = false;
  for (let i = 0; i < 6; i++) {
    const f = flowOf(svc, id);
    let ok: boolean;
    if (f.state === "EVIDENCE_READY") ok = (await svc.evaluateGate(OPERATOR, id)).ok && flowOf(svc, id).state === "GATE_ELIGIBLE";
    else if (f.state === "GATE_ELIGIBLE") ok = (await svc.requestHumanReview(OPERATOR, id)).ok;
    else if (f.state === "AWAITING_HUMAN") ok = approved = (await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok;
    else if (f.state === "HUMAN_APPROVED") ok = submitted = (await svc.submit(OPERATOR, id, f.authorization?.authorization_digest ?? "")).ok;
    else break;
    path.push(`${f.state}:${ok ? "ok" : "refused"}`);
    if (!ok || submitted) break;
  }
  return { approved, submitted, path };
}
type Before = { creates: number; validates: number; records: number };
const snapshot = (w: World): Before => ({ creates: creates(w), validates: validates(w), records: records(w) });
/** The secure outcome of a replay: the operator's second attempt did not get through, and the provider saw nothing new. */
function assertNoSecondCreate(w: World, before: Before, went: { submitted: boolean; path: string[] }, why: string): void {
  const how = `${why} [${went.path.join(" -> ") || "nothing possible"}]`;
  assert.equal(went.submitted, false, `${how}: approve or submit is refused`);
  assert.equal(creates(w), before.creates, `${how}: no second provider create`);
  assert.equal(records(w), before.records, `${how}: the provider holds nothing new`);
  assert.equal(validates(w), before.validates, `${how}: nothing was even validated`);
}

// ------------------------------------------------------------------------------------------------- the reproduction

test("REPRO-A8-09 after an uncertain create, a store rolled back to AWAITING_HUMAN, a restart and a fresh human approval do not buy a second create", async () => {
  // the review probe, step for step
  const w = newWorld("a809", GENUINE);
  const id = await submittedOnce(w, service(w), "TIMEOUT_AFTER_SEND");
  const before = snapshot(w);
  assert.deepEqual([before.creates, before.records], [1, 1], "fixture: one create reached the provider, outcome uncertain");
  rollBackTo(w, id, "AWAITING_HUMAN");
  const svc = restart(w);
  const f = flowOf(svc, id);
  assert.deepEqual([f.state, f.authorization, f.submission.attempt_id], ["AWAITING_HUMAN", null, null], "fixture: the store shows a flow that was never approved or submitted");
  assertNoSecondCreate(w, before, await operatorCarriesOn(svc, id), "A8-09");
  assert.deepEqual([creates(w), records(w)], [1, 1], "creates stays 1, provider records stay 1");
});

// ------------------------------------------------------------------------------------------------------- variants

const FIRST: [string, CreateMode, number][] = [
  ["SUBMITTED", "ACCEPT", 1],
  ["PROVIDER_REFUSED", "REFUSE_422", 0],
  ["an uncertain create that never reached the provider", "TIMEOUT_BEFORE_SEND", 0],
];
for (const [name, first, held] of FIRST) {
  test(`A8-09 variant: rollback to AWAITING_HUMAN after ${name}, restart, fresh approval: no second create`, async () => {
    const w = newWorld("a809-after", GENUINE);
    const id = await submittedOnce(w, service(w), first);
    const before = snapshot(w);
    assert.deepEqual([before.creates, before.records], [1, held], "fixture: exactly one create attempt was made");
    rollBackTo(w, id, "AWAITING_HUMAN");
    assertNoSecondCreate(w, before, await operatorCarriesOn(restart(w), id), `after ${name}`);
  });
}

for (const to of ["GATE_ELIGIBLE", "EVIDENCE_READY"] as const) {
  test(`A8-09 variant: rollback all the way to ${to}, restart, then evaluate, review, approve and submit again: no second create`, async () => {
    const w = newWorld("a809-deep", GENUINE);
    const id = await submittedOnce(w, service(w), "TIMEOUT_AFTER_SEND");
    const before = snapshot(w);
    rollBackTo(w, id, to);
    const svc = restart(w);
    assert.equal(flowOf(svc, id).state, to, "fixture: rolled back");
    assertNoSecondCreate(w, before, await operatorCarriesOn(svc, id), `rollback to ${to}`);
  });
}

test("A8-09 variant: the whole flow database file restored from a copy taken before the approval, restart, fresh approval: no second create", async () => {
  const w = newWorld("a809-restore", GENUINE);
  const first = service(w);
  const id = await driveTo(first, "AWAITING_HUMAN");
  const copy = copyStore(w);
  const f = flowOf(first, id);
  assert.equal((await first.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok, true);
  w.provider.script({ create: "TIMEOUT_AFTER_SEND" });
  await first.submit(OPERATOR, id, flowOf(first, id).authorization?.authorization_digest);
  w.provider.script({ create: "ACCEPT" });
  const before = snapshot(w);
  assert.deepEqual([flowOf(first, id).state, before.creates], ["SUBMISSION_UNCERTAIN", 1], "fixture: one create, outcome uncertain");
  restoreStore(w, copy);
  const svc = restart(w);
  assert.deepEqual([flowOf(svc, id).state, flowOf(svc, id).authorization], ["AWAITING_HUMAN", null], "fixture: the restored database knows nothing of the approval or the submission");
  assertNoSecondCreate(w, before, await operatorCarriesOn(svc, id), "database file restored");
});

test("A8-09 variant: the same rollback survives two restarts", async () => {
  const w = newWorld("a809-twice", GENUINE);
  const id = await submittedOnce(w, service(w), "TIMEOUT_AFTER_SEND");
  const before = snapshot(w);
  rollBackTo(w, id, "AWAITING_HUMAN");
  restart(w);
  assertNoSecondCreate(w, before, await operatorCarriesOn(restart(w), id), "two restarts");
  // and a third process, after that refusal, is no more permissive
  assertNoSecondCreate(w, before, await operatorCarriesOn(restart(w), id), "three restarts");
});

test("A8-09 variant: rollback and fresh approval WITHOUT a restart (same process) do not buy a second create", async () => {
  const w = newWorld("a809-same", GENUINE);
  const svc = service(w);
  const id = await submittedOnce(w, svc, "TIMEOUT_AFTER_SEND");
  const before = snapshot(w);
  rollBackTo(w, id, "AWAITING_HUMAN");
  assertNoSecondCreate(w, before, await operatorCarriesOn(svc, id), "same process");
});

test("A8-09 variant: no restart at all: a SECOND live server instance with a different approval key on the same data dir re-approves after the rollback: no second create", async () => {
  const w = newWorld("a809-two", GENUINE);
  const first = service(w);
  const id = await submittedOnce(w, first, "TIMEOUT_AFTER_SEND");
  const before = snapshot(w);
  rollBackTo(w, id, "AWAITING_HUMAN");
  w.rotateApprovalKey();
  const second = service(w); // the first instance is still alive and still holds the old key
  assertNoSecondCreate(w, before, await operatorCarriesOn(second, id), "second live instance");
  assert.equal(flowOf(first, id).submission.attempt_id, flowOf(second, id).submission.attempt_id, "both instances read the same store");
  assertNoSecondCreate(w, before, await operatorCarriesOn(first, id), "and the first instance afterwards");
});

// ------------------------------------------------------------------------------- outcome x attack matrix (owner)
// SIMULATED-PROVIDER: in every cell the provider's records live OUTSIDE the server's data dir, as a real provider's
// do, and no attack touches them. One test per cell.
//
// Row labels name two different things and keep them apart:
//   - what the SIMULATED PROVIDER actually did (ground truth only this test can know), and
//   - how the SYSTEM classified the attempt, read black-box from the flow state it recorded.
// The system never classifies a timeout or a 429 as "never sent": it cannot prove non-transmission, so those are
// UNCERTAIN to it even when the simulated provider in fact received nothing. Only two outcomes are definite to the
// system: a definitive provider refusal, and a create that was never attempted at all (validation refused).
//   ACCEPTED                              provider accepted            -> provider holds a record   system: SUBMITTED
//   UNCERTAIN-PROVIDER-RECEIVED           provider received, no answer -> provider holds a record   system: SUBMISSION_UNCERTAIN
//   UNCERTAIN-PROVIDER-NEVER-RECEIVED     nothing reached the provider -> provider holds NO record  system: SUBMISSION_UNCERTAIN
//   DEFINITIVE-PROVIDER-REFUSAL           provider refused (422)       -> provider holds NO record  system: PROVIDER_REFUSED
//   CONFIRMED-NOT-TRANSMITTED             validation refused, so the system never attempted a create -> system: HUMAN_APPROVED
// Columns are the attack that follows.
type Row = { label: string; first: CreateMode; validate: "OK" | "REFUSE_400"; attempts: 0 | 1; held: boolean; system: FlowState };
const ROWS: Row[] = [
  { label: "ACCEPTED", first: "ACCEPT", validate: "OK", attempts: 1, held: true, system: "SUBMITTED" },
  ...(["TIMEOUT_AFTER_SEND", "HTTP_500_AFTER_SEND", "HTTP_409_AFTER_SEND", "MALFORMED_201"] as CreateMode[]).map((first): Row => ({ label: "UNCERTAIN-PROVIDER-RECEIVED", first, validate: "OK", attempts: 1, held: true, system: "SUBMISSION_UNCERTAIN" })),
  ...(["TIMEOUT_BEFORE_SEND", "HTTP_429_BEFORE_SEND"] as CreateMode[]).map((first): Row => ({ label: "UNCERTAIN-PROVIDER-NEVER-RECEIVED", first, validate: "OK", attempts: 1, held: false, system: "SUBMISSION_UNCERTAIN" })),
  { label: "DEFINITIVE-PROVIDER-REFUSAL", first: "REFUSE_422", validate: "OK", attempts: 1, held: false, system: "PROVIDER_REFUSED" },
  { label: "CONFIRMED-NOT-TRANSMITTED", first: "ACCEPT", validate: "REFUSE_400", attempts: 0, held: false, system: "HUMAN_APPROVED" },
];
const CHILD = join(fileURLToPath(new URL(".", import.meta.url)), "..", "support", "child.ts");
/** One operation in a SEPARATE operating-system process over the same data dir (a second live server process). */
function inAnotherProcess(w: World, op: "approve" | "submit", flow_id: string, digests: (string | null | undefined)[]): { ok: boolean; code: string } {
  const env = { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", DBIT_NET_LOG: join(w.dir, "net_attempts.log") } as unknown as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ dir: w.dir, spec: { impl: "real" }, op, actor: OPERATOR, flow_id, digests })], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`SECOND_PROCESS_FAILED ${r.status} ${String(r.stderr).slice(0, 400)}`);
  return JSON.parse(r.stdout) as { ok: boolean; code: string };
}
type Attack = (w: World, first: FlowService, id: string, pre: DataDirCopy) => Promise<{ submitted: boolean; path: string[]; guard?: () => void }>;
const COLUMNS: [string, Attack][] = [
  ["ROLLBACK+RESTART+REAPPROVE", async (w, _first, id) => {
    rollBackTo(w, id, "AWAITING_HUMAN");
    return operatorCarriesOn(restart(w), id);
  }],
  ["SECOND-LIVE-PROCESS", async (w, first, id) => {
    // the first server process stays alive; a second OS process with its own approval key takes over the flow
    rollBackTo(w, id, "AWAITING_HUMAN");
    w.rotateApprovalKey();
    const f = flowOf(first, id);
    const approved = inAnotherProcess(w, "approve", id, [f.proposal_digest, f.gate?.gate_digest]);
    const path = [`AWAITING_HUMAN:${approved.ok ? "ok" : "refused"} (process 2)`];
    if (!approved.ok) return { submitted: false, path };
    const submitted = inAnotherProcess(w, "submit", id, [flowOf(first, id).authorization?.authorization_digest]);
    return { submitted: submitted.ok, path: [...path, `HUMAN_APPROVED:${submitted.ok ? "ok" : "refused"} (process 2)`] };
  }],
  ["HISTORY-FILES-DELETED", async (w, _first, id) => {
    const outside = filesOutsideStore(w).length;
    damageOutsideStore(w, "DELETE");
    rollBackTo(w, id, "AWAITING_HUMAN");
    const went = await operatorCarriesOn(restart(w), id);
    return { ...went, guard: () => assert.ok(outside >= 1, "fixture: the server keeps submission history in the data dir outside the flow database (A8-09 requirement 5)") };
  }],
  ["WHOLE-DATA-FOLDER-RESTORED", async (w, _first, id, pre) => {
    restoreDataDir(w, pre);
    return operatorCarriesOn(restart(w), id);
  }],
];
/** RESIDUAL R-1 (owner decision, option B): the provider holds NO record of the one create attempt, and the WHOLE
 *  data folder, database and submission history together, is restored to before the approval. Nothing the server
 *  can read then reveals the earlier attempt. These cells do NOT demonstrate protection; they record what happens. */
const isR1 = (row: Row, column: string): boolean => column === "WHOLE-DATA-FOLDER-RESTORED" && row.attempts === 1 && !row.held;
for (const row of ROWS) {
  for (const [column, attack] of COLUMNS) {
    const about = `row ${row.label} (${row.validate === "OK" ? row.first : "validate refused, create never attempted"}; simulated provider holds ${row.held ? "a record" : "NO record"}; system state ${row.system}) | column ${column}`;
    const title = isR1(row, column)
      ? `RESIDUAL R-1 — OBSERVED / NOT PROTECTED | SIMULATED-PROVIDER A8-09 matrix | ${about} | observed: 2 provider-create attempts, 1 provider record`
      : row.attempts === 0
        ? `SIMULATED-PROVIDER A8-09 matrix | ${about} | at most one create in total`
        : `SIMULATED-PROVIDER A8-09 matrix | ${about} | no second create`;
    test(title, async (t) => {
      const w = newWorld("a809-mx", GENUINE);
      const svc = service(w);
      const id = await driveTo(svc, "AWAITING_HUMAN");
      const pre = copyDataDir(w); // the pre-submit (and pre-approval) snapshot of the whole data folder
      const f = flowOf(svc, id);
      assert.equal((await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok, true);
      w.provider.script({ create: row.first, validate: row.validate });
      await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest);
      w.provider.script({ create: "ACCEPT", validate: "OK" });
      const before = snapshot(w);
      assert.deepEqual([before.creates, before.records, flowOf(svc, id).state], [row.attempts, row.held ? 1 : 0, row.system], "fixture: the create attempts, the simulated provider's records and the system's own classification are as the row says");
      const went = await attack(w, svc, id, pre);
      t.diagnostic(`${row.label}/${row.first} x ${column}: path ${went.path.join(" -> ") || "none"}; provider-create attempts ${creates(w)} (was ${before.creates}); provider records ${records(w)} (was ${before.records})`);
      if (isR1(row, column)) {
        // OBSERVED, NOT PROTECTED. If either number changes, this cell must be rewritten, not deleted.
        assert.deepEqual({ createAttempts: creates(w), providerRecords: records(w), resubmitted: went.submitted }, { createAttempts: 2, providerRecords: 1, resubmitted: true }, "RESIDUAL R-1 observed behaviour: a second create is made and accepted");
      } else if (row.attempts === 0) {
        // no create was ever attempted, so one honest create after a fresh approval is legitimate; a second never is
        assert.ok(creates(w) <= 1 && records(w) <= 1, `at most one create in total (attempts ${creates(w)}, records ${records(w)})`);
      } else assertNoSecondCreate(w, before, went, `${row.label}/${row.first} x ${column}`);
      went.guard?.();
    });
  }
}

// ---------------------------------------------------------------------------------------------- MOCK-MODE LIMIT
// NOT a guard. Evidence of a disclosed, owner-accepted limit of MOCK runtime mode: there the mock provider keeps its
// state in the data dir itself (mock-provider-state.json, see integrated/flowRuntime.ts), so a writer who restores the
// whole folder also erases the "provider's" memory of the transfer. This test does exactly that with the
// implementation's own mock provider and asserts the create count that is actually observed.
test("MOCK-MODE LIMIT (evidence, not a guard): with the mock provider's state INSIDE the data folder, a whole-folder restore plus restart plus re-approval gets a SECOND create (observed: create calls = 2)", async (t) => {
  const w = newWorld("a809-mocklimit", GENUINE);
  const stateFile = join(w.dataDir, "mock-provider-state.json");
  let createCalls = 0;
  const runtimeMock = (): ProviderPort => {
    const real = mockProvider({ stateFile });
    return { mode: "mock", validate: (b) => real.validate(b), create: (b) => { createCalls++; return real.create(b); }, readById: (x) => real.readById(x), readByRequestId: (x) => real.readByRequestId(x) };
  };
  const svc0 = service(w, runtimeMock());
  const id = await driveTo(svc0, "AWAITING_HUMAN");
  const pre = copyDataDir(w);
  const f = flowOf(svc0, id);
  assert.equal((await svc0.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest)).ok, true);
  assert.equal((await svc0.submit(OPERATOR, id, flowOf(svc0, id).authorization?.authorization_digest)).ok, true);
  assert.deepEqual([flowOf(svc0, id).state, createCalls, mockProvider({ stateFile }).records().length], ["SUBMITTED", 1, 1], "fixture: one accepted create, recorded in the folder");
  restoreDataDir(w, pre); // the folder goes back, INCLUDING mock-provider-state.json
  w.rotateApprovalKey();
  const svc = service(w, runtimeMock());
  const went = await operatorCarriesOn(svc, id);
  const observed = { path: went.path.join(" -> "), submitted: went.submitted, createCalls, recordsInFolder: mockProvider({ stateFile }).records().length, state: flowOf(svc, id).state };
  t.diagnostic(`MOCK-MODE LIMIT observed: ${JSON.stringify(observed)}`);
  assert.equal(observed.createCalls, 2, "OBSERVED LIMIT: the second create happens. If this ever becomes 1, the limit is gone and this test must be rewritten as a guard, not deleted");
  assert.deepEqual([observed.submitted, observed.state], [true, "SUBMITTED"], "OBSERVED LIMIT: the replayed flow reaches SUBMITTED a second time");
});

// ---------------------------------------------------------------------------------------------------- fail closed
// "Missing, malformed or inconsistent submission history" must stop payments, not permit them. These tests damage
// EVERY file the server keeps in its data directory outside the flow database, without knowing its name or format.

for (const how of ["DELETE", "TRUNCATE", "GARBLE"] as const) {
 for (const [first, held] of [["TIMEOUT_AFTER_SEND", true], ["REFUSE_422", false]] as [CreateMode, boolean][]) {
  test(`A8-09 fail closed [provider holds ${held ? "a record" : "NO record"}]: submission history ${how}D after ${first}, store rolled back, restart, fresh approval: no second create`, async () => {
    const w = newWorld("a809-hist", GENUINE);
    const id = await submittedOnce(w, service(w), first);
    const before = snapshot(w);
    const outside = filesOutsideStore(w).length;
    damageOutsideStore(w, how);
    rollBackTo(w, id, "AWAITING_HUMAN");
    assertNoSecondCreate(w, before, await operatorCarriesOn(restart(w), id), `history ${how}`);
    // guard against a vacuous pass: there must have been a history outside the database for this test to damage
    assert.ok(outside >= 1, "fixture: the server keeps submission history in the data dir outside the flow database (A8-09 requirement 5)");
  });
 }

  test(`A8-09 fail closed: submission history ${how}D while the store still shows the submission: a restarted server makes no further create, not even for a new flow`, async () => {
    const w = newWorld("a809-incons", GENUINE);
    const id = await submittedOnce(w, service(w), "TIMEOUT_AFTER_SEND");
    const before = snapshot(w);
    const outside = filesOutsideStore(w).length;
    damageOutsideStore(w, how);
    const svc = restart(w);
    assertNoSecondCreate(w, before, await operatorCarriesOn(svc, id), `history ${how}, same flow`);
    // a different flow for the same obligation: the server can no longer tell what was already sent, so it must not send
    let other: string | null = null;
    try {
      other = await driveTo(svc, "AWAITING_HUMAN");
    } catch {
      other = null; // refusing earlier (create, evaluate or review) is also fail-closed
    }
    if (other) assertNoSecondCreate(w, before, await operatorCarriesOn(svc, other), `history ${how}, new flow`);
    assert.deepEqual([creates(w), records(w)], [before.creates, before.records], `history ${how}: nothing new at the provider`);
    assert.ok(outside >= 1, "fixture: the server keeps submission history in the data dir outside the flow database (A8-09 requirement 5)");
  });
}

// ---------------------------------------------------------------------------------------------------- kept behaviour

test("A8-09 kept: an honest flow on a fresh data dir is paid exactly once", async () => {
  const w = newWorld("a809-honest", GENUINE);
  const svc = service(w);
  const id = await driveTo(svc, "HUMAN_APPROVED");
  const out = await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest);
  assert.equal(out.ok, true, out.code);
  assert.deepEqual([flowOf(svc, id).state, creates(w), validates(w), records(w)], ["SUBMITTED", 1, 1, 1]);
});

test("A8-09 kept: a second, different flow for the same obligation is still allowed, in the same process and after a restart", async () => {
  const w = newWorld("a809-second", GENUINE);
  let svc = service(w);
  await submittedOnce(w, svc, "TIMEOUT_AFTER_SEND");
  for (const [n, restarted] of [[2, false], [3, true]] as [number, boolean][]) {
    if (restarted) svc = restart(w);
    const id = await driveTo(svc, "HUMAN_APPROVED");
    const out = await svc.submit(OPERATOR, id, flowOf(svc, id).authorization?.authorization_digest);
    assert.equal(out.ok, true, `flow ${n}${restarted ? " after a restart" : ""}: ${out.code}`);
    assert.equal(creates(w), n, "one create per flow");
  }
  assert.equal(new Set(w.provider.createAttempts().map((e) => e.request_id)).size, 3, "each flow has its own provider request id");
});

test("A8-09 kept: after a restart, read-back still resolves the uncertain flow and creates nothing", async () => {
  const w = newWorld("a809-read", GENUINE);
  const id = await submittedOnce(w, service(w), "TIMEOUT_AFTER_SEND");
  const svc = restart(w);
  assert.equal(flowOf(svc, id).state, "SUBMISSION_UNCERTAIN" satisfies FlowState);
  assert.equal((await svc.reconcile(OPERATOR, id)).ok, true);
  assert.deepEqual([flowOf(svc, id).state, creates(w)], ["PROVIDER_PROCESSING", 1]);
});

test("A8-09-NET the A8-09 reproductions attempted no real network connection", () => {
  assert.deepEqual(networkAttempts(), []);
});
