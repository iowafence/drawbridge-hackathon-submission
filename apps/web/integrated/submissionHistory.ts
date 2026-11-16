// DRAWBRIDGE integrated flow: submission history. OWNER: A3. Remediation for cold review finding A8-09.
//
// WHAT THIS IS
//   An append-only file, `submission-history-v1.jsonl`, in the integrated data directory BESIDE `flow-v1.sqlite`.
//   One line is appended and fsynced for every submit intent, before provider create is called. It is the record
//   that a create may have been sent for a flow, a provider request id, a proposal and an authorization.
//
// WHY IT IS NOT IN THE DATABASE, AND WHY THE AUDIT CHAIN IS NOT ENOUGH
//   The flow rows, the authorization rows, the submit-attempt rows AND the audit chain all live in one SQLite file
//   so that state and audit commit together. The price of that is that they also roll back together: whoever
//   restores or rewrites `flow-v1.sqlite` takes the flow back to "never submitted" and takes the audit events that
//   said otherwise with it. The audit chain's trust boundary is therefore the database file. It is evidence for a
//   reader who trusts that file; it is not a replay guard against someone who can replace it. This file is.
//
// TRUST BOUNDARY (stated plainly; the cold reviewer judges it)
//   DEFEATED: a writer who rolls back, restores or edits `flow-v1.sqlite` ALONE, in any process and across any
//             number of restarts. After such a rollback the history still names the intent, and approve and submit
//             refuse that flow, request id, proposal and authorization for good.
//   DEFEATED: the same writer also deleting, truncating, corrupting or reordering this file. A missing file (when
//             the store shows any approval or attempt), a malformed line, a broken hash chain, or a store attempt
//             the history does not know about each refuse every approve and submit in the store.
//   NOT DEFEATED BY THIS FILE: a writer who controls the WHOLE data directory and rewrites both files consistently:
//             rolls the database back and also removes the matching lines here and recomputes the chain (it is
//             unkeyed), or restores both files from a snapshot taken before the submit, or replaces this file with
//             a freshly forged header-only one. Both files sit in the same directory with the same owner, so this
//             is the same operating-system principal. NO CLAIM is made that local state protects against total
//             local-state compromise.
//   THE ONLY GUARD AGAINST THAT WRITER is the provider request-id lookup in flowService.ts (read-only, before
//             approve, before the intent and again before create): if the provider already holds a record for the
//             request id, nothing more is sent. Its limits:
//               - It helps only when the provider HOLDS a record. If the first create was definitively refused, or
//                 never reached the provider, there is no record, and a whole-directory rollback followed by a
//                 fresh human approval can reach a second create CALL for the same request id.
//               - MOCK PROVIDER RECORDS ARE LOCAL. In the mock runtime the provider state file is kept inside the
//                 data directory, so a whole-directory writer rolls it back too. The mock lookup is NOT an
//                 independent security boundary against full data-folder control; it proves the code path only.
//                 Independence holds only where the records live at the provider (sandbox or live), and that has
//                 not been demonstrated here: no sandbox or live execution was authorized.
//               - Neither the history nor the lookup establishes protection from full local state rollback or
//                 real-provider inconsistency.
//               - The lookup answer is accepted as "absent" only in one exact shape (see providerRecordProblem in
//                 flowService.ts). That shape is a pinned ASSUMPTION about the provider's API and is UNVERIFIED.
//                 If the real API answers in any other shape, every sandbox approval and submit fails closed:
//                 a liveness cost, not a safety one.
//   RESIDUAL R-3 (accepted by the owner as a documented, UNRESOLVED risk; finding A8-10):
//     Preconditions: the writer controls the whole data directory (database AND this file restored to a pre-submit
//                    copy); the FIRST create was accepted by the provider, or is still in flight, but the provider's
//                    list-by-request-id does not yet return it (lag), so the lookup honestly answers "absent";
//                    within that window the server restarts or another process serves, and a human approves again.
//     Observed:      the re-approval is accepted and the submit proceeds to a second provider create call. With a
//                    fake provider that deduplicates on request id the second call is answered as a duplicate and
//                    the flow ends SUBMISSION_UNCERTAIN; with a fake that does not, it ends SUBMITTED.
//     Provider-create count: 2 create CALLS for the one provider_request_id.
//     Possible financial effect: one transfer if the provider deduplicates request_id; possibly two otherwise;
//                    UNVERIFIED. Two create calls are NOT evidence of two transfers. Whether Airwallex suppresses
//                    a duplicate request_id, and how quickly its list reflects a new transfer, has not been
//                    verified. Verifying both is a prerequisite for any release that claims financial execution
//                    safety. R-1 and R-2 (described in the lane handoff) remain open as well.
//     No automatic retry exists in any of these cases: every second create above needs a fresh human approval.
//               - A lookup that says "absent" is only ever one more gate. It never clears a refusal that came
//                 from this history, the in-process spent record, the approval MAC, the state machine or the
//                 binding checks. A failed, timed-out or ambiguous lookup refuses.
//   ASSUMED:  one host, one data directory, local POSIX file system with working O_APPEND and fsync. Appends are
//             serialized by the SQLite write lock (the caller appends inside a BEGIN IMMEDIATE transaction), which
//             holds across connections and processes on one host. Not designed for a network file system.
//             That lock is the FLOW DATABASE's lock. A writer who replaces `flow-v1.sqlite` while processes are
//             running takes the lock's meaning with it; that case belongs to the whole-directory residual below.
//   The in-process "spent" record in flowService.ts stays as well; it needs no file at all but lives for one
//   process. This file is what carries single use across a restart.
//
// FORMAT
//   UTF-8, one JSON object per line, every line ends with "\n". Line 1 is a HEADER. Each line carries `seq`
//   (0, 1, 2, ...), `prev` (the previous line's hash, 64 zeroes for the header) and `hash` =
//   sha256("DRAWBRIDGE-FLOW-V1" 0x00 "submission_history" 0x00 CANON-1(line without hash)). Key sets are exact.
//     HEADER               { v, kind, seq, created_at_ms, prev, hash }
//     INTENT               { v, kind, seq, flow_id, provider_request_id, proposal_digest, authorization_digest,
//                            attempt_id, provider_mode, at_ms, prev, hash }
//     INTENT_NOT_COMMITTED { v, kind, seq, flow_id, attempt_id, code, at_ms, prev, hash }
//     OUTCOME              { v, kind, seq, flow_id, attempt_id, outcome, at_ms, prev, hash }
//   INTENT_NOT_COMMITTED is written by the same invocation when the database transaction that would have recorded
//   the intent failed to commit, so the flow never left HUMAN_APPROVED and create was never reached. It cancels
//   exactly one INTENT by attempt id. An INTENT that is not cancelled is "live".
//   OUTCOME records what is known about a live intent, at most once per attempt:
//     SENT_ACCEPTED    the provider answered with a well-formed acceptance
//     SENT_REFUSED     the provider answered with a definite refusal
//     UNCERTAIN        anything else after create was called, including every timeout, 429 and 5xx: the code
//                      cannot prove the request did not leave the process, so it does not say so
//     NOT_TRANSMITTED  create was provably never called for this attempt (the pre-create provider lookup refused)
//   An OUTCOME is evidence only. Whatever it says, a live intent blocks every further approve and submit for its
//   flow, request id, proposal and authorization. No outcome is ever a permission to send again.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalText } from "./flowCanonical.ts";

