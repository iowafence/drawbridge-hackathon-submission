// Airwallex sandbox integration tests. Every provider call here is a mock: this suite makes NO network request.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditError, AuditLog } from "../../src/server/audit.ts";
import { COOKIE, createSession, getSession, hashPassphrase, resetAuthForTests, sameCsrf, sameOrigin } from "../../src/server/auth.ts";
import { AWX_BASE, AwxError, listBeneficiaries, loadRoleEnv, parseJsonDecimal, readBalances, SandboxClient } from "../../src/server/awx.ts";
import type { FetchLike } from "../../src/server/awx.ts";
import { handleAction } from "../../src/server/handler.ts";
import { DEMO_CAP_MINOR, evaluate, fromMinor, PROPOSAL, toMinor } from "../../src/server/policy.ts";
import { parseAllowlist } from "../../src/server/runtime.ts";
import { APPROVAL_TTL_MS, createDraft, decide, fold, prevalidate, providerBody, reconcile, requestReview, submit, validate } from "../../src/server/transfers.ts";
import type { Ctx } from "../../src/server/transfers.ts";

const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const KEY = "SENTINEL-API-KEY-0123456789";
const CID = "SENTINEL-CLIENT-ID";
const TOKEN = "SENTINEL-BEARER-TOKEN";
const BEN = "11111111-2222-4333-8444-555555555555";
const PROVIDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HUMAN = "human:operator";
const PASS = "correct horse battery";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dbsbx-"));
}
function credFile(dir: string, role: "read" | "transfer", extra: Record<string, string> = {}, mode = 0o600): string {
  const R = role.toUpperCase();
  const lines = { AWX_ENV: "sandbox", AWX_BASE_URL: AWX_BASE, [`AWX_${R}_CLIENT_ID`]: CID, [`AWX_${R}_API_KEY`]: KEY, ...extra };
  const p = join(dir, `.env.${role}`);
  writeFileSync(p, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  chmodSync(p, mode);
  return p;
}
type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
type Reply = { status: number; json?: unknown; text?: string } | "timeout";
function mockFetch(route: (c: Call) => Reply): { fetchImpl: FetchLike; calls: Call[]; ops: () => Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const c: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    if (url === `${AWX_BASE}/authentication/login`) return new Response(JSON.stringify({ token: TOKEN, expires_at: "2099-01-01T00:00:00+0000" }), { status: 201 });
    const r = route(c);
    if (r === "timeout") throw new Error("socket hang up to secret-host.example");
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status });
  };
  return { fetchImpl, calls, ops: () => calls.filter((c) => !c.url.endsWith("/authentication/login")) };
}
const created = (c: Call, status = "PROCESSING") => ({ id: PROVIDER_ID, status, request_id: c.body?.request_id, transfer_amount: 5.0, transfer_currency: "USD" });

function world(route: (c: Call) => Reply = () => ({ status: 200, json: {} }), opts: { available?: string | null; credential?: boolean } = {}) {
  const dir = tmp();
  const m = mockFetch(route);
  const clock = { t: 1_800_000_000_000 };
  const state = { release: undefined as string | undefined, available: opts.available === undefined ? "250.00" : opts.available };
  let client: SandboxClient | null = null;
  const ctx: Ctx = {
    audit: new AuditLog(join(dir, "data")),
    now: () => clock.t,
    allowlist: new Map([[BEN, "Sandbox test beneficiary"]]),
    transferClient: () => (client ??= new SandboxClient("transfer", { envPath: opts.credential === false ? undefined : credFile(dir, "transfer"), fetchImpl: m.fetchImpl })),
    availableUsd: async () => state.available,
    get release() {
      return state.release;
    },
  };
  const t = () => [...fold(ctx.audit.read()).values()].at(-1)!;
  const creates = () => m.ops().filter((c) => c.url.endsWith("/transfers/create"));
  return { dir, ctx, clock, state, m, t, creates };
}
async function toValidated(w: ReturnType<typeof world>) {
  const d = createDraft(w.ctx, HUMAN, BEN);
  assert.equal(d.code, "DRAFT_CREATED");
  assert.equal(requestReview(w.ctx, HUMAN, d.request_id).code, "REVIEW_REQUIRED");
  assert.equal((await decide(w.ctx, HUMAN, d.request_id, w.t().digest, true)).code, "HUMAN_APPROVED");
  assert.equal((await validate(w.ctx, HUMAN, d.request_id, w.t().digest)).code, "VALIDATED");
  w.state.release = `${w.t().request_id}:${w.t().digest}`;
  return w.t();
}

// ---------------------------------------------------------------- provider boundary

