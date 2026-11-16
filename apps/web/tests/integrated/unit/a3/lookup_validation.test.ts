// A3 candidate-4 tests. Finding A8-11: the provider request-id lookup must never read a malformed, incomplete or
// ambiguous answer as "the provider holds nothing". Finding A8-10 / residual R-3: documented, NOT resolved; the last
// test records the observed behaviour. Builder-side unit tests with this lane's fakes. Offline.
//
// The accepted "absent" answer is exactly HTTP 200 { items: [...], has_more: false } with well-formed items. That
// shape is this build's pinned ASSUMPTION about the provider's list-by-request-id response. It is UNVERIFIED against
// the real Airwallex API.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { createFlowService } from "../../../../integrated/flowService.ts";
import type { ProviderCallResult, ProviderPort, ProviderTransferBody } from "../../../../integrated/flowTypes.ts";
import { historyPath, readSubmissionHistory } from "../../../../integrated/submissionHistory.ts";
import { drive, OPERATOR, world } from "./support.ts";
import type { World } from "./support.ts";

const body = (b: unknown, status = 200): ProviderCallResult => ({ kind: "HTTP", status, body: b });
const calls = (w: World) => [w.provider.calls().validate, w.provider.calls().create];
const lastRefusal = (w: World, id: string) => {
  const e = w.events(id).at(-1)!;
  return [e.type, e.data.op, e.data.code];
};
/** A service over `w` whose by-request-id lookup is answered by `read` (n = 1, 2, ... per service). */
function withRead(w: World, read: (inner: ProviderPort, requestId: string, n: number) => Promise<ProviderCallResult>) {
  const inner = w.deps.provider;
  let n = 0;
  w.deps.provider = { mode: "mock", validate: (b) => inner.validate(b), create: (b) => inner.create(b), readById: (x) => inner.readById(x), readByRequestId: (x) => read(inner, x, ++n) };
  return createFlowService(w.deps);
}
const AMBIGUOUS = "PROVIDER_LOOKUP_AMBIGUOUS";
const EXISTS = "PROVIDER_RECORD_EXISTS";

