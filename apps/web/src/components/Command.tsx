// Command screen building blocks (ERP redesign of the Overview). Server components only: no script, no control, no
// recomputation. Every figure is read from the derived scenario state or the committed E3 evidence snapshot.
import Link from "next/link";
import type { ReactNode } from "react";
import { Pill } from "./Figure.tsx";
import { formatMoney, formatMoneyShort } from "../contract/money.ts";
import type { Derived } from "../contract/derive.ts";
import type { ScenarioId } from "../contract/types.ts";
import { FUNDING_CASES, FUNDING_CASE_LABEL, FORECAST_WEEKS, cashCrisis } from "../data/cashCrisis.ts";
import type { CashCrisisDecision, CashCrisisForecastView, FundingCase } from "../data/cashCrisis.ts";

const m = formatMoney;

export const TOUR_STEPS = [
  { title: "The owner draw is late", target: "cmd-forecast", body: "The $2,100,000 owner draw is scheduled for the first forecast week. In the stress case it arrives 12 days late. Use the two case links to compare them." },
  { title: "A funding gap appears", target: "cmd-forecast", body: "In the delayed case, projected cash closes below zero in weeks 1 and 2. The lowest point is the funding gap the project has to cover until the draw lands." },
  { title: "Three requests cannot be paid", target: "cmd-requests", body: "Steel is disputed, electrical is unsigned, and the concrete transfer may already be in flight. Each is stopped by a named rule, and none counts as available." },
  { title: "Money states stay separate", target: "cmd-states", body: "Cash, reserved, held, available and ready-to-send are different states. Available to commit is a calculation. It is never permission to pay." },
  { title: "Nothing moves without a person", target: "cmd-approvals", body: "Every release needs a human approval. None is eligible, so nothing is ready to send and no release control exists." },
  { title: "The recorder proves it", target: "cmd-recorder", body: "Each event is recorded and hash-chained to the one before it, so an edit to the history is detectable. Every number traces back to evidence and a rule." },
] as const;

export function parseTour(params: Readonly<Record<string, string | string[] | undefined>>): number {
  const raw = params.tour;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= TOUR_STEPS.length ? n : 0;
}

export function commandHref(scenario: ScenarioId, fundingCase: FundingCase, tour: number, fragment?: string): string {
  return `/overview?s=${scenario}&d=${fundingCase}${tour > 0 ? `&tour=${tour}` : ""}${fragment ? `#${fragment}` : ""}`;
}

function toneForStatus(status: string): "danger" | "warn" | "ok" {
  return status === "BLOCKED" ? "danger" : status === "UNRESOLVED" ? "warn" : "ok";
}

/** The answer first: one sentence about the funding gap, and what can be sent now. */
export function AnswerBanner(props: { forecast: CashCrisisForecastView; fundingCase: FundingCase; d: Derived }) {
  const { forecast, fundingCase, d } = props;
  const gap = forecast.peakFundingGap > 0n;
  return (
    <section className={`answer ${gap ? "answer-gap" : "answer-ok"}`} aria-label="Answer" data-command-answer={fundingCase}>
      <div className="answer-head">
        <span className={`answer-tag ${gap ? "gap" : "ok"}`}>{gap ? "FUNDING GAP" : "NO GAP"}</span>
        <h2>
          {gap
            ? `Projected funding gap of ${m(forecast.peakFundingGap)} in week ${forecast.worstWeek}`
            : "No projected funding gap"}
        </h2>
      </div>
      <p>
        {gap
          ? `Projected cash closes below zero in ${forecast.negativeWeekCount} of ${FORECAST_WEEKS} weeks, then recovers when the owner draw arrives in week ${forecast.drawWeek} (${forecast.drawDate}). `
          : `The owner draw arrives in week ${forecast.drawWeek} (${forecast.drawDate}). The lowest weekly closing is ${m(forecast.minimumClosing)} in week ${forecast.worstWeek}. `}
        Ready to send now: <strong>{m(d.dispatchableNowTotal)}</strong>. This is a synthetic projection, not a bank
        balance.
      </p>
    </section>
  );
}