test("SBX-01 production and custom hosts, wrong environment and bad credential files are refused before any network use", () => {
  const m = mockFetch(() => ({ status: 200 }));
  const cases: [Record<string, string>, number, string][] = [
    [{ AWX_BASE_URL: "https://api.airwallex.com/api/v1" }, 0o600, "AWX_E_CONFIG_BASE_URL"],
    [{ AWX_BASE_URL: "https://evil.example/api/v1" }, 0o600, "AWX_E_CONFIG_BASE_URL"],
    [{ AWX_BASE_URL: "https://api.sandbox.airwallex.com.evil.example/api/v1" }, 0o600, "AWX_E_CONFIG_BASE_URL"],
    [{ AWX_ENV: "production" }, 0o600, "AWX_E_CONFIG_ENVIRONMENT"],
    [{ AWX_ENV: "" }, 0o600, "AWX_E_CONFIG_ENVIRONMENT"],
    [{}, 0o644, "AWX_E_CRED_FILE_PERMISSIONS"],
    [{}, 0o640, "AWX_E_CRED_FILE_PERMISSIONS"],
    [{ AWX_ADMIN_API_KEY: "x" }, 0o600, "AWX_E_CRED_FILE_ROLE_MIX"],
    [{ AWX_READ_API_KEY: "x" }, 0o600, "AWX_E_CRED_FILE_ROLE_MIX"],
    [{ AWX_TRANSFER_API_KEY: "" }, 0o600, "AWX_E_CRED_INCOMPLETE"],
  ];
  for (const [extra, mode, code] of cases) {
    assert.throws(() => new SandboxClient("transfer", { envPath: credFile(tmp(), "transfer", extra, mode), fetchImpl: m.fetchImpl }), (e: AwxError) => e.code === code, code);
  }
  const d = tmp();
  writeFileSync(join(d, "other"), "x");
  assert.throws(() => loadRoleEnv(join(d, "other"), "transfer"), (e: AwxError) => e.code === "AWX_E_CRED_FILE_NAME");
  assert.throws(() => loadRoleEnv(credFile(d, "read"), "transfer"), (e: AwxError) => e.code === "AWX_E_CRED_FILE_NAME", "the read key file can never be used for transfers");
  assert.throws(() => loadRoleEnv(join(d, "nope", ".env.transfer"), "transfer"), (e: AwxError) => e.code === "AWX_E_CRED_FILE_MISSING");
  assert.throws(() => loadRoleEnv(undefined, "transfer"), (e: AwxError) => e.code === "AWX_E_CRED_FILE_NOT_CONFIGURED");
  assert.equal(m.calls.length, 0);
});