export const SUBMISSION_HISTORY_FILE = "submission-history-v1.jsonl";
export const HISTORY_MISSING = "SUBMISSION_HISTORY_MISSING";
export const HISTORY_MALFORMED = "SUBMISSION_HISTORY_MALFORMED";
export const HISTORY_BROKEN = "SUBMISSION_HISTORY_BROKEN";
export const HISTORY_INCONSISTENT = "SUBMISSION_HISTORY_INCONSISTENT";
export const HISTORY_WRITE_FAILED = "SUBMISSION_HISTORY_WRITE_FAILED";
export const ALREADY_RECORDED = "SUBMISSION_ALREADY_RECORDED";

export class SubmissionHistoryError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type HistoryIntent = {
  /** What is known about this attempt, or null when no outcome line was written (for example after a crash). */
  outcome?: OutcomeClass | null;
  flow_id: string;
  provider_request_id: string;
  proposal_digest: string;
  authorization_digest: string;
  attempt_id: string;
  provider_mode: "mock" | "sandbox";
  at_ms: number;
};
export type HistoryRead =
  | { ok: true; lines: number; head: string; live: HistoryIntent[]; cancelled: number }
  | { ok: false; code: typeof HISTORY_MISSING | typeof HISTORY_MALFORMED | typeof HISTORY_BROKEN };

