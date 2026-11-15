// Server-only Airwallex SANDBOX transport. Never import this from a client component.
// Fixed host, fixed per-role operation allowlist, role credential files read from outside the repository.
// Errors carry fixed codes only; credentials, tokens and caller-supplied strings are never echoed.
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export const AWX_ORIGIN = "https://api.sandbox.airwallex.com";
export const AWX_BASE = `${AWX_ORIGIN}/api/v1`;
const LOGIN = "/authentication/login";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type Role = "read" | "transfer";
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const ROLE_KEYS: Record<Role, [string, string]> = {
  read: ["AWX_READ_CLIENT_ID", "AWX_READ_API_KEY"],
  transfer: ["AWX_TRANSFER_CLIENT_ID", "AWX_TRANSFER_API_KEY"],
};
export const ENV_FILE_VAR: Record<Role, string> = { read: "AWX_READ_ENV_FILE", transfer: "AWX_TRANSFER_ENV_FILE" };
const ANY_ROLE_KEY = /^AWX_(READ|SETUP|EXECUTOR|TRANSFER|ADMIN)_/;

// The complete set of provider operations this application can perform. The read role has no POST at all.
const ALLOW: Record<Role, { method: "GET" | "POST"; path: RegExp }[]> = {
  read: [
    { method: "GET", path: /^\/balances\/current$/ },
    { method: "GET", path: /^\/global_accounts$/ },
  ],
  transfer: [
    { method: "POST", path: /^\/transfers\/validate$/ },
    { method: "POST", path: /^\/transfers\/create$/ },
    { method: "GET", path: new RegExp(`^/transfers/${UUID}$`) },
    { method: "GET", path: new RegExp(`^/transfers\\?request_id=${UUID}$`) },
    { method: "GET", path: /^\/beneficiaries$/ }, // read-only lookup of existing sandbox test beneficiaries
  ],
};

export class AwxError extends Error {
  code: string;
  /** true only when the failed call was the requested operation itself and it may have reached the provider. */
  sent: boolean;
  constructor(code: string, sent = false) {
    super(code);
    this.code = code;
    this.sent = sent;
  }
}

/** Parse JSON keeping every number as its exact source text, so money never passes through a float. */
export function parseJsonDecimal(text: string): unknown {
  return JSON.parse(text, ((_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === "number" ? (ctx?.source ?? String(v)) : v) as (k: string, v: unknown) => unknown);
}

export function loadRoleEnv(path: string | undefined, role: Role): { clientId: string; apiKey: string } {
  if (!path) throw new AwxError("AWX_E_CRED_FILE_NOT_CONFIGURED");
  if (basename(path) !== `.env.${role}`) throw new AwxError("AWX_E_CRED_FILE_NAME");
  let mode: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error("not a file");
    mode = st.mode;
  } catch {
    throw new AwxError("AWX_E_CRED_FILE_MISSING");
  }
  if (mode & 0o077) throw new AwxError("AWX_E_CRED_FILE_PERMISSIONS");
  const found: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (ROLE_KEYS[role].includes(key) || key === "AWX_ENV" || key === "AWX_BASE_URL") found[key] = value;
    else if (ANY_ROLE_KEY.test(key)) throw new AwxError("AWX_E_CRED_FILE_ROLE_MIX");
  }
  if (found.AWX_ENV !== "sandbox") throw new AwxError("AWX_E_CONFIG_ENVIRONMENT");
  if ((found.AWX_BASE_URL ?? AWX_BASE).replace(/\/+$/, "") !== AWX_BASE) throw new AwxError("AWX_E_CONFIG_BASE_URL");
  const [idKey, keyKey] = ROLE_KEYS[role];
  if (!found[idKey] || !found[keyKey]) throw new AwxError("AWX_E_CRED_INCOMPLETE");
  return { clientId: found[idKey], apiKey: found[keyKey] };
}

export type AwxResponse = { status: number; body: unknown };

export class SandboxClient {
  readonly role: Role;
  #creds: { clientId: string; apiKey: string };
  #token: { value: string; exp: number } | null = null;
  #fetch: FetchLike;
  #timeoutMs: number;

  constructor(role: Role, opts: { envPath?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
    this.role = role;
    this.#creds = loadRoleEnv(opts.envPath ?? process.env[ENV_FILE_VAR[role]], role);
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
  }

  toJSON() {
    return { client: "SandboxClient", role: this.role };
  }

  static allowed(role: Role, method: string, path: string): boolean {
    return typeof path === "string" && ALLOW[role].some((a) => a.method === method && a.path.test(path));
  }

  async request(method: "GET" | "POST", path: string, payload?: Record<string, string | boolean>): Promise<AwxResponse> {
    if (!SandboxClient.allowed(this.role, method, path)) throw new AwxError("AWX_E_OPERATION_DENIED");
    if ((method === "POST") !== (payload !== undefined)) throw new AwxError("AWX_E_OPERATION_DENIED");
    const token = await this.#login();
    return this.#send(method, path, payload, { Authorization: `Bearer ${token}` }, true);
  }

  async #login(): Promise<string> {
    if (this.#token && this.#token.exp > Date.now() + 60_000) return this.#token.value;
    const res = await this.#send("POST", LOGIN, undefined, { "x-client-id": this.#creds.clientId, "x-api-key": this.#creds.apiKey }, false);
    const body = res.body as { token?: unknown; expires_at?: unknown } | null;
    if (res.status !== 201 || !body || typeof body.token !== "string" || !body.token) throw new AwxError("AWX_E_LOGIN_FAILED");
    const exp = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    this.#token = { value: body.token, exp: Number.isFinite(exp) ? exp : Date.now() + 5 * 60_000 };
    return body.token;
  }

  async #send(method: string, path: string, payload: unknown, headers: Record<string, string>, isOperation: boolean): Promise<AwxResponse> {
    const url = AWX_BASE + path;
    if (new URL(url).origin !== AWX_ORIGIN) throw new AwxError("AWX_E_OPERATION_DENIED");
    let status: number;
    let text: string;
    try {
      const res = await this.#fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch {
      throw new AwxError("AWX_E_NETWORK", isOperation); // the underlying error (host, reason) is deliberately dropped
    }
    let body: unknown = null;
    try {
      body = text ? parseJsonDecimal(text) : null;
    } catch {
      body = null;
    }
    if (status < 200 || status > 299) {
      // error responses keep only short provider code/source strings; messages and details are dropped
      const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const kept: Record<string, string> = {};
      for (const k of ["code", "source"]) if (typeof b[k] === "string") kept[k] = (b[k] as string).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
      body = kept;
      if (status === 401 && isOperation) this.#token = null;
    }
    return { status, body };
  }
}

