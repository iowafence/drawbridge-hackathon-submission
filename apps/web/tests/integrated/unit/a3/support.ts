// A3 unit-test fixtures. TEST CODE ONLY. Everything is offline: the file-backed mock provider from paymentAdapter.ts,
// a fake GatePort and a fake AuditPort in the flow-v1 shapes, a fake proposal builder and a fake ledger. No network,
// no language system, no real credential. The real gate binding and audit chain are other lanes' modules.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowDigest, gateDigest } from "../../../../integrated/flowCanonical.ts";
import { createFlowService } from "../../../../integrated/flowService.ts";
import type { FlowTestHooks } from "../../../../integrated/flowService.ts";
import { GATE_POLICY_VERSION, GATE_TTL_MS, PROOF_IDS } from "../../../../integrated/flowTypes.ts";
import type { AuditPort, FlowAuditEvent, FlowAuditInput, FlowDeps, FlowProposal, FlowRecordV1, FlowService, GatePort, GateRecord, LedgerPort, ProofStates, ProviderPort, SqlTx } from "../../../../integrated/flowTypes.ts";
import { MOCK_ALLOWLIST, mockProvider } from "../../../../integrated/paymentAdapter.ts";
import type { MockProvider } from "../../../../integrated/paymentAdapter.ts";
import type { Decision } from "../../../../src/server/agentPolicy.ts";
import { documentDigest } from "../../../../src/server/agentRegistry.ts";
import type { Registry } from "../../../../src/server/agentRegistry.ts";
import { toMinor } from "../../../../src/server/policy.ts";

export const T0 = 1_800_000_000_000;
/** Fixed test approval key (flow-v1.2 R11). The runtime generates a random one per process. */
export const TEST_APPROVAL_KEY = new Uint8Array(32).fill(7);
export const CASE = "CASE-SBX-0002";
export const DOC = "DOC-SBX-0002-INV";
export const OPERATOR = "human:operator";
export const [BEN, BEN_LABEL] = [...MOCK_ALLOWLIST.entries()][0];
export const EVIDENCE = "INVOICE DB-SBX-0002\nPrairie Test Concrete LLC\nNet payable 5.00 USD";
const REGISTRY = { provenance: "A3_TEST", authorities: [], obligations: [] } as unknown as Registry;

export type GateKnobs = { decision: Decision; proofs: ProofStates; revalidate: string | null; throws: boolean; mutate: ((g: GateRecord) => GateRecord) | null; evaluations: number; revalidations: string[] };
export const allVerified = (): ProofStates => Object.fromEntries(PROOF_IDS.map((k) => [k, "VERIFIED"])) as ProofStates;

/** A GatePort with the contract's shape. It decides from the knobs, not from evidence: these tests are about what
 *  the flow does WITH a gate result, never about the gate itself. */
export function fakeGate(k: GateKnobs): GatePort {
  return {
    evaluateAndBind(input) {
      k.evaluations++;
      if (k.throws) throw new Error("gate down");
      const rest = {
        flow_id: input.flow_id, proposal_digest: input.proposal_digest, evidence_source: input.evidence_source, evidence_digest: documentDigest(input.evidence_text),
        document_id: k.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? DOC : null, document_binding: (k.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? "REGISTERED_DOCUMENT" : "NONE") as GateRecord["document_binding"],
        registry_digest: flowDigest("registry", {}), claims_digest: input.claims === null ? null : flowDigest("claims", input.claims), policy_version: GATE_POLICY_VERSION, decision: k.decision, rule: k.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? "P-OK" : "P-TEST HOLD",
        gate_refused: false, proof_states: { ...k.proofs }, balance_minor: input.balance_usd === null ? null : toMinor(input.balance_usd).toString(), evaluated_at_ms: input.now_ms, expires_at_ms: input.now_ms + GATE_TTL_MS,
      };
      const g: GateRecord = { ...rest, gate_digest: gateDigest(rest) };
      return k.mutate ? k.mutate(g) : g;
    },
    revalidate(record, input, phase) {
      k.revalidations.push(phase);
      if (k.throws) throw new Error("gate down");
      if (phase !== "submit" && input.now_ms >= record.expires_at_ms) return { ok: false, code: "GATE_EXPIRED" };
      if (k.revalidate) return { ok: false, code: k.revalidate };
      if (k.decision !== "ELIGIBLE_FOR_HUMAN_REVIEW" || !PROOF_IDS.every((p) => k.proofs[p] === "VERIFIED")) return { ok: false, code: "GATE_REEVALUATION_MISMATCH" };
      return { ok: true };
    },
  };
}

