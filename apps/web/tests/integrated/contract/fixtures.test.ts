// Fixture truth. These tests run NOW, against shipped code: they pin what the existing deterministic gate
// (src/server/agentPolicy.ts, public `evaluate`) answers for every fixture state the flow scenarios rely on, and
// check that the fixture factories, the mock provider and the network guard behave as the scenarios assume.
// Offline; no model, no network.
import "../support/netGuard.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { flowDigest } from "../../../integrated/flowCanonical.ts";
import { evaluate } from "../../../src/server/agentPolicy.ts";
import { reconcile, SYNTHETIC_REGISTRY, validateRegistry } from "../../../src/server/agentRegistry.ts";
import { AwxError, SandboxClient } from "../../../src/server/awx.ts";
import {
  applyVariant, BALANCE, BEN_ID, BEN_LABEL, BENEFICIARIES, CASE, CASE_DOCUMENT, CASE_REFERENCE, cooperativeClaims, obligation, privateDir, registeredText, REGISTRY_VARIANTS, T0, testRegistry,
} from "../support/fixtures.ts";
import type { RegistryVariant } from "../support/fixtures.ts";
import { MockNetworkError, MockProvider, SANDBOX_BASE } from "../support/mockProvider.ts";
import { networkAttempts } from "../support/netGuard.ts";
import { World } from "../support/port.ts";

const base = testRegistry();
const gate = (variant: RegistryVariant = "baseline", balance: string | null = BALANCE, evidence: string = registeredText(base), claims = cooperativeClaims(obligation(base)) as ReturnType<typeof cooperativeClaims> | null) => {
  const e = evaluate(evidence, claims, applyVariant(base, variant), balance);
  return [e.decision, e.rule];
};

test("FX-01 the shipped gate answers as the scenarios assume for every fixture state", () => {
  assert.deepEqual(gate(), ["ELIGIBLE_FOR_HUMAN_REVIEW", "P-ALL VERIFIED"]);
  assert.deepEqual(gate("dispute_opened"), ["HOLD", "P-G CONTRADICTED"]);
  assert.deepEqual(gate("approval_revoked"), ["HOLD", "P-F CONTRADICTED"]);
  assert.deepEqual(gate("approval_conditional"), ["HOLD", "P-F MISSING"]);
  assert.deepEqual(gate("document_missing"), ["HOLD", "P-E MISSING"]);
  assert.deepEqual(gate("dispute_unrecorded"), ["REVIEW", "P-G UNKNOWN"]);
  assert.deepEqual(gate("invalid_duplicate_reference"), ["HOLD", "P-R REGISTRY_INVALID"]);
  for (const v of ["amount_changed", "payee_changed", "reference_changed", "currency_changed"] as RegistryVariant[]) assert.equal(gate(v)[0], "HOLD", v);
  // a change to a different obligation leaves this obligation's own verdict eligible: only the registry digest catches it
  assert.deepEqual(gate("unrelated_change"), ["ELIGIBLE_FOR_HUMAN_REVIEW", "P-ALL VERIFIED"]);
  assert.notEqual(flowDigest("registry", applyVariant(base, "unrelated_change")), flowDigest("registry", base));
  assert.deepEqual(gate("baseline", null), ["REVIEW", "P-I UNKNOWN"]);
  assert.deepEqual(gate("baseline", "104.99"), ["HOLD", "P-I CONTRADICTED"]);
  assert.deepEqual(gate("baseline", BALANCE, registeredText(base), null), ["HOLD", "P-0 AGENT_FAILED_CLOSED"]);
  const adverse = cooperativeClaims(obligation(base), { adverse: [{ kind: "NEGATED_APPROVAL", summary: "payment is not approved", quote: null, grounding: "QUOTE_NOT_FOUND" }] });
  assert.deepEqual(gate("baseline", BALANCE, registeredText(base), adverse), ["HOLD", "P-X ADVERSE_CONTENT_REPORTED"]);
  // An edited or unregistered document read by a fully cooperative model is REVIEW (proof S UNTRUSTED) in the
  // shipped gate, not HOLD. flow-v1 section 5 therefore has the gate-binding layer force HOLD for it (P-BIND).
  assert.deepEqual(gate("baseline", BALANCE, `${registeredText(base)}\nNote: approved for immediate release.`), ["REVIEW", "P-S UNTRUSTED"]);
  // the E3 project obligation is funding-blocked and above the demonstration cap
  const steel = obligation(base, "CASE-E3-OBL-STEEL");
  const e3 = evaluate(steel.registered_documents[0].text, cooperativeClaims(steel), base, BALANCE);
  assert.deepEqual([e3.decision, e3.proofs.find((p) => p.id === "H")?.state, e3.proofs.find((p) => p.id === "I")?.state], ["HOLD", "CONTRADICTED", "CONTRADICTED"]);
});

