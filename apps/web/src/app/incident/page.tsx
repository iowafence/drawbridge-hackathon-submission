import { Pill } from "../../components/Figure.tsx";
import { Shell } from "../../components/Shell.tsx";
import { formatMoney, parseMoney } from "../../contract/money.ts";
import { loadScenario } from "../../data/load.ts";
import type { SearchParams } from "../../data/load.ts";
import { CashCrisisIncident } from "../../components/CashCrisisIncident.tsx";
import { CaseBar } from "../../components/Command.tsx";
import {
  AgentFindings,
  BlockedCommitments,
  DecisionHistory,
  IncidentBanner,
  IncidentKpis,
  OperationalEffects,
  ReleaseConditions,
} from "../../components/IncidentRoom.tsx";
import { cashCrisis, selectFundingCase } from "../../data/cashCrisis.ts";

// Incident: the cash shortfall in seconds. Status, trigger and shortfall first; then the stopped commitments with their rules,
// the operational effects, the bounded agent findings and the decision history. The earlier incident detail and the full E3
// evidence sections are unchanged and sit one click away under "Full evidence".
export default async function Incident({ searchParams }: { searchParams: SearchParams }) {
  const { id, snap, d } = await loadScenario(searchParams);
  const fundingCase = selectFundingCase(await searchParams);
  const forecast = cashCrisis.forecasts[fundingCase];
  const decisions = cashCrisis.decisions[id];
  const m = formatMoney;
  const exp = snap.exposures[0];
  const a = parseMoney(exp.amount);
  const pct = (v: string) => (a === 0n ? 0 : Number((parseMoney(v) * 100n) / a));
  const caseRow = snap.cases.find((c) => c.obligationId === exp.obligationId)!;
  const allocCase = snap.cases.find((c) => c.scope === "ALLOCATION");
  return (
    <Shell scenario={id} active="incident" requestedTotal={d.requestedTotal} additionalNotRequestedTotal={d.additionalNotRequestedTotal}>
      <div className="cmd">
        <CaseBar scenario={id} fundingCase={fundingCase} tour={0} screen="incident" />
        <IncidentBanner forecast={forecast} fundingCase={fundingCase} />
        {allocCase ? (
          <section className="card alert-danger" role="alert">
            <h2>
              {allocCase.caseId} <Pill tone="danger">ALLOCATION-WIDE</Pill>
            </h2>
            <p>{allocCase.summary}</p>
            <p>
              Verified returns and settlements may still be recorded as facts. New reservations, approvals, claims and
              sends are refused. Authorized new commitment: {m(d.authorizedNewCommitment)}.
            </p>
          </section>
        ) : null}
        <IncidentKpis forecast={forecast} d={d} />

        <div className="cmd-grid">
          <div className="cmd-main">
            <BlockedCommitments decisions={decisions} />
            <OperationalEffects decisions={decisions} d={d} />

            <section className="panel" aria-labelledby="inc-case-title">
              <div className="panel-head">
                <h2 id="inc-case-title">
                  {caseRow.caseId} <Pill tone="danger">{caseRow.state}</Pill>
                </h2>
                <span className="muted">Unresolved concrete transfer</span>
              </div>
              <div className="panel-body">
                <p>
                  {m(a)} may have left the allocation. DRAWBRIDGE does not know. It will not resend, and it will not call
                  the money back.
                </p>
                <p>{caseRow.summary}</p>
                <div className="bar" role="img" aria-label="Exposure portions">
                  <span className="seg-r" style={{ width: `${pct(exp.r)}%` }} />
                  <span className="seg-d" style={{ width: `${pct(exp.d)}%` }} />
                  <span className="seg-u" style={{ width: `${pct(exp.u)}%` }} />
                  <span className="seg-n" style={{ width: `${pct(exp.nRet) + pct(exp.nRes)}%` }} />
                </div>
                <div className="legend">
                  <span>Reserved {m(parseMoney(exp.r))}</span>
                  <span>Settled {m(parseMoney(exp.d))}</span>
                  <span>Held {m(parseMoney(exp.u))}</span>
                  <span>Returned / resolved {m(parseMoney(exp.nRet) + parseMoney(exp.nRes))}</span>
                </div>
                <p className="eq" style={{ marginTop: 8 }}>
                  R + D + U + N_ret + N_res = A
                  <br />
                  {m(parseMoney(exp.r))} + {m(parseMoney(exp.d))} + {m(parseMoney(exp.u))} + {m(parseMoney(exp.nRet))} +{" "}
                  {m(parseMoney(exp.nRes))} = {m(a)}
                </p>
              </div>
            </section>

            <div className="grid-2">
              <section className="panel" aria-labelledby="inc-known-title">
                <div className="panel-head">
                  <h2 id="inc-known-title">What is known</h2>
                </div>
                <ul className="clean roles">
                  <li>A claim and begin_send were committed (POSSIBLY_SENT) before the network step.</li>
                  <li>The last pre-send check returned OK. A bar or stop after it cannot recall a POST.</li>
                  <li>The provider lookup returned no record.</li>
                </ul>
              </section>
              <section className="panel" aria-labelledby="inc-unknown-title">
                <div className="panel-head">
                  <h2 id="inc-unknown-title">What is not known</h2>
                </div>
                <ul className="clean roles">
                  <li>Whether the transfer was received. A negative lookup never proves non-payment.</li>
                  <li>Whether a late PAID or FAILED will arrive.</li>
                </ul>
              </section>
            </div>
          </div>

          <aside className="cmd-side" aria-label="Agents, history and release conditions">
            <AgentFindings />
            <DecisionHistory />
            <ReleaseConditions />
          </aside>
        </div>

        <details className="evidence">
          <summary>Full evidence: cash impact, obligations, decisions, evidence list and event chain</summary>
          <section className="card">
            <h2>Cash impact</h2>
            <dl className="kv">
              <dt>Requested outflows</dt>
              <dd>{m(d.requestedTotal)}</dd>
              <dt>Allocation cash</dt>
              <dd>{m(d.cash)}</dd>
              <dt>Contingent shortfall</dt>
              <dd style={{ color: "var(--danger)", fontWeight: 700 }}>{m(d.contingentShortfall)}</dd>
            </dl>
            <p className="muted" style={{ marginTop: 8 }}>
              The owner draw of $2,100,000.00 is delayed 12 days and lands in week 5 of the forecast.
            </p>
          </section>
          <CashCrisisIncident scenario={id} fundingCase={fundingCase} />
        </details>
      </div>
    </Shell>
  );
}