test("SBX-02 each role can perform only its allowlisted operations and every request goes to the sandbox host", async () => {
  const m = mockFetch(() => ({ status: 200, json: [] }));
  const d = tmp();
  const read = new SandboxClient("read", { envPath: credFile(d, "read"), fetchImpl: m.fetchImpl });
  const xfer = new SandboxClient("transfer", { envPath: credFile(d, "transfer"), fetchImpl: m.fetchImpl });
  const denied: [SandboxClient, "GET" | "POST", string, Record<string, string>?][] = [
    [read, "POST", "/transfers/create", {}], [read, "POST", "/transfers/validate", {}], [read, "GET", `/transfers/${PROVIDER_ID}`], [read, "POST", "/balances/current", {}],
    [read, "GET", "/beneficiaries"], [read, "GET", "/balances/current?x=1"], [read, "GET", "https://api.airwallex.com/api/v1/balances/current"], [read, "GET", "//evil.example/x"],
    [xfer, "GET", "/balances/current"], [xfer, "POST", "/beneficiaries/create", {}], [xfer, "POST", "/transfers/create/../../payments", {}], [xfer, "GET", "/transfers"], [xfer, "GET", "/beneficiaries/x"], [xfer, "GET", "/beneficiaries?page_size=2000"], [xfer, "POST", "/beneficiaries", {}],
    [xfer, "GET", "/transfers?request_id=x&status=PAID"], [xfer, "POST", `/transfers/${PROVIDER_ID}/cancel`, {}], [xfer, "POST", "/simulation/transfers/x/transition", {}],
    [xfer, "GET", "/transfers/create"], [xfer, "POST", "/transfers/create"], [xfer, "GET", `/transfers/${PROVIDER_ID}`, {}],
  ];
  for (const [c, method, path, body] of denied) await assert.rejects(c.request(method, path, body), (e: AwxError) => e.code === "AWX_E_OPERATION_DENIED", `${c.role} ${method} ${path}`);
  assert.equal(m.calls.length, 0, "a denied operation does not even log in");
  await read.request("GET", "/balances/current");
  await xfer.request("GET", `/transfers/${PROVIDER_ID}`);
  await xfer.request("POST", "/transfers/validate", { a: "b" });
  for (const c of m.calls) assert.ok(c.url.startsWith("https://api.sandbox.airwallex.com/api/v1/"), c.url);
  assert.equal(m.calls.filter((c) => c.url.endsWith("/authentication/login")).length, 2, "one login per client; the token is reused");
  assert.equal(m.ops()[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test("SBX-03 balances: exact decimal text on success; fixed codes and nothing substituted on every failure path", async () => {
  assert.deepEqual(parseJsonDecimal('{"a":0.10,"b":12345678901234567.89,"c":[1.0]}'), { a: "0.10", b: "12345678901234567.89", c: ["1.0"] });
  const mk = (r: Reply) => new SandboxClient("read", { envPath: credFile(tmp(), "read"), fetchImpl: mockFetch(() => r).fetchImpl });
  const ok = await readBalances(mk({ status: 200, text: '[{"currency":"USD","available_amount":1000000.10,"pending_amount":0,"reserved_amount":0.0,"total_amount":1000000.10,"account_type":"x"}]' }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.rows, [{ currency: "USD", available: "1000000.10", pending: "0", reserved: "0.0", total: "1000000.10" }]);
  const bad: [Reply, string][] = [
    [{ status: 401, json: { code: "credentials_invalid", message: `leak ${KEY}` } }, "AWX_E_HTTP_STATUS"],
    [{ status: 500, text: "<html>" }, "AWX_E_HTTP_STATUS"],
    [{ status: 200, json: { items: [] } }, "AWX_E_UNRECOGNIZED_RESPONSE"],
    [{ status: 200, text: "not json" }, "AWX_E_UNRECOGNIZED_RESPONSE"],
    [{ status: 200, json: [{ currency: "USD", available_amount: "abc", pending_amount: 0, reserved_amount: 0, total_amount: 0 }] }, "AWX_E_UNRECOGNIZED_RESPONSE"],
    [{ status: 200, json: [{ currency: "usd", available_amount: 1, pending_amount: 0, reserved_amount: 0, total_amount: 0 }] }, "AWX_E_UNRECOGNIZED_RESPONSE"],
    ["timeout", "AWX_E_NETWORK"],
  ];
  for (const [r, code] of bad) {
    const res = await readBalances(mk(r));
    assert.deepEqual({ ok: res.ok, code: res.ok ? "" : res.code }, { ok: false, code });
    assert.doesNotMatch(JSON.stringify(res), /SENTINEL|secret-host/);
  }
  const noLogin: FetchLike = async () => new Response(JSON.stringify({ code: "credentials_invalid" }), { status: 401 });
  const res = await readBalances(new SandboxClient("read", { envPath: credFile(tmp(), "read"), fetchImpl: noLogin }));
  assert.deepEqual(res, { ok: false, code: "AWX_E_LOGIN_FAILED", httpStatus: null });
});

// ---------------------------------------------------------------- policy and money

test("SBX-04 money is exact integer arithmetic and the policy decides deterministically at the boundary", () => {
  assert.equal(toMinor("0.10") + toMinor("0.20"), 30n);
  assert.equal(toMinor("5"), 500n);
  assert.equal(toMinor("5.0"), 500n);
  assert.equal(toMinor("5.000"), 500n);
  assert.equal(fromMinor(500n), "5.00");
  assert.equal(fromMinor(-5n), "-0.05");
  for (const bad of ["5.001", "1e3", "", " 5", "5,00", "NaN", "0x10", ".5", "5."]) assert.throws(() => toMinor(bad), /INVALID_AMOUNT/, bad);
  assert.equal(PROPOSAL.amount, "5.00");
  const at = (available: string | null, over: Partial<typeof PROPOSAL> = {}) => evaluate(available, { ...PROPOSAL, ...over });
  assert.deepEqual([at("105.00").recommendation, at("105.00").rule], ["ALLOW", "P-6 WITHIN_RESERVE"]);
  assert.deepEqual([at("104.99").recommendation, at("104.99").rule], ["HOLD", "P-5 RESERVE_BREACH"]);
  assert.match(at("104.99").reason, /Available 104\.99 minus proposed 5\.00 leaves 99\.99, below the reserve threshold 100\.00 USD/);
  assert.equal(at(null).rule, "P-4 SANDBOX_BALANCE_UNAVAILABLE");
  assert.equal(at("garbage").rule, "P-4 SANDBOX_BALANCE_UNAVAILABLE");
  assert.equal(at("1000000.00", { amount: "10.01" }).rule, "P-3 ABOVE_DEMO_CAP");
  assert.equal(at("1000000.00", { amount: "10.00" }).recommendation, "ALLOW");
  assert.equal(at("1000000.00", { amount: "0.00" }).rule, "P-1 INVALID_AMOUNT");
  assert.equal(at("1000000.00", { amount: "-5.00" }).rule, "P-1 INVALID_AMOUNT");
  assert.equal(at("1000000.00", { currency: "EUR" }).rule, "P-2 CURRENCY_NOT_APPROVED");
  assert.equal(at("105.00").humanApprovalRequired, true);
  assert.equal(DEMO_CAP_MINOR, 1000n);
});

// ---------------------------------------------------------------- audit chain

test("SBX-05 the audit chain is ordered and hash-linked, detects tampering, and refuses secret-shaped fields", () => {
  const log = new AuditLog(tmp());
  for (let i = 0; i < 3; i++) log.append("X", null, "server", { i });
  const ev = log.read();
  assert.deepEqual(ev.map((e) => e.seq), [1, 2, 3]);
  assert.equal(ev[1].prev, ev[0].hash);
  assert.equal(ev[0].prev, "0".repeat(64));
  for (const k of ["api_key", "token", "Authorization", "account_number", "routing_value", "passphrase"]) assert.throws(() => log.append("X", null, "s", { [k]: "v" }), (e: AuditError) => e.code === "AUDIT_FIELD_REFUSED");
  assert.throws(() => log.append("X", null, "s", { note: "x".repeat(301) }), AuditError);
  const lines = readFileSync(log.file, "utf8").trim().split("\n");
  writeFileSync(log.file, [lines[0], lines[1].replace('"i":1', '"i":9'), lines[2]].join("\n") + "\n");
  assert.throws(() => log.read(), (e: AuditError) => e.code === "AUDIT_CHAIN_BROKEN");
  writeFileSync(log.file, [lines[0], lines[2]].join("\n") + "\n");
  assert.throws(() => log.read(), (e: AuditError) => e.code === "AUDIT_CHAIN_BROKEN", "a removed event is detected");
  assert.throws(() => log.append("X", null, "s", {}), AuditError, "nothing is appended to a broken chain");
});

// ---------------------------------------------------------------- workflow

test("SBX-06 full path: draft, review, human approval, provider validation, one create, provider status read", async () => {
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200, json: {} } : c.url.endsWith("/create") ? { status: 201, json: created(c) } : { status: 200, json: { ...created({ ...c, body: { request_id: w.t().request_id } }, "SENT") } }));
  const t = await toValidated(w);
  assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "SUBMITTED_TO_AIRWALLEX");
  assert.equal(w.creates().length, 1);
  assert.deepEqual(w.creates()[0].body, { beneficiary_id: BEN, transfer_amount: "5.00", transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reason: "goods_purchased", reference: "DB-SBX-0001", request_id: t.request_id });
  assert.deepEqual(w.m.ops().find((c) => c.url.endsWith("/validate"))!.body, providerBody(t), "validate and create send the same body");
  assert.deepEqual([w.t().state, w.t().provider_transfer_id, w.t().provider_status, w.t().last_code], ["SUBMITTED_TO_AIRWALLEX", PROVIDER_ID, "PROCESSING", "CREATE_ACCEPTED_NOT_PAID"]);
  assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, "PROVIDER_STATUS_RECONCILED");
  assert.deepEqual([w.t().state, w.t().provider_status], ["PROVIDER_STATUS_RECONCILED", "SENT"], "the status shown is the one the provider reported");
  assert.equal(w.m.ops().at(-1)!.url, `${AWX_BASE}/transfers/${PROVIDER_ID}`);
  assert.deepEqual(w.ctx.audit.read().map((e) => e.type), ["DRAFT_CREATED", "REVIEW_REQUESTED", "HUMAN_APPROVED", "VALIDATION_RESULT", "SUBMISSION_ATTEMPTED", "PROVIDER_RESPONSE", "RECONCILIATION_RESULT"]);
  assert.doesNotMatch(readFileSync(w.ctx.audit.file, "utf8"), /SENTINEL/, "no credential or token in the audit file");
});

