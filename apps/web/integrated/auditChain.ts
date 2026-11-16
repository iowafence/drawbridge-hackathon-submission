// DRAWBRIDGE integrated flow — audit chain DB_INTEGRATED_FLOW_V1 (contract flow-v1 §10). OWNER: A5.
//
// Implements AuditPort. The flow service calls append() INSIDE its own open transaction, on the same SQLite file as
// the flow state, so a state change and its audit event commit or roll back together.
//
// Chain: `seq` is global and contiguous from 1; `prev` links each event to the previous event OF THE SAME FLOW
// (64 zeroes for a flow's first event); `hash` = flowDigest("audit_event", event minus hash).
//
// What this is NOT: tamper proof. The chain is unkeyed and lives in a local file. Anyone who can write that file can
// rewrite or shorten the chain and recompute every hash, and verify() will pass. The append-only triggers below stop
// application mistakes, not a person with file access (they can be dropped). docs/integrated/AUDIT_THREAT_MODEL.md.
//
// Never stored: credentials, raw provider bodies, evidence text. Only fixed-shape scalars are accepted (see append).
import { canonicalText, flowDigest } from "./flowCanonical.ts";
import { LEGAL_TRANSITIONS } from "./flowTypes.ts";
import type { AuditPort, FlowAuditEvent, FlowAuditInput, SqlTx } from "./flowTypes.ts";

export const AUDIT_CHAIN = "DB_INTEGRATED_FLOW_V1" as const;
export const AUDIT_ZERO = "0".repeat(64);
export const AUDIT_TABLE = "integrated_audit_event";
export const AUDIT_MAX_STRING = 300;

/** Same pattern as the historic audit.ts FORBIDDEN_KEY (not exported there). A test pins the two source texts equal. */
export const AUDIT_FORBIDDEN_KEY = /key|token|secret|password|passphrase|authorization|account_number|routing|iban|swift|bank/i;

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;
const ACTOR = /^(?:server|system:recovery|human:[^\s\p{Cc}][^\p{Cc}]{0,79})$/u;
const DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/; // the CANON-1 key rule (flow-v1.1 R1)
const HEX64 = /^[0-9a-f]{64}$/;
const STATES: readonly string[] = [...new Set(Object.values(LEGAL_TRANSITIONS).flatMap((r) => r.to))];

