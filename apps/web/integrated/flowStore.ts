// DRAWBRIDGE integrated flow (contract flow-v1 section 6): durable flow store. OWNER: A3.
//
// One SQLite file per data directory (node:sqlite, WAL, synchronous=FULL). There is NO in-memory fallback: if the
// store cannot be opened durably, openFlowStore throws INTEGRATED_STORE_UNAVAILABLE and the flow service refuses
// every operation with that code.
//
// The rules that matter are enforced twice: by the compare-and-swap code in stateMachine.ts, and again here by
// database constraints and triggers, so that a defect in a caller (or a raw SQL statement) still cannot
//   - move a flow along an edge that is not in LEGAL_TRANSITIONS,
//   - change a proposal, an attached evidence text, a gate record or an authorization after it was written,
//   - record a second submit attempt for a flow, a request id or (in sandbox mode) the whole store,
//   - mark a flow paid without a provider read that said PAID.
//
// This store is the state of the integrated payment flow only. It is not a ledger and not the historic chain.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEGAL_TRANSITIONS } from "./flowTypes.ts";
import type { AuthorizationRecord, FlowProposal, FlowRecordV1, FlowState, GateRecord, LedgerBinding, ProviderMode } from "./flowTypes.ts";
import type { Claims } from "../src/server/agentPolicy.ts";
import { MAX_SUBMISSIONS } from "../src/server/transfers.ts";

export const FLOW_STORE_FILE = "flow-v1.sqlite";
/** 2: flow_authorization.approval_mac (flow-v1.2 R11). A store written by schema 1 is refused, not migrated. */
export const FLOW_STORE_SCHEMA_VERSION = 2;
export const STORE_UNAVAILABLE = "INTEGRATED_STORE_UNAVAILABLE";

export class FlowStoreError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Raw row of table `flow`. JSON columns hold exactly the contract records. */
export type FlowRow = {
  flow_id: string; created_at_ms: number; created_by: string;
  proposal_json: string; proposal_digest: string; provider_request_id: string; obligation_id: string;
  evidence_source: string | null; evidence_text: string | null; claims_json: string | null; evidence_document_id: string | null; evidence_digest: string | null;
  gate_json: string | null; gate_digest: string | null; proof_reasons_json: string | null; gate_consumed_at_ms: number | null;
  authorization_json: string | null; authorization_consumed_at_ms: number | null; ledger_json: string | null;
  attempt_id: string | null; attempt_recorded_at_ms: number | null; provider_mode: string | null;
  provider_transfer_id: string | null; create_http_status: number | null; create_reported_status: string | null;
  last_provider_status: string | null; last_provider_read_at_ms: number | null;
  state: FlowState; version: number; audit_head: string; updated_at_ms: number;
};

const IMMUTABLE = ["flow_id", "created_at_ms", "created_by", "proposal_json", "proposal_digest", "provider_request_id", "obligation_id"];
const SET_ONCE = ["evidence_source", "evidence_text", "claims_json", "evidence_document_id", "evidence_digest", "gate_json", "gate_digest", "proof_reasons_json", "gate_consumed_at_ms",
  "authorization_json", "authorization_consumed_at_ms", "attempt_id", "attempt_recorded_at_ms", "provider_mode", "provider_transfer_id", "create_http_status", "create_reported_status"];
/** Columns a transition may write (audit_head, state, version and updated_at_ms are written by the state machine). */
export const WRITABLE: ReadonlySet<string> = new Set([...SET_ONCE, "ledger_json", "last_provider_status", "last_provider_read_at_ms"]);
/** Columns that may change WITHOUT a version increment (audit-only events and the ledger note). */
const NO_VERSION = new Set(["audit_head", "ledger_json", "updated_at_ms"]);
const ALL_MUTABLE = [...SET_ONCE, "ledger_json", "last_provider_status", "last_provider_read_at_ms", "audit_head", "updated_at_ms"];