const ZERO = "0".repeat(64);
export type AuditKnobs = { failOnType: string | null };
/** A minimal AuditPort (section 10 shape) in its own table inside the flow store file. Not the product chain. */
export function fakeAudit(k: AuditKnobs): AuditPort {
  return {
    ddl: ["CREATE TABLE IF NOT EXISTS a3_test_audit (seq INTEGER PRIMARY KEY, flow_id TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL)"],
    append(tx: SqlTx, ev: FlowAuditInput): FlowAuditEvent {
      if (k.failOnType === ev.type) throw Object.assign(new Error("AUDIT_FIELD_REFUSED"), { code: "AUDIT_FIELD_REFUSED" });
      for (const key of Object.keys(ev.data)) if (/key|token|secret|password|passphrase|authorization|account_number|routing|iban|swift|bank/i.test(key)) throw Object.assign(new Error("AUDIT_FIELD_REFUSED"), { code: "AUDIT_FIELD_REFUSED" });
      const last = tx.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM a3_test_audit").get() as { n: number };
      const prevRow = tx.prepare("SELECT hash FROM a3_test_audit WHERE flow_id = ? ORDER BY seq DESC LIMIT 1").get(ev.flow_id) as { hash: string } | undefined;
      const rest = { ...ev, chain: "DB_INTEGRATED_FLOW_V1" as const, seq: Number(last.n) + 1, prev: prevRow?.hash ?? ZERO };
      const event: FlowAuditEvent = { ...rest, hash: flowDigest("audit_event", rest) };
      tx.prepare("INSERT INTO a3_test_audit (seq, flow_id, prev, hash, body) VALUES (?,?,?,?,?)").run(event.seq, event.flow_id, event.prev, event.hash, JSON.stringify(rest));
      return event;
    },
    verify(tx: SqlTx, flowId?: string) {
      const rows = tx.prepare("SELECT seq, flow_id, prev, hash, body FROM a3_test_audit ORDER BY seq").all() as { seq: number; flow_id: string; prev: string; hash: string; body: string }[];
      const heads = new Map<string, string>();
      let expected = 1, count = 0, head = ZERO;
      for (const r of rows) {
        if (Number(r.seq) !== expected++) return { ok: false as const, code: "AUDIT_CHAIN_BROKEN", at_seq: Number(r.seq) };
        let hash = "";
        try {
          hash = flowDigest("audit_event", JSON.parse(r.body));
        } catch { /* stays empty */ }
        if (hash !== r.hash || r.prev !== (heads.get(r.flow_id) ?? ZERO)) return { ok: false as const, code: "AUDIT_CHAIN_BROKEN", at_seq: Number(r.seq) };
        heads.set(r.flow_id, r.hash);
        if (flowId === undefined || r.flow_id === flowId) {
          count++;
          head = r.hash;
        }
      }
      return { ok: true as const, count, head };
    },
  };
}

export type LedgerKnobs = { fund: string | null; reduce: string | null; checks: number; reductions: { flow_id: string; idempotency_key: string; authorization_id: string }[] };
export function fakeLedger(k: LedgerKnobs): LedgerPort {
  return {
    async checkFunding() {
      k.checks++;
      return k.fund ? { ok: false, code: k.fund } : { ok: true, funding_check_version: `v${k.checks}`, available_minor: "100000" };
    },
    async postReduction(input) {
      k.reductions.push({ flow_id: input.flow_id, idempotency_key: input.idempotency_key, authorization_id: input.authorization_id });
      return k.reduce ? { ok: false, code: k.reduce } : { ok: true, reduction_event_id: `red-${k.reductions.length}`, reduced_at_ms: T0, replayed: false };
    },
  };
}

export type World = {
  dir: string; clock: { t: number }; gate: GateKnobs; audit: AuditKnobs; ledger: LedgerKnobs; provider: MockProvider;
  allowlist: Map<string, string>; proposalPatch: Partial<FlowProposal>; runs: Map<string, { evidence: string; claims: unknown }>;
  deps: FlowDeps; svc: FlowService;
  events(flowId: string): { type: string; data: Record<string, unknown>; to_state: string | null }[];
  types(flowId: string): string[];
  rec(flowId: string): FlowRecordV1;
};

/** Opens a world on `dir` (a new one by default). Calling it again on the same dir is a process restart: a new
 *  service, a new store handle, the same files. */
