// Claude adapter for the evidence agent. All Anthropic-specific request and response shapes stay in this file.
// Uses the official SDK and the Messages API with client tool use: Claude asks for a tool, the controller validates
// and runs it, and the result goes back as a tool_result block. The API key is passed in by the caller and is never
// read from, or written to, the process environment.
import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_SCHEMA, FACTS_SCHEMA } from "./agent.ts";
import type { ModelProvider, ModelReply, ToolDef, ToolResult } from "./agent.ts";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const CLAUDE_API_URL = "https://api.anthropic.com";
const NO_INPUT = { type: "object" as const, properties: {}, required: [], additionalProperties: false };

/** Names of ANTHROPIC_* variables present in the process environment. The installed SDK reads several of them
 *  (base URL, auth token, custom headers, logging, telemetry). Rather than reason about each, the runtime refuses to
 *  call Claude while any is set, so a stray variable cannot redirect a request or log document contents. */
export function anthropicEnvOverrides(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_") && env[k] !== undefined && env[k] !== "").sort();
}

function failure(e: unknown, ms: number): ModelReply {
  let code = "CLAUDE_UNEXPECTED_ERROR";
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) code = "CLAUDE_AUTH_FAILED";
  else if (e instanceof Anthropic.RateLimitError) code = "CLAUDE_RATE_LIMITED";
  else if (e instanceof Anthropic.NotFoundError) code = "CLAUDE_MODEL_NOT_FOUND";
  else if (e instanceof Anthropic.BadRequestError) code = "CLAUDE_BAD_REQUEST";
  else if (e instanceof Anthropic.APIConnectionTimeoutError) code = "MODEL_TIMEOUT";
  else if (e instanceof Anthropic.APIConnectionError) code = "MODEL_UNAVAILABLE";
  else if (e instanceof Anthropic.APIError) code = "CLAUDE_API_ERROR";
  return { ok: false, ms, code };
}

/** The only Claude model this agent will call. A different configured name is refused, never substituted. */
export const PERMITTED_CLAUDE_MODELS = ["claude-opus-5-5"];

const closedProvider = (model: string, code: string): ModelProvider => ({ provider: "Claude API (Anthropic)", model, start: () => ({ next: async () => ({ ok: false, ms: 0, code }) }) });

export function claudeProvider(apiKey: string, model: string = DEFAULT_CLAUDE_MODEL, client?: Anthropic): ModelProvider {
  if (!PERMITTED_CLAUDE_MODELS.includes(model)) return closedProvider(String(model).replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 60), "CLAUDE_MODEL_NOT_PERMITTED");
  if (!client) {
    // a real client is about to be built: refuse if the environment could redirect it or make the SDK log content
    const overrides = anthropicEnvOverrides();
    if (overrides.length) return closedProvider(model, `ANTHROPIC_ENV_OVERRIDE_PRESENT: ${overrides.join(", ")}`);
    if (!apiKey) return closedProvider(model, "ANTHROPIC_API_KEY_MISSING");
  }
  const name = model;
  const api = client ?? new Anthropic({ apiKey, authToken: null, baseURL: CLAUDE_API_URL, logLevel: "off", maxRetries: 1, timeout: 120_000 }) // host, credential and logging are set explicitly; see anthropicEnvOverrides for the rest;
  return {
    provider: "Claude API (Anthropic)",
    model: name,
    start(system: string, evidence: string, toolDefs: ToolDef[]) {
      const tools: Anthropic.Tool[] = toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        // strict mode on the no-argument tools; the facts tool is validated by the controller instead (a strict facts
        // schema together with the structured final answer exceeds the API's grammar size limit)
        strict: t.input === "none",
        input_schema: (t.input === "none" ? NO_INPUT : FACTS_SCHEMA) as Anthropic.Tool["input_schema"],
      }));
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: `<evidence>\n${evidence}\n</evidence>` }];
      let pending: Anthropic.ToolUseBlock[] = [];
      return {
        async next(toolResult?: ToolResult): Promise<ModelReply> {
          if (toolResult) {
            // every tool_use block of the previous turn gets a result; only the first was executed
            const results: Anthropic.ContentBlockParam[] = pending.map((b, i) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: i === 0 ? toolResult.content : JSON.stringify({ error: "ONE_TOOL_AT_A_TIME" }),
              is_error: i === 0 ? toolResult.isError : true,
            }));
            if (toolResult.final) results.push({ type: "text", text: "No more tool calls are available. Give your final answer now." });
            messages.push({ role: "user", content: results });
          }
          const t0 = Date.now();
          try {
            const res = await api.messages.create({
              model: name,
              max_tokens: 8000, // thinking is always on for this model and shares this budget
              system,
              tools,
              tool_choice: { type: "auto", disable_parallel_tool_use: true }, // one tool request per turn, so each goes through the controller
              messages,
              output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } }, // no thinking parameter: adaptive is the only mode
            });
            const ms = Date.now() - t0;
            if (res.stop_reason === "refusal") return { ok: false, ms, code: "CLAUDE_REFUSED" };
            if (res.stop_reason === "max_tokens") return { ok: false, ms, code: "CLAUDE_OUTPUT_TRUNCATED" };
            messages.push({ role: "assistant", content: res.content });
            pending = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
            const requestId = res._request_id ?? null;
            if (pending.length) return { ok: true, ms, requestId, model: res.model ?? null, toolRequest: { name: pending[0].name, input: pending[0].input }, analysis: null };
            const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
            return { ok: true, ms, requestId, model: res.model ?? null, toolRequest: null, analysis: text };
          } catch (e) {
            return failure(e, Date.now() - t0);
          }
        },
      };
    },
  };
}