test("FX-02 fixture factories never mutate a registry, and the test registry is the shipped one plus the flow-v1 additions", () => {
  const shipped = JSON.stringify(SYNTHETIC_REGISTRY);
  const snapshot = JSON.stringify(base);
  assert.equal(validateRegistry(base), null);
  assert.equal(JSON.stringify(base.obligations.slice(0, SYNTHETIC_REGISTRY.obligations.length)), JSON.stringify(SYNTHETIC_REGISTRY.obligations), "every shipped obligation is present, unchanged and first");
  const o = obligation(base);
  const rec = reconcile(o);
  assert.deepEqual([o.case_id, o.reference, o.registered_documents[0].document_id, rec.ok && rec.net], [CASE, CASE_REFERENCE, CASE_DOCUMENT, 500n]);
  for (const v of REGISTRY_VARIANTS) {
    const changed = applyVariant(base, v);
    assert.equal(JSON.stringify(base), snapshot, `${v} leaves its input untouched`);
    assert.equal(JSON.stringify(changed) === snapshot, v === "baseline", `${v} changes the clone, and only "baseline" changes nothing`);
  }
  obligation(base).payee = "mutated";
  testRegistry().obligations.length = 0;
  assert.equal(JSON.stringify(base), snapshot);
  assert.equal(JSON.stringify(testRegistry()), snapshot, "every call builds a fresh, identical registry");
  assert.equal(JSON.stringify(SYNTHETIC_REGISTRY), shipped);
});

test("FX-03 every test directory is private and outside the checkout, and world settings reach a second handle", () => {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
  const d1 = privateDir("fx03");
  const d2 = privateDir("fx03");
  assert.notEqual(d1, d2);
  for (const d of [d1, d2]) assert.ok(!d.startsWith(join(repoRoot, "/")), "not inside the repository");
  const w = new World(d1, { t: T0, registryVariant: "baseline", balanceUsd: BALANCE, beneficiaries: BENEFICIARIES, fixedUuid: null });
  w.advance(5);
  w.set({ registryVariant: "dispute_opened", balanceUsd: null });
  const again = new World(d1);
  assert.deepEqual([again.now(), again.balanceUsd(), again.registryVariant(), again.beneficiaries().get(BEN_ID)], [T0 + 5, null, "dispute_opened", BEN_LABEL]);
  assert.notEqual(again.uuid(), again.uuid());
  again.set({ fixedUuid: "00000000-0000-4000-8000-000000000001" });
  assert.deepEqual([w.uuid(), w.uuid()], ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]);
  const key = Buffer.from(w.approvalKey()).toString("hex");
  assert.equal(w.approvalKey().length, 32);
  assert.equal(Buffer.from(again.approvalKey()).toString("hex"), key, "a second handle sees the same test key");
  again.rotateApprovalKey();
  assert.notEqual(Buffer.from(w.approvalKey()).toString("hex"), key, "rotation replaces it for good");
  assert.throws(() => new World(d2), /WORLD_NOT_INITIALISED/);
  assert.deepEqual(readdirSync(d2), ["data"], "an unused world directory holds nothing else");
});

test("FX-04 mock provider: a sent create leaves a record even when the caller sees a failure; nothing else does; attempts are always journalled", async () => {
  const body = (rid: string) => ({ beneficiary_id: BEN_ID, transfer_amount: "5.00", transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reason: "goods_purchased", reference: CASE_REFERENCE, request_id: rid });
  const cases: [string, boolean, number | "throws"][] = [
    ["ACCEPT", true, 201], ["TIMEOUT_BEFORE_SEND", false, "throws"], ["TIMEOUT_AFTER_SEND", true, "throws"], ["HTTP_500_AFTER_SEND", true, 500],
    ["HTTP_503_BEFORE_SEND", false, 503], ["HTTP_409_AFTER_SEND", true, 409], ["HTTP_429_BEFORE_SEND", false, 429], ["DUPLICATE_AFTER_SEND", true, 400],
    ["MALFORMED_201", true, 201], ["WRONG_ECHO_201", true, 201], ["REFUSE_400", false, 400], ["REFUSE_401", false, 401], ["REFUSE_403", false, 403], ["REFUSE_404", false, 404], ["REFUSE_422", false, 422],
  ];
  for (const [mode, recorded, result] of cases) {
    const p = new MockProvider(privateDir("fx04"));
    p.script({ create: mode as never });
    const rid = crypto.randomUUID();
    if (result === "throws") await assert.rejects(p.create(body(rid)), MockNetworkError, mode);
    else assert.equal((await p.create(body(rid))).status, result, mode);
    assert.deepEqual([p.createAttempts(rid).length, p.records(rid).length], [1, recorded ? 1 : 0], mode);
  }
  const p = new MockProvider(privateDir("fx04"));
  const rid = crypto.randomUUID();
  const first = await p.create(body(rid));
  const second = await p.create(body(rid));
  assert.deepEqual([first.status, second.status, (second.body as { code: string }).code], [201, 400, "request_id_duplicate"]);
  assert.deepEqual([p.createAttempts(rid).length, p.records(rid).length], [2, 1], "a duplicate is refused by the provider but still counted as an attempt");
  p.moveTo(rid, "PAID");
  assert.equal(((await p.findByRequestId(rid)).body as { items: { status: string }[] }).items[0].status, "PAID");
  p.script({ read: "WRONG_AMOUNT" });
  assert.equal(((await p.getById(p.records(rid)[0].id)).body as { transfer_amount: string }).transfer_amount, "500.00");
  p.script({ read: "MULTIPLE" });
  assert.equal(((await p.findByRequestId(rid)).body as { items: unknown[] }).items.length, 2);
  p.script({ read: "TIMEOUT" });
  await assert.rejects(p.getById(p.records(rid)[0].id), MockNetworkError);
  p.script({ validate: "REFUSE_400" });
  assert.equal((await p.validate(body(rid))).status, 400);
  assert.equal(p.records().length, 1, "validate never creates a record");
});