export function CaseBar(props: { scenario: ScenarioId; fundingCase: FundingCase; tour: number; screen?: "overview" | "incident" }) {
  const { scenario, fundingCase, tour } = props;
  const screen = props.screen ?? "overview";
  return (
    <div className="case-bar">
      <div className="case-switch" role="group" aria-label="Owner draw timing">
        <span className="case-label">OWNER DRAW</span>
        {FUNDING_CASES.map((fc) => (
          <Link
            key={fc}
            href={screen === "overview" ? commandHref(scenario, fc, tour) : `/${screen}?s=${scenario}&d=${fc}`}
            aria-current={fc === fundingCase ? "true" : undefined}
            data-command-case={fc}
          >
            {FUNDING_CASE_LABEL[fc]}
          </Link>
        ))}
      </div>
      {tour === 0 && screen === "overview" ? (
        <Link className="tour-start" href={commandHref(scenario, "delayed", 1)}>
          Start guided tour
        </Link>
      ) : null}
    </div>
  );
}

/** Where the money stands: separate states, left to right. */
export function MoneyStates(props: { d: Derived; allocationId: string }) {
  const { d } = props;
  const cells: { label: string; value: bigint; note: ReactNode; tone?: string }[] = [
    { label: "Cash", value: d.cash, note: `Posted allocation balance (${props.allocationId}). Not permission.` },
    { label: "Reserved", value: d.res, note: "Held for approved intents." },
    { label: "Held, unresolved", value: d.unc, note: "Uncovered hold on the concrete transfer.", tone: "warn" },
    {
      label: "Available to commit",
      value: d.avail,
      note: d.spendingBlocked ? "Positive but NOT spendable while blocked." : "Cash less reserved and held.",
      tone: "accent",
    },
    { label: "Ready to send now", value: d.dispatchableNowTotal, note: "Approved, eligible, reserved amounts only." },
  ];
  return (
    <section id="cmd-states" className="panel" aria-labelledby="cmd-states-title">
      <div className="panel-head">
        <h2 id="cmd-states-title">Where the money stands</h2>
        <span className="muted">Each state is separate. Moving right needs a recorded decision.</span>
      </div>
      <div className="states">
        {cells.map((c) => (
          <div key={c.label} className="state">
            <div className="state-label">{c.label}</div>
            <div className={`state-value ${c.tone ?? ""}`}>{m(c.value)}</div>
            <div className="state-note">{c.note}</div>
          </div>
        ))}
      </div>
      <div className="panel-foot mono">
        AVAIL = CASH − RES − UNC &nbsp;→&nbsp; {m(d.avail)} = {m(d.cash)} − {m(d.res)} − {m(d.unc)}
      </div>
    </section>
  );
}

