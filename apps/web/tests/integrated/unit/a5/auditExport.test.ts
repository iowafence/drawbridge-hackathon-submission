// A5: export, replay verification and the optional external checkpoint (integrated/auditExport.ts), flow-v1 §10.
// Offline; synthetic data. CUTTABLE together with integrated/auditExport.ts.
//
// Tests named "LIMITATION" perform an attack and assert that the check PASSES.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_TABLE, AUDIT_ZERO, auditPort } from "../../../../integrated/auditChain.ts";
import { exportFlowAudit, replayFlowEvents, rollingHeads, verifyAgainstCheckpoint, writeCheckpoint } from "../../../../integrated/auditExport.ts";
import type { FlowAuditEvent, FlowAuditInput } from "../../../../integrated/flowTypes.ts";
import { allEvents, appendAll, dropGuards, ev, FLOW_A, FLOW_B, happyInputs, HUMAN, openDb, rewriteChain, scratch, T0, twoFlows } from "./helpers.ts";

/** Builds events for replay without the port (replay is a pure function over events). */
const asEvents = (inputs: FlowAuditInput[]): FlowAuditEvent[] => appendAll(openDb(), inputs);
const codes = (inputs: FlowAuditInput[]): string[] => replayFlowEvents(asEvents(inputs)).findings.map((f) => `${f.code}@${f.seq}`);

// ---- export and replay ----------------------------------------------------------------------------------------------

test("A5-20 export returns one flow's verified events with the state and version the trail supports", () => {
  const db = openDb();
  const events = twoFlows(db);
  const x = exportFlowAudit(db, FLOW_A);
  assert.equal(x.chain, "DB_INTEGRATED_FLOW_V1");
  assert.equal(x.chain_ok, true);
  assert.equal(x.count, 11);
  assert.deepEqual(x.events, events.filter((e) => e.flow_id === FLOW_A));
  assert.equal(x.head, x.events[10].hash);
  assert.deepEqual(x.replay, { ok: true, findings: [], final_state: "PROVIDER_PAID", final_version: 9, transitions: 9, audit_only_events: 2 });
  assert.equal(x.integrity_claim, "INTERNALLY_CONSISTENT_ONLY_NOT_TAMPER_PROOF");
  const b = exportFlowAudit(db, FLOW_B);
  assert.equal(b.replay?.final_state, "GATE_ELIGIBLE"); // eligible for human review: nothing approved, nothing sent
  assert.equal(b.replay?.final_version, 3);
  const none = exportFlowAudit(db, "cccccccc-0000-4000-8000-000000000003");
  assert.deepEqual([none.count, none.head, none.replay?.final_state], [0, AUDIT_ZERO, null]);
});

test("A5-21 replay reports the exact state after every event and never runs ahead of the trail", () => {
  const events = asEvents(happyInputs(FLOW_A));
  const expected = ["DRAFT", "EVIDENCE_READY", "GATE_ELIGIBLE", "AWAITING_HUMAN", "AWAITING_HUMAN", "HUMAN_APPROVED", "SUBMIT_INTENT_RECORDED", "SUBMITTED", "PROVIDER_PROCESSING", "PROVIDER_PROCESSING", "PROVIDER_PAID"];
  expected.forEach((state, i) => assert.equal(replayFlowEvents(events.slice(0, i + 1)).final_state, state, `after event ${i + 1}`));
  // a 201 with create_reported_status PROCESSING leaves the flow at SUBMITTED; only a provider READ moves it on
  assert.equal(events[7].data.create_reported_status, "PROCESSING");
  assert.equal(replayFlowEvents(events.slice(0, 8)).final_state, "SUBMITTED");
});