test("SBX-07 only a human operator can approve or submit; order, digest binding and expiry are enforced on the server", async () => {
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : { status: 201, json: created(c) }));
  const d = createDraft(w.ctx, "agent:model", BEN);
  const id = d.request_id!;
  const dg = w.t().digest;
  assert.equal((await decide(w.ctx, HUMAN, id, dg, true)).code, "WRONG_STATE", "no approval before review is requested");
  assert.equal((await validate(w.ctx, HUMAN, id, dg)).code, "WRONG_STATE");
  assert.equal((await submit(w.ctx, HUMAN, id, dg)).code, "WRONG_STATE");
  requestReview(w.ctx, "agent:model", id);
  assert.equal((await decide(w.ctx, "agent:model", id, dg, true)).code, "HUMAN_OPERATOR_REQUIRED", "an agent may prepare but not approve");
  assert.equal((await decide(w.ctx, "server", id, dg, true)).code, "HUMAN_OPERATOR_REQUIRED");
  assert.equal((await decide(w.ctx, HUMAN, id, "0".repeat(64), true)).code, "REQUEST_CHANGED_OR_DIGEST_MISMATCH");
  assert.equal((await decide(w.ctx, HUMAN, id, undefined, true)).code, "REQUEST_CHANGED_OR_DIGEST_MISMATCH");
  assert.equal(w.t().state, "REVIEW_REQUIRED");
  assert.equal((await submit(w.ctx, HUMAN, id, dg)).code, "WRONG_STATE", "no submission without approval");
  assert.equal((await decide(w.ctx, HUMAN, id, dg, true)).code, "HUMAN_APPROVED");
  assert.equal((await submit(w.ctx, HUMAN, id, dg)).code, "WRONG_STATE", "no submission without validation");
  assert.equal((await validate(w.ctx, HUMAN, id, "f".repeat(64))).code, "REQUEST_CHANGED_OR_DIGEST_MISMATCH");
  w.clock.t += APPROVAL_TTL_MS;
  assert.equal((await validate(w.ctx, HUMAN, id, dg)).code, "APPROVAL_EXPIRED");
  w.clock.t -= 1;
  assert.equal((await validate(w.ctx, HUMAN, id, dg)).code, "VALIDATED");
  w.state.release = `${id}:${dg}`;
  assert.equal((await submit(w.ctx, "agent:model", id, dg)).code, "HUMAN_OPERATOR_REQUIRED");
  assert.equal((await submit(w.ctx, HUMAN, id, "f".repeat(64))).code, "REQUEST_CHANGED_OR_DIGEST_MISMATCH");
  w.clock.t += 1;
  assert.equal((await submit(w.ctx, HUMAN, id, dg)).code, "APPROVAL_EXPIRED");
  assert.equal(w.creates().length, 0, "no create request was sent by any refused attempt");
  assert.ok(w.ctx.audit.read().filter((e) => e.type === "REFUSED").length >= 10, "every refusal is recorded");
});

test("SBX-08 fail closed: no owner release, wrong release, no credential, unlisted beneficiary, policy HOLD", async () => {
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : { status: 201, json: created(c) }));
  const t = await toValidated(w);
  w.state.release = undefined;
  assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "OWNER_RELEASE_MISSING");
  for (const r of ["", "true", `${t.request_id}:${"0".repeat(64)}`, `${PROVIDER_ID}:${t.digest}`, t.digest]) {
    w.state.release = r;
    assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "OWNER_RELEASE_MISSING", r);
  }
  w.state.release = `${t.request_id}:${t.digest}`;
  w.ctx.allowlist.clear();
  assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "BENEFICIARY_NOT_ALLOWLISTED", "the allowlist is re-checked at submission");
  assert.equal(w.creates().length, 0);

  const nocred = world(() => ({ status: 200 }), { credential: false });
  const d = createDraft(nocred.ctx, HUMAN, BEN);
  requestReview(nocred.ctx, HUMAN, d.request_id);
  await decide(nocred.ctx, HUMAN, d.request_id, nocred.t().digest, true);
  assert.equal((await validate(nocred.ctx, HUMAN, d.request_id, nocred.t().digest)).code, "AWX_E_CRED_FILE_NOT_CONFIGURED");
  assert.equal(nocred.t().state, "HUMAN_APPROVED");
  assert.equal(nocred.m.calls.length, 0);

  const w2 = world();
  for (const b of ["99999999-2222-4333-8444-555555555555", "", undefined, `${BEN} `, { id: BEN }]) assert.equal(createDraft(w2.ctx, HUMAN, b).code, "BENEFICIARY_NOT_ALLOWLISTED");
  assert.equal(createDraft(w2.ctx, HUMAN, BEN, { ...PROPOSAL, amount: "10.01" }).code, "ABOVE_DEMO_CAP");
  assert.equal(createDraft(w2.ctx, HUMAN, BEN, { ...PROPOSAL, amount: "0.00" }).code, "INVALID_AMOUNT");
  assert.equal(createDraft(w2.ctx, HUMAN, BEN, { ...PROPOSAL, amount: "-1.00" }).code, "INVALID_AMOUNT");
  assert.equal(createDraft(w2.ctx, HUMAN, BEN, { ...PROPOSAL, amount: "5.001" }).code, "INVALID_AMOUNT");
  assert.equal(createDraft(w2.ctx, HUMAN, BEN, { ...PROPOSAL, currency: "EUR" }).code, "CURRENCY_NOT_APPROVED");
  assert.equal(createDraft(w2.ctx, HUMAN, BEN, { ...PROPOSAL, transfer_method: "SWIFT" }).code, "METHOD_NOT_APPROVED");
  assert.equal(fold(w2.ctx.audit.read()).size, 0);
  assert.deepEqual([...parseAllowlist(`${BEN}=Test A;not-a-uuid=B;${BEN.replace("1", "2")}=<script>`)], [[BEN, "Test A"]]);

  const low = world(() => ({ status: 200 }), { available: "104.99" });
  const d3 = createDraft(low.ctx, HUMAN, BEN);
  requestReview(low.ctx, HUMAN, d3.request_id);
  assert.equal((await decide(low.ctx, HUMAN, d3.request_id, low.t().digest, true)).code, "POLICY_HOLD P-5 RESERVE_BREACH", "a human cannot approve what the policy holds");
  low.state.available = null;
  assert.equal((await decide(low.ctx, HUMAN, d3.request_id, low.t().digest, true)).code, "POLICY_HOLD P-4 SANDBOX_BALANCE_UNAVAILABLE");
  assert.equal(low.t().state, "REVIEW_REQUIRED");
  assert.equal((await decide(low.ctx, HUMAN, d3.request_id, low.t().digest, false)).code, "REJECTED");
  assert.equal((await decide(low.ctx, HUMAN, d3.request_id, low.t().digest, true)).code, "WRONG_STATE", "a rejected request cannot be approved later");
});

