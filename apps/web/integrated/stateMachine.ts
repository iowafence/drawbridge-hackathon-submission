// DRAWBRIDGE integrated flow (contract flow-v1 section 6): compare-and-swap state machine. OWNER: A3.
//
// Every state change in the integrated flow goes through `transition` below and nowhere else. One call is one
// BEGIN IMMEDIATE transaction that
//   1. checks the operation is legal for (from, to) in the contract table (isLegal),
//   2. re-reads the row and requires it to be exactly at (from, expected version),
//   3. runs the caller's extra inserts (authorization row, submit-attempt row) in the same transaction,
//   4. appends the audit event through the audit port (same file, same transaction),
//   5. UPDATE flow SET state, version = version + 1, audit_head, ... WHERE flow_id AND state = from AND version = expected,
//      which must change exactly one row,
// and then commits. If any step fails, nothing is written. There is no other writer of `state` or `version`.
import { isLegal } from "./flowTypes.ts";
import type { AuditPort, FlowAuditInput, FlowOp, FlowState } from "./flowTypes.ts";
import { FlowStoreError, WRITABLE } from "./flowStore.ts";
import type { FlowRow, FlowStore } from "./flowStore.ts";

export type AuditData = FlowAuditInput["data"];
export type Fields = Partial<Record<string, string | number | null>>;

export type TransitionInput = {
  flow_id: string;
  op: FlowOp;
  from: FlowState;
  expected_version: number;
  to: FlowState;
  /** Column values written with the transition. Only columns in the store's WRITABLE set are accepted. */
  set?: Fields;
  /** Extra statements that must commit with the transition (authorization row, submit-attempt row). */
  extra?: () => void;
  event: { type: string; actor: string; data: AuditData };
  at_ms: number;
};

export type TransitionResult = { ok: true; row: FlowRow } | { ok: false; code: string };

class Refused extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const CONSTRAINT = /(FLOW_[A-Z_]+|ATTEMPT_[A-Z_]+|AUTHORIZATION_[A-Z_]+|SUBMISSION_LIMIT_REACHED)/;

function codeOfError(e: unknown): string {
  if (e instanceof Refused || e instanceof FlowStoreError) return e.code;
  const msg = String((e as Error)?.message ?? "");
  const m = CONSTRAINT.exec(msg);
  if (m) return m[1];
  if (/UNIQUE constraint failed: flow_submit_attempt/.test(msg)) return "DUPLICATE_SUBMISSION";
  if (/UNIQUE constraint failed: flow_authorization/.test(msg)) return "GATE_ALREADY_CONSUMED";
  if (/UNIQUE constraint failed/.test(msg)) return "STORE_UNIQUE_VIOLATION";
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === "string" && /^(AUDIT|CANON)_[A-Z_]+$/.test(c)) return c;
  return "STORE_WRITE_FAILED";
}

/** The single compare-and-swap. Returns the new row, or a fixed refusal code and no change at all. */
export function transition(store: FlowStore, audit: AuditPort, t: TransitionInput): TransitionResult {
  if (!isLegal(t.op, t.from, t.to)) return { ok: false, code: "ILLEGAL_TRANSITION" };
  const set = t.set ?? {};
  const keys = Object.keys(set);
  for (const k of keys) if (!WRITABLE.has(k)) return { ok: false, code: "STORE_FIELD_REFUSED" };
  try {
    return store.tx((): TransitionResult => {
      const cur = store.getRow(t.flow_id);
      if (!cur) throw new Refused("UNKNOWN_FLOW");
      if (cur.state !== t.from) throw new Refused("WRONG_STATE");
      if (cur.version !== t.expected_version) throw new Refused("CONCURRENT_MODIFICATION");
      t.extra?.();
      const ev = audit.append(store.db, { flow_id: t.flow_id, type: t.event.type, actor: t.event.actor, from_state: t.from, to_state: t.to, flow_version: t.expected_version + 1, data: t.event.data, at_ms: t.at_ms });
      const sets = ["state = ?", "version = version + 1", "audit_head = ?", "updated_at_ms = ?", ...keys.map((k) => `${k} = ?`)];
      const res = store.db.prepare(`UPDATE flow SET ${sets.join(", ")} WHERE flow_id = ? AND state = ? AND version = ?`)
        .run(t.to, ev.hash, t.at_ms, ...keys.map((k) => set[k] ?? null), t.flow_id, t.from, t.expected_version);
      if (Number(res.changes) !== 1) throw new Refused("CONCURRENT_MODIFICATION");
      return { ok: true, row: store.getRow(t.flow_id)! };
    });
  } catch (e) {
    return { ok: false, code: codeOfError(e) };
  }
}

/** Creates the DRAFT row and its first audit event in one transaction (create_flow: no prior state). */
export function createDraft(store: FlowStore, audit: AuditPort, f: { flow_id: string; created_by: string; proposal_json: string; proposal_digest: string; provider_request_id: string; obligation_id: string; data: AuditData; at_ms: number }): TransitionResult {
  if (!isLegal("create_flow", null, "DRAFT")) return { ok: false, code: "ILLEGAL_TRANSITION" };
  try {
    return store.tx((): TransitionResult => {
      store.db.prepare("INSERT INTO flow (flow_id, created_at_ms, created_by, proposal_json, proposal_digest, provider_request_id, obligation_id, state, version, audit_head, updated_at_ms) VALUES (?,?,?,?,?,?,?,'DRAFT',1,?,?)")
        .run(f.flow_id, f.at_ms, f.created_by, f.proposal_json, f.proposal_digest, f.provider_request_id, f.obligation_id, "0".repeat(64), f.at_ms);
      const ev = audit.append(store.db, { flow_id: f.flow_id, type: "FLOW_CREATED", actor: f.created_by, from_state: null, to_state: "DRAFT", flow_version: 1, data: f.data, at_ms: f.at_ms });
      store.db.prepare("UPDATE flow SET audit_head = ?, updated_at_ms = ? WHERE flow_id = ?").run(ev.hash, f.at_ms, f.flow_id);
      return { ok: true, row: store.getRow(f.flow_id)! };
    });
  } catch (e) {
    return { ok: false, code: codeOfError(e) };
  }
}

/** Audit-only event: the flow's state and version do not change (refusals, reads that change nothing, ledger notes).
 *  Returns false when the event could not be recorded; the caller's refusal stands either way. */
export function note(store: FlowStore, audit: AuditPort, flow_id: string, event: { type: string; actor: string; data: AuditData }, at_ms: number, set: { ledger_json?: string } = {}): boolean {
  try {
    return store.tx(() => {
      const cur = store.getRow(flow_id);
      if (!cur) return false;
      const ev = audit.append(store.db, { flow_id, type: event.type, actor: event.actor, from_state: cur.state, to_state: null, flow_version: cur.version, data: event.data, at_ms });
      if (set.ledger_json !== undefined) store.db.prepare("UPDATE flow SET audit_head = ?, updated_at_ms = ?, ledger_json = ? WHERE flow_id = ?").run(ev.hash, at_ms, set.ledger_json, flow_id);
      else store.db.prepare("UPDATE flow SET audit_head = ?, updated_at_ms = ? WHERE flow_id = ?").run(ev.hash, at_ms, flow_id);
      return true;
    });
  } catch {
    return false;
  }
}