/** Thrown by append(). `code` is AUDIT_FIELD_REFUSED or AUDIT_CHAIN_BROKEN; `detail` names the rule, never the value. */
export class AuditChainError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    super(`${code} ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

export type AuditVerifyFail = { ok: false; code: "AUDIT_CHAIN_BROKEN"; at_seq: number | null; detail: string };
export type AuditVerifyResult = { ok: true; count: number; head: string } | AuditVerifyFail;

/**
 * Heuristic screen for values that look like a credential or a raw payload. The schema already limits values to
 * short scalars under non-credential keys; this catches the obvious mistakes on top of that. It is a pattern check,
 * not a secret detector: a secret that looks like an ordinary identifier passes.
 */
function looksSensitive(s: string): string | null {
  if (/[\r\n]/.test(s)) return "VALUE_MULTILINE_TEXT"; // evidence text and raw bodies, not identifiers
  if (/bearer\s+\S/i.test(s) || /^basic\s+[A-Za-z0-9+/=]{8,}$/i.test(s)) return "VALUE_LOOKS_LIKE_CREDENTIAL";
  if (/-----BEGIN /.test(s) || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(s)) return "VALUE_LOOKS_LIKE_CREDENTIAL";
  if (/^\s*[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return "VALUE_LOOKS_LIKE_RAW_PAYLOAD";
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** Returns the name of the first rule the input breaks, or null. Never returns or logs the offending value. */
export function auditInputProblem(ev: unknown): string | null {
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return "EVENT_NOT_OBJECT";
  const e = ev as Record<string, unknown>;
  if (Object.keys(e).sort().join(",") !== "actor,at_ms,data,flow_id,flow_version,from_state,to_state,type") return "EVENT_KEYS";
  if (typeof e.flow_id !== "string" || !FLOW_ID.test(e.flow_id)) return "FLOW_ID";
  if (typeof e.type !== "string" || !TYPE.test(e.type)) return "TYPE";
  if (typeof e.actor !== "string" || !ACTOR.test(e.actor)) return "ACTOR";
  for (const k of ["from_state", "to_state"]) {
    const st = e[k];
    if (st !== null && (typeof st !== "string" || !STATES.includes(st))) return k.toUpperCase();
  }
  if (typeof e.flow_version !== "number" || !Number.isSafeInteger(e.flow_version) || e.flow_version < 0) return "FLOW_VERSION";
  if (typeof e.at_ms !== "number" || !Number.isSafeInteger(e.at_ms) || e.at_ms < 0) return "AT_MS";
  const d = e.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return "DATA_NOT_OBJECT";
  const proto = Object.getPrototypeOf(d);
  if (proto !== Object.prototype && proto !== null) return "DATA_NOT_PLAIN_OBJECT";
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (!DATA_KEY.test(k)) return "DATA_KEY_SHAPE";
    if (AUDIT_FORBIDDEN_KEY.test(k)) return "DATA_KEY_FORBIDDEN";
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) return "DATA_NUMBER_NOT_SAFE_INTEGER";
      continue;
    }
    if (typeof v !== "string") return "DATA_VALUE_NOT_SCALAR";
    if (v.length > AUDIT_MAX_STRING) return "DATA_STRING_TOO_LONG";
    const bad = looksSensitive(v);
    if (bad) return bad;
  }
  return null;
}

type Row = { seq: unknown; flow_id: unknown; type: unknown; actor: unknown; from_state: unknown; to_state: unknown; flow_version: unknown; data: unknown; at_ms: unknown; prev: unknown; hash: unknown };
const COLS = "seq, flow_id, type, actor, from_state, to_state, flow_version, data, at_ms, prev, hash";
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number));

/** Rebuilds an event from a stored row and checks it in isolation. Returns the event or the name of the defect. */
function eventFromRow(r: Row): FlowAuditEvent | string {
  const seq = num(r.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) return "ROW_SEQ";
  if (typeof r.prev !== "string" || !HEX64.test(r.prev) || typeof r.hash !== "string" || !HEX64.test(r.hash) || typeof r.data !== "string") return "ROW_MALFORMED";
  let data: unknown;
  try {
    data = JSON.parse(r.data);
  } catch {
    return "ROW_DATA_NOT_JSON";
  }
  const input = { flow_id: r.flow_id, type: r.type, actor: r.actor, from_state: r.from_state, to_state: r.to_state, flow_version: num(r.flow_version), data, at_ms: num(r.at_ms) };
  const bad = auditInputProblem(input);
  if (bad) return `ROW_${bad}`;
  const rest = { ...(input as FlowAuditInput), chain: AUDIT_CHAIN, seq, prev: r.prev };
  try {
    if (canonicalText(data) !== r.data) return "ROW_DATA_NOT_CANONICAL";
    if (flowDigest("audit_event", rest) !== r.hash) return "HASH_MISMATCH";
  } catch {
    return "ROW_NOT_CANONICAL";
  }
  return { ...rest, hash: r.hash };
}

/**
 * Reads and verifies the WHOLE chain in seq order. Returns the verified events, or the first defect.
 * Used by verify() and by auditExport.ts; not part of AuditPort.
 */
export function readVerifiedChain(tx: SqlTx): { ok: true; events: FlowAuditEvent[] } | AuditVerifyFail {
  const broken = (at_seq: number | null, detail: string): AuditVerifyFail => ({ ok: false, code: "AUDIT_CHAIN_BROKEN", at_seq, detail });
  let rows: Row[];
  try {
    rows = tx.prepare(`SELECT ${COLS} FROM ${AUDIT_TABLE} ORDER BY seq`).all() as Row[];
  } catch {
    return broken(null, "STORE_UNREADABLE");
  }
  const heads = new Map<string, string>();
  const events: FlowAuditEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const want = i + 1;
    const e = eventFromRow(rows[i]);
    if (typeof e === "string") return broken(want, e);
    if (e.seq !== want) return broken(want, "SEQ_GAP");
    if (e.prev !== (heads.get(e.flow_id) ?? AUDIT_ZERO)) return broken(want, "PREV_MISMATCH");
    heads.set(e.flow_id, e.hash);
    events.push(e);
  }
  return { ok: true, events };
}

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
     seq INTEGER PRIMARY KEY CHECK (seq >= 1),
     flow_id TEXT NOT NULL,
     type TEXT NOT NULL,
     actor TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT,
     flow_version INTEGER NOT NULL CHECK (flow_version >= 0),
     data TEXT NOT NULL,
     at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
     prev TEXT NOT NULL CHECK (length(prev) = 64),
     hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS ${AUDIT_TABLE}_flow ON ${AUDIT_TABLE} (flow_id, seq)`,
  // Guards against application mistakes only. Anyone with file access can drop a trigger.
  `CREATE TRIGGER IF NOT EXISTS ${AUDIT_TABLE}_no_update BEFORE UPDATE ON ${AUDIT_TABLE} BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${AUDIT_TABLE}_no_delete BEFORE DELETE ON ${AUDIT_TABLE} BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END`,
];

