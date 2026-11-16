// A3 candidate-3 tests for cold review finding A8-09: a database rollback, then a restart (or a second process), then
// a fresh human approval, must not lead to a second provider create. Builder-side unit tests with this lane's fakes.
// The independent reproductions belong to the test lane and the reviewer. Offline: the provider is the mock.
//
// In these tests the mock provider's state file lives OUTSIDE the data directory (world() puts it beside it), which
// models a provider whose records the store writer cannot reach. One test (H-12) deliberately rolls that file back
// too, to show what the provider lookup does NOT protect against.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFlowService } from "../../../../integrated/flowService.ts";
import type { ProviderCallResult, ProviderPort } from "../../../../integrated/flowTypes.ts";
import type { MockScript } from "../../../../integrated/paymentAdapter.ts";
import { appendIntent, historyPath, readSubmissionHistory, SUBMISSION_HISTORY_FILE } from "../../../../integrated/submissionHistory.ts";
import { CASE, DOC, drive, OPERATOR, submit, world } from "./support.ts";
import type { World } from "./support.ts";

const CHILD = join(fileURLToPath(new URL(".", import.meta.url)), "child.ts");
const NEW_KEY = () => new Uint8Array(32).fill(8);

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
/** Roll one flow back to AWAITING_HUMAN as if it had never been approved or submitted. */
const ROLLBACK = (id: string) => `DELETE FROM flow_submit_attempt WHERE flow_id='${id}'; DELETE FROM flow_authorization WHERE flow_id='${id}';
  UPDATE flow SET state='AWAITING_HUMAN', authorization_json=NULL, gate_consumed_at_ms=NULL, attempt_id=NULL, attempt_recorded_at_ms=NULL, provider_mode=NULL, authorization_consumed_at_ms=NULL,
    provider_transfer_id=NULL, create_http_status=NULL, create_reported_status=NULL, last_provider_status=NULL, last_provider_read_at_ms=NULL, version=version+1 WHERE flow_id='${id}'`;
const calls = (w: World) => [w.provider.calls().validate, w.provider.calls().create];
const restart = (w: World) => world(w.dir, { clock: w.clock, approvalKey: NEW_KEY() }); // new process: new key, empty memory
const history = (w: World) => readSubmissionHistory(w.deps.dataDir);
const histFile = (w: World) => historyPath(w.deps.dataDir);
const approveAgain = (w: World, id: string) => {
  const f = w.rec(id);
  return w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest);
};
const lastRefusal = (w: World, id: string) => {
  const e = w.events(id).at(-1)!;
  return [e.type, e.data.op, e.data.code];
};

// ------------------------------------------------------------------------------------------------------------
// The finding itself: rollback + restart (or second process) + fresh human approval
// ------------------------------------------------------------------------------------------------------------

test("A3-H01 (A8-09) rollback to AWAITING_HUMAN, restart with a new key, fresh approval: refused from the history, whatever the first create's outcome", async () => {
  const cases: [NonNullable<MockScript["create"]>, string, string][] = [
    ["TIMEOUT_AFTER_SEND", "SUBMISSION_UNCERTAIN", "UNCERTAIN"], ["HTTP_500_AFTER_SEND", "SUBMISSION_UNCERTAIN", "UNCERTAIN"], ["HTTP_409_AFTER_SEND", "SUBMISSION_UNCERTAIN", "UNCERTAIN"],
    ["ACCEPT", "SUBMITTED", "SENT_ACCEPTED"], ["REFUSE_422", "PROVIDER_REFUSED", "SENT_REFUSED"], ["REFUSE_400", "PROVIDER_REFUSED", "SENT_REFUSED"],
    ["HTTP_429_BEFORE_SEND", "SUBMISSION_UNCERTAIN", "UNCERTAIN"], ["TIMEOUT_BEFORE_SEND", "SUBMISSION_UNCERTAIN", "UNCERTAIN"], ["HTTP_500_BEFORE_SEND", "SUBMISSION_UNCERTAIN", "UNCERTAIN"],
  ];
  for (const [script, reached, outcome] of cases) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    const before = w.rec(id);
    w.provider.script.create = script;
    await submit(w, id);
    assert.deepEqual([w.rec(id).state, calls(w)], [reached, [1, 1]], script);
    const h = history(w);
    assert.ok(h.ok && h.live.length === 1, script);
    assert.deepEqual([h.ok && h.live[0].flow_id, h.ok && h.live[0].provider_request_id, h.ok && h.live[0].authorization_digest, h.ok && h.live[0].outcome],
      [id, before.proposal.provider_request_id, before.authorization!.authorization_digest, outcome], `${script}: the intent and its outcome class are on record outside the database`);

    untrustedWrite(w, ROLLBACK(id));
    const r = restart(w);
    r.provider.script.create = "ACCEPT"; // the provider would accept; it must not be asked to create
    const rolled = r.rec(id);
    assert.deepEqual([rolled.state, rolled.authorization, rolled.submission.attempt_id, rolled.gate_consumed_at_ms], ["AWAITING_HUMAN", null, null, null], `${script}: the store says this flow was never approved or submitted`);
    assert.deepEqual(await approveAgain(r, id), { ok: false, code: "SUBMISSION_ALREADY_RECORDED" }, script);
    assert.deepEqual([r.rec(id).state, r.rec(id).authorization, calls(r)], ["AWAITING_HUMAN", null, [1, 1]], `${script}: no approval, no second validate, no second create`);
    assert.deepEqual(lastRefusal(r, id), ["REFUSED", "approve", "SUBMISSION_ALREADY_RECORDED"], "the refusal is audited");
    // a brand new flow for the same case is a different transaction and is not blocked
    const fresh = await drive(r, "HUMAN_APPROVED");
    assert.equal((await submit(r, fresh)).code, "SUBMITTED");
    assert.equal(r.provider.calls().create, 2);
  }
});