test("SBX-09 duplicate clicks and a second transfer cannot produce a second create request", async () => {
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : { status: 201, json: created(c) }));
  const t = await toValidated(w);
  const results = await Promise.all([1, 2, 3].map(() => submit(w.ctx, HUMAN, t.request_id, t.digest)));
  assert.deepEqual(results.map((r) => r.code).sort(), ["DUPLICATE_SUBMISSION", "DUPLICATE_SUBMISSION", "SUBMITTED_TO_AIRWALLEX"]);
  assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "DUPLICATE_SUBMISSION");
  assert.equal(w.creates().length, 1);
  assert.ok(readdirSync(w.ctx.audit.dir).includes(`submit-${t.request_id}.lock`));
  const t2 = await toValidated(w);
  assert.notEqual(t2.request_id, t.request_id, "every draft gets its own stable request_id");
  assert.equal((await submit(w.ctx, HUMAN, t2.request_id, t2.digest)).code, "SUBMISSION_LIMIT_REACHED", "initial validation allows one create request in total");
  assert.equal(w.creates().length, 1);
});

test("SBX-10 unclear outcomes stop in OUTCOME_UNKNOWN, are never retried, and are resolved only by reading the provider", async () => {
  const ambiguous: [Reply | ((c: Call) => Reply), string][] = [
    ["timeout", "AWX_E_NETWORK"],
    [{ status: 500, text: "oops" }, "AMBIGUOUS_PROVIDER_STATUS"],
    [{ status: 409, json: { code: "request_pending" } }, "AMBIGUOUS_PROVIDER_STATUS"],
    [{ status: 429, json: {} }, "AMBIGUOUS_PROVIDER_STATUS"],
    [{ status: 400, json: { code: "request_id_duplicate" } }, "AMBIGUOUS_PROVIDER_STATUS"],
    [{ status: 201, json: { ok: true } }, "UNRECOGNIZED_PROVIDER_RESPONSE"],
    [{ status: 201, text: "not json" }, "UNRECOGNIZED_PROVIDER_RESPONSE"],
    [{ status: 201, json: { id: PROVIDER_ID, status: "TOTALLY_NEW", request_id: "x" } }, "UNRECOGNIZED_PROVIDER_RESPONSE"],
    [(c) => ({ status: 201, json: { ...created(c), request_id: PROVIDER_ID } }), "UNRECOGNIZED_PROVIDER_RESPONSE"],
  ];
  for (const [reply, code] of ambiguous) {
    let list: unknown = { items: [] };
    const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : c.url.endsWith("/create") ? (typeof reply === "function" ? reply(c) : reply) : { status: 200, json: list }));
    const t = await toValidated(w);
    assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "OUTCOME_UNKNOWN");
    assert.deepEqual([w.t().state, w.t().last_code, w.t().provider_status], ["OUTCOME_UNKNOWN", code, null], "no provider status is invented");
    assert.equal((await submit(w.ctx, HUMAN, t.request_id, t.digest)).code, "WRONG_STATE");
    assert.equal((await validate(w.ctx, HUMAN, t.request_id, t.digest)).code, "WRONG_STATE");
    assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, "PROVIDER_HAS_NO_RECORD_FOR_REQUEST_ID");
    assert.equal(w.t().state, "OUTCOME_UNKNOWN", "absence at the provider does not re-open submission");
    assert.equal(w.m.ops().at(-1)!.url, `${AWX_BASE}/transfers?request_id=${t.request_id}`);
    list = { items: [{ id: PROVIDER_ID, status: "PROCESSING", request_id: t.request_id, transfer_amount: 5.0, transfer_currency: "USD" }] };
    assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, "PROVIDER_STATUS_RECONCILED");
    assert.deepEqual([w.t().state, w.t().provider_transfer_id, w.t().provider_status], ["PROVIDER_STATUS_RECONCILED", PROVIDER_ID, "PROCESSING"]);
    assert.equal(w.creates().length, 1, "exactly one create request, whatever happened");
  }
  const refused = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : { status: 400, json: { code: "invalid_argument", message: "details" } }));
  const t = await toValidated(refused);
  assert.equal((await submit(refused.ctx, HUMAN, t.request_id, t.digest)).code, "PROVIDER_REFUSED");
  assert.equal((await submit(refused.ctx, HUMAN, t.request_id, t.digest)).code, "WRONG_STATE");
  assert.equal(refused.creates().length, 1);
});

