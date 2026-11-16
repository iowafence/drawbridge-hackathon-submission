// Support for the A8-01 / A8-02 reproductions (tests/integrated/e2e/a8_reproductions.test.ts). TEST CODE ONLY.
//
// Two things live here:
//   1. `service(world)`: the real merged flow service (flow lane), gate port, proposal builder, registry and audit
//      port, wired through FlowDeps exactly as the conformance binding does, over this suite's own mock provider.
//      One call = one server process: it captures the allowlist and the approval key that exist at that moment.
//   2. The UNTRUSTED STORE WRITER of the review scope: someone who can write flow-v1.sqlite directly. It drops the
//      store's integrity triggers and edits rows. It never holds the server's approval key. Nothing here calls any
//      non-exported implementation code; the writer only knows table and column names.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { auditPort } from "../../../integrated/auditChain.ts";
import { authorizationDigest, gateDigest, proposalDigest } from "../../../integrated/flowCanonical.ts";
import { createFlowService } from "../../../integrated/flowService.ts";
import type { AuthorizationRecord, FlowDeps, FlowProposal, FlowRecordV1, FlowService, GateRecord, ProviderCallResult, ProviderPort, ProviderTransferBody } from "../../../integrated/flowTypes.ts";
import { gatePort } from "../../../integrated/gateBinding.ts";
import { buildProposal, INTEGRATED_REGISTRY, replayEvidence } from "../../../integrated/proposalBuilder.ts";
import { BALANCE, privateDir, T0 } from "./fixtures.ts";
import { MockNetworkError } from "./mockProvider.ts";
import type { MockResponse } from "./mockProvider.ts";
import { World } from "./port.ts";

export const OPERATOR = "human:operator";
export const ELIGIBLE_CASE = "CASE-SBX-0002";
/** A second sandbox test beneficiary that is on the allowlist but belongs to nobody's obligation. */
export const ATTACKER_BEN = "11111111-1111-4111-8111-111111111111";
export const ATTACKER_LABEL = "Attacker supplies";

export function newWorld(label: string, beneficiaries: [string, string][]): World {
  return new World(privateDir(label), { t: T0, registryVariant: "baseline", balanceUsd: BALANCE, beneficiaries, fixedUuid: null });
}

function providerPort(world: World): ProviderPort {
  const call = async (fn: () => Promise<MockResponse>): Promise<ProviderCallResult> => {
    try {
      const r = await fn();
      return { kind: "HTTP", status: r.status, body: r.body };
    } catch (e) {
      if (e instanceof MockNetworkError) return { kind: "TRANSPORT_ERROR", code: "MOCK_NETWORK_ERROR" };
      throw e;
    }
  };
  return {
    mode: "mock",
    validate: (b: ProviderTransferBody) => call(() => world.provider.validate(b)),
    create: (b: ProviderTransferBody) => call(() => world.provider.create(b)),
    readById: (id: string) => call(() => world.provider.getById(id)),
    readByRequestId: (rid: string) => call(() => world.provider.findByRequestId(rid)),
  };
}

/** One server process over the world's store: the real modules and, unless another provider is passed, this suite's
 *  SIMULATED PROVIDER. That provider keeps its records in the test's private directory OUTSIDE the server's data dir,
 *  as a real provider's records are outside the server's reach: nothing a data-dir writer does can erase them. */
export function service(world: World, provider: ProviderPort = providerPort(world)): FlowService {
  const deps: FlowDeps = {
    approvalKey: world.approvalKey(), dataDir: world.dataDir, providerMode: "mock", submitRelease: null, gate: gatePort, provider, audit: auditPort, ledger: null,
    registry: INTEGRATED_REGISTRY, allowlist: world.beneficiaries(), buildProposal, replayEvidence, runLookup: () => null,
    balanceUsd: async () => world.balanceUsd(), ledgerAllocationFor: () => null, now: world.now, uuid: world.uuid,
  };
  return createFlowService(deps);
}

export const documentOf = (caseId: string): string => {
  const o = INTEGRATED_REGISTRY.obligations.find((x) => x.case_id === caseId);
  if (!o) throw new Error(`FIXTURE_CASE_MISSING ${caseId}`);
  return o.registered_documents[0].document_id;
};
export const e3Cases = (): string[] => INTEGRATED_REGISTRY.obligations.filter((o) => o.funding_source === "E3_PROJECT").map((o) => o.case_id);

export function flowOf(svc: FlowService, id: string): FlowRecordV1 {
  const f = svc.getFlow(id);
  if (!f) throw new Error("FLOW_NOT_READABLE");
  return f;
}

