// Model-provider configuration for the evidence agent. Server-only.
// The Anthropic key is read from an owner-only file into memory. It is never placed in process.env, so no child
// process (and not the local Ollama server) can inherit it, and it is never logged or returned to a browser.
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export type AiConfig = { provider: "anthropic" | "ollama"; anthropicKey: string | null; claudeModel: string | undefined; ollamaModel: string | undefined; problem: string | null };

export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const out: AiConfig = { provider: env.DRAWBRIDGE_AI_PROVIDER === "ollama" ? "ollama" : "anthropic", anthropicKey: null, claudeModel: env.DRAWBRIDGE_CLAUDE_MODEL, ollamaModel: env.DRAWBRIDGE_AGENT_MODEL, problem: null };
  const path = env.DRAWBRIDGE_ANTHROPIC_ENV_FILE;
  if (!path) return { ...out, problem: "ANTHROPIC_ENV_FILE_NOT_CONFIGURED" };
  if (basename(path) !== ".env.anthropic") return { ...out, problem: "ANTHROPIC_ENV_FILE_NAME" };
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { ...out, problem: "ANTHROPIC_ENV_FILE_MISSING" };
    if (st.mode & 0o077) return { ...out, problem: "ANTHROPIC_ENV_FILE_PERMISSIONS" };
  } catch {
    return { ...out, problem: "ANTHROPIC_ENV_FILE_MISSING" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ...out, problem: "ANTHROPIC_ENV_FILE_UNREADABLE" };
  }
  for (const raw of text.split("\n")) {
    const i = raw.indexOf("=");
    if (i < 1 || raw.trim().startsWith("#")) continue;
    const k = raw.slice(0, i).trim();
    const v = raw.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k === "ANTHROPIC_API_KEY" && v) out.anthropicKey = v;
    else if (k === "DRAWBRIDGE_AI_PROVIDER" && (v === "anthropic" || v === "ollama") && !env.DRAWBRIDGE_AI_PROVIDER) out.provider = v;
    else if (k === "DRAWBRIDGE_CLAUDE_MODEL" && v && !out.claudeModel) out.claudeModel = v;
  }
  if (!out.anthropicKey) out.problem = "ANTHROPIC_API_KEY_MISSING";
  return out;
}