test("SBX-11 reconciliation accepts only a matching provider record and a recognized status; PAID is never inferred", async () => {
  let rec: Record<string, unknown> = {};
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : c.url.endsWith("/create") ? { status: 201, json: created(c) } : { status: 200, json: rec }));
  const t = await toValidated(w);
  await submit(w.ctx, HUMAN, t.request_id, t.digest);
  assert.notEqual(w.t().provider_status, "PAID", "a 201 from create is not a payment");
  const good = { id: PROVIDER_ID, status: "PROCESSING", request_id: t.request_id, transfer_amount: 5.0, transfer_currency: "USD" };
  const bad: [Record<string, unknown>, string][] = [
    [{ ...good, transfer_amount: 50.0 }, "PROVIDER_RECORD_MISMATCH"],
    [{ ...good, transfer_currency: "EUR" }, "PROVIDER_RECORD_MISMATCH"],
    [{ ...good, request_id: PROVIDER_ID }, "PROVIDER_RECORD_MISMATCH"],
    [{ ...good, status: "SETTLED_MAYBE" }, "UNRECOGNIZED_PROVIDER_STATUS"],
    [{ ...good, id: "x" }, "UNRECOGNIZED_PROVIDER_RESPONSE"],
    [{}, "UNRECOGNIZED_PROVIDER_RESPONSE"],
  ];
  for (const [r, code] of bad) {
    rec = r;
    assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, code);
    assert.deepEqual([w.t().state, w.t().provider_status], ["SUBMITTED_TO_AIRWALLEX", "PROCESSING"]);
  }
  rec = { ...good, status: "PAID" };
  assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, "PROVIDER_STATUS_RECONCILED");
  assert.equal(w.t().provider_status, "PAID");
  assert.equal(w.creates().length, 1);
});

test("SBX-12 a modified or broken audit record stops the workflow", async () => {
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : { status: 201, json: created(c) }));
  const t = await toValidated(w);
  writeFileSync(w.ctx.audit.file, readFileSync(w.ctx.audit.file, "utf8").replace('"amount_minor":"500"', '"amount_minor":"900"'));
  await assert.rejects(submit(w.ctx, HUMAN, t.request_id, t.digest), (e: AuditError) => e.code === "AUDIT_CHAIN_BROKEN");
  assert.equal(w.creates().length, 0);
});

// ---------------------------------------------------------------- HTTP boundary

test("SBX-13 the action endpoint refuses unauthenticated, cross-site, CSRF-less and unconfigured requests", async () => {
  resetAuthForTests();
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : { status: 201, json: created(c) }));
  const env = { DRAWBRIDGE_OPERATOR_SCRYPT: hashPassphrase(PASS) };
  const deps = { ctx: () => w.ctx, env, now: () => w.clock.t };
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}, d: typeof deps | { ctx: () => Ctx; env: Record<string, string>; now: () => number } = deps) =>
    handleAction(new Request("http://localhost:3100/sandbox/action", { method: "POST", headers: { origin: "http://localhost:3100", host: "localhost:3100", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() }), d);
  const loc = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "").replace("/sandbox?m=", "");

  assert.equal((await post({ op: "draft", beneficiary_id: BEN })).status, 401);
  assert.equal((await post({ op: "draft" }, { cookie: `${COOKIE}=forged` })).status, 401);
  assert.equal((await post({ op: "login", passphrase: PASS }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ op: "login", passphrase: PASS }, { origin: "" })).status, 403);
  assert.equal((await post({ op: "login", passphrase: PASS }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ op: "login", passphrase: PASS }, {}, { ...deps, env: {} })).status, 503);
  assert.equal((await handleAction(new Request("http://localhost:3100/sandbox/action", { headers: { origin: "http://localhost:3100", host: "localhost:3100" } }), deps)).status, 405);

  const wrong = await post({ op: "login", passphrase: "wrong passphrase!" });
  assert.deepEqual([wrong.status, loc(wrong), wrong.headers.get("set-cookie")], [303, "LOGIN_REFUSED", null]);
  const login = await post({ op: "login", passphrase: PASS });
  const setCookie = login.headers.get("set-cookie")!;
  assert.match(setCookie, /^db_operator=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/sandbox; Max-Age=1800$/);
  const cookie = setCookie.split(";")[0];
  const session = getSession(cookie.split("=")[1], w.clock.t)!;
  assert.equal((await post({ op: "draft", beneficiary_id: BEN }, { cookie })).status, 403, "no CSRF token");
  assert.equal((await post({ op: "draft", beneficiary_id: BEN, csrf: "x".repeat(32) }, { cookie })).status, 403);
  const auth = { cookie };
  const csrf = session.csrf;
  assert.equal(loc(await post({ op: "draft", beneficiary_id: BEN, csrf }, auth)), "DRAFT_CREATED");
  const t = w.t();
  const ids = { id: t.request_id, digest: t.digest, csrf };
  assert.equal(loc(await post({ op: "review", ...ids }, auth)), "REVIEW_REQUIRED");
  assert.equal(loc(await post({ op: "approve", ...ids }, auth)), "STEP_UP_REFUSED", "approval needs the passphrase again");
  assert.equal(loc(await post({ op: "approve", ...ids, passphrase: "wrong passphrase!" }, auth)), "STEP_UP_REFUSED");
  assert.equal(w.t().state, "REVIEW_REQUIRED");
  // the browser cannot supply the approval state: extra fields are ignored and the state is unchanged
  assert.equal(loc(await post({ op: "validate", ...ids, state: "HUMAN_APPROVED", approved: "true" }, auth)), "WRONG_STATE");
  assert.equal(loc(await post({ op: "submit", ...ids, passphrase: PASS, state: "VALIDATED" }, auth)), "WRONG_STATE");
  assert.equal(loc(await post({ op: "approve", ...ids, digest: "0".repeat(64), passphrase: PASS }, auth)), "REQUEST_CHANGED_OR_DIGEST_MISMATCH");
  assert.equal(loc(await post({ op: "approve", ...ids, passphrase: PASS }, auth)), "HUMAN_APPROVED");
  assert.equal(w.t().approved_by, "human:operator");
  assert.equal(loc(await post({ op: "validate", ...ids }, auth)), "VALIDATED");
  assert.equal(loc(await post({ op: "submit", ...ids }, auth)), "STEP_UP_REFUSED");
  assert.equal(loc(await post({ op: "submit", ...ids, passphrase: PASS }, auth)), "OWNER_RELEASE_MISSING");
  assert.equal(w.creates().length, 0);
  assert.equal((await post({ op: "nope", csrf }, auth)).status, 400);

  w.clock.t += 30 * 60_000;
  assert.equal((await post({ op: "draft", beneficiary_id: BEN, csrf }, auth)).status, 401, "sessions expire");
  w.clock.t -= 30 * 60_000;
  const s2 = createSession("operator", w.clock.t);
  const out = await post({ op: "logout", csrf: s2.csrf }, { cookie: `${COOKIE}=${s2.token}` });
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(getSession(s2.token, w.clock.t), null);

  resetAuthForTests();
  for (let i = 0; i < 5; i++) await post({ op: "login", passphrase: "wrong passphrase!" });
  assert.equal(loc(await post({ op: "login", passphrase: PASS })), "LOGIN_LOCKED", "repeated failures lock sign-in, even for the right passphrase");
  w.clock.t += 60_001;
  assert.equal(loc(await post({ op: "login", passphrase: PASS })), "SIGNED_IN");
  resetAuthForTests();
});

