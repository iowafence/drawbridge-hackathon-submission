// Reference model of flow-v1 behaviour. TEST ORACLE ONLY: it is not the product and proves nothing about the
// product. Its two jobs are (1) to show that every scenario in contract/scenarios.ts can be satisfied, and (2) with
// one safety rule deliberately removed (a "mutant"), to show that the scenarios notice. It uses the shipped
// deterministic gate (src/server/agentPolicy.ts) and the contract's own digest functions, and nothing else.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { approvalMac, approvalMacValid, flowDigest, proposalDigest, proposalProblem } from "../../../../integrated/flowCanonical.ts";
import { GATE_TTL_MS, INTENT_STALE_MS, PROVIDER_STATUS_TO_STATE } from "../../../../integrated/flowTypes.ts";
import type { FlowProposal, FlowState } from "../../../../integrated/flowTypes.ts";
import { claimsUsable, evaluate } from "../../../../src/server/agentPolicy.ts";
import type { Claims, Decision, ProofState } from "../../../../src/server/agentPolicy.ts";
import { reconcile as reconcileAmounts } from "../../../../src/server/agentRegistry.ts";
import type { Registry } from "../../../../src/server/agentRegistry.ts";
import { fromMinor, toMinor } from "../../../../src/server/policy.ts";
import { APPROVAL_TTL_MS } from "../../../../src/server/transfers.ts";
import { applyVariant, cooperativeClaims, E3_RESERVED_BENEFICIARY_ID, TEST_BINDINGS, testRegistry } from "../fixtures.ts";
import type { MockResponse, ProviderRecord } from "../mockProvider.ts";
import type { EvidenceInput, FlowPort, FlowSystem, ForgedMac, Outcome, TestView, World } from "../port.ts";

/** Each mutant removes exactly one safety rule. The self-check requires every one of them to be caught. */
export const MUTANTS = [
  "APPROVE_NON_ELIGIBLE", "SKIP_PROPOSAL_BINDING", "SKIP_DIGEST_CHECK", "SKIP_GATE_EXPIRY", "SKIP_APPROVAL_EXPIRY", "SKIP_REGISTRY_FRESHNESS",
  "SKIP_REEVALUATION", "SKIP_BENEFICIARY_RECHECK", "ANY_ACTOR_MAY_APPROVE", "ANY_HUMAN_MAY_SUBMIT", "SUBMIT_WITHOUT_APPROVAL", "GATE_REUSABLE",
  "SKIP_PROVIDER_VALIDATION", "NO_SINGLE_ATTEMPT_GUARD", "RETRY_AFTER_UNCERTAIN", "RESUBMIT_ON_RECOVERY", "ACCEPTANCE_IS_PAID", "TRUST_UNKNOWN_STATUS",
  "SKIP_RECORD_MATCH", "CREATE_ON_RECONCILE", "TERMINAL_NOT_FINAL", "SKIP_APPROVAL_MAC", "RETRY_AFTER_UNCERTAIN_LOOKUP_BYPASSED",
] as const;
export type Mutant = (typeof MUTANTS)[number];