const STATES = [...new Set(Object.values(LEGAL_TRANSITIONS).flatMap((r) => [...r.from.filter((s): s is FlowState => s !== null), ...r.to]))];
const stateList = STATES.map((s) => `'${s}'`).join(",");
/** Every (from, to) pair that some operation allows. */
export const LEGAL_PAIRS: readonly [FlowState, FlowState][] = (() => {
  const seen = new Set<string>();
  const out: [FlowState, FlowState][] = [];
  for (const r of Object.values(LEGAL_TRANSITIONS)) for (const f of r.from) for (const t of r.to) if (f !== null && !seen.has(`${f}>${t}`)) {
    seen.add(`${f}>${t}`);
    out.push([f, t]);
  }
  return out;
})();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flow (
  flow_id TEXT PRIMARY KEY CHECK (length(flow_id) = 36),
  created_at_ms INTEGER NOT NULL, created_by TEXT NOT NULL CHECK (created_by LIKE 'human:%'),
  proposal_json TEXT NOT NULL, proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  provider_request_id TEXT NOT NULL UNIQUE CHECK (length(provider_request_id) = 36),
  obligation_id TEXT NOT NULL,
  evidence_source TEXT CHECK (evidence_source IS NULL OR evidence_source IN ('AGENT_RUN','FIXTURE_REPLAY')),
  evidence_text TEXT, claims_json TEXT, evidence_document_id TEXT, evidence_digest TEXT,
  gate_json TEXT, gate_digest TEXT UNIQUE, proof_reasons_json TEXT, gate_consumed_at_ms INTEGER,
  authorization_json TEXT, authorization_consumed_at_ms INTEGER, ledger_json TEXT,
  attempt_id TEXT UNIQUE, attempt_recorded_at_ms INTEGER, provider_mode TEXT CHECK (provider_mode IS NULL OR provider_mode IN ('mock','sandbox')),
  provider_transfer_id TEXT UNIQUE, create_http_status INTEGER, create_reported_status TEXT,
  last_provider_status TEXT, last_provider_read_at_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN (${stateList})),
  version INTEGER NOT NULL CHECK (version >= 1),
  audit_head TEXT NOT NULL CHECK (length(audit_head) = 64),
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- at most one authorization per flow; one gate result authorizes at most once
CREATE TABLE IF NOT EXISTS flow_authorization (
  flow_id TEXT PRIMARY KEY REFERENCES flow(flow_id),
  gate_digest TEXT NOT NULL UNIQUE,
  authorization_digest TEXT NOT NULL UNIQUE,
  proposal_digest TEXT NOT NULL,
  operator_id TEXT NOT NULL CHECK (operator_id LIKE 'human:%'),
  approved_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, flow_version INTEGER NOT NULL,
  -- R11: HMAC of authorization_digest under the per-process approval key. Outside the AuthorizationRecord and its digest.
  approval_mac TEXT NOT NULL CHECK (length(approval_mac) = 64)
) STRICT;

-- the durable submit intent: one per flow, per provider request id, per attempt id
CREATE TABLE IF NOT EXISTS flow_submit_attempt (
  flow_id TEXT PRIMARY KEY REFERENCES flow(flow_id),
  provider_request_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE,
  authorization_digest TEXT NOT NULL UNIQUE,
  recorded_at_ms INTEGER NOT NULL,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('mock','sandbox'))
) STRICT;

CREATE TABLE IF NOT EXISTS flow_legal_transition (from_state TEXT NOT NULL, to_state TEXT NOT NULL, PRIMARY KEY (from_state, to_state)) STRICT;

CREATE TRIGGER IF NOT EXISTS flow_insert_draft BEFORE INSERT ON flow
WHEN NEW.state <> 'DRAFT' OR NEW.version <> 1 OR ${[...SET_ONCE, "ledger_json", "last_provider_status", "last_provider_read_at_ms"].map((c) => `NEW.${c} IS NOT NULL`).join(" OR ")}
BEGIN SELECT RAISE(ABORT, 'FLOW_MUST_START_AS_DRAFT'); END;

CREATE TRIGGER IF NOT EXISTS flow_no_delete BEFORE DELETE ON flow BEGIN SELECT RAISE(ABORT, 'FLOW_DELETE_REFUSED'); END;

CREATE TRIGGER IF NOT EXISTS flow_immutable BEFORE UPDATE ON flow
WHEN ${IMMUTABLE.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT, 'FLOW_IMMUTABLE_FIELD'); END;

CREATE TRIGGER IF NOT EXISTS flow_set_once BEFORE UPDATE ON flow
WHEN ${SET_ONCE.map((c) => `(OLD.${c} IS NOT NULL AND NEW.${c} IS NOT OLD.${c})`).join(" OR ")}
BEGIN SELECT RAISE(ABORT, 'FLOW_FIELD_ALREADY_SET'); END;