test("A3-H02 (A8-09) the same with the audit chain rewritten to hide the submit, and with a second LIVE process instead of a restart", async () => {
  // audit rows after the review request removed: the chain in the database verifies and shows no submit at all
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  w.provider.script.create = "TIMEOUT_AFTER_SEND";
  await submit(w, id);
  const keep = w.events(id).findIndex((e) => e.type === "HUMAN_REVIEW_REQUESTED") + 1;
  untrustedWrite(w, `${ROLLBACK(id)}; DELETE FROM a3_test_audit WHERE flow_id='${id}' AND seq > (SELECT seq FROM a3_test_audit WHERE flow_id='${id}' ORDER BY seq LIMIT 1 OFFSET ${keep - 1})`);
  const r = restart(w);
  assert.ok(!r.types(id).includes("SUBMIT_INTENT_RECORDED") && r.deps.audit.verify(new (process.getBuiltinModule("node:sqlite").DatabaseSync)(join(r.deps.dataDir, "flow-v1.sqlite"))).ok, "the audit chain in the database now verifies and hides the submit");
  assert.deepEqual([await approveAgain(r, id), calls(r)], [{ ok: false, code: "SUBMISSION_ALREADY_RECORDED" }, [1, 1]]);

  // no restart: process B (its own key, its own memory) is alive the whole time and sees A's intent on disk
  const a = world();
  const b = world(a.dir, { clock: a.clock, approvalKey: NEW_KEY() });
  const aid = await drive(a, "HUMAN_APPROVED");
  a.provider.script.create = "HTTP_500_AFTER_SEND";
  await submit(a, aid);
  untrustedWrite(a, ROLLBACK(aid));
  assert.deepEqual([await approveAgain(b, aid), calls(b)], [{ ok: false, code: "SUBMISSION_ALREADY_RECORDED" }, [1, 1]], "the history is read from disk at every check, never cached");
  assert.deepEqual(await approveAgain(a, aid), { ok: false, code: "CREATE_ALREADY_ATTEMPTED" }, "process A still refuses from its own memory first");
});

test("A3-H03 (A8-09) eight OS processes racing one submit: one create, one live intent in the history, chain intact", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const run = () => new Promise<{ ok: boolean; code: string }>((resolve, rejectP) => {
    const p = spawn(process.execPath, ["--no-warnings", CHILD, w.dir, id, "none", String(w.clock.t)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rejectP);
    p.on("close", (c) => (c === 0 ? resolve(JSON.parse(out.trim())) : rejectP(new Error(`child ${c}: ${err}`))));
  });
  const outs = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(outs.filter((o) => o.ok).length, 1, JSON.stringify(outs));
  const h = history(w);
  assert.ok(h.ok, "the history still verifies after concurrent writers");
  assert.deepEqual([h.ok && h.live.length, h.ok && h.live[0].flow_id, h.ok && h.live[0].outcome, w.provider.calls().create], [1, id, "SENT_ACCEPTED", 1]);
});

// ------------------------------------------------------------------------------------------------------------
// Fail-closed matrix: missing, malformed, broken, inconsistent
// ------------------------------------------------------------------------------------------------------------

