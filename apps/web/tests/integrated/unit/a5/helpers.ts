// A5 test support. Synthetic values only; no network, no provider, no credentials. SQLite is in-memory unless a test
// needs a file. Scratch files go under DB_A5_SCRATCH when set (lane rule), else the OS temp directory.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AUDIT_CHAIN, AUDIT_TABLE, AUDIT_ZERO, auditPort } from "../../../../integrated/auditChain.ts";
import { canonicalText, flowDigest } from "../../../../integrated/flowCanonical.ts";
import type { FlowAuditEvent, FlowAuditInput, FlowState } from "../../../../integrated/flowTypes.ts";

export const FLOW_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const FLOW_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const HUMAN = "human:operator";
export const T0 = 1_794_000_000_000;
export const DIGEST = "d".repeat(64);

export function scratch(): string {
  const base = process.env.DB_A5_SCRATCH ?? tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "a5-"));
}

export function openDb(file = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(file);
  for (const sql of auditPort.ddl) db.exec(sql);
  return db;
}

let clock = 0;
export function ev(flow_id: string, type: string, from_state: FlowState | null, to_state: FlowState | null, flow_version: number, data: FlowAuditInput["data"] = {}, actor = "server"): FlowAuditInput {
  return { flow_id, type, actor, from_state, to_state, flow_version, data, at_ms: T0 + clock++ * 1000 };
}

/** A complete, legal mock-mode history for one flow: 10 transitions and 1 audit-only refusal. */
export function happyInputs(flowId: string): FlowAuditInput[] {
  return [
    ev(flowId, "FLOW_CREATED", null, "DRAFT", 1, { case_id: "CASE-SBX-0002" }, HUMAN),
    ev(flowId, "EVIDENCE_ATTACHED", "DRAFT", "EVIDENCE_READY", 2, { evidence_digest: DIGEST, document_id: "DOC-SBX-0002", evidence_source: "FIXTURE_REPLAY" }),
    ev(flowId, "GATE_EVALUATED", "EVIDENCE_READY", "GATE_ELIGIBLE", 3, { decision: "ELIGIBLE_FOR_HUMAN_REVIEW", rule: "P-ALL VERIFIED", gate_digest: DIGEST }),
    ev(flowId, "HUMAN_REVIEW_REQUESTED", "GATE_ELIGIBLE", "AWAITING_HUMAN", 4, {}, HUMAN),
    ev(flowId, "REFUSED", "AWAITING_HUMAN", null, 4, { op: "approve", code: "DIGEST_MISMATCH" }, HUMAN),
    ev(flowId, "HUMAN_APPROVED", "AWAITING_HUMAN", "HUMAN_APPROVED", 5, { proposal_digest: DIGEST, gate_digest: DIGEST, approval_digest: DIGEST }, HUMAN),
    ev(flowId, "SUBMIT_INTENT_RECORDED", "HUMAN_APPROVED", "SUBMIT_INTENT_RECORDED", 6, { attempt_id: "11111111-2222-4333-8444-555555555555", provider_mode: "mock" }, HUMAN),
    ev(flowId, "CREATE_ACCEPTED", "SUBMIT_INTENT_RECORDED", "SUBMITTED", 7, { http_status: 201, provider_transfer_id: "99999999-8888-4777-8666-555555555555", create_reported_status: "PROCESSING" }),
    ev(flowId, "PROVIDER_READ", "SUBMITTED", "PROVIDER_PROCESSING", 8, { http_status: 200, provider_status: "PROCESSING" }),
    ev(flowId, "PROVIDER_READ", "PROVIDER_PROCESSING", null, 8, { http_status: 200, provider_status: "PROCESSING" }),
    ev(flowId, "PROVIDER_READ", "PROVIDER_PROCESSING", "PROVIDER_PAID", 9, { http_status: 200, provider_status: "PAID" }),
  ];
}

export function appendAll(db: DatabaseSync, inputs: FlowAuditInput[]): FlowAuditEvent[] {
  return inputs.map((i) => auditPort.append(db, i));
}

/** Two flows interleaved: A's 11 events with B's first 3 woven in. 14 events. */
export function twoFlows(db: DatabaseSync): FlowAuditEvent[] {
  const a = happyInputs(FLOW_A);
  const b = happyInputs(FLOW_B).slice(0, 3);
  return appendAll(db, [a[0], b[0], a[1], a[2], b[1], a[3], a[4], a[5], b[2], ...a.slice(6)]);
}

// ---- what an attacker with write access to the SQLite file can do ---------------------------------------------------

export function dropGuards(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER ${AUDIT_TABLE}_no_update; DROP TRIGGER ${AUDIT_TABLE}_no_delete`);
}

export function allEvents(db: DatabaseSync): FlowAuditEvent[] {
  const rows = db.prepare(`SELECT * FROM ${AUDIT_TABLE} ORDER BY seq`).all() as Record<string, unknown>[];
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data as string), chain: AUDIT_CHAIN }) as unknown as FlowAuditEvent);
}

/** Replaces the whole table with `events`, renumbered and with every prev and hash recomputed so the chain links. */
export function rewriteChain(db: DatabaseSync, events: FlowAuditEvent[]): FlowAuditEvent[] {
  dropGuardsIfPresent(db);
  db.exec(`DELETE FROM ${AUDIT_TABLE}`);
  const heads = new Map<string, string>();
  const out: FlowAuditEvent[] = [];
  const ins = db.prepare(`INSERT INTO ${AUDIT_TABLE} (seq, flow_id, type, actor, from_state, to_state, flow_version, data, at_ms, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of events) {
    const { hash: _old, ...body } = e;
    const rest = { ...body, seq: out.length + 1, prev: heads.get(e.flow_id) ?? AUDIT_ZERO };
    const hash = flowDigest("audit_event", rest);
    heads.set(e.flow_id, hash);
    ins.run(rest.seq, rest.flow_id, rest.type, rest.actor, rest.from_state, rest.to_state, rest.flow_version, canonicalText(rest.data), rest.at_ms, rest.prev, hash);
    out.push({ ...rest, hash });
  }
  return out;
}

function dropGuardsIfPresent(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER IF EXISTS ${AUDIT_TABLE}_no_update; DROP TRIGGER IF EXISTS ${AUDIT_TABLE}_no_delete`);
}
