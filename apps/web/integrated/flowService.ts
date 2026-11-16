// DRAWBRIDGE integrated flow (contract flow-v1 sections 6 and 7): the flow service. OWNER: A3.
//
// createFlowService(deps) returns the only object that can move an integrated flow. Trust rules enforced here:
//   * No operation accepts a decision, a proof state, a gate record, an approval, a provider status or a paid flag
//     from its arguments. The caller supplies a case id, a flow id, an evidence reference (looked up server-side) and
//     the digests the operator was SHOWN, which are compared with the stored values and never stored.
//   * Eligibility comes only from the injected GatePort (the deterministic gate binding). Nothing here asks a
//     language system for anything, and nothing here is exposed as a tool.
//   * GATE_ELIGIBLE means eligible for HUMAN REVIEW. HUMAN_APPROVED is not a transfer. SUBMITTED is not settlement.
//     PROVIDER_PAID is written only from a provider READ that says PAID for a record matching this flow.
//   * provider.create is called in exactly one place (submit, below), once, only after the submit intent has been
//     durably committed. A timeout, crash, 5xx or any unclear answer becomes SUBMISSION_UNCERTAIN, and from there
//     the only provider operations are reads. There is no retry path.
//   * The caller (the route handler) authenticates the operator and performs the passphrase step-up for approve,
//     reject and submit. This service additionally requires a "human:" actor, and for submit the SAME human who
//     approved.
import { groundFacts } from "../src/server/agent.ts";
import { claimsUsable, evaluate } from "../src/server/agentPolicy.ts";
import type { Claims } from "../src/server/agentPolicy.ts";
import { documentDigest } from "../src/server/agentRegistry.ts";
import { fromMinor } from "../src/server/policy.ts";
import { APPROVAL_TTL_MS, MAX_SUBMISSIONS } from "../src/server/transfers.ts";
import { APPROVAL_KEY_MIN_BYTES, approvalMac, approvalMacValid, authorizationDigest, flowDigest, gateDigest, proposalDigest, proposalProblem } from "./flowCanonical.ts";
import { GATE_POLICY_VERSION, GATE_TTL_MS, INTENT_STALE_MS, PROOF_IDS, PROVIDER_STATUS_TO_STATE, TERMINAL_STATES } from "./flowTypes.ts";
import type { AuthorizationRecord, EvidenceRef, EvidenceSource, FlowDeps, FlowRecordV1, FlowResult, FlowService, FlowState, FlowView, GateBindInput, GateRecord, LedgerBinding, ProofId, ProviderCallResult } from "./flowTypes.ts";
import { authorizationOf, claimsOf, FlowStoreError, gateOf, ledgerOf, openFlowStore, proposalOf, STORE_UNAVAILABLE, toRecord } from "./flowStore.ts";
import { ALREADY_RECORDED, appendIntent, appendIntentNotCommitted, appendOutcome, createSubmissionHistory, HISTORY_INCONSISTENT, HISTORY_MISSING, HISTORY_WRITE_FAILED, readSubmissionHistory } from "./submissionHistory.ts";
import type { FlowRow, FlowStore } from "./flowStore.ts";
import type { OutcomeClass } from "./submissionHistory.ts";
import { classifyCreate, classifyRead, providerBody } from "./paymentAdapter.ts";
import { createDraft, note, transition } from "./stateMachine.ts";
import type { AuditData, TransitionInput } from "./stateMachine.ts";

/** Failure injection for tests ONLY. The runtime never passes it. A hook may throw or kill the process. */
export type FlowTestHooks = { beforeIntent?: () => void; afterIntent?: () => void; afterCreate?: () => void; afterRead?: () => void };

const HUMAN = /^human:[A-Za-z0-9_-]{1,24}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_CHARS = 8000;
const code = (c: unknown, fallback: string): string => (typeof c === "string" && /^[A-Za-z0-9_.: -]{1,80}$/.test(c) ? c : fallback);
const actorLabel = (a: unknown): string => (typeof a === "string" && (HUMAN.test(a) || a === "server" || a === "system:recovery") ? a : "server");
const errorCode = (e: unknown, fallback: string): string => code((e as { code?: unknown } | null)?.code, fallback);

/** Remediation A8-02. What this server process has already spent, held in process memory where a writer of the store
 *  file cannot reach it. An entry is added synchronously, in the same span as the intent commit and before
 *  provider.create is awaited, and is NEVER removed, whatever the outcome (accepted, refused, uncertain, thrown).
 *  So even if the store is rolled back (attempt row deleted, flow row reset to HUMAN_APPROVED or earlier), this
 *  process will not validate, record an intent or call create again for the same authorization, the same provider
 *  request id or the same flow.
 *
 *  LIMIT, by design and documented: this is per process. It has the lifetime of the approval key (flow-v1.2 R11)
 *  and is shared by every flow service in the process that holds the same key object. It is not shared across
 *  processes and does not survive a restart. Those two cases are closed by R11 instead: another process or a
 *  restarted one has a different key, so the old approval is refused as AUTHORIZATION_NOT_SERVER_ISSUED. */
type Spent = { approvals: Set<string>; requests: Set<string>; flows: Set<string> };
const SPENT_BY_KEY = new WeakMap<Uint8Array, Spent>();
function spentFor(key: unknown): Spent {
  const fresh = (): Spent => ({ approvals: new Set(), requests: new Set(), flows: new Set() });
  if (!(key instanceof Uint8Array)) return fresh(); // no usable key: approve and submit refuse anyway
  let s = SPENT_BY_KEY.get(key);
  if (!s) SPENT_BY_KEY.set(key, (s = fresh()));
  return s;
}

