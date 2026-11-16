// The black-box surface the flow-v1 scenarios drive. TEST CODE ONLY.
//
// The scenarios in ../contract/scenarios.ts never import an implementation. They talk to a FlowPort. Two exist:
//   - reference/referenceFlow.ts  a test oracle, used only to prove the scenarios themselves work (self-check)
//   - adapter/realPort.ts         the binding to the merged modules through their public exports
//                                 (createFlowService, gatePort, buildProposal, replayEvidence, auditPort)
// `prepare` stands for the operator steps before the human decision: createFlow, attachEvidence, evaluateGate and,
// when the gate is eligible, requestHumanReview.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FlowProposal, FlowState } from "../../../integrated/flowTypes.ts";
import type { Claims, Decision, ProofState } from "../../../src/server/agentPolicy.ts";
import type { Registry } from "../../../src/server/agentRegistry.ts";
import { MockProvider } from "./mockProvider.ts";
import type { RegistryVariant } from "./fixtures.ts";

export type { FlowProposal, FlowState };

/** States from which no provider create can have been attempted. */
export const BEFORE_INTENT: readonly FlowState[] = ["DRAFT", "EVIDENCE_READY", "GATE_HOLD", "GATE_REVIEW", "GATE_ELIGIBLE", "AWAITING_HUMAN", "HUMAN_APPROVED", "HUMAN_REJECTED", "EXPIRED"];

export type EvidenceInput =
  /** A registered document replayed from the trusted fixture (flow-v1 FIXTURE_REPLAY). */
  | { kind: "REPLAY"; document_id: string }
  /** What an agent run produced: UNTRUSTED text and UNTRUSTED model claims (flow-v1 AGENT_RUN). */
  | { kind: "RUN"; evidence: string; claims: Claims | null };

export type Outcome = { ok: boolean; code: string };

/** The approval MAC a store writer without the server key can plant. */
export type ForgedMac =
  /** 64 random lower-case hex characters. */
  | { kind: "RANDOM" }
  /** The genuine MAC of another flow's genuine approval, copied out of the store. */
  | { kind: "COPIED_FROM"; flow_id: string }
  /** A correctly computed MAC for THIS authorization digest, under a key that is not the server's. */
  | { kind: "OTHER_KEY" };

export type TestView = {
  flow_id: string;
  state: FlowState;
  version: number;
  gate_decision: Decision | null;
  proof_states: Record<string, ProofState> | null;
  proposal: FlowProposal;
  proposal_digest: string;
  gate_digest: string | null;
  authorization_digest: string | null;
  attempt_id: string | null;
  provider_transfer_id: string | null;
  /** What the create RESPONSE said. Never a settlement fact. */
  create_reported_status: string | null;
  /** The last status a matching provider READ returned, verbatim. */
  last_provider_status: string | null;
  /** True if the system presents this flow as paid or settled anywhere (record or read model). */
  claims_settled: boolean;
  /** Whether the flow's audit chain verifies. Null when the port cannot say. */
  audit_verified: boolean | null;
};

export interface FlowSystem {
  prepare(actor: string, case_id: unknown, evidence: EvidenceInput): Promise<Outcome & { flow_id?: string }>;
  approve(actor: string, flow_id: unknown, shownProposalDigest: unknown, shownGateDigest: unknown): Promise<Outcome>;
  reject(actor: string, flow_id: unknown, shownProposalDigest: unknown): Promise<Outcome>;
  submit(actor: string, flow_id: unknown, shownAuthorizationDigest: unknown): Promise<Outcome>;
  /** ATTACKER SIMULATION, not an operator action: someone who can write the durable store directly (bypassing its
   *  integrity triggers) plants a self-consistent authorization by `operator` on a flow that is awaiting a human, and
   *  marks it HUMAN_APPROVED. No approval was ever issued by the server. The writer cannot know the server's approval
   *  key, so the MAC it plants is one of the things it CAN produce (see ForgedMac). Returns the planted digest. */
  forgeApproval(flow_id: string, operator: string, mac: ForgedMac): Promise<string>;
  /** Read-only provider read-back. Never creates anything. */
  reconcile(actor: string, flow_id: unknown): Promise<Outcome>;
  read(flow_id: unknown): Promise<TestView | null>;
}

export interface FlowPort {
  readonly name: string;
  /** The trusted registry this port evaluates against when nothing has drifted. Fixture variants are applied to it. */
  baseRegistry(): Registry;
  /** Open (or re-open after a restart) the system over the world's durable data directory. */
  open(world: World): Promise<FlowSystem>;
}

type WorldState = { t: number; registryVariant: RegistryVariant; balanceUsd: string | null; beneficiaries: [string, string][]; fixedUuid: string | null; approvalKeyHex?: string };

/** Everything outside the system under test: clock, registry version, sandbox balance, beneficiary allowlist, id
 *  source and the mock provider. Settings live in the test's own temp directory so a child process sees them too. */
export class World {
  readonly dir: string;
  readonly dataDir: string;
  readonly provider: MockProvider;
  #file: string;

  constructor(dir: string, initial?: WorldState) {
    this.dir = dir;
    this.dataDir = join(dir, "data");
    this.#file = join(dir, "world.json");
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    if (initial) this.#write({ approvalKeyHex: randomBytes(32).toString("hex"), ...initial });
    else if (!existsSync(this.#file)) throw new Error("WORLD_NOT_INITIALISED");
    this.provider = new MockProvider(dir);
  }

  #read(): WorldState {
    return JSON.parse(readFileSync(this.#file, "utf8")) as WorldState;
  }
  #write(s: WorldState): void {
    const tmp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
  set(patch: Partial<WorldState>): void {
    this.#write({ ...this.#read(), ...patch });
  }
  now = (): number => this.#read().t;
  advance(ms: number): void {
    this.set({ t: this.#read().t + ms });
  }
  registryVariant = (): RegistryVariant => this.#read().registryVariant;
  balanceUsd = (): string | null => this.#read().balanceUsd;
  /** beneficiary_id -> label. Only these sandbox test beneficiaries may ever be paid. */
  beneficiaries = (): Map<string, string> => new Map(this.#read().beneficiaries);
  /** The server's in-memory approval key (flow-v1 §16 R11). In production it is generated once per process and never
   *  persisted. Here it is a per-test fixture, held in the test's private directory, so that the child processes that
   *  stand for ONE server (races, a crash inside the provider call) share it. A real restart is `rotateApprovalKey`. */
  approvalKey = (): Uint8Array => Buffer.from(this.#read().approvalKeyHex ?? "", "hex");
  /** What a process restart does to the key: the old one is gone for good. */
  rotateApprovalKey(): void {
    this.set({ approvalKeyHex: randomBytes(32).toString("hex") });
  }
  /** Id source handed to the system. `fixedUuid` makes it repeat one value, to test id reuse. */
  uuid = (): string => this.#read().fixedUuid ?? randomUUID();
}
