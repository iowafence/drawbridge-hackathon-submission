// DRAWBRIDGE — Evidence Analysis Agent. Server component. A model analyses synthetic evidence, may call read-only
// tools, and recommends. A positive-proof gate decides from trusted records. Nothing on this page can create or
// approve a payment.
import { cookies } from "next/headers";
import { authConfigured, COOKIE, getSession } from "../../../server/auth.ts";
import { MAX_EVIDENCE, MAX_TOOL_REQUESTS, TOOLS } from "../../../server/agent.ts";
import type { Step } from "../../../server/agent.ts";
import type { ProofState } from "../../../server/agentPolicy.ts";
import { EXAMPLES } from "../../../server/agentRegistry.ts";
import { agentProviders, getRun } from "../../../server/agentRuntime.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "DRAWBRIDGE — Evidence Analysis Agent" };

const KIND: Record<Step["kind"], { label: string; cls: string }> = {
  INPUT: { label: "INPUT", cls: "" },
  MODEL: { label: "LIVE MODEL", cls: "synthetic" },
  AI_EXTRACTED: { label: "AI EXTRACTED", cls: "synthetic" },
  AI_RECOMMENDED: { label: "AI RECOMMENDED", cls: "synthetic" },
  SYSTEM_VERIFIED: { label: "SYSTEM VERIFIED", cls: "ok" },
  SYSTEM_REFUSED: { label: "SYSTEM REFUSED", cls: "danger" },
  TOOL: { label: "READ-ONLY TOOL", cls: "ok" },
  POLICY: { label: "POLICY GATE", cls: "warn" },
};
const STATE: Record<ProofState, string> = { VERIFIED: "ok", MISSING: "danger", CONTRADICTED: "danger", UNTRUSTED: "warn", UNKNOWN: "warn" };
const cell = { padding: "6px 10px", borderBottom: "1px solid var(--border)", textAlign: "left" as const, verticalAlign: "top" as const };
const btn = { padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-2)", font: "inherit", cursor: "pointer" };
const pre = { whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, fontFamily: "ui-monospace, monospace", fontSize: "0.8rem", margin: 0 };