export type Stage = "EVIDENCE_READY" | "GATE_ELIGIBLE" | "AWAITING_HUMAN" | "HUMAN_APPROVED";
/** Drive a flow honestly, as the operator would, and stop at `stage`. Throws if the honest path does not get there. */
export async function driveTo(svc: FlowService, stage: Stage, caseId: string = ELIGIBLE_CASE): Promise<string> {
  const must = (ok: boolean, what: string, code: string) => {
    if (!ok) throw new Error(`HONEST_PATH_FAILED ${what}: ${code}`);
  };
  const created = svc.createFlow(OPERATOR, caseId);
  must(created.ok && !!created.flow_id, "createFlow", created.code);
  const id = created.flow_id as string;
  const attached = svc.attachEvidence(OPERATOR, id, { kind: "FIXTURE_REPLAY", document_id: documentOf(caseId) });
  must(attached.ok, "attachEvidence", attached.code);
  if (stage === "EVIDENCE_READY") return id;
  const gate = await svc.evaluateGate(OPERATOR, id);
  must(flowOf(svc, id).state === "GATE_ELIGIBLE", "evaluateGate", gate.code);
  if (stage === "GATE_ELIGIBLE") return id;
  const review = await svc.requestHumanReview(OPERATOR, id);
  must(flowOf(svc, id).state === "AWAITING_HUMAN", "requestHumanReview", review.code);
  if (stage === "AWAITING_HUMAN") return id;
  const f = flowOf(svc, id);
  const approval = await svc.approve(OPERATOR, id, f.proposal_digest, f.gate?.gate_digest);
  must(flowOf(svc, id).state === "HUMAN_APPROVED", "approve", approval.code);
  return id;
}

// ---------------------------------------------------------------------------------------------- untrusted store writer

/** Open the store file directly and drop every integrity trigger, as the review's store writer does. */
export function storeWriter(world: World, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(world.dataDir, "flow-v1.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) db.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
    fn(db);
  } finally {
    db.close();
  }
}

type Row = { proposal_json: string; gate_json: string | null; authorization_json: string | null };

/** A8-01, probe X1: rewrite the stored proposal so the payment goes to another beneficiary, and keep every stored
 *  record that the writer CAN keep consistent, consistent: the proposal digest, and (when they already exist) the
 *  gate record and the authorization record with recomputed digests. The approval MAC cannot be recomputed without
 *  the server key and is left as it was. */
export function redirectBeneficiary(world: World, flowId: string, to: { beneficiary_id?: string; beneficiary_label?: string }): FlowProposal {
  const out: { proposal: FlowProposal | null } = { proposal: null };
  storeWriter(world, (db) => {
    const row = db.prepare("SELECT proposal_json, gate_json, authorization_json FROM flow WHERE flow_id=?").get(flowId) as Row | undefined;
    if (!row) throw new Error("STORE_WRITER_FLOW_MISSING");
    const p = { ...(JSON.parse(row.proposal_json) as FlowProposal), ...to };
    const pd = proposalDigest(p);
    out.proposal = p;
    db.prepare("UPDATE flow SET proposal_json=?, proposal_digest=? WHERE flow_id=?").run(JSON.stringify(p), pd, flowId);
    if (!row.gate_json) return;
    const { gate_digest: _oldGate, ...gateRest } = JSON.parse(row.gate_json) as GateRecord;
    const gate: GateRecord = { ...gateRest, proposal_digest: pd, gate_digest: gateDigest({ ...gateRest, proposal_digest: pd }) };
    db.prepare("UPDATE flow SET gate_json=?, gate_digest=? WHERE flow_id=?").run(JSON.stringify(gate), gate.gate_digest, flowId);
    if (!row.authorization_json) return;
    const { authorization_digest: _oldAuth, ...authRest } = JSON.parse(row.authorization_json) as AuthorizationRecord;
    const rest = { ...authRest, proposal_digest: pd, gate_digest: gate.gate_digest };
    const auth: AuthorizationRecord = { ...rest, authorization_digest: authorizationDigest(rest) };
    db.prepare("UPDATE flow SET authorization_json=? WHERE flow_id=?").run(JSON.stringify(auth), flowId);
    db.prepare("UPDATE flow_authorization SET proposal_digest=?, gate_digest=?, authorization_digest=? WHERE flow_id=?").run(pd, gate.gate_digest, auth.authorization_digest, flowId);
  });
  if (!out.proposal) throw new Error("STORE_WRITER_DID_NOT_RUN");
  return out.proposal;
}

/** A8-02, probe X2: erase every stored trace that the approval was used, and put the flow back to HUMAN_APPROVED.
 *  The first two statements are the review probe's, verbatim; the third also clears what a completed create left. */