/** One approved flow (A) that has been submitted, one flow (B) awaiting a human, one flow (C) approved, in one store. */
async function three(script: NonNullable<MockScript["create"]> = "ACCEPT") {
  const w = world();
  const a = await drive(w, "HUMAN_APPROVED");
  w.provider.script.create = script;
  await submit(w, a);
  w.provider.script.create = "ACCEPT";
  const b = await drive(w, "AWAITING_HUMAN");
  const c = await drive(w, "HUMAN_APPROVED");
  return { w, a, b, c };
}
/** Every approve and submit in the store refuses with `code`, is audited, and nothing reaches validate or create. */
async function everythingRefuses(w: World, b: string, c: string, code: string, label: string) {
  const before = calls(w);
  assert.deepEqual(await approveAgain(w, b), { ok: false, code }, `${label}: approve`);
  assert.deepEqual(lastRefusal(w, b), ["REFUSED", "approve", code], `${label}: audited`);
  assert.deepEqual(await submit(w, c), { ok: false, code }, `${label}: submit`);
  assert.deepEqual(lastRefusal(w, c), ["REFUSED", "submit", code], `${label}: audited`);
  assert.deepEqual([w.rec(b).state, w.rec(c).state, w.rec(c).submission.attempt_id, calls(w)], ["AWAITING_HUMAN", "HUMAN_APPROVED", null, before], `${label}: no state change, zero validate, zero create`);
}

test("A3-H04 (matrix: missing) no history file while the store holds any flow: every approve and submit refuses; a fresh install gets one", async () => {
  const fresh = world();
  assert.deepEqual([existsSync(histFile(fresh)), history(fresh).ok && (history(fresh) as { lines: number }).lines], [true, 1], "a store with no flows gets a header-only history");
  const { w, b, c } = await three();
  renameSync(histFile(w), `${histFile(w)}.removed`);
  await everythingRefuses(w, b, c, "SUBMISSION_HISTORY_MISSING", "deleted");
  const r = world(w.dir, { clock: w.clock }); // a restart does NOT quietly create a new empty history for a store with flows
  assert.equal(existsSync(histFile(r)), false);
  await everythingRefuses(r, b, c, "SUBMISSION_HISTORY_MISSING", "deleted, after restart");
  // even a store whose flows have never been approved is not given a fresh history
  const young = world();
  const yid = await drive(young, "AWAITING_HUMAN");
  renameSync(histFile(young), `${histFile(young)}.removed`);
  const y2 = world(young.dir, { clock: young.clock });
  assert.deepEqual([existsSync(histFile(y2)), await approveAgain(y2, yid)], [false, { ok: false, code: "SUBMISSION_HISTORY_MISSING" }]);
});

test("A3-H05 (matrix: malformed) an empty file, a torn last line, a line that is not JSON, or a line with the wrong shape", async () => {
  const damage: [string, (text: string) => string][] = [
    ["empty file", () => ""],
    ["torn last line", (t) => t.slice(0, -5)],
    ["no final newline", (t) => t.slice(0, -1)],
    ["a line that is not JSON", (t) => `${t}this is not json\n`],
    ["a JSON array line", (t) => `${t}[1,2,3]\n`],
    ["an unknown kind", (t) => `${t}${JSON.stringify({ v: 1, kind: "RESET", seq: 99, prev: "0".repeat(64), hash: "0".repeat(64) })}\n`],
    ["an extra key", (t) => t.replace('"kind":"INTENT"', '"kind":"INTENT","note":"x"')],
    ["a missing key", (t) => t.replace(/"provider_mode":"mock",/, "")],
    ["a non-hex digest", (t) => t.replace(/"authorization_digest":"[0-9a-f]{64}"/, '"authorization_digest":"zz"')],
    ["a blank line", (t) => t.replace("\n", "\n\n")],
  ];
  for (const [label, edit] of damage) {
    const { w, b, c } = await three();
    writeFileSync(histFile(w), edit(readFileSync(histFile(w), "utf8")));
    assert.deepEqual(history(w), { ok: false, code: "SUBMISSION_HISTORY_MALFORMED" }, label);
    await everythingRefuses(w, b, c, "SUBMISSION_HISTORY_MALFORMED", label);
  }
});

