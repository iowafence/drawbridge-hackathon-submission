// Human-approved SANDBOX transfer workflow. Server-side only. All state is derived from the audit chain.
//
//   DRAFT -> REVIEW_REQUIRED -> HUMAN_APPROVED -> VALIDATED -> SUBMITTED_TO_AIRWALLEX -> PROVIDER_STATUS_RECONCILED
//
// Side states: REJECTED, PROVIDER_REFUSED (terminal), OUTCOME_UNKNOWN (stop and reconcile; never resubmitted).
// Nothing here trusts the browser: every transition re-checks state, approval, expiry and the request digest on the
// server. A transfer record is immutable after it is drafted; there is no edit operation.
import { openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AuditLog, canonical, sha256 } from "./audit.ts";
import type { AuditData, AuditEvent } from "./audit.ts";
import { AwxError } from "./awx.ts";
import type { AwxResponse, SandboxClient } from "./awx.ts";
import { CURRENCY, DEMO_CAP_MINOR, evaluate, fromMinor, PROPOSAL, toMinor } from "./policy.ts";
import type { Proposal } from "./policy.ts";

export const APPROVAL_TTL_MS = 10 * 60_000;
/** Initial integration validation: at most one create request, ever, per audit chain. */
export const MAX_SUBMISSIONS = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Status names inferred from Airwallex's documented transfer webhook events. Anything else is treated as unrecognized.
export const KNOWN_PROVIDER_STATUS = new Set(["IN_APPROVAL", "APPROVAL_BLOCKED", "APPROVAL_RECALLED", "APPROVAL_REJECTED", "SCHEDULED", "OVERDUE", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLATION_REQUESTED", "CANCELLED"]);

export type State = "DRAFT" | "REVIEW_REQUIRED" | "HUMAN_APPROVED" | "VALIDATED" | "SUBMITTING" | "SUBMITTED_TO_AIRWALLEX" | "PROVIDER_STATUS_RECONCILED" | "REJECTED" | "PROVIDER_REFUSED" | "OUTCOME_UNKNOWN";

export type Transfer = {
  request_id: string;
  proposal_id: string;
  beneficiary_id: string;
  beneficiary_label: string;
  amount_minor: string;
  currency: string;
  reference: string;
  reason: string;
  transfer_method: string;
  digest: string;
  state: State;
  approved_by: string | null;
  approval_expires: number | null;
  provider_transfer_id: string | null;
  provider_status: string | null;
  provider_status_at: string | null;
  last_code: string | null;
};

export type Ctx = {
  audit: AuditLog;
  now: () => number;
  /** beneficiary_id -> label. Only these sandbox test beneficiaries can ever be paid. */
  allowlist: Map<string, string>;
  /** Throws AwxError with a fixed code when the transfer credential is absent (fail closed). */
  transferClient: () => SandboxClient;
  /** Exact decimal text of the sandbox USD available balance, or null when it cannot be read. */
  availableUsd: () => Promise<string | null>;
  /** Owner release for one exact transaction: "<request_id>:<digest>". Absent means no create request can be sent. */
  release: string | undefined;
};

export type Result = { ok: boolean; code: string };

/** Approval binds to exactly these fields. Any difference is a different digest. */
export function requestDigest(t: Pick<Transfer, "beneficiary_id" | "amount_minor" | "currency" | "reference" | "request_id" | "reason" | "transfer_method">): string {
  return sha256(canonical({ beneficiary_id: t.beneficiary_id, amount_minor: t.amount_minor, currency: t.currency, reference: t.reference, request_id: t.request_id, reason: t.reason, transfer_method: t.transfer_method }));
}

/** Only documented fields; the amount is exact decimal text, never a float. */
export function providerBody(t: Transfer): Record<string, string> {
  return {
    beneficiary_id: t.beneficiary_id,
    transfer_amount: fromMinor(BigInt(t.amount_minor)),
    transfer_currency: t.currency,
    source_currency: t.currency,
    transfer_method: t.transfer_method,
    reason: t.reason,
    reference: t.reference,
    request_id: t.request_id,
  };
}

// The only state changes an event may make. An event that does not fit (for example a response that arrives after the
// request has already moved on) is ignored entirely when the chain is folded.
const LEGAL: Record<string, { from: State[]; to: State[] }> = {
  REVIEW_REQUESTED: { from: ["DRAFT"], to: ["REVIEW_REQUIRED"] },
  HUMAN_APPROVED: { from: ["REVIEW_REQUIRED"], to: ["HUMAN_APPROVED"] },
  HUMAN_REJECTED: { from: ["REVIEW_REQUIRED"], to: ["REJECTED"] },
  VALIDATION_RESULT: { from: ["HUMAN_APPROVED"], to: ["VALIDATED"] },
  SUBMISSION_ATTEMPTED: { from: ["VALIDATED"], to: ["SUBMITTING"] },
  PROVIDER_RESPONSE: { from: ["SUBMITTING"], to: ["SUBMITTED_TO_AIRWALLEX", "PROVIDER_REFUSED", "OUTCOME_UNKNOWN"] },
  RECONCILIATION_RESULT: { from: ["SUBMITTING", "SUBMITTED_TO_AIRWALLEX", "PROVIDER_STATUS_RECONCILED", "OUTCOME_UNKNOWN"], to: ["PROVIDER_STATUS_RECONCILED"] },
};

export function fold(events: AuditEvent[]): Map<string, Transfer> {
  const out = new Map<string, Transfer>();
  for (const e of events) {
    const d = e.data;
    if (e.type === "DRAFT_CREATED" && e.transfer) {
      out.set(e.transfer, {
        request_id: e.transfer, proposal_id: String(d.proposal_id), beneficiary_id: String(d.beneficiary_id), beneficiary_label: String(d.beneficiary_label),
        amount_minor: String(d.amount_minor), currency: String(d.currency), reference: String(d.reference), reason: String(d.reason), transfer_method: String(d.transfer_method),
        digest: String(d.digest), state: "DRAFT", approved_by: null, approval_expires: null, provider_transfer_id: null, provider_status: null, provider_status_at: null, last_code: null,
      });
      continue;
    }
    const t = e.transfer ? out.get(e.transfer) : undefined;
    if (!t) continue;
    if (typeof d.state === "string") {
      const rule = LEGAL[e.type];
      if (!rule || !rule.from.includes(t.state) || !rule.to.includes(d.state as State)) continue;
      t.state = d.state as State;
    }
    if (typeof d.code === "string") t.last_code = d.code;
    if (e.type === "HUMAN_APPROVED") {
      t.approved_by = e.actor;
      t.approval_expires = Number(d.expires_ms);
    }
    if (typeof d.provider_transfer_id === "string") t.provider_transfer_id = d.provider_transfer_id;
    if (typeof d.provider_status === "string") {
      t.provider_status = d.provider_status;
      t.provider_status_at = e.ts;
    }
  }
  return out;
}

function load(ctx: Ctx, id: unknown): Transfer | null {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const t = fold(ctx.audit.read()).get(id);
  // the stored record must still hash to its own digest; a modified record is refused everywhere
  return t && requestDigest(t) === t.digest ? t : null;
}

function refuse(ctx: Ctx, t: Transfer | null, actor: string, op: string, code: string): Result {
  ctx.audit.append("REFUSED", t?.request_id ?? null, actor, { op, code }, ctx.now());
  return { ok: false, code };
}

function localChecks(ctx: Ctx, t: Transfer): string | null {
  if (!ctx.allowlist.has(t.beneficiary_id)) return "BENEFICIARY_NOT_ALLOWLISTED";
  if (t.currency !== CURRENCY) return "CURRENCY_NOT_APPROVED";
  let minor: bigint;
  try {
    minor = BigInt(t.amount_minor);
  } catch {
    return "INVALID_AMOUNT";
  }
  if (minor <= 0n) return "INVALID_AMOUNT";
  if (minor > DEMO_CAP_MINOR) return "ABOVE_DEMO_CAP";
  if (!/^[A-Za-z0-9-]{1,32}$/.test(t.reference)) return "INVALID_REFERENCE";
  if (t.transfer_method !== "LOCAL") return "METHOD_NOT_APPROVED";
  if (!/^[a-z_]{3,40}$/.test(t.reason)) return "INVALID_REASON";
  return null;
}

function approvalProblem(ctx: Ctx, t: Transfer, digest: unknown): string | null {
  if (digest !== t.digest) return "REQUEST_CHANGED_OR_DIGEST_MISMATCH";
  if (!t.approved_by || !t.approved_by.startsWith("human:") || t.approval_expires === null) return "NOT_HUMAN_APPROVED";
  if (ctx.now() >= t.approval_expires) return "APPROVAL_EXPIRED";
  return null;
}

/** Draft the fixed synthetic proposal for one allowlisted test beneficiary. No free-form destination or amount. */
export function createDraft(ctx: Ctx, actor: string, beneficiaryId: unknown, proposal: Proposal = PROPOSAL): Result & { request_id?: string } {
  if (typeof beneficiaryId !== "string" || !ctx.allowlist.has(beneficiaryId)) return refuse(ctx, null, actor, "draft", "BENEFICIARY_NOT_ALLOWLISTED");
  let minor: bigint;
  try {
    minor = toMinor(proposal.amount);
  } catch {
    return refuse(ctx, null, actor, "draft", "INVALID_AMOUNT");
  }
  const t: Transfer = {
    request_id: randomUUID(), proposal_id: proposal.proposal_id, beneficiary_id: beneficiaryId, beneficiary_label: ctx.allowlist.get(beneficiaryId)!,
    amount_minor: minor.toString(), currency: proposal.currency, reference: proposal.reference, reason: proposal.reason, transfer_method: proposal.transfer_method,
    digest: "", state: "DRAFT", approved_by: null, approval_expires: null, provider_transfer_id: null, provider_status: null, provider_status_at: null, last_code: null,
  };
  const bad = localChecks(ctx, t);
  if (bad) return refuse(ctx, null, actor, "draft", bad);
  t.digest = requestDigest(t);
  ctx.audit.append("DRAFT_CREATED", t.request_id, actor, {
    proposal_id: t.proposal_id, beneficiary_id: t.beneficiary_id, beneficiary_label: t.beneficiary_label, amount_minor: t.amount_minor, currency: t.currency,
    reference: t.reference, reason: t.reason, transfer_method: t.transfer_method, digest: t.digest, state: "DRAFT",
  }, ctx.now());
  return { ok: true, code: "DRAFT_CREATED", request_id: t.request_id };
}

export function requestReview(ctx: Ctx, actor: string, id: unknown): Result {
  const t = load(ctx, id);
  if (!t) return refuse(ctx, null, actor, "review", "UNKNOWN_TRANSFER");
  if (t.state !== "DRAFT") return refuse(ctx, t, actor, "review", "WRONG_STATE");
  ctx.audit.append("REVIEW_REQUESTED", t.request_id, actor, { state: "REVIEW_REQUIRED" }, ctx.now());
  return { ok: true, code: "REVIEW_REQUIRED" };
}

/** `actor` must be an authenticated human operator who has just re-entered the passphrase (enforced by the caller). */
export async function decide(ctx: Ctx, actor: string, id: unknown, digest: unknown, approve: boolean): Promise<Result> {
  const t = load(ctx, id);
  if (!t) return refuse(ctx, null, actor, "decide", "UNKNOWN_TRANSFER");
  if (!actor.startsWith("human:")) return refuse(ctx, t, actor, "decide", "HUMAN_OPERATOR_REQUIRED");
  if (t.state !== "REVIEW_REQUIRED") return refuse(ctx, t, actor, "decide", "WRONG_STATE");
  if (digest !== t.digest) return refuse(ctx, t, actor, "decide", "REQUEST_CHANGED_OR_DIGEST_MISMATCH");
  if (!approve) {
    ctx.audit.append("HUMAN_REJECTED", t.request_id, actor, { state: "REJECTED", digest: t.digest }, ctx.now());
    return { ok: true, code: "REJECTED" };
  }
  const bad = localChecks(ctx, t);
  if (bad) return refuse(ctx, t, actor, "decide", bad);
  // deterministic policy on the live sandbox balance decides eligibility; the human can only approve an ALLOW
  const decision = evaluate(await ctx.availableUsd(), { ...PROPOSAL, amount: fromMinor(BigInt(t.amount_minor)), currency: t.currency });
  if (decision.recommendation !== "ALLOW") return refuse(ctx, t, actor, "decide", `POLICY_HOLD ${decision.rule}`);
  if (load(ctx, id)?.state !== "REVIEW_REQUIRED") return refuse(ctx, t, actor, "decide", "STATE_CHANGED_DURING_REQUEST"); // re-check after the await
  const expires = ctx.now() + APPROVAL_TTL_MS;
  ctx.audit.append("HUMAN_APPROVED", t.request_id, actor, { state: "HUMAN_APPROVED", digest: t.digest, policy_rule: decision.rule, expires_ms: expires, expires_at: new Date(expires).toISOString() }, ctx.now());
  return { ok: true, code: "HUMAN_APPROVED" };
}

function client(ctx: Ctx): SandboxClient | string {
  try {
    return ctx.transferClient();
  } catch (e) {
    return e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED";
  }
}

const providerCode = (r: AwxResponse) => String((r.body as { code?: string } | null)?.code ?? "").slice(0, 60);

/** Non-executing provider check that an agent may run while PREPARING a request (before the human decision).
 *  It calls POST /transfers/validate only, creates nothing, and never changes the workflow state: the human approval
 *  and the formal VALIDATED step are still required afterwards. */
export async function prevalidate(ctx: Ctx, actor: string, id: unknown): Promise<Result & { httpStatus?: number; providerCode?: string; source?: string }> {
  const t = load(ctx, id);
  if (!t) return refuse(ctx, null, actor, "prevalidate", "UNKNOWN_TRANSFER");
  if (t.state !== "DRAFT" && t.state !== "REVIEW_REQUIRED") return refuse(ctx, t, actor, "prevalidate", "WRONG_STATE");
  const bad = localChecks(ctx, t);
  if (bad) return refuse(ctx, t, actor, "prevalidate", bad);
  const decision = evaluate(await ctx.availableUsd(), { ...PROPOSAL, amount: fromMinor(BigInt(t.amount_minor)), currency: t.currency });
  const c = client(ctx);
  if (typeof c === "string") return refuse(ctx, t, actor, "prevalidate", c);
  let res: AwxResponse;
  try {
    res = await c.request("POST", "/transfers/validate", providerBody(t));
  } catch (e) {
    return refuse(ctx, t, actor, "prevalidate", e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED");
  }
  const ok = res.status === 200;
  const source = String((res.body as { source?: string } | null)?.source ?? "").slice(0, 60);
  ctx.audit.append("PREVALIDATION_RESULT", t.request_id, actor, {
    http_status: res.status, code: ok ? "PROVIDER_PREVALIDATION_PASSED" : "PROVIDER_PREVALIDATION_FAILED", provider_code: ok ? "" : providerCode(res), provider_source: ok ? "" : source,
    policy: decision.recommendation, policy_rule: decision.rule, creates_transfer: false,
  }, ctx.now());
  return { ok, code: ok ? "PROVIDER_PREVALIDATION_PASSED" : "PROVIDER_PREVALIDATION_FAILED", httpStatus: res.status, providerCode: providerCode(res), source };
}

/** POST /transfers/validate. Creates nothing at the provider. */
export async function validate(ctx: Ctx, actor: string, id: unknown, digest: unknown): Promise<Result> {
  const t = load(ctx, id);
  if (!t) return refuse(ctx, null, actor, "validate", "UNKNOWN_TRANSFER");
  if (t.state !== "HUMAN_APPROVED") return refuse(ctx, t, actor, "validate", "WRONG_STATE");
  const bad = approvalProblem(ctx, t, digest) ?? localChecks(ctx, t);
  if (bad) return refuse(ctx, t, actor, "validate", bad);
  const c = client(ctx);
  if (typeof c === "string") return refuse(ctx, t, actor, "validate", c);
  let res: AwxResponse;
  try {
    res = await c.request("POST", "/transfers/validate", providerBody(t));
  } catch (e) {
    return refuse(ctx, t, actor, "validate", e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED");
  }
  if (load(ctx, id)?.state !== "HUMAN_APPROVED") return refuse(ctx, t, actor, "validate", "STATE_CHANGED_DURING_REQUEST"); // re-check after the await
  if (res.status === 200) {
    ctx.audit.append("VALIDATION_RESULT", t.request_id, actor, { state: "VALIDATED", http_status: 200, code: "PROVIDER_VALIDATION_PASSED" }, ctx.now());
    return { ok: true, code: "VALIDATED" };
  }
  ctx.audit.append("VALIDATION_RESULT", t.request_id, actor, { http_status: res.status, code: "PROVIDER_VALIDATION_FAILED", provider_code: providerCode(res) }, ctx.now());
  return { ok: false, code: "PROVIDER_VALIDATION_FAILED" };
}

/** POST /transfers/create, at most once. An unclear outcome stops in OUTCOME_UNKNOWN; it is never retried. */
export async function submit(ctx: Ctx, actor: string, id: unknown, digest: unknown): Promise<Result> {
  const t = load(ctx, id);
  if (!t) return refuse(ctx, null, actor, "submit", "UNKNOWN_TRANSFER");
  if (!actor.startsWith("human:")) return refuse(ctx, t, actor, "submit", "HUMAN_OPERATOR_REQUIRED");
  if (t.state !== "VALIDATED") return refuse(ctx, t, actor, "submit", t.state === "SUBMITTING" || t.provider_transfer_id ? "DUPLICATE_SUBMISSION" : "WRONG_STATE");
  const bad = approvalProblem(ctx, t, digest) ?? localChecks(ctx, t);
  if (bad) return refuse(ctx, t, actor, "submit", bad);
  if (!ctx.release || ctx.release !== `${t.request_id}:${t.digest}`) return refuse(ctx, t, actor, "submit", "OWNER_RELEASE_MISSING");
  if (ctx.audit.read().filter((e) => e.type === "SUBMISSION_ATTEMPTED").length >= MAX_SUBMISSIONS) return refuse(ctx, t, actor, "submit", "SUBMISSION_LIMIT_REACHED");
  const c = client(ctx);
  if (typeof c === "string") return refuse(ctx, t, actor, "submit", c);
  try {
    closeSync(openSync(join(ctx.audit.dir, `submit-${t.request_id}.lock`), "wx", 0o600)); // one-time, never removed
  } catch {
    return refuse(ctx, t, actor, "submit", "DUPLICATE_SUBMISSION");
  }
  ctx.audit.append("SUBMISSION_ATTEMPTED", t.request_id, actor, { state: "SUBMITTING", digest: t.digest }, ctx.now());
  const unknown = (code: string, extra: AuditData = {}): Result => {
    ctx.audit.append("PROVIDER_RESPONSE", t.request_id, "server", { state: "OUTCOME_UNKNOWN", code, ...extra }, ctx.now());
    return { ok: false, code: "OUTCOME_UNKNOWN" };
  };
  let res: AwxResponse;
  try {
    res = await c.request("POST", "/transfers/create", providerBody(t));
  } catch (e) {
    return unknown(e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED");
  }
  const body = res.body as { id?: unknown; status?: unknown; request_id?: unknown } | null;
  if (res.status === 200 || res.status === 201) {
    if (!body || typeof body.id !== "string" || !UUID.test(body.id) || typeof body.status !== "string" || !KNOWN_PROVIDER_STATUS.has(body.status) || body.request_id !== t.request_id) {
      return unknown("UNRECOGNIZED_PROVIDER_RESPONSE", { http_status: res.status });
    }
    ctx.audit.append("PROVIDER_RESPONSE", t.request_id, "server", { state: "SUBMITTED_TO_AIRWALLEX", http_status: res.status, provider_transfer_id: body.id, provider_status: body.status, code: "CREATE_ACCEPTED_NOT_PAID" }, ctx.now());
    return { ok: true, code: "SUBMITTED_TO_AIRWALLEX" };
  }
  const code = providerCode(res);
  // a definite refusal of this request; everything else (5xx, 409 pending, 429, duplicate) is unclear and must be reconciled
  if ([400, 401, 403, 404, 422].includes(res.status) && code !== "request_id_duplicate") {
    ctx.audit.append("PROVIDER_RESPONSE", t.request_id, "server", { state: "PROVIDER_REFUSED", http_status: res.status, provider_code: code, code: "PROVIDER_REFUSED" }, ctx.now());
    return { ok: false, code: "PROVIDER_REFUSED" };
  }
  return unknown("AMBIGUOUS_PROVIDER_STATUS", { http_status: res.status, provider_code: code });
}

/** Read the provider's own record (by transfer id, else by request_id). Read-only; never creates anything. */
export async function reconcile(ctx: Ctx, actor: string, id: unknown): Promise<Result> {
  const t = load(ctx, id);
  if (!t) return refuse(ctx, null, actor, "reconcile", "UNKNOWN_TRANSFER");
  if (!["SUBMITTING", "SUBMITTED_TO_AIRWALLEX", "PROVIDER_STATUS_RECONCILED", "OUTCOME_UNKNOWN"].includes(t.state)) return refuse(ctx, t, actor, "reconcile", "WRONG_STATE");
  const c = client(ctx);
  if (typeof c === "string") return refuse(ctx, t, actor, "reconcile", c);
  const note = (code: string, extra: AuditData = {}): Result => {
    ctx.audit.append("RECONCILIATION_RESULT", t.request_id, actor, { code, ...extra }, ctx.now());
    return { ok: false, code };
  };
  let res: AwxResponse;
  try {
    res = await c.request("GET", t.provider_transfer_id ? `/transfers/${t.provider_transfer_id}` : `/transfers?request_id=${t.request_id}`);
  } catch (e) {
    return note(e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED");
  }
  if (res.status !== 200) return note("RECONCILE_HTTP_STATUS", { http_status: res.status });
  let rec = res.body as Record<string, unknown> | null;
  if (!t.provider_transfer_id) {
    const items = (rec as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return note("UNRECOGNIZED_PROVIDER_RESPONSE");
    const mine = items.filter((x) => x && typeof x === "object" && (x as Record<string, unknown>).request_id === t.request_id);
    if (mine.length === 0) return note("PROVIDER_HAS_NO_RECORD_FOR_REQUEST_ID");
    if (mine.length > 1) return note("PROVIDER_HAS_MULTIPLE_RECORDS");
    rec = mine[0] as Record<string, unknown>;
  }
  if (!rec || typeof rec.id !== "string" || !UUID.test(rec.id) || typeof rec.status !== "string") return note("UNRECOGNIZED_PROVIDER_RESPONSE");
  let amountOk = false;
  try {
    amountOk = toMinor(String(rec.transfer_amount)).toString() === t.amount_minor;
  } catch {
    amountOk = false;
  }
  if (rec.request_id !== t.request_id || rec.transfer_currency !== t.currency || !amountOk || (t.provider_transfer_id && rec.id !== t.provider_transfer_id)) return note("PROVIDER_RECORD_MISMATCH");
  if (!KNOWN_PROVIDER_STATUS.has(rec.status)) return note("UNRECOGNIZED_PROVIDER_STATUS");
  ctx.audit.append("RECONCILIATION_RESULT", t.request_id, actor, { state: "PROVIDER_STATUS_RECONCILED", http_status: 200, provider_transfer_id: rec.id, provider_status: rec.status, code: "PROVIDER_RECORD_MATCHES" }, ctx.now());
  return { ok: true, code: "PROVIDER_STATUS_RECONCILED" };
}

export function listTransfers(ctx: Ctx): { transfers: Transfer[]; events: AuditEvent[] } {
  const events = ctx.audit.read();
  return { transfers: [...fold(events).values()], events };
}
