// A7 HTTP-boundary tests for /sandbox/flow/action (integrated/flowHandler.ts) over the REAL merged lanes, mock provider.
// Proves the governed mocked path end to end through the route handler, and the HTTP refusals (owner directive 7: no
// client-supplied eligibility authority; human approval binds the exact proposal; no bypass).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSession, hashPassphrase, resetAuthForTests } from "../../../src/server/auth.ts";
import { handleFlowAction } from "../../../integrated/flowHandler.ts";
import { buildFlowDeps } from "../../../integrated/flowRuntime.ts";
import type { FlowRuntime } from "../../../integrated/flowRuntime.ts";
import { createFlowService } from "../../../integrated/flowService.ts";
import { readIntegratedFlags } from "../../../integrated/flags.ts";
import { INTEGRATED_REGISTRY } from "../../../integrated/proposalBuilder.ts";
import type { IntegratedFlags } from "../../../integrated/flags.ts";

const PASS = "correct horse battery staple";
const ORIGIN = "http://127.0.0.1:3100";
const docOf = (c: string) => INTEGRATED_REGISTRY.obligations.find((o) => o.case_id === c)!.registered_documents[0].document_id;

function rig() {
  const base = process.env.TMPDIR ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "a7-http-"));
  const env: Record<string, string | undefined> = { DRAWBRIDGE_OPERATOR_SCRYPT: hashPassphrase(PASS), DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_DATA_DIR: join(dir, "data") };
  const flags = readIntegratedFlags(env, "/nonexistent-repo") as IntegratedFlags;
  assert.equal(typeof flags, "object");
  const deps = buildFlowDeps(flags, env, randomBytes(32));
  assert.equal(typeof deps, "object");
  const service = createFlowService(deps as Exclude<typeof deps, string>);
  const runtime: FlowRuntime = { service, flags, surface: { session: () => null, views: () => [], view: () => null } };
  const { token, csrf } = createSession("operator");
  const post = async (fields: Record<string, string>, o: { origin?: string | null; cookie?: string | null; csrf?: string | null; method?: string; rt?: () => FlowRuntime | string } = {}) => {
    const body = new URLSearchParams({ ...(o.csrf === null ? {} : { csrf: o.csrf ?? csrf }), ...fields });
    const headers: Record<string, string> = { host: "127.0.0.1:3100", "content-type": "application/x-www-form-urlencoded" };
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    if (o.cookie !== null) headers.cookie = `db_operator=${o.cookie ?? token}`;
    const req = new Request(`${ORIGIN}/sandbox/flow/action`, { method: o.method ?? "POST", headers, body: (o.method ?? "POST") === "POST" ? body : undefined });
    return handleFlowAction(req, { env, runtime: o.rt ?? (() => runtime) });
  };
  const code = (r: Response) => new URL(r.headers.get("location")!, ORIGIN).searchParams.get("m");
  const flowOf = (r: Response) => new URL(r.headers.get("location")!, ORIGIN).pathname.split("/").pop()!;
  return { post, code, flowOf, service };
}

beforeEach(() => resetAuthForTests());

test("A7-HTTP-01 governed mocked path through the route: create, attach, gate, review, approve (step-up), submit (step-up), read-back", async () => {
  const { post, code, flowOf, service } = rig();
  const c = await post({ op: "create_flow", case_id: "CASE-SBX-0002" });
  assert.equal(c.status, 303);
  const id = flowOf(c);
  assert.equal(code(await post({ op: "attach_evidence", flow_id: id, document_id: docOf("CASE-SBX-0002") })), "EVIDENCE_READY");
  assert.equal(code(await post({ op: "evaluate_gate", flow_id: id })), "GATE_ELIGIBLE");
  assert.equal(code(await post({ op: "request_human_review", flow_id: id })), "AWAITING_HUMAN");
  const v = service.getFlowView(id)!;
  assert.equal(code(await post({ op: "approve", flow_id: id, proposal_digest: v.echo.proposal_digest, gate_digest: v.echo.gate_digest! })), "STEP_UP_REFUSED", "approve without passphrase");
  assert.equal(code(await post({ op: "approve", flow_id: id, proposal_digest: v.echo.proposal_digest, gate_digest: v.echo.gate_digest!, passphrase: PASS })), "HUMAN_APPROVED");
  const a = service.getFlowView(id)!.echo.authorization_digest!;
  assert.equal(code(await post({ op: "submit", flow_id: id, authorization_digest: a })), "STEP_UP_REFUSED", "submit without passphrase");
  assert.equal(code(await post({ op: "submit", flow_id: id, authorization_digest: a, passphrase: PASS })), "SUBMITTED");
  assert.equal(service.getFlow(id)!.state, "SUBMITTED", "accepted create is not a provider state, not paid");
  await post({ op: "reconcile", flow_id: id });
  assert.equal(service.getFlow(id)!.state, "PROVIDER_PROCESSING", "read-back PROCESSING is not paid");
  assert.equal(code(await post({ op: "submit", flow_id: id, authorization_digest: a, passphrase: PASS })) === "SUBMITTED", false, "no second submit");
});

