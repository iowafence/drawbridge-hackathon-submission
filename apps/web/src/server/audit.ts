// Append-only, hash-chained integration audit log (local JSONL file).
// This is the AIRWALLEX SANDBOX INTEGRATION chain. It is NOT the accepted G2C1 ledger event chain and NOT the six
// synthetic E3 recorder events. Durability claim: a local file, fsynced on append, one writer at a time. It is not
// externally anchored and a host administrator can replace it.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const CHAIN = "AWX_SANDBOX_INTEGRATION_V1";
const GENESIS = "0".repeat(64);
const FORBIDDEN_KEY = /key|token|secret|password|passphrase|authorization|account_number|routing|iban|swift|bank/i;

export type AuditData = Record<string, string | number | boolean | null>;
export type AuditEvent = { chain: string; seq: number; ts: string; type: string; transfer: string | null; actor: string; data: AuditData; prev: string; hash: string };

export class AuditError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const canonical = canon;

export class AuditLog {
  readonly dir: string;
  readonly file: string;
  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "integration_audit.jsonl");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Read and verify the whole chain. Any break refuses every later operation (fail closed). */
  read(): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    const events: AuditEvent[] = [];
    let prev = GENESIS;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      let e: AuditEvent;
      try {
        e = JSON.parse(line);
      } catch {
        throw new AuditError("AUDIT_CHAIN_BROKEN");
      }
      const { hash, ...rest } = e;
      if (e.chain !== CHAIN || e.seq !== events.length + 1 || e.prev !== prev || hash !== sha256(canon(rest))) throw new AuditError("AUDIT_CHAIN_BROKEN");
      prev = hash;
      events.push(e);
    }
    return events;
  }

  append(type: string, transfer: string | null, actor: string, data: AuditData, now: number = Date.now()): AuditEvent {
    for (const [k, v] of Object.entries(data)) {
      if (FORBIDDEN_KEY.test(k) || (typeof v === "string" && v.length > 300)) throw new AuditError("AUDIT_FIELD_REFUSED");
    }
    const lock = join(this.dir, "audit.lock");
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600); // one writer at a time, across processes
    } catch {
      throw new AuditError("AUDIT_LOCKED");
    }
    try {
      const events = this.read();
      const rest = { chain: CHAIN, seq: events.length + 1, ts: new Date(now).toISOString(), type, transfer, actor, data, prev: events.at(-1)?.hash ?? GENESIS };
      const event: AuditEvent = { ...rest, hash: sha256(canon(rest)) };
      const out = openSync(this.file, "a", 0o600);
      try {
        writeSync(out, JSON.stringify(event) + "\n");
        fsyncSync(out);
      } finally {
        closeSync(out);
      }
      return event;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}
