// SIM-ENG-002-E3 / E3-D6 — the E3 construction cash-crisis summary appended to the Overview screen.
// A server-rendered, read-only view of the committed evidence snapshot: every figure is displayed from the snapshot's
// integer cents and none is recomputed here. The on-time / delayed choice is a plain link parameter; there is no
// control, no script and no payment, approval or release pathway. Synthetic, non-operational demonstration.
import Link from "next/link";
import { Figure, Pill } from "./Figure.tsx";
import { formatMoney, formatMoneyShort } from "../contract/money.ts";
import type { ScenarioId } from "../contract/types.ts";
import {
  CASH_CRISIS_FIXTURE_PATH,
  DEFAULT_FUNDING_CASE,
  E3_EVIDENCE_LIST_ANCHOR,
  E3_INCIDENT_ANCHOR,
  E3_OVERVIEW_ANCHOR,
  FUNDING_CASES,
  FUNDING_CASE_LABEL,
  cashCrisis,
  cashCrisisHref,
  eligibilityReference,
  isoDateLabel,
} from "../data/cashCrisis.ts";
import type { CashCrisisForecastView, ForecastRow, FundingCase } from "../data/cashCrisis.ts";

const m = formatMoney;
const right = { textAlign: "right" } as const;
const numeric = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } as const;
const figure = { textAlign: "right", fontVariantNumeric: "tabular-nums" } as const;

/** The two funding cases as server-rendered links. The selected case is marked in text and by aria-current. */
export function FundingCaseLinks(props: {
  screen: "overview" | "incident";
  scenario: ScenarioId;
  fundingCase: FundingCase;
  fragment: string;
}) {
  const { screen, scenario, fundingCase, fragment } = props;
  return (
    <div
      role="group"
      aria-label="E3 owner-draw funding case"
      data-e3-case-links={screen}
      style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}
    >
      {FUNDING_CASES.map((fc) => {
        const selected = fc === fundingCase;
        return (
          <Link
            key={fc}
            href={cashCrisisHref(screen, scenario, fc, fragment)}
            aria-current={selected ? "true" : undefined}
            data-e3-case={fc}
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: 44,
              padding: "8px 14px",
              borderRadius: 8,
              border: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
              background: selected ? "var(--surface-2)" : "var(--surface)",
              color: "var(--text)",
              fontWeight: selected ? 700 : 400,
              textDecoration: selected ? "none" : "underline",
            }}
          >
            {FUNDING_CASE_LABEL[fc]}
            {selected ? " (shown)" : ""}
          </Link>
        );
      })}
    </div>
  );
}

function qualityLabel(row: ForecastRow): string {
  return row.quality === "INCOMPLETE_LATE_HORIZON" ? "Incomplete" : "Illustrative";
}

