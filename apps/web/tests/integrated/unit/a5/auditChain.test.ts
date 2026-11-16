// A5: AuditPort (integrated/auditChain.ts), contract flow-v1 §10. Offline; synthetic data; in-memory SQLite.
//
// Tests named "LIMITATION" perform an attack and assert that verification PASSES. They are deliberate: they pin down
// what an unkeyed local chain does not protect, so the limit cannot be forgotten or overstated.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_CHAIN, AUDIT_FORBIDDEN_KEY, AUDIT_TABLE, AUDIT_ZERO, AuditChainError, auditInputProblem, auditPort } from "../../../../integrated/auditChain.ts";
import { CanonicalError, flowDigest } from "../../../../integrated/flowCanonical.ts";
import type { AuditPort, FlowAuditInput } from "../../../../integrated/flowTypes.ts";
import { allEvents, appendAll, DIGEST, dropGuards, ev, FLOW_A, FLOW_B, happyInputs, HUMAN, openDb, rewriteChain, twoFlows } from "./helpers.ts";

const WEB = join(import.meta.dirname, "..", "..", "..", "..");
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuditChainError) return `${e.code} ${e.detail}`;
    if (e instanceof CanonicalError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};
const brokenAt = (db: ReturnType<typeof openDb>): string => {
  const r = auditPort.verify(db) as { ok: boolean; code?: string; at_seq?: number | null; detail?: string };
  assert.equal(r.ok, false);
  assert.equal(r.code, "AUDIT_CHAIN_BROKEN"); // the one code the flow service refuses on
  assert.deepEqual(auditPort.verify(db, FLOW_A), r, "a per-flow verify still recomputes the whole chain");
  return `${r.detail}@${r.at_seq}`;
};

// ---- contract shape -------------------------------------------------------------------------------------------------

test("A5-01 implements AuditPort: ddl is idempotent, event shape and hash follow flow-v1 §10", () => {
  const port: AuditPort = auditPort; // compile-time conformance
  const db = openDb();
  for (const sql of port.ddl) db.exec(sql); // second application is harmless
  const input = ev(FLOW_A, "FLOW_CREATED", null, "DRAFT", 1, { case_id: "CASE-SBX-0002" }, HUMAN);
  const e = port.append(db, input);
  assert.deepEqual(Object.keys(e).sort(), ["actor", "at_ms", "chain", "data", "flow_id", "flow_version", "from_state", "hash", "prev", "seq", "to_state", "type"]);
  assert.equal(e.chain, "DB_INTEGRATED_FLOW_V1");
  assert.equal(e.seq, 1);
  assert.equal(e.prev, "0".repeat(64));
  const { hash, ...rest } = e;
  assert.equal(hash, flowDigest("audit_event", rest)); // event hash = flowDigest("audit_event", event minus hash)
  assert.equal(hash, flowDigest("audit_event", { ...input, chain: AUDIT_CHAIN, seq: 1, prev: AUDIT_ZERO }));
  assert.deepEqual(port.verify(db), { ok: true, count: 1, head: hash });
});

test("A5-02 seq is global and contiguous; prev links per flow; verify reports per-flow and overall heads", () => {
  const db = openDb();
  const events = twoFlows(db);
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 14 }, (_, i) => i + 1));
  const a = events.filter((e) => e.flow_id === FLOW_A);
  const b = events.filter((e) => e.flow_id === FLOW_B);
  for (const flow of [a, b]) flow.forEach((e, i) => assert.equal(e.prev, i === 0 ? AUDIT_ZERO : flow[i - 1].hash));
  assert.deepEqual(auditPort.verify(db), { ok: true, count: 14, head: events[13].hash });
  assert.deepEqual(auditPort.verify(db, FLOW_A), { ok: true, count: 11, head: a[10].hash });
  assert.deepEqual(auditPort.verify(db, FLOW_B), { ok: true, count: 3, head: b[2].hash });
  assert.deepEqual(auditPort.verify(db, "cccccccc-0000-4000-8000-000000000003"), { ok: true, count: 0, head: AUDIT_ZERO });
  assert.deepEqual(auditPort.verify(openDb()), { ok: true, count: 0, head: AUDIT_ZERO });
});

