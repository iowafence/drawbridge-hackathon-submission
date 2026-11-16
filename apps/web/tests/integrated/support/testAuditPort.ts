// A minimal, independent AuditPort (flow-v1 §10 shape) for running the flow service when the audit lane's module is
// not merged yet. TEST CODE ONLY. It is NOT the product's audit chain and makes no tamper-resistance claim.
import { flowDigest } from "../../../integrated/flowCanonical.ts";
import type { AuditPort, FlowAuditEvent, FlowAuditInput, SqlTx } from "../../../integrated/flowTypes.ts";

const ZERO = "0".repeat(64);
type Row = { seq: number; flow_id: string; prev: string; hash: string; body: string };

export const testAuditPort: AuditPort = {
  ddl: ["CREATE TABLE IF NOT EXISTS a4_test_audit (seq INTEGER PRIMARY KEY, flow_id TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL)"],
  append(tx: SqlTx, ev: FlowAuditInput): FlowAuditEvent {
    const last = tx.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM a4_test_audit").get() as { n: number };
    const prevRow = tx.prepare("SELECT hash FROM a4_test_audit WHERE flow_id = ? ORDER BY seq DESC LIMIT 1").get(ev.flow_id) as { hash: string } | undefined;
    const rest = { ...ev, chain: "DB_INTEGRATED_FLOW_V1" as const, seq: Number(last.n) + 1, prev: prevRow?.hash ?? ZERO };
    const event: FlowAuditEvent = { ...rest, hash: flowDigest("audit_event", rest) };
    tx.prepare("INSERT INTO a4_test_audit (seq, flow_id, prev, hash, body) VALUES (?, ?, ?, ?, ?)").run(event.seq, event.flow_id, event.prev, event.hash, JSON.stringify(rest));
    return event;
  },
  verify(tx: SqlTx, flowId?: string) {
    const rows = tx.prepare("SELECT seq, flow_id, prev, hash, body FROM a4_test_audit ORDER BY seq").all() as Row[];
    const heads = new Map<string, string>();
    let expected = 1;
    let count = 0;
    let head = ZERO;
    for (const r of rows) {
      if (Number(r.seq) !== expected++) return { ok: false as const, code: "AUDIT_CHAIN_BROKEN", at_seq: Number(r.seq) };
      let hash = "";
      try {
        hash = flowDigest("audit_event", JSON.parse(r.body));
      } catch {
        hash = "";
      }
      if (hash !== r.hash || r.prev !== (heads.get(r.flow_id) ?? ZERO)) return { ok: false as const, code: "AUDIT_CHAIN_BROKEN", at_seq: Number(r.seq) };
      heads.set(r.flow_id, r.hash);
      if (flowId === undefined || r.flow_id === flowId) {
        count++;
        head = r.hash;
      }
    }
    return { ok: true as const, count, head };
  },
};