/** Weekly closing cash. Geometry only, one vertical scale for both cases so switching the case does not rescale. */
function Chart(props: { forecast: CashCrisisForecastView; fundingCase: FundingCase }) {
  const { forecast, fundingCase } = props;
  const W = 640;
  const H = 240;
  const padL = 52;
  const padR = 8;
  const top = 18;
  const bottom = 30;
  const plotH = H - top - bottom;
  const all = FUNDING_CASES.flatMap((fc) => cashCrisis.forecasts[fc].rows.map((r) => r.closing));
  const hi = all.reduce((a, b) => (b > a ? b : a), 0n);
  const lo = all.reduce((a, b) => (b < a ? b : a), 0n);
  const span = hi - lo > 0n ? hi - lo : 1n;
  const px = (v: bigint) => Number((v * BigInt(plotH)) / span);
  const zeroY = top + px(hi);
  const slot = (W - padL - padR) / forecast.rows.length;
  const barW = Math.max(8, slot - 8);
  const label =
    `13-week synthetic projection, ${FUNDING_CASE_LABEL[fundingCase].toLowerCase()}: weekly closing cash. ` +
    `Lowest closing ${m(forecast.minimumClosing)} in week ${forecast.worstWeek}; week 13 closes at ${m(forecast.endingCash)}. ` +
    `Weeks ${forecast.incompleteWeeks[0]} to ${forecast.incompleteWeeks[forecast.incompleteWeeks.length - 1]} are incomplete. The evidence section lists the same rows.`;
  return (
    <figure className="chart" data-command-chart={fundingCase}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
        <defs>
          <pattern id="cmd-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface)" strokeWidth="3" />
          </pattern>
        </defs>
        <text x={padL - 6} y={top + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{formatMoneyShort(hi)}</text>
        <text x={padL - 6} y={zeroY + 4} fontSize="10" textAnchor="end" fill="var(--muted)">$0</text>
        <text x={padL - 6} y={H - bottom + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{formatMoneyShort(lo)}</text>
        <line x1={padL} x2={W - padR} y1={top} y2={top} stroke="var(--border)" strokeDasharray="3 3" />
        <line x1={padL} x2={W - padR} y1={H - bottom} y2={H - bottom} stroke="var(--border)" strokeDasharray="3 3" />
        {forecast.rows.map((row, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          const h = Math.max(2, px(row.closing < 0n ? -row.closing : row.closing));
          const y = row.closing < 0n ? zeroY : zeroY - h;
          const late = row.quality === "INCOMPLETE_LATE_HORIZON";
          const isLow = row.week === forecast.worstWeek;
          return (
            <g key={row.week} data-closing-cents={row.closing.toString()}>
              <rect x={x} y={y} width={barW} height={h} rx="2" fill={row.negative ? "var(--danger)" : "var(--accent)"} opacity={late ? 0.55 : 1}>
                <title>{`Week ${row.week}: closing ${m(row.closing)} (${late ? "incomplete" : "illustrative"}, synthetic projection)`}</title>
              </rect>
              {late ? <rect x={x} y={y} width={barW} height={h} rx="2" fill="url(#cmd-hatch)" /> : null}
              {isLow ? (
                <text
                  x={x + barW / 2}
                  y={row.closing < 0n ? zeroY - 5 : y - 5}
                  fontSize="10"
                  fontWeight="700"
                  textAnchor="middle"
                  fill={row.negative ? "var(--danger)" : "var(--text)"}
                >
                  {formatMoneyShort(row.closing)}
                </text>
              ) : null}
              <text x={x + barW / 2} y={H - 12} fontSize="10" textAnchor="middle" fill="var(--muted)">
                W{row.week}
                {late ? "*" : ""}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="var(--muted)" strokeWidth="1.5" />
      </svg>
      <figcaption className="muted">
        Bars below the zero line are a projected funding requirement of a synthetic, unfinanced path. Hatched weeks
        marked * are incomplete placeholders.
      </figcaption>
    </figure>
  );
}

export function ForecastPanel(props: { forecast: CashCrisisForecastView; fundingCase: FundingCase }) {
  const { forecast, fundingCase } = props;
  const gap = forecast.peakFundingGap > 0n;
  const stats: { label: string; value: string; tone?: string }[] = [
    { label: "Peak funding gap", value: m(forecast.peakFundingGap), tone: gap ? "neg" : "ok" },
    { label: "Weeks below zero", value: `${forecast.negativeWeekCount} of ${FORECAST_WEEKS}`, tone: gap ? "neg" : "ok" },
    { label: "Lowest closing", value: `${m(forecast.minimumClosing)} · W${forecast.worstWeek}` },
    { label: "Week 13 closing", value: m(forecast.endingCash) },
  ];
  return (
    <section id="cmd-forecast" className="panel" aria-labelledby="cmd-forecast-title" data-command-forecast={fundingCase}>
      <div className="panel-head">
        <h2 id="cmd-forecast-title">Projected weekly closing cash</h2>
        <span className="tag-synthetic">SYNTHETIC · ILLUSTRATIVE</span>
      </div>
      <div className="kpis">
        {stats.map((s) => (
          <div key={s.label} className="kpi">
            <div className="state-label">{s.label}</div>
            <div className={`kpi-value ${s.tone ?? ""}`}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="chart-wrap">
        <Chart forecast={forecast} fundingCase={fundingCase} />
      </div>
    </section>
  );
}

export function RequestsTable(props: { decisions: CashCrisisDecision[]; requestedTotal: bigint; allocation: bigint; shortfall: bigint }) {
  const immediate = props.decisions.filter((x) => x.inImmediateRequests);
  const separate = props.decisions.filter((x) => !x.inImmediateRequests);
  const rule = (id: string) => cashCrisis.rules.find((r) => r.id === id)?.text ?? "";
  const row = (x: CashCrisisDecision) => (
    <tr key={x.id}>
      <td>
        <strong>{x.description}</strong>
        <div className="mono muted">{x.requestId}</div>
      </td>
      <td>{x.party}</td>
      <td className="num">{m(x.amount)}</td>
      <td>
        <Pill tone={toneForStatus(x.status)}>{x.status.replace("_", " ")}</Pill>
      </td>
      <td>{x.releaseStatus === "NOT_AUTHORIZED" ? "Not authorized" : x.releaseStatus}</td>
      <td>
        {x.ruleIds
          .filter((r) => r !== "E3-RULE-108")
          .map((r) => (
            <div key={r}>
              <span className="mono rule-id">{r}</span> {rule(r)}
            </div>
          ))}
      </td>
    </tr>
  );
  return (
    <section id="cmd-requests" className="panel" aria-labelledby="cmd-requests-title">
      <div className="panel-head">
        <h2 id="cmd-requests-title">
          Immediate requests: {m(props.requestedTotal)} against a {m(props.allocation)} allocation
        </h2>
        <span className="muted">Contingent shortfall {m(props.shortfall)}</span>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Immediate requests, scrollable">
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Counterparty</th>
              <th scope="col" className="num">Amount</th>
              <th scope="col">Eligibility</th>
              <th scope="col">Release</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {immediate.map(row)}
            {separate.length > 0 ? (
              <tr className="sep-head">
                <td colSpan={6}>Separate payable, outside the {m(props.requestedTotal)} above</td>
              </tr>
            ) : null}
            {separate.map(row)}
          </tbody>
        </table>
      </div>
      <div className="panel-foot">
        Eligibility is evidence status. It is not a payment authorization. <span className="mono rule-id">E3-RULE-108</span>{" "}
        {rule("E3-RULE-108")}
      </div>
    </section>
  );
}

export function ApprovalsPanel() {
  const c = cashCrisis.controls;
  return (
    <section id="cmd-approvals" className="panel" aria-labelledby="cmd-approvals-title">
      <div className="panel-head">
        <h2 id="cmd-approvals-title">Approvals</h2>
      </div>
      <dl className="kv panel-body">
        <dt>Ready for human approval</dt>
        <dd>0</dd>
        <dt>Automated decision authority</dt>
        <dd>{c.automatedDecisionAuthority ? "Yes" : "None"}</dd>
        <dt>Release interface</dt>
        <dd>{c.releaseInterfaceExists ? "Exists" : "None"}</dd>
        <dt>Human identity verification</dt>
        <dd>{c.humanIdentityVerified ? "Verified" : "Not implemented"}</dd>
      </dl>
      <div className="panel-body">
        <div className="disabled-action" aria-disabled="true">
          Approve release (unavailable)
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          A person must approve every release. None is eligible, and no release interface exists.
        </p>
      </div>
    </section>
  );
}

export function RoleNotes() {
  return (
    <section className="panel" aria-labelledby="cmd-roles-title">
      <div className="panel-head">
        <h2 id="cmd-roles-title">Why, in plain language</h2>
      </div>
      <ul className="clean roles">
        {cashCrisis.findings.map((f) => (
          <li key={f.role}>
            <div className="state-label role-name">{f.role}</div>
            <div>{f.finding}</div>
            <div className="muted role-boundary">{f.boundary}</div>
          </li>
        ))}
      </ul>
      <div className="panel-foot">
        Recorded in the evidence snapshot. Static, rule-grounded text; no model runs in this application.
      </div>
    </section>
  );
}

export function RecorderStrip() {
  const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-8)}`;
  return (
    <section id="cmd-recorder" className="panel" aria-labelledby="cmd-recorder-title">
      <div className="panel-head">
        <h2 id="cmd-recorder-title">Flight recorder</h2>
        <span className="muted">
          {cashCrisis.events.length} events, each chained to the one before by SHA-256. Detects edits; not an externally
          anchored proof.
        </span>
      </div>
      <ol className="events">
        {cashCrisis.events.map((e) => (
          <li key={e.id}>
            <div className="state-label">
              {e.sequence} · {e.type.replace("_", " ")}
            </div>
            <div className="event-title">{e.title}</div>
            <div className="mono muted">{short(e.sha256)}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function TourPanel(props: { step: number; scenario: ScenarioId; fundingCase: FundingCase }) {
  const { step, scenario, fundingCase } = props;
  const s = TOUR_STEPS[step - 1];
  const fc: FundingCase = step <= 2 ? "delayed" : fundingCase;
  return (
    <section className="panel tour" aria-label="Guided tour" data-tour-step={step}>
      <div className="tour-head">
        <span>
          GUIDED TOUR · STEP {step} OF {TOUR_STEPS.length}
        </span>
        <Link href={commandHref(scenario, fundingCase, 0)}>Close</Link>
      </div>
      <div className="panel-body">
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="tour-actions">
          {step > 1 ? (
            <Link href={commandHref(scenario, fc, step - 1, s.target)} className="btn-link">
              Back
            </Link>
          ) : null}
          {step < TOUR_STEPS.length ? (
            <Link href={commandHref(scenario, step + 1 <= 2 ? "delayed" : fundingCase, step + 1, TOUR_STEPS[step].target)} className="btn-link primary">
              Next
            </Link>
          ) : (
            <Link href={commandHref(scenario, fundingCase, 0)} className="btn-link primary">
              Finish
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
