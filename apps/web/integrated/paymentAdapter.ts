// DRAWBRIDGE integrated flow (contract flow-v1 section 7): payment provider adapter. OWNER: A3.
//
// Two implementations of ProviderPort:
//   mockProvider(script)  the DEFAULT. An offline fake with scriptable outcomes. It makes no network call.
//   sandboxProvider()     wraps the existing transfer-role sandbox client (src/server/awx.ts, unchanged), which holds
//                         the fixed sandbox host and the operation allowlist. Available only when the provider mode
//                         flag says "sandbox", in an owner-authorized local environment. No host name appears in this
//                         file and there is no production option anywhere.
//
// This is the only integrated file that holds the transfer role or names the create and validate operations.
// The adapter decides nothing about authorization. The two classify functions turn a raw provider answer into
// exactly one of: ACCEPTED, REFUSED or UNCERTAIN for a create, and MATCH or "no change" for a read. The rules are
// copied from the historic sandbox workflow (transfers.ts submit / reconcile).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AwxError, SandboxClient } from "../src/server/awx.ts";
import type { AwxResponse } from "../src/server/awx.ts";
import { fromMinor, toMinor } from "../src/server/policy.ts";
import { KNOWN_PROVIDER_STATUS } from "../src/server/transfers.ts";
import type { FlowProposal, ProviderCallResult, ProviderPort, ProviderTransferBody } from "./flowTypes.ts";

/** Mock-mode beneficiary allowlist: one synthetic test supplier. Never a real beneficiary. */
export const MOCK_ALLOWLIST: Map<string, string> = new Map([["00000000-0000-4000-8000-0000000000be", "Synthetic test supplier"]]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const short = (v: unknown, fallback: string): string => {
  const s = typeof v === "string" ? v.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) : "";
  return s || fallback;
};

/** The provider request body, built from the stored proposal only. The amount is exact decimal text. */
export function providerBody(p: FlowProposal): ProviderTransferBody {
  return {
    beneficiary_id: p.beneficiary_id,
    transfer_amount: fromMinor(BigInt(p.amount_minor)),
    transfer_currency: p.currency,
    source_currency: p.currency,
    transfer_method: p.transfer_method,
    reason: p.reason,
    reference: p.reference,
    request_id: p.provider_request_id,
  };
}

export type CreateClass =
  | { kind: "ACCEPTED"; http_status: number; provider_transfer_id: string; reported_status: string }
  | { kind: "REFUSED"; http_status: number; provider_code: string }
  | { kind: "UNCERTAIN"; http_status: number | null; code: string };

/** Section 7 rule 4. Anything that is not a well-formed acceptance or a definite refusal is UNCERTAIN. */
export function classifyCreate(r: ProviderCallResult | null | undefined, requestId: string): CreateClass {
  if (!r || typeof r !== "object") return { kind: "UNCERTAIN", http_status: null, code: "UNRECOGNIZED_PROVIDER_RESPONSE" };
  if (r.kind === "TRANSPORT_ERROR") return { kind: "UNCERTAIN", http_status: null, code: short(r.code, "PROVIDER_TRANSPORT_ERROR") };
  if (r.kind !== "HTTP" || !Number.isInteger(r.status)) return { kind: "UNCERTAIN", http_status: null, code: "UNRECOGNIZED_PROVIDER_RESPONSE" };
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
  if (r.status === 200 || r.status === 201) {
    if (typeof b.id !== "string" || !UUID.test(b.id) || typeof b.status !== "string" || !KNOWN_PROVIDER_STATUS.has(b.status) || b.request_id !== requestId) return { kind: "UNCERTAIN", http_status: r.status, code: "UNRECOGNIZED_PROVIDER_RESPONSE" };
    return { kind: "ACCEPTED", http_status: r.status, provider_transfer_id: b.id, reported_status: b.status };
  }
  const code = short(b.code, "");
  if ([400, 401, 403, 404, 422].includes(r.status) && code !== "request_id_duplicate") return { kind: "REFUSED", http_status: r.status, provider_code: code || "PROVIDER_REFUSED" };
  return { kind: "UNCERTAIN", http_status: r.status, code: code === "request_id_duplicate" ? "REQUEST_ID_DUPLICATE" : "AMBIGUOUS_PROVIDER_STATUS" };
}

export type ReadClass =
  | { kind: "MATCH"; provider_transfer_id: string; status: string }
  | { kind: "NO_CHANGE"; code: string; http_status: number | null };

/** Section 7 rule 5. A read matches only when it is HTTP 200 and the record has this flow's request id, currency and
 *  exact amount, and (when one is already known) the same transfer id, with a recognized status. */
