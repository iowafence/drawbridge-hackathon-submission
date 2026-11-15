// Incident screen building blocks (ERP redesign). Server components only: no script, no control, no recomputation.
// Every figure and sentence is read from the derived scenario state or the committed E3 evidence snapshot.
import { Pill } from "./Figure.tsx";
import { formatMoney } from "../contract/money.ts";
import type { Derived } from "../contract/derive.ts";
import { cashCrisis } from "../data/cashCrisis.ts";
import type { CashCrisisDecision, CashCrisisForecastView, FundingCase } from "../data/cashCrisis.ts";

const m = formatMoney;
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-8)}`;
const tone = (status: string): "danger" | "warn" | "ok" => (status === "BLOCKED" ? "danger" : status === "UNRESOLVED" ? "warn" : "ok");

/** Incident status first: what happened, what it triggered, how big the shortfall is. */
export function IncidentBanner(props: { forecast: CashCrisisForecastView; fundingCase: FundingCase }) {
  const { forecast, fundingCase } = props;
  const { draw } = cashCrisis;
  const gap = forecast.peakFundingGap > 0n;
  return (
    <section className={`answer ${gap ? "answer-gap" : "answer-ok"}`} aria-label="Incident status" data-incident-status={fundingCase}>
      <div className="answer-head">
        <span className={`answer-tag ${gap ? "gap" : "ok"}`}>{gap ? "OPEN INCIDENT" : "NOT TRIGGERED"}</span>
        <h2>
          {gap
            ? `Week-two funding shortfall of ${m(forecast.peakFundingGap)}`
            : "No funding shortfall when the owner draw arrives on time"}
        </h2>
      </div>
      <p>
        <strong>Trigger:</strong> the {m(draw.amount)} owner draw scheduled for {draw.onTimeDate}{" "}
        {gap ? `arrives ${draw.delayedDate}, ${draw.delayDays} days late` : "arrives on schedule"}.{" "}
        {gap
          ? `Projected cash closes below zero in ${forecast.negativeWeekCount} of 13 weeks and is lowest in week ${forecast.worstWeek}.`
          : `The lowest weekly closing is ${m(forecast.minimumClosing)} in week ${forecast.worstWeek}.`}{" "}
        Either way, the three immediate requests stay stopped by their own evidence. This is a synthetic projection.
      </p>
    </section>
  );
}

export function IncidentKpis(props: { forecast: CashCrisisForecastView; d: Derived }) {
  const { forecast, d } = props;
  const cells: { label: string; value: string; note: string; tone?: string }[] = [
    { label: "Peak funding shortfall", value: m(forecast.peakFundingGap), note: `Projection, week ${forecast.worstWeek} of the E3 calendar.`, tone: forecast.peakFundingGap > 0n ? "neg" : "ok" },
    { label: "Requests stopped", value: m(d.requestedTotal), note: "Immediate requests, none authorized." },
    { label: "Held, unresolved", value: m(d.unc), note: "Concrete transfer, outcome unknown.", tone: "warn" },
    { label: "Ready to send now", value: m(d.dispatchableNowTotal), note: "Approved, eligible, reserved amounts only." },
  ];
  return (
    <section className="panel" aria-label="Incident figures">
      <div className="kpis">
        {cells.map((c) => (
          <div key={c.label} className="kpi">
            <div className="state-label">{c.label}</div>
            <div className={`kpi-value ${c.tone === "neg" ? "neg" : c.tone === "ok" ? "ok" : ""}`}>{c.value}</div>
            <div className="state-note">{c.note}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Blocked commitments: each request, its rule references and rationale, with its evidence. */
export function BlockedCommitments(props: { decisions: CashCrisisDecision[] }) {
  const rule = (id: string) => cashCrisis.rules.find((r) => r.id === id)?.text ?? "";
  return (
    <section id="inc-commitments" className="panel" aria-labelledby="inc-commitments-title">
      <div className="panel-head">
        <h2 id="inc-commitments-title">Commitments stopped by the incident</h2>
        <span className="muted">Each decision cites its rules and evidence.</span>
      </div>
      <ul className="clean decisions">
        {props.decisions.map((x) => (
          <li key={x.id}>
            <div className="decision-head">
              <strong>{x.description}</strong>
              <span className="num-inline">{m(x.amount)}</span>
              <Pill tone={tone(x.status)}>{x.status.replace("_", " ")}</Pill>
              {!x.inImmediateRequests ? <span className="tag-synthetic">SEPARATE PAYABLE</span> : null}
            </div>
            <div className="muted decision-meta">
              {x.party} · <span className="mono">{x.requestId}</span>
            </div>
            <ul className="rules">
              {x.ruleIds.map((r) => (
                <li key={r}>
                  <span className="mono rule-id">{r}</span> {rule(r)}
                </li>
              ))}
            </ul>
            <div className="chips">
              <span className="state-label">Evidence</span>
              {x.evidenceIds.map((e) => (
                <span key={e} className="chip mono">
                  {e}
                </span>
              ))}
              <span className="chip">Release: {x.releaseStatus === "NOT_AUTHORIZED" ? "not authorized" : x.releaseStatus}</span>
              <span className="chip">Repeat attempt: {x.repeatAttempt === "BLOCKED" ? "blocked" : "not applicable"}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Immediate operational effects, stated from the decisions themselves. */
export function OperationalEffects(props: { decisions: CashCrisisDecision[]; d: Derived }) {
  const { decisions, d } = props;
  const n = decisions.length;
  const noReservation = decisions.filter((x) => !x.newReservationPermitted).length;
  const notAuthorized = decisions.filter((x) => x.releaseStatus === "NOT_AUTHORIZED").length;
  const humanRequired = decisions.filter((x) => x.humanApprovalRequired).length;
  const repeatBlocked = decisions.filter((x) => x.repeatAttempt === "BLOCKED");
  const providerWrites = decisions.reduce((a, x) => a + x.providerWrites, 0);
  const databaseWrites = decisions.reduce((a, x) => a + x.databaseWrites, 0);
  const rows: [string, string][] = [
    ["New reservations", `Not permitted for ${noReservation} of ${n} decisions.`],
    ["Releases", `Not authorized on ${notAuthorized} of ${n} decisions.`],
    ["Human approval", `Required on ${humanRequired} of ${n} decisions. None is recorded.`],
    ["Repeat transfer", repeatBlocked.length > 0 ? `Blocked for ${repeatBlocked.map((x) => x.requestId).join(", ")}.` : "No repeat attempt is pending."],
    ["Available to commit", `The ${m(d.unc)} hold reduces it from ${m(d.cash)} to ${m(d.avail)}. It is a calculation, not permission.`],
    ["Contingent shortfall", `${m(d.contingentShortfall)} if every request were paid from the allocation.`],
    ["Provider and database writes", `${providerWrites} and ${databaseWrites}. Nothing is sent or stored.`],
  ];
  return (
    <section className="panel" aria-labelledby="inc-effects-title">
      <div className="panel-head">
        <h2 id="inc-effects-title">Immediate operational effects</h2>
      </div>
      <dl className="kv panel-body effects">
        {rows.map(([k, v]) => (
          <div key={k} className="effect">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AgentFindings() {
  return (
    <section id="inc-agents" className="panel" aria-labelledby="inc-agents-title">
      <div className="panel-head">
        <h2 id="inc-agents-title">Agent findings and boundaries</h2>
      </div>
      <ul className="clean roles">
        {cashCrisis.findings.map((f) => (
          <li key={f.role}>
            <div className="state-label role-name">{f.role}</div>
            <div>{f.finding}</div>
            <div className="muted role-boundary">Boundary: {f.boundary}</div>
            <div className="chips">
              {f.evidenceIds.map((e) => (
                <span key={e} className="chip mono">
                  {e}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="panel-foot">Static, rule-grounded text recorded in the evidence snapshot. Agents recommend; a person decides. No model runs here.</div>
    </section>
  );
}

export function DecisionHistory() {
  return (
    <section id="inc-history" className="panel" aria-labelledby="inc-history-title">
      <div className="panel-head">
        <h2 id="inc-history-title">Decision history</h2>
        <span className="muted">{cashCrisis.events.length} events, hash-chained.</span>
      </div>
      <ol className="history">
        {cashCrisis.events.map((e) => (
          <li key={e.id}>
            <div className="history-when">{e.when}</div>
            <div>
              <div className="decision-head">
                <strong>{e.title}</strong>
                <span className="chip">{e.role}</span>
              </div>
              <div className="history-text">{e.finding}</div>
              <div className="mono muted history-hash">
                {e.evidenceIds.join(", ")} · sha256 {short(e.sha256)}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="panel-foot">No human approval or decision is recorded in this scenario. Every event above is an agent or system finding.</div>
    </section>
  );
}

export function ReleaseConditions() {
  return (
    <section className="panel" aria-labelledby="inc-release-title">
      <div className="panel-head">
        <h2 id="inc-release-title">What would release the hold</h2>
      </div>
      <ul className="clean roles">
        <li>A signed resolution with authoritative evidence: confirmed paid (the hold moves to settled) or confirmed non-payment.</li>
        <li>Closing the case does not release the hold by itself.</li>
        <li>No resolution authorizes another send. Manual resend is disabled.</li>
      </ul>
    </section>
  );
}