/** Every answer that must NOT be read as a confirmed absence, with the code it must produce. `ours` is the flow's request id. */
const NOT_ABSENT: [string, string, (ours: string) => unknown][] = [
  // pagination must terminate unambiguously
  ["has_more missing", AMBIGUOUS, () => ({ items: [] })],
  ["has_more true", AMBIGUOUS, () => ({ items: [], has_more: true })],
  ["has_more null", AMBIGUOUS, () => ({ items: [], has_more: null })],
  ["has_more the string \"false\"", AMBIGUOUS, () => ({ items: [], has_more: "false" })],
  ["has_more 0", AMBIGUOUS, () => ({ items: [], has_more: 0 })],
  ["has_more missing, cursor present (the reviewer's probe L1)", AMBIGUOUS, () => ({ items: [], page_after: "cursor-1" })],
  // unknown pagination, cursor or envelope fields
  ["page_after beside has_more:false", AMBIGUOUS, () => ({ items: [], has_more: false, page_after: "cursor-1" })],
  ["page_before null", AMBIGUOUS, () => ({ items: [], has_more: false, page_before: null })],
  ["next_cursor", AMBIGUOUS, () => ({ items: [], has_more: false, next_cursor: "" })],
  ["page_num", AMBIGUOUS, () => ({ items: [], has_more: false, page_num: 0 })],
  ["total_count", AMBIGUOUS, () => ({ items: [], has_more: false, total_count: 0 })],
  ["an unknown key of any kind", AMBIGUOUS, () => ({ items: [], has_more: false, note: "ok" })],
  ["a wrapped envelope", AMBIGUOUS, () => ({ data: { items: [], has_more: false } })],
  ["HAS_MORE in another case", AMBIGUOUS, () => ({ items: [], HAS_MORE: false })],
  // the list itself
  ["items missing", AMBIGUOUS, () => ({ has_more: false })],
  ["items null", AMBIGUOUS, () => ({ items: null, has_more: false })],
  ["items an object", AMBIGUOUS, () => ({ items: {}, has_more: false })],
  ["body is an array", AMBIGUOUS, () => []],
  ["body is a string", AMBIGUOUS, () => "[]"],
  ["body is null", AMBIGUOUS, () => null],
  ["body is a class instance", AMBIGUOUS, () => new (class Page { items = []; has_more = false; })()],
  // absent, malformed or conflicting request-id fields
  ["an item without request_id", AMBIGUOUS, () => ({ items: [{ id: "t-1", status: "PAID" }], has_more: false })],
  ["request_id null", AMBIGUOUS, () => ({ items: [{ request_id: null }], has_more: false })],
  ["request_id a number", AMBIGUOUS, () => ({ items: [{ request_id: 42 }], has_more: false })],
  ["request_id empty", AMBIGUOUS, () => ({ items: [{ request_id: "" }], has_more: false })],
  ["request_id an object", AMBIGUOUS, () => ({ items: [{ request_id: {} }], has_more: false })],
  ["an item that is null", AMBIGUOUS, () => ({ items: [null], has_more: false })],
  ["an item that is a string", AMBIGUOUS, (o) => ({ items: [o], has_more: false })],
  ["an item that is an array", AMBIGUOUS, (o) => ({ items: [[o]], has_more: false })],
  ["our id only under client_request_id (the reviewer's probe L1)", AMBIGUOUS, (o) => ({ items: [{ id: "t-1", client_request_id: o }], has_more: false })],
  ["client_request_id is ours, request_id is someone else's", AMBIGUOUS, (o) => ({ items: [{ request_id: "someone-else", client_request_id: o }], has_more: false })],
  ["client_request_id disagrees with request_id", AMBIGUOUS, () => ({ items: [{ request_id: "someone-else", client_request_id: "a-third-id" }], has_more: false })],
  ["our id only under requestId", AMBIGUOUS, (o) => ({ items: [{ requestId: o }], has_more: false })],
  ["Request_ID in another case carries our id", AMBIGUOUS, (o) => ({ items: [{ request_id: "someone-else", Request_ID: o }], has_more: false })],
  ["a request-id-like field that is not a string", AMBIGUOUS, () => ({ items: [{ request_id: "someone-else", client_request_id: 7 }], has_more: false })],
  // ambiguous case differences
  ["our id in upper case", AMBIGUOUS, (o) => ({ items: [{ request_id: o.toUpperCase() }], has_more: false })],
  ["our id with a trailing space", AMBIGUOUS, (o) => ({ items: [{ request_id: `${o} ` }], has_more: false })],
  ["our id in upper case under client_request_id", AMBIGUOUS, (o) => ({ items: [{ request_id: "someone-else", client_request_id: o.toUpperCase() }], has_more: false })],
  // an exact match is a record, however badly formed the rest of the answer is
  ["exact match, well formed", EXISTS, (o) => ({ items: [{ id: "t-1", request_id: o, status: "PROCESSING" }], has_more: false })],
  ["exact match, has_more missing", EXISTS, (o) => ({ items: [{ request_id: o }] })],
  ["exact match, more pages", EXISTS, (o) => ({ items: [{ request_id: o }], has_more: true })],
  ["exact match beside an unknown cursor key", EXISTS, (o) => ({ items: [{ request_id: o }], has_more: false, page_after: "c" })],
  ["exact match beside a malformed item", EXISTS, (o) => ({ items: [null, { request_id: o }], has_more: false })],
  ["exact match twice", EXISTS, (o) => ({ items: [{ request_id: o, status: "FAILED" }, { request_id: o, status: "PAID" }], has_more: false })],
  ["exact match with a conflicting client_request_id", EXISTS, (o) => ({ items: [{ request_id: o, client_request_id: "other" }], has_more: false })],
];

/** The only answers accepted as a confirmed absence. */
const ABSENT: [string, (ours: string) => unknown][] = [
  ["empty list, has_more false", () => ({ items: [], has_more: false })],
  ["other people's well-formed records, has_more false", () => ({ items: [{ id: "t-1", request_id: "someone-else", status: "PAID" }, { id: "t-2", request_id: "a-third-id", status: "FAILED" }], has_more: false })],
  ["a client_request_id that agrees with request_id", () => ({ items: [{ request_id: "someone-else", client_request_id: "someone-else" }], has_more: false })],
];

