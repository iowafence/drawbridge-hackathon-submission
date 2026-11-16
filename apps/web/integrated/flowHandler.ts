// DRAWBRIDGE integrated flow — the single HTTP entry point for /sandbox/flow/action (contract flow-v1 §12, R8). OWNER: A7.
// Check order mirrors the reviewed src/server/handler.ts: method -> same-origin -> operator auth configured -> flags ->
// session -> CSRF -> known op -> passphrase step-up (approve/reject/submit) -> operation. Only the §12 form fields are
// read. No field is ever treated as a decision, proof, digest source, approval or provider status: digests are echoes
// that the service compares with its own values.
import { authConfigured, cookieToken, getSession, sameCsrf, sameOrigin, verifyPassphrase } from "../src/server/auth.ts";
import { flowRuntime } from "./flowRuntime.ts";
import type { FlowRuntime } from "./flowRuntime.ts";
import { FLOW_ACTION_OPS, STEP_UP_OPS } from "./flowTypes.ts";
import type { FlowActionOp, FlowResult } from "./flowTypes.ts";

export type FlowHandlerDeps = { env?: Record<string, string | undefined>; now?: () => number; runtime?: () => FlowRuntime | string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (status: number, code: string) => new Response(code + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
function redirect(flowId: string | null, code: string): Response {
  const path = flowId && UUID.test(flowId) ? `/sandbox/flow/${flowId}` : "/sandbox/flow";
  return new Response(null, { status: 303, headers: { Location: `${path}?m=${encodeURIComponent(code)}`, "Cache-Control": "no-store" } });
}

export async function handleFlowAction(req: Request, deps: FlowHandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  if (req.method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED");
  if (!sameOrigin(req)) return refuse(403, "CROSS_ORIGIN_REFUSED");
  if (!authConfigured(env)) return refuse(503, "OPERATOR_AUTH_NOT_CONFIGURED");
  const rt = (deps.runtime ?? (() => flowRuntime(env)))();
  if (rt === "INTEGRATED_FLOW_DISABLED") return refuse(404, "NOT_FOUND");
  if (Number(req.headers.get("content-length") ?? "0") > 16_000) return refuse(413, "REQUEST_TOO_LARGE");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "BAD_REQUEST");
  }
  const f = (k: string): string | undefined => {
    const v = form.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const session = getSession(cookieToken(req.headers.get("cookie")), now);
  if (!session) return refuse(401, "NOT_AUTHENTICATED");
  if (!sameCsrf(f("csrf"), session.csrf)) return refuse(403, "CSRF_REFUSED");
  const op = f("op");
  if (!op || !(FLOW_ACTION_OPS as readonly string[]).includes(op)) return refuse(400, "UNKNOWN_OPERATION");
  if (typeof rt === "string") return redirect(null, rt);
  if ((STEP_UP_OPS as readonly string[]).includes(op)) {
    const again = verifyPassphrase(f("passphrase"), env, now);
    if (again !== "OK") return redirect(f("flow_id") ?? null, again === "LOCKED" ? "LOGIN_LOCKED" : "STEP_UP_REFUSED");
  }
  const actor = `human:${session.name}`;
  const svc = rt.service;
  const id = f("flow_id");
  let result: FlowResult & { flow_id?: string };
  try {
    switch (op as FlowActionOp) {
      case "create_flow":
        result = svc.createFlow(actor, f("case_id"));
        return redirect(result.flow_id ?? null, result.code);
      case "attach_evidence": {
        const doc = f("document_id");
        const run = f("run_id");
        if ((doc === undefined) === (run === undefined)) return redirect(id ?? null, "EVIDENCE_SOURCE_REQUIRED");
        result = svc.attachEvidence(actor, id, doc !== undefined ? { kind: "FIXTURE_REPLAY", document_id: doc } : { kind: "AGENT_RUN", run_id: run! });
        break;
      }
      case "evaluate_gate":
        result = await svc.evaluateGate(actor, id);
        break;
      case "request_human_review":
        result = await svc.requestHumanReview(actor, id);
        break;
      case "approve":
        result = await svc.approve(actor, id, f("proposal_digest"), f("gate_digest"));
        break;
      case "reject":
        result = svc.reject(actor, id, f("proposal_digest"));
        break;
      case "submit":
        result = await svc.submit(actor, id, f("authorization_digest"));
        break;
      case "reconcile":
        result = await svc.reconcile(actor, id);
        break;
    }
  } catch {
    return redirect(id ?? null, "INTERNAL_ERROR_NO_ACTION_TAKEN");
  }
  return redirect(id ?? null, result!.code);
}