const ZERO = "0".repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9_.: -]{1,80}$/;
/** Attempt ids come from FlowDeps.uuid (a UUID in the runtime; tests may inject other generators). */
const ATTEMPT = /^[A-Za-z0-9._:-]{1,128}$/;
const KEYS: Record<string, string> = {
  HEADER: "created_at_ms,hash,kind,prev,seq,v",
  INTENT: "at_ms,attempt_id,authorization_digest,flow_id,hash,kind,prev,proposal_digest,provider_mode,provider_request_id,seq,v",
  INTENT_NOT_COMMITTED: "at_ms,attempt_id,code,flow_id,hash,kind,prev,seq,v",
  OUTCOME: "at_ms,attempt_id,flow_id,hash,kind,outcome,prev,seq,v",
};
export const OUTCOME_CLASSES = ["SENT_ACCEPTED", "SENT_REFUSED", "UNCERTAIN", "NOT_TRANSMITTED"] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const lineHash = (rest: Record<string, unknown>): string => createHash("sha256").update(`DRAWBRIDGE-FLOW-V1\u0000submission_history\u0000${canonicalText(rest)}`, "utf8").digest("hex");
export const historyPath = (dir: string): string => join(dir, SUBMISSION_HISTORY_FILE);

function shapeOk(o: Record<string, unknown>): boolean {
  if (o.v !== 1 || typeof o.kind !== "string" || !(o.kind in KEYS) || Object.keys(o).sort().join(",") !== KEYS[o.kind]) return false;
  if (!time(o.seq) || typeof o.prev !== "string" || !HEX64.test(o.prev) || typeof o.hash !== "string" || !HEX64.test(o.hash)) return false;
  if (o.kind === "HEADER") return time(o.created_at_ms);
  if (typeof o.flow_id !== "string" || !UUID.test(o.flow_id) || typeof o.attempt_id !== "string" || !ATTEMPT.test(o.attempt_id) || !time(o.at_ms)) return false;
  if (o.kind === "INTENT_NOT_COMMITTED") return typeof o.code === "string" && CODE.test(o.code);
  if (o.kind === "OUTCOME") return typeof o.outcome === "string" && (OUTCOME_CLASSES as readonly string[]).includes(o.outcome);
  return typeof o.provider_request_id === "string" && UUID.test(o.provider_request_id) && typeof o.proposal_digest === "string" && HEX64.test(o.proposal_digest)
    && typeof o.authorization_digest === "string" && HEX64.test(o.authorization_digest) && (o.provider_mode === "mock" || o.provider_mode === "sandbox");
}

/** Reads and verifies the whole file. Never throws. Anything short of a complete, well-formed, correctly chained
 *  file is reported with a fixed code and the caller refuses. */
export function readSubmissionHistory(dir: string): HistoryRead {
  const file = historyPath(dir);
  let text: string;
  try {
    if (!existsSync(file)) return { ok: false, code: HISTORY_MISSING };
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, code: HISTORY_MALFORMED };
  }
  if (text.length === 0 || !text.endsWith("\n")) return { ok: false, code: HISTORY_MALFORMED }; // empty file or a torn last line
  const rows = text.slice(0, -1).split("\n");
  const intents = new Map<string, HistoryIntent>();
  const cancelled = new Set<string>();
  let prev = ZERO;
  for (let i = 0; i < rows.length; i++) {
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rows[i]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: HISTORY_MALFORMED };
      o = parsed as Record<string, unknown>;
      if (!shapeOk(o)) return { ok: false, code: HISTORY_MALFORMED };
    } catch {
      return { ok: false, code: HISTORY_MALFORMED };
    }
    const { hash, ...rest } = o;
    let expect: string;
    try {
      expect = lineHash(rest);
    } catch {
      return { ok: false, code: HISTORY_MALFORMED };
    }
    if (o.seq !== i || o.prev !== prev || hash !== expect || (i === 0) !== (o.kind === "HEADER")) return { ok: false, code: HISTORY_BROKEN };
    prev = hash as string;
    if (o.kind === "INTENT") {
      const id = o.attempt_id as string;
      if (intents.has(id)) return { ok: false, code: HISTORY_BROKEN }; // an attempt id is recorded once
      intents.set(id, { outcome: null, flow_id: o.flow_id as string, provider_request_id: o.provider_request_id as string, proposal_digest: o.proposal_digest as string, authorization_digest: o.authorization_digest as string, attempt_id: id, provider_mode: o.provider_mode as "mock" | "sandbox", at_ms: o.at_ms as number });
    } else if (o.kind === "INTENT_NOT_COMMITTED") {
      const id = o.attempt_id as string;
      const it = intents.get(id);
      if (!it || it.flow_id !== o.flow_id || cancelled.has(id) || (it.outcome ?? null) !== null) return { ok: false, code: HISTORY_BROKEN }; // cancels exactly one earlier intent of that flow, never one with an outcome
      cancelled.add(id);
    } else if (o.kind === "OUTCOME") {
      const it = intents.get(o.attempt_id as string);
      // an outcome belongs to exactly one earlier, uncancelled intent of that flow, and is recorded once
      if (!it || it.flow_id !== o.flow_id || cancelled.has(it.attempt_id) || (it.outcome ?? null) !== null) return { ok: false, code: HISTORY_BROKEN };
      it.outcome = o.outcome as OutcomeClass;
    }
  }
  return { ok: true, lines: rows.length, head: prev, live: [...intents.values()].filter((x) => !cancelled.has(x.attempt_id)), cancelled: cancelled.size };
}