type Gate = { decision: Decision; rule: string; proof_states: Record<string, ProofState>; registry_digest: string; evaluated_at_ms: number; expires_at_ms: number; gate_digest: string };
type Authorization = { operator_id: string; approved_at_ms: number; expires_at_ms: number; authorization_digest: string; mac: string | null };
type Flow = {
  flow_id: string; state: FlowState; version: number; proposal: FlowProposal; proposal_digest: string;
  evidence: { text: string; claims: Claims | null } | null; gate: Gate | null; gate_consumed: boolean;
  authorization: Authorization | null; attempt_id: string | null; attempt_recorded_at_ms: number | null;
  provider_transfer_id: string | null; create_reported_status: string | null; last_provider_status: string | null;
};
type Store = { flows: Record<string, Flow>; request_ids: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const no = (code: string): Outcome => ({ ok: false, code });
const yes = (code: string): Outcome => ({ ok: true, code });
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isHuman = (actor: unknown): actor is string => typeof actor === "string" && actor.startsWith("human:");

class ReferenceFlow implements FlowSystem {
  #w: World;
  #m: Mutant | null;
  #file: string;
  #lock: string;

  constructor(world: World, mutant: Mutant | null) {
    this.#w = world;
    this.#m = mutant;
    this.#file = join(world.dataDir, "reference_flows.json");
    this.#lock = join(world.dataDir, "reference_flows.lock");
  }

  /** One short, exclusive, durable read-modify-write. Never held across a provider call. */
  #tx<T>(fn: (s: Store) => T): T {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const fd = openSync(this.#lock, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch {
        let holder = NaN;
        try {
          holder = Number(readFileSync(this.#lock, "utf8"));
        } catch {
          // the lock vanished between the two calls; try again
        }
        let alive = true;
        if (Number.isInteger(holder) && holder > 0) {
          try {
            process.kill(holder, 0);
          } catch {
            alive = false;
          }
        }
        if (!alive) {
          try {
            unlinkSync(this.#lock);
          } catch {
            // another process already cleared it
          }
        } else if (Date.now() > deadline) throw new Error("REFERENCE_STORE_LOCKED");
        else pause(3);
      }
    }
    try {
      const s: Store = existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as Store) : { flows: {}, request_ids: [] };
      const out = fn(s);
      const tmp = `${this.#file}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      writeFileSync(fd, JSON.stringify(s));
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, this.#file);
      return out;
    } finally {
      unlinkSync(this.#lock);
    }
  }
  #move(f: Flow, state: FlowState): void {
    f.state = state;
    f.version += 1;
  }
  #registry(): Registry {
    return applyVariant(testRegistry(), this.#w.registryVariant());
  }

  /** flow-v1 §5 proposal construction: every field comes from the server's registry, binding and allowlist. */
  #buildProposal(case_id: unknown, flow_id: string, provider_request_id: string): FlowProposal | string {
    if (typeof case_id !== "string" || !Object.hasOwn(TEST_BINDINGS, case_id)) return "UNKNOWN_CASE";
    const o = testRegistry().obligations.find((x) => x.case_id === case_id);
    if (!o) return "UNKNOWN_CASE";
    const binding = TEST_BINDINGS[case_id];
    let beneficiary_id = E3_RESERVED_BENEFICIARY_ID;
    if (!binding.e3) {
      const hits = [...this.#w.beneficiaries()].filter(([, label]) => label === binding.beneficiary_label);
      if (hits.length !== 1) return "BENEFICIARY_BINDING_UNRESOLVED";
      beneficiary_id = hits[0][0];
    }
    const rec = reconcileAmounts(o);
    if (!rec.ok || rec.net <= 0n) return "OBLIGATION_NOT_RECONCILED";
    const p: FlowProposal = {
      flow_id, obligation_id: o.case_id, payee: o.payee, beneficiary_id, beneficiary_label: binding.beneficiary_label, amount_minor: rec.net.toString(),
      currency: "USD", reference: o.reference, transfer_method: "LOCAL", reason: binding.reason, provider_request_id,
    };
    return o.currency !== "USD" ? "CURRENCY_NOT_APPROVED" : (proposalProblem(p) ?? p);
  }

  #evaluate(f: Flow): { decision: Decision; rule: string; proof_states: Record<string, ProofState> } {
    const registry = this.#registry();
    const e = evaluate(f.evidence!.text, f.evidence!.claims, registry, this.#w.balanceUsd());
    const proof_states = Object.fromEntries(e.proofs.filter((p) => p.id !== "R").map((p) => [p.id, p.state]));
    if (this.#m === "SKIP_PROPOSAL_BINDING") return { decision: e.decision, rule: e.rule, proof_states };
    const o = registry.obligations.find((x) => x.case_id === f.proposal.obligation_id);
    const rec = o ? reconcileAmounts(o) : null;
    let bind: string | null = null;
    if (e.document.binding !== "REGISTERED_DOCUMENT") bind = "EVIDENCE_NOT_REGISTERED";
    else if (e.document.case_id !== f.proposal.obligation_id) bind = "EVIDENCE_FOR_ANOTHER_OBLIGATION";
    else if (!o || !rec || !rec.ok || o.reference !== f.proposal.reference || o.payee !== f.proposal.payee || o.currency !== f.proposal.currency || rec.net.toString() !== f.proposal.amount_minor) bind = "PROPOSAL_DIFFERS_FROM_REGISTRY";
    return bind ? { decision: "HOLD", rule: `P-BIND ${bind}`, proof_states } : { decision: e.decision, rule: e.rule, proof_states };
  }

  /** flow-v1 §5 revalidate. */
  #revalidate(f: Flow, phase: "review" | "approve" | "submit"): string | null {
    const g = f.gate!;
    if (phase !== "submit" && this.#m !== "SKIP_GATE_EXPIRY" && this.#w.now() >= g.expires_at_ms) return "GATE_EXPIRED";
    if (g.decision !== "ELIGIBLE_FOR_HUMAN_REVIEW" && this.#m !== "APPROVE_NON_ELIGIBLE") return "GATE_NOT_ELIGIBLE";
    if (this.#m !== "SKIP_REGISTRY_FRESHNESS" && flowDigest("registry", this.#registry()) !== g.registry_digest) return "REGISTRY_DRIFT";
    if (this.#m !== "SKIP_REEVALUATION" && this.#m !== "APPROVE_NON_ELIGIBLE") {
      const again = this.#evaluate(f);
      if (again.decision !== "ELIGIBLE_FOR_HUMAN_REVIEW" || JSON.stringify(again.proof_states) !== JSON.stringify(g.proof_states)) return "GATE_REEVALUATION_MISMATCH";
    }
    if (this.#m !== "SKIP_BENEFICIARY_RECHECK" && this.#w.beneficiaries().get(f.proposal.beneficiary_id) !== f.proposal.beneficiary_label) return "BENEFICIARY_NOT_ALLOWLISTED";
    return null;
  }

  async prepare(actor: string, case_id: unknown, evidence: EvidenceInput): Promise<Outcome & { flow_id?: string }> {
    if (!isHuman(actor)) return no("HUMAN_OPERATOR_REQUIRED");
    const flow_id = this.#w.uuid();
    const built = this.#buildProposal(case_id, flow_id, this.#w.uuid());
    if (typeof built === "string") return no(built);
    const created = this.#tx((s) => {
      if (s.flows[flow_id] || s.request_ids.includes(built.provider_request_id)) return false;
      s.flows[flow_id] = {
        flow_id, state: "DRAFT", version: 1, proposal: built, proposal_digest: proposalDigest(built), evidence: null, gate: null, gate_consumed: false,
        authorization: null, attempt_id: null, attempt_recorded_at_ms: null, provider_transfer_id: null, create_reported_status: null, last_provider_status: null,
      };
      s.request_ids.push(built.provider_request_id);
      return true;
    });
    if (!created) return no("DUPLICATE_FLOW_OR_REQUEST_ID");
    // attach_evidence: the server holds the text and the claims from here on
    let held: { text: string; claims: Claims | null } | null = null;
    if (evidence.kind === "REPLAY") {
      const owner = testRegistry().obligations.find((o) => o.registered_documents.some((d) => d.document_id === evidence.document_id));
      if (owner) held = { text: owner.registered_documents.find((d) => d.document_id === evidence.document_id)!.text, claims: cooperativeClaims(owner) };
    } else if (typeof evidence.evidence === "string" && (evidence.claims === null || claimsUsable(evidence.claims))) held = { text: evidence.evidence, claims: evidence.claims };
    if (!held) return { ...no("EVIDENCE_UNAVAILABLE"), flow_id };
    return this.#tx((s) => {
      const f = s.flows[flow_id];
      f.evidence = held;
      this.#move(f, "EVIDENCE_READY");
      const e = this.#evaluate(f);
      const now = this.#w.now();
      const registry_digest = flowDigest("registry", this.#registry());
      const body = { flow_id, proposal_digest: f.proposal_digest, decision: e.decision, rule: e.rule, proof_states: e.proof_states, registry_digest, evaluated_at_ms: now, expires_at_ms: now + GATE_TTL_MS };
      f.gate = { ...body, gate_digest: flowDigest("gate", body) };
      this.#move(f, e.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? "GATE_ELIGIBLE" : e.decision === "REVIEW" ? "GATE_REVIEW" : "GATE_HOLD");
      if (f.state !== "GATE_ELIGIBLE") return { ...no(`GATE_${e.decision}`), flow_id };
      const bad = this.#revalidate(f, "review");
      if (bad) return { ...no(bad), flow_id };
      this.#move(f, "AWAITING_HUMAN");
      return { ...yes("AWAITING_HUMAN"), flow_id };
    });
  }

  /** Read-only provider guard (A8-09 design): refuse unless the provider confirms it holds no record for this flow's
   *  request id. Asked after every local check has passed, once at approve and once at submit. Never a create. */
  async #providerHoldsRecord(flow_id: unknown): Promise<string | null> {
    const rid = this.#tx((s) => (typeof flow_id === "string" && Object.hasOwn(s.flows, flow_id) ? s.flows[flow_id].proposal.provider_request_id : null));
    if (rid === null) return "UNKNOWN_FLOW";
    // TEST-ONLY mutant of this oracle (never of the product): the lookup guard is bypassed entirely, so the only
    // thing left between an uncertain create and a retry is the no-retry rule, which the same mutant also removes.
    if (this.#m === "RETRY_AFTER_UNCERTAIN_LOOKUP_BYPASSED") return null;
    let res: MockResponse;
    try {
      res = await this.#w.provider.findByRequestId(rid);
    } catch {
      return "PROVIDER_LOOKUP_FAILED";
    }
    const b = res.body as { items?: Partial<ProviderRecord>[]; has_more?: unknown } | null;
    if (res.status !== 200 || !b || !Array.isArray(b.items) || b.has_more !== false) return "PROVIDER_LOOKUP_FAILED";
    return b.items.some((r) => r.request_id === rid) ? "PROVIDER_RECORD_EXISTS" : null;
  }

  async approve(actor: string, flow_id: unknown, shownProposalDigest: unknown, shownGateDigest: unknown): Promise<Outcome> {
    // every local check first (without committing), then the provider lookup, then the same checks again with the commit
    const local = this.#approveTx(actor, flow_id, shownProposalDigest, shownGateDigest, false);
    if (!local.ok) return local;
    const held = await this.#providerHoldsRecord(flow_id);
    if (held) return no(held);
    return this.#approveTx(actor, flow_id, shownProposalDigest, shownGateDigest, true);
  }

  #approveTx(actor: string, flow_id: unknown, shownProposalDigest: unknown, shownGateDigest: unknown, commit: boolean): Outcome {
    return this.#tx((s) => {
      const f = typeof flow_id === "string" && Object.hasOwn(s.flows, flow_id) ? s.flows[flow_id] : null;
      if (!f) return no("UNKNOWN_FLOW");
      if (!isHuman(actor) && this.#m !== "ANY_ACTOR_MAY_APPROVE") return no("HUMAN_OPERATOR_REQUIRED");
      const open = f.state === "AWAITING_HUMAN" || (this.#m === "APPROVE_NON_ELIGIBLE" && (f.state === "GATE_HOLD" || f.state === "GATE_REVIEW")) || (this.#m === "GATE_REUSABLE" && f.state === "HUMAN_APPROVED");
      if (!open || !f.gate) return no("WRONG_STATE");
      if (this.#m !== "SKIP_GATE_EXPIRY" && this.#w.now() >= f.gate.expires_at_ms) {
        this.#move(f, "EXPIRED");
        return no("GATE_EXPIRED");
      }
      if (this.#m !== "SKIP_DIGEST_CHECK" && (shownProposalDigest !== f.proposal_digest || shownGateDigest !== f.gate.gate_digest)) return no("SHOWN_DIGEST_MISMATCH");
      const bad = this.#revalidate(f, "approve");
      if (bad) return no(bad);
      if (f.gate_consumed && this.#m !== "GATE_REUSABLE") return no("GATE_ALREADY_CONSUMED");
      if (!commit) return yes("LOCAL_CHECKS_PASSED");
      const now = this.#w.now();
      const body = { flow_id: f.flow_id, proposal_digest: f.proposal_digest, gate_digest: f.gate.gate_digest, operator_id: String(actor), approved_at_ms: now, expires_at_ms: now + APPROVAL_TTL_MS, flow_version: f.version };
      const authorization_digest = flowDigest("authorization", body);
      // §16 R11: the approval carries a MAC under the server's in-memory key, outside the record and its digest
      f.authorization = { operator_id: body.operator_id, approved_at_ms: now, expires_at_ms: body.expires_at_ms, authorization_digest, mac: approvalMac(this.#w.approvalKey(), authorization_digest) };
      f.gate_consumed = true;
      this.#move(f, "HUMAN_APPROVED");
      return yes("HUMAN_APPROVED");
    });
  }

  async reject(actor: string, flow_id: unknown, shownProposalDigest: unknown): Promise<Outcome> {
    return this.#tx((s) => {
      const f = typeof flow_id === "string" && Object.hasOwn(s.flows, flow_id) ? s.flows[flow_id] : null;
      if (!f) return no("UNKNOWN_FLOW");
      if (!isHuman(actor)) return no("HUMAN_OPERATOR_REQUIRED");
      if (f.state !== "AWAITING_HUMAN") return no("WRONG_STATE");
      if (shownProposalDigest !== f.proposal_digest) return no("SHOWN_DIGEST_MISMATCH");
      this.#move(f, "HUMAN_REJECTED");
      return yes("HUMAN_REJECTED");
    });
  }

  async forgeApproval(flow_id: string, operator: string, forged: ForgedMac): Promise<string> {
    return this.#tx((s) => {
      const f = s.flows[flow_id];
      if (!f || f.state !== "AWAITING_HUMAN" || !f.gate) throw new Error("FORGERY_FIXTURE_NEEDS_AWAITING_HUMAN");
      const now = this.#w.now();
      const body = { flow_id: f.flow_id, proposal_digest: f.proposal_digest, gate_digest: f.gate.gate_digest, operator_id: operator, approved_at_ms: now, expires_at_ms: now + APPROVAL_TTL_MS, flow_version: f.version };
      const authorization_digest = flowDigest("authorization", body);
      const mac = forged.kind === "RANDOM" ? randomBytes(32).toString("hex") : forged.kind === "OTHER_KEY" ? approvalMac(randomBytes(32), authorization_digest) : (s.flows[forged.flow_id]?.authorization?.mac ?? null);
      if (mac === null) throw new Error("FORGERY_FIXTURE_NEEDS_A_GENUINE_APPROVAL_TO_COPY");
      f.authorization = { operator_id: operator, approved_at_ms: now, expires_at_ms: body.expires_at_ms, authorization_digest, mac };
      f.gate_consumed = true;
      this.#move(f, "HUMAN_APPROVED");
      return f.authorization.authorization_digest;
    });
  }

  #body(p: FlowProposal): Record<string, string> {
    return { beneficiary_id: p.beneficiary_id, transfer_amount: fromMinor(BigInt(p.amount_minor)), transfer_currency: p.currency, source_currency: p.currency, transfer_method: p.transfer_method, reason: p.reason, reference: p.reference, request_id: p.provider_request_id };
  }

  async submit(actor: string, flow_id: unknown, shownAuthorizationDigest: unknown): Promise<Outcome> {
    const checked = this.#tx((s): Outcome | Flow => {
      const f = typeof flow_id === "string" && Object.hasOwn(s.flows, flow_id) ? s.flows[flow_id] : null;
      if (!f) return no("UNKNOWN_FLOW");
      if (!isHuman(actor)) return no("HUMAN_OPERATOR_REQUIRED");
      const again = (this.#m === "RETRY_AFTER_UNCERTAIN" || this.#m === "RETRY_AFTER_UNCERTAIN_LOOKUP_BYPASSED") && f.state === "SUBMISSION_UNCERTAIN";
      const unapproved = this.#m === "SUBMIT_WITHOUT_APPROVAL" && f.state === "AWAITING_HUMAN";
      if (unapproved) return structuredClone(f);
      if ((f.state !== "HUMAN_APPROVED" && !again) || !f.authorization) return no(f.attempt_id ? "DUPLICATE_SUBMISSION" : "WRONG_STATE");
      if (actor !== f.authorization.operator_id && this.#m !== "ANY_HUMAN_MAY_SUBMIT") return no("OPERATOR_MISMATCH");
      if (!again && this.#m !== "SKIP_APPROVAL_EXPIRY" && this.#w.now() >= f.authorization.expires_at_ms) {
        this.#move(f, "EXPIRED");
        return no("AUTHORIZATION_EXPIRED");
      }
      if (this.#m !== "SKIP_DIGEST_CHECK" && shownAuthorizationDigest !== f.authorization.authorization_digest) return no("SHOWN_DIGEST_MISMATCH");
      if (this.#m !== "SKIP_APPROVAL_MAC" && !approvalMacValid(this.#w.approvalKey(), f.authorization.authorization_digest, f.authorization.mac)) return no("AUTHORIZATION_NOT_SERVER_ISSUED");
      const bad = this.#revalidate(f, "submit");
      return bad ? no(bad) : structuredClone(f);
    });
    if (!("flow_id" in checked)) return checked;
    // 0. the read-only provider lookup, after every local check and before anything is asked of the provider's write side
    const held = await this.#providerHoldsRecord(checked.flow_id);
    if (held) return no(held);
    // 1. validate (creates nothing); anything but 200 leaves the flow approved and sends nothing
    if (this.#m !== "SKIP_PROVIDER_VALIDATION") {
      try {
        if ((await this.#w.provider.validate(this.#body(checked.proposal))).status !== 200) return no("PROVIDER_VALIDATION_FAILED");
      } catch {
        return no("PROVIDER_VALIDATION_FAILED");
      }
    }
    // 2. commit the intent, compare-and-swap on state and version, BEFORE any create
    const intent = this.#tx((s) => {
      const f = s.flows[checked.flow_id];
      if (this.#m === "NO_SINGLE_ATTEMPT_GUARD") {
        f.attempt_id = randomUUID();
        return true;
      }
      if (f.state !== checked.state || f.version !== checked.version) return false;
      f.attempt_id = randomUUID();
      f.attempt_recorded_at_ms = this.#w.now();
      this.#move(f, "SUBMIT_INTENT_RECORDED");
      return true;
    });
    if (!intent) return no("CONCURRENT_MODIFICATION");
    // 2b. asked once more with the intent on record, immediately before the create. A refusal here leaves the intent
    //     in place: the flow is uncertain and only a read-back can move it. Nothing is sent.
    const late = await this.#providerHoldsRecord(checked.flow_id);
    if (late) {
      this.#tx((s) => this.#move(s.flows[checked.flow_id], "SUBMISSION_UNCERTAIN"));
      return no(late);
    }
    return this.#create(checked);
  }

  /** 3. the single create call, and 4. classification of its outcome. */
  async #create(f: Flow): Promise<Outcome> {
    const settle = (state: FlowState, patch: Partial<Flow>, out: Outcome): Outcome =>
      this.#tx((s) => {
        Object.assign(s.flows[f.flow_id], patch);
        this.#move(s.flows[f.flow_id], state);
        return out;
      });
    let res: MockResponse;
    try {
      res = await this.#w.provider.create(this.#body(f.proposal));
    } catch {
      return settle("SUBMISSION_UNCERTAIN", {}, no("SUBMISSION_UNCERTAIN"));
    }
    const b = res.body as (Partial<ProviderRecord> & { code?: string }) | null;
    if ((res.status === 200 || res.status === 201) && b && typeof b.id === "string" && UUID.test(b.id) && typeof b.status === "string" && Object.hasOwn(PROVIDER_STATUS_TO_STATE, b.status) && b.request_id === f.proposal.provider_request_id) {
      if (this.#m === "ACCEPTANCE_IS_PAID") return settle("PROVIDER_PAID", { provider_transfer_id: b.id, create_reported_status: b.status, last_provider_status: "PAID" }, yes("PROVIDER_PAID"));
      return settle("SUBMITTED", { provider_transfer_id: b.id, create_reported_status: b.status }, yes("SUBMITTED"));
    }
    if ([400, 401, 403, 404, 422].includes(res.status) && b?.code !== "request_id_duplicate") return settle("PROVIDER_REFUSED", {}, no("PROVIDER_REFUSED"));
    return settle("SUBMISSION_UNCERTAIN", {}, no("SUBMISSION_UNCERTAIN"));
  }

  async reconcile(_actor: string, flow_id: unknown): Promise<Outcome> {
    const f = this.#tx((s) => {
      const cur = typeof flow_id === "string" && Object.hasOwn(s.flows, flow_id) ? s.flows[flow_id] : null;
      if (cur && cur.state === "SUBMIT_INTENT_RECORDED" && this.#m !== "RESUBMIT_ON_RECOVERY" && this.#w.now() - (cur.attempt_recorded_at_ms ?? 0) >= INTENT_STALE_MS) this.#move(cur, "SUBMISSION_UNCERTAIN");
      return cur ? structuredClone(cur) : null;
    });
    if (!f) return no("UNKNOWN_FLOW");
    if (f.state === "SUBMIT_INTENT_RECORDED") return this.#m === "RESUBMIT_ON_RECOVERY" ? this.#create(f) : no("SUBMISSION_IN_FLIGHT");
    if (this.#m === "CREATE_ON_RECONCILE" && f.state === "SUBMISSION_UNCERTAIN") return this.#create(f);
    if (!["SUBMITTED", "SUBMISSION_UNCERTAIN", "PROVIDER_SCHEDULED", "PROVIDER_PROCESSING", "PROVIDER_FAILED", "PROVIDER_PAID"].includes(f.state)) return no("WRONG_STATE");
    let res: MockResponse;
    try {
      res = f.provider_transfer_id ? await this.#w.provider.getById(f.provider_transfer_id) : await this.#w.provider.findByRequestId(f.proposal.provider_request_id);
    } catch {
      return no("RECONCILE_TRANSPORT_ERROR");
    }
    if (res.status !== 200) return no("RECONCILE_HTTP_STATUS");
    let rec = res.body as Partial<ProviderRecord> | null;
    if (!f.provider_transfer_id) {
      const items = ((res.body as { items?: Partial<ProviderRecord>[] } | null)?.items ?? []).filter((r) => this.#m === "SKIP_RECORD_MATCH" || r.request_id === f.proposal.provider_request_id);
      if (items.length !== 1) return no(items.length ? "PROVIDER_HAS_MULTIPLE_RECORDS" : "PROVIDER_HAS_NO_RECORD");
      rec = items[0];
    }
    if (!rec || typeof rec.id !== "string" || typeof rec.status !== "string") return no("UNRECOGNIZED_PROVIDER_RESPONSE");
    if (this.#m !== "SKIP_RECORD_MATCH") {
      let amountOk = false;
      try {
        amountOk = toMinor(String(rec.transfer_amount)).toString() === f.proposal.amount_minor;
      } catch {
        amountOk = false;
      }
      if (rec.request_id !== f.proposal.provider_request_id || rec.transfer_currency !== f.proposal.currency || !amountOk || (f.provider_transfer_id && rec.id !== f.provider_transfer_id)) return no("PROVIDER_RECORD_MISMATCH");
    }
    const target: FlowState | null = Object.hasOwn(PROVIDER_STATUS_TO_STATE, rec.status) ? PROVIDER_STATUS_TO_STATE[rec.status] : this.#m === "TRUST_UNKNOWN_STATUS" ? "PROVIDER_PAID" : null;
    if (!target) return no("UNRECOGNIZED_PROVIDER_STATUS");
    const terminal = f.state === "PROVIDER_FAILED" || f.state === "PROVIDER_PAID";
    if (terminal && this.#m !== "TERMINAL_NOT_FINAL") return target === f.state ? yes(target) : no("PROVIDER_STATUS_REGRESSION");
    return this.#tx((s) => {
      const cur = s.flows[f.flow_id];
      cur.provider_transfer_id = rec.id as string;
      cur.last_provider_status = rec.status as string;
      this.#move(cur, target);
      return yes(target);
    });
  }

  async read(flow_id: unknown): Promise<TestView | null> {
    const f = this.#tx((s) => (typeof flow_id === "string" && Object.hasOwn(s.flows, flow_id) ? structuredClone(s.flows[flow_id]) : null));
    if (!f) return null;
    return {
      flow_id: f.flow_id, state: f.state, version: f.version, gate_decision: f.gate?.decision ?? null, proof_states: f.gate?.proof_states ?? null, proposal: f.proposal,
      proposal_digest: f.proposal_digest, gate_digest: f.gate?.gate_digest ?? null, authorization_digest: f.authorization?.authorization_digest ?? null, attempt_id: f.attempt_id,
      provider_transfer_id: f.provider_transfer_id, create_reported_status: f.create_reported_status, last_provider_status: f.last_provider_status,
      claims_settled: f.state === "PROVIDER_PAID" || f.last_provider_status === "PAID", audit_verified: null,
    };
  }
}

export function referencePort(mutant: Mutant | null = null): FlowPort {
  return { name: mutant ? `reference+${mutant}` : "reference", baseRegistry: testRegistry, open: async (world) => new ReferenceFlow(world, mutant) };
}