export function rollBackToApproved(world: World, flowId: string): void {
  storeWriter(world, (db) => {
    db.prepare("DELETE FROM flow_submit_attempt WHERE flow_id=?").run(flowId);
    db.prepare("UPDATE flow SET state='HUMAN_APPROVED', attempt_id=NULL, attempt_recorded_at_ms=NULL, authorization_consumed_at_ms=NULL, provider_mode=NULL, create_http_status=NULL WHERE flow_id=?").run(flowId);
    db.prepare("UPDATE flow SET provider_transfer_id=NULL, create_reported_status=NULL, last_provider_status=NULL, last_provider_read_at_ms=NULL WHERE flow_id=?").run(flowId);
  });
}

// ------------------------------------------------------------------------------------------- A8-09 store-writer helpers

const STORE_FILE = "flow-v1.sqlite";
const storePath = (world: World): string => join(world.dataDir, STORE_FILE);

/** A8-09, probe "R2 residual": erase every stored trace of the submission AND of the approval, and put the flow back
 *  to an earlier state. For AWAITING_HUMAN the statements are the review probe's, verbatim. The deeper targets also
 *  erase the review (GATE_ELIGIBLE) or the whole gate record (EVIDENCE_READY). */
export function rollBackTo(world: World, flowId: string, state: "AWAITING_HUMAN" | "GATE_ELIGIBLE" | "EVIDENCE_READY"): void {
  storeWriter(world, (db) => {
    db.prepare("DELETE FROM flow_submit_attempt WHERE flow_id=?").run(flowId);
    const common = "attempt_id=NULL, attempt_recorded_at_ms=NULL, authorization_consumed_at_ms=NULL, provider_mode=NULL, create_http_status=NULL, create_reported_status=NULL, provider_transfer_id=NULL, last_provider_status=NULL, last_provider_read_at_ms=NULL";
    db.prepare("DELETE FROM flow_authorization WHERE flow_id=?").run(flowId);
    const gate = state === "EVIDENCE_READY" ? ", gate_json=NULL, gate_digest=NULL, proof_reasons_json=NULL" : "";
    db.prepare(`UPDATE flow SET state='${state}', authorization_json=NULL, gate_consumed_at_ms=NULL${gate}, ${common} WHERE flow_id=?`).run(flowId);
  });
}

export type StoreCopy = { files: Map<string, Buffer> };
/** A byte copy of the flow database file (and its WAL sidecars, after a checkpoint), as a backup would take it. */
export function copyStore(world: World): StoreCopy {
  const db = new DatabaseSync(storePath(world));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(world.dataDir)) if (name.startsWith(STORE_FILE)) files.set(name, readFileSync(join(world.dataDir, name)));
  return { files };
}
/** Put that copy back over the live database: the flow database is restored, nothing else in the data dir is touched. */
export function restoreStore(world: World, copy: StoreCopy): void {
  for (const name of readdirSync(world.dataDir)) if (name.startsWith(STORE_FILE) && !copy.files.has(name)) rmSync(join(world.dataDir, name));
  for (const [name, bytes] of copy.files) writeFileSync(join(world.dataDir, name), bytes, { mode: 0o600 });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
/** Every file under the data dir that is NOT the flow database. Whatever submission history the server keeps outside
 *  the database lives here; the tests deliberately do not know its name or format. */
export function filesOutsideStore(world: World): string[] {
  return walk(world.dataDir).filter((f) => !f.slice(world.dataDir.length + 1).startsWith(STORE_FILE));
}
/** Damage everything the server keeps outside the flow database. Returns how many files were hit. */
export function damageOutsideStore(world: World, how: "DELETE" | "TRUNCATE" | "GARBLE"): number {
  const files = filesOutsideStore(world);
  for (const f of files) {
    if (how === "DELETE") rmSync(f);
    else if (how === "TRUNCATE") writeFileSync(f, "");
    else {
      const bytes = readFileSync(f);
      // keep the length, corrupt the content: flip every byte of the second half and append a broken line
      for (let i = Math.floor(bytes.length / 2); i < bytes.length; i++) bytes[i] ^= 0xff;
      writeFileSync(f, Buffer.concat([bytes, Buffer.from('\n{"not":"a valid record"\n')]));
    }
  }
  return files.length;
}

export type DataDirCopy = { files: Map<string, Buffer> };
/** A byte copy of EVERYTHING in the data dir: the flow database and whatever else the server keeps beside it. */
export function copyDataDir(world: World): DataDirCopy {
  copyStore(world); // checkpoints the WAL so the database file is complete on its own
  const files = new Map<string, Buffer>();
  for (const f of walk(world.dataDir)) files.set(f.slice(world.dataDir.length + 1), readFileSync(f));
  return { files };
}
/** Put the whole data dir back as it was: the strongest restore, in which database and history go back together. */
export function restoreDataDir(world: World, copy: DataDirCopy): void {
  for (const f of walk(world.dataDir)) if (!copy.files.has(f.slice(world.dataDir.length + 1))) rmSync(f);
  for (const [rel, bytes] of copy.files) writeFileSync(join(world.dataDir, rel), bytes, { mode: 0o600 });
}
