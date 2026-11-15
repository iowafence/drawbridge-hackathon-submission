// Airwallex SANDBOX integration screen. Separate from the six synthetic Incident Room screens:
// nothing here feeds the E3 scenario, and no E3 figure is shown or changed here.
// Server component only. Provider data is fetched on the server after the operator session is verified.
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { authConfigured, COOKIE, getSession } from "../../server/auth.ts";
import { AuditError } from "../../server/audit.ts";
import type { AuditEvent } from "../../server/audit.ts";
import { AWX_ORIGIN } from "../../server/awx.ts";
import { DEMO_CAP_MINOR, evaluate, fromMinor, PROPOSAL } from "../../server/policy.ts";
import { liveBalances, runtimeCtx, transferCredentialStatus, usdAvailable } from "../../server/runtime.ts";
import { listTransfers } from "../../server/transfers.ts";
import type { Transfer } from "../../server/transfers.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "DRAWBRIDGE · Airwallex sandbox (test data)" };

const FLOW = ["DRAFT", "REVIEW_REQUIRED", "HUMAN_APPROVED", "VALIDATED", "SUBMITTED_TO_AIRWALLEX", "PROVIDER_STATUS_RECONCILED"];
const cell = { padding: "6px 10px", borderBottom: "1px solid var(--border)", textAlign: "left" as const, verticalAlign: "top" as const };
const mono = { fontFamily: "ui-monospace, monospace", fontSize: "0.8rem", wordBreak: "break-all" as const };
const btn = { padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-2)", font: "inherit", cursor: "pointer" };
const field = { padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, font: "inherit" };

function Frame({ children }: { children: ReactNode }) {
  return (
    <>
      <header>
        <div className="synthetic-bar" role="note">
          <div className="wrap">AIRWALLEX SANDBOX · NOT PROJECT CASH · SANDBOX / TEST DATA. No production endpoint. No real money.</div>
        </div>
      </header>
      <main id="main-content" className="wrap" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <p className="muted"><a href="/overview?s=S0">← Incident Room (synthetic E3 scenario, unchanged)</a></p>
        <h1>Airwallex sandbox integration</h1>
        <p className="muted">
          Live reads from <code>{AWX_ORIGIN}</code> through a server-only adapter. These figures are sandbox test balances. They are
          not project cash and are never used in the E3 funding-gap scenario, whose ready-to-send amount stays $0.00.
        </p>
        <section className="card" aria-labelledby="h-cmp">
          <h2 id="h-cmp">Two separate demonstrations</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th scope="col" style={cell}></th><th scope="col" style={cell}>Incident Room (E3 scenario)</th><th scope="col" style={cell}>Airwallex sandbox (this screen)</th></tr></thead>
            <tbody>
              <tr><th scope="row" style={cell}>Data</th><td style={cell}>Synthetic fixtures only</td><td style={cell}>Live Airwallex sandbox test data</td></tr>
              <tr><th scope="row" style={cell}>Decision</th><td style={cell}>Funding controls block disbursement. Ready to send: $0.00</td><td style={cell}>A separate 5.00 USD proposal is checked against a reserve policy on the sandbox balance</td></tr>
              <tr><th scope="row" style={cell}>Human step</th><td style={cell}>Approval controls are disabled by design</td><td style={cell}>An authenticated operator must approve the exact request</td></tr>
              <tr><th scope="row" style={cell}>Provider</th><td style={cell}>None. No bank connection</td><td style={cell}>Airwallex validates, creates at most one sandbox transfer, and reports its status</td></tr>
            </tbody>
          </table>
          <p className="muted">
            The two do not share data, balances or a decision engine. Nothing on this screen pays an E3 obligation, and no E3 figure depends
            on a sandbox balance. <a href="/overview?s=S0">Open the Incident Room</a>.
          </p>
        </section>
        {children}
      </main>
    </>
  );
}

function Act(props: { op: string; csrf: string; t?: Transfer; label: string; stepUp?: boolean; disabled?: boolean }) {
  return (
    <form method="post" action="/sandbox/action" style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 8px 4px 0", flexWrap: "wrap" }}>
      <input type="hidden" name="op" value={props.op} />
      <input type="hidden" name="csrf" value={props.csrf} />
      {props.t ? <input type="hidden" name="id" value={props.t.request_id} /> : null}
      {props.t ? <input type="hidden" name="digest" value={props.t.digest} /> : null}
      {props.stepUp ? <input type="password" name="passphrase" required autoComplete="off" aria-label={`Operator passphrase to ${props.label}`} placeholder="passphrase" style={field} /> : null}
      <button type="submit" disabled={props.disabled} style={btn}>{props.label}</button>
    </form>
  );
}