test("A3-H06 (matrix: broken) an edited field, a removed line, reordered lines, a truncated head, a duplicated or orphaned line", async () => {
  const lines = (t: string) => t.slice(0, -1).split("\n");
  const join2 = (ls: string[]) => `${ls.join("\n")}\n`;
  const damage: [string, (text: string) => string][] = [
    ["an edited flow id (hash no longer matches)", (t) => t.replace(/"flow_id":"[0-9a-f]/, (m) => `${m.slice(0, -1)}${m.endsWith("f") ? "e" : "f"}`)],
    ["an edited outcome", (t) => t.replace('"outcome":"SENT_ACCEPTED"', '"outcome":"NOT_TRANSMITTED"')],
    ["the header removed", (t) => join2(lines(t).slice(1))],
    ["a middle line removed", (t) => join2([lines(t)[0], ...lines(t).slice(2)])],
    ["two lines swapped", (t) => join2([lines(t)[0], lines(t)[2], lines(t)[1], ...lines(t).slice(3)])],
    ["a line duplicated", (t) => join2([...lines(t), lines(t)[1]])],
  ];
  for (const [label, edit] of damage) {
    const { w, b, c } = await three();
    writeFileSync(histFile(w), edit(readFileSync(histFile(w), "utf8")));
    assert.deepEqual(history(w), { ok: false, code: "SUBMISSION_HISTORY_BROKEN" }, label);
    await everythingRefuses(w, b, c, "SUBMISSION_HISTORY_BROKEN", label);
  }
});

test("A3-H07 (matrix: inconsistent, both directions) the store holds an attempt the history lacks; the history names a flow the store has never held", async () => {
  // direction 1: the history is cut back to its header (or replaced by a forged header-only file) while the
  // database still shows the submit. The store knows an attempt the history does not: everything refuses.
  const t = await three();
  const header = readFileSync(histFile(t.w), "utf8").split("\n")[0];
  writeFileSync(histFile(t.w), `${header}\n`);
  assert.ok(history(t.w).ok, "the truncated history is itself well formed");
  await everythingRefuses(t.w, t.b, t.c, "SUBMISSION_HISTORY_INCONSISTENT", "history truncated to its header");
  // also when the attempt is in the history but under different ids
  const m = await three();
  const other = world();
  const oid = await drive(other, "HUMAN_APPROVED");
  await submit(other, oid);
  copyFileSync(histFile(other), histFile(m.w)); // a valid history, from a different store
  await everythingRefuses(m.w, m.b, m.c, "SUBMISSION_HISTORY_INCONSISTENT", "history from another store");

  // direction 2: the history names an intent for a flow that exists but has lost its attempt (the rollback): that
  // flow is refused for good, and the rest of the store keeps working
  const r = await three("TIMEOUT_AFTER_SEND");
  untrustedWrite(r.w, ROLLBACK(r.a));
  assert.deepEqual(await approveAgain(r.w, r.a), { ok: false, code: "CREATE_ALREADY_ATTEMPTED" });
  const rr = restart(r.w);
  assert.deepEqual(await approveAgain(rr, r.a), { ok: false, code: "SUBMISSION_ALREADY_RECORDED" });
  assert.equal((await approveAgain(rr, r.b)).code, "HUMAN_APPROVED", "an unrelated flow in the same store is still served");
});

// ------------------------------------------------------------------------------------------------------------
// Whole data-directory attacks, the provider lookup, and what remains
// ------------------------------------------------------------------------------------------------------------

test("A3-H08 (A8-09 c, d) history restored to its pre-submit copy, or deleted: stopped by the provider's own record, or by the missing history", async () => {
  for (const script of ["TIMEOUT_AFTER_SEND", "HTTP_500_AFTER_SEND", "ACCEPT"] as const) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    copyFileSync(histFile(w), `${histFile(w)}.snapshot`); // the writer keeps a copy from before the submit
    w.provider.script.create = script;
    await submit(w, id);
    untrustedWrite(w, ROLLBACK(id));
    copyFileSync(`${histFile(w)}.snapshot`, histFile(w)); // ... and restores it: the local history no longer names the intent
    const r = restart(w);
    r.provider.script.create = "ACCEPT";
    const h = history(r);
    assert.ok(h.ok && h.live.length === 0, "local state is now fully consistent and shows no submit");
    assert.deepEqual(await approveAgain(r, id), { ok: false, code: "PROVIDER_RECORD_EXISTS" }, `${script}: the provider still holds the record for this request id`);
    assert.deepEqual([r.rec(id).state, r.rec(id).authorization, calls(r)], ["AWAITING_HUMAN", null, [1, 1]], script);
    assert.deepEqual(lastRefusal(r, id), ["REFUSED", "approve", "PROVIDER_RECORD_EXISTS"]);
  }
  // deleted instead of restored: the store has flows and no history
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  w.provider.script.create = "REFUSE_422"; // even though the provider holds nothing for this one
  await submit(w, id);
  untrustedWrite(w, ROLLBACK(id));
  renameSync(histFile(w), `${histFile(w)}.removed`);
  const r = restart(w);
  assert.deepEqual([await approveAgain(r, id), calls(r)], [{ ok: false, code: "SUBMISSION_HISTORY_MISSING" }, [1, 1]]);
});

function withRead(w: World, read: (inner: ProviderPort, requestId: string, n: number) => Promise<ProviderCallResult>) {
  const inner = w.deps.provider;
  let n = 0;
  w.deps.provider = { mode: "mock", validate: (b) => inner.validate(b), create: (b) => inner.create(b), readById: (x) => inner.readById(x), readByRequestId: (x) => read(inner, x, ++n) };
  return createFlowService(w.deps);
}
const list = (items: unknown, extra: Record<string, unknown> = {}): ProviderCallResult => ({ kind: "HTTP", status: 200, body: { items, ...extra } });

test("A3-H09 (lookup) a failed, timed-out, non-200, malformed or paginated lookup refuses approve and submit; several matching records refuse; nothing is validated or created", async () => {
  const bad: [string, string, () => Promise<ProviderCallResult>][] = [
    ["transport error", "PROVIDER_LOOKUP_FAILED", async () => ({ kind: "TRANSPORT_ERROR", code: "MOCK_E_NETWORK" })],
    ["thrown", "PROVIDER_LOOKUP_FAILED", async () => { throw new Error("socket hang up"); }],
    ["HTTP 503", "PROVIDER_LOOKUP_FAILED", async () => ({ kind: "HTTP", status: 503, body: {} })],
    ["HTTP 404", "PROVIDER_LOOKUP_FAILED", async () => ({ kind: "HTTP", status: 404, body: { code: "not_found" } })],
    ["HTTP 201", "PROVIDER_LOOKUP_FAILED", async () => ({ kind: "HTTP", status: 201, body: { items: [] } })],
    ["no answer", "PROVIDER_LOOKUP_FAILED", async () => null as never],
    ["body is not a list", "PROVIDER_LOOKUP_AMBIGUOUS", async () => ({ kind: "HTTP", status: 200, body: {} })],
    ["null body", "PROVIDER_LOOKUP_AMBIGUOUS", async () => ({ kind: "HTTP", status: 200, body: null })],
    ["items is a string", "PROVIDER_LOOKUP_AMBIGUOUS", async () => list("none")],
    ["a single record, not a list", "PROVIDER_LOOKUP_AMBIGUOUS", async () => ({ kind: "HTTP", status: 200, body: { id: "x", status: "PAID" } })],
    ["a null entry", "PROVIDER_LOOKUP_AMBIGUOUS", async () => list([null])],
    ["more pages, ours not on this one", "PROVIDER_LOOKUP_AMBIGUOUS", async () => list([{ request_id: "someone-else" }], { has_more: true })],
    ["has_more of unknown meaning", "PROVIDER_LOOKUP_AMBIGUOUS", async () => list([], { has_more: "maybe" })],
  ];
  for (const [label, code, answer] of bad) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const svc = withRead(w, answer);
    const f = w.rec(id);
    assert.deepEqual(await svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code }, `${label}: approve`);
    assert.deepEqual([w.rec(id).state, w.rec(id).authorization, lastRefusal(w, id)], ["AWAITING_HUMAN", null, ["REFUSED", "approve", code]], label);
    // the same answer at submit, for a flow approved while the provider was still answering properly
    const v = world();
    const vid = await drive(v, "HUMAN_APPROVED");
    const vsvc = withRead(v, answer);
    assert.deepEqual(await vsvc.submit(OPERATOR, vid, v.rec(vid).authorization!.authorization_digest), { ok: false, code }, `${label}: submit`);
    assert.deepEqual([v.rec(vid).state, v.rec(vid).submission.attempt_id, calls(v), lastRefusal(v, vid)], ["HUMAN_APPROVED", null, [0, 0], ["REFUSED", "submit", code]], `${label}: zero validate, zero create, no intent`);
    const h = history(v);
    assert.ok(h.ok && h.live.length === 0, `${label}: nothing recorded as an intent`);
  }
  // any existing record blocks: one, or several for the same request id
  for (const n of [1, 2, 3]) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const svc = withRead(w, async (_i, req) => list(Array.from({ length: n }, (_x, i) => ({ id: `t-${i}`, request_id: req, status: "FAILED" }))));
    const f = w.rec(id);
    assert.deepEqual(await svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: "PROVIDER_RECORD_EXISTS" }, `${n} record(s), even FAILED ones`);
  }
  // a clean list of other people's transfers with no further pages is a confirmed absence
  const ok = world();
  const oid = await drive(ok, "AWAITING_HUMAN");
  const osvc = withRead(ok, async () => list([{ id: "t-9", request_id: "someone-else", status: "PAID" }], { has_more: false }));
  const of = ok.rec(oid);
  assert.equal((await osvc.approve(OPERATOR, oid, of.proposal_digest, of.gate!.gate_digest)).code, "HUMAN_APPROVED");
});

