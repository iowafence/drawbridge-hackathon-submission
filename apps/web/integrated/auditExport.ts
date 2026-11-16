// DRAWBRIDGE integrated flow — audit export, replay verification and the optional external checkpoint
// (contract flow-v1 §10). OWNER: A5.
//
// CUTTABLE: nothing in auditChain.ts imports this file. Without it the flow still appends and verifies; what is lost
// is the per-flow export, the replay check and the truncation checkpoint.
//
// The checkpoint is `{seq, head, at_ms}` in a file outside the data directory. It is UNKEYED: it detects a rewrite or
// truncation of the audit table by someone who did not also rewrite the checkpoint file. It does not stop anyone who
// can write both. See docs/integrated/AUDIT_THREAT_MODEL.md.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { AUDIT_CHAIN, AUDIT_ZERO, readVerifiedChain } from "./auditChain.ts";
import { flowDigest } from "./flowCanonical.ts";
import { LEGAL_TRANSITIONS } from "./flowTypes.ts";
import type { FlowAuditEvent, FlowState, SqlTx } from "./flowTypes.ts";

// ---- replay ---------------------------------------------------------------------------------------------------------

export type ReplayFinding = { seq: number; code: string };
export type FlowReplay = {
  /** true when every event follows from the one before it under LEGAL_TRANSITIONS and the version rule. */
  ok: boolean;
  findings: ReplayFinding[];
  /** State and version the audit events alone support. Compare with the flow record; they must be equal. */
  final_state: FlowState | null;
  final_version: number;
  transitions: number;
  audit_only_events: number;
};

const legalMove = (from: FlowState | null, to: FlowState): boolean => Object.values(LEGAL_TRANSITIONS).some((r) => r.from.includes(from) && r.to.includes(to));

/**
 * Replays one flow's events (already chain-verified, in seq order) and checks that they describe a legal history:
 *   - a transition's from_state is the state the previous events left the flow in;
 *   - the move is one LEGAL_TRANSITIONS allows (so: no approval without AWAITING_HUMAN, no second submit intent,
 *     no PROVIDER_* state straight from a create response, nothing after a terminal state);
 *   - flow_version rises by exactly 1 on a transition and is unchanged on an audit-only event.
 * Pure. It reports what the audit trail supports and never upgrades a status.
 */
export function replayFlowEvents(events: readonly FlowAuditEvent[]): FlowReplay {
  const findings: ReplayFinding[] = [];
  let state: FlowState | null = null;
  let version = 0;
  let transitions = 0;
  let auditOnly = 0;
  for (const e of events) {
    if (e.to_state === null) {
      auditOnly++;
      if (e.from_state !== null && e.from_state !== state) findings.push({ seq: e.seq, code: "F_FROM_STATE_MISMATCH" });
      if (e.flow_version !== version) findings.push({ seq: e.seq, code: "F_VERSION_CHANGED_WITHOUT_TRANSITION" });
      continue;
    }
    transitions++;
    if (e.from_state !== state) findings.push({ seq: e.seq, code: "F_FROM_STATE_MISMATCH" });
    else if (!legalMove(e.from_state, e.to_state)) findings.push({ seq: e.seq, code: "F_ILLEGAL_TRANSITION" });
    if (e.flow_version !== version + 1) findings.push({ seq: e.seq, code: "F_VERSION_NOT_INCREMENTED" });
    state = e.to_state;
    version = e.flow_version;
  }
  return { ok: findings.length === 0, findings, final_state: state, final_version: version, transitions, audit_only_events: auditOnly };
}

export type FlowAuditExport = {
  chain: typeof AUDIT_CHAIN;
  flow_id: string;
  /** Result of verifying the WHOLE chain (all flows). When it is not ok, `events` is empty and `replay` is null. */
  chain_ok: boolean;
  chain_error: { at_seq: number | null; detail: string } | null;
  count: number;
  head: string;
  events: FlowAuditEvent[];
  replay: FlowReplay | null;
  /** Always this text. An export is a copy of local, unkeyed records; it proves nothing about who wrote them. */
  integrity_claim: "INTERNALLY_CONSISTENT_ONLY_NOT_TAMPER_PROOF";
};

/** One flow's verified events plus the replay result. Read-only. Nothing is derived from a broken chain. */
export function exportFlowAudit(tx: SqlTx, flowId: string): FlowAuditExport {
  const base = { chain: AUDIT_CHAIN, flow_id: flowId, integrity_claim: "INTERNALLY_CONSISTENT_ONLY_NOT_TAMPER_PROOF" as const };
  const chain = readVerifiedChain(tx);
  if (!chain.ok) return { ...base, chain_ok: false, chain_error: { at_seq: chain.at_seq, detail: chain.detail }, count: 0, head: AUDIT_ZERO, events: [], replay: null };
  const events = chain.events.filter((e) => e.flow_id === flowId);
  return { ...base, chain_ok: true, chain_error: null, count: events.length, head: events.at(-1)?.hash ?? AUDIT_ZERO, events, replay: replayFlowEvents(events) };
}

// ---- external checkpoint --------------------------------------------------------------------------------------------

export type AuditCheckpoint = { seq: number; head: string; at_ms: number };
export type CheckpointWrite = ({ ok: true } & AuditCheckpoint) | { ok: false; code: string };
export type CheckpointCheck =
  | { ok: true; checkpoint_seq: number; chain_count: number; /** events after the checkpoint: NOT covered by it */ uncovered_events: number }
  | { ok: false; code: string; checkpoint_seq: number | null; chain_count: number | null };