test("A7-HTTP-02 HOLD obligation cannot be approved or submitted through the route, whatever the client sends", async () => {
  const { post, code, flowOf, service } = rig();
  const id = flowOf(await post({ op: "create_flow", case_id: "CASE-PTC-2043" }));
  await post({ op: "attach_evidence", flow_id: id, document_id: docOf("CASE-PTC-2043") });
  assert.equal(code(await post({ op: "evaluate_gate", flow_id: id, decision: "ELIGIBLE_FOR_HUMAN_REVIEW", proof_states: "all VERIFIED" })), "GATE_HOLD", "client decision fields are ignored");
  const v = service.getFlowView(id)!;
  for (const op of ["request_human_review", "approve", "submit"]) {
    const r = await post({ op, flow_id: id, proposal_digest: v.echo.proposal_digest, gate_digest: v.echo.gate_digest ?? "", authorization_digest: "a".repeat(64), passphrase: PASS, state: "HUMAN_APPROVED" });
    assert.notEqual(code(r), "HUMAN_APPROVED");
    assert.notEqual(code(r), "SUBMITTED");
  }
  assert.equal(service.getFlow(id)!.state, "GATE_HOLD");
});

test("A7-HTTP-03 boundary refusals mirror handler.ts: method, origin, auth, session, CSRF, op allowlist, disabled flag", async () => {
  const { post } = rig();
  assert.equal((await post({ op: "create_flow" }, { method: "GET" })).status, 405);
  assert.equal((await post({ op: "create_flow" }, { origin: null })).status, 403);
  assert.equal((await post({ op: "create_flow" }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post({ op: "create_flow" }, { cookie: null })).status, 401);
  assert.equal((await post({ op: "create_flow" }, { cookie: "forged" })).status, 401);
  assert.equal((await post({ op: "create_flow" }, { csrf: null })).status, 403);
  assert.equal((await post({ op: "create_flow" }, { csrf: "wrong" })).status, 403);
  for (const op of ["", "mark_paid", "set_state", "approve_all", "record_provider_read", "expire"]) assert.equal((await post({ op })).status, 400, op);
  assert.equal((await post({ op: "create_flow" }, { rt: () => "INTEGRATED_FLOW_DISABLED" })).status, 404);
});

test("A7-HTTP-04 approval binds the exact shown digests: wrong, swapped or other-flow digests are refused", async () => {
  const { post, code, flowOf, service } = rig();
  const mk = async () => {
    const id = flowOf(await post({ op: "create_flow", case_id: "CASE-SBX-0002" }));
    await post({ op: "attach_evidence", flow_id: id, document_id: docOf("CASE-SBX-0002") });
    await post({ op: "evaluate_gate", flow_id: id });
    await post({ op: "request_human_review", flow_id: id });
    return { id, v: service.getFlowView(id)! };
  };
  const x = await mk();
  const y = await mk();
  for (const [p, g] of [[y.v.echo.proposal_digest, x.v.echo.gate_digest!], [x.v.echo.proposal_digest, y.v.echo.gate_digest!], [x.v.echo.gate_digest!, x.v.echo.proposal_digest], ["0".repeat(64), x.v.echo.gate_digest!]]) {
    const r = await post({ op: "approve", flow_id: x.id, proposal_digest: p, gate_digest: g, passphrase: PASS });
    assert.notEqual(code(r), "HUMAN_APPROVED");
  }
  assert.equal(service.getFlow(x.id)!.state, "AWAITING_HUMAN");
});