test("A3-H10 (lookup) a negative lookup never overrides local evidence: history, in-process record, approval MAC and state all still refuse", async () => {
  let lookups = 0;
  const absent = (w: World) => withRead(w, async () => (lookups++, list([])));
  // history says an intent exists; the provider says it holds nothing (the first create was refused)
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  w.provider.script.create = "REFUSE_422";
  await submit(w, id);
  untrustedWrite(w, ROLLBACK(id));
  const r = restart(w);
  lookups = 0;
  const f = r.rec(id);
  assert.deepEqual(await absent(r).approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: "SUBMISSION_ALREADY_RECORDED" });
  assert.equal(lookups, 0, "the local refusal came first; the provider was not even asked");
  // same process: the in-memory record refuses, provider absent or not
  const s = world();
  const sid = await drive(s, "HUMAN_APPROVED");
  s.provider.script.create = "HTTP_429_BEFORE_SEND";
  const digest = s.rec(sid).authorization!.authorization_digest;
  await submit(s, sid);
  untrustedWrite(s, `DELETE FROM flow_submit_attempt WHERE flow_id='${sid}'; UPDATE flow SET state='HUMAN_APPROVED', attempt_id=NULL, attempt_recorded_at_ms=NULL, provider_mode=NULL, authorization_consumed_at_ms=NULL, create_http_status=NULL, version=version+1 WHERE flow_id='${sid}'`);
  lookups = 0;
  assert.deepEqual([await absent(s).submit(OPERATOR, sid, digest), lookups, s.provider.calls().create], [{ ok: false, code: "AUTHORIZATION_ALREADY_CONSUMED" }, 0, 1]);
  // after a restart the stale approval is refused by its MAC, then by the history, never rescued by the lookup
  const s2 = restart(s);
  lookups = 0;
  assert.deepEqual([await absent(s2).submit(OPERATOR, sid, digest), lookups, s2.provider.calls().create], [{ ok: false, code: "AUTHORIZATION_NOT_SERVER_ISSUED" }, 0, 1]);
  // an uncertain flow that was never rolled back stays uncertain: state refuses before anything else
  const u = world();
  const uid = await drive(u, "HUMAN_APPROVED");
  u.provider.script.create = "TIMEOUT_BEFORE_SEND";
  await submit(u, uid);
  lookups = 0;
  assert.deepEqual([await absent(u).submit(OPERATOR, uid, u.rec(uid).authorization!.authorization_digest), u.rec(uid).state, lookups, u.provider.calls().create], [{ ok: false, code: "DUPLICATE_SUBMISSION" }, "SUBMISSION_UNCERTAIN", 0, 1], "an uncertain create is never retried");
});