-- every change is either a transition (version + 1) or an audit-only note that touches nothing but the audit head
CREATE TRIGGER IF NOT EXISTS flow_version BEFORE UPDATE ON flow
WHEN NEW.version <> OLD.version + 1 AND NOT (NEW.version = OLD.version AND NEW.state = OLD.state AND ${ALL_MUTABLE.filter((c) => !NO_VERSION.has(c)).map((c) => `NEW.${c} IS OLD.${c}`).join(" AND ")})
BEGIN SELECT RAISE(ABORT, 'FLOW_VERSION_NOT_INCREMENTED'); END;

CREATE TRIGGER IF NOT EXISTS flow_legal BEFORE UPDATE ON flow
WHEN NEW.version = OLD.version + 1 AND NOT EXISTS (SELECT 1 FROM flow_legal_transition WHERE from_state = OLD.state AND to_state = NEW.state)
BEGIN SELECT RAISE(ABORT, 'FLOW_ILLEGAL_TRANSITION'); END;

-- a state may only be entered when the row already holds what that state claims
CREATE TRIGGER IF NOT EXISTS flow_state_evidence BEFORE UPDATE ON flow
WHEN NEW.version = OLD.version + 1 AND (
  (NEW.state <> 'DRAFT' AND NEW.state <> 'EXPIRED' AND (NEW.evidence_text IS NULL OR NEW.evidence_source IS NULL OR NEW.evidence_digest IS NULL))
  OR (NEW.state IN ('GATE_HOLD','GATE_REVIEW','GATE_ELIGIBLE','AWAITING_HUMAN','HUMAN_APPROVED','HUMAN_REJECTED','SUBMIT_INTENT_RECORDED') AND (NEW.gate_json IS NULL OR NEW.gate_digest IS NULL))
  OR (NEW.state = 'GATE_HOLD' AND json_extract(NEW.gate_json, '$.decision') IS NOT 'HOLD')
  OR (NEW.state = 'GATE_REVIEW' AND json_extract(NEW.gate_json, '$.decision') IS NOT 'REVIEW')
  OR (NEW.state IN ('GATE_ELIGIBLE','AWAITING_HUMAN','HUMAN_APPROVED','SUBMIT_INTENT_RECORDED') AND json_extract(NEW.gate_json, '$.decision') IS NOT 'ELIGIBLE_FOR_HUMAN_REVIEW')
  OR (NEW.state IN ('HUMAN_APPROVED','SUBMIT_INTENT_RECORDED') AND (NEW.authorization_json IS NULL OR NEW.gate_consumed_at_ms IS NULL OR NOT EXISTS (
        SELECT 1 FROM flow_authorization a WHERE a.flow_id = NEW.flow_id AND a.gate_digest = NEW.gate_digest AND a.proposal_digest = NEW.proposal_digest
          AND a.authorization_digest = json_extract(NEW.authorization_json, '$.authorization_digest'))))
  OR (NEW.state = 'SUBMIT_INTENT_RECORDED' AND (NEW.attempt_id IS NULL OR NEW.authorization_consumed_at_ms IS NULL OR NEW.provider_mode IS NULL OR NOT EXISTS (
        SELECT 1 FROM flow_submit_attempt t WHERE t.flow_id = NEW.flow_id AND t.attempt_id = NEW.attempt_id AND t.provider_request_id = NEW.provider_request_id AND t.provider_mode = NEW.provider_mode)))
  OR (NEW.state IN ('SUBMITTED','SUBMISSION_UNCERTAIN','PROVIDER_REFUSED','PROVIDER_SCHEDULED','PROVIDER_PROCESSING','PROVIDER_FAILED','PROVIDER_PAID') AND NEW.attempt_id IS NULL)
  OR (NEW.state = 'SUBMITTED' AND (NEW.provider_transfer_id IS NULL OR NEW.create_reported_status IS NULL))
  OR (NEW.state IN ('PROVIDER_SCHEDULED','PROVIDER_PROCESSING','PROVIDER_FAILED','PROVIDER_PAID') AND (NEW.provider_transfer_id IS NULL OR NEW.last_provider_status IS NULL OR NEW.last_provider_read_at_ms IS NULL))
  OR (NEW.state = 'PROVIDER_PAID' AND NEW.last_provider_status IS NOT 'PAID')
  OR (NEW.state <> 'PROVIDER_PAID' AND NEW.last_provider_status IS 'PAID')
  OR (NEW.state = 'PROVIDER_SCHEDULED' AND NEW.last_provider_status IS NOT 'SCHEDULED')
)
BEGIN SELECT RAISE(ABORT, 'FLOW_STATE_WITHOUT_EVIDENCE'); END;