test("A3-L01 (A8-11) at approve: no malformed, incomplete, paginated or ambiguous lookup answer is read as absence", async () => {
  for (const [label, code, make] of NOT_ABSENT) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const f = w.rec(id);
    const svc = withRead(w, async (_i, ours) => body(make(ours)));
    assert.deepEqual(await svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code }, label);
    assert.deepEqual([w.rec(id).state, w.rec(id).authorization, calls(w), lastRefusal(w, id)], ["AWAITING_HUMAN", null, [0, 0], ["REFUSED", "approve", code]], `${label}: no approval, audited, no provider write`);
  }
  for (const [label, make] of ABSENT) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const f = w.rec(id);
    const svc = withRead(w, async (_i, ours) => body(make(ours)));
    assert.deepEqual(await svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: true, code: "HUMAN_APPROVED" }, label);
  }
  // a non-200 answer is a failed lookup even when its body is the perfect "absent" shape
  for (const status of [201, 204, 206, 304, 404, 500]) {
    const w = world();
    const id = await drive(w, "AWAITING_HUMAN");
    const f = w.rec(id);
    const svc = withRead(w, async () => body({ items: [], has_more: false }, status));
    assert.deepEqual(await svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest), { ok: false, code: "PROVIDER_LOOKUP_FAILED" }, `HTTP ${status}`);
  }
});

test("A3-L02 (A8-11) at submit, before validate: the same answers refuse with zero validate, zero create and no intent", async () => {
  for (const [label, code, make] of NOT_ABSENT) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED"); // approved while the provider answered properly
    const digest = w.rec(id).authorization!.authorization_digest;
    const svc = withRead(w, async (_i, ours) => body(make(ours)));
    assert.deepEqual(await svc.submit(OPERATOR, id, digest), { ok: false, code }, label);
    assert.deepEqual([w.rec(id).state, w.rec(id).submission.attempt_id, calls(w), lastRefusal(w, id)], ["HUMAN_APPROVED", null, [0, 0], ["REFUSED", "submit", code]], label);
    const h = readSubmissionHistory(w.deps.dataDir);
    assert.ok(h.ok && h.live.length === 0, `${label}: no intent recorded`);
  }
  for (const [label, make] of ABSENT) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    const svc = withRead(w, async (_i, ours) => body(make(ours)));
    assert.deepEqual([await svc.submit(OPERATOR, id, w.rec(id).authorization!.authorization_digest), calls(w)], [{ ok: true, code: "SUBMITTED" }, [1, 1]], label);
  }
});

test("A3-L03 (A8-11) at submit, after the durable intent: the same answers stop the create; the attempt is spent and recorded as not transmitted", async () => {
  for (const [label, code, make] of NOT_ABSENT) {
    const w = world();
    const id = await drive(w, "HUMAN_APPROVED");
    const digest = w.rec(id).authorization!.authorization_digest;
    // lookup #1 (before validate) is a clean absence; lookup #2 (after the intent) is the answer under test
    const svc = withRead(w, async (_i, ours, n) => body(n === 1 ? { items: [], has_more: false } : make(ours)));
    assert.deepEqual(await svc.submit(OPERATOR, id, digest), { ok: false, code }, label);
    const f = w.rec(id);
    assert.deepEqual([f.state, calls(w), f.submission.provider_transfer_id], ["SUBMISSION_UNCERTAIN", [1, 0], null], `${label}: create was never called`);
    const h = readSubmissionHistory(w.deps.dataDir);
    assert.deepEqual([h.ok && h.live.length, h.ok && h.live[0].outcome], [1, "NOT_TRANSMITTED"], label);
    assert.equal((await svc.submit(OPERATOR, id, digest)).code, "DUPLICATE_SUBMISSION", `${label}: and it is never retried`);
    assert.equal(w.provider.calls().create, 0);
  }
});

test("A3-L04 (A8-11) the product's own mock provider answers the lookup in the exact accepted shape, and a stored record is found", async () => {
  const w = world();
  const empty = await w.provider.readByRequestId("00000000-0000-4000-8000-00000000abcd");
  assert.deepEqual(empty, { kind: "HTTP", status: 200, body: { items: [], has_more: false } });
  const id = await drive(w, "HUMAN_APPROVED");
  assert.equal((await w.svc.submit(OPERATOR, id, w.rec(id).authorization!.authorization_digest)).code, "SUBMITTED");
  const found = await w.provider.readByRequestId(w.rec(id).proposal.provider_request_id);
  assert.ok(found.kind === "HTTP" && found.status === 200);
  const b = (found as { body: { items: { request_id: string }[]; has_more: unknown } }).body;
  assert.deepEqual([Object.keys(b).sort(), b.has_more, b.items.length, b.items[0].request_id], [["has_more", "items"], false, 1, w.rec(id).proposal.provider_request_id]);
});