test("A3-H11 (lookup/create race) a record that appears, or a lookup that fails, AFTER the intent is durable: create is not called", async () => {
  for (const [label, code, late] of [
    ["a record appeared", "PROVIDER_RECORD_EXISTS", async (_i: ProviderPort, req: string) => list([{ id: "t-1", request_id: req, status: "PROCESSING" }])],
    ["the lookup failed", "PROVIDER_LOOKUP_FAILED", async () => ({ kind: "TRANSPORT_ERROR", code: "MOCK_E_NETWORK" }) as ProviderCallResult],
    ["the lookup was malformed", "PROVIDER_LOOKUP_AMBIGUOUS", async () => ({ kind: "HTTP", status: 200, body: {} }) as ProviderCallResult],
  ] as const) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    // lookups for this flow from here: #1 before validate (clean), #2 after the intent (the late answer)
    const svc = withRead(w, (inner, req, n) => (n === 1 ? inner.readByRequestId(req) : late(inner, req)));
    assert.deepEqual(await svc.submit(OPERATOR, id, w.rec(id).authorization!.authorization_digest), { ok: false, code }, label);
    const f = w.rec(id);
    assert.deepEqual([f.state, calls(w), f.submission.provider_transfer_id], ["SUBMISSION_UNCERTAIN", [1, 0], null], `${label}: the intent stands, create was never called`);
    const h = history(w);
    assert.deepEqual([h.ok && h.live.length, h.ok && h.live[0].outcome], [1, "NOT_TRANSMITTED"], `${label}: the only outcome this code can PROVE was not transmitted`);
    const ev = w.events(id).filter((e) => e.type === "PROVIDER_CREATE_NOT_SENT");
    assert.deepEqual([ev.length, ev[0].data.code, ev[0].data.create_called, ev[0].to_state], [1, code, false, "SUBMISSION_UNCERTAIN"]);
    // it is spent all the same: no retry in this process, none after a rollback and restart
    assert.equal((await svc.submit(OPERATOR, id, f.authorization!.authorization_digest)).code, "DUPLICATE_SUBMISSION");
    untrustedWrite(w, ROLLBACK(id));
    const r = restart(w);
    assert.deepEqual([await approveAgain(r, id), r.provider.calls().create], [{ ok: false, code: "SUBMISSION_ALREADY_RECORDED" }, 0]);
  }
});

