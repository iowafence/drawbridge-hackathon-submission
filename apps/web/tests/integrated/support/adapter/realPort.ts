// Binds the scenarios to the MERGED implementation through its public exports only (flow-v1 §12). TEST CODE ONLY.
//
//   integrated/flowService.ts      createFlowService(deps: FlowDeps): FlowService            (flow lane)
//   integrated/gateBinding.ts      gatePort                                                   (gate lane)
//   integrated/proposalBuilder.ts  buildProposal, replayEvidence, INTEGRATED_REGISTRY         (gate lane)
//   integrated/auditChain.ts       auditPort                                                  (audit lane, optional here)
//
// The provider is this suite's own MockProvider wrapped as a flow-v1 ProviderPort; no implementation mock is used.
// Until the modules are merged, loadRealPort() reports why, and every conformance test is SKIPPED. A skip is not a
// pass. If the modules are present but a required export is missing, that is reported as broken, which FAILS.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approvalMac, authorizationDigest } from "../../../../integrated/flowCanonical.ts";
import type { AuditPort, EvidenceRef, FlowDeps, FlowProposal, FlowService, GatePort, ProviderCallResult, ProviderPort, ProviderTransferBody } from "../../../../integrated/flowTypes.ts";
import type { Claims } from "../../../../src/server/agentPolicy.ts";
import type { Registry } from "../../../../src/server/agentRegistry.ts";
import { APPROVAL_TTL_MS } from "../../../../src/server/transfers.ts";
import { applyVariant } from "../fixtures.ts";
import { MockNetworkError } from "../mockProvider.ts";
import type { MockResponse } from "../mockProvider.ts";
import type { EvidenceInput, FlowPort, FlowSystem, ForgedMac, Outcome, TestView, World } from "../port.ts";
import { testAuditPort } from "../testAuditPort.ts";

const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const REQUIRED = ["integrated/flowService.ts", "integrated/gateBinding.ts", "integrated/proposalBuilder.ts"];
const AUDIT = "integrated/auditChain.ts";

export type RealPort = { port: FlowPort | null; reason: string; broken: boolean; audit: "audit lane auditPort" | "A4 test AuditPort" | null };

type BuildProposal = FlowDeps["buildProposal"];
type Modules = { createFlowService: (deps: FlowDeps) => FlowService; gatePort: GatePort; buildProposal: BuildProposal; replayEvidence: FlowDeps["replayEvidence"]; registry: Registry; audit: AuditPort };

const load = async (rel: string): Promise<Record<string, unknown>> => (await import(pathToFileURL(join(webRoot, rel)).href)) as Record<string, unknown>;

export async function loadRealPort(): Promise<RealPort> {
  const missing = REQUIRED.filter((f) => !existsSync(join(webRoot, f)));
  if (missing.length) return { port: null, broken: false, audit: null, reason: `not merged in this checkout: ${missing.join(", ")}` };
  const [svc, gate, builder] = await Promise.all(REQUIRED.map(load));
  const hasAudit = existsSync(join(webRoot, AUDIT));
  const auditMod = hasAudit ? await load(AUDIT) : null;
  const absent = [
    typeof svc.createFlowService !== "function" && "flowService.createFlowService", !gate.gatePort && "gateBinding.gatePort", typeof builder.buildProposal !== "function" && "proposalBuilder.buildProposal",
    typeof builder.replayEvidence !== "function" && "proposalBuilder.replayEvidence", !builder.INTEGRATED_REGISTRY && "proposalBuilder.INTEGRATED_REGISTRY", hasAudit && !auditMod?.auditPort && "auditChain.auditPort",
  ].filter(Boolean);
  if (absent.length) return { port: null, broken: true, audit: null, reason: `modules are present but these flow-v1 exports are missing: ${absent.join(", ")}` };
  const m: Modules = {
    createFlowService: svc.createFlowService as Modules["createFlowService"], gatePort: gate.gatePort as GatePort, buildProposal: builder.buildProposal as BuildProposal,
    replayEvidence: builder.replayEvidence as FlowDeps["replayEvidence"], registry: builder.INTEGRATED_REGISTRY as Registry, audit: (auditMod?.auditPort as AuditPort | undefined) ?? testAuditPort,
  };
  return {
    broken: false, reason: "", audit: hasAudit ? "audit lane auditPort" : "A4 test AuditPort",
    port: { name: "implementation", baseRegistry: () => structuredClone(m.registry) as Registry, open: async (world) => new Bound(world, m) },
  };
}