export type BalanceRow = { currency: string; available: string; pending: string; reserved: string; total: string };
export type BalanceRead =
  | { ok: true; fetchedAt: string; httpStatus: number; rows: BalanceRow[] }
  | { ok: false; code: string; httpStatus: number | null };

const DEC = /^-?\d{1,18}(\.\d{1,8})?$/;

/** GET /balances/current through the read role. Returns only currency and amount columns, as exact decimal text. */
export async function readBalances(client: SandboxClient, now: () => number = Date.now): Promise<BalanceRead> {
  let res: AwxResponse;
  try {
    res = await client.request("GET", "/balances/current");
  } catch (e) {
    return { ok: false, code: e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED", httpStatus: null };
  }
  if (res.status !== 200) return { ok: false, code: "AWX_E_HTTP_STATUS", httpStatus: res.status };
  if (!Array.isArray(res.body)) return { ok: false, code: "AWX_E_UNRECOGNIZED_RESPONSE", httpStatus: 200 };
  const rows: BalanceRow[] = [];
  for (const item of res.body as Record<string, unknown>[]) {
    const row = {
      currency: item?.currency,
      available: item?.available_amount,
      pending: item?.pending_amount,
      reserved: item?.reserved_amount,
      total: item?.total_amount,
    };
    if (typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) return { ok: false, code: "AWX_E_UNRECOGNIZED_RESPONSE", httpStatus: 200 };
    for (const k of ["available", "pending", "reserved", "total"] as const) {
      if (typeof row[k] !== "string" || !DEC.test(row[k] as string)) return { ok: false, code: "AWX_E_UNRECOGNIZED_RESPONSE", httpStatus: 200 };
    }
    rows.push(row as BalanceRow);
  }
  return { ok: true, fetchedAt: new Date(now()).toISOString(), httpStatus: 200, rows };
}

export type BeneficiarySummary = { id: string; nickname: string; country: string; currency: string; methods: string[]; clearing: string; entityType: string };
export type BeneficiaryRead = { ok: true; httpStatus: number; items: BeneficiarySummary[]; hasMore: boolean } | { ok: false; code: string; httpStatus: number | null; providerCode?: string };

const short = (v: unknown, re: RegExp, max: number) => (typeof v === "string" ? v.replace(re, "").slice(0, max) : "");

/** GET /beneficiaries. Keeps only id, nickname, country, currency, method, clearing system and entity type.
 *  Account numbers, routing values, names, addresses and identity fields are never copied out of the response. */
export async function listBeneficiaries(client: SandboxClient): Promise<BeneficiaryRead> {
  let res: AwxResponse;
  try {
    res = await client.request("GET", "/beneficiaries");
  } catch (e) {
    return { ok: false, code: e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED", httpStatus: null };
  }
  if (res.status !== 200) return { ok: false, code: "AWX_E_HTTP_STATUS", httpStatus: res.status, providerCode: (res.body as { code?: string } | null)?.code };
  const body = res.body as { items?: unknown; has_more?: unknown } | null;
  if (!body || !Array.isArray(body.items)) return { ok: false, code: "AWX_E_UNRECOGNIZED_RESPONSE", httpStatus: 200 };
  const items: BeneficiarySummary[] = [];
  for (const raw of body.items as Record<string, unknown>[]) {
    const ben = (raw?.beneficiary ?? {}) as Record<string, unknown>;
    const bank = (ben.bank_details ?? {}) as Record<string, unknown>;
    const methods = (Array.isArray(raw?.transfer_methods) ? raw.transfer_methods : Array.isArray(raw?.payment_methods) ? raw.payment_methods : []) as unknown[];
    if (typeof raw?.id !== "string" || !new RegExp(`^${UUID}$`).test(raw.id)) continue;
    items.push({
      id: raw.id,
      nickname: short(raw.nickname, /[^A-Za-z0-9 ()._-]/g, 60),
      country: short(bank.bank_country_code, /[^A-Z]/g, 2),
      currency: short(bank.account_currency, /[^A-Z]/g, 3),
      methods: methods.map((m) => short(m, /[^A-Z_]/g, 20)).filter(Boolean),
      clearing: short(bank.local_clearing_system, /[^A-Za-z0-9_]/g, 30),
      entityType: short(ben.entity_type, /[^A-Z_]/g, 20),
    });
  }
  return { ok: true, httpStatus: 200, items, hasMore: body.has_more === true };
}
