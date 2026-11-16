// Contract-driven black-box scenarios for the integrated payment flow (contract flow-v1). TEST CODE ONLY.
// Each scenario drives a FlowPort and an independent mock provider and asserts only on what can be observed from
// outside: outcomes, the flow as read back, and what the provider was asked to do. No scenario imports an
// implementation. Section references (§) are to contracts/integrated/flow-v1.md.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_TTL_MS, INTENT_STALE_MS, LEGAL_TRANSITIONS, PROOF_IDS, PROVIDER_STATUS_TO_STATE } from "../../../integrated/flowTypes.ts";
import type { FlowOp } from "../../../integrated/flowTypes.ts";
import type { Registry } from "../../../src/server/agentRegistry.ts";
import { toMinor } from "../../../src/server/policy.ts";
import { APPROVAL_TTL_MS } from "../../../src/server/transfers.ts";
import {
  BALANCE, BEN_ID, BEN_LABEL, BENEFICIARIES, CASE, CASE_DOCUMENT, cooperativeClaims, E3_RESERVED_BENEFICIARY_ID, HUMAN, NOT_HUMAN, obligation, OTHER_HUMAN, privateDir,
  registeredText, T0,
} from "../support/fixtures.ts";
import type { RegistryVariant } from "../support/fixtures.ts";
import type { CreateMode } from "../support/mockProvider.ts";
import { BEFORE_INTENT, World } from "../support/port.ts";
import type { EvidenceInput, FlowPort, FlowState, FlowSystem, Outcome, TestView } from "../support/port.ts";
import type { PortSpec } from "../support/ports.ts";

export type Harness = { port: FlowPort; spec: PortSpec };
export type Scenario = { id: string; title: string; run: (h: Harness) => Promise<void> };

const CHILD = join(fileURLToPath(new URL(".", import.meta.url)), "..", "support", "child.ts");
const NEVER_REVIEWED: FlowState[] = ["DRAFT", "EVIDENCE_READY", "GATE_HOLD", "GATE_REVIEW"];
const REPLAY: EvidenceInput = { kind: "REPLAY", document_id: CASE_DOCUMENT };
const BAD_DIGESTS = (good: string, other: string): unknown[] => [other, good.toUpperCase(), good.slice(0, -1), `${good} `, "", null, undefined, 0, { digest: good }, [good]];

type Ctx = {
  h: Harness; world: World; sys: FlowSystem; base: Registry; netLog: string;
  /** A new handle on the same store with the same server key (another instance of the same server). */
  reopen: () => Promise<FlowSystem>;
  /** A real process restart: the in-memory approval key is gone and a new one is generated (§16 R11). */
  restart: () => Promise<FlowSystem>;
};
type Prepared = { out: Outcome & { flow_id?: string }; v: TestView | null };

async function start(h: Harness, label: string, variant: RegistryVariant = "baseline"): Promise<Ctx> {
  const dir = privateDir(label);
  const world = new World(dir, { t: T0, registryVariant: variant, balanceUsd: BALANCE, beneficiaries: BENEFICIARIES, fixedUuid: null });
  const c: Ctx = { h, world, sys: await h.port.open(world), base: h.port.baseRegistry(), netLog: join(dir, "net_attempts.log"), reopen: async () => (c.sys = await h.port.open(new World(dir))), restart: async () => { world.rotateApprovalKey(); return c.reopen(); } };
  return c;
}
/** Nothing in a scenario may leave the mock: no foreign host through the mock, no network attempt in a child. */
function hygiene(c: Ctx): void {
  assert.deepEqual(c.world.provider.foreignCalls(), [], "no call to any host or path outside the sandbox transfer API");
  assert.equal(existsSync(c.netLog) ? readFileSync(c.netLog, "utf8") : "", "", "no child process attempted a network connection");
}
async function view(c: Ctx, flow_id: string): Promise<TestView> {
  const v = await c.sys.read(flow_id);
  assert.ok(v, "the flow can be read back");
  return v;
}
const creates = (c: Ctx) => c.world.provider.createAttempts().length;
/** The provider journal as [operation, request id] pairs, in order. */
const journal = (c: Ctx) => c.world.provider.journal().map((e) => [e.op, e.request_id]);
/** The read-only request-id lookup the server makes before an approval and before a submit (flow-v1 A8-09 design). */
const lookup = (request_id: string): [string, string] => ["read", request_id];
const providerCalls = (c: Ctx) => c.world.provider.journal().filter((e) => e.op !== "read").length;
function unsettled(v: TestView, why: string): void {
  assert.equal(v.claims_settled, false, `${why}: not presented as paid or settled`);
  assert.notEqual(v.state, "PROVIDER_PAID", `${why}: state is not PROVIDER_PAID`);
  assert.notEqual(v.last_provider_status, "PAID", `${why}: no PAID read-back is recorded`);
}
/** Untrusted agent-run evidence: by default the registered document and a fully cooperative model. */
function run(c: Ctx): EvidenceInput {
  return { kind: "RUN", evidence: registeredText(c.base), claims: cooperativeClaims(obligation(c.base)) };
}
async function prepared(c: Ctx, evidence: EvidenceInput = REPLAY, case_id: unknown = CASE, actor: string = HUMAN): Promise<Prepared> {
  const out = await c.sys.prepare(actor, case_id, evidence);
  return { out, v: out.flow_id ? await view(c, out.flow_id) : null };
}
async function awaiting(c: Ctx, evidence: EvidenceInput = REPLAY): Promise<TestView> {
  const { out, v } = await prepared(c, evidence);
  assert.equal(out.ok, true, `the eligible case reaches human review (${out.code})`);
  assert.ok(v);
  assert.deepEqual([v.state, v.gate_decision], ["AWAITING_HUMAN", "ELIGIBLE_FOR_HUMAN_REVIEW"]);
  assert.ok(v.gate_digest, "the gate record has a digest");
  return v;
}
async function approve(c: Ctx, v: TestView, actor: string = HUMAN): Promise<TestView> {
  const out = await c.sys.approve(actor, v.flow_id, v.proposal_digest, v.gate_digest);
  assert.equal(out.ok, true, `human approval of the exact proposal and gate is accepted (${out.code})`);
  const after = await view(c, v.flow_id);
  assert.equal(after.state, "HUMAN_APPROVED");
  assert.ok(after.authorization_digest, "the authorization has a digest");
  return after;
}
const approved = async (c: Ctx): Promise<TestView> => approve(c, await awaiting(c));
async function submitted(c: Ctx): Promise<TestView> {
  const a = await approved(c);
  const out = await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest);
  assert.equal(out.ok, true, `submission is accepted (${out.code})`);
  const s = await view(c, a.flow_id);
  assert.equal(s.state, "SUBMITTED");
  return s;
}
/** A flow that never reached human review can go nowhere: not approved, not submitted, nothing sent. */
async function deadEnd(c: Ctx, r: Prepared, why: string, state?: FlowState): Promise<void> {
  assert.equal(r.out.ok, false, `${why}: does not reach human review`);
  if (r.v) {
    const v = r.v;
    assert.notEqual(v.gate_decision, "ELIGIBLE_FOR_HUMAN_REVIEW", `${why}: gate decision`);
    assert.ok(NEVER_REVIEWED.includes(v.state), `${why}: state ${v.state}`);
    if (state) assert.equal(v.state, state, why);
    for (const actor of [HUMAN, OTHER_HUMAN]) {
      assert.equal((await c.sys.approve(actor, v.flow_id, v.proposal_digest, v.gate_digest ?? "")).ok, false, `${why}: approval refused`);
      for (const d of [v.gate_digest, v.proposal_digest, ""]) assert.equal((await c.sys.submit(actor, v.flow_id, d)).ok, false, `${why}: submission refused`);
    }
    await c.sys.reconcile(HUMAN, v.flow_id);
    const after = await view(c, v.flow_id);
    assert.equal(after.state, v.state, `${why}: state unchanged by the refused attempts`);
    assert.equal(after.authorization_digest, null, `${why}: no authorization exists`);
    unsettled(after, why);
  }
  assert.equal(c.world.provider.journal().length, 0, `${why}: the provider was never contacted`);
}