CREATE TRIGGER IF NOT EXISTS authorization_only_awaiting BEFORE INSERT ON flow_authorization
WHEN NOT EXISTS (SELECT 1 FROM flow f WHERE f.flow_id = NEW.flow_id AND f.state = 'AWAITING_HUMAN' AND f.gate_digest = NEW.gate_digest AND f.proposal_digest = NEW.proposal_digest AND f.gate_consumed_at_ms IS NULL)
BEGIN SELECT RAISE(ABORT, 'AUTHORIZATION_WITHOUT_LIVE_GATE'); END;
CREATE TRIGGER IF NOT EXISTS authorization_no_update BEFORE UPDATE ON flow_authorization BEGIN SELECT RAISE(ABORT, 'AUTHORIZATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS authorization_no_delete BEFORE DELETE ON flow_authorization BEGIN SELECT RAISE(ABORT, 'AUTHORIZATION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS attempt_only_approved BEFORE INSERT ON flow_submit_attempt
WHEN NOT EXISTS (
  SELECT 1 FROM flow f JOIN flow_authorization a ON a.flow_id = f.flow_id
  WHERE f.flow_id = NEW.flow_id AND f.state = 'HUMAN_APPROVED' AND f.provider_request_id = NEW.provider_request_id
    AND f.authorization_consumed_at_ms IS NULL AND a.authorization_digest = NEW.authorization_digest)
BEGIN SELECT RAISE(ABORT, 'ATTEMPT_WITHOUT_LIVE_APPROVAL'); END;
CREATE TRIGGER IF NOT EXISTS attempt_sandbox_limit BEFORE INSERT ON flow_submit_attempt
WHEN NEW.provider_mode = 'sandbox' AND (SELECT count(*) FROM flow_submit_attempt WHERE provider_mode = 'sandbox') >= ${MAX_SUBMISSIONS}
BEGIN SELECT RAISE(ABORT, 'SUBMISSION_LIMIT_REACHED'); END;
CREATE TRIGGER IF NOT EXISTS attempt_no_update BEFORE UPDATE ON flow_submit_attempt BEGIN SELECT RAISE(ABORT, 'ATTEMPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS attempt_no_delete BEFORE DELETE ON flow_submit_attempt BEGIN SELECT RAISE(ABORT, 'ATTEMPT_IMMUTABLE'); END;
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FlowStore = {
  readonly dir: string;
  readonly file: string;
  readonly db: DatabaseSync;
  /** One BEGIN IMMEDIATE transaction. Commits when fn returns, rolls back when it throws. */
  tx<T>(fn: () => T): T;
  getRow(flowId: unknown): FlowRow | null;
  listRows(state?: FlowState): FlowRow[];
  attemptCount(mode: ProviderMode): number;
  /** The stored approval MAC and digest for a flow (flow-v1.2 R11), or null when there is no authorization row. */
  approvalMac(flowId: string): { authorization_digest: string; approval_mac: string } | null;
  /** Every submit-attempt row in the store (candidate 3, A8-09: compared with the submission history file). */
  attempts(): { flow_id: string; provider_request_id: string; attempt_id: string; authorization_digest: string }[];
  /** Number of authorization rows in the store. */
  authorizationCount(): number;
  toRecord(row: FlowRow): FlowRecordV1;
  close(): void;
};

/** Opens (creating if needed) `<dir>/flow-v1.sqlite`. `dir` must be absolute; it is created 0700 and the file 0600.
 *  `auditDdl` is the audit lane's DDL (AuditPort.ddl), applied in the same file so state and audit commit together.
 *  Throws FlowStoreError(INTEGRATED_STORE_UNAVAILABLE) unless the database ends up in WAL mode with synchronous=FULL. */
export function openFlowStore(dir: string, auditDdl: readonly string[] = []): FlowStore {
  const fail = () => new FlowStoreError(STORE_UNAVAILABLE);
  if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes("\0")) throw fail();
  const file = join(dir, FLOW_STORE_FILE);
  let db: DatabaseSync;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const fresh = !existsSync(file);
    db = new DatabaseSync(file);
    if (fresh) chmodSync(file, 0o600);
  } catch {
    throw fail();
  }
  const tx = <T>(fn: () => T): T => {
    try {
      db.exec("BEGIN IMMEDIATE"); // takes the single write lock up front; other writers wait (busy_timeout)
    } catch {
      throw new FlowStoreError("INTEGRATED_STORE_BUSY");
    }
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch { /* nothing to roll back */ }
      throw e;
    }
  };
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const mode = (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined)?.journal_mode;
    db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF");
    const sync = (db.prepare("PRAGMA synchronous").get() as { synchronous?: number } | undefined)?.synchronous;
    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys;
    if (mode !== "wal" || sync !== 2 || fk !== 1) throw fail();
    tx(() => {
      const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (v !== 0 && v !== FLOW_STORE_SCHEMA_VERSION) throw fail();
      db.exec(SCHEMA);
      for (const stmt of auditDdl) db.exec(stmt);
      const ins = db.prepare("INSERT OR IGNORE INTO flow_legal_transition (from_state, to_state) VALUES (?, ?)");
      for (const [f, t] of LEGAL_PAIRS) ins.run(f, t);
      // the table on disk must equal the contract table exactly; a widened table is refused
      const n = (db.prepare("SELECT count(*) AS n FROM flow_legal_transition").get() as { n: number }).n;
      if (Number(n) !== LEGAL_PAIRS.length) throw fail();
      db.exec(`PRAGMA user_version = ${FLOW_STORE_SCHEMA_VERSION}`);
    });
  } catch {
    try {
      db.close();
    } catch { /* already closed */ }
    throw fail();
  }

  const getRow = (flowId: unknown): FlowRow | null => {
    if (typeof flowId !== "string" || !UUID.test(flowId)) return null;
    return (db.prepare("SELECT * FROM flow WHERE flow_id = ?").get(flowId) as FlowRow | undefined) ?? null;
  };
  return {
    dir, file, db, tx, getRow,
    listRows: (state) => (state ? db.prepare("SELECT * FROM flow WHERE state = ? ORDER BY created_at_ms, flow_id").all(state) : db.prepare("SELECT * FROM flow ORDER BY created_at_ms, flow_id").all()) as FlowRow[],
    attemptCount: (mode) => Number((db.prepare("SELECT count(*) AS n FROM flow_submit_attempt WHERE provider_mode = ?").get(mode) as { n: number }).n),
    approvalMac: (flowId) => (db.prepare("SELECT authorization_digest, approval_mac FROM flow_authorization WHERE flow_id = ?").get(flowId) as { authorization_digest: string; approval_mac: string } | undefined) ?? null,
    attempts: () => (db.prepare("SELECT flow_id, provider_request_id, attempt_id, authorization_digest FROM flow_submit_attempt ORDER BY recorded_at_ms, flow_id").all() as { flow_id: string; provider_request_id: string; attempt_id: string; authorization_digest: string }[]).map((r) => ({ ...r })),
    authorizationCount: () => Number((db.prepare("SELECT count(*) AS n FROM flow_authorization").get() as { n: number }).n),
    toRecord,
    close: () => db.close(),
  };
}