// ------------------------------------------------------------------------------------------------------------
// Residual R-3 (finding A8-10): accepted by the owner as a documented, UNRESOLVED risk. Observed behaviour only.
// ------------------------------------------------------------------------------------------------------------

test("A3-L05 RESIDUAL R-3, NOT RESOLVED: first create accepted but not yet visible to the lookup, whole data directory restored, fresh approval: a second create CALL", async () => {
  const ROLLBACK = (id: string) => `DELETE FROM flow_submit_attempt WHERE flow_id='${id}'; DELETE FROM flow_authorization WHERE flow_id='${id}';
    UPDATE flow SET state='AWAITING_HUMAN', authorization_json=NULL, gate_consumed_at_ms=NULL, attempt_id=NULL, attempt_recorded_at_ms=NULL, provider_mode=NULL, authorization_consumed_at_ms=NULL,
      provider_transfer_id=NULL, create_http_status=NULL, create_reported_status=NULL, last_provider_status=NULL, last_provider_read_at_ms=NULL, version=version+1 WHERE flow_id='${id}'`;
  const untrustedWrite = (w: World, sql: string) => {
    const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(join(w.deps.dataDir, "flow-v1.sqlite"));
    try {
      for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) db.exec(`DROP TRIGGER "${t.name}"`);
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  for (const dedup of [true, false]) {
    // A FAKE provider standing outside the data directory. Its list lags: it never shows a record yet (the window).
    // With `dedup` it answers a repeated request id as a duplicate; without, it accepts again. Neither is a
    // statement about Airwallex, whose behaviour here is UNVERIFIED.
    const created: ProviderTransferBody[] = [];
    const laggy = (inner: ProviderPort): ProviderPort => ({
      mode: "mock", validate: (b) => inner.validate(b), readById: (x) => inner.readById(x),
      readByRequestId: async () => body({ items: [], has_more: false }), // honest "absent": the record is not listed yet
      create: async (b) => {
        if (dedup && created.some((c) => c.request_id === b.request_id)) return body({ code: "request_id_duplicate" }, 400);
        created.push(b);
        return body({ id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(created.length).padStart(12, "0")}`, status: "PROCESSING", request_id: b.request_id }, 201);
      },
    });
    const w = world();
    w.deps.provider = laggy(w.deps.provider);
    const svc = createFlowService(w.deps);
    const id = await drive({ ...w, svc }, "HUMAN_APPROVED");
    copyFileSync(historyPath(w.deps.dataDir), `${historyPath(w.deps.dataDir)}.snapshot`);
    assert.equal((await svc.submit(OPERATOR, id, svc.getFlow(id)!.authorization!.authorization_digest)).code, "SUBMITTED", "the first create is ACCEPTED by the provider");
    assert.equal(created.length, 1);
    // whole-directory rollback: the database AND the submission history go back to before the submit
    untrustedWrite(w, ROLLBACK(id));
    copyFileSync(`${historyPath(w.deps.dataDir)}.snapshot`, historyPath(w.deps.dataDir));
    const r = world(w.dir, { clock: w.clock, approvalKey: new Uint8Array(32).fill(8) }); // restart
    r.deps.provider = laggy(r.deps.provider);
    const rsvc = createFlowService(r.deps);
    const f = rsvc.getFlow(id)!;
    assert.equal((await rsvc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest)).code, "HUMAN_APPROVED", "OBSERVED: the fresh approval is accepted (no local evidence, and the lookup honestly sees nothing yet)");
    const second = await rsvc.submit(OPERATOR, id, rsvc.getFlow(id)!.authorization!.authorization_digest);
    if (dedup) {
      assert.deepEqual([second, rsvc.getFlow(id)!.state, created.length], [{ ok: false, code: "SUBMISSION_UNCERTAIN" }, "SUBMISSION_UNCERTAIN", 1],
        "OBSERVED with a deduplicating fake: a second create CALL was made and answered as a duplicate; one transfer exists");
    } else {
      assert.deepEqual([second, rsvc.getFlow(id)!.state, created.length], [{ ok: true, code: "SUBMITTED" }, "SUBMITTED", 2],
        "OBSERVED with a non-deduplicating fake: a second create CALL was made and accepted by the FAKE; what a real provider would do is unverified");
      assert.equal(created[0].request_id, created[1].request_id, "both calls carry the same provider request id");
    }
  }
});