/**
 * The checkpoint `head`. Because `prev` links events per flow, the hash of the newest event commits only to that one
 * flow's history. The checkpoint therefore uses a ROLLING head over every event in seq order, so it commits to all
 * flows:   R(0) = 64 zeroes;   R(i) = flowDigest("audit_event", { chain, rollup_prev: R(i-1), rollup_event: hash(i) }).
 * (A rollup object can never be mistaken for an event: the key sets differ.) Returns one value per seq, index 0 = R(0).
 */
export function rollingHeads(events: readonly FlowAuditEvent[]): string[] {
  const out = [AUDIT_ZERO];
  for (const e of events) out.push(flowDigest("audit_event", { chain: AUDIT_CHAIN, rollup_prev: out[out.length - 1], rollup_event: e.hash }));
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseCheckpoint(text: string): AuditCheckpoint | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "at_ms,head,seq") return null;
  if (typeof o.seq !== "number" || !Number.isSafeInteger(o.seq) || o.seq < 1) return null;
  if (typeof o.at_ms !== "number" || !Number.isSafeInteger(o.at_ms) || o.at_ms < 0) return null;
  if (typeof o.head !== "string" || !HEX64.test(o.head)) return null;
  return { seq: o.seq, head: o.head, at_ms: o.at_ms };
}

/** Resolves symlinks on the deepest existing ancestor, so an alias of the data directory is still recognised. */
function real(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(cur.slice(dirname(cur).length + 1));
    cur = dirname(cur);
  }
  return join(realpathSync(cur), ...tail);
}

/** A fixed code when the checkpoint path is unusable, else null. The path must be absolute and must not be inside the
 *  directory that holds the SQLite file (asked of SQLite itself; an in-memory database has no directory to check). */
function pathProblem(tx: SqlTx, file: string): string | null {
  if (typeof file !== "string" || !isAbsolute(file)) return "CHECKPOINT_PATH_NOT_ABSOLUTE";
  let dbFile = "";
  try {
    const rows = tx.prepare("PRAGMA database_list").all() as { name?: unknown; file?: unknown }[];
    const main = rows.find((r) => r.name === "main");
    dbFile = typeof main?.file === "string" ? main.file : "";
  } catch {
    return "CHECKPOINT_STORE_UNREADABLE";
  }
  if (dbFile === "") return null;
  const dataDir = real(dirname(dbFile));
  const target = real(file);
  return target === dataDir || target.startsWith(dataDir.endsWith(sep) ? dataDir : dataDir + sep) ? "CHECKPOINT_INSIDE_DATA_DIR" : null;
}

function check(tx: SqlTx, file: string): CheckpointCheck {
  const fail = (code: string, checkpoint_seq: number | null = null, chain_count: number | null = null): CheckpointCheck => ({ ok: false, code, checkpoint_seq, chain_count });
  const bad = pathProblem(tx, file);
  if (bad) return fail(bad);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return fail("CHECKPOINT_MISSING"); // no checkpoint is never a pass
  }
  const cp = parseCheckpoint(text);
  if (!cp) return fail("CHECKPOINT_MALFORMED");
  const chain = readVerifiedChain(tx);
  if (!chain.ok) return fail("AUDIT_CHAIN_BROKEN", cp.seq);
  const n = chain.events.length;
  if (cp.seq > n) return fail("AUDIT_TRUNCATED_BELOW_CHECKPOINT", cp.seq, n);
  if (rollingHeads(chain.events.slice(0, cp.seq))[cp.seq] !== cp.head) return fail("AUDIT_REWRITTEN_BELOW_CHECKPOINT", cp.seq, n);
  return { ok: true, checkpoint_seq: cp.seq, chain_count: n, uncovered_events: n - cp.seq };
}

/**
 * Checks the audit table against the retained checkpoint. Never throws.
 * ok:true means: events 1..checkpoint_seq are exactly the events that were there when the checkpoint was written,
 * ASSUMING the checkpoint file itself was not rewritten. Events after checkpoint_seq are not covered at all.
 */
export function verifyAgainstCheckpoint(tx: SqlTx, file: string): CheckpointCheck {
  try {
    return check(tx, file);
  } catch {
    return { ok: false, code: "CHECKPOINT_CHECK_FAILED", checkpoint_seq: null, chain_count: null };
  }
}

/**
 * Writes `{seq, head, at_ms}` for the current chain to `file` (owner-only, replaced atomically). Never throws.
 * Refuses when: the path is relative or inside the data directory; the chain is broken or empty; or a checkpoint is
 * already there and the chain does not agree with it. That last rule matters: a checkpoint that has caught a rewrite
 * or truncation is never overwritten by the routine that would otherwise erase the evidence.
 */
export function writeCheckpoint(tx: SqlTx, file: string, nowMs: number = Date.now()): CheckpointWrite {
  try {
    const bad = pathProblem(tx, file);
    if (bad) return { ok: false, code: bad };
    if (existsSync(file)) {
      const prior = check(tx, file);
      if (!prior.ok) return { ok: false, code: prior.code === "CHECKPOINT_MALFORMED" ? "CHECKPOINT_EXISTING_MALFORMED" : prior.code };
    }
    const chain = readVerifiedChain(tx);
    if (!chain.ok) return { ok: false, code: "AUDIT_CHAIN_BROKEN" };
    const seq = chain.events.length;
    if (seq === 0) return { ok: false, code: "CHECKPOINT_NOTHING_TO_COVER" };
    const cp: AuditCheckpoint = { seq, head: rollingHeads(chain.events)[seq], at_ms: nowMs };
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(cp) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return { ok: true, ...cp };
  } catch {
    return { ok: false, code: "CHECKPOINT_WRITE_FAILED" };
  }
}