export function classifyRead(r: ProviderCallResult | null | undefined, p: FlowProposal, knownTransferId: string | null): ReadClass {
  const no = (code: string, http: number | null = null): ReadClass => ({ kind: "NO_CHANGE", code, http_status: http });
  if (!r || typeof r !== "object") return no("UNRECOGNIZED_PROVIDER_RESPONSE");
  if (r.kind === "TRANSPORT_ERROR") return no(short(r.code, "PROVIDER_TRANSPORT_ERROR"));
  if (r.kind !== "HTTP" || !Number.isInteger(r.status)) return no("UNRECOGNIZED_PROVIDER_RESPONSE");
  if (r.status !== 200) return no("RECONCILE_HTTP_STATUS", r.status);
  let rec = r.body as Record<string, unknown> | null;
  if (!knownTransferId) {
    const items = (rec as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return no("UNRECOGNIZED_PROVIDER_RESPONSE", 200);
    const mine = items.filter((x) => x && typeof x === "object" && (x as Record<string, unknown>).request_id === p.provider_request_id);
    if (mine.length === 0) return no("PROVIDER_HAS_NO_RECORD_FOR_REQUEST_ID", 200);
    if (mine.length > 1) return no("PROVIDER_HAS_MULTIPLE_RECORDS", 200);
    rec = mine[0] as Record<string, unknown>;
  }
  if (!rec || typeof rec !== "object" || typeof rec.id !== "string" || !UUID.test(rec.id) || typeof rec.status !== "string") return no("UNRECOGNIZED_PROVIDER_RESPONSE", 200);
  let sameValue = false;
  try {
    sameValue = toMinor(String(rec.transfer_amount)).toString() === p.amount_minor;
  } catch {
    sameValue = false;
  }
  if (rec.request_id !== p.provider_request_id || rec.transfer_currency !== p.currency || !sameValue || (knownTransferId !== null && rec.id !== knownTransferId)) return no("PROVIDER_RECORD_MISMATCH", 200);
  if (typeof rec.beneficiary_id === "string" && rec.beneficiary_id !== p.beneficiary_id) return no("PROVIDER_RECORD_MISMATCH", 200);
  if (!KNOWN_PROVIDER_STATUS.has(rec.status)) return no("UNRECOGNIZED_PROVIDER_STATUS", 200);
  return { kind: "MATCH", provider_transfer_id: rec.id, status: rec.status };
}

// ---------------------------------------------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------------------------------------------

/** What the mock does on the next call. "AFTER_SEND" outcomes DO create the provider-side record and then lose or
 *  garble the answer, which is exactly the case that must never be resubmitted. */
export type MockScript = {
  validate?: "OK" | "REFUSE_400" | "TRANSPORT";
  create?: "ACCEPT" | "REFUSE_400" | "REFUSE_422" | "TIMEOUT_BEFORE_SEND" | "TIMEOUT_AFTER_SEND" | "HTTP_500_BEFORE_SEND" | "HTTP_500_AFTER_SEND" | "HTTP_409_AFTER_SEND" | "HTTP_429_BEFORE_SEND" | "MALFORMED_201" | "WRONG_ECHO_201";
  /** Status the provider-side record starts with. Default PROCESSING. */
  createStatus?: string;
  read?: "OK" | "HTTP_503" | "TRANSPORT";
  /** Absolute path. When set, provider-side records survive a restart and are shared by every process using the
   *  same file (as a real provider's would be), and each create call is appended to `<stateFile>.creates`. */
  stateFile?: string;
};

export type MockRecord = { id: string; status: string; request_id: string; transfer_amount: string; transfer_currency: string; beneficiary_id: string };
type MockState = { records: Record<string, MockRecord>; validate: number; create: number; read_by_id: number; read_by_request_id: number };

export type MockProvider = ProviderPort & {
  readonly mode: "mock";
  /** Live script: tests and the demo may change it between calls. Never reachable from a request. */
  script: MockScript;
  calls(): { validate: number; create: number; readById: number; readByRequestId: number };
  records(): MockRecord[];
  /** Simulates the provider advancing a transfer. */
  setStatus(requestId: string, status: string): void;
  /** Simulates a provider-side record that disagrees with the request. */
  alter(requestId: string, patch: Partial<MockRecord>): void;
  /** Simulates the provider holding a second record for the same request id. */
  duplicate(requestId: string): void;
};

const transportError = (): ProviderCallResult => ({ kind: "TRANSPORT_ERROR", code: "MOCK_E_NETWORK" });
const http = (status: number, body: unknown): ProviderCallResult => ({ kind: "HTTP", status, body });
/** Deterministic provider-side transfer id for a request id. */
const mockTransferId = (requestId: string): string => {
  const h = createHash("sha256").update(`mock-transfer\n${requestId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function mockProvider(script: MockScript = {}): MockProvider {
  if (script.stateFile !== undefined && !isAbsolute(script.stateFile)) throw new Error("MOCK_STATE_PATH_NOT_ABSOLUTE");
  const file = script.stateFile ?? null;
  let mem: MockState = { records: {}, validate: 0, create: 0, read_by_id: 0, read_by_request_id: 0 };
  const extra: Record<string, MockRecord[]> = {};
  const load = (): MockState => (file ? (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as MockState) : { records: {}, validate: 0, create: 0, read_by_id: 0, read_by_request_id: 0 }) : mem);
  const save = (s: MockState): void => {
    if (!file) {
      mem = s;
      return;
    }
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const p: MockProvider = {
    mode: "mock",
    script,
    calls() {
      const s = load();
      const creates = file ? (existsSync(`${file}.creates`) ? readFileSync(`${file}.creates`, "utf8").split("\n").filter(Boolean).length : 0) : s.create;
      return { validate: s.validate, create: creates, readById: s.read_by_id, readByRequestId: s.read_by_request_id };
    },
    records: () => Object.values(load().records),
    setStatus(requestId, status) {
      const s = load();
      if (!s.records[requestId]) throw new Error("MOCK_NO_SUCH_RECORD");
      s.records[requestId].status = status;
      save(s);
    },
    alter(requestId, patch) {
      const s = load();
      if (!s.records[requestId]) throw new Error("MOCK_NO_SUCH_RECORD");
      Object.assign(s.records[requestId], patch);
      save(s);
    },
    duplicate(requestId) {
      const r = load().records[requestId];
      if (!r) throw new Error("MOCK_NO_SUCH_RECORD");
      (extra[requestId] ??= []).push({ ...r, id: mockTransferId(`${requestId}#${extra[requestId]?.length ?? 0}`) });
    },
    async validate() {
      const s = load();
      s.validate++;
      save(s);
      const v = p.script.validate ?? "OK";
      if (v === "TRANSPORT") return transportError();
      if (v === "REFUSE_400") return http(400, { code: "invalid_argument" });
      return http(200, {});
    },
    async create(body) {
      if (file) appendFileSync(`${file}.creates`, `${body.request_id}\n`, { mode: 0o600 });
      const s = load();
      s.create++;
      const c = p.script.create ?? "ACCEPT";
      const before = (r: ProviderCallResult): ProviderCallResult => {
        save(s);
        return r;
      };
      if (c === "TIMEOUT_BEFORE_SEND") return before(transportError());
      if (c === "HTTP_500_BEFORE_SEND") return before(http(500, {}));
      if (c === "HTTP_429_BEFORE_SEND") return before(http(429, {}));
      if (c === "REFUSE_400") return before(http(400, { code: "invalid_argument" }));
      if (c === "REFUSE_422") return before(http(422, { code: "validation_failed" }));
      // the provider's own idempotency: a repeated request id never creates a second transfer
      if (s.records[body.request_id]) return before(http(400, { code: "request_id_duplicate" }));
      const rec: MockRecord = { id: mockTransferId(body.request_id), status: p.script.createStatus ?? "PROCESSING", request_id: body.request_id, transfer_amount: body.transfer_amount, transfer_currency: body.transfer_currency, beneficiary_id: body.beneficiary_id };
      s.records[body.request_id] = rec;
      save(s);
      if (c === "TIMEOUT_AFTER_SEND") return transportError();
      if (c === "HTTP_500_AFTER_SEND") return http(500, {});
      if (c === "HTTP_409_AFTER_SEND") return http(409, {});
      if (c === "MALFORMED_201") return http(201, { ok: true });
      if (c === "WRONG_ECHO_201") return http(201, { ...rec, request_id: "00000000-0000-4000-8000-000000000000" });
      return http(201, { ...rec });
    },
    async readById(id) {
      const s = load();
      s.read_by_id++;
      save(s);
      if (p.script.read === "TRANSPORT") return transportError();
      if (p.script.read === "HTTP_503") return http(503, {});
      const rec = Object.values(s.records).find((x) => x.id === id);
      return rec ? http(200, { ...rec }) : http(404, { code: "not_found" });
    },
    async readByRequestId(requestId) {
      const s = load();
      s.read_by_request_id++;
      save(s);
      if (p.script.read === "TRANSPORT") return transportError();
      if (p.script.read === "HTTP_503") return http(503, {});
      const rec = s.records[requestId];
      return http(200, { items: rec ? [{ ...rec }, ...(extra[requestId] ?? [])] : [], has_more: false });
    },
  };
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Sandbox provider. Never the default. Tests drive it with a mocked transport only.
// ---------------------------------------------------------------------------------------------------------------

/** `client` is for tests (a transfer-role client over a mocked transport). In the runtime it is left unset and the
 *  client is built lazily from the owner-only credential file; a missing credential fails closed as a transport error. */
export function sandboxProvider(opts: { client?: () => SandboxClient } = {}): ProviderPort {
  let cached: SandboxClient | null = null;
  const client = (): SandboxClient => (opts.client ? opts.client() : (cached ??= new SandboxClient("transfer")));
  const call = async (fn: (c: SandboxClient) => Promise<AwxResponse>): Promise<ProviderCallResult> => {
    try {
      const res = await fn(client());
      return { kind: "HTTP", status: res.status, body: res.body };
    } catch (e) {
      return { kind: "TRANSPORT_ERROR", code: e instanceof AwxError ? e.code : "AWX_E_UNEXPECTED" };
    }
  };
  return {
    mode: "sandbox",
    validate: (body) => call((c) => c.request("POST", "/transfers/validate", body)),
    create: (body) => call((c) => c.request("POST", "/transfers/create", body)),
    readById: (id) => call((c) => c.request("GET", `/transfers/${id}`)),
    readByRequestId: (requestId) => call((c) => c.request("GET", `/transfers?request_id=${requestId}`)),
  };
}