type ChildResult = { signal: NodeJS.Signals | null; outcome: Outcome | null };
function child(c: Ctx, op: "approve" | "submit" | "approve_then_die", flow_id: string, digests: (string | null)[], actor: string = HUMAN): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    // a minimal environment: the child inherits no credentials, tokens or provider configuration from the caller
    const env = { PATH: process.env.PATH ?? "", DBIT_NET_LOG: c.netLog, NODE_NO_WARNINGS: "1" } as unknown as NodeJS.ProcessEnv;
    const p = spawn(process.execPath, [CHILD, JSON.stringify({ dir: c.world.dir, spec: c.h.spec, op, actor, flow_id, digests })], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (signal === null && code !== 0) return reject(new Error(`child failed (${code}): ${err.slice(0, 600)}`));
      resolve({ signal, outcome: signal === null ? (JSON.parse(out) as Outcome) : null });
    });
  });
}
/** A flow stopped in SUBMIT_INTENT_RECORDED by killing the submitting process inside the provider create call. */
async function crashedInCreate(c: Ctx, mode: CreateMode): Promise<TestView> {
  const a = await approved(c);
  c.world.provider.script({ create: mode });
  assert.equal((await child(c, "submit", a.flow_id, [a.authorization_digest])).signal, "SIGKILL", `${mode}: the submitting process was killed`);
  c.world.provider.script({ create: "ACCEPT" });
  await c.restart();
  return view(c, a.flow_id);
}