/** The suite's mock provider behind the flow-v1 ProviderPort. A mock network error becomes a transport error. */
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

type Runs = Record<string, { evidence: string; claims: Claims | null }>;

class Bound implements FlowSystem {
  #w: World;
  #m: Modules;
  #runs: string;
  #cache: { key: string; svc: FlowService } | null = null;

  constructor(world: World, m: Modules) {
    this.#w = world;
    this.#m = m;
    this.#runs = join(world.dir, "agent_runs.json");
  }

  #readRuns(): Runs {
    return existsSync(this.#runs) ? (JSON.parse(readFileSync(this.#runs, "utf8")) as Runs) : {};
  }
  /** The service for the world as it is now. A new one is built when the registry version or allowlist changed,
   *  which is what a server restart over a changed registry looks like from outside. */
  #svc(): FlowService {
    const allowlist = this.#w.beneficiaries();
    const variant = this.#w.registryVariant();
    const approvalKey = this.#w.approvalKey();
    const key = JSON.stringify([variant, [...allowlist], Buffer.from(approvalKey).toString("hex")]);
    if (this.#cache?.key === key) return this.#cache.svc;
    const deps: FlowDeps = {
      approvalKey, dataDir: this.#w.dataDir, providerMode: "mock", submitRelease: null, gate: this.#m.gatePort, provider: providerPort(this.#w), audit: this.#m.audit, ledger: null,
      registry: applyVariant(this.#m.registry, variant), allowlist, buildProposal: this.#m.buildProposal, replayEvidence: this.#m.replayEvidence,
      runLookup: (runId: string) => (Object.hasOwn(this.#readRuns(), runId) ? this.#readRuns()[runId] : null),
      balanceUsd: async () => this.#w.balanceUsd(), ledgerAllocationFor: () => null, now: this.#w.now, uuid: this.#w.uuid,
    };
    this.#cache = { key, svc: this.#m.createFlowService(deps) };
    return this.#cache.svc;
  }

  async prepare(actor: string, case_id: unknown, evidence: EvidenceInput): Promise<Outcome & { flow_id?: string }> {
    const svc = this.#svc();
    const created = svc.createFlow(actor, case_id);
    if (!created.ok || !created.flow_id) return { ok: false, code: created.code, flow_id: created.flow_id };
    const flow_id = created.flow_id;
    let src: EvidenceRef;
    if (evidence.kind === "REPLAY") src = { kind: "FIXTURE_REPLAY", document_id: evidence.document_id };
    else {
      const run_id = randomUUID();
      const runs = { ...this.#readRuns(), [run_id]: { evidence: evidence.evidence, claims: evidence.claims } };
      const tmp = `${this.#runs}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(runs), { mode: 0o600 });
      renameSync(tmp, this.#runs);
      src = { kind: "AGENT_RUN", run_id };
    }
    const attached = svc.attachEvidence(actor, flow_id, src);
    if (!attached.ok) return { ok: false, code: attached.code, flow_id };
    const gate = await svc.evaluateGate(actor, flow_id);
    if (svc.getFlow(flow_id)?.state !== "GATE_ELIGIBLE") return { ok: false, code: gate.code, flow_id };
    const review = await svc.requestHumanReview(actor, flow_id);
    return { ok: review.ok && svc.getFlow(flow_id)?.state === "AWAITING_HUMAN", code: review.code, flow_id };
  }
  approve(actor: string, flow_id: unknown, shownProposalDigest: unknown, shownGateDigest: unknown): Promise<Outcome> {
    return this.#svc().approve(actor, flow_id, shownProposalDigest, shownGateDigest);
  }
  async reject(actor: string, flow_id: unknown, shownProposalDigest: unknown): Promise<Outcome> {
    return this.#svc().reject(actor, flow_id, shownProposalDigest);
  }
  /** Writes the store file directly with node:sqlite, the way an untrusted local writer would (§16, F-A7-01): the
   *  integrity triggers are dropped, a self-consistent authorization is inserted with an approval MAC the writer can
   *  produce without the server key, the flow is marked approved, and the triggers are put back. This is the ONLY place the suite goes beneath the public exports, and it only plants
   *  the attack; every assertion afterwards is made through the public flow service. */
  async forgeApproval(flow_id: string, operator: string, forged: ForgedMac): Promise<string> {
    const db = new DatabaseSync(join(this.#w.dataDir, "flow-v1.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const row = db.prepare("SELECT state, version, proposal_digest, gate_digest FROM flow WHERE flow_id = ?").get(flow_id) as { state: string; version: number; proposal_digest: string; gate_digest: string } | undefined;
      if (!row || row.state !== "AWAITING_HUMAN") throw new Error("FORGERY_FIXTURE_NEEDS_AWAITING_HUMAN");
      const now = this.#w.now();
      const body = { flow_id, proposal_digest: row.proposal_digest, gate_digest: row.gate_digest, operator_id: operator, approved_at_ms: now, expires_at_ms: now + APPROVAL_TTL_MS, flow_version: Number(row.version) };
      const record = { ...body, authorization_digest: authorizationDigest(body) };
      let mac: string;
      if (forged.kind === "RANDOM") mac = randomBytes(32).toString("hex");
      else if (forged.kind === "OTHER_KEY") mac = approvalMac(randomBytes(32), record.authorization_digest);
      else {
        const genuine = db.prepare("SELECT approval_mac FROM flow_authorization WHERE flow_id = ?").get(forged.flow_id) as { approval_mac: string } | undefined;
        if (!genuine) throw new Error("FORGERY_FIXTURE_NEEDS_A_GENUINE_APPROVAL_TO_COPY");
        mac = genuine.approval_mac;
      }
      const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; sql: string }[];
      db.exec("BEGIN IMMEDIATE");
      for (const t of triggers) db.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
      db.prepare("INSERT INTO flow_authorization (flow_id, gate_digest, authorization_digest, proposal_digest, operator_id, approved_at_ms, expires_at_ms, flow_version, approval_mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(flow_id, body.gate_digest, record.authorization_digest, body.proposal_digest, operator, now, body.expires_at_ms, body.flow_version, mac);
      db.prepare("UPDATE flow SET authorization_json = ?, gate_consumed_at_ms = ?, state = 'HUMAN_APPROVED', version = version + 1 WHERE flow_id = ?").run(JSON.stringify(record), now, flow_id);
      for (const t of triggers) db.exec(t.sql);
      db.exec("COMMIT");
      return record.authorization_digest;
    } finally {
      db.close();
    }
  }
  submit(actor: string, flow_id: unknown, shownAuthorizationDigest: unknown): Promise<Outcome> {
    return this.#svc().submit(actor, flow_id, shownAuthorizationDigest);
  }
  reconcile(actor: string, flow_id: unknown): Promise<Outcome> {
    return this.#svc().reconcile(actor, flow_id);
  }
  async read(flow_id: unknown): Promise<TestView | null> {
    const svc = this.#svc();
    const r = svc.getFlow(flow_id);
    if (!r) return null;
    const v = svc.getFlowView(flow_id);
    // the read model shown to the operator must agree with the durable record
    if (!v || v.state !== r.state || v.version !== r.version || v.submission.last_provider_status !== r.submission.last_provider_status) throw new Error("FLOW_VIEW_DISAGREES_WITH_RECORD");
    // the digests the read model echoes into forms are the server's own (§14 R7)
    if (v.echo.proposal_digest !== r.proposal_digest || v.echo.gate_digest !== (r.gate?.gate_digest ?? null) || v.echo.authorization_digest !== (r.authorization?.authorization_digest ?? null)) throw new Error("FLOW_VIEW_ECHO_DISAGREES_WITH_RECORD");
    const proposal: FlowProposal = r.proposal;
    return {
      flow_id: r.flow_id, state: r.state, version: r.version, gate_decision: r.gate?.decision ?? null, proof_states: r.gate?.proof_states ?? null, proposal, proposal_digest: r.proposal_digest,
      gate_digest: r.gate?.gate_digest ?? null, authorization_digest: r.authorization?.authorization_digest ?? null, attempt_id: r.submission.attempt_id, provider_transfer_id: r.submission.provider_transfer_id,
      create_reported_status: r.submission.create_reported_status, last_provider_status: r.submission.last_provider_status,
      claims_settled: r.state === "PROVIDER_PAID" || v.state === "PROVIDER_PAID" || r.submission.last_provider_status === "PAID" || v.submission.last_provider_status === "PAID",
      audit_verified: v.audit.verified,
    };
  }
}