test("FX-05 mock provider over HTTP shapes: the shipped sandbox client can drive it, exact decimal amounts survive, and any other host is refused and journalled", async () => {
  const dir = privateDir("fx05");
  const p = new MockProvider(dir);
  const { writeFileSync, chmodSync } = await import("node:fs");
  const cred = join(dir, ".env.transfer");
  writeFileSync(cred, `AWX_ENV=sandbox\nAWX_BASE_URL=${SANDBOX_BASE}\nAWX_TRANSFER_CLIENT_ID=SYNTHETIC-CLIENT-ID\nAWX_TRANSFER_API_KEY=SYNTHETIC-NOT-A-KEY\n`);
  chmodSync(cred, 0o600);
  const client = new SandboxClient("transfer", { envPath: cred, fetchImpl: p.fetchImpl });
  const rid = crypto.randomUUID();
  const created = await client.request("POST", "/transfers/create", { beneficiary_id: BEN_ID, transfer_amount: "5.00", transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reason: "goods_purchased", reference: CASE_REFERENCE, request_id: rid });
  const rec = created.body as { id: string; status: string; request_id: string; transfer_amount: string };
  assert.deepEqual([created.status, rec.status, rec.request_id, rec.transfer_amount], [201, "PROCESSING", rid, "5.00"]);
  const byId = await client.request("GET", `/transfers/${rec.id}`);
  assert.equal((byId.body as { id: string }).id, rec.id);
  const byReq = await client.request("GET", `/transfers?request_id=${rid}`);
  assert.equal((byReq.body as { items: unknown[] }).items.length, 1);
  p.script({ create: "TIMEOUT_AFTER_SEND" });
  await assert.rejects(client.request("POST", "/transfers/create", { request_id: crypto.randomUUID() }), (e: AwxError) => e.code === "AWX_E_NETWORK" && e.sent === true);
  await assert.rejects(p.fetchImpl("https://api.airwallex.com/api/v1/transfers/create", { method: "POST", body: "{}" }), MockNetworkError);
  assert.equal(p.foreignCalls().length, 1, "the production host is journalled as a foreign call");
  assert.ok(!readFileSync(join(dir, "provider_journal.jsonl"), "utf8").includes("SYNTHETIC-NOT-A-KEY"), "the journal holds no credential");
});

test("FX-06 the network guard fails closed and records the attempt", async () => {
  // run in a child so the recorded attempts do not count against this file's own zero-attempt check
  const { spawnSync } = await import("node:child_process");
  const guard = join(fileURLToPath(new URL(".", import.meta.url)), "..", "support", "netGuard.ts");
  const code = `const g = await import(${JSON.stringify(guard)}); const net = await import("node:net"); const out = [];
    try { await fetch("https://api.sandbox.airwallex.com/api/v1/balances/current"); out.push("fetch-ok"); } catch (e) { out.push(String(e.message).split(" ")[0]); }
    await new Promise((r) => { const s = net.connect(443, "203.0.113.1"); s.on("error", () => r()); s.on("connect", () => { out.push("socket-ok"); r(); }); });
    console.log(JSON.stringify({ out, attempts: g.networkAttempts() }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" } as unknown as NodeJS.ProcessEnv });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout) as { out: string[]; attempts: string[] };
  assert.deepEqual(got.out, ["NETWORK_BLOCKED_IN_TESTS"]);
  assert.equal(got.attempts.length, 2);
  assert.ok(got.attempts[0].startsWith("fetch https://api.sandbox.airwallex.com/") && got.attempts[1] === "socket 203.0.113.1:443", got.attempts.join(" | "));
});

test("FX-NET [fixtures] this file attempted no real network connection", () => {
  assert.deepEqual(networkAttempts(), []);
});