export const SCENARIOS: Scenario[] = [
  {
    id: "IT-01", title: "eligible obligation: 11 proofs verified, exact human approval, validate then one mocked create, SUBMITTED is not paid, read-back PROCESSING is not paid",
    run: async (h) => {
      for (const evidence of ["REPLAY", "RUN"] as const) {
        const c = await start(h, "it01");
        const v = await awaiting(c, evidence === "REPLAY" ? REPLAY : run(c));
        assert.deepEqual(Object.keys(v.proof_states ?? {}).sort(), [...PROOF_IDS].sort());
        for (const id of PROOF_IDS) assert.equal(v.proof_states?.[id], "VERIFIED", `proof ${id}`);
        const p = v.proposal;
        assert.deepEqual([p.obligation_id, p.beneficiary_id, p.beneficiary_label, p.amount_minor, p.currency, p.transfer_method, p.flow_id], [CASE, BEN_ID, BEN_LABEL, "500", "USD", "LOCAL", v.flow_id], "the server built the proposal from the registry, binding and allowlist");
        assert.equal(c.world.provider.journal().length, 0, "eligibility and review contact no provider");
        const a = await approve(c, v);
        assert.deepEqual(journal(c), [lookup(p.provider_request_id)], "human approval is not a transfer: the only provider contact is the one read-only request-id lookup");
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, true);
        const s = await view(c, a.flow_id);
        assert.deepEqual([s.state, s.create_reported_status, s.last_provider_status], ["SUBMITTED", "PROCESSING", null], "a create response never sets a provider state (§7.4)");
        unsettled(s, "HTTP 201 with PROCESSING");
        assert.deepEqual(journal(c), [lookup(p.provider_request_id), lookup(p.provider_request_id), ["validate", p.provider_request_id], lookup(p.provider_request_id), ["create", p.provider_request_id]], "one lookup at approve; at submit a lookup, then validate, then a lookup after the intent, then exactly one create (§7.1-3)");
        const recs = c.world.provider.records();
        assert.equal(recs.length, 1);
        assert.deepEqual([recs[0].request_id, recs[0].beneficiary_id, recs[0].transfer_currency, recs[0].reference, toMinor(recs[0].transfer_amount).toString()], [p.provider_request_id, p.beneficiary_id, p.currency, p.reference, p.amount_minor], "the provider was asked for exactly the approved proposal");
        assert.equal(s.provider_transfer_id, recs[0].id);
        assert.ok(s.attempt_id, "the attempt is recorded");
        assert.equal((await c.sys.reconcile(HUMAN, a.flow_id)).ok, true);
        const r = await view(c, a.flow_id);
        assert.deepEqual([r.state, r.last_provider_status], ["PROVIDER_PROCESSING", "PROCESSING"]);
        unsettled(r, "provider read-back PROCESSING");
        assert.equal(creates(c), 1, "read-back creates nothing");
        assert.notEqual(r.audit_verified, false, "the audit chain verifies");
        hygiene(c);
      }
    },
  },
  {
    id: "IT-02", title: "HOLD: open dispute, revoked or conditional approval, missing document and the E3 project obligations cannot be approved or submitted",
    run: async (h) => {
      for (const variant of ["dispute_opened", "approval_revoked", "approval_conditional", "document_missing"] as RegistryVariant[]) {
        const c = await start(h, "it02", variant);
        const r = await prepared(c);
        assert.equal(r.v?.gate_decision, "HOLD", variant);
        await deadEnd(c, r, `HOLD (${variant})`, "GATE_HOLD");
        for (const who of NOT_HUMAN) assert.equal((await c.sys.approve(who, r.v!.flow_id, r.v!.proposal_digest, r.v!.gate_digest)).ok, false);
        hygiene(c);
      }
      // every E3 project obligation in the registry is funding-blocked: HOLD, and never a provider beneficiary
      const base = h.port.baseRegistry();
      const e3 = base.obligations.filter((o) => o.funding_source === "E3_PROJECT");
      assert.ok(e3.length >= 1, "the registry carries at least one E3 project obligation");
      for (const o of e3) {
        const c = await start(h, "it02");
        const r = await prepared(c, { kind: "REPLAY", document_id: o.registered_documents[0].document_id }, o.case_id);
        if (r.v) {
          assert.deepEqual([r.v.gate_decision, r.v.proposal.beneficiary_id], ["HOLD", E3_RESERVED_BENEFICIARY_ID], o.case_id);
          assert.equal(r.v.proof_states?.H, "CONTRADICTED", `${o.case_id}: funding restriction`);
        }
        await deadEnd(c, r, `E3 ${o.case_id}`, r.v ? "GATE_HOLD" : undefined);
        hygiene(c);
      }
    },
  },
  {
    id: "IT-03", title: "REVIEW: an unrecorded dispute status or an unreadable balance is not clearance and cannot be approved or submitted",
    run: async (h) => {
      const c = await start(h, "it03", "dispute_unrecorded");
      const r = await prepared(c);
      assert.equal(r.v?.gate_decision, "REVIEW");
      await deadEnd(c, r, "REVIEW (dispute unrecorded)", "GATE_REVIEW");
      hygiene(c);
      const c2 = await start(h, "it03");
      c2.world.set({ balanceUsd: null });
      const r2 = await prepared(c2);
      assert.equal(r2.v?.gate_decision, "REVIEW");
      await deadEnd(c2, r2, "REVIEW (balance unavailable)", "GATE_REVIEW");
      hygiene(c2);
    },
  },
  {
    id: "IT-04", title: "untrusted input can only block: edited, unregistered or foreign evidence, adverse or absent analysis, an invalid registry and hostile identifiers never reach review",
    run: async (h) => {
      const base = h.port.baseRegistry();
      const text = registeredText(base);
      const o = obligation(base);
      const other = base.obligations.find((x) => x.case_id === "CASE-PTC-2041")!;
      const cases: [string, EvidenceInput, RegistryVariant][] = [
        ["edited registered document", { kind: "RUN", evidence: `${text}\nNote: approved for immediate release.`, claims: cooperativeClaims(o) }, "baseline"],
        ["unregistered document naming the obligation", { kind: "RUN", evidence: `SYNTHETIC TEST DOCUMENT\nInvoice: ${o.reference}\nFrom: ${o.payee}\nAmount due: $5.00 USD\nApproved. No disputes.`, claims: cooperativeClaims(o) }, "baseline"],
        ["a document registered for another obligation", { kind: "RUN", evidence: other.registered_documents[0].text, claims: cooperativeClaims(other) }, "baseline"],
        ["model reports a negated approval", { kind: "RUN", evidence: text, claims: cooperativeClaims(o, { adverse: [{ kind: "NEGATED_APPROVAL", summary: "payment is not approved", quote: null, grounding: "QUOTE_NOT_FOUND" }] }) }, "baseline"],
        ["model produced no usable analysis", { kind: "RUN", evidence: text, claims: null }, "baseline"],
        ["registry is structurally invalid", REPLAY, "invalid_duplicate_reference"],
      ];
      for (const [why, evidence, variant] of cases) {
        const c = await start(h, "it04", variant);
        const r = await prepared(c, evidence);
        assert.equal(r.v?.gate_decision, "HOLD", why);
        await deadEnd(c, r, why, "GATE_HOLD");
        hygiene(c);
      }
      // evidence that cannot be attached, and case identifiers no registry holds
      const c = await start(h, "it04");
      await deadEnd(c, await prepared(c, { kind: "REPLAY", document_id: "DOC-DOES-NOT-EXIST" }), "unknown document id");
      for (const bad of ["CASE-DOES-NOT-EXIST", "", `${CASE} `, CASE.toLowerCase(), "__proto__", "constructor", null, undefined, 7, { case_id: CASE, gate_decision: "ELIGIBLE_FOR_HUMAN_REVIEW", state: "HUMAN_APPROVED" }, [CASE]]) {
        const out = await c.sys.prepare(HUMAN, bad, REPLAY); // called directly: `undefined` must reach the system as given
        assert.equal(out.ok, false, `case id ${JSON.stringify(bad)}`);
        assert.equal(out.flow_id, undefined, `no flow is created for case id ${JSON.stringify(bad)}`);
      }
      for (const who of NOT_HUMAN) assert.equal((await prepared(c, REPLAY, CASE, who)).out.ok, false, `flow created by ${JSON.stringify(who)}`);
      assert.equal(c.world.provider.journal().length, 0);
      hygiene(c);
    },
  },
  {
    id: "IT-05", title: "eligible for human review is not authorization: no submit without approval; only a human approves; only the approving human submits",
    run: async (h) => {
      const c = await start(h, "it05");
      const v = await awaiting(c);
      for (const d of [v.gate_digest, v.proposal_digest, "", null]) assert.equal((await c.sys.submit(HUMAN, v.flow_id, d)).ok, false, "submit before any approval");
      for (const who of NOT_HUMAN) assert.equal((await c.sys.approve(who, v.flow_id, v.proposal_digest, v.gate_digest)).ok, false, `approve as ${JSON.stringify(who)}`);
      const still = await view(c, v.flow_id);
      assert.deepEqual([still.state, still.authorization_digest], ["AWAITING_HUMAN", null]);
      const a = await approve(c, v);
      for (const who of [...NOT_HUMAN, OTHER_HUMAN]) assert.equal((await c.sys.submit(who, a.flow_id, a.authorization_digest)).ok, false, `submit as ${JSON.stringify(who)}`);
      assert.equal((await view(c, a.flow_id)).state, "HUMAN_APPROVED");
      assert.equal(providerCalls(c), 0, "a refused submit sends nothing, not even a validate");
      hygiene(c);
    },
  },
  {
    id: "IT-06", title: "mismatch: a registry that disagrees with the proposal is HOLD, and approval or submission against any digest but the exact ones shown is refused",
    run: async (h) => {
      for (const variant of ["amount_changed", "payee_changed", "reference_changed", "currency_changed"] as RegistryVariant[]) {
        const c = await start(h, "it06", variant);
        const r = await prepared(c);
        assert.equal(r.v?.gate_decision, "HOLD", variant);
        await deadEnd(c, r, `mismatch (${variant})`, "GATE_HOLD");
        hygiene(c);
      }
      const c = await start(h, "it06");
      const v = await awaiting(c);
      const other = await awaiting(c);
      assert.ok(other.proposal_digest !== v.proposal_digest && other.gate_digest !== v.gate_digest, "two flows for one obligation have different proposal and gate digests");
      for (const d of BAD_DIGESTS(v.proposal_digest, other.proposal_digest)) assert.equal((await c.sys.approve(HUMAN, v.flow_id, d, v.gate_digest)).ok, false, `approval with proposal digest ${JSON.stringify(d)}`);
      for (const d of BAD_DIGESTS(v.gate_digest!, other.gate_digest!)) assert.equal((await c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, d)).ok, false, `approval with gate digest ${JSON.stringify(d)}`);
      assert.equal((await c.sys.approve(HUMAN, v.flow_id, v.gate_digest, v.proposal_digest)).ok, false, "approval with the two digests swapped");
      assert.deepEqual([(await view(c, v.flow_id)).state, (await view(c, v.flow_id)).authorization_digest], ["AWAITING_HUMAN", null]);
      const a = await approve(c, v);
      const b = await approve(c, other);
      for (const d of [...BAD_DIGESTS(a.authorization_digest!, b.authorization_digest!), a.proposal_digest, a.gate_digest]) assert.equal((await c.sys.submit(HUMAN, a.flow_id, d)).ok, false, `submission with authorization digest ${JSON.stringify(d)}`);
      assert.equal((await view(c, a.flow_id)).state, "HUMAN_APPROVED");
      assert.equal(providerCalls(c), 0);
      hygiene(c);
    },
  },
  {
    id: "IT-07", title: "expiry: an expired gate cannot be approved and an expired authorization cannot be submitted (EXPIRED); a live authorization outlives the gate TTL",
    run: async (h) => {
      const c = await start(h, "it07");
      const v = await awaiting(c);
      c.world.advance(GATE_TTL_MS);
      assert.equal((await c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest)).ok, false, "approval at the gate expiry instant");
      assert.equal((await view(c, v.flow_id)).state, "EXPIRED", "an expired gate found by an operation expires the flow (§6)");
      c.world.advance(-GATE_TTL_MS);
      assert.equal((await c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest)).ok, false, "EXPIRED is terminal even if the clock goes back");
      const c2 = await start(h, "it07");
      const a = await approved(c2);
      c2.world.advance(APPROVAL_TTL_MS);
      assert.equal((await c2.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, "submission at the authorization expiry instant");
      assert.equal((await view(c2, a.flow_id)).state, "EXPIRED");
      // §5: at submit the gate TTL is not re-applied; the authorization TTL governs
      const c3 = await start(h, "it07");
      const w = await awaiting(c3);
      c3.world.advance(GATE_TTL_MS - 1);
      const late = await approve(c3, w);
      c3.world.advance(APPROVAL_TTL_MS - 1);
      assert.equal((await c3.sys.submit(HUMAN, late.flow_id, late.authorization_digest)).ok, true, "authorization still live although the gate TTL has passed");
      assert.equal(creates(c) + creates(c2), 0);
      assert.equal(creates(c3), 1);
      for (const x of [c, c2, c3]) hygiene(x);
    },
  },
  {
    id: "IT-08", title: "invalid beneficiary: a binding that does not resolve to exactly one allowlisted sandbox beneficiary creates no flow",
    run: async (h) => {
      const lists: [string, [string, string][]][] = [
        ["empty allowlist", []],
        ["label not on the allowlist", [[BEN_ID, "Some other supplier"]]],
        ["two beneficiaries with the bound label", [[BEN_ID, BEN_LABEL], ["11111111-2222-4333-8444-555555555555", BEN_LABEL]]],
        ["label differs only by case", [[BEN_ID, BEN_LABEL.toUpperCase()]]],
      ];
      for (const [why, beneficiaries] of lists) {
        const c = await start(h, "it08");
        c.world.set({ beneficiaries });
        await c.reopen();
        const r = await prepared(c);
        assert.equal(r.out.flow_id, undefined, `${why}: no flow is created`);
        await deadEnd(c, r, why);
        hygiene(c);
      }
      // a different id carrying the bound label is used as given: the id comes from the allowlist, never from a client
      const c = await start(h, "it08");
      c.world.set({ beneficiaries: [["22222222-3333-4444-8555-666666666666", BEN_LABEL]] });
      await c.reopen();
      assert.equal((await awaiting(c)).proposal.beneficiary_id, "22222222-3333-4444-8555-666666666666");
      hygiene(c);
    },
  },
  {
    id: "IT-09", title: "stale registry or balance: any drift after the gate invalidates approval, and after approval invalidates submission",
    run: async (h) => {
      const drifts: [string, (c: Ctx) => void][] = [
        ...(["dispute_opened", "approval_revoked", "amount_changed", "payee_changed", "unrelated_change", "invalid_duplicate_reference"] as RegistryVariant[]).map((v): [string, (c: Ctx) => void] => [`registry ${v}`, (c) => c.world.set({ registryVariant: v })]),
        ["balance below the reserve", (c) => c.world.set({ balanceUsd: "104.99" })],
        ["balance unreadable", (c) => c.world.set({ balanceUsd: null })],
      ];
      for (const [why, drift] of drifts) {
        const c = await start(h, "it09");
        const v = await awaiting(c);
        drift(c);
        assert.equal((await c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest)).ok, false, `approve after ${why}`);
        const after = await view(c, v.flow_id);
        assert.deepEqual([after.state, after.authorization_digest], ["AWAITING_HUMAN", null], why);
        const c2 = await start(h, "it09");
        const a = await approved(c2);
        drift(c2);
        assert.equal((await c2.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, `submit after ${why}`);
        assert.equal((await view(c2, a.flow_id)).state, "HUMAN_APPROVED", `no intent recorded after ${why}`);
        assert.equal(providerCalls(c) + providerCalls(c2), 0, why);
        hygiene(c);
        hygiene(c2);
      }
    },
  },
  {
    id: "IT-10", title: "double submit and replay: a second submit, a replayed approval or authorization, a reused id and another flow's digests never produce a second create",
    run: async (h) => {
      const c = await start(h, "it10");
      const s = await submitted(c);
      const rid = s.proposal.provider_request_id;
      assert.equal((await c.sys.submit(HUMAN, s.flow_id, s.authorization_digest)).ok, false, "second submit");
      assert.equal((await c.sys.approve(HUMAN, s.flow_id, s.proposal_digest, s.gate_digest)).ok, false, "approval replayed after submission");
      assert.equal((await c.sys.reject(HUMAN, s.flow_id, s.proposal_digest)).ok, false, "rejection after submission");
      assert.equal(creates(c), 1);
      // a flow whose ids collide with an existing one is never created
      for (const fixed of [rid, s.flow_id]) {
        c.world.set({ fixedUuid: fixed });
        assert.equal((await prepared(c)).out.ok, false, "a reused flow id or provider request id");
        c.world.set({ fixedUuid: null });
      }
      assert.equal(c.world.provider.createAttempts(rid).length, 1, "one create attempt, ever, per provider request id");
      // one gate authorizes once; one flow's digests open no other flow
      const a = await approved(c);
      assert.equal((await c.sys.approve(HUMAN, a.flow_id, a.proposal_digest, a.gate_digest)).ok, false, "approval replayed on an approved flow");
      assert.equal((await view(c, a.flow_id)).authorization_digest, a.authorization_digest, "the authorization is unchanged by the replay");
      const b = await awaiting(c);
      assert.equal((await c.sys.approve(HUMAN, b.flow_id, a.proposal_digest, a.gate_digest)).ok, false, "flow B approved with flow A's digests");
      assert.equal((await c.sys.submit(HUMAN, b.flow_id, a.authorization_digest)).ok, false, "flow B submitted with flow A's authorization");
      assert.equal((await c.sys.submit(HUMAN, a.flow_id, s.authorization_digest)).ok, false, "flow A submitted with a consumed authorization from another flow");
      for (const id of ["00000000-0000-4000-8000-000000000000", "", `../${a.flow_id}`, null, undefined, { flow_id: a.flow_id }]) {
        assert.equal((await c.sys.approve(HUMAN, id, a.proposal_digest, a.gate_digest)).ok, false, `approve unknown flow ${JSON.stringify(id)}`);
        assert.equal((await c.sys.submit(HUMAN, id, a.authorization_digest)).ok, false, `submit unknown flow ${JSON.stringify(id)}`);
        assert.equal(await c.sys.read(id), null);
      }
      assert.equal(creates(c), 1);
      // a restart (browser refresh, server restart) changes nothing
      await c.reopen();
      assert.equal((await c.sys.submit(HUMAN, s.flow_id, s.authorization_digest)).ok, false, "submit after restart");
      assert.equal(creates(c), 1);
      hygiene(c);
    },
  },
  {
    id: "IT-11", title: "race in one process: eight simultaneous approvals give one authorization; eight simultaneous submits give exactly one create",
    run: async (h) => {
      const c = await start(h, "it11");
      const v = await awaiting(c);
      const approvals = await Promise.all(Array.from({ length: 8 }, () => c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest)));
      assert.equal(approvals.filter((o) => o.ok).length, 1, "exactly one approval succeeds");
      const a = await view(c, v.flow_id);
      assert.equal(a.state, "HUMAN_APPROVED");
      c.world.provider.script({ delayMs: 40 });
      const outs = await Promise.all(Array.from({ length: 8 }, () => c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)));
      assert.equal(creates(c), 1, "exactly one create attempt");
      assert.equal(outs.filter((o) => o.ok).length, 1, "exactly one submit succeeds");
      assert.equal(c.world.provider.records().length, 1);
      const s = await view(c, a.flow_id);
      assert.equal(s.state, "SUBMITTED");
      unsettled(s, "after the race");
      hygiene(c);
    },
  },
  {
    id: "IT-12", title: "race across processes: six server processes submitting one approved flow at once produce exactly one create, and read-back agrees",
    run: async (h) => {
      const c = await start(h, "it12");
      const a = await approved(c);
      c.world.provider.script({ delayMs: 150 });
      const outs = await Promise.all(Array.from({ length: 6 }, () => child(c, "submit", a.flow_id, [a.authorization_digest])));
      assert.equal(creates(c), 1, "exactly one create attempt across all processes");
      assert.equal(outs.filter((o) => o.outcome?.ok).length, 1, "exactly one process reports success");
      assert.equal(c.world.provider.records().length, 1);
      await c.reopen();
      assert.equal((await view(c, a.flow_id)).state, "SUBMITTED");
      assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, "no submit after the race");
      assert.equal((await c.sys.reconcile(HUMAN, a.flow_id)).ok, true, "read-back finds the one transfer");
      const r = await view(c, a.flow_id);
      assert.deepEqual([r.state, r.last_provider_status], ["PROVIDER_PROCESSING", "PROCESSING"]);
      unsettled(r, "after the race");
      assert.equal(creates(c), 1);
      hygiene(c);
    },
  },
  {
    id: "IT-13", title: "provider timeout or unclear answer after a possible send: SUBMISSION_UNCERTAIN, no second create, a matching read-back resolves it",
    run: async (h) => {
      for (const mode of ["TIMEOUT_AFTER_SEND", "HTTP_500_AFTER_SEND", "HTTP_409_AFTER_SEND", "DUPLICATE_AFTER_SEND", "MALFORMED_201", "WRONG_ECHO_201"] as CreateMode[]) {
        const c = await start(h, "it13");
        const a = await approved(c);
        c.world.provider.script({ create: mode });
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, `${mode}: the outcome is not reported as success`);
        const u = await view(c, a.flow_id);
        assert.equal(u.state, "SUBMISSION_UNCERTAIN", mode);
        unsettled(u, mode);
        c.world.provider.script({ create: "ACCEPT" });
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, `${mode}: resubmission refused`);
        assert.equal((await c.sys.approve(HUMAN, a.flow_id, a.proposal_digest, a.gate_digest)).ok, false, `${mode}: re-approval refused`);
        assert.equal(creates(c), 1, `${mode}: no second create`);
        assert.equal((await c.sys.reconcile(HUMAN, a.flow_id)).ok, true, `${mode}: read-back finds the provider's record`);
        const r = await view(c, a.flow_id);
        assert.deepEqual([r.state, r.last_provider_status], ["PROVIDER_PROCESSING", "PROCESSING"], mode);
        unsettled(r, mode);
        assert.equal(creates(c), 1, `${mode}: read-back creates nothing`);
        hygiene(c);
      }
    },
  },
  {
    id: "IT-14", title: "nothing reached the provider: a timeout stays uncertain with no retry, a failed validation sends nothing, and a definite refusal is terminal",
    run: async (h) => {
      for (const mode of ["TIMEOUT_BEFORE_SEND", "HTTP_503_BEFORE_SEND", "HTTP_429_BEFORE_SEND"] as CreateMode[]) {
        const c = await start(h, "it14");
        const a = await approved(c);
        c.world.provider.script({ create: mode });
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, mode);
        assert.equal((await view(c, a.flow_id)).state, "SUBMISSION_UNCERTAIN", mode);
        c.world.provider.script({ create: "ACCEPT" });
        assert.equal((await c.sys.reconcile(HUMAN, a.flow_id)).ok, false, `${mode}: the provider has no record`);
        assert.equal((await c.sys.reconcile(HUMAN, a.flow_id)).ok, false, `${mode}: still no record`);
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, `${mode}: resubmission refused`);
        const u = await view(c, a.flow_id);
        assert.equal(u.state, "SUBMISSION_UNCERTAIN", `${mode}: an empty read-back does not prove absence`);
        unsettled(u, mode);
        assert.equal(creates(c), 1, `${mode}: one attempt, never retried, never re-created by read-back`);
        assert.equal(c.world.provider.records().length, 0, mode);
        hygiene(c);
      }
      for (const validate of ["REFUSE_400", "HTTP_500", "TIMEOUT"] as const) {
        const c = await start(h, "it14");
        const a = await approved(c);
        c.world.provider.script({ validate });
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, `validate ${validate}`);
        assert.equal((await view(c, a.flow_id)).state, "HUMAN_APPROVED", `validate ${validate}: the flow stays approved (§7.1)`);
        assert.equal(creates(c), 0, `validate ${validate}: no create without a passed validation`);
        hygiene(c);
      }
      for (const mode of ["REFUSE_400", "REFUSE_401", "REFUSE_403", "REFUSE_404", "REFUSE_422"] as CreateMode[]) {
        const c = await start(h, "it14");
        const a = await approved(c);
        c.world.provider.script({ create: mode });
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, mode);
        c.world.provider.script({ create: "ACCEPT" });
        assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, `${mode}: no resubmission after a refusal`);
        await c.sys.reconcile(HUMAN, a.flow_id);
        const f = await view(c, a.flow_id);
        assert.equal(f.state, "PROVIDER_REFUSED", mode);
        unsettled(f, mode);
        assert.equal(creates(c), 1, mode);
        hygiene(c);
      }
    },
  },
  {
    id: "IT-15", title: "crash recovery: process killed before intent, after intent but before the network, and after the provider received the create",
    run: async (h) => {
      // (a) killed after the approval committed, before submit was ever called (§7.6: no create was sent).
      // The restarted server has a new approval key, so the old approval cannot be used: it fails closed (§16 R11.4).
      const c = await start(h, "it15a");
      const v = await awaiting(c);
      assert.equal((await child(c, "approve_then_die", v.flow_id, [v.proposal_digest, v.gate_digest])).signal, "SIGKILL");
      await c.restart();
      const a = await view(c, v.flow_id);
      assert.equal(a.state, "HUMAN_APPROVED", "the committed approval record survives the crash");
      assert.equal(providerCalls(c), 0, "recovery sends nothing on its own");
      assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, "an approval issued before the restart is not accepted after it");
      assert.equal(providerCalls(c), 0, "nothing was validated or created");
      unsettled(await view(c, a.flow_id), "after the restart");
      hygiene(c);
      // (b) and (c): killed inside the provider create call
      for (const [mode, sent] of [["CRASH_BEFORE_SEND", false], ["CRASH_AFTER_SEND", true]] as [CreateMode, boolean][]) {
        const k = await start(h, "it15b");
        const r = await crashedInCreate(k, mode);
        assert.equal(r.state, "SUBMIT_INTENT_RECORDED", `${mode}: the intent was durable before the provider call (§7.2)`);
        assert.ok(r.attempt_id, `${mode}: the attempt row exists`);
        unsettled(r, mode);
        assert.equal(creates(k), 1, `${mode}: restart does not send again`);
        assert.equal((await k.sys.submit(HUMAN, r.flow_id, r.authorization_digest)).ok, false, `${mode}: resubmission refused after restart`);
        assert.equal((await k.sys.approve(HUMAN, r.flow_id, r.proposal_digest, r.gate_digest)).ok, false, `${mode}: re-approval refused after restart`);
        assert.equal((await k.sys.reconcile(HUMAN, r.flow_id)).ok, false, `${mode}: a young intent may still be in flight (§6)`);
        assert.equal((await view(k, r.flow_id)).state, "SUBMIT_INTENT_RECORDED", mode);
        k.world.advance(INTENT_STALE_MS);
        const rec = await k.sys.reconcile(HUMAN, r.flow_id);
        const after = await view(k, r.flow_id);
        if (sent) {
          assert.equal(rec.ok, true, `${mode}: read-back finds the transfer the provider created`);
          assert.deepEqual([after.state, after.last_provider_status], ["PROVIDER_PROCESSING", "PROCESSING"]);
        } else {
          assert.equal(rec.ok, false, `${mode}: the provider has no record`);
          assert.equal(after.state, "SUBMISSION_UNCERTAIN", `${mode}: a stale intent is presumed crashed and stays unresolved`);
        }
        unsettled(after, mode);
        assert.equal((await k.sys.submit(HUMAN, r.flow_id, r.authorization_digest)).ok, false, `${mode}: still no resubmission`);
        assert.equal(creates(k), 1, `${mode}: exactly one create attempt in total`);
        assert.equal(k.world.provider.records().length, sent ? 1 : 0);
        hygiene(k);
      }
    },
  },
  {
    id: "IT-16", title: "provider status truthfulness: every known status maps to its own state; only a matching PAID read-back is settlement; terminal states do not regress",
    run: async (h) => {
      for (const [status, state] of Object.entries(PROVIDER_STATUS_TO_STATE)) {
        const c = await start(h, "it16");
        const s = await submitted(c);
        unsettled(s, "before any read-back");
        c.world.provider.moveTo(s.proposal.provider_request_id, status);
        assert.equal((await c.sys.reconcile(HUMAN, s.flow_id)).ok, true, status);
        const r = await view(c, s.flow_id);
        assert.deepEqual([r.state, r.last_provider_status, r.claims_settled], [state, status, status === "PAID"], status);
        assert.equal(creates(c), 1);
        hygiene(c);
      }
      // a create response that itself says PAID or SCHEDULED is still only SUBMITTED
      for (const createStatus of ["PAID", "SCHEDULED"]) {
        const c = await start(h, "it16");
        c.world.provider.script({ createStatus });
        const s = await submitted(c);
        assert.deepEqual([s.state, s.create_reported_status, s.last_provider_status, s.claims_settled], ["SUBMITTED", createStatus, null, false], `create response ${createStatus}`);
        hygiene(c);
      }
      // statuses outside the known vocabulary are never promoted and change nothing
      for (const status of ["SETTLED", "paid", "PAID ", "COMPLETED", ""]) {
        const c = await start(h, "it16");
        const s = await submitted(c);
        c.world.provider.moveTo(s.proposal.provider_request_id, status);
        assert.equal((await c.sys.reconcile(HUMAN, s.flow_id)).ok, false, `provider status ${JSON.stringify(status)}`);
        const r = await view(c, s.flow_id);
        assert.equal(r.state, "SUBMITTED", `provider status ${JSON.stringify(status)}`);
        unsettled(r, `provider status ${JSON.stringify(status)}`);
        hygiene(c);
      }
      // a PAID that cannot be read, or that does not match this request, is not settlement
      const c = await start(h, "it16");
      const s = await submitted(c);
      c.world.provider.moveTo(s.proposal.provider_request_id, "PAID");
      for (const read of ["TIMEOUT", "HTTP_500", "WRONG_AMOUNT", "WRONG_CURRENCY", "WRONG_REQUEST_ID"] as const) {
        c.world.provider.script({ read });
        assert.equal((await c.sys.reconcile(HUMAN, s.flow_id)).ok, false, `read-back ${read}`);
        const r = await view(c, s.flow_id);
        assert.equal(r.state, "SUBMITTED", `read-back ${read} is audit-only`);
        unsettled(r, `read-back ${read}`);
      }
      // SCHEDULED -> PROCESSING -> PAID, each only when the provider says so; then PAID is final
      c.world.provider.script({ read: "OK" });
      for (const status of ["SCHEDULED", "PROCESSING", "PAID"]) {
        c.world.provider.moveTo(s.proposal.provider_request_id, status);
        assert.equal((await c.sys.reconcile(HUMAN, s.flow_id)).ok, true, status);
        const r = await view(c, s.flow_id);
        assert.deepEqual([r.state, r.claims_settled], [`PROVIDER_${status}`, status === "PAID"]);
      }
      c.world.provider.moveTo(s.proposal.provider_request_id, "PROCESSING");
      await c.sys.reconcile(HUMAN, s.flow_id);
      assert.equal((await view(c, s.flow_id)).state, "PROVIDER_PAID", "a later disagreeing read does not move a terminal state");
      assert.equal(creates(c), 1, "no read-back ever creates a transfer");
      hygiene(c);
      // FAILED is final too: a later PAID read is a warning, not settlement
      const f = await start(h, "it16");
      const fs = await submitted(f);
      f.world.provider.moveTo(fs.proposal.provider_request_id, "FAILED");
      assert.equal((await f.sys.reconcile(HUMAN, fs.flow_id)).ok, true);
      f.world.provider.moveTo(fs.proposal.provider_request_id, "PAID");
      await f.sys.reconcile(HUMAN, fs.flow_id);
      const fr = await view(f, fs.flow_id);
      assert.deepEqual([fr.state, fr.claims_settled], ["PROVIDER_FAILED", false]);
      // an uncertain flow whose only matching evidence is ambiguous stays uncertain
      const m = await start(h, "it16");
      const ma = await approved(m);
      m.world.provider.script({ create: "TIMEOUT_AFTER_SEND" });
      await m.sys.submit(HUMAN, ma.flow_id, ma.authorization_digest);
      m.world.provider.script({ read: "MULTIPLE" });
      assert.equal((await m.sys.reconcile(HUMAN, ma.flow_id)).ok, false, "several provider records for one request id");
      assert.equal((await view(m, ma.flow_id)).state, "SUBMISSION_UNCERTAIN");
      hygiene(f);
      hygiene(m);
    },
  },
  {
    id: "IT-17", title: "durability: every stage survives a restart with the same record, and read-back of an unsent flow sends nothing",
    run: async (h) => {
      const c = await start(h, "it17");
      const v = await awaiting(c);
      await c.reopen();
      assert.deepEqual(await view(c, v.flow_id), v);
      await c.sys.reconcile(HUMAN, v.flow_id);
      const a = await approve(c, await view(c, v.flow_id));
      await c.reopen();
      assert.deepEqual(await view(c, v.flow_id), a);
      await c.sys.reconcile(HUMAN, v.flow_id);
      assert.deepEqual(journal(c), [lookup(a.proposal.provider_request_id)], "read-back of a flow that was never submitted contacts no provider: the only entry is the approval's request-id lookup");
      assert.equal((await view(c, v.flow_id)).state, "HUMAN_APPROVED");
      assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, true);
      const s = await view(c, a.flow_id);
      await c.reopen();
      assert.deepEqual(await view(c, a.flow_id), s);
      assert.ok(s.version > a.version && a.version > v.version, "the record version only moves forward");
      assert.equal(creates(c), 1, "a restart after submission sends nothing");
      hygiene(c);
    },
  },
  {
    id: "IT-18", title: "state machine: from every reachable state, approve, reject, submit and read-back make only the moves LEGAL_TRANSITIONS allows, and only a submit from HUMAN_APPROVED creates",
    run: async (h) => {
      const afterRead = async (c: Ctx, status: string) => {
        const s = await submitted(c);
        c.world.provider.moveTo(s.proposal.provider_request_id, status);
        assert.equal((await c.sys.reconcile(HUMAN, s.flow_id)).ok, true);
        return view(c, s.flow_id);
      };
      const builders: Record<string, (c: Ctx) => Promise<TestView>> = {
        GATE_HOLD: async (c) => { c.world.set({ registryVariant: "dispute_opened" }); return (await prepared(c)).v!; },
        GATE_REVIEW: async (c) => { c.world.set({ registryVariant: "dispute_unrecorded" }); return (await prepared(c)).v!; },
        AWAITING_HUMAN: (c) => awaiting(c),
        HUMAN_APPROVED: (c) => approved(c),
        HUMAN_REJECTED: async (c) => { const v = await awaiting(c); assert.equal((await c.sys.reject(HUMAN, v.flow_id, v.proposal_digest)).ok, true); return view(c, v.flow_id); },
        EXPIRED: async (c) => { const v = await awaiting(c); c.world.advance(GATE_TTL_MS); await c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest); c.world.advance(-GATE_TTL_MS); return view(c, v.flow_id); },
        SUBMIT_INTENT_RECORDED: (c) => crashedInCreate(c, "CRASH_BEFORE_SEND"),
        SUBMITTED: (c) => submitted(c),
        SUBMISSION_UNCERTAIN: async (c) => { const a = await approved(c); c.world.provider.script({ create: "TIMEOUT_BEFORE_SEND" }); await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest); c.world.provider.script({ create: "ACCEPT" }); return view(c, a.flow_id); },
        PROVIDER_REFUSED: async (c) => { const a = await approved(c); c.world.provider.script({ create: "REFUSE_422" }); await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest); c.world.provider.script({ create: "ACCEPT" }); return view(c, a.flow_id); },
        PROVIDER_SCHEDULED: (c) => afterRead(c, "SCHEDULED"),
        PROVIDER_PROCESSING: (c) => afterRead(c, "PROCESSING"),
        PROVIDER_FAILED: (c) => afterRead(c, "FAILED"),
        PROVIDER_PAID: (c) => afterRead(c, "PAID"),
      };
      const ops: Record<string, { legal: FlowOp[]; call: (c: Ctx, v: TestView) => Promise<Outcome> }> = {
        approve: { legal: ["approve", "expire"], call: (c, v) => c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest ?? "") },
        reject: { legal: ["reject", "expire"], call: (c, v) => c.sys.reject(HUMAN, v.flow_id, v.proposal_digest) },
        submit: { legal: ["record_submit_intent", "record_create_accepted", "record_create_refused", "record_create_uncertain", "expire"], call: (c, v) => c.sys.submit(HUMAN, v.flow_id, v.authorization_digest ?? "") },
        reconcile: { legal: ["recover_stale_intent", "record_provider_read"], call: (c, v) => c.sys.reconcile(HUMAN, v.flow_id) },
      };
      for (const [state, build] of Object.entries(builders)) {
        for (const [name, op] of Object.entries(ops)) {
          const c = await start(h, "it18");
          const before = await build(c);
          assert.equal(before.state, state, `fixture reaches ${state}`);
          const sent = creates(c);
          const out = await op.call(c, before);
          const after = await view(c, before.flow_id);
          const where = `${name} from ${state} -> ${after.state} (${out.code})`;
          if (after.state !== before.state) {
            // a submit passes through SUBMIT_INTENT_RECORDED, so its end state is reachable in two legal steps
            const direct = op.legal.some((o) => LEGAL_TRANSITIONS[o].from.includes(before.state) && LEGAL_TRANSITIONS[o].to.includes(after.state));
            const viaIntent = name === "submit" && before.state === "HUMAN_APPROVED" && ["SUBMITTED", "PROVIDER_REFUSED", "SUBMISSION_UNCERTAIN"].includes(after.state);
            assert.ok(direct || viaIntent, `illegal transition: ${where}`);
            assert.ok(after.version > before.version, `${where}: version advances`);
          } else assert.ok(after.version === before.version || !out.ok || name === "reconcile", `${where}: a successful state-preserving call is only possible for read-back`);
          const mayCreate = name === "submit" && state === "HUMAN_APPROVED";
          assert.equal(creates(c) - sent, mayCreate ? 1 : 0, `${where}: create attempts`);
          if (!mayCreate && !(name === "approve" && state === "AWAITING_HUMAN")) assert.ok(!BEFORE_INTENT.includes(after.state) || BEFORE_INTENT.includes(before.state), `${where}: no way back to a pre-intent state`);
          if (state !== "PROVIDER_PAID") unsettled(after, where);
          hygiene(c);
        }
      }
    },
  },
  {
    id: "IT-19", title: "allowlist re-check (§14 R5): a beneficiary removed from the allowlist after review cannot be approved, and after approval cannot be submitted",
    run: async (h) => {
      const c = await start(h, "it19");
      const v = await awaiting(c);
      c.world.set({ beneficiaries: [] });
      await c.reopen();
      assert.equal((await c.sys.approve(HUMAN, v.flow_id, v.proposal_digest, v.gate_digest)).ok, false, "beneficiary removed after review");
      assert.notEqual((await view(c, v.flow_id)).state, "HUMAN_APPROVED");
      const c2 = await start(h, "it19");
      const a = await approved(c2);
      c2.world.set({ beneficiaries: [[BEN_ID, "Some other supplier"]] });
      await c2.reopen();
      assert.equal((await c2.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false, "beneficiary re-labelled after approval");
      assert.ok(BEFORE_INTENT.includes((await view(c2, a.flow_id)).state));
      assert.equal(creates(c) + creates(c2), 0);
      hygiene(c);
      hygiene(c2);
    },
  },
  {
    id: "IT-20", title: "forged approval (§16 R11): an authorization planted directly in the store with a random, stolen or wrong-key MAC cannot be submitted; nothing is validated or created",
    run: async (h) => {
      const macs = ["RANDOM", "COPIED_FROM", "OTHER_KEY"] as const;
      for (const [kind, forger] of macs.flatMap((k) => [HUMAN, OTHER_HUMAN].map((f) => [k, f] as const))) {
        const c = await start(h, "it20");
        // a genuine approval of another flow exists in the same store; its MAC is what COPIED_FROM steals
        const genuine = await approved(c);
        const v = await awaiting(c);
        const planted = await c.sys.forgeApproval(v.flow_id, forger, kind === "COPIED_FROM" ? { kind, flow_id: genuine.flow_id } : { kind });
        const f = await view(c, v.flow_id);
        assert.deepEqual([f.state, f.authorization_digest], ["HUMAN_APPROVED", planted], "fixture: the store now holds a self-consistent approval");
        const out = await c.sys.submit(forger, v.flow_id, planted);
        assert.deepEqual([out.ok, out.code], [false, "AUTHORIZATION_NOT_SERVER_ISSUED"], `${kind} MAC planted as ${forger}`);
        assert.deepEqual(journal(c), [lookup(genuine.proposal.provider_request_id)], `${kind}: 0 validate, 0 create, and no lookup for the forged flow: the only entry is the genuine flow's approval lookup`);
        const after = await view(c, v.flow_id);
        assert.ok(BEFORE_INTENT.includes(after.state), `${kind}: no intent recorded (${after.state})`);
        assert.equal(after.attempt_id, null);
        unsettled(after, `forged approval (${kind})`);
        // the same holds after a restart, and read-back has nothing to read
        await c.restart();
        assert.equal((await c.sys.submit(forger, v.flow_id, planted)).ok, false, "still refused after a restart");
        await c.sys.reconcile(HUMAN, v.flow_id);
        assert.deepEqual(journal(c), [lookup(genuine.proposal.provider_request_id)], `${kind}: still nothing but the genuine flow's approval lookup`);
        hygiene(c);
      }
      // control: in the same kind of store, the genuine approval is still accepted, so the refusals are the MAC alone
      const k = await start(h, "it20");
      const genuine = await approved(k);
      const victim = await awaiting(k);
      await k.sys.forgeApproval(victim.flow_id, HUMAN, { kind: "RANDOM" });
      assert.equal((await k.sys.submit(HUMAN, genuine.flow_id, genuine.authorization_digest)).ok, true, "the genuine approval beside a forged one still submits");
      assert.equal(creates(k), 1);
      hygiene(k);
    },
  },
  {
    id: "IT-21", title: "approval key (§16 R11): a server instance with a new key cannot submit an approval issued under the old key; an instance with the same key can",
    run: async (h) => {
      const c = await start(h, "it21");
      const a = await approved(c);
      await c.restart();
      const out = await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest);
      assert.deepEqual([out.ok, out.code], [false, "AUTHORIZATION_NOT_SERVER_ISSUED"]);
      const after = await view(c, a.flow_id);
      assert.deepEqual([after.state, after.attempt_id], ["HUMAN_APPROVED", null]);
      assert.deepEqual(journal(c), [lookup(a.proposal.provider_request_id)], "0 validate, 0 create: the only entry is the approval's request-id lookup");
      // such a flow cannot be re-approved; it can only expire (§16 R11.4)
      assert.equal((await c.sys.approve(HUMAN, a.flow_id, a.proposal_digest, a.gate_digest)).ok, false, "no second approval for a consumed gate");
      c.world.advance(APPROVAL_TTL_MS);
      assert.equal((await c.sys.submit(HUMAN, a.flow_id, a.authorization_digest)).ok, false);
      assert.equal((await view(c, a.flow_id)).state, "EXPIRED");
      assert.deepEqual(journal(c), [lookup(a.proposal.provider_request_id)], "still nothing but the approval's request-id lookup");
      hygiene(c);
      // control: another instance holding the SAME key does accept it, so the refusal above is the key and nothing else
      const k = await start(h, "it21");
      const b = await approved(k);
      await k.reopen();
      assert.equal((await k.sys.submit(HUMAN, b.flow_id, b.authorization_digest)).ok, true);
      assert.equal(creates(k), 1);
      hygiene(k);
    },
  },
];