function append(dir: string, build: (seq: number, prev: string) => Record<string, unknown>, create: boolean): void {
  const file = historyPath(dir);
  let fd: number | null = null;
  try {
    let seq = 0;
    let prev = ZERO;
    if (!create) {
      const cur = readSubmissionHistory(dir); // never append to a file that does not verify
      if (!cur.ok) throw new SubmissionHistoryError(cur.code);
      seq = cur.lines;
      prev = cur.head;
    }
    const rest = build(seq, prev);
    const line = `${JSON.stringify({ ...rest, hash: lineHash(rest) })}\n`;
    fd = openSync(file, create ? "wx" : "a", 0o600); // "wx": refuse to replace an existing history
    const buf = Buffer.from(line, "utf8");
    if (writeSync(fd, buf, 0, buf.length) !== buf.length) throw new SubmissionHistoryError(HISTORY_WRITE_FAILED);
    fsyncSync(fd); // durable before the caller goes on (and so before any provider create)
    if (create) {
      const d = openSync(dir, "r");
      try {
        fsyncSync(d); // the new directory entry too
      } finally {
        closeSync(d);
      }
    }
  } catch (e) {
    throw e instanceof SubmissionHistoryError ? e : new SubmissionHistoryError(HISTORY_WRITE_FAILED);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch { /* nothing more to do */ }
    }
  }
}

/** Creates the file with its header. Throws if it already exists. Call under the store write lock. */
export function createSubmissionHistory(dir: string, at_ms: number): void {
  append(dir, (seq, prev) => ({ v: 1, kind: "HEADER", seq, created_at_ms: at_ms, prev }), true);
}

/** Appends one INTENT and fsyncs. Call under the store write lock, before the intent transaction commits and
 *  therefore before provider create. Throws SubmissionHistoryError; the caller must then send nothing. */
export function appendIntent(dir: string, it: HistoryIntent): void {
  append(dir, (seq, prev) => ({ v: 1, kind: "INTENT", seq, flow_id: it.flow_id, provider_request_id: it.provider_request_id, proposal_digest: it.proposal_digest, authorization_digest: it.authorization_digest, attempt_id: it.attempt_id, provider_mode: it.provider_mode, at_ms: it.at_ms, prev }), false);
}

/** Records that the database transaction for an INTENT did not commit (nothing was sent). Call under the store
 *  write lock. If this cannot be written the intent stays live and the flow stays refused, which fails closed. */
export function appendIntentNotCommitted(dir: string, x: { flow_id: string; attempt_id: string; code: string; at_ms: number }): void {
  append(dir, (seq, prev) => ({ v: 1, kind: "INTENT_NOT_COMMITTED", seq, flow_id: x.flow_id, attempt_id: x.attempt_id, code: CODE.test(x.code) ? x.code : "INTENT_NOT_COMMITTED", at_ms: x.at_ms, prev }), false);
}

/** Records the outcome class of a live intent. Evidence only; it never unblocks anything. Call under the store
 *  write lock. A failure to write it changes nothing: the intent stays live with no outcome. */
export function appendOutcome(dir: string, x: { flow_id: string; attempt_id: string; outcome: OutcomeClass; at_ms: number }): void {
  append(dir, (seq, prev) => ({ v: 1, kind: "OUTCOME", seq, flow_id: x.flow_id, attempt_id: x.attempt_id, outcome: x.outcome, at_ms: x.at_ms, prev }), false);
}