// ---------------------------------------------------------------- source rules

test("SBX-14 secrets stay on the server: no client component, no public env variable, no credential in any error or record", async () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const src = walk(join(webRoot, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
  for (const f of src) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /^\s*["']use client["']/m, `${f}: no client component exists`);
    assert.doesNotMatch(text, /NEXT_PUBLIC_/, `${f}: no public environment variable`);
    const rel = f.slice(webRoot.length + 1);
    if (!rel.startsWith("src/server/") && !rel.startsWith("src/app/sandbox/")) {
      assert.doesNotMatch(text, /server\/(awx|auth|audit|transfers|handler|runtime|policy)\.ts/, `${rel}: the E3 screens do not import the sandbox integration`);
    }
    if (rel.startsWith("src/server/")) assert.doesNotMatch(text, /parseFloat|toFixed|Math\.round|Number\(.*amount/i, `${rel}: no float money handling`);
  }
  assert.doesNotMatch(readFileSync(join(webRoot, "src/server/awx.ts"), "utf8").replace("https://api.sandbox.airwallex.com", ""), /https?:\/\//, "the sandbox origin is the only URL in the transport");
  const m = mockFetch(() => "timeout");
  const c = new SandboxClient("transfer", { envPath: credFile(tmp(), "transfer"), fetchImpl: m.fetchImpl });
  const err = await c.request("POST", "/transfers/create", {}).catch((e) => e);
  assert.equal(err.code, "AWX_E_NETWORK");
  assert.doesNotMatch(`${err.message} ${err.stack} ${JSON.stringify(err)} ${JSON.stringify(c)} ${String(c)}`, /SENTINEL|secret-host/);
  assert.equal(err.cause, undefined);
});

test("SBX-15 beneficiary lookup returns only non-sensitive fields, and agent pre-validation creates nothing and changes no state", async () => {
  const raw = { has_more: false, items: [
    { id: BEN, nickname: "US USD LOCAL", transfer_methods: ["LOCAL"], beneficiary: { entity_type: "COMPANY", company_name: "SECRET-NAME", address: { street_address: "SECRET-STREET" }, bank_details: { account_currency: "USD", bank_country_code: "US", local_clearing_system: "ACH", account_number: "SECRET-ACCT-000123", account_routing_value1: "SECRET-ROUTING", account_name: "SECRET-NAME" } } },
    { id: "not-a-uuid", nickname: "x" },
  ] };
  const m = mockFetch(() => ({ status: 200, json: raw }));
  const res = await listBeneficiaries(new SandboxClient("transfer", { envPath: credFile(tmp(), "transfer"), fetchImpl: m.fetchImpl }));
  assert.deepEqual(res, { ok: true, httpStatus: 200, hasMore: false, items: [{ id: BEN, nickname: "US USD LOCAL", country: "US", currency: "USD", methods: ["LOCAL"], clearing: "ACH", entityType: "COMPANY" }] });
  assert.doesNotMatch(JSON.stringify(res), /SECRET/);
  const denied = await listBeneficiaries(new SandboxClient("transfer", { envPath: credFile(tmp(), "transfer"), fetchImpl: mockFetch(() => ({ status: 403, json: { code: "forbidden", message: "SECRET" } })).fetchImpl }));
  assert.deepEqual(denied, { ok: false, code: "AWX_E_HTTP_STATUS", httpStatus: 403, providerCode: "forbidden" });

  let reply: Reply = { status: 200, json: {} };
  const w = world(() => reply);
  const d = createDraft(w.ctx, "agent:prepare-cli", BEN);
  assert.equal((await prevalidate(w.ctx, "agent:prepare-cli", d.request_id)).code, "PROVIDER_PREVALIDATION_PASSED");
  requestReview(w.ctx, "agent:prepare-cli", d.request_id);
  reply = { status: 400, json: { code: "invalid_argument", source: "reason", message: "SECRET detail" } };
  const failed = await prevalidate(w.ctx, "agent:prepare-cli", d.request_id);
  assert.deepEqual([failed.code, failed.httpStatus, failed.providerCode, failed.source], ["PROVIDER_PREVALIDATION_FAILED", 400, "invalid_argument", "reason"]);
  assert.deepEqual([w.t().state, w.t().approved_by], ["REVIEW_REQUIRED", null], "pre-validation is not approval and not the VALIDATED state");
  assert.ok(w.m.ops().every((c) => c.url.endsWith("/transfers/validate")));
  assert.equal(w.creates().length, 0);
  assert.equal((await validate(w.ctx, HUMAN, d.request_id, w.t().digest)).code, "WRONG_STATE", "formal validation still needs the human approval first");
  assert.equal((await submit(w.ctx, HUMAN, d.request_id, w.t().digest)).code, "WRONG_STATE");
  assert.doesNotMatch(readFileSync(w.ctx.audit.file, "utf8"), /SECRET|SENTINEL/);
  await decide(w.ctx, HUMAN, d.request_id, w.t().digest, true);
  assert.equal((await prevalidate(w.ctx, "agent:prepare-cli", d.request_id)).code, "WRONG_STATE");
});

test("SBX-16 late or repeated responses cannot move a request backwards; a rejection cannot be overtaken by an approval", async () => {
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : c.url.endsWith("/create") ? { status: 201, json: created(c) } : { status: 200, json: { ...created(c), request_id: w.t().request_id } }));
  const d = createDraft(w.ctx, HUMAN, BEN);
  requestReview(w.ctx, HUMAN, d.request_id);
  const dg = w.t().digest;
  assert.deepEqual((await Promise.all([decide(w.ctx, HUMAN, d.request_id, dg, true), decide(w.ctx, HUMAN, d.request_id, dg, true)])).map((r) => r.code).sort(), ["HUMAN_APPROVED", "STATE_CHANGED_DURING_REQUEST"]);
  assert.deepEqual((await Promise.all([validate(w.ctx, HUMAN, d.request_id, dg), validate(w.ctx, HUMAN, d.request_id, dg)])).map((r) => r.code).sort(), ["STATE_CHANGED_DURING_REQUEST", "VALIDATED"]);
  assert.equal(w.ctx.audit.read().filter((e) => e.type === "VALIDATION_RESULT").length, 1);
  w.state.release = `${d.request_id}:${dg}`;
  assert.equal((await submit(w.ctx, HUMAN, d.request_id, dg)).code, "SUBMITTED_TO_AIRWALLEX");
  // even if a stale event were written, folding ignores an illegal transition
  w.ctx.audit.append("VALIDATION_RESULT", d.request_id!, HUMAN, { state: "VALIDATED", code: "PROVIDER_VALIDATION_PASSED" });
  w.ctx.audit.append("HUMAN_REJECTED", d.request_id!, HUMAN, { state: "REJECTED" });
  w.ctx.audit.append("PROVIDER_RESPONSE", d.request_id!, "server", { state: "DRAFT" });
  assert.deepEqual([w.t().state, w.t().provider_transfer_id, w.t().last_code], ["SUBMITTED_TO_AIRWALLEX", PROVIDER_ID, "CREATE_ACCEPTED_NOT_PAID"]);
  assert.equal((await submit(w.ctx, HUMAN, d.request_id, dg)).code, "DUPLICATE_SUBMISSION");
  assert.equal((await reconcile(w.ctx, HUMAN, d.request_id)).code, "PROVIDER_STATUS_RECONCILED", "the provider status of a created transfer can still be read");
  assert.equal(w.creates().length, 1);

  const w2 = world();
  const d2 = createDraft(w2.ctx, HUMAN, BEN);
  requestReview(w2.ctx, HUMAN, d2.request_id);
  const approving = decide(w2.ctx, HUMAN, d2.request_id, w2.t().digest, true); // in flight: waiting for the balance read
  assert.equal((await decide(w2.ctx, HUMAN, d2.request_id, w2.t().digest, false)).code, "REJECTED");
  assert.equal((await approving).code, "STATE_CHANGED_DURING_REQUEST");
  assert.deepEqual([w2.t().state, w2.t().approved_by], ["REJECTED", null]);
});

test("SBX-17 reconciliation by ID rejects a different provider ID; CSRF comparison never throws; only loopback hosts are accepted", async () => {
  let rec: Record<string, unknown> = {};
  const w = world((c) => (c.url.endsWith("/validate") ? { status: 200 } : c.url.endsWith("/create") ? { status: 201, json: created(c) } : { status: 200, json: rec }));
  const t = await toValidated(w);
  await submit(w.ctx, HUMAN, t.request_id, t.digest);
  rec = { id: "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "PAID", request_id: t.request_id, transfer_amount: "5.00", transfer_currency: "USD" };
  assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, "PROVIDER_RECORD_MISMATCH");
  assert.deepEqual([w.t().provider_transfer_id, w.t().provider_status], [PROVIDER_ID, "PROCESSING"]);
  rec = { ...rec, id: PROVIDER_ID, status: "PROCESSING" };
  assert.equal((await reconcile(w.ctx, HUMAN, t.request_id)).code, "PROVIDER_STATUS_RECONCILED", "exact decimal text 5.00 matches 500 minor units");

  const csrf = "a".repeat(32);
  for (const bad of ["é".repeat(32), "a".repeat(31) + "é", "", "a".repeat(33), undefined, 5]) assert.equal(sameCsrf(bad, csrf), false);
  assert.equal(sameCsrf(csrf, csrf), true);
  const req = (origin: string, host: string) => new Request("http://x/sandbox/action", { method: "POST", headers: { origin, host } });
  for (const h of ["127.0.0.1:3102", "localhost:3100", "[::1]:3102", "localhost"]) assert.equal(sameOrigin(req(`http://${h}`, h)), true, h);
  for (const h of ["evil.example:3102", "192.168.0.10:3102", "127.0.0.1.evil.example", "localhost.evil.example:3102"]) assert.equal(sameOrigin(req(`http://${h}`, h)), false, h);
  assert.equal(sameOrigin(req("http://127.0.0.1:3102", "127.0.0.1:3103")), false);
});