test("A5-22 replay flags a history the state machine could not have produced", () => {
  const h = happyInputs(FLOW_A);
  assert.deepEqual(codes(h), []);
  // approval with no human-review step
  assert.deepEqual(codes([h[0], h[1], h[2], ev(FLOW_A, "HUMAN_APPROVED", "GATE_ELIGIBLE", "HUMAN_APPROVED", 4, {}, HUMAN)]), ["F_ILLEGAL_TRANSITION@4"]);
  // approval after a HOLD
  assert.deepEqual(codes([h[0], h[1], ev(FLOW_A, "GATE_EVALUATED", "EVIDENCE_READY", "GATE_HOLD", 3), ev(FLOW_A, "HUMAN_APPROVED", "GATE_HOLD", "HUMAN_APPROVED", 4, {}, HUMAN)]), ["F_ILLEGAL_TRANSITION@4"]);
  // submit intent without approval
  assert.deepEqual(codes([...h.slice(0, 4), ev(FLOW_A, "SUBMIT_INTENT_RECORDED", "AWAITING_HUMAN", "SUBMIT_INTENT_RECORDED", 5)]), ["F_ILLEGAL_TRANSITION@5"]);
  // a second submit intent
  assert.deepEqual(codes([...h.slice(0, 8), ev(FLOW_A, "SUBMIT_INTENT_RECORDED", "SUBMITTED", "SUBMIT_INTENT_RECORDED", 8)]), ["F_ILLEGAL_TRANSITION@9"]);
  // a create response promoted straight to PAID
  assert.deepEqual(codes([...h.slice(0, 7), ev(FLOW_A, "CREATE_ACCEPTED", "SUBMIT_INTENT_RECORDED", "PROVIDER_PAID", 7)]), ["F_ILLEGAL_TRANSITION@8"]);
  // anything after a terminal state
  assert.deepEqual(codes([...h, ev(FLOW_A, "PROVIDER_READ", "PROVIDER_PAID", "PROVIDER_FAILED", 10)]), ["F_ILLEGAL_TRANSITION@12"]);
  // an event that claims a starting state the trail does not support (a step is missing)
  assert.deepEqual(codes([h[0], h[2]]), ["F_FROM_STATE_MISMATCH@2", "F_VERSION_NOT_INCREMENTED@2"]);
  assert.deepEqual(codes([h[1]]), ["F_FROM_STATE_MISMATCH@1", "F_VERSION_NOT_INCREMENTED@1"]);
  // version rules
  assert.deepEqual(codes([h[0], { ...h[1], flow_version: 5 }]), ["F_VERSION_NOT_INCREMENTED@2"]);
  assert.deepEqual(codes([h[0], ev(FLOW_A, "REFUSED", "DRAFT", null, 2, { op: "approve", code: "X" })]), ["F_VERSION_CHANGED_WITHOUT_TRANSITION@2"]);
  assert.deepEqual(codes([h[0], ev(FLOW_A, "REFUSED", "AWAITING_HUMAN", null, 1, { op: "approve", code: "X" })]), ["F_FROM_STATE_MISMATCH@2"]);
  assert.deepEqual(codes([h[0], ev(FLOW_A, "REFUSED", null, null, 1, { op: "approve", code: "X" })]), []); // from_state may be omitted on an audit-only event
});

test("A5-23 nothing is exported or replayed from a broken chain, even when the damage is in another flow", () => {
  const db = openDb();
  twoFlows(db);
  dropGuards(db);
  db.exec(`UPDATE ${AUDIT_TABLE} SET actor = 'human:someone-else' WHERE flow_id = '${FLOW_B}' AND seq = 2`);
  const x = exportFlowAudit(db, FLOW_A);
  assert.deepEqual([x.chain_ok, x.count, x.events.length, x.replay, x.head], [false, 0, 0, null, AUDIT_ZERO]);
  assert.deepEqual(x.chain_error, { at_seq: 2, detail: "HASH_MISMATCH" });
});

