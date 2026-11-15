// Local Ollama adapter for the evidence agent (optional fallback, selected explicitly by the operator).
// All Ollama-specific shapes stay in this file. It talks only to 127.0.0.1 and never receives any API key.
// Ollama has no native tool protocol here: the model asks for a tool through a "tool_request" field in its JSON reply,
// and this adapter translates that into the controller's provider-neutral tool request.
import { ANALYSIS_SCHEMA } from "./agent.ts";
import type { ModelProvider, ModelReply, ToolDef, ToolResult } from "./agent.ts";

export const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

export function ollamaProvider(model: string = DEFAULT_OLLAMA_MODEL, fetchImpl: typeof fetch = fetch, timeoutMs = 45_000): ModelProvider {
  if (!/^[a-z0-9._:-]{1,60}$/.test(model)) {
    // an invalid configured name is refused, never replaced by another model
    return { provider: "local Ollama (127.0.0.1)", model: "invalid", start: () => ({ next: async () => ({ ok: false, ms: 0, code: "OLLAMA_MODEL_NAME_INVALID" }) }) };
  }
  const name = model;
  return {
    provider: "local Ollama (127.0.0.1)",
    model: name,
    start(system: string, evidence: string, tools: ToolDef[]) {
      const format = {
        ...ANALYSIS_SCHEMA,
        properties: { ...ANALYSIS_SCHEMA.properties, tool_request: { type: ["object", "null"], properties: { name: { type: "string" } }, required: ["name"] } },
        required: [...ANALYSIS_SCHEMA.required, "tool_request"],
      };
      const toolText = `\n\nTools are requested through the JSON field "tool_request": {"name": "<tool name>"} or null. Available tools: ${tools.map((t) => `"${t.name}" (${t.description})`).join("; ")}. For "evaluate_payment_eligibility" the facts in the same JSON object are used as its input. When tool_request is null your JSON is the final answer.`;
      const messages = [{ role: "system", content: system + toolText }, { role: "user", content: `<evidence>\n${evidence}\n</evidence>` }];
      return {
        async next(toolResult?: ToolResult): Promise<ModelReply> {
          if (toolResult) messages.push({ role: "user", content: `Tool result for "${toolResult.name}": ${toolResult.content}\nReply again with the same JSON object.${toolResult.final ? " No more tools are available: set tool_request to null and give your final answer." : ""}` });
          const t0 = Date.now();
          try {
            const res = await fetchImpl(OLLAMA_URL, {
              method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
              body: JSON.stringify({ model: name, stream: false, format, options: { temperature: 0, num_predict: 1200 }, messages }),
            });
            const ms = Date.now() - t0;
            if (res.status !== 200) return { ok: false, ms, code: res.status === 404 ? "MODEL_NOT_FOUND" : "MODEL_HTTP_ERROR" };
            const content = ((await res.json()) as { message?: { content?: unknown } })?.message?.content;
            if (typeof content !== "string") return { ok: false, ms, code: "MODEL_EMPTY_RESPONSE" };
            messages.push({ role: "assistant", content });
            let obj: { tool_request?: { name?: unknown } | null } | null = null;
            try {
              obj = JSON.parse(content);
            } catch {
              return { ok: false, ms, code: "MODEL_OUTPUT_NOT_JSON" };
            }
            const tr = obj && typeof obj === "object" ? obj.tool_request : null;
            if (tr && typeof tr === "object" && typeof tr.name === "string") {
              const facts = tr.name === "evaluate_payment_eligibility" ? obj : {};
              return { ok: true, ms, requestId: null, model: name, toolRequest: { name: tr.name, input: facts }, analysis: null };
            }
            return { ok: true, ms, requestId: null, model: name, toolRequest: null, analysis: content };
          } catch (e) {
            const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
            return { ok: false, ms: Date.now() - t0, code: timeout ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE" };
          }
        },
      };
    },
  };
}
