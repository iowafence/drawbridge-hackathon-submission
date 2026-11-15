// Wires the evidence agent to the server: operator session, model provider, read-only balance. Server-only.
// Deliberately imports nothing from the transfer workflow (transfers.ts, handler.ts, runtime.ts).
// The provider is chosen explicitly per run by the operator. There is no automatic switch between providers.
import { randomUUID } from "node:crypto";
import { authConfigured, cookieToken, getSession, sameCsrf, sameOrigin } from "./auth.ts";
import { runAgent } from "./agent.ts";
import type { Deps, ModelProvider, Run } from "./agent.ts";
import { anthropicEnvOverrides, claudeProvider, DEFAULT_CLAUDE_MODEL } from "./agentClaude.ts";
import { DEFAULT_OLLAMA_MODEL, ollamaProvider } from "./agentOllama.ts";
import { loadAiConfig } from "./aiConfig.ts";
import { readBalances, SandboxClient } from "./awx.ts";

type Store = { runs: Map<string, Run>; read?: SandboxClient };
const g = globalThis as unknown as { __drawbridgeAgent?: Store };
const store = (): Store => (g.__drawbridgeAgent ??= { runs: new Map<string, Run>() });

export type ProviderChoice = "anthropic" | "ollama";

export function agentProviders(): { preferred: ProviderChoice; claudeModel: string; ollamaModel: string; claudeProblem: string | null } {
  const cfg = loadAiConfig();
  return { preferred: cfg.provider, claudeModel: cfg.claudeModel ?? DEFAULT_CLAUDE_MODEL, ollamaModel: cfg.ollamaModel ?? DEFAULT_OLLAMA_MODEL, claudeProblem: cfg.problem };
}

function providerFor(choice: unknown): ModelProvider {
  const cfg = loadAiConfig();
  const which: ProviderChoice = choice === "ollama" || choice === "anthropic" ? choice : cfg.provider;
  if (which === "ollama") return ollamaProvider(cfg.ollamaModel);
  const overrides = anthropicEnvOverrides();
  const closed = (code: string): ModelProvider => ({ provider: "Claude API (Anthropic)", model: cfg.claudeModel ?? DEFAULT_CLAUDE_MODEL, start: () => ({ next: async () => ({ ok: false, ms: 0, code }) }) });
  if (overrides.length) return closed(`ANTHROPIC_ENV_OVERRIDE_PRESENT: ${overrides.join(", ")}`);
  if (cfg.anthropicKey) return claudeProvider(cfg.anthropicKey, cfg.claudeModel);
  // Claude is selected but not usable: fail closed with the reason. Never fall back to another provider silently.
  return closed(cfg.problem ?? "ANTHROPIC_NOT_CONFIGURED");
}

/** USD available from the Airwallex sandbox through the READ role only. Null on any failure. */
async function balanceUsd(): Promise<string | null> {
  try {
    const s = store();
    const res = await readBalances((s.read ??= new SandboxClient("read")));
    return res.ok ? (res.rows.find((r) => r.currency === "USD")?.available ?? null) : null;
  } catch {
    return null;
  }
}

export function getRun(id: unknown): Run | null {
  return typeof id === "string" ? (store().runs.get(id) ?? null) : null;
}

const refuse = (status: number, code: string) => new Response(code + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function handleAgentRun(req: Request, deps?: Deps): Promise<Response> {
  if (req.method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED");
  if (!sameOrigin(req)) return refuse(403, "CROSS_ORIGIN_REFUSED");
  if (!authConfigured()) return refuse(503, "OPERATOR_AUTH_NOT_CONFIGURED");
  const session = getSession(cookieToken(req.headers.get("cookie")));
  if (!session) return refuse(401, "NOT_AUTHENTICATED");
  if (Number(req.headers.get("content-length") ?? "0") > 64_000) return refuse(413, "REQUEST_TOO_LARGE");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "BAD_REQUEST");
  }
  if (!sameCsrf(form.get("csrf"), session.csrf)) return refuse(403, "CSRF_REFUSED");
  const id = randomUUID();
  const run = await runAgent(form.get("evidence"), deps ?? { model: providerFor(form.get("provider")), balanceUsd }, id);
  const runs = store().runs;
  runs.set(id, run);
  while (runs.size > 30) runs.delete(runs.keys().next().value!);
  return new Response(null, { status: 303, headers: { Location: `/sandbox/agent?run=${id}`, "Cache-Control": "no-store" } });
}
