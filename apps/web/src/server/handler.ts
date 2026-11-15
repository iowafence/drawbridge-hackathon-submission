// The single server entry point for sandbox actions (form POSTs). Framework-free so it can be tested directly.
// Order of checks: same-origin -> operator auth configured -> (login) | session -> CSRF -> operation.
import { authConfigured, COOKIE, cookieToken, createSession, destroySession, getSession, sameCsrf, sameOrigin, verifyPassphrase } from "./auth.ts";
import { AuditError } from "./audit.ts";
import { createDraft, decide, reconcile, requestReview, submit, validate } from "./transfers.ts";
import type { Ctx, Result } from "./transfers.ts";

export type Deps = { ctx: () => Ctx | string; env?: Record<string, string | undefined>; now?: () => number };

function redirect(code: string, status = 303, setCookie?: string): Response {
  const headers = new Headers({ Location: `/sandbox?m=${encodeURIComponent(code)}`, "Cache-Control": "no-store" });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(null, { status, headers });
}

const refuse = (status: number, code: string) => new Response(code + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function handleAction(req: Request, deps: Deps): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  if (req.method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED");
  if (!sameOrigin(req)) return refuse(403, "CROSS_ORIGIN_REFUSED");
  if (!authConfigured(env)) return refuse(503, "OPERATOR_AUTH_NOT_CONFIGURED");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "BAD_REQUEST");
  }
  const f = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const op = f("op");
  const secure = req.headers.get("x-forwarded-proto") === "https" || req.url.startsWith("https:") ? "; Secure" : "";

  if (op === "login") {
    const r = verifyPassphrase(f("passphrase"), env, now);
    if (r !== "OK") return redirect(r === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_REFUSED");
    const { token } = createSession(env.DRAWBRIDGE_OPERATOR_NAME?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "operator", now);
    return redirect("SIGNED_IN", 303, `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/sandbox; Max-Age=1800${secure}`);
  }

  const token = cookieToken(req.headers.get("cookie"));
  const session = getSession(token, now);
  if (!session) return refuse(401, "NOT_AUTHENTICATED");
  if (!sameCsrf(f("csrf"), session.csrf)) return refuse(403, "CSRF_REFUSED");

  if (op === "logout") {
    destroySession(token);
    return redirect("SIGNED_OUT", 303, `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/sandbox; Max-Age=0${secure}`);
  }

  const ctx = deps.ctx();
  if (typeof ctx === "string") return redirect(ctx);
  const actor = `human:${session.name}`;
  const id = f("id");
  const digest = f("digest");
  let result: Result;
  try {
    switch (op) {
      case "draft":
        result = createDraft(ctx, actor, f("beneficiary_id"));
        break;
      case "review":
        result = requestReview(ctx, actor, id);
        break;
      case "approve":
      case "reject": {
        // step-up: the human decision requires the passphrase again, in this request
        const again = verifyPassphrase(f("passphrase"), env, now);
        if (again !== "OK") return redirect(again === "LOCKED" ? "LOGIN_LOCKED" : "STEP_UP_REFUSED");
        result = await decide(ctx, actor, id, digest, op === "approve");
        break;
      }
      case "validate":
        result = await validate(ctx, actor, id, digest);
        break;
      case "submit": {
        const again = verifyPassphrase(f("passphrase"), env, now);
        if (again !== "OK") return redirect(again === "LOCKED" ? "LOGIN_LOCKED" : "STEP_UP_REFUSED");
        result = await submit(ctx, actor, id, digest);
        break;
      }
      case "reconcile":
        result = await reconcile(ctx, actor, id);
        break;
      default:
        return refuse(400, "UNKNOWN_OPERATION");
    }
  } catch (e) {
    return redirect(e instanceof AuditError ? e.code : "INTERNAL_ERROR_NO_ACTION_TAKEN");
  }
  return redirect(result.code);
}
