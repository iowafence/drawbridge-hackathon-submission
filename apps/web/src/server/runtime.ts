// Wires the sandbox integration to the server environment. Server-only. No browser-exposed (public) environment variable is read anywhere.
//
//   AWX_READ_ENV_FILE          absolute path of an owner-only file named `.env.read`      (balances read)
//   AWX_TRANSFER_ENV_FILE      absolute path of an owner-only file named `.env.transfer`  (scoped Transfers key)
//   AWX_ALLOWED_BENEFICIARIES  "<beneficiary uuid>=<label>;..."  sandbox test beneficiaries only
//   AWX_SUBMIT_RELEASE         "<request_id>:<digest>" owner release of one exact transaction
//   DRAWBRIDGE_DATA_DIR        directory for the integration audit chain (outside the repository)
//   DRAWBRIDGE_OPERATOR_SCRYPT scrypt hash of the operator passphrase (see scripts/operator-hash.mjs)
import { AuditLog } from "./audit.ts";
import { AwxError, readBalances, SandboxClient } from "./awx.ts";
import type { BalanceRead, Role } from "./awx.ts";
import { CURRENCY } from "./policy.ts";
import type { Ctx } from "./transfers.ts";

const g = globalThis as unknown as { __drawbridgeAwx?: Partial<Record<Role, SandboxClient>> };

function clientFor(role: Role): SandboxClient {
  const cache = (g.__drawbridgeAwx ??= {});
  return (cache[role] ??= new SandboxClient(role));
}

export async function liveBalances(): Promise<BalanceRead> {
  try {
    return await readBalances(clientFor("read"));
  } catch (e) {
    return { ok: false, code: e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED", httpStatus: null };
  }
}

export function usdAvailable(b: BalanceRead): string | null {
  return b.ok ? (b.rows.find((r) => r.currency === CURRENCY)?.available ?? null) : null;
}

export function parseAllowlist(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(";")) {
    const m = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})=([A-Za-z0-9 ()._-]{1,60})\s*$/.exec(part);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

export function transferCredentialStatus(): string {
  try {
    clientFor("transfer");
    return "CONFIGURED";
  } catch (e) {
    return e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED";
  }
}

/** Returns a fixed code instead of a context when the workflow cannot run (fail closed). */
export function runtimeCtx(): Ctx | string {
  const dir = process.env.DRAWBRIDGE_DATA_DIR;
  if (!dir || !dir.startsWith("/")) return "AUDIT_STORAGE_NOT_CONFIGURED";
  return {
    audit: new AuditLog(dir),
    now: Date.now,
    allowlist: parseAllowlist(process.env.AWX_ALLOWED_BENEFICIARIES),
    transferClient: () => clientFor("transfer"),
    availableUsd: async () => usdAvailable(await liveBalances()),
    release: process.env.AWX_SUBMIT_RELEASE,
  };
}