test("A3-H12 RESIDUAL, NOT RESOLVED (reported to the owner): full data-directory control plus a provider with no record reaches a second create call", async () => {
  // Preconditions: (1) the writer controls the whole data directory: rolls the database back AND restores the
  // history to its pre-submit copy; (2) the server restarts or another process serves; (3) a human approves again;
  // (4) the provider holds NO record for the request id, because the first create was definitively refused or
  // never arrived. Then no local evidence remains and the lookup has nothing to find.
  for (const script of ["REFUSE_422", "HTTP_429_BEFORE_SEND", "TIMEOUT_BEFORE_SEND"] as const) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    copyFileSync(histFile(w), `${histFile(w)}.snapshot`);
    w.provider.script.create = script;
    await submit(w, id);
    assert.deepEqual([w.provider.calls().create, w.provider.records().length], [1, 0], `${script}: one create call, no transfer at the provider`);
    untrustedWrite(w, ROLLBACK(id));
    copyFileSync(`${histFile(w)}.snapshot`, histFile(w));
    const r = restart(w);
    r.provider.script.create = "ACCEPT";
    assert.equal((await approveAgain(r, id)).code, "HUMAN_APPROVED", `${script}: OBSERVED: the re-approval is accepted`);
    assert.equal((await submit(r, id)).code, "SUBMITTED", `${script}: OBSERVED: the submit goes through`);
    assert.deepEqual([r.provider.calls().create, r.provider.records().length], [2, 1], `${script}: OBSERVED: provider create was called twice in total; exactly one transfer exists, for the one request id`);
  }
  // The mock provider's records are LOCAL. If its state file is rolled back with everything else, the lookup is
  // blind even after an ACCEPTED create. (In the runtime the mock state file sits inside the data directory.)
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const mock = join(w.dir, "mock-provider.json");
  copyFileSync(histFile(w), `${histFile(w)}.snapshot`);
  copyFileSync(mock, `${mock}.snapshot`);
  await submit(w, id);
  assert.deepEqual([w.rec(id).state, w.provider.records().length], ["SUBMITTED", 1]);
  untrustedWrite(w, ROLLBACK(id));
  copyFileSync(`${histFile(w)}.snapshot`, histFile(w));
  copyFileSync(`${mock}.snapshot`, mock); // the "provider" forgets the transfer
  const r = restart(w);
  assert.equal((await approveAgain(r, id)).code, "HUMAN_APPROVED", "OBSERVED: with the mock's own records rolled back, the lookup finds nothing");
  assert.equal((await submit(r, id)).code, "SUBMITTED", "OBSERVED: a second create is sent and the mock accepts it");
  assert.equal(r.provider.calls().create, 2);
});

// ------------------------------------------------------------------------------------------------------------
// Ordering and write failures
// ------------------------------------------------------------------------------------------------------------

test("A3-H13 (ordering) the INTENT line is on disk before provider.create is entered and absent at validate; a failed intent is cancelled, not left live", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const inner = w.deps.provider;
  const seen: Record<string, number> = {};
  const liveNow = () => {
    const h = readSubmissionHistory(w.deps.dataDir); // straight from disk
    return h.ok ? h.live.length : -1;
  };
  w.deps.provider = { mode: "mock", readById: (x) => inner.readById(x), readByRequestId: (x) => inner.readByRequestId(x),
    validate: async (b) => ((seen.validate = liveNow()), inner.validate(b)), create: async (b) => ((seen.create = liveNow()), inner.create(b)) };
  const svc = createFlowService(w.deps);
  w.audit.failOnType = "SUBMIT_INTENT_RECORDED"; // the intent transaction rolls back AFTER the history line was written
  const digest = w.rec(id).authorization!.authorization_digest;
  assert.equal((await svc.submit(OPERATOR, id, digest)).code, "AUDIT_FIELD_REFUSED");
  let h = history(w);
  assert.deepEqual([h.ok && h.live.length, h.ok && h.cancelled, w.rec(id).state, w.provider.calls().create], [0, 1, "HUMAN_APPROVED", 0], "the uncommitted intent is cancelled in the history: nothing was sent");
  w.audit.failOnType = null;
  assert.equal((await svc.submit(OPERATOR, id, digest)).code, "SUBMITTED");
  assert.deepEqual(seen, { validate: 0, create: 1 }, "no live intent at validate; exactly one, already durable, when create is entered");
  h = history(w);
  assert.deepEqual([h.ok && h.live.length, h.ok && h.cancelled, h.ok && h.live[0].outcome, h.ok && h.lines], [1, 1, "SENT_ACCEPTED", 5], "header, intent, not-committed, intent, outcome");
  assert.equal((statMode(histFile(w)) & 0o077), 0, "owner-only file");
});
const statMode = (f: string) => (process.getBuiltinModule("node:fs").statSync(f).mode);