export const auditPort: AuditPort = {
  ddl: DDL,

  /**
   * Appends one event inside the caller's transaction. Throws (and writes nothing) on:
   *   AuditChainError AUDIT_FIELD_REFUSED  the input breaks a field rule (detail names the rule, never the value);
   *   AuditChainError AUDIT_CHAIN_BROKEN   the stored tail does not verify (a cheap check; verify() is the full one);
   *   CanonicalError                       the event cannot be encoded in CANON-1 (contract §4.7: fail closed).
   * The caller must let the exception abort its transaction.
   */
  append(tx: SqlTx, ev: FlowAuditInput): FlowAuditEvent {
    const bad = auditInputProblem(ev);
    if (bad) throw new AuditChainError("AUDIT_FIELD_REFUSED", bad);
    const tally = tx.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS top FROM ${AUDIT_TABLE}`).get() as { n: unknown; top: unknown };
    const top = num(tally.top);
    if (num(tally.n) !== top) throw new AuditChainError("AUDIT_CHAIN_BROKEN", "SEQ_GAP");
    const tail = [
      tx.prepare(`SELECT ${COLS} FROM ${AUDIT_TABLE} WHERE seq = ?`).get(top) as Row | undefined,
      tx.prepare(`SELECT ${COLS} FROM ${AUDIT_TABLE} WHERE flow_id = ? ORDER BY seq DESC LIMIT 1`).get(ev.flow_id) as Row | undefined,
    ];
    let prev = AUDIT_ZERO;
    for (const row of tail) {
      if (!row) continue;
      const e = eventFromRow(row);
      if (typeof e === "string") throw new AuditChainError("AUDIT_CHAIN_BROKEN", e);
      if (e.flow_id === ev.flow_id) prev = e.hash;
    }
    const { flow_id, type, actor, from_state, to_state, flow_version, at_ms } = ev;
    const rest = { flow_id, type, actor, from_state, to_state, flow_version, data: { ...ev.data }, at_ms, chain: AUDIT_CHAIN, seq: top + 1, prev };
    const event: FlowAuditEvent = { ...rest, hash: flowDigest("audit_event", rest) };
    tx.prepare(`INSERT INTO ${AUDIT_TABLE} (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.seq, flow_id, type, actor, from_state, to_state, flow_version, canonicalText(rest.data), at_ms, prev, event.hash,
    );
    return event;
  },

  /**
   * Recomputes the whole chain, always, whether or not a flowId is given: one broken event anywhere is a broken chain.
   * With flowId: count and head are that flow's (head = hash of its newest event, 64 zeroes if it has none).
   * Without:     count is every event and head is the hash of the newest event overall.
   * A failure is always code AUDIT_CHAIN_BROKEN; `detail` (an extra field) says what was found.
   *
   * A pass means the stored events are internally consistent. It does NOT mean they are the events that were
   * originally written: a rewritten or shortened chain with recomputed hashes passes.
   */
  verify(tx: SqlTx, flowId?: string): AuditVerifyResult {
    const chain = readVerifiedChain(tx);
    if (!chain.ok) return chain;
    const mine = flowId === undefined ? chain.events : chain.events.filter((e) => e.flow_id === flowId);
    return { ok: true, count: mine.length, head: mine.at(-1)?.hash ?? AUDIT_ZERO };
  },
};