test("A5-24 LIMITATION: replay checks that a history is legal, not that it happened; a truncated trail replays cleanly", () => {
  const db = openDb();
  appendAll(db, happyInputs(FLOW_A));
  dropGuards(db);
  db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq > 6`);
  const x = exportFlowAudit(db, FLOW_A);
  assert.equal(x.chain_ok && x.replay?.ok, true);
  assert.equal(x.replay?.final_state, "HUMAN_APPROVED", "compare final_state and final_version with the flow record: here they would disagree");
});

// ---- external checkpoint --------------------------------------------------------------------------------------------

/** File-backed store in one scratch directory, checkpoint in another. Checkpoint written after event 12 of 14. */
function scenario() {
  const dataDir = scratch();
  const cpDir = scratch();
  const db = openDb(join(dataDir, "integrated_flow.sqlite"));
  const cp = join(cpDir, "audit_checkpoint.json");
  const inputs = (() => {
    const a = happyInputs(FLOW_A);
    const b = happyInputs(FLOW_B).slice(0, 3);
    return [a[0], b[0], a[1], a[2], b[1], a[3], a[4], a[5], b[2], ...a.slice(6)];
  })();
  appendAll(db, inputs.slice(0, 12));
  const written = writeCheckpoint(db, cp, T0 + 500_000);
  appendAll(db, inputs.slice(12));
  return { dataDir, cpDir, db, cp, written, original: allEvents(db) };
}

test("A5-30 checkpoint is exactly {seq, head, at_ms}, owner-only, outside the data directory, and an intact chain agrees with it", () => {
  const s = scenario();
  assert.equal(s.written.ok, true);
  const onDisk = JSON.parse(readFileSync(s.cp, "utf8"));
  assert.deepEqual(Object.keys(onDisk).sort(), ["at_ms", "head", "seq"]);
  assert.deepEqual(onDisk, { seq: 12, head: rollingHeads(s.original.slice(0, 12))[12], at_ms: T0 + 500_000 });
  assert.equal(statSync(s.cp).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(s.cpDir), ["audit_checkpoint.json"]); // no temporary file left behind
  assert.deepEqual(verifyAgainstCheckpoint(s.db, s.cp), { ok: true, checkpoint_seq: 12, chain_count: 14, uncovered_events: 2 });
  // the rolling head commits to every flow, unlike the newest event's hash, which commits to one
  assert.notEqual(onDisk.head, s.original[11].hash);
  assert.equal(rollingHeads([])[0], AUDIT_ZERO);
});

test("A5-31 CLOSED: a rewrite with recomputed hashes passes verify() but contradicts the checkpoint, in whichever flow it happens", () => {
  for (const [flow, type] of [[FLOW_A, "HUMAN_APPROVED"], [FLOW_B, "GATE_EVALUATED"]] as const) {
    const s = scenario();
    rewriteChain(s.db, s.original.map((e) => (e.flow_id === flow && e.type === type ? { ...e, actor: "human:someone-else" } : e)));
    assert.equal(auditPort.verify(s.db).ok, true, "the unkeyed chain alone is fooled");
    assert.deepEqual(verifyAgainstCheckpoint(s.db, s.cp), { ok: false, code: "AUDIT_REWRITTEN_BELOW_CHECKPOINT", checkpoint_seq: 12, chain_count: 14 });
  }
});

test("A5-32 CLOSED: truncation below the checkpoint and deletion of every event are detected", () => {
  const s = scenario();
  dropGuards(s.db);
  s.db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq > 8`);
  assert.equal(auditPort.verify(s.db).ok, true, "the unkeyed chain alone is fooled");
  assert.deepEqual(verifyAgainstCheckpoint(s.db, s.cp), { ok: false, code: "AUDIT_TRUNCATED_BELOW_CHECKPOINT", checkpoint_seq: 12, chain_count: 8 });
  s.db.exec(`DELETE FROM ${AUDIT_TABLE}`);
  assert.deepEqual(verifyAgainstCheckpoint(s.db, s.cp), { ok: false, code: "AUDIT_TRUNCATED_BELOW_CHECKPOINT", checkpoint_seq: 12, chain_count: 0 });
});

test("A5-33 CLOSED: keeping the checkpointed length but substituting events is detected; a broken chain is reported as broken", () => {
  const s = scenario();
  rewriteChain(s.db, [...s.original.slice(0, 11), { ...s.original[11], data: { http_status: 200, provider_status: "FAILED" } }, ...s.original.slice(12)]);
  assert.equal(verifyAgainstCheckpoint(s.db, s.cp).ok, false);
  const t = scenario();
  dropGuards(t.db);
  t.db.exec(`UPDATE ${AUDIT_TABLE} SET at_ms = 0 WHERE seq = 3`);
  assert.deepEqual(verifyAgainstCheckpoint(t.db, t.cp), { ok: false, code: "AUDIT_CHAIN_BROKEN", checkpoint_seq: 12, chain_count: null });
});

test("A5-34 a missing or malformed checkpoint is never a pass", () => {
  const s = scenario();
  assert.equal((verifyAgainstCheckpoint(s.db, join(s.cpDir, "absent.json")) as { code: string }).code, "CHECKPOINT_MISSING");
  for (const text of ["", "not json", "[]", '{"seq":12}', `{"seq":0,"head":"${"a".repeat(64)}","at_ms":1}`, `{"seq":12,"head":"${"A".repeat(64)}","at_ms":1}`, `{"seq":12,"head":"${"a".repeat(64)}","at_ms":1,"mac":"x"}`]) {
    writeFileSync(s.cp, text);
    assert.equal((verifyAgainstCheckpoint(s.db, s.cp) as { code: string }).code, "CHECKPOINT_MALFORMED", text);
  }
});