export default async function AgentPage({ searchParams }: { searchParams: Promise<{ run?: string | string[]; ex?: string | string[] }> }) {
  const sp = await searchParams;
  const session = authConfigured() ? getSession((await cookies()).get(COOKIE)?.value) : null;
  const run = session ? getRun(sp.run) : null;
  const example = typeof sp.ex === "string" ? EXAMPLES.find((e) => e.key === sp.ex) : undefined;
  const text = run?.evidence ?? example?.text ?? EXAMPLES[0].text;
  const providers = session ? agentProviders() : null;
  const usedClaude = !!run && run.provider.startsWith("Claude API") && run.inferences.some((i) => i.ok);
  const ev = run?.evaluation;
  const decisionCls = ev ? (ev.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? "alert-ok" : ev.decision === "HOLD" ? "alert-danger" : "alert-warn") : "";
  const claims = run?.claims;
  const claimRows = claims ? [
    ...(claims.reference ? [{ field: "reference", ...claims.reference }] : []),
    ...(claims.payee ? [{ field: "payee", ...claims.payee }] : []),
    ...(claims.currency ? [{ field: "currency", ...claims.currency }] : []),
    ...claims.amounts.map((a) => ({ field: `amount: ${a.kind}`, ...a })),
  ] : [];
  return (
    <>
      <header>
        <div className="synthetic-bar" role="note">
          <div className="wrap">SYNTHETIC EVIDENCE AND SYNTHETIC REGISTRY · THE AI MODEL HAS NO FINANCIAL AUTHORITY. This page cannot create, approve or send a payment.</div>
        </div>
      </header>
      <main id="main-content" className="wrap" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <p className="muted"><a href="/sandbox">← Airwallex sandbox</a> · <a href="/overview?s=S0">Incident Room (synthetic E3 scenario, unchanged)</a></p>
        <h1>DRAWBRIDGE — Evidence Analysis Agent</h1>
        <p className="muted">
          A language model reads the evidence, may ask for up to {MAX_TOOL_REQUESTS} read-only tools ({TOOLS.map((t) => t.name).join(", ")}), extracts typed claims and
          recommends. What the document or the model says is never proof. A deterministic gate decides, and it can be satisfied only by trusted
          records: a registered source document, an approval record that matches the payee and amount exactly, a document manifest and a dispute
          register. <b>Available money is not authority to spend money.</b>
        </p>
        {usedClaude ? <p><span className="pill synthetic">Powered by Claude API</span> <span className="pill">Financial rails: Airwallex Sandbox</span></p> : null}
        {!session ? (
          <section className="card alert-warn"><h2>Operator sign-in required</h2><p>Sign in on the <a href="/sandbox">sandbox page</a> first. No model is run for an unauthenticated request.</p></section>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, alignItems: "start" }}>
            <section className="card" aria-labelledby="h-in">
              <h2 id="h-in">Synthetic evidence</h2>
              <p className="muted">Load: {EXAMPLES.map((e) => <a key={e.key} href={`/sandbox/agent?ex=${e.key}`} style={{ marginRight: 12, display: "inline-block" }}>{e.label}</a>)} or type your own.</p>
              <form method="post" action="/sandbox/agent/run">
                <input type="hidden" name="csrf" value={session.csrf} />
                <p><label>Model provider{" "}
                  <select name="provider" defaultValue={providers!.preferred} style={{ padding: "6px 8px" }}>
                    <option value="anthropic">Claude API ({providers!.claudeModel}){providers!.claudeProblem ? " - not configured" : ""}</option>
                    <option value="ollama">Local Ollama fallback ({providers!.ollamaModel})</option>
                  </select></label> <span className="muted">Chosen per run. The agent never switches provider by itself.</span></p>
                <textarea name="evidence" defaultValue={text} rows={16} maxLength={MAX_EVIDENCE} required aria-label="Synthetic evidence text" style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "0.85rem", padding: 8 }} />
                <p><button type="submit" style={btn}>Run the agent on this evidence</button></p>
              </form>
              <p className="muted">
                Synthetic test documents only, up to {MAX_EVIDENCE} characters (longer text is refused whole). The text is untrusted data. Any change to a
                registered document, even one word, makes it a new unregistered document that cannot be eligible. The registry is synthetic fixture data, not a real
                approval system.
              </p>
            </section>
            <section aria-labelledby="h-out">
              {!run || !ev ? (
                <div className="card"><h2 id="h-out">Agent execution</h2><p className="muted">No run yet. Submit evidence to see the live model call, tool use, excerpt checks and the proof gate.</p></div>
              ) : (
                <>
                  <div className={`card ${decisionCls}`}>
                    <h2 id="h-out">Decision: {ev.decision.replace(/_/g, " ")}</h2>
                    <p><span className="pill warn">SYSTEM POLICY DECISION</span> <code>{ev.rule}</code></p>
                    <p>{ev.reason}</p>
                    <p><span className="pill synthetic">AI RECOMMENDATION</span> {run.modelRecommendation ?? "no valid recommendation"}{run.modelRationale ? `: ${run.modelRationale}` : ""}</p>
                    {run.modelLimitations ? <p className="muted">Model-stated limitations: {run.modelLimitations}</p> : null}
                    <p><span className="pill">HUMAN AUTHORIZATION</span> Required and not given here. This page cannot approve anything.</p>
                    <p><span className="pill">AIRWALLEX PROVIDER STATUS</span> None. No payment was created by this analysis. The payment workflow is separate and unchanged.</p>
                  </div>
                  <div className="card" style={{ overflowX: "auto" }}>
                    <h3>Required proofs</h3>
                    <p className="muted">Only VERIFIED satisfies a requirement, and only a trusted source can verify. Document {ev.document.document_id ?? "not registered"} · case {ev.document.case_id ?? "none"} · binding {ev.document.binding.replace(/_/g, " ")}</p>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead><tr>{["", "Requirement", "State", "Trusted source and evidence", "Document claims", "Reason"].map((h) => <th key={h} scope="col" style={cell}>{h}</th>)}</tr></thead>
                      <tbody>
                        {ev.proofs.map((p) => (
                          <tr key={p.id}><th scope="row" style={cell}>{p.id}</th><td style={cell}>{p.requirement}</td>
                            <td style={cell}><span className={`pill ${STATE[p.state]}`}>{p.state}</span></td>
                            <td style={{ ...cell, ...pre }}>{p.source_type.replace(/_/g, " ")}{p.source_id ? `\n${p.source_id}` : ""}{p.evidence ? `\n${p.evidence}` : ""}</td>
                            <td style={{ ...cell, ...pre }}>{p.claimed ?? "none"}</td><td style={cell}>{p.reason}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="card">
                    <h3>Runtime</h3>
                    <p style={pre}>
                      provider: {run.provider}{"\n"}
                      model: {run.model}{"\n"}
                      inferences: {run.inferences.length} · {run.inferences.map((i) => `${i.ms} ms ${i.ok ? "ok" : "FAILED"}${i.requestId ? ` (${i.requestId})` : ""}`).join(", ")}{"\n"}
                      tool requests: {run.toolCalls.length ? run.toolCalls.map((t) => `${t.name} (${t.permitted ? "permitted" : "REFUSED"})`).join(", ") : "none"}{"\n"}
                      run {run.id} at {run.at}
                    </p>
                  </div>
                  <div className="card">
                    <h3>Execution sequence</h3>
                    <ol style={{ paddingLeft: 18 }}>
                      {run.steps.map((s, i) => (
                        <li key={i} style={{ marginBottom: 8 }}><span className={`pill ${KIND[s.kind].cls}`}>{KIND[s.kind].label}</span> <b>{s.title}</b><br /><span style={pre}>{s.detail}</span></li>
                      ))}
                    </ol>
                  </div>
                  <div className="card" style={{ overflowX: "auto" }}>
                    <h3>What the model read in the document (untrusted)</h3>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead><tr>{["Field", "AI extracted", "Excerpt and position", "Excerpt check"].map((h) => <th key={h} scope="col" style={cell}>{h}</th>)}</tr></thead>
                      <tbody>
                        {claimRows.map((c, i) => (
                          <tr key={i}><td style={cell}>{c.field}</td><td style={cell}>{c.value}</td><td style={{ ...cell, ...pre }}>{c.quote ?? "none"}{c.start !== null ? `\n[chars ${c.start}-${c.end}]` : ""}</td>
                            <td style={cell}><span className={`pill ${c.grounding === "QUOTED" ? "" : "danger"}`}>{c.grounding === "QUOTED" ? "EXCERPT FOUND, NOT PROOF" : c.grounding.replace(/_/g, " ")}</span></td></tr>
                        ))}
                        {(claims?.adverse ?? []).map((a, i) => (
                          <tr key={`a${i}`}><td style={cell}>adverse: {a.kind.replace(/_/g, " ")}</td><td style={cell}>{a.summary}</td><td style={{ ...cell, ...pre }}>{a.quote ?? "none"}</td>
                            <td style={cell}><span className="pill warn">BLOCKS ELIGIBILITY</span></td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