test("A5-03 append runs inside the caller's transaction: a rollback removes the event, a commit keeps it", () => {
  const db = openDb();
  db.exec("CREATE TABLE flow_state (flow_id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO flow_state VALUES (?, ?)").run(FLOW_A, "DRAFT");
  auditPort.append(db, happyInputs(FLOW_A)[0]);
  db.exec("ROLLBACK");
  assert.deepEqual(auditPort.verify(db), { ok: true, count: 0, head: AUDIT_ZERO });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM flow_state").get()!.n, 0);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO flow_state VALUES (?, ?)").run(FLOW_A, "DRAFT");
  const e = auditPort.append(db, happyInputs(FLOW_A)[0]);
  db.exec("COMMIT");
  assert.deepEqual(auditPort.verify(db, FLOW_A), { ok: true, count: 1, head: e.hash });
  // a refused append throws, so a caller that lets the exception propagate rolls its state change back too
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE flow_state SET state = ? WHERE flow_id = ?").run("EVIDENCE_READY", FLOW_A);
  assert.throws(() => auditPort.append(db, ev(FLOW_A, "EVIDENCE_ATTACHED", "DRAFT", "EVIDENCE_READY", 2, { api_key: "x" })), AuditChainError);
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT state FROM flow_state").get()!.state, "DRAFT");
});

// ---- nothing sensitive is stored ------------------------------------------------------------------------------------

test("A5-04 forbidden keys follow the historic audit.ts pattern exactly", () => {
  const historic = readFileSync(join(WEB, "src/server/audit.ts"), "utf8").match(/const FORBIDDEN_KEY = (\/.*\/i);/);
  assert.ok(historic, "historic pattern found");
  assert.equal(String(AUDIT_FORBIDDEN_KEY), historic[1]);
  for (const k of ["api_key", "access_token", "client_secret", "password", "passphrase", "authorization", "account_number", "routing_code", "iban", "swift_code", "bank_name"]) {
    assert.equal(auditInputProblem(ev(FLOW_A, "PROVIDER_READ", "SUBMITTED", null, 7, { [k]: "x" })), "DATA_KEY_FORBIDDEN", k);
  }
});