test("A5-35 writeCheckpoint never overwrites a checkpoint that has caught tampering, and advances on an intact chain", () => {
  const s = scenario();
  const before = readFileSync(s.cp, "utf8");
  dropGuards(s.db);
  s.db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq > 8`);
  assert.deepEqual(writeCheckpoint(s.db, s.cp, T0 + 900_000), { ok: false, code: "AUDIT_TRUNCATED_BELOW_CHECKPOINT" });
  assert.equal(readFileSync(s.cp, "utf8"), before, "the evidence is left in place");
  const t = scenario();
  assert.deepEqual(writeCheckpoint(t.db, t.cp, T0 + 900_000), { ok: true, seq: 14, head: rollingHeads(t.original)[14], at_ms: T0 + 900_000 });
  assert.deepEqual(verifyAgainstCheckpoint(t.db, t.cp), { ok: true, checkpoint_seq: 14, chain_count: 14, uncovered_events: 0 });
  writeFileSync(t.cp, "garbage");
  assert.deepEqual(writeCheckpoint(t.db, t.cp), { ok: false, code: "CHECKPOINT_EXISTING_MALFORMED" });
  // broken or empty chains are not checkpointed
  const empty = openDb(join(scratch(), "x.sqlite"));
  assert.deepEqual(writeCheckpoint(empty, join(scratch(), "cp.json")), { ok: false, code: "CHECKPOINT_NOTHING_TO_COVER" });
  const u = scenario();
  dropGuards(u.db);
  u.db.exec(`UPDATE ${AUDIT_TABLE} SET at_ms = 0 WHERE seq = 14`);
  assert.deepEqual(writeCheckpoint(u.db, join(u.cpDir, "new.json")), { ok: false, code: "AUDIT_CHAIN_BROKEN" });
  assert.equal(existsSync(join(u.cpDir, "new.json")), false);
});

test("A5-36 the checkpoint path must be absolute and outside the directory holding the SQLite file", () => {
  const s = scenario();
  mkdirSync(join(s.dataDir, "sub"));
  const alias = join(scratch(), "alias");
  symlinkSync(s.dataDir, alias);
  for (const [want, file] of [
    ["CHECKPOINT_PATH_NOT_ABSOLUTE", "audit_checkpoint.json"],
    ["CHECKPOINT_INSIDE_DATA_DIR", join(s.dataDir, "audit_checkpoint.json")],
    ["CHECKPOINT_INSIDE_DATA_DIR", join(s.dataDir, "sub", "audit_checkpoint.json")],
    ["CHECKPOINT_INSIDE_DATA_DIR", join(alias, "audit_checkpoint.json")],
  ]) {
    assert.deepEqual(writeCheckpoint(s.db, file), { ok: false, code: want }, file);
    assert.equal((verifyAgainstCheckpoint(s.db, file) as { code: string }).code, want, file);
  }
  assert.deepEqual(readdirSync(s.dataDir).filter((f) => /checkpoint/.test(f)), []);
  assert.equal(writeCheckpoint(s.db, join(s.cpDir, "no-such-dir", "cp.json")).ok, false); // reported, not thrown
});

// ---- what the checkpoint does NOT close (each attack below SUCCEEDS) --------------------------------------------------

test("A5-40 LIMITATION: events after the checkpoint can be removed or replaced without detection", () => {
  const s = scenario();
  dropGuards(s.db);
  s.db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq > 12`); // drops the PAID read
  assert.deepEqual(verifyAgainstCheckpoint(s.db, s.cp), { ok: true, checkpoint_seq: 12, chain_count: 12, uncovered_events: 0 });
  const t = scenario();
  rewriteChain(t.db, [...t.original.slice(0, 13), { ...t.original[13], to_state: "PROVIDER_FAILED", data: { http_status: 200, provider_status: "FAILED" } }]);
  assert.equal(verifyAgainstCheckpoint(t.db, t.cp).ok, true, "uncovered_events is the size of the unprotected window");
});

test("A5-41 LIMITATION: the checkpoint is unkeyed, so whoever can write both files rewrites both and passes", () => {
  const s = scenario();
  const forged = rewriteChain(s.db, s.original.map((e) => (e.type === "HUMAN_APPROVED" ? { ...e, actor: "human:someone-else" } : e)));
  writeFileSync(s.cp, JSON.stringify({ seq: 12, head: rollingHeads(forged.slice(0, 12))[12], at_ms: T0 + 500_000 }));
  assert.deepEqual(verifyAgainstCheckpoint(s.db, s.cp), { ok: true, checkpoint_seq: 12, chain_count: 14, uncovered_events: 2 });
});

test("A5-42 LIMITATION: rolling the checkpoint back, or deleting it and writing a fresh one, hides a truncation", () => {
  const s = scenario();
  dropGuards(s.db);
  s.db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq > 6`);
  writeFileSync(s.cp, JSON.stringify({ seq: 6, head: rollingHeads(s.original.slice(0, 6))[6], at_ms: T0 }));
  assert.equal(verifyAgainstCheckpoint(s.db, s.cp).ok, true);
  assert.equal(writeCheckpoint(s.db, s.cp).ok, true, "and the next routine checkpoint then endorses the shortened chain");
});

test("A5-43 LIMITATION: a checkpoint vouches for stored rows, not for truth", () => {
  const dir = scratch();
  const db = openDb(join(dir, "f.sqlite"));
  appendAll(db, happyInputs(FLOW_A).map((e) => ({ ...e, actor: e.actor === HUMAN ? "human:nobody" : e.actor }))); // fabricated history
  const cp = join(scratch(), "cp.json");
  assert.equal(writeCheckpoint(db, cp).ok, true);
  assert.equal(verifyAgainstCheckpoint(db, cp).ok, true);
});
