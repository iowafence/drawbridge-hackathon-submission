// A7 integration test (contract §15, §16; owner proof 8 and finding F-A7-01). Runs the REAL merged modules:
// A3 flowService/flowStore, A1 gatePort/buildProposal/registry, A5 auditPort, mock provider. An untrusted writer of
// flow-v1.sqlite (store triggers dropped = full write power) tries to turn forged records into payment authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFlowService } from "../../../integrated/flowService.ts";
import { gatePort } from "../../../integrated/gateBinding.ts";
import { INTEGRATED_REGISTRY, buildProposal, replayEvidence } from "../../../integrated/proposalBuilder.ts";
import { MOCK_ALLOWLIST, mockProvider } from "../../../integrated/paymentAdapter.ts";
import { auditPort } from "../../../integrated/auditChain.ts";
import { approvalMac, authorizationDigest, gateDigest, proposalDigest } from "../../../integrated/flowCanonical.ts";
import { PROOF_IDS } from "../../../integrated/flowTypes.ts";
import type { FlowDeps, FlowService, GateRecord } from "../../../integrated/flowTypes.ts";

const H = "human:operator";
const allVerified = Object.fromEntries(PROOF_IDS.map((p) => [p, "VERIFIED"]));
const docOf = (caseId: string) => INTEGRATED_REGISTRY.obligations.find((o) => o.case_id === caseId)!.registered_documents[0].document_id;

function world(key: Uint8Array = randomBytes(32)) {
  const base = process.env.TMPDIR ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "a7-forge-"));
  const provider = mockProvider({});
  const clock = { t: 1_800_000_000_000 };
  const deps: FlowDeps = {
    approvalKey: key, dataDir: join(dir, "data"), providerMode: "mock", submitRelease: null, gate: gatePort, provider, audit: auditPort, ledger: null,
    registry: INTEGRATED_REGISTRY, allowlist: MOCK_ALLOWLIST, buildProposal, replayEvidence, runLookup: () => null,
    balanceUsd: async () => "10000000.00", ledgerAllocationFor: () => null, now: () => clock.t, uuid: () => randomUUID(),
  };
  return { svc: createFlowService(deps), file: join(deps.dataDir, "flow-v1.sqlite"), provider, clock, key };
}
type World = ReturnType<typeof world>;
const creates = (w: World) => w.provider.calls().create;
const validates = (w: World) => w.provider.calls().validate;

/** Untrusted writer: drop every store trigger, apply the edit, close. */
function raw(file: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) db.exec(`DROP TRIGGER "${t.name}"`);
  fn(db);
  db.close();
}
async function toGate(svc: FlowService, caseId: string): Promise<string> {
  const r = svc.createFlow(H, caseId);
  assert.ok(r.ok && r.flow_id, `createFlow ${caseId}: ${r.code}`);
  assert.equal(svc.attachEvidence(H, r.flow_id!, { kind: "FIXTURE_REPLAY", document_id: docOf(caseId) }).ok, true);
  await svc.evaluateGate(H, r.flow_id!);
  return r.flow_id!;
}
const reseal = (g: GateRecord, patch: Partial<GateRecord>): GateRecord => {
  const { gate_digest: _, ...rest } = { ...g, ...patch };
  return { ...rest, gate_digest: gateDigest(rest) } as GateRecord;
};

test("A7-INT-00 baseline: the real eligible path approves and creates exactly once (mock provider)", async () => {
  const w = world();
  const id = await toGate(w.svc, "CASE-SBX-0002");
  assert.equal(w.svc.getFlow(id)!.state, "GATE_ELIGIBLE");
  assert.equal((await w.svc.requestHumanReview(H, id)).ok, true);
  const rec = w.svc.getFlow(id)!;
  assert.equal((await w.svc.approve(H, id, rec.proposal_digest, rec.gate!.gate_digest)).code, "HUMAN_APPROVED");
  const r = await w.svc.submit(H, id, w.svc.getFlow(id)!.authorization!.authorization_digest);
  assert.equal(r.code, "SUBMITTED");
  assert.equal(creates(w), 1);
});

