// Independent mock of the Airwallex SANDBOX transfer API. TEST CODE ONLY. It makes no network request.
//
// It is file-backed (append-only journal + provider-side record file in the test's private directory) so several
// processes can share one "provider": that is what lets the tests count create attempts across a crash or a race.
// Two equivalent faces are offered:
//   - typed methods (validate / create / getById / findByRequestId), which the flow-v1 ProviderPort binding wraps
//   - `fetchImpl`, which speaks the sandbox HTTP shapes used by src/server/awx.ts
// A "sent" create leaves a provider-side record even when the caller never sees a usable response.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const SANDBOX_BASE = "https://api.sandbox.airwallex.com/api/v1";

export type CreateMode =
  | "ACCEPT"                // 201, record created
  | "TIMEOUT_BEFORE_SEND"   // transport error, provider has no record
  | "TIMEOUT_AFTER_SEND"    // transport error, but the provider DID create the record
  | "HTTP_500_AFTER_SEND"   // 500, but the provider DID create the record
  | "HTTP_503_BEFORE_SEND"  // 503, provider has no record
  | "HTTP_409_AFTER_SEND"   // 409 pending, provider DID create the record
  | "HTTP_429_BEFORE_SEND"  // 429, provider has no record
  | "DUPLICATE_AFTER_SEND"  // 400 request_id_duplicate: the provider already holds this request id
  | "MALFORMED_201"         // 201 with an unusable body, record created
  | "WRONG_ECHO_201"        // 201 whose body echoes a different request id, record created
  | "REFUSE_400" | "REFUSE_401" | "REFUSE_403" | "REFUSE_404" | "REFUSE_422" // definite refusal, no record
  | "CRASH_BEFORE_SEND"     // the calling process is killed before anything reaches the provider
  | "CRASH_AFTER_SEND";     // the calling process is killed after the provider created the record
export type ValidateMode = "OK" | "REFUSE_400" | "HTTP_500" | "TIMEOUT";
export type ReadMode = "OK" | "TIMEOUT" | "HTTP_500" | "WRONG_AMOUNT" | "WRONG_CURRENCY" | "WRONG_REQUEST_ID" | "MULTIPLE";
export type Script = { validate: ValidateMode; create: CreateMode; createStatus: string; read: ReadMode; delayMs: number };

export type ProviderRecord = { id: string; request_id: string; status: string; transfer_amount: string; transfer_currency: string; beneficiary_id: string; reference: string };
export type JournalEntry = { op: "login" | "validate" | "create" | "read" | "foreign"; request_id: string | null; recorded: boolean; mode: string; pid: number; detail: string };
export type MockResponse = { status: number; body: unknown };

export class MockNetworkError extends Error {
  constructor() {
    super("MOCK_NETWORK_ERROR");
  }
}

const SENDS: CreateMode[] = ["ACCEPT", "TIMEOUT_AFTER_SEND", "HTTP_500_AFTER_SEND", "HTTP_409_AFTER_SEND", "DUPLICATE_AFTER_SEND", "MALFORMED_201", "WRONG_ECHO_201", "CRASH_AFTER_SEND"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);

export class MockProvider {
  #script: string;
  #journal: string;
  #records: string;
  #status: string;