/** Bars of the weekly closing figure, drawn from the same rows as the table. Geometry only; no amount is derived. */
function ClosingChart(props: { forecast: CashCrisisForecastView; fundingCase: FundingCase }) {
  const { forecast, fundingCase } = props;
  const W = 340;
  const H = 200;
  const padL = 8;
  const padR = 8;
  const top = 20;
  const bottom = 32;
  const plotH = H - top - bottom;
  // One vertical scale for both cases, so that switching the case does not rescale the picture.
  const all = FUNDING_CASES.flatMap((fc) => cashCrisis.forecasts[fc].rows.map((r) => r.closing));
  const hi = all.reduce((a, b) => (b > a ? b : a), 0n);
  const lo = all.reduce((a, b) => (b < a ? b : a), 0n);
  const span = hi - lo > 0n ? hi - lo : 1n;
  const px = (v: bigint) => Number((v * BigInt(plotH)) / span);
  const zeroY = top + px(hi);
  const slot = (W - padL - padR) / forecast.rows.length;
  const barW = Math.max(6, slot - 6);
  const incomplete = forecast.incompleteWeeks;
  const label =
    `E3 synthetic 13-week projection, ${FUNDING_CASE_LABEL[fundingCase].toLowerCase()}: weekly closing projected operating cash. ` +
    `Lowest closing ${m(forecast.minimumClosing)} in week ${forecast.worstWeek}; week 13 closes at ${m(forecast.endingCash)}. ` +
    `Weeks ${incomplete[0]} to ${incomplete[incomplete.length - 1]} are incomplete. The table below lists the same rows.`;
  return (
    <figure style={{ margin: 0 }} data-e3-chart={fundingCase}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: "block", maxHeight: 280 }}>
        <defs>
          <pattern id="e3-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface)" strokeWidth="3" />
          </pattern>
        </defs>
        {forecast.rows.map((row, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          const h = Math.max(2, px(row.closing < 0n ? -row.closing : row.closing));
          const y = row.closing < 0n ? zeroY : zeroY - h;
          const late = row.quality === "INCOMPLETE_LATE_HORIZON";
          return (
            <g key={row.week} data-e3-bar={row.week} data-closing-cents={row.closing.toString()} data-quality={row.quality}>
              <rect x={x} y={y} width={barW} height={h} fill={row.negative ? "var(--danger)" : "var(--accent)"} rx="2">
                <title>{`Week ${row.week}: closing ${m(row.closing)} (${qualityLabel(row).toLowerCase()}, synthetic projection)`}</title>
              </rect>
              {late ? <rect x={x} y={y} width={barW} height={h} fill="url(#e3-hatch)" rx="2" /> : null}
              <text x={x + barW / 2} y={H - 18} fontSize="8" textAnchor="middle" fill="var(--muted)">
                {row.week}
                {late ? "*" : ""}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="var(--text)" strokeWidth="1" />
        <text x={padL} y={12} fontSize="9" fill="var(--muted)">
          Lowest closing {formatMoneyShort(forecast.minimumClosing)} (week {forecast.worstWeek})
        </text>
        <text x={W - padR} y={12} fontSize="9" textAnchor="end" fill="var(--muted)">zero line marked</text>
        <text x={W - padR} y={H - 4} fontSize="8" textAnchor="end" fill="var(--muted)">week (* incomplete)</text>
      </svg>
      <figcaption className="muted" style={{ fontSize: "0.8rem" }}>
        Weekly closing projected operating cash in the E3 synthetic model, {FUNDING_CASE_LABEL[fundingCase].toLowerCase()}.
        Bars below the zero line are a projected funding requirement of a synthetic, unfinanced path. Hatched bars
        marked * (weeks {incomplete[0]} to {incomplete[incomplete.length - 1]}) are incomplete placeholders. The chart
        and the table show the same 13 rows.
      </figcaption>
    </figure>
  );
}

function ForecastTable(props: { forecast: CashCrisisForecastView; fundingCase: FundingCase }) {
  const { forecast, fundingCase } = props;
  return (
    <div className="table-scroll" style={{ marginTop: 8 }} tabIndex={0} role="region" aria-label="E3 13-week forecast table, scrollable">
      <table data-e3-forecast-table={fundingCase}>
        <caption className="muted" style={{ textAlign: "left", captionSide: "top", padding: "0 0 6px" }}>
          E3 synthetic 13-week projection — {FUNDING_CASE_LABEL[fundingCase].toLowerCase()}. Opening + receipts −
          outflows = closing, in each week. Illustrative; weeks 10 to 13 incomplete.
        </caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Dates</th>
            <th scope="col" style={right}>Opening</th>
            <th scope="col" style={right}>Receipts</th>
            <th scope="col" style={right}>Outflows</th>
            <th scope="col" style={right}>Closing</th>
            <th scope="col">Quality and notes</th>
          </tr>
        </thead>
        <tbody>
          {forecast.rows.map((row) => (
            <tr key={row.week} data-e3-week={row.week} data-quality={row.quality}>
              <th scope="row" style={{ whiteSpace: "nowrap" }}>Week {row.week}</th>
              <td className="mono">
                {row.start} to {row.end}
              </td>
              <td style={numeric} data-cents={row.opening.toString()} data-col="opening">{m(row.opening)}</td>
              <td style={numeric} data-cents={row.receipts.toString()} data-col="receipts">{m(row.receipts)}</td>
              <td style={numeric} data-cents={row.outflow.toString()} data-col="outflow">{m(row.outflow)}</td>
              <td
                style={row.negative ? { ...numeric, color: "var(--danger)", fontWeight: 700 } : numeric}
                data-cents={row.closing.toString()}
                data-col="closing"
              >
                {m(row.closing)}
              </td>
              <td>
                {row.quality === "INCOMPLETE_LATE_HORIZON" ? (
                  <>
                    <Pill tone="warn">INCOMPLETE</Pill> <span className="mono">INCOMPLETE_LATE_HORIZON</span>: placeholder
                    values, not a verified projection.
                  </>
                ) : (
                  <span className="mono">ILLUSTRATIVE</span>
                )}
                {row.week === forecast.drawWeek ? <> Owner draw of {m(cashCrisis.draw.amount)} modeled in this week.</> : null}
                {row.negative ? <> Negative closing: projected funding requirement, synthetic.</> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutcomeComparison(props: { fundingCase: FundingCase }) {
  const f = cashCrisis.forecasts;
  const cell = (fc: FundingCase, key: string, text: string, centsValue?: bigint) => (
    <td
      key={fc}
      style={centsValue === undefined ? figure : numeric}
      data-e3-outcome={`${fc}:${key}`}
      data-cents={centsValue === undefined ? undefined : centsValue.toString()}
    >
      {text}
    </td>
  );
  const rows: { key: string; label: string; text: (v: CashCrisisForecastView) => string; cents?: (v: CashCrisisForecastView) => bigint }[] = [
    { key: "draw-week", label: "Week that receives the owner draw", text: (v) => `Week ${v.drawWeek} (${v.drawDate})` },
    { key: "minimum-closing", label: "Lowest weekly closing", text: (v) => m(v.minimumClosing), cents: (v) => v.minimumClosing },
    { key: "peak-gap", label: "Peak projected funding gap", text: (v) => m(v.peakFundingGap), cents: (v) => v.peakFundingGap },
    {
      key: "peak-week",
      label: "Week of peak funding gap",
      text: (v) => (v.peakFundingGap > 0n ? `Week ${v.worstWeek}` : "None (no negative week)"),
    },
    { key: "negative-weeks", label: "Weeks closing below zero", text: (v) => String(v.negativeWeekCount) },
    { key: "ending-cash", label: "Week 13 closing", text: (v) => m(v.endingCash), cents: (v) => v.endingCash },
  ];
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="E3 on-time versus delayed outcome table, scrollable">
      <table data-e3-outcome-table="">
        <caption className="muted" style={{ textAlign: "left", captionSide: "top", padding: "0 0 6px" }}>
          On-time versus delayed outcome in the E3 synthetic model. The two cases differ only in the week that receives
          the owner draw.
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            {FUNDING_CASES.map((fc) => (
              <th key={fc} scope="col" style={right} aria-current={fc === props.fundingCase ? "true" : undefined}>
                {FUNDING_CASE_LABEL[fc]}
                {fc === props.fundingCase ? " (shown)" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              {FUNDING_CASES.map((fc) => cell(fc, r.key, r.text(f[fc]), r.cents ? r.cents(f[fc]) : undefined))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CashCrisisForecast(props: { scenario: ScenarioId; fundingCase: FundingCase }) {
  const { scenario, fundingCase } = props;
  const { project, draw, capital, forecasts } = cashCrisis;
  const forecast = forecasts[fundingCase];
  const delayed = forecasts.delayed;
  const onTime = forecasts.on_time;
  const other: ScenarioId = scenario === "S0" ? "S1" : "S0";
  const immediate = cashCrisis.decisions[scenario].filter((x) => x.inImmediateRequests);
  const separate = cashCrisis.decisions[scenario].filter((x) => !x.inImmediateRequests);
  const incompleteWeeks = forecast.incompleteWeeks;
  return (
    <section
      id={E3_OVERVIEW_ANCHOR}
      aria-labelledby="e3-cash-crisis-title"
      data-e3-section="overview"
      data-e3-scenario={scenario}
      data-e3-funding-case={fundingCase}
      style={{ marginTop: 24, borderTop: "3px solid var(--synthetic)", paddingTop: 16 }}
    >
      <h2 id="e3-cash-crisis-title">
        E3 construction cash crisis: a separate synthetic stress model <Pill tone="synthetic">SYNTHETIC</Pill>{" "}
        <Pill tone="synthetic">NON-OPERATIONAL</Pill>
      </h2>
      <p className="muted" data-e3-status="">
        {cashCrisis.classification}. Project {project.id} ({project.label}). Every figure in this section is read from one committed,
        deterministic evidence snapshot and is displayed, not recalculated. Nothing here is a bank balance, a payment
        authority, an approval or a release.
      </p>

      <div className="grid four">
        <Figure
          label="Contract"
          contractKey="E3 · synthetic project"
          value={m(project.contract)}
          sub={`${formatMoneyShort(project.contract)} project`}
        />
        <Figure
          label="Projected gross profit"
          contractKey="E3 · not liquidity"
          value={m(project.projectedGrossProfit)}
          sub={`${formatMoneyShort(project.projectedGrossProfit)} projected. Profit is not cash on hand.`}
        />
        <Figure
          label="Owner draw, delayed"
          contractKey={`E3 · ${draw.delayDays} days late in the stress case`}
          value={m(draw.amount)}
          sub={`${formatMoneyShort(draw.amount)} scheduled ${isoDateLabel(draw.onTimeDate)}; stress case ${isoDateLabel(draw.delayedDate)}.`}
        />
        <Figure
          label="Peak projected funding gap"
          contractKey="E3 · delayed case · projection"
          value={m(delayed.peakFundingGap)}
          tone="neg"
          sub={`Week ${delayed.worstWeek} of the E3 calendar. On time: ${m(onTime.peakFundingGap)}.`}
        />
      </div>

      <section className="card alert-warn" aria-labelledby="e3-calendar-title" data-e3-disclosure="calendar">
        <h3 id="e3-calendar-title">Two synthetic calendars: week numbers are not comparable</h3>
        <p>
          <strong>E3 (this section)</strong> uses its own synthetic calendar of weeks starting {forecast.rows[0].start}:
          the {m(draw.amount)} owner draw falls in <strong>week {onTime.drawWeek}</strong> on time and in{" "}
          <strong>week {delayed.drawWeek}</strong> when delayed.
        </p>
        <p>
          <strong>E2 (the recorded-schedule 13-week forecast above)</strong> counts days from the scenario date: the
          draw is due on <strong>day 18</strong> and arrives on <strong>day 30</strong>, in week 5 of that forecast.
        </p>
        <p style={{ marginBottom: 0 }}>
          Both describe the same {m(draw.amount)} draw, {draw.delayDays} days late. They are distinct synthetic
          calendars; an E3 week number must not be read against an E2 week number, and neither is adjusted to match the
          other.
        </p>
      </section>

      <section className="card" aria-labelledby="e3-outcome-title">
        <h3 id="e3-outcome-title">13-week cash forecast: on-time versus delayed</h3>
        <p>
          Choose the funding case. Each choice is a link to this page; nothing is calculated in the browser.
        </p>
        <FundingCaseLinks screen="overview" scenario={scenario} fundingCase={fundingCase} fragment={E3_OVERVIEW_ANCHOR} />
        <p className="muted">
          Default: {FUNDING_CASE_LABEL[DEFAULT_FUNDING_CASE].toLowerCase()}. The scenario switch at the top of the page
          (S0 / S1) does not carry the funding case, so using it returns this section to that default.
        </p>
        <OutcomeComparison fundingCase={fundingCase} />
        <p data-e3-gap-statement="" style={{ marginTop: 10 }}>
          <strong>
            Peak projected funding gap: {m(delayed.peakFundingGap)} in week {delayed.worstWeek}, delayed case.
          </strong>{" "}
          This is a projected funding requirement of a synthetic, unfinanced path driven by new synthetic assumptions.
          It is a projection only: not an observed balance, not a recorded shortfall at any bank and not a verified
          contractual fact. Recorded basis: <span className="mono" style={{ overflowWrap: "anywhere" }}>{delayed.fundingGapBasis}</span>.
        </p>
      </section>

      <section className="card" aria-labelledby="e3-forecast-title" data-e3-forecast={fundingCase}>
        <h3 id="e3-forecast-title">
          E3 projection, {FUNDING_CASE_LABEL[fundingCase].toLowerCase()} <Pill tone="synthetic">ILLUSTRATIVE</Pill>
        </h3>
        <p data-e3-disclosure="late-horizon">
          <Pill tone="warn">INCOMPLETE</Pill>{" "}
          <span>
            Weeks {incompleteWeeks[0]} to {incompleteWeeks[incompleteWeeks.length - 1]} carry the quality{" "}
            <span className="mono">INCOMPLETE_LATE_HORIZON</span>: their inputs are incomplete and their values are
            illustrative placeholders.
          </span>
        </p>
        <ClosingChart forecast={forecast} fundingCase={fundingCase} />
        <ForecastTable forecast={forecast} fundingCase={fundingCase} />
        <ul className="clean" style={{ marginTop: 8 }} data-e3-forecast-limitations="">
          {forecast.limitations.map((text) => (
            <li key={text} className="muted">{text}</li>
          ))}
        </ul>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="e3-capital-title" data-e3-capital="">
          <h3 id="e3-capital-title">Capital reconciliation (E3)</h3>
          <div className="eq" data-e3-eq="requests">
            Immediate requests
            <br />
            {immediate.map((x) => m(x.amount)).join(" + ")} = {m(capital.immediateRequests)}
          </div>
          <div className="eq" style={{ marginTop: 6 }} data-e3-eq="nominal-gap">
            Requests − allocation
            <br />
            {m(capital.immediateRequests)} − {m(capital.allocation)} = {m(capital.nominalOverAllocation)}
          </div>
          <div className="eq" style={{ marginTop: 6 }} data-e3-eq="after-hold">
            Allocation − concrete hold (applied once)
            <br />
            {m(capital.allocation)} − {m(capital.concreteHold)} = {m(capital.availableAfterHold)}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {separate.map((x) => `A separate ${m(x.amount)} payable (${x.requestId}) is outside the ${m(capital.immediateRequests)} and is in no total above.`).join(" ")}{" "}
            <Link href={cashCrisisHref("incident", scenario, fundingCase, E3_INCIDENT_ANCHOR)}>
              Obligations, evidence and decisions on the Incident screen
            </Link>
            .
          </p>
        </section>

        <section className="card" aria-labelledby="e3-authority-title" data-e3-authority={scenario}>
          <h3 id="e3-authority-title">Calculated cash is not new authority</h3>
          <dl className="kv">
            <dt>Calculated availability after the hold, S0 and S1</dt>
            <dd data-e3-available="">{m(capital.availableAfterHold)}</dd>
            <dt>New-reservable authority, {scenario} (shown)</dt>
            <dd data-e3-new-reservable={scenario}>{m(capital.newReservable[scenario])}</dd>
            <dt>New-reservable authority, {other}</dt>
            <dd data-e3-new-reservable={other}>{m(capital.newReservable[other])}</dd>
          </dl>
          <p className="muted" style={{ marginTop: 8 }}>
            The facts and the calculated availability are identical in S0 and S1. Only the authority to make a new
            reservation differs. Neither figure is permission to pay.
          </p>
        </section>
      </div>

      <section className="card alert-warn" aria-labelledby="e3-capital-disclosure-title" data-e3-disclosure="capital">
        <h3 id="e3-capital-disclosure-title">Two availability figures, two sets of assumptions</h3>
        <dl className="kv">
          <dt>E3: allocation {m(capital.allocation)} less the {m(capital.concreteHold)} concrete hold</dt>
          <dd data-e3-capital-figure="e3">{m(capital.availableAfterHold)}</dd>
          <dt>
            E2 eligibility demonstration: the same allocation and hold, less an additional{" "}
            {m(eligibilityReference.restrictedReserves)} reserve
          </dt>
          <dd data-e3-capital-figure="e2">{m(eligibilityReference.availableToCommit)}</dd>
        </dl>
        <p style={{ marginTop: 8, marginBottom: 0 }}>
          The {m(capital.eligibilityReference.reserve)} illustrative reserve belongs to the accepted eligibility
          demonstration (screen 6) and is not applied in E3. Both calculations are kept as they are; neither is changed
          to agree with the other.
        </p>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }} data-e3-eligibility-note="">
          {capital.eligibilityReference.note}
        </p>
      </section>

      <section className="card" aria-labelledby="e3-terms-title" data-e3-disclosure="terms">
        <h3 id="e3-terms-title">Four different things</h3>
        <dl className="kv">
          <dt>Operating liquidity: opening projected operating cash, a synthetic forecast input</dt>
          <dd>{m(project.openingOperatingCash)}</dd>
          <dt>Project allocation</dt>
          <dd>{m(capital.allocation)}</dd>
          <dt>Eligible capital: calculated availability after the single hold</dt>
          <dd>{m(capital.availableAfterHold)}</dd>
          <dt>Actual payment authority</dt>
          <dd>None</dd>
        </dl>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
          The opening operating cash is not the allocation, not a wallet and not a bank balance. No figure on this page
          authorizes a payment.
        </p>
      </section>

      <section className="card" aria-labelledby="e3-assumptions-title" data-e3-assumptions="">
        <h3 id="e3-assumptions-title">Forecast assumptions ({cashCrisis.assumptions.length}, all synthetic)</h3>
        <ul className="clean">
          {cashCrisis.assumptions.map((a) => (
            <li key={a.id} data-e3-assumption={a.id}>
              <span className="mono">{a.id}</span> <Pill tone="synthetic">{a.label}</Pill>{" "}
              <span style={{ overflowWrap: "anywhere" }}>{a.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="e3-provenance-title" data-e3-provenance="">
        <h3 id="e3-provenance-title">Evidence provenance</h3>
        <dl className="kv" style={{ gridTemplateColumns: "1fr" }}>
          <dt>Snapshot schema</dt>
          <dd className="mono" style={{ textAlign: "left", overflowWrap: "anywhere" }}>{cashCrisis.schema}</dd>
          <dt>Task</dt>
          <dd className="mono" style={{ textAlign: "left", overflowWrap: "anywhere" }}>{cashCrisis.task}</dd>
          <dt>Synthetic input fixture</dt>
          <dd className="mono" style={{ textAlign: "left", overflowWrap: "anywhere" }}>
            {cashCrisis.fixture.id} · {cashCrisis.fixture.path}
          </dd>
          <dt>Input fixture SHA-256</dt>
          <dd className="mono" style={{ textAlign: "left", overflowWrap: "anywhere" }} data-e3-fixture-sha256="">{cashCrisis.fixture.sha256}</dd>
          <dt>Snapshot content SHA-256 (recorded inside the snapshot; not the file hash)</dt>
          <dd className="mono" style={{ textAlign: "left", overflowWrap: "anywhere" }} data-e3-snapshot-sha256="">{cashCrisis.snapshotContentSha256}</dd>
        </dl>
        <p style={{ marginTop: 8 }}>
          Source file: <span className="mono" style={{ overflowWrap: "anywhere" }}>{CASH_CRISIS_FIXTURE_PATH}</span>, the committed output
          of the deterministic finance simulation.{" "}
          <Link href={cashCrisisHref("incident", scenario, fundingCase, E3_EVIDENCE_LIST_ANCHOR)}>
            {cashCrisis.evidence.length} evidence items and {cashCrisis.events.length} chained events on the Incident
            screen
          </Link>
          .
        </p>
        <ul className="clean" data-e3-limitations="">
          {cashCrisis.limitations.map((text) => (
            <li key={text} className="muted">{text}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}
