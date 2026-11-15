// Live check of the evidence agent against the real model provider and the real sandbox balance read.
// Usage: AWX_READ_ENV_FILE=... DRAWBRIDGE_ANTHROPIC_ENV_FILE=... node scripts/agent-live-check.ts [anthropic|ollama] [extra-evidence.txt ...]
// Runs the registry's example documents plus any extra evidence files. Prints decisions, proofs, tool calls, latency
// and request ids. Never prints a credential.
import { readFileSync } from "node:fs";
import { runAgent } from "../src/server/agent.ts";
import { anthropicEnvOverrides, claudeProvider } from "../src/server/agentClaude.ts";
import { ollamaProvider } from "../src/server/agentOllama.ts";
import { EXAMPLES } from "../src/server/agentRegistry.ts";
import { loadAiConfig } from "../src/server/aiConfig.ts";
import { readBalances, SandboxClient } from "../src/server/awx.ts";

const cfg = loadAiConfig();
const which = process.argv[2] ?? cfg.provider;
if (which !== "anthropic" && which !== "ollama") throw new Error(`unknown provider "${which}": use anthropic or ollama`);
if (which === "anthropic" && anthropicEnvOverrides().length) throw new Error(`ANTHROPIC_ENV_OVERRIDE_PRESENT: ${anthropicEnvOverrides().join(", ")}`);
if (which === "anthropic" && (cfg.problem || !cfg.anthropicKey)) throw new Error(cfg.problem ?? "ANTHROPIC_API_KEY_MISSING");
const model = which === "anthropic" ? claudeProvider(cfg.anthropicKey!, cfg.claudeModel) : ollamaProvider(cfg.ollamaModel);
const read = new SandboxClient("read");
const balanceUsd = async () => { try { const r = await readBalances(read); return r.ok ? (r.rows.find((x) => x.currency === "USD")?.available ?? null) : null; } catch { return null; } };
const cases: [string, string][] = [...EXAMPLES.map((e) => [e.label, e.text] as [string, string]), ...process.argv.slice(3).map((f) => [`FILE ${f.split("/").pop()}`, readFileSync(f, "utf8")] as [string, string])];
for (const [name, text] of cases) {
  const run = await runAgent(text, { model, balanceUsd }, name);
  const e = run.evaluation;
  console.log(`\n===== ${name} | ${run.provider} | ${run.model} | ${run.inferences.map((i) => `${i.ms}ms${i.requestId ? " " + i.requestId : ""}`).join(", ")}`);
  console.log(`GATE   ${e.decision} | ${e.rule} | document ${e.document.document_id ?? "unregistered"} (${e.document.binding})`);
  console.log(`PROOFS ${e.proofs.map((p) => `${p.id}:${p.state}`).join(" ")}`);
  console.log(`MODEL  ${run.modelRecommendation} | ${(run.modelRationale ?? "(withheld)").slice(0, 260)}`);
  for (const t of run.toolCalls) console.log(`  TOOL ${t.permitted ? "ran" : "REFUSED"} ${t.name} -> ${t.result.slice(0, 150)}`);
  for (const s of run.steps.filter((s) => s.kind === "SYSTEM_REFUSED")) console.log(`  REFUSED ${s.title}: ${s.detail.slice(0, 200)}`);
  if (run.claims) {
    const c = run.claims;
    console.log(`  claims: ref=${c.reference?.value}[${c.reference?.grounding}] payee=${c.payee?.value}[${c.payee?.grounding}] cur=${c.currency?.value} amounts=${c.amounts.map((a) => `${a.kind}:${a.value}[${a.grounding === "QUOTED" ? "q" : a.grounding}]`).join(",")}`);
    for (const a of c.adverse) console.log(`  adverse ${a.kind}: ${a.summary.slice(0, 110)}`);
  }
  for (const p of e.proofs.filter((p) => p.state !== "VERIFIED")) console.log(`  ${p.id} ${p.state}: ${p.reason.slice(0, 170)}`);
}