  constructor(dir: string) {
    this.#script = join(dir, "provider_script.json");
    this.#journal = join(dir, "provider_journal.jsonl");
    this.#records = join(dir, "provider_records.jsonl");
    this.#status = join(dir, "provider_status.json");
    if (!existsSync(this.#script)) this.script({});
  }

  // ---- test controls

  script(patch: Partial<Script>): void {
    const base: Script = existsSync(this.#script) ? (JSON.parse(readFileSync(this.#script, "utf8")) as Script) : { validate: "OK", create: "ACCEPT", createStatus: "PROCESSING", read: "OK", delayMs: 0 };
    const tmp = `${this.#script}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...base, ...patch }), { mode: 0o600 });
    renameSync(tmp, this.#script);
  }
  /** The provider moves a transfer to another status (what a later read-back will see). */
  moveTo(request_id: string, status: string): void {
    const all = existsSync(this.#status) ? (JSON.parse(readFileSync(this.#status, "utf8")) as Record<string, string>) : {};
    all[request_id] = status;
    writeFileSync(this.#status, JSON.stringify(all), { mode: 0o600 });
  }
  journal(): JournalEntry[] {
    return jsonl<JournalEntry>(this.#journal);
  }
  /** Every create request that was attempted, whether or not it reached the provider. */
  createAttempts(request_id?: string): JournalEntry[] {
    return this.journal().filter((e) => e.op === "create" && (request_id === undefined || e.request_id === request_id));
  }
  /** Transfers that exist at the provider. */
  records(request_id?: string): ProviderRecord[] {
    const moved = existsSync(this.#status) ? (JSON.parse(readFileSync(this.#status, "utf8")) as Record<string, string>) : {};
    return jsonl<ProviderRecord>(this.#records).filter((r) => request_id === undefined || r.request_id === request_id).map((r) => ({ ...r, status: moved[r.request_id] ?? r.status }));
  }
  foreignCalls(): JournalEntry[] {
    return this.journal().filter((e) => e.op === "foreign");
  }

  // ---- provider behaviour

  #cfg(): Script {
    return JSON.parse(readFileSync(this.#script, "utf8")) as Script;
  }
  #log(e: Omit<JournalEntry, "pid">): void {
    appendFileSync(this.#journal, JSON.stringify({ ...e, pid: process.pid }) + "\n", { mode: 0o600 });
  }
  #die(): never {
    process.kill(process.pid, "SIGKILL");
    throw new Error("unreachable");
  }

  /** POST /transfers/validate. Creates nothing. */
  async validate(body: Record<string, unknown>): Promise<MockResponse> {
    const cfg = this.#cfg();
    this.#log({ op: "validate", request_id: typeof body.request_id === "string" ? body.request_id : null, recorded: false, mode: cfg.validate, detail: "" });
    if (cfg.validate === "TIMEOUT") throw new MockNetworkError();
    if (cfg.validate === "HTTP_500") return { status: 500, body: { code: "internal_error" } };
    if (cfg.validate === "REFUSE_400") return { status: 400, body: { code: "invalid_argument", source: "reference" } };
    return { status: 200, body: {} };
  }

  /** POST /transfers/create. */
  async create(body: Record<string, unknown>): Promise<MockResponse> {
    const cfg = this.#cfg();
    const request_id = typeof body.request_id === "string" ? body.request_id : null;
    if (cfg.delayMs) await sleep(cfg.delayMs);
    if (cfg.create === "CRASH_BEFORE_SEND") {
      this.#log({ op: "create", request_id, recorded: false, mode: cfg.create, detail: "" });
      this.#die();
    }
    const duplicate = request_id !== null && jsonl<ProviderRecord>(this.#records).some((r) => r.request_id === request_id);
    if (duplicate) {
      // the provider is idempotent on request_id, but a second create ATTEMPT is still journalled and is a test failure
      this.#log({ op: "create", request_id, recorded: false, mode: cfg.create, detail: "DUPLICATE_REQUEST_ID" });
      return { status: 400, body: { code: "request_id_duplicate" } };
    }
    let record: ProviderRecord | null = null;
    if (SENDS.includes(cfg.create) && request_id !== null) {
      record = {
        id: randomUUID(), request_id, status: cfg.createStatus, transfer_amount: String(body.transfer_amount), transfer_currency: String(body.transfer_currency),
        beneficiary_id: String(body.beneficiary_id), reference: String(body.reference),
      };
      appendFileSync(this.#records, JSON.stringify(record) + "\n", { mode: 0o600 });
    }
    this.#log({ op: "create", request_id, recorded: record !== null, mode: cfg.create, detail: `${String(body.beneficiary_id)} ${String(body.transfer_amount)} ${String(body.transfer_currency)} ${String(body.reference)}` });
    switch (cfg.create) {
      case "ACCEPT": return { status: 201, body: record };
      case "MALFORMED_201": return { status: 201, body: { unexpected: true } };
      case "WRONG_ECHO_201": return { status: 201, body: { ...record, request_id: randomUUID() } };
      case "HTTP_500_AFTER_SEND": return { status: 500, body: { code: "internal_error" } };
      case "HTTP_503_BEFORE_SEND": return { status: 503, body: { code: "service_unavailable" } };
      case "HTTP_409_AFTER_SEND": return { status: 409, body: { code: "request_pending" } };
      case "HTTP_429_BEFORE_SEND": return { status: 429, body: { code: "too_many_requests" } };
      case "DUPLICATE_AFTER_SEND": return { status: 400, body: { code: "request_id_duplicate" } };
      case "CRASH_AFTER_SEND": return this.#die();
      case "TIMEOUT_BEFORE_SEND":
      case "TIMEOUT_AFTER_SEND": throw new MockNetworkError();
      default: return { status: Number(cfg.create.slice("REFUSE_".length)), body: { code: "invalid_argument", source: "beneficiary_id" } };
    }
  }

  async #read(find: (r: ProviderRecord) => boolean, request_id: string | null, list: boolean): Promise<MockResponse> {
    const cfg = this.#cfg();
    this.#log({ op: "read", request_id, recorded: false, mode: cfg.read, detail: "" });
    if (cfg.read === "TIMEOUT") throw new MockNetworkError();
    if (cfg.read === "HTTP_500") return { status: 500, body: { code: "internal_error" } };
    const distort = (r: ProviderRecord): ProviderRecord =>
      cfg.read === "WRONG_AMOUNT" ? { ...r, transfer_amount: "500.00" } : cfg.read === "WRONG_CURRENCY" ? { ...r, transfer_currency: "EUR" } : cfg.read === "WRONG_REQUEST_ID" ? { ...r, request_id: randomUUID() } : r;
    let hits = this.records().filter(find).map(distort);
    if (cfg.read === "MULTIPLE" && hits.length) hits = [hits[0], { ...hits[0], id: randomUUID() }];
    if (list) return { status: 200, body: { items: hits, has_more: false } };
    return hits.length ? { status: 200, body: hits[0] } : { status: 404, body: { code: "not_found" } };
  }
  /** GET /transfers/{id}. */
  getById(id: string): Promise<MockResponse> {
    return this.#read((r) => r.id === id, null, false);
  }
  /** GET /transfers?request_id=. */
  findByRequestId(request_id: string): Promise<MockResponse> {
    return this.#read((r) => r.request_id === request_id, request_id, true);
  }

  /** The same provider behind the sandbox HTTP shapes. Any other host is journalled as a foreign call and refused. */
  fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const method = String(init.method ?? "GET");
    if (!url.startsWith(`${SANDBOX_BASE}/`)) {
      this.#log({ op: "foreign", request_id: null, recorded: false, mode: method, detail: url.slice(0, 120) });
      throw new MockNetworkError();
    }
    const path = url.slice(SANDBOX_BASE.length);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const reply = (r: MockResponse) => new Response(wire(r.body), { status: r.status });
    if (method === "POST" && path === "/authentication/login") {
      this.#log({ op: "login", request_id: null, recorded: false, mode: "OK", detail: "" });
      return new Response(JSON.stringify({ token: "MOCK-BEARER-TOKEN", expires_at: "2099-01-01T00:00:00+0000" }), { status: 201 });
    }
    if (method === "POST" && path === "/transfers/validate") return reply(await this.validate(body));
    if (method === "POST" && path === "/transfers/create") return reply(await this.create(body));
    const byId = /^\/transfers\/([0-9a-f-]{36})$/.exec(path);
    if (method === "GET" && byId) return reply(await this.getById(byId[1]));
    const byReq = /^\/transfers\?request_id=([0-9a-f-]{36})$/.exec(path);
    if (method === "GET" && byReq) return reply(await this.findByRequestId(byReq[1]));
    this.#log({ op: "foreign", request_id: null, recorded: false, mode: method, detail: path.slice(0, 120) });
    return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  };
}

/** JSON text in which transfer_amount is a bare decimal number (5.00), as the provider sends it. */
function wire(body: unknown): string {
  return JSON.stringify(body).replace(/"transfer_amount":"(-?\d+(?:\.\d+)?)"/g, '"transfer_amount":$1');
}