export function world(dir = mkdtempSync(join(tmpdir(), "dbflow-a3-")), o: { clock?: { t: number }; provider?: ProviderPort; providerMode?: "mock" | "sandbox"; ledger?: boolean; hooks?: FlowTestHooks; approvalKey?: Uint8Array; submitRelease?: string | null; dataDir?: string } = {}): World {
  const clock = o.clock ?? { t: T0 };
  const gate: GateKnobs = { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", proofs: allVerified(), revalidate: null, throws: false, mutate: null, evaluations: 0, revalidations: [] };
  const audit: AuditKnobs = { failOnType: null };
  const ledger: LedgerKnobs = { fund: null, reduce: null, checks: 0, reductions: [] };
  const provider = mockProvider({ stateFile: join(dir, "mock-provider.json") });
  const allowlist = new Map(MOCK_ALLOWLIST);
  const proposalPatch: Partial<FlowProposal> = {};
  const runs = new Map<string, { evidence: string; claims: unknown }>();
  const auditPort = fakeAudit(audit);
  const deps: FlowDeps = {
    approvalKey: o.approvalKey ?? TEST_APPROVAL_KEY,
    dataDir: o.dataDir ?? join(dir, "data"), providerMode: o.providerMode ?? "mock", submitRelease: o.submitRelease ?? null,
    gate: fakeGate(gate), provider: o.provider ?? provider, audit: auditPort, ledger: o.ledger ? fakeLedger(ledger) : null, registry: REGISTRY, allowlist,
    buildProposal: (caseId, flowId, providerRequestId, list) => {
      if (caseId !== CASE) return { ok: false, code: "UNKNOWN_CASE" };
      if (list.get(BEN) !== BEN_LABEL) return { ok: false, code: "BENEFICIARY_BINDING_UNRESOLVED" };
      return { ok: true, proposal: { flow_id: flowId, obligation_id: caseId, payee: "Prairie Test Concrete LLC", beneficiary_id: BEN, beneficiary_label: BEN_LABEL, amount_minor: "500", currency: "USD", reference: "DB-SBX-0002", transfer_method: "LOCAL", reason: "goods_purchased", provider_request_id: providerRequestId, ...proposalPatch } as FlowProposal };
    },
    replayEvidence: (documentId) => (documentId === DOC ? { text: EVIDENCE, facts: {} } : null),
    runLookup: (runId) => (runs.get(runId) as { evidence: string; claims: null } | undefined) ?? null,
    balanceUsd: async () => "10000000.00",
    ledgerAllocationFor: (caseId) => (caseId === CASE ? "ALLOC-SBX-0002" : null),
    now: () => clock.t, uuid: randomUUID,
  };
  const svc = createFlowService(deps, o.hooks ?? {});
  const events = (flowId: string) => {
    const f = join(deps.dataDir, "flow-v1.sqlite");
    if (!existsSync(f)) return [];
    const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(f);
    try {
      return (db.prepare("SELECT body FROM a3_test_audit WHERE flow_id = ? ORDER BY seq").all(flowId) as { body: string }[]).map((r) => JSON.parse(r.body));
    } finally {
      db.close();
    }
  };
  return { dir, clock, gate, audit, ledger, provider, allowlist, proposalPatch, runs, deps, svc, events, types: (id) => events(id).map((e) => e.type), rec: (id) => svc.getFlow(id)! };
}

export type Stage = "DRAFT" | "EVIDENCE_READY" | "GATE" | "AWAITING_HUMAN" | "HUMAN_APPROVED";
/** Drives a flow to a stage through the real service operations only. Returns the flow id. */
export async function drive(w: World, to: Stage): Promise<string> {
  const c = w.svc.createFlow(OPERATOR, CASE);
  if (!c.ok) throw new Error(`createFlow ${c.code}`);
  const id = c.flow_id!;
  if (to === "DRAFT") return id;
  const a = w.svc.attachEvidence(OPERATOR, id, { kind: "FIXTURE_REPLAY", document_id: DOC });
  if (!a.ok) throw new Error(`attachEvidence ${a.code}`);
  if (to === "EVIDENCE_READY") return id;
  await w.svc.evaluateGate(OPERATOR, id);
  if (to === "GATE") return id;
  const r = await w.svc.requestHumanReview(OPERATOR, id);
  if (!r.ok) throw new Error(`requestHumanReview ${r.code}`);
  if (to === "AWAITING_HUMAN") return id;
  const f = w.rec(id);
  const ap = await w.svc.approve(OPERATOR, id, f.proposal_digest, f.gate!.gate_digest);
  if (!ap.ok) throw new Error(`approve ${ap.code}`);
  return id;
}
export const submit = (w: World, id: string, actor = OPERATOR) => w.svc.submit(actor, id, w.rec(id).authorization?.authorization_digest);

/** Raw statement against the store file, for proving that the database itself refuses illegal writes. */
export function rawSql(w: World, sql: string): void {
  const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(join(w.deps.dataDir, "flow-v1.sqlite"));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
export const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
export { writeFileSync };