test("A3-H14 (write failure) if the history cannot be written, the intent does not commit and nothing is sent", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  chmodSync(histFile(w), 0o400); // readable, not appendable
  const r = await submit(w, id);
  chmodSync(histFile(w), 0o600);
  if (process.getuid?.() === 0) return; // root ignores file modes; the case cannot be produced
  assert.deepEqual([r, w.rec(id).state, w.rec(id).submission.attempt_id, w.provider.calls().create], [{ ok: false, code: "SUBMISSION_HISTORY_WRITE_FAILED" }, "HUMAN_APPROVED", null, 0]);
  const h = history(w);
  assert.ok(h.ok && h.live.length === 0);
  assert.equal((await submit(w, id)).code, "SUBMITTED", "once the history is writable again the untouched approval works, once");
  assert.equal(w.provider.calls().create, 1);
  // appending to a history that does not verify is refused by the writer itself
  writeFileSync(histFile(w), "garbage\n");
  assert.throws(() => appendIntent(w.deps.dataDir, { flow_id: id, provider_request_id: id, proposal_digest: "a".repeat(64), authorization_digest: "b".repeat(64), attempt_id: "x", provider_mode: "mock", at_ms: 1 }), /SUBMISSION_HISTORY_MALFORMED/);
  assert.equal(SUBMISSION_HISTORY_FILE, "submission-history-v1.jsonl");
  void CASE; void DOC;
});

test("A3-H15 (crash inside the intent transaction) INTENT fsynced, process killed before the database commit: the flow is refused for good and nothing is ever sent", async () => {
  const w = world();
  const id = await drive(w, "HUMAN_APPROVED");
  const other = await drive(w, "HUMAN_APPROVED");
  const digest = w.rec(id).authorization!.authorization_digest;
  const signal = await new Promise<string | null>((resolve, rejectP) => {
    const p = spawn(process.execPath, ["--no-warnings", join(fileURLToPath(new URL(".", import.meta.url)), "child_tx_crash.ts"), w.dir, id, String(w.clock.t)], { stdio: "ignore" });
    p.on("error", rejectP);
    p.on("close", (_c, s) => resolve(s));
  });
  assert.equal(signal, "SIGKILL");
  const r = world(w.dir, { clock: w.clock }); // restart; same key, so the approval's MAC is still valid
  const f = r.rec(id);
  assert.deepEqual([f.state, f.submission.attempt_id, f.authorization_consumed_at_ms, calls(r)], ["HUMAN_APPROVED", null, null, [1, 0]], "the database transaction did not commit: the store shows an unused approval, and create was never called");
  const h = history(r);
  assert.deepEqual([h.ok && h.live.length, h.ok && h.live[0].flow_id, h.ok && h.live[0].outcome, h.ok && h.cancelled], [1, id, null, 0], "the history holds the INTENT, with no cancel line and no outcome");
  // the history names an intent the store lacks: this flow fails closed, in this process and after any restart
  for (let i = 0; i < 2; i++) assert.deepEqual(await r.svc.submit(OPERATOR, id, digest), { ok: false, code: "SUBMISSION_ALREADY_RECORDED" });
  assert.deepEqual([r.rec(id).state, calls(r), lastRefusal(r, id)], ["HUMAN_APPROVED", [1, 0], ["REFUSED", "submit", "SUBMISSION_ALREADY_RECORDED"]]);
  untrustedWrite(r, ROLLBACK(id));
  const r2 = restart(r);
  assert.deepEqual([await approveAgain(r2, id), calls(r2)], [{ ok: false, code: "SUBMISSION_ALREADY_RECORDED" }, [1, 0]]);
  // the rest of the store is unaffected, and the history is still well formed
  assert.equal((await submit(r, other)).code, "SUBMITTED");
  assert.deepEqual([r.provider.calls().create, history(r).ok], [1, true]);
});