export const proposalOf = (row: FlowRow): FlowProposal => JSON.parse(row.proposal_json) as FlowProposal;
export const gateOf = (row: FlowRow): GateRecord | null => (row.gate_json ? (JSON.parse(row.gate_json) as GateRecord) : null);
export const authorizationOf = (row: FlowRow): AuthorizationRecord | null => (row.authorization_json ? (JSON.parse(row.authorization_json) as AuthorizationRecord) : null);
export const ledgerOf = (row: FlowRow): LedgerBinding | null => (row.ledger_json ? (JSON.parse(row.ledger_json) as LedgerBinding) : null);
export const claimsOf = (row: FlowRow): Claims | null => (row.claims_json ? (JSON.parse(row.claims_json) as Claims) : null);

/** The contract record, built only from stored columns. */
export function toRecord(row: FlowRow): FlowRecordV1 {
  return {
    contract: "flow-v1",
    flow_id: row.flow_id, created_at_ms: row.created_at_ms, created_by: row.created_by,
    proposal: proposalOf(row), proposal_digest: row.proposal_digest,
    gate: gateOf(row), gate_consumed_at_ms: row.gate_consumed_at_ms,
    authorization: authorizationOf(row), authorization_consumed_at_ms: row.authorization_consumed_at_ms,
    ledger: ledgerOf(row),
    submission: {
      attempt_id: row.attempt_id, attempt_recorded_at_ms: row.attempt_recorded_at_ms, provider_mode: row.provider_mode as ProviderMode | null,
      provider_transfer_id: row.provider_transfer_id, create_http_status: row.create_http_status, create_reported_status: row.create_reported_status,
      last_provider_status: row.last_provider_status, last_provider_read_at_ms: row.last_provider_read_at_ms,
    },
    state: row.state, version: row.version, audit_head: row.audit_head,
  };
}