export default async function SandboxPage({ searchParams }: { searchParams: Promise<{ m?: string | string[] }> }) {
  const rawMessage = (await searchParams).m;
  const message = typeof rawMessage === "string" && /^[A-Z][A-Z0-9_]{2,60}( P-\d [A-Z_]{3,40})?$/.test(rawMessage) ? rawMessage : null;
  const note = message ? <p className="card" role="status">Result code of the last action: <code>{message}</code>. This line comes from the page address; the record is the audit trail below.</p> : null;

  if (!authConfigured()) {
    return (
      <Frame>
        <section className="card alert-warn">
          <h2>Disabled</h2>
          <p>Operator authentication is not configured on this server, so no sandbox data is read or shown and no action is available.</p>
        </section>
      </Frame>
    );
  }
  const session = getSession((await cookies()).get(COOKIE)?.value);
  if (!session) {
    return (
      <Frame>
        {note}
        <section className="card">
          <h2>Operator sign-in required</h2>
          <p className="muted">Sandbox data is only read for an authenticated operator. There is no public endpoint.</p>
          <form method="post" action="/sandbox/action" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input type="hidden" name="op" value="login" />
            <input type="password" name="passphrase" required autoComplete="current-password" aria-label="Operator passphrase" placeholder="operator passphrase" style={field} />
            <button type="submit" style={btn}>Sign in</button>
          </form>
        </section>
      </Frame>
    );
  }

  const balances = await liveBalances();
  const available = usdAvailable(balances);
  const decision = evaluate(available);
  const ctx = runtimeCtx();
  let transfers: Transfer[] = [];
  let events: AuditEvent[] = [];
  let workflowProblem: string | null = typeof ctx === "string" ? ctx : null;
  if (typeof ctx !== "string") {
    try {
      ({ transfers, events } = listTransfers(ctx));
    } catch (e) {
      workflowProblem = e instanceof AuditError ? e.code : "AUDIT_UNREADABLE";
    }
  }
  const allowlist = typeof ctx === "string" ? new Map<string, string>() : ctx.allowlist;
  const credential = transferCredentialStatus();
  const released = typeof ctx !== "string" && !!ctx.release;
  const nonZero = balances.ok ? balances.rows.filter((r) => /[1-9]/.test(r.total) || r.currency === "USD") : [];

  return (
    <Frame>
      {note}
      <p className="muted">Signed in as <b>{session.name}</b>. <Act op="logout" csrf={session.csrf} label="Sign out" /></p>

      <section className="card wallet" aria-labelledby="h-bal">
        <h2 id="h-bal">1. Live sandbox balances <span className="pill synthetic">AIRWALLEX SANDBOX</span> <span className="pill warn">NOT PROJECT CASH</span></h2>
        {balances.ok ? (
          <>
            <p className="muted">
              <code>GET /api/v1/balances/current</code> · HTTP {balances.httpStatus} · read at {balances.fetchedAt} · {balances.rows.length} currency
              entries returned; showing USD and every currency with a non-zero total.
            </p>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Currency", "Available", "Pending", "Reserved", "Total"].map((h) => <th key={h} scope="col" style={cell}>{h}</th>)}</tr></thead>
              <tbody>
                {nonZero.map((r) => (
                  <tr key={r.currency}><th scope="row" style={cell}>{r.currency}</th><td style={cell}>{r.available}</td><td style={cell}>{r.pending}</td><td style={cell}>{r.reserved}</td><td style={cell}>{r.total}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="muted">Amounts are the provider's own decimal text, unmodified. Sandbox test data.</p>
          </>
        ) : (
          <p><span className="pill danger">READ FAILED</span> No balance is shown. Code <code>{balances.code}</code>{balances.httpStatus ? ` (HTTP ${balances.httpStatus})` : ""}. Nothing is substituted.</p>
        )}
      </section>

      <section className={`card ${decision.recommendation === "ALLOW" ? "alert-ok" : "alert-warn"}`} aria-labelledby="h-pol">
        <h2 id="h-pol">2. Policy decision on one synthetic proposal <span className={`pill ${decision.recommendation === "ALLOW" ? "ok" : "warn"}`}>{decision.recommendation}</span></h2>
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr><th scope="row" style={cell}>Proposal</th><td style={cell}>{PROPOSAL.proposal_id} · {PROPOSAL.description} · reference {PROPOSAL.reference}</td></tr>
            <tr><th scope="row" style={cell}>Available sandbox funds (USD)</th><td style={cell}>{decision.availableMinor === null ? (available ?? "not read") : fromMinor(decision.availableMinor)}</td></tr>
            <tr><th scope="row" style={cell}>Proposed amount (USD)</th><td style={cell}>{decision.amountMinor === null ? PROPOSAL.amount : fromMinor(decision.amountMinor)}</td></tr>
            <tr><th scope="row" style={cell}>Reserve threshold (USD)</th><td style={cell}>{fromMinor(decision.reserveMinor)}</td></tr>
            <tr><th scope="row" style={cell}>Demo cap (USD)</th><td style={cell}>{fromMinor(DEMO_CAP_MINOR)}</td></tr>
            <tr><th scope="row" style={cell}>Rule</th><td style={cell}><code>{decision.rule}</code></td></tr>
            <tr><th scope="row" style={cell}>Reason</th><td style={cell}>{decision.reason}</td></tr>
            <tr><th scope="row" style={cell}>Human approval</th><td style={cell}>Required. {decision.recommendation} is a recommendation from deterministic code; it authorizes nothing.</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="h-xfer">
        <h2 id="h-xfer">3. Human-approved sandbox transfer</h2>
        <p className="muted">
          Transfer credential: <code>{credential}</code> · allowlisted test beneficiaries: {allowlist.size} · owner release for a create request:{" "}
          <b>{released ? "set for one exact transaction" : "not set (no create request can be sent)"}</b>
        </p>
        {workflowProblem ? (
          <p><span className="pill danger">WORKFLOW DISABLED</span> <code>{workflowProblem}</code></p>
        ) : (
          <>
            {allowlist.size === 0 ? (
              <p><span className="pill warn">NO TEST BENEFICIARY</span> The owner has not allowlisted a sandbox test beneficiary, so no draft can be created.</p>
            ) : (
              <form method="post" action="/sandbox/action" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input type="hidden" name="op" value="draft" />
                <input type="hidden" name="csrf" value={session.csrf} />
                <label>Test beneficiary{" "}
                  <select name="beneficiary_id" style={field}>{[...allowlist].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
                </label>
                <button type="submit" style={btn}>Draft {PROPOSAL.amount} {PROPOSAL.currency} from proposal {PROPOSAL.proposal_id}</button>
              </form>
            )}
            {transfers.map((t) => (
              <article key={t.request_id} className="card" style={{ marginTop: 12 }}>
                <h3>{fromMinor(BigInt(t.amount_minor))} {t.currency} to {t.beneficiary_label} <span className="pill">{t.state}</span></h3>
                <p className="muted">{FLOW.map((s) => (s === t.state ? `[${s}]` : s)).join(" → ")}</p>
                <p style={mono}>request_id {t.request_id}<br />approval digest {t.digest}<br />reference {t.reference} · method {t.transfer_method} · reason {t.reason}</p>
                <p>
                  Provider transfer ID: <b style={mono}>{t.provider_transfer_id ?? "none (nothing created at Airwallex)"}</b><br />
                  Provider status: <b>{t.provider_status ?? "none"}</b>{t.provider_status_at ? ` (as reported at ${t.provider_status_at})` : ""}
                  {t.provider_status && t.provider_status !== "PAID" ? " · not paid" : ""}
                  {t.last_code ? <><br />Last result: <code>{t.last_code}</code></> : null}
                </p>
                {t.state === "DRAFT" ? <Act op="review" csrf={session.csrf} t={t} label="Request human review" /> : null}
                {t.state === "REVIEW_REQUIRED" ? <><Act op="approve" csrf={session.csrf} t={t} label="Approve exactly this request" stepUp /><Act op="reject" csrf={session.csrf} t={t} label="Reject" stepUp /></> : null}
                {t.state === "HUMAN_APPROVED" ? <Act op="validate" csrf={session.csrf} t={t} label="Validate with Airwallex (creates nothing)" /> : null}
                {t.state === "VALIDATED" ? <Act op="submit" csrf={session.csrf} t={t} label="Submit one sandbox transfer" stepUp disabled={!released} /> : null}
                {["SUBMITTING", "SUBMITTED_TO_AIRWALLEX", "PROVIDER_STATUS_RECONCILED", "OUTCOME_UNKNOWN"].includes(t.state) ? <Act op="reconcile" csrf={session.csrf} t={t} label="Read provider status" /> : null}
              </article>
            ))}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="h-aud">
        <h2 id="h-aud">4. Integration audit trail <span className="pill">{events.length} events</span></h2>
        <p className="muted">
          A new, separate hash-chained log for this sandbox integration, stored in a local file. It is not the six synthetic E3 recorder
          events and not the G2C1 ledger chain. It is not externally anchored. No credential, token or bank detail is recorded.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["#", "Time (UTC)", "Event", "Actor", "Detail", "Hash"].map((h) => <th key={h} scope="col" style={cell}>{h}</th>)}</tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq}>
                  <td style={cell}>{e.seq}</td><td style={cell}>{e.ts}</td><td style={cell}>{e.type}</td><td style={cell}>{e.actor}</td>
                  <td style={{ ...cell, ...mono }}>{Object.entries(e.data).filter(([k]) => !["digest", "beneficiary_id"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" · ")}</td>
                  <td style={{ ...cell, ...mono }}>{e.hash.slice(0, 16)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Frame>
  );
}