export function createFlowService(deps: FlowDeps, hooks: FlowTestHooks = {}): FlowService {
  const instanceSpent = spentFor(deps.approvalKey);
  /** The spent record for the key in use now (the same object as instanceSpent unless the key was replaced). */
  const spent = (): Spent => (deps.approvalKey instanceof Uint8Array ? spentFor(deps.approvalKey) : instanceSpent);
  /** A fixed refusal code when this process has already recorded a submit intent for this approval, request or flow. */
  const alreadySpent = (row: FlowRow, authorizationDigestHex: string | null): string | null => {
    const s = spent();
    if (authorizationDigestHex !== null && (s.approvals.has(authorizationDigestHex) || instanceSpent.approvals.has(authorizationDigestHex))) return "AUTHORIZATION_ALREADY_CONSUMED";
    if (s.requests.has(row.provider_request_id) || s.flows.has(row.flow_id) || instanceSpent.requests.has(row.provider_request_id) || instanceSpent.flows.has(row.flow_id)) return "CREATE_ALREADY_ATTEMPTED";
    return null;
  };
  let store: FlowStore | null = null;
  try {
    store = openFlowStore(deps.dataDir, deps.audit.ddl);
  } catch {
    store = null; // every operation refuses; there is no in-memory fallback
  }
  const audit = deps.audit;
  const now = () => deps.now();

  /** Store present and audit chain intact, or a fixed refusal code. A broken chain refuses every operation. */
  function unavailable(): string | null {
    if (!store) return STORE_UNAVAILABLE;
    try {
      const v = audit.verify(store.db);
      return v.ok ? null : "AUDIT_CHAIN_BROKEN";
    } catch {
      return "AUDIT_CHAIN_BROKEN";
    }
  }

  /** flow-v1.2 R11: the per-process approval key. Held in memory only; never stored, logged, audited or returned. */
  const approvalKeyUsable = (): boolean => deps.approvalKey instanceof Uint8Array && deps.approvalKey.length >= APPROVAL_KEY_MIN_BYTES;

  function refuse(row: FlowRow | null, actor: unknown, op: string, c: string, extra: AuditData = {}): FlowResult {
    if (store && row) note(store, audit, row.flow_id, { type: "REFUSED", actor: actorLabel(actor), data: { op, code: c, ...extra } }, now());
    return { ok: false, code: c };
  }

  function move(t: TransitionInput) {
    return transition(store!, audit, t);
  }

  /** Lazy expiry (never after intent): an expired gate before approval, or an expired authorization before submit. */
  function expireIfDue(row: FlowRow, actor: unknown, op: string): FlowResult | null {
    const at = now();
    let why: string | null = null;
    if (row.state === "GATE_ELIGIBLE" || row.state === "AWAITING_HUMAN") {
      const g = gateOf(row);
      if (!g || at >= g.expires_at_ms) why = "GATE_EXPIRED";
    } else if (row.state === "HUMAN_APPROVED") {
      const a = authorizationOf(row);
      if (!a || at >= a.expires_at_ms) why = "APPROVAL_EXPIRED";
    }
    if (!why) return null;
    const r = move({ flow_id: row.flow_id, op: "expire", from: row.state, expected_version: row.version, to: "EXPIRED", event: { type: "FLOW_EXPIRED", actor: actorLabel(actor), data: { op, code: why } }, at_ms: at });
    return r.ok ? { ok: false, code: why } : refuse(row, actor, op, r.code);
  }

  async function balance(): Promise<string | null> {
    try {
      const b = await deps.balanceUsd();
      return typeof b === "string" ? b : null;
    } catch {
      return null;
    }
  }

  function bindInput(row: FlowRow, balance_usd: string | null): GateBindInput {
    return { flow_id: row.flow_id, proposal: proposalOf(row), proposal_digest: row.proposal_digest, evidence_source: row.evidence_source as EvidenceSource, evidence_text: row.evidence_text ?? "", claims: claimsOf(row), registry: deps.registry, balance_usd, now_ms: now() };
  }

  /** The stored proposal and gate record must still hash to their own digests before anything relies on them. */
  function storedProblem(row: FlowRow, needGate: boolean): string | null {
    try {
      const p = proposalOf(row);
      if (proposalProblem(p) || proposalDigest(p) !== row.proposal_digest || p.flow_id !== row.flow_id || p.provider_request_id !== row.provider_request_id) return "PROPOSAL_RECORD_TAMPERED";
      if (needGate) {
        const g = gateOf(row);
        if (!g) return "NO_GATE_RESULT";
        const { gate_digest, ...rest } = g;
        if (gateDigest(rest) !== gate_digest || gate_digest !== row.gate_digest || g.flow_id !== row.flow_id || g.proposal_digest !== row.proposal_digest) return "GATE_RECORD_TAMPERED";
        if (g.decision !== "ELIGIBLE_FOR_HUMAN_REVIEW" || g.gate_refused || !PROOF_IDS.every((k) => g.proof_states[k] === "VERIFIED")) return "GATE_NOT_ELIGIBLE";
        // the evidence and claims held for this flow must still be the ones the gate record was bound to
        if (documentDigest(row.evidence_text ?? "") !== row.evidence_digest || g.evidence_digest !== row.evidence_digest || g.evidence_source !== row.evidence_source) return "EVIDENCE_CHANGED";
        const claims = claimsOf(row);
        if (g.claims_digest !== (claims === null ? null : flowDigest("claims", claims))) return "CLAIMS_CHANGED";
      }
      return null;
    } catch (e) {
      return errorCode(e, "STORED_RECORD_UNREADABLE");
    }
  }

  /** Fresh server-side re-check by the gate port for one phase, with a freshly read balance. */
  async function revalidate(row: FlowRow, phase: "review" | "approve" | "submit"): Promise<string | null> {
    const g = gateOf(row)!;
    try {
      const r = deps.gate.revalidate(g, bindInput(row, await balance()), phase);
      if (r && r.ok === true) return null;
      return code((r as { code?: unknown } | null)?.code, "GATE_REVALIDATION_FAILED");
    } catch {
      return "GATE_REVALIDATION_FAILED";
    }
  }

  function allowlistProblem(row: FlowRow): string | null {
    const p = proposalOf(row);
    return deps.allowlist.get(p.beneficiary_id) === p.beneficiary_label ? null : "BENEFICIARY_NOT_ALLOWLISTED";
  }

  /** Remediation A8-01 (flow side). Being ON the allowlist is not enough: the stored proposal must be exactly the
   *  proposal the trusted builder derives NOW for this obligation (registry, binding fixture, allowlist) with this
   *  flow's ids, and the bound label must resolve to exactly one allowlist entry, which must be the stored
   *  beneficiary. A store writer who points an eligible obligation at a different allowlisted beneficiary, or swaps
   *  the id while keeping the label, fails here at evaluate, review, approve and submit. */
  function bindingProblem(row: FlowRow): string | null {
    try {
      const p = proposalOf(row);
      if (p.obligation_id !== row.obligation_id) return "BENEFICIARY_BINDING_MISMATCH";
      // A label that appears on the allowlist must appear exactly once, on the stored beneficiary. A label that does
      // not appear at all is left to the gate (E3 obligations are bound to a reserved id that is never allowlisted
      // and must still be evaluated to HOLD); review, approve and submit refuse it through allowlistProblem.
      const sameLabel = [...deps.allowlist.entries()].filter(([, label]) => label === p.beneficiary_label);
      if (sameLabel.length > 1 || (sameLabel.length === 1 && sameLabel[0][0] !== p.beneficiary_id)) return "BENEFICIARY_BINDING_UNRESOLVED";
      const built = deps.buildProposal(row.obligation_id, row.flow_id, row.provider_request_id, deps.allowlist);
      if (!built || built.ok !== true) return code((built as { code?: unknown } | null)?.code, "BENEFICIARY_BINDING_MISMATCH");
      if (proposalProblem(built.proposal) || proposalDigest(built.proposal) !== row.proposal_digest) return "BENEFICIARY_BINDING_MISMATCH";
      return null;
    } catch {
      return "BENEFICIARY_BINDING_MISMATCH";
    }
  }

  /** Funding check when the ledger is wired. Returns the binding to store, null when the ledger is off, or a code. */
  async function funding(row: FlowRow): Promise<LedgerBinding | null | string> {
    if (!deps.ledger) return null;
    const p = proposalOf(row);
    let allocation: string | null;
    try {
      allocation = deps.ledgerAllocationFor(p.obligation_id);
    } catch {
      allocation = null;
    }
    if (!allocation) return "LEDGER_ALLOCATION_UNRESOLVED";
    try {
      const r = await deps.ledger.checkFunding({ flow_id: row.flow_id, allocation_id: allocation, amount_minor: p.amount_minor });
      if (!r || r.ok !== true) return code((r as { code?: unknown } | null)?.code, "LEDGER_FUNDING_CHECK_FAILED");
      const prev = ledgerOf(row);
      return { allocation_id: allocation, funding_check_version: String(r.funding_check_version), funding_checked_at_ms: now(), reduction_event_id: prev?.reduction_event_id ?? null, reduced_at_ms: prev?.reduced_at_ms ?? null };
    } catch {
      return "LEDGER_FUNDING_CHECK_FAILED";
    }
  }

  /** At most one reduction, and only from the two places the contract allows: after record_create_accepted, or after
   *  the first matching provider read out of SUBMISSION_UNCERTAIN. A failure is audit-only; it never changes state. */
  async function postReductionOnce(flowId: string): Promise<void> {
    if (!deps.ledger || !store) return;
    const row = store.getRow(flowId);
    const binding = row ? ledgerOf(row) : null;
    const a = row ? authorizationOf(row) : null;
    if (!row || !binding || !a || binding.reduction_event_id !== null) return;
    const p = proposalOf(row);
    try {
      const r = await deps.ledger.postReduction({ flow_id: flowId, allocation_id: binding.allocation_id, amount_minor: p.amount_minor, idempotency_key: p.provider_request_id, authorization_id: a.authorization_digest });
      if (r && r.ok === true) {
        const next: LedgerBinding = { ...binding, reduction_event_id: String(r.reduction_event_id), reduced_at_ms: r.reduced_at_ms };
        note(store, audit, flowId, { type: "LEDGER_REDUCTION_POSTED", actor: "server", data: { reduction_ref: String(r.reduction_event_id).slice(0, 120), replayed: r.replayed === true, label: "drawn against allocation" } }, now(), { ledger_json: JSON.stringify(next) });
      } else {
        note(store, audit, flowId, { type: "LEDGER_REDUCTION_FAILED", actor: "server", data: { code: code((r as { code?: unknown } | null)?.code, "LEDGER_REDUCTION_FAILED") } }, now());
      }
    } catch {
      note(store, audit, flowId, { type: "LEDGER_REDUCTION_FAILED", actor: "server", data: { code: "LEDGER_REDUCTION_FAILED" } }, now());
    }
  }

  /** A submit intent with no recorded outcome that is older than INTENT_STALE_MS: the process that owned it crashed
   *  or lost the answer. The outcome is unknown. It is never resubmitted. Makes no provider call. */
  function recoverStale(actor: string): void {
    if (!store) return;
    for (const row of store.listRows("SUBMIT_INTENT_RECORDED")) {
      if (row.attempt_recorded_at_ms === null || now() - row.attempt_recorded_at_ms < INTENT_STALE_MS) continue;
      move({ flow_id: row.flow_id, op: "recover_stale_intent", from: "SUBMIT_INTENT_RECORDED", expected_version: row.version, to: "SUBMISSION_UNCERTAIN", event: { type: "STALE_INTENT_RECOVERED", actor, data: { code: "INTERRUPTED_AFTER_INTENT", attempt_id: row.attempt_id } }, at_ms: now() });
    }
  }
  if (store) {
    try {
      recoverStale("system:recovery");
    } catch { /* recovery is retried by reconcile */ }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Candidate 3, A8-09: submission history OUTSIDE the database (see submissionHistory.ts for the trust boundary).
  //
  // The database, including its audit chain, can be rolled back as one file, and the in-process spent record above
  // does not survive a restart. So "has a create ever been attempted for this flow?" is also answered from a
  // separate append-only file. approve and submit refuse on any recorded intent, and on a history that is missing,
  // malformed, broken or inconsistent with the store. Nothing here ever calls the provider.
  // -------------------------------------------------------------------------------------------------------------
  if (store) {
    const s = store;
    try {
      // The file is created only for a store with NO flow at all (a fresh install). A store that already holds any
      // flow, with no history file, is NOT given a fresh one: approve and submit refuse SUBMISSION_HISTORY_MISSING.
      // (A writer who also forges a valid header-only history is not stopped by this; see the trust boundary.)
      s.tx(() => {
        const h = readSubmissionHistory(s.dir);
        if (!h.ok && h.code === HISTORY_MISSING && s.listRows().length === 0 && s.authorizationCount() === 0 && s.attempts().length === 0) createSubmissionHistory(s.dir, now());
      });
    } catch { /* left missing: approve and submit refuse */ }
  }

  /** Read-only provider guard (owner-approved for A8-09; response validation tightened for A8-11). Asks the provider,
   *  by request id, whether it already holds a record for this flow's provider_request_id. It is one more gate and
   *  nothing else: callers run it AFTER every local check, a null from here never clears a refusal from anywhere
   *  else, and it never calls create. The same function serves all three lookup points (approve, before validate,
   *  after the durable intent), so the rules below hold at each of them.
   *
   *  RECORD EXISTS: any list entry whose `request_id` is exactly this flow's request id. One or several, any status.
   *
   *  CONFIRMED ABSENT (the only case that returns null) requires ALL of:
   *    - HTTP 200;
   *    - the body is a plain object with EXACTLY the keys `items` and `has_more`, nothing else. Any other key is
   *      treated as a pagination, cursor or envelope field this code does not understand, and refuses;
   *    - `items` is an array and `has_more` is exactly the boolean false (missing, null, "false", 0 all refuse);
   *    - every item is a plain object with a non-empty string `request_id`;
   *    - no item carries another request-id-like field (for example `client_request_id` or `requestId`) whose value
   *      differs from that item's `request_id`, or which equals this flow's request id in any letter case;
   *    - no item's `request_id` equals this flow's request id after trimming and case-folding without being exactly
   *      equal to it (an ambiguous near-match is not an absence).
   *  Everything else refuses: PROVIDER_LOOKUP_FAILED for no usable HTTP 200 answer, PROVIDER_LOOKUP_AMBIGUOUS for a
   *  200 answer that is not that exact shape. Malformed provider data is NEVER treated as a confirmed absence.
   *
   *  PINNED ASSUMPTION, UNVERIFIED: the accepted key set { items, has_more } and the item field `request_id` are this
   *  build's assumption about the provider's list-by-request-id response. It has not been checked against the real
   *  Airwallex API (no sandbox or live call was authorized). If the real response differs, every lookup refuses,
   *  which is the safe direction; it must be verified before any release that claims financial execution safety. */
  async function providerRecordProblem(row: FlowRow): Promise<string | null> {
    let r: ProviderCallResult;
    try {
      r = await deps.provider.readByRequestId(row.provider_request_id);
    } catch {
      return "PROVIDER_LOOKUP_FAILED";
    }
    if (!r || typeof r !== "object" || r.kind !== "HTTP" || r.status !== 200) return "PROVIDER_LOOKUP_FAILED";
    const AMBIGUOUS = "PROVIDER_LOOKUP_AMBIGUOUS";
    const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
    const ours = row.provider_request_id;
    const fold = (v: string) => v.trim().toLowerCase();
    const b = r.body;
    if (!plain(b) || !Array.isArray(b.items)) return AMBIGUOUS;
    const items = b.items as unknown[];
    // An exact match is a record, whatever else is wrong with the answer: never send again.
    if (items.some((x) => plain(x) && x.request_id === ours)) return "PROVIDER_RECORD_EXISTS";
    // From here on the question is whether this answer PROVES absence. Anything short of the exact shape does not.
    if (Object.keys(b).sort().join(",") !== "has_more,items") return AMBIGUOUS; // unknown envelope, cursor or pagination key, or has_more missing
    if (b.has_more !== false) return AMBIGUOUS; // more pages, or a value this code cannot read as "no more pages"
    for (const x of items) {
      if (!plain(x)) return AMBIGUOUS;
      if (typeof x.request_id !== "string" || x.request_id.length === 0) return AMBIGUOUS; // absent or malformed request id
      if (fold(x.request_id) === fold(ours)) return AMBIGUOUS; // same id in another letter case or with stray spaces
      for (const [k, v] of Object.entries(x)) {
        if (k === "request_id" || !/request[\s_-]*id/i.test(k)) continue;
        // another request-id-like field: it must agree with request_id, and must not be this flow's id in any case
        if (typeof v !== "string" || v !== x.request_id || fold(v) === fold(ours)) return AMBIGUOUS;
      }
    }
    return null;
  }

  /** A concurrent submit of the SAME flow may have recorded its intent (and even reached the provider) between this
   *  request reading the row and reaching a history or lookup check. When the store itself now shows that attempt,
   *  the truthful refusal is the ordinary DUPLICATE_SUBMISSION, exactly as before these checks existed. It is a
   *  refusal either way; only the code differs. A flow whose row shows no attempt keeps the specific code. */
  const raced = (row: FlowRow, c: string): string => (store!.getRow(row.flow_id)?.attempt_id ? "DUPLICATE_SUBMISSION" : c);

  /** Best-effort outcome line for a live intent (evidence only). */
  function recordOutcome(flowId: string, attemptId: string, outcome: OutcomeClass): void {
    try {
      store!.tx(() => appendOutcome(store!.dir, { flow_id: flowId, attempt_id: attemptId, outcome, at_ms: now() }));
    } catch { /* the intent stays live with no outcome; nothing is unblocked either way */ }
  }

  /** Fixed refusal code unless the submission history is intact, agrees with the store, and holds no live intent
   *  for this flow, its provider request id, its proposal or (when given) this authorization. */
  function historyProblem(row: FlowRow, authorizationDigestHex: string | null): string | null {
    try {
      // Read under the store write lock, the same lock every append holds, so a check never sees a line that
      // another process is in the middle of writing.
      const h = store!.tx(() => readSubmissionHistory(store!.dir));
      if (!h.ok) return h.code; // missing, malformed or broken: nothing in this store may be approved or submitted
      // An intent on record for this transaction: a create may already have been sent. Never again, in any process.
      if (h.live.some((l) => l.flow_id === row.flow_id || l.provider_request_id === row.provider_request_id || l.proposal_digest === row.proposal_digest || (authorizationDigestHex !== null && l.authorization_digest === authorizationDigestHex))) return ALREADY_RECORDED;
      // The store must not know of an attempt the history does not (a truncated or replaced history) ...
      const live = new Map(h.live.map((l) => [l.attempt_id, l]));
      for (const a of store!.attempts()) {
        const l = live.get(a.attempt_id);
        if (!l || l.flow_id !== a.flow_id || l.provider_request_id !== a.provider_request_id || l.authorization_digest !== a.authorization_digest) return HISTORY_INCONSISTENT;
      }
      // ... and the history must not name a flow the store has never heard of (a database restored from elsewhere).
      // A flow that exists but has lost its attempt row is the rollback case: that flow alone is refused, above.
      for (const l of h.live) if (!store!.getRow(l.flow_id)) return HISTORY_INCONSISTENT;
      return null;
    } catch {
      return HISTORY_INCONSISTENT;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------------------------------------------

  function createFlow(actor: string, caseId: unknown): FlowResult & { flow_id?: string } {
    const down = unavailable();
    if (down) return { ok: false, code: down };
    if (typeof actor !== "string" || !HUMAN.test(actor)) return { ok: false, code: "HUMAN_OPERATOR_REQUIRED" };
    if (typeof caseId !== "string" || !caseId || caseId.length > 80) return { ok: false, code: "UNKNOWN_CASE" };
    try {
      const flowId = deps.uuid();
      const requestId = deps.uuid();
      const built = deps.buildProposal(caseId, flowId, requestId, deps.allowlist);
      if (!built || built.ok !== true) return { ok: false, code: code((built as { code?: unknown } | null)?.code, "PROPOSAL_BUILD_FAILED") };
      const p = built.proposal;
      const bad = proposalProblem(p) ?? (p.flow_id !== flowId || p.provider_request_id !== requestId || p.obligation_id !== caseId ? "PROPOSAL_SHAPE" : null);
      if (bad) return { ok: false, code: bad };
      const digest = proposalDigest(p);
      const r = createDraft(store!, audit, { flow_id: flowId, created_by: actor, proposal_json: JSON.stringify(p), proposal_digest: digest, provider_request_id: requestId, obligation_id: p.obligation_id, data: { obligation_id: p.obligation_id, proposal_digest: digest, request_id: requestId, provider_mode: deps.providerMode }, at_ms: now() });
      return r.ok ? { ok: true, code: "DRAFT", flow_id: flowId } : { ok: false, code: r.code };
    } catch (e) {
      return { ok: false, code: errorCode(e, "PROPOSAL_BUILD_FAILED") };
    }
  }

  function attachEvidence(actor: string, flowId: unknown, src: EvidenceRef): FlowResult {
    const down = unavailable();
    if (down) return { ok: false, code: down };
    const row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    if (row.state !== "DRAFT") return refuse(row, actor, "attach_evidence", "WRONG_STATE");
    let text: string;
    let claims: Claims | null;
    let documentId: string | null = null;
    let source: EvidenceSource;
    try {
      if (src && src.kind === "FIXTURE_REPLAY" && typeof src.document_id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(src.document_id)) {
        const replay = deps.replayEvidence(src.document_id);
        if (!replay || typeof replay.text !== "string") return refuse(row, actor, "attach_evidence", "REPLAY_DOCUMENT_NOT_FOUND");
        text = replay.text;
        const grounded = groundFacts(replay.facts, text); // a string here means the fixture facts could not be grounded
        claims = typeof grounded === "string" ? null : grounded;
        documentId = src.document_id;
        source = "FIXTURE_REPLAY";
      } else if (src && src.kind === "AGENT_RUN" && typeof src.run_id === "string" && src.run_id.length <= 120) {
        const run = deps.runLookup(src.run_id);
        if (!run || typeof run.evidence !== "string") return refuse(row, actor, "attach_evidence", "AGENT_RUN_NOT_FOUND");
        text = run.evidence;
        claims = run.claims ?? null;
        source = "AGENT_RUN";
      } else {
        return refuse(row, actor, "attach_evidence", "EVIDENCE_REFERENCE_INVALID");
      }
    } catch {
      return refuse(row, actor, "attach_evidence", "EVIDENCE_LOOKUP_FAILED");
    }
    if (!text.trim() || text.length > MAX_EVIDENCE_CHARS) return refuse(row, actor, "attach_evidence", "EVIDENCE_TEXT_INVALID");
    if (claims !== null && !claimsUsable(claims)) {
      if (source === "AGENT_RUN") return refuse(row, actor, "attach_evidence", "CLAIMS_UNUSABLE");
      claims = null;
    }
    const digest = documentDigest(text);
    const r = move({
      flow_id: row.flow_id, op: "attach_evidence", from: "DRAFT", expected_version: row.version, to: "EVIDENCE_READY",
      set: { evidence_source: source, evidence_text: text, claims_json: claims === null ? null : JSON.stringify(claims), evidence_document_id: documentId, evidence_digest: digest },
      event: { type: "EVIDENCE_ATTACHED", actor: actorLabel(actor), data: { evidence_source: source, document_id: documentId, evidence_digest: digest, claims_present: claims !== null } }, at_ms: now(),
    });
    return r.ok ? { ok: true, code: "EVIDENCE_READY" } : refuse(row, actor, "attach_evidence", r.code);
  }

  /** What a gate record must be before this flow will store it. A record that fails is not stored at all. */
  function gateRecordProblem(g: GateRecord, row: FlowRow, at: number): string | null {
    try {
      if (!g || typeof g !== "object") return "GATE_RECORD_INVALID";
      const { gate_digest, ...rest } = g;
      if (!HEX64.test(String(gate_digest)) || gateDigest(rest) !== gate_digest) return "GATE_RECORD_INVALID";
      if (g.flow_id !== row.flow_id || g.proposal_digest !== row.proposal_digest || g.evidence_source !== row.evidence_source || g.evidence_digest !== row.evidence_digest) return "GATE_RECORD_NOT_FOR_THIS_FLOW";
      if (g.policy_version !== GATE_POLICY_VERSION) return "POLICY_VERSION_CHANGED";
      if (!["HOLD", "REVIEW", "ELIGIBLE_FOR_HUMAN_REVIEW"].includes(g.decision) || typeof g.gate_refused !== "boolean") return "GATE_RECORD_INVALID";
      if (!g.proof_states || Object.keys(g.proof_states).length !== PROOF_IDS.length || !PROOF_IDS.every((k) => ["VERIFIED", "MISSING", "CONTRADICTED", "UNTRUSTED", "UNKNOWN"].includes(g.proof_states[k]))) return "GATE_RECORD_INVALID";
      if (!Number.isSafeInteger(g.evaluated_at_ms) || g.evaluated_at_ms > at || g.expires_at_ms !== g.evaluated_at_ms + GATE_TTL_MS || g.expires_at_ms <= at) return "GATE_RECORD_INVALID";
      if (g.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" && (g.gate_refused || g.document_binding !== "REGISTERED_DOCUMENT" || !PROOF_IDS.every((k) => g.proof_states[k] === "VERIFIED"))) return "GATE_RECORD_INCONSISTENT";
      return null;
    } catch (e) {
      return errorCode(e, "GATE_RECORD_INVALID");
    }
  }

  /** DISPLAY ONLY. Re-runs the published gate on exactly the inputs the record was bound to (stored evidence and
   *  claims, the integrated registry, the bound balance) to obtain the per-proof reason text, and keeps it only if
   *  the decision and all 11 proof states equal the record. Never read by any decision path; never run at view time. */
  function displayReasons(g: GateRecord, row: FlowRow): { reasons: Record<ProofId, string>; matched: boolean } {
    const empty = Object.fromEntries(PROOF_IDS.map((k) => [k, ""])) as Record<ProofId, string>;
    try {
      const ev = evaluate(row.evidence_text ?? "", claimsOf(row), deps.registry, g.balance_minor === null ? null : fromMinor(BigInt(g.balance_minor)));
      const byId = new Map(ev.proofs.map((p) => [p.id, p]));
      if (ev.decision !== g.decision || !PROOF_IDS.every((k) => byId.get(k)?.state === g.proof_states[k])) return { reasons: empty, matched: false };
      return { reasons: Object.fromEntries(PROOF_IDS.map((k) => [k, String(byId.get(k)?.reason ?? "").slice(0, 300)])) as Record<ProofId, string>, matched: true };
    } catch {
      return { reasons: empty, matched: false };
    }
  }

  async function evaluateGate(actor: string, flowId: unknown): Promise<FlowResult> {
    const down = unavailable();
    if (down) return { ok: false, code: down };
    const row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    if (row.state !== "EVIDENCE_READY") return refuse(row, actor, "evaluate_gate", "WRONG_STATE");
    // A8-01: a proposal that is not the bound one never reaches the gate, so it can never become GATE_ELIGIBLE.
    // The operation is refused and the flow stays EVIDENCE_READY (no new state or transition). Allowlist MEMBERSHIP
    // is not required here: an obligation with no allowlisted beneficiary (E3) must still be evaluated, to HOLD.
    const stored = storedProblem(row, false) ?? bindingProblem(row);
    if (stored) return refuse(row, actor, "evaluate_gate", stored);
    if (documentDigest(row.evidence_text ?? "") !== row.evidence_digest) return refuse(row, actor, "evaluate_gate", "EVIDENCE_CHANGED");
    let g: GateRecord;
    try {
      g = deps.gate.evaluateAndBind(bindInput(row, await balance()));
    } catch {
      return refuse(row, actor, "evaluate_gate", "GATE_UNAVAILABLE");
    }
    const bad = gateRecordProblem(g, row, now());
    if (bad) return refuse(row, actor, "evaluate_gate", bad);
    const to: FlowState = g.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? "GATE_ELIGIBLE" : g.decision === "REVIEW" ? "GATE_REVIEW" : "GATE_HOLD";
    const shown = displayReasons(g, row);
    const r = move({
      flow_id: row.flow_id, op: "evaluate_gate", from: "EVIDENCE_READY", expected_version: row.version, to,
      set: { gate_json: JSON.stringify(g), gate_digest: g.gate_digest, proof_reasons_json: JSON.stringify(shown.reasons) },
      event: { type: "GATE_EVALUATED", actor: actorLabel(actor), data: { decision: g.decision, rule: String(g.rule).slice(0, 200), gate_refused: g.gate_refused, gate_digest: g.gate_digest, policy_version: g.policy_version, registry_digest: g.registry_digest, evidence_digest: g.evidence_digest, document_id: g.document_id, proofs_not_verified: PROOF_IDS.filter((k) => g.proof_states[k] !== "VERIFIED").join(","), expires_at_ms: g.expires_at_ms } },
      at_ms: now(),
    });
    if (!r.ok) return refuse(row, actor, "evaluate_gate", r.code);
    if (!shown.matched) note(store!, audit, row.flow_id, { type: "GATE_REASON_MISMATCH", actor: "server", data: { gate_digest: g.gate_digest } }, now());
    return { ok: true, code: to };
  }

  async function requestHumanReview(actor: string, flowId: unknown): Promise<FlowResult> {
    const op = "request_human_review";
    const down = unavailable();
    if (down) return { ok: false, code: down };
    const row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    if (row.state !== "GATE_ELIGIBLE") return refuse(row, actor, op, "WRONG_STATE");
    const expired = expireIfDue(row, actor, op);
    if (expired) return expired;
    const bad = storedProblem(row, true) ?? allowlistProblem(row) ?? bindingProblem(row) ?? (await revalidate(row, "review"));
    if (bad) return refuse(row, actor, op, bad);
    const fund = await funding(row);
    if (typeof fund === "string") return refuse(row, actor, op, fund);
    const late = expireIfDue(row, actor, op); // re-check after the awaits
    if (late) return late;
    const r = move({ flow_id: row.flow_id, op, from: "GATE_ELIGIBLE", expected_version: row.version, to: "AWAITING_HUMAN", set: fund ? { ledger_json: JSON.stringify(fund) } : {}, event: { type: "HUMAN_REVIEW_REQUESTED", actor: actorLabel(actor), data: { proposal_digest: row.proposal_digest, gate_digest: row.gate_digest } }, at_ms: now() });
    return r.ok ? { ok: true, code: "AWAITING_HUMAN" } : refuse(row, actor, op, r.code);
  }

  async function approve(actor: string, flowId: unknown, shownProposalDigest: unknown, shownGateDigest: unknown): Promise<FlowResult> {
    const op = "approve";
    const down = unavailable();
    if (down) return { ok: false, code: down };
    const row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    if (typeof actor !== "string" || !HUMAN.test(actor)) return refuse(row, "server", op, "HUMAN_OPERATOR_REQUIRED");
    if (row.state !== "AWAITING_HUMAN") return refuse(row, actor, op, "WRONG_STATE");
    if (!approvalKeyUsable()) return refuse(row, actor, op, "APPROVAL_KEY_INVALID"); // an approval this process could not vouch for is never written
    const expired = expireIfDue(row, actor, op);
    if (expired) return expired;
    if (shownProposalDigest !== row.proposal_digest) return refuse(row, actor, op, "PROPOSAL_DIGEST_MISMATCH");
    if (!row.gate_digest || shownGateDigest !== row.gate_digest) return refuse(row, actor, op, "GATE_DIGEST_MISMATCH");
    if (row.gate_consumed_at_ms !== null || row.authorization_json !== null) return refuse(row, actor, op, "GATE_ALREADY_CONSUMED");
    const bad = storedProblem(row, true) ?? allowlistProblem(row) ?? bindingProblem(row) ?? alreadySpent(row, null) ?? historyProblem(row, null) ?? (await revalidate(row, "approve")) ?? (await providerRecordProblem(row));
    if (bad) return refuse(row, actor, op, bad);
    const fund = await funding(row);
    if (typeof fund === "string") return refuse(row, actor, op, fund);
    const late = expireIfDue(row, actor, op); // re-check after the awaits
    if (late) return late;
    const at = now();
    let a: AuthorizationRecord;
    let mac: string;
    try {
      const rest = { flow_id: row.flow_id, proposal_digest: row.proposal_digest, gate_digest: row.gate_digest, operator_id: actor, approved_at_ms: at, expires_at_ms: at + APPROVAL_TTL_MS, flow_version: row.version };
      a = { ...rest, authorization_digest: authorizationDigest(rest) };
      mac = approvalMac(deps.approvalKey, a.authorization_digest); // proves THIS server process issued the approval
    } catch (e) {
      return refuse(row, actor, op, errorCode(e, "AUTHORIZATION_DIGEST_FAILED"));
    }
    // one transaction: the authorization row (one per flow, one per gate result), the consumed gate, the state
    const r = move({
      flow_id: row.flow_id, op, from: "AWAITING_HUMAN", expected_version: row.version, to: "HUMAN_APPROVED",
      set: { authorization_json: JSON.stringify(a), gate_consumed_at_ms: at, ...(fund ? { ledger_json: JSON.stringify(fund) } : {}) },
      extra: () => {
        store!.db.prepare("INSERT INTO flow_authorization (flow_id, gate_digest, authorization_digest, proposal_digest, operator_id, approved_at_ms, expires_at_ms, flow_version, approval_mac) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(a.flow_id, a.gate_digest, a.authorization_digest, a.proposal_digest, a.operator_id, a.approved_at_ms, a.expires_at_ms, a.flow_version, mac);
      },
      event: { type: "HUMAN_APPROVED", actor, data: { proposal_digest: a.proposal_digest, gate_digest: a.gate_digest, approval_digest: a.authorization_digest, expires_at_ms: a.expires_at_ms } }, at_ms: at,
    });
    return r.ok ? { ok: true, code: "HUMAN_APPROVED" } : refuse(row, actor, op, r.code);
  }

  function reject(actor: string, flowId: unknown, shownProposalDigest: unknown): FlowResult {
    const op = "reject";
    const down = unavailable();
    if (down) return { ok: false, code: down };
    const row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    if (typeof actor !== "string" || !HUMAN.test(actor)) return refuse(row, "server", op, "HUMAN_OPERATOR_REQUIRED");
    if (row.state !== "AWAITING_HUMAN") return refuse(row, actor, op, "WRONG_STATE");
    if (shownProposalDigest !== row.proposal_digest) return refuse(row, actor, op, "PROPOSAL_DIGEST_MISMATCH");
    const r = move({ flow_id: row.flow_id, op, from: "AWAITING_HUMAN", expected_version: row.version, to: "HUMAN_REJECTED", event: { type: "HUMAN_REJECTED", actor, data: { proposal_digest: row.proposal_digest } }, at_ms: now() });
    return r.ok ? { ok: true, code: "HUMAN_REJECTED" } : refuse(row, actor, op, r.code);
  }

  async function submit(actor: string, flowId: unknown, shownAuthorizationDigest: unknown): Promise<FlowResult> {
    const op = "submit";
    const down = unavailable();
    if (down) return { ok: false, code: down };
    let row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    if (typeof actor !== "string" || !HUMAN.test(actor)) return refuse(row, "server", op, "HUMAN_OPERATOR_REQUIRED");
    if (row.state !== "HUMAN_APPROVED") return refuse(row, actor, op, row.attempt_id ? "DUPLICATE_SUBMISSION" : "WRONG_STATE");
    const expired = expireIfDue(row, actor, op);
    if (expired) return expired;
    const a = authorizationOf(row);
    if (!a || row.authorization_consumed_at_ms !== null) return refuse(row, actor, op, "NOT_HUMAN_APPROVED");
    if (shownAuthorizationDigest !== a.authorization_digest) return refuse(row, actor, op, "AUTHORIZATION_DIGEST_MISMATCH");
    try {
      const { authorization_digest, ...rest } = a;
      if (authorizationDigest(rest) !== authorization_digest || a.flow_id !== row.flow_id || a.proposal_digest !== row.proposal_digest || a.gate_digest !== row.gate_digest) return refuse(row, actor, op, "AUTHORIZATION_RECORD_TAMPERED");
    } catch (e) {
      return refuse(row, actor, op, errorCode(e, "AUTHORIZATION_RECORD_TAMPERED"));
    }
    // flow-v1.2 R11: the authorization must have been issued by approve() in THIS server process. A record written
    // into the store by anything else, however self-consistent, has no valid MAC. Checked before validate, intent
    // or create. An approval from before a restart fails here too, and then expires.
    if (!approvalKeyUsable()) return refuse(row, actor, op, "APPROVAL_KEY_INVALID");
    const issued = store!.approvalMac(row.flow_id);
    if (!issued || issued.authorization_digest !== a.authorization_digest || !approvalMacValid(deps.approvalKey, a.authorization_digest, issued.approval_mac)) return refuse(row, actor, op, "AUTHORIZATION_NOT_SERVER_ISSUED");
    // A8-02: single use is also remembered in process memory, out of the store writer's reach. A flow row rolled back
    // to HUMAN_APPROVED after its intent was recorded is refused here, before validate, intent or create.
    const replay = alreadySpent(row, a.authorization_digest);
    if (replay) return refuse(row, actor, op, replay);
    // A8-09: the same question asked of the history file, which survives a database rollback AND a restart.
    const recorded = historyProblem(row, a.authorization_digest);
    if (recorded) return refuse(row, actor, op, raced(row, recorded));
    if (actor !== a.operator_id) return refuse(row, actor, op, "OPERATOR_MISMATCH"); // the same human who approved
    if (deps.provider.mode !== deps.providerMode) return refuse(row, actor, op, "PROVIDER_MODE_MISMATCH");
    if (deps.providerMode === "sandbox") {
      if (!deps.submitRelease || deps.submitRelease !== `${row.flow_id}:${a.authorization_digest}`) return refuse(row, actor, op, "OWNER_RELEASE_MISSING");
      if (store!.attemptCount("sandbox") >= MAX_SUBMISSIONS) return refuse(row, actor, op, "SUBMISSION_LIMIT_REACHED");
    }
    const bad = storedProblem(row, true) ?? allowlistProblem(row) ?? bindingProblem(row) ?? (await revalidate(row, "submit"));
    if (bad) return refuse(row, actor, op, bad);
    const fund = await funding(row);
    if (typeof fund === "string") return refuse(row, actor, op, fund);

    // A8-09: every local check has passed. Last gate before anything is asked of the provider's write side: does the
    // provider already hold a record for this request id? Refused with zero validate and zero create calls.
    const held = await providerRecordProblem(row);
    if (held) return refuse(row, actor, op, raced(row, held));

    // Section 7 step 1: validate (creates nothing) must answer HTTP 200.
    const proposal = proposalOf(row);
    const body = providerBody(proposal);
    let validated: ProviderCallResult;
    try {
      validated = await deps.provider.validate(body);
    } catch {
      validated = { kind: "TRANSPORT_ERROR", code: "PROVIDER_CALL_FAILED" };
    }
    if (!validated || validated.kind !== "HTTP" || validated.status !== 200) return refuse(row, actor, op, "PROVIDER_VALIDATION_FAILED", { http_status: validated && validated.kind === "HTTP" ? validated.status : null });
    const late = expireIfDue(row, actor, op); // re-check after the awaits
    if (late) return late;
    hooks.beforeIntent?.();

    // A8-02: re-check after the awaits above. From here to the create call there is no await, so nothing in this
    // process can run between this check, the intent commit and the marking below.
    const replayNow = alreadySpent(row, a.authorization_digest);
    if (replayNow) return refuse(row, actor, op, store!.getRow(row.flow_id)?.attempt_id ? "DUPLICATE_SUBMISSION" : replayNow);

    // Section 7 step 2: commit the intent FIRST. One transaction: attempt row, consumed authorization, state, audit.
    const at = now();
    const attemptId = deps.uuid();
    let historyWritten = false;
    const intent = move({
      flow_id: row.flow_id, op: "record_submit_intent", from: "HUMAN_APPROVED", expected_version: row.version, to: "SUBMIT_INTENT_RECORDED",
      set: { attempt_id: attemptId, attempt_recorded_at_ms: at, provider_mode: deps.providerMode, authorization_consumed_at_ms: at, ...(fund ? { ledger_json: JSON.stringify(fund) } : {}) },
      extra: () => {
        store!.db.prepare("INSERT INTO flow_submit_attempt (flow_id, provider_request_id, attempt_id, authorization_digest, recorded_at_ms, provider_mode) VALUES (?,?,?,?,?,?)")
          .run(row!.flow_id, row!.provider_request_id, attemptId, a.authorization_digest, at, deps.providerMode);
        // A8-09: still inside the intent transaction, so under the store write lock (one writer across connections
        // and processes). Re-check the history, then append and fsync the INTENT line. Only after this does the
        // transaction commit, and only after the commit is create called. If this throws, the transaction rolls
        // back and nothing is sent.
        const h = readSubmissionHistory(store!.dir);
        if (!h.ok) throw new FlowStoreError(h.code);
        if (h.live.some((l) => l.flow_id === row!.flow_id || l.provider_request_id === row!.provider_request_id || l.proposal_digest === row!.proposal_digest || l.authorization_digest === a.authorization_digest)) throw new FlowStoreError(ALREADY_RECORDED);
        try {
          appendIntent(store!.dir, { flow_id: row!.flow_id, provider_request_id: row!.provider_request_id, proposal_digest: row!.proposal_digest, authorization_digest: a.authorization_digest, attempt_id: attemptId, provider_mode: deps.providerMode, at_ms: at });
        } catch (e) {
          throw new FlowStoreError(code((e as { code?: unknown } | null)?.code, HISTORY_WRITE_FAILED));
        }
        historyWritten = true;
      },
      event: { type: "SUBMIT_INTENT_RECORDED", actor, data: { attempt_id: attemptId, request_id: row.provider_request_id, proposal_digest: row.proposal_digest, approval_digest: a.authorization_digest, provider_mode: deps.providerMode } }, at_ms: at,
    });
    if (!intent.ok) {
      if (historyWritten) {
        // The INTENT line is durable but the transaction that would have recorded the intent did not commit, so
        // nothing was or will be sent for this attempt. Say so in the history. If even that cannot be written, the
        // intent stays live there and this flow stays refused: fail closed.
        try {
          store!.tx(() => appendIntentNotCommitted(store!.dir, { flow_id: row!.flow_id, attempt_id: attemptId, code: intent.code, at_ms: now() }));
        } catch { /* stays live in the history */ }
      }
      const cur = store!.getRow(row.flow_id);
      return refuse(row, actor, op, cur?.attempt_id ? "DUPLICATE_SUBMISSION" : intent.code); // nothing was sent
    }
    row = intent.row;
    // A8-02: mark the approval, the request id and the flow as spent in process memory, synchronously, in the same
    // span as the committed intent and before create is awaited. Never unmarked.
    for (const s of new Set([spent(), instanceSpent])) {
      s.approvals.add(a.authorization_digest);
      s.requests.add(row.provider_request_id);
      s.flows.add(row.flow_id);
    }

    // Section 7 step 3: the single create call, from the invocation that committed the intent.
    hooks.afterIntent?.();
    // A8-09: the intent is now durable in the store and in the history, and both were written under the store write
    // lock, so no other process can be at this point for this flow, request id or authorization. Ask the provider
    // once more. If it holds a record, or the answer is not a clean "absent", create is NOT called: this attempt is
    // provably not transmitted, the flow is left SUBMISSION_UNCERTAIN (a create may exist from an earlier life of
    // this flow), and only a reconcile read can move it. This closes the lookup-then-create race.
    const heldNow = await providerRecordProblem(row);
    if (heldNow) {
      recordOutcome(row.flow_id, attemptId, "NOT_TRANSMITTED");
      const u = move({ flow_id: row.flow_id, op: "record_create_uncertain", from: "SUBMIT_INTENT_RECORDED", expected_version: row.version, to: "SUBMISSION_UNCERTAIN", event: { type: "PROVIDER_CREATE_NOT_SENT", actor: "server", data: { code: heldNow, attempt_id: attemptId, create_called: false } }, at_ms: now() });
      if (!u.ok) note(store!, audit, row.flow_id, { type: "PROVIDER_CREATE_NOT_SENT", actor: "server", data: { code: heldNow, attempt_id: attemptId, create_called: false } }, now());
      return { ok: false, code: heldNow };
    }
    let answer: ProviderCallResult;
    try {
      answer = await deps.provider.create(body);
    } catch {
      answer = { kind: "TRANSPORT_ERROR", code: "PROVIDER_CALL_FAILED" };
    }
    hooks.afterCreate?.();

    // Section 7 step 4: classify and record. A create response never sets a PROVIDER_* state.
    const c = classifyCreate(answer, row.provider_request_id);
    // Outcome class for the history. Anything that is not a well-formed acceptance or a definite refusal is
    // UNCERTAIN: once create has been called this code cannot prove the request never left the process.
    recordOutcome(row.flow_id, attemptId, c.kind === "ACCEPTED" ? "SENT_ACCEPTED" : c.kind === "REFUSED" ? "SENT_REFUSED" : "UNCERTAIN");
    const base = { flow_id: row.flow_id, from: "SUBMIT_INTENT_RECORDED" as const, expected_version: row.version, at_ms: now() };
    const rec = c.kind === "ACCEPTED"
      ? move({ ...base, op: "record_create_accepted", to: "SUBMITTED", set: { provider_transfer_id: c.provider_transfer_id, create_http_status: c.http_status, create_reported_status: c.reported_status }, event: { type: "PROVIDER_CREATE_ACCEPTED", actor: "server", data: { code: "CREATE_ACCEPTED_NOT_PAID", http_status: c.http_status, provider_transfer_id: c.provider_transfer_id, create_reported_status: c.reported_status, attempt_id: attemptId } } })
      : c.kind === "REFUSED"
        ? move({ ...base, op: "record_create_refused", to: "PROVIDER_REFUSED", set: { create_http_status: c.http_status }, event: { type: "PROVIDER_CREATE_REFUSED", actor: "server", data: { code: "PROVIDER_REFUSED", http_status: c.http_status, provider_code: c.provider_code, attempt_id: attemptId } } })
        : move({ ...base, op: "record_create_uncertain", to: "SUBMISSION_UNCERTAIN", set: c.http_status === null ? {} : { create_http_status: c.http_status }, event: { type: "PROVIDER_CREATE_UNCERTAIN", actor: "server", data: { code: c.code, http_status: c.http_status, attempt_id: attemptId } } });
    if (!rec.ok) {
      // stale-intent recovery already moved this flow to SUBMISSION_UNCERTAIN; the answer is noted, the state stands,
      // and only a provider read can move it
      note(store!, audit, row.flow_id, { type: "LATE_CREATE_RESPONSE", actor: "server", data: { classified: c.kind, http_status: c.http_status, code: rec.code } }, now());
      return { ok: false, code: "SUBMISSION_UNCERTAIN" };
    }
    if (c.kind === "ACCEPTED") {
      await postReductionOnce(row.flow_id);
      return { ok: true, code: "SUBMITTED" };
    }
    return { ok: false, code: c.kind === "REFUSED" ? "PROVIDER_REFUSED" : "SUBMISSION_UNCERTAIN" };
  }

  async function reconcile(actor: string, flowId: unknown): Promise<FlowResult> {
    const op = "reconcile";
    const down = unavailable();
    if (down) return { ok: false, code: down };
    let row = store!.getRow(flowId);
    if (!row) return { ok: false, code: "UNKNOWN_FLOW" };
    const readable: FlowState[] = ["SUBMIT_INTENT_RECORDED", "SUBMITTED", "SUBMISSION_UNCERTAIN", "PROVIDER_SCHEDULED", "PROVIDER_PROCESSING", "PROVIDER_FAILED", "PROVIDER_PAID"];
    if (!readable.includes(row.state)) return refuse(row, actor, op, "WRONG_STATE");
    if (row.state === "SUBMIT_INTENT_RECORDED") {
      if (row.attempt_recorded_at_ms === null || now() - row.attempt_recorded_at_ms < INTENT_STALE_MS) return refuse(row, actor, op, "SUBMISSION_IN_FLIGHT");
      const m = move({ flow_id: row.flow_id, op: "recover_stale_intent", from: "SUBMIT_INTENT_RECORDED", expected_version: row.version, to: "SUBMISSION_UNCERTAIN", event: { type: "STALE_INTENT_RECOVERED", actor: actorLabel(actor), data: { code: "INTERRUPTED_AFTER_INTENT", attempt_id: row.attempt_id } }, at_ms: now() });
      if (!m.ok) return refuse(row, actor, op, m.code);
      row = m.row;
    }
    const proposal = proposalOf(row);
    let answer: ProviderCallResult;
    try {
      answer = row.provider_transfer_id ? await deps.provider.readById(row.provider_transfer_id) : await deps.provider.readByRequestId(row.provider_request_id);
    } catch {
      answer = { kind: "TRANSPORT_ERROR", code: "PROVIDER_CALL_FAILED" };
    }
    hooks.afterRead?.();
    const c = classifyRead(answer, proposal, row.provider_transfer_id);
    if (c.kind === "NO_CHANGE") {
      // audit-only: nothing found, several found, a mismatch or a non-200 never changes the state
      note(store!, audit, row.flow_id, { type: "PROVIDER_READ_NO_CHANGE", actor: actorLabel(actor), data: { code: c.code, http_status: c.http_status } }, now());
      return { ok: false, code: c.code };
    }
    const to = PROVIDER_STATUS_TO_STATE[c.status];
    if (!to) return refuse(row, actor, op, "UNRECOGNIZED_PROVIDER_STATUS");
    if (row.state === "PROVIDER_PAID" || row.state === "PROVIDER_FAILED") {
      const same = to === row.state;
      note(store!, audit, row.flow_id, { type: same ? "PROVIDER_READ_CONFIRMED" : "PROVIDER_STATUS_REGRESSION", actor: actorLabel(actor), data: { provider_status: c.status, recorded_state: row.state } }, now());
      return same ? { ok: true, code: row.state } : { ok: false, code: "PROVIDER_STATUS_REGRESSION" };
    }
    const from = row.state as "SUBMITTED" | "SUBMISSION_UNCERTAIN" | "PROVIDER_SCHEDULED" | "PROVIDER_PROCESSING";
    const at = now();
    const r = move({
      flow_id: row.flow_id, op: "record_provider_read", from, expected_version: row.version, to,
      set: { last_provider_status: c.status, last_provider_read_at_ms: at, ...(row.provider_transfer_id ? {} : { provider_transfer_id: c.provider_transfer_id }) },
      event: { type: "PROVIDER_READ", actor: actorLabel(actor), data: { code: "PROVIDER_RECORD_MATCHES", provider_transfer_id: c.provider_transfer_id, provider_status: c.status } }, at_ms: at,
    });
    if (!r.ok) return refuse(row, actor, op, r.code);
    if (from === "SUBMISSION_UNCERTAIN") await postReductionOnce(row.flow_id); // the first matching read out of UNCERTAIN
    return { ok: true, code: to };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Read models. Built only from stored columns; nothing is evaluated here.
  // -------------------------------------------------------------------------------------------------------------

  function getFlow(flowId: unknown): FlowRecordV1 | null {
    const row = store?.getRow(flowId);
    return row ? toRecord(row) : null;
  }

  function view(row: FlowRow): FlowView {
    const rec = toRecord(row);
    const { beneficiary_id, ...shownProposal } = rec.proposal;
    const g = rec.gate;
    let reasons = Object.fromEntries(PROOF_IDS.map((k) => [k, ""])) as Record<ProofId, string>;
    try {
      if (row.proof_reasons_json) reasons = { ...reasons, ...(JSON.parse(row.proof_reasons_json) as Record<ProofId, string>) };
    } catch { /* display text only */ }
    let auditView: FlowView["audit"] = { count: 0, head: rec.audit_head, verified: false, code: "AUDIT_CHAIN_BROKEN" };
    try {
      const whole = audit.verify(store!.db);
      const mine = audit.verify(store!.db, row.flow_id);
      auditView = whole.ok && mine.ok ? { count: mine.count, head: mine.head, verified: mine.head === rec.audit_head, code: mine.head === rec.audit_head ? null : "AUDIT_HEAD_MISMATCH" } : { count: 0, head: rec.audit_head, verified: false, code: "AUDIT_CHAIN_BROKEN" };
    } catch { /* stays unverified */ }
    return {
      flow_id: rec.flow_id, state: rec.state, version: rec.version, terminal: TERMINAL_STATES.includes(rec.state),
      proposal: { ...shownProposal, beneficiary_id_suffix: beneficiary_id.slice(-4), amount_display: fromMinor(BigInt(rec.proposal.amount_minor)) },
      gate: g ? { decision: g.decision, rule: g.rule, gate_refused: g.gate_refused, proof_states: g.proof_states, evidence_source: g.evidence_source, document_id: g.document_id, document_binding: g.document_binding, evaluated_at_ms: g.evaluated_at_ms, expires_at_ms: g.expires_at_ms, policy_version: g.policy_version, proof_reasons: reasons } : null,
      authorization: rec.authorization ? { operator_id: rec.authorization.operator_id, approved_at_ms: rec.authorization.approved_at_ms, expires_at_ms: rec.authorization.expires_at_ms } : null,
      ledger: rec.ledger ? { ...rec.ledger, label: "drawn against allocation" } : null,
      submission: rec.submission,
      audit: auditView,
      echo: { proposal_digest: rec.proposal_digest, gate_digest: g?.gate_digest ?? null, authorization_digest: rec.authorization?.authorization_digest ?? null },
      balance_display: g && g.balance_minor !== null && /^-?[0-9]{1,18}$/.test(g.balance_minor) ? fromMinor(BigInt(g.balance_minor)) : null,
      provider_mode: (rec.submission.provider_mode ?? deps.providerMode),
      flags: { ledger: deps.ledger !== null, e3: false, external_audit: false },
    };
  }

  function getFlowView(flowId: unknown): FlowView | null {
    const row = store?.getRow(flowId);
    try {
      return row ? view(row) : null;
    } catch {
      return null;
    }
  }

  function listFlowViews(): FlowView[] {
    if (!store) return [];
    const out: FlowView[] = [];
    for (const row of store.listRows()) {
      try {
        out.push(view(row));
      } catch { /* an unreadable row is not shown */ }
    }
    return out;
  }

  return { createFlow, attachEvidence, evaluateGate, requestHumanReview, approve, reject, submit, reconcile, getFlow, getFlowView, listFlowViews };
}