test("A5-05 credentials, raw provider bodies and evidence text are refused; nothing reaches the table; errors never echo the value", () => {
  const db = openDb();
  appendAll(db, happyInputs(FLOW_A).slice(0, 7));
  const SECRET = "SENTINEL-BEARER-0123456789";
  const BODY = JSON.stringify({ id: "x", beneficiary: { bank_details: { account_number: "SENTINEL-ACCT-0001" } } });
  const base = (data: Record<string, unknown>) => ev(FLOW_A, "CREATE_ACCEPTED", "SUBMIT_INTENT_RECORDED", "SUBMITTED", 7, data as FlowAuditInput["data"]);
  const cases: [string, Record<string, unknown>][] = [
    ["DATA_KEY_FORBIDDEN", { authorization: `Bearer ${SECRET}` }],
    ["DATA_KEY_FORBIDDEN", { transfer_api_key: SECRET }],
    ["VALUE_LOOKS_LIKE_CREDENTIAL", { note: `Bearer ${SECRET}` }],
    ["VALUE_LOOKS_LIKE_CREDENTIAL", { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRU5USU5FTCJ9.sig" }],
    ["VALUE_LOOKS_LIKE_CREDENTIAL", { note: "-----BEGIN PRIVATE KEY----- SENTINEL" }],
    ["VALUE_LOOKS_LIKE_RAW_PAYLOAD", { provider_body: BODY }],
    ["VALUE_LOOKS_LIKE_RAW_PAYLOAD", { provider_body: `  [${BODY}]` }],
    ["VALUE_MULTILINE_TEXT", { evidence: "INVOICE SENTINEL-EVIDENCE\nPay to: Supplier\nAmount: 5.00" }],
    ["DATA_STRING_TOO_LONG", { note: "S".repeat(301) }],
    ["DATA_VALUE_NOT_SCALAR", { provider: { nested: SECRET } }],
    ["DATA_VALUE_NOT_SCALAR", { codes: [SECRET] }],
    ["DATA_NUMBER_NOT_SAFE_INTEGER", { amount: 5.5 }],
    ["DATA_KEY_SHAPE", { "Provider-Status": "PAID" }],
  ];
  for (const [want, data] of cases) assert.equal(refusal(() => auditPort.append(db, base(data))), `AUDIT_FIELD_REFUSED ${want}`, want);
  assert.equal(refusal(() => auditPort.append(db, base({ note: "x".repeat(300), http_status: 201, ok: true, nothing: null }))), "NO_ERROR"); // the limit is 300, inclusive
  const stored = JSON.stringify(db.prepare(`SELECT * FROM ${AUDIT_TABLE}`).all());
  assert.ok(!/SENTINEL|Bearer|bank_details|BEGIN PRIVATE/.test(stored));
  assert.equal((auditPort.verify(db) as { count: number }).count, 8);
  try {
    auditPort.append(db, base({ transfer_api_key: SECRET, note: `Bearer ${SECRET}` }));
    assert.fail("expected refusal");
  } catch (e) {
    assert.ok(!`${(e as Error).message} ${(e as Error).stack} ${JSON.stringify(e)}`.includes("SENTINEL"));
  }
});

test("A5-06 envelope fields are validated: flow id, type, actor, states, version, time, exact key set", () => {
  const good = ev(FLOW_A, "FLOW_CREATED", null, "DRAFT", 1);
  assert.equal(auditInputProblem(good), null);
  const cases: [string, Record<string, unknown>][] = [
    ["FLOW_ID", { flow_id: "../../etc/passwd" }],
    ["FLOW_ID", { flow_id: FLOW_A.toUpperCase() }],
    ["TYPE", { type: "flow created" }],
    ["TYPE", { type: "X" }],
    ["ACTOR", { actor: "operator" }],
    ["ACTOR", { actor: "human:" }],
    ["ACTOR", { actor: "human:line\nbreak" }],
    ["ACTOR", { actor: "system:anything" }],
    ["FROM_STATE", { from_state: "PAID" }],
    ["TO_STATE", { to_state: "SETTLED" }],
    ["FLOW_VERSION", { flow_version: -1 }],
    ["FLOW_VERSION", { flow_version: 1.5 }],
    ["AT_MS", { at_ms: "now" }],
    ["DATA_NOT_OBJECT", { data: null }],
    ["DATA_NOT_PLAIN_OBJECT", { data: new Map() }],
    ["EVENT_KEYS", { extra: 1 }],
    ["EVENT_KEYS", { hash: DIGEST }], // a caller cannot supply chain fields
  ];
  for (const [want, change] of cases) assert.equal(auditInputProblem({ ...good, ...change }), want, JSON.stringify(change));
  for (const actor of ["server", "system:recovery", "human:operator", "human:Test Operator B."]) assert.equal(auditInputProblem({ ...good, actor }), null, actor);
  assert.equal(auditInputProblem(null), "EVENT_NOT_OBJECT");
  // a string CANON-1 refuses fails closed with the contract's own error
  assert.equal(refusal(() => auditPort.append(openDb(), { ...good, data: { note: "é" } })), "CANON_STRING_NOT_NFC");
});

// ---- what the chain detects -----------------------------------------------------------------------------------------

test("A5-07 the table refuses UPDATE and DELETE (a guard against application mistakes)", () => {
  const db = openDb();
  twoFlows(db);
  assert.throws(() => db.exec(`UPDATE ${AUDIT_TABLE} SET actor = 'human:other' WHERE seq = 6`), /AUDIT_APPEND_ONLY/);
  assert.throws(() => db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq = 14`), /AUDIT_APPEND_ONLY/);
  assert.throws(() => db.exec(`INSERT INTO ${AUDIT_TABLE} SELECT * FROM ${AUDIT_TABLE} WHERE seq = 1`), /UNIQUE|PRIMARY/i);
  assert.equal(auditPort.verify(db).ok, true);
});

test("A5-08 detected: every edit, deletion, insertion or relinking that does not recompute the hashes", () => {
  const attack = (sql: string): string => {
    const db = openDb();
    twoFlows(db);
    dropGuards(db);
    db.exec(sql);
    return brokenAt(db);
  };
  const T = AUDIT_TABLE;
  assert.equal(attack(`UPDATE ${T} SET actor = 'human:someone-else' WHERE seq = 8`), "HASH_MISMATCH@8");
  assert.equal(attack(`UPDATE ${T} SET data = replace(data, 'PROCESSING', 'PAID') WHERE seq = 12`), "HASH_MISMATCH@12");
  assert.equal(attack(`UPDATE ${T} SET to_state = 'PROVIDER_PAID' WHERE seq = 12`), "HASH_MISMATCH@12");
  assert.equal(attack(`UPDATE ${T} SET at_ms = at_ms - 86400000 WHERE seq = 3`), "HASH_MISMATCH@3");
  assert.equal(attack(`UPDATE ${T} SET flow_id = '${FLOW_B}' WHERE seq = 3`), "HASH_MISMATCH@3");
  assert.equal(attack(`DELETE FROM ${T} WHERE seq = 5`), "SEQ_GAP@5");
  assert.equal(attack(`DELETE FROM ${T} WHERE seq = 1`), "SEQ_GAP@1");
  assert.equal(attack(`UPDATE ${T} SET seq = 99 WHERE seq = 14`), "HASH_MISMATCH@14");
  assert.equal(attack(`UPDATE ${T} SET hash = '${"e".repeat(64)}' WHERE seq = 2`), "HASH_MISMATCH@2");
  assert.equal(attack(`UPDATE ${T} SET prev = '${"e".repeat(64)}' WHERE seq = 4`), "HASH_MISMATCH@4");
  assert.equal(attack(`UPDATE ${T} SET data = '{"case_id": "CASE-SBX-0002"}' WHERE seq = 1`), "ROW_DATA_NOT_CANONICAL@1");
  assert.equal(attack(`UPDATE ${T} SET data = 'not json' WHERE seq = 1`), "ROW_DATA_NOT_JSON@1");
  assert.equal(attack(`UPDATE ${T} SET to_state = 'SETTLED' WHERE seq = 1`), "ROW_TO_STATE@1");
  assert.equal(attack(`DROP TABLE ${T}`), "STORE_UNREADABLE@null");
  // a self-consistent forged event appended with the wrong link (points at the other flow's head)
  const db = openDb();
  const events = twoFlows(db);
  const forged = { ...ev(FLOW_B, "GATE_EVALUATED", "EVIDENCE_READY", "GATE_ELIGIBLE", 3), chain: AUDIT_CHAIN, seq: 15, prev: events[13].hash };
  db.prepare(`INSERT INTO ${AUDIT_TABLE} (seq, flow_id, type, actor, from_state, to_state, flow_version, data, at_ms, prev, hash) VALUES (15, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`).run(
    forged.flow_id, forged.type, forged.actor, forged.from_state, forged.to_state, forged.flow_version, forged.at_ms, forged.prev, flowDigest("audit_event", forged),
  );
  assert.equal(brokenAt(db), "PREV_MISMATCH@15");
  // a stored event carrying a forbidden key is a broken chain even when its hash is right
  const db2 = openDb();
  rewriteChain(db2, [{ ...ev(FLOW_A, "FLOW_CREATED", null, "DRAFT", 1, { api_key: "x" }), chain: AUDIT_CHAIN, seq: 1, prev: AUDIT_ZERO, hash: "" }]);
  assert.equal(brokenAt(db2), "ROW_DATA_KEY_FORBIDDEN@1");
});

test("A5-09 append refuses on a damaged tail without waiting for a full verify", () => {
  const db = openDb();
  twoFlows(db);
  dropGuards(db);
  db.exec(`UPDATE ${AUDIT_TABLE} SET actor = 'human:someone-else' WHERE seq = 14`);
  assert.equal(refusal(() => auditPort.append(db, ev(FLOW_B, "REFUSED", "GATE_ELIGIBLE", null, 3, { op: "approve", code: "X" }))), "AUDIT_CHAIN_BROKEN HASH_MISMATCH");
  const db2 = openDb();
  twoFlows(db2);
  dropGuards(db2);
  db2.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq = 4`);
  assert.equal(refusal(() => auditPort.append(db2, ev(FLOW_B, "REFUSED", "GATE_ELIGIBLE", null, 3, { op: "approve", code: "X" }))), "AUDIT_CHAIN_BROKEN SEQ_GAP");
  assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM ${AUDIT_TABLE}`).get()!.n, 13);
});

// ---- LIMITS OF AN UNKEYED LOCAL CHAIN (each attack below SUCCEEDS) ----------------------------------------------------

test("A5-10 LIMITATION: a same-user rewrite that recomputes the hashes verifies", () => {
  const db = openDb();
  const original = twoFlows(db);
  // change who approved flow A, then re-link everything
  const forged = rewriteChain(db, allEvents(db).map((e) => (e.type === "HUMAN_APPROVED" ? { ...e, actor: "human:someone-else" } : e)));
  assert.deepEqual(auditPort.verify(db), { ok: true, count: 14, head: forged[13].hash });
  assert.equal(allEvents(db).find((e) => e.type === "HUMAN_APPROVED")!.actor, "human:someone-else");
  assert.notEqual(forged[13].hash, original[13].hash); // the only trace: a different head, visible only to someone who kept the old one
});

test("A5-11 LIMITATION: truncating the tail verifies, and makes the trail say less than what happened", () => {
  const db = openDb();
  appendAll(db, happyInputs(FLOW_A));
  dropGuards(db);
  db.exec(`DELETE FROM ${AUDIT_TABLE} WHERE seq > 6`); // remove the submit intent and everything the provider said
  const r = auditPort.verify(db, FLOW_A);
  assert.equal(r.ok, true, "the trail now ends at HUMAN_APPROVED: a submitted request reads as never submitted");
  assert.equal(allEvents(db).at(-1)!.to_state, "HUMAN_APPROVED");
  // and the audit port will accept a second submit intent, because the first is gone
  auditPort.append(db, ev(FLOW_A, "SUBMIT_INTENT_RECORDED", "HUMAN_APPROVED", "SUBMIT_INTENT_RECORDED", 6, {}, HUMAN));
  assert.equal(auditPort.verify(db).ok, true, "one-create-attempt must rest on the flow store and the provider request id, never on this chain");
});

test("A5-12 LIMITATION: deleting every event, fabricating a whole history, back-dating and naming any actor all verify", () => {
  const db = openDb();
  twoFlows(db);
  dropGuards(db);
  db.exec(`DELETE FROM ${AUDIT_TABLE}`);
  assert.deepEqual(auditPort.verify(db), { ok: true, count: 0, head: AUDIT_ZERO }); // reads as "nothing ever happened"
  const fabricated = openDb();
  appendAll(fabricated, happyInputs(FLOW_A).map((e) => ({ ...e, at_ms: e.at_ms - 365 * 86_400_000, actor: e.actor === HUMAN ? "human:anyone" : e.actor })));
  assert.equal(auditPort.verify(fabricated).ok, true, "actor and at_ms are the writer's claims; nothing here authenticates them");
});

// ---- hygiene --------------------------------------------------------------------------------------------------------

test("A5-13 the audit modules read no environment, open no network and import only the contract files", () => {
  for (const f of ["integrated/auditChain.ts", "integrated/auditExport.ts"]) {
    if (!existsSync(join(WEB, f))) continue; // auditExport.ts is cuttable
    const src = readFileSync(join(WEB, f), "utf8");
    assert.doesNotMatch(src, /process\.env|fetch\(|node:https?|node:net|node:child_process/, f);
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.ok(["node:fs", "node:path", "./flowCanonical.ts", "./flowTypes.ts", "./auditChain.ts"].includes(m[1]), `${f} imports ${m[1]}`);
  }
  assert.doesNotMatch(readFileSync(join(WEB, "integrated/auditChain.ts"), "utf8"), /from "[^"]*(auditExport|node:fs)[^"]*"/, "the port does not import the cuttable export/checkpoint layer and touches no file itself");
});