test("A7-INT-01 forged ELIGIBLE gate record on a HOLD obligation is refused by fresh re-evaluation", async () => {
  const w = world();
  const id = await toGate(w.svc, "CASE-PTC-2043");
  const rec = w.svc.getFlow(id)!;
  assert.equal(rec.state, "GATE_HOLD");
  const g2 = reseal(rec.gate!, { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", gate_refused: false, proof_states: allVerified as GateRecord["proof_states"], document_binding: "REGISTERED_DOCUMENT" });
  raw(w.file, (db) => db.prepare("UPDATE flow SET gate_json=?, gate_digest=?, state='AWAITING_HUMAN' WHERE flow_id=?").run(JSON.stringify(g2), g2.gate_digest, id));
  const r = await w.svc.approve(H, id, rec.proposal_digest, g2.gate_digest);
  assert.equal(r.ok, false);
  assert.equal(r.code, "GATE_REEVALUATION_MISMATCH");
  assert.equal(w.svc.getFlow(id)!.authorization, null);
  assert.equal(creates(w), 0);
});

test("A7-INT-02 forged gate plus evidence and claims swapped in from an eligible obligation is refused (obligation binding)", async () => {
  const w = world();
  const src = world();
  const eid = await toGate(src.svc, "CASE-SBX-0002");
  const er = new DatabaseSync(src.file).prepare("SELECT evidence_text, claims_json, evidence_document_id, evidence_digest, gate_json FROM flow WHERE flow_id=?").get(eid) as Record<string, string>;
  const id = await toGate(w.svc, "CASE-PTC-2043");
  const rec = w.svc.getFlow(id)!;
  const g2 = reseal(JSON.parse(er.gate_json), { flow_id: id, proposal_digest: rec.proposal_digest, evaluated_at_ms: w.clock.t, expires_at_ms: w.clock.t + 600_000 });
  raw(w.file, (db) => db.prepare("UPDATE flow SET evidence_text=?, claims_json=?, evidence_document_id=?, evidence_digest=?, gate_json=?, gate_digest=?, state='AWAITING_HUMAN' WHERE flow_id=?")
    .run(er.evidence_text, er.claims_json, er.evidence_document_id, er.evidence_digest, JSON.stringify(g2), g2.gate_digest, id));
  const r = await w.svc.approve(H, id, rec.proposal_digest, g2.gate_digest);
  assert.equal(r.ok, false);
  assert.ok(["GATE_REEVALUATION_MISMATCH", "EVIDENCE_CHANGED", "CLAIMS_CHANGED", "PROPOSAL_CHANGED"].includes(r.code), r.code);
  assert.equal(creates(w), 0);
});

test("A7-INT-03 F-A7-01 regression: a planted authorization the server never issued cannot be submitted", async () => {
  const w = world();
  const other = world(randomBytes(32));
  for (const variant of ["random-mac", "foreign-key-mac", "copied-mac"] as const) {
    const id = await toGate(w.svc, "CASE-SBX-0002");
    assert.equal((await w.svc.requestHumanReview(H, id)).ok, true);
    const rec = w.svc.getFlow(id)!;
    const now = w.clock.t;
    const rest = { flow_id: id, proposal_digest: rec.proposal_digest, gate_digest: rec.gate!.gate_digest, operator_id: H, approved_at_ms: now, expires_at_ms: now + 600_000, flow_version: rec.version };
    const a = { ...rest, authorization_digest: authorizationDigest(rest) };
    let mac = randomBytes(32).toString("hex");
    if (variant === "foreign-key-mac") mac = approvalMac(other.key, a.authorization_digest);
    if (variant === "copied-mac") {
      const gid = await toGate(w.svc, "CASE-SBX-0002");
      await w.svc.requestHumanReview(H, gid);
      const g = w.svc.getFlow(gid)!;
      assert.equal((await w.svc.approve(H, gid, g.proposal_digest, g.gate!.gate_digest)).ok, true);
      mac = (new DatabaseSync(w.file).prepare("SELECT approval_mac FROM flow_authorization WHERE flow_id=?").get(gid) as { approval_mac: string }).approval_mac;
    }
    raw(w.file, (db) => {
      db.prepare("INSERT INTO flow_authorization (flow_id, gate_digest, authorization_digest, proposal_digest, operator_id, approved_at_ms, expires_at_ms, flow_version, approval_mac) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(a.flow_id, a.gate_digest, a.authorization_digest, a.proposal_digest, a.operator_id, a.approved_at_ms, a.expires_at_ms, a.flow_version, mac);
      db.prepare("UPDATE flow SET authorization_json=?, gate_consumed_at_ms=?, state='HUMAN_APPROVED', version=version+1 WHERE flow_id=?").run(JSON.stringify(a), now, id);
    });
    const before = { c: creates(w), v: validates(w) };
    const r = await w.svc.submit(H, id, a.authorization_digest);
    assert.equal(r.ok, false, variant);
    assert.equal(r.code, "AUTHORIZATION_NOT_SERVER_ISSUED", variant);
    assert.deepEqual({ c: creates(w), v: validates(w) }, before, `${variant}: nothing validated or created`);
    assert.equal(w.svc.getFlow(id)!.state, "HUMAN_APPROVED", variant);
  }
});

test("A7-INT-04 a rewritten proposal (payee/amount/beneficiary) breaks its digest and cannot be approved or submitted", async () => {
  const w = world();
  const id = await toGate(w.svc, "CASE-SBX-0002");
  await w.svc.requestHumanReview(H, id);
  const rec = w.svc.getFlow(id)!;
  const p2 = { ...rec.proposal, amount_minor: "999" };
  raw(w.file, (db) => db.prepare("UPDATE flow SET proposal_json=? WHERE flow_id=?").run(JSON.stringify(p2), id));
  const r1 = await w.svc.approve(H, id, rec.proposal_digest, rec.gate!.gate_digest);
  assert.equal(r1.ok, false);
  const pd = proposalDigest(p2);
  raw(w.file, (db) => db.prepare("UPDATE flow SET proposal_digest=? WHERE flow_id=?").run(pd, id));
  const r2 = await w.svc.approve(H, id, pd, rec.gate!.gate_digest);
  assert.equal(r2.ok, false, `consistent rewrite still refused (${r2.code})`);
  assert.equal(creates(w), 0);
});
