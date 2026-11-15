import { Pill } from "../../components/Figure.tsx";
import { ForecastChart } from "../../components/ForecastChart.tsx";
import { Shell } from "../../components/Shell.tsx";
import { formatMoney, parseMoney } from "../../contract/money.ts";
import { loadScenario } from "../../data/load.ts";
import type { SearchParams } from "../../data/load.ts";
import { CashCrisisForecast } from "../../components/CashCrisisForecast.tsx";
import {
  AnswerBanner,
  ApprovalsPanel,
  CaseBar,
  ForecastPanel,
  MoneyStates,
  RecorderStrip,
  RequestsTable,
  RoleNotes,
  TourPanel,
  parseTour,
} from "../../components/Command.tsx";
import { cashCrisis, selectFundingCase } from "../../data/cashCrisis.ts";

// Command: the Overview rebuilt as an answer-first control screen. The answer, the separate money states, the forecast,
// the blocked requests, the approvals boundary and the recorder come first. The earlier detail (recorded-schedule
// forecast and the full E3 evidence sections) is unchanged and sits one click away under "Full evidence".
export default async function Overview({ searchParams }: { searchParams: SearchParams }) {
  const { id, snap, d } = await loadScenario(searchParams);
  const params = await searchParams;
  const fundingCase = selectFundingCase(params);
  const tour = parseTour(params);
  const forecast = cashCrisis.forecasts[fundingCase];
  const m = formatMoney;
  const gapPct = d.requestedTotal > 0n ? Number((d.cash * 100n) / d.requestedTotal) : 100;
  return (
    <Shell scenario={id} active="overview" requestedTotal={d.requestedTotal} additionalNotRequestedTotal={d.additionalNotRequestedTotal}>
      <p className="muted">
        {snap.project.name} · contract {m(parseMoney(snap.project.contractAmount))} · gross-profit
        baseline {m(parseMoney(snap.project.grossProfitBaseline))}
      </p>

      <div className="cmd" data-tour-step={tour > 0 ? tour : undefined}>
        <CaseBar scenario={id} fundingCase={fundingCase} tour={tour} />
        <AnswerBanner forecast={forecast} fundingCase={fundingCase} d={d} />

        {d.spendingBlocked ? (
          <div className="card alert-danger" role="alert">
            <h2>
              Spending blocked <Pill tone="danger">ALLOCATION_BLOCKED</Pill>
            </h2>
            <p>
              Available to commit is {m(d.avail)}, but an open allocation-wide case has an unknown amount. Authorized new
              commitment is {m(d.authorizedNewCommitment)}. Do not treat the available figure as spendable.
            </p>
          </div>
        ) : (
          <div className="card alert-warn">
            <h2>
              Capacity open, with known holds <Pill tone="warn">{d.openCases} open case</Pill>
            </h2>
            <p>
              {m(d.unc)} is held for a transfer whose outcome is unknown. New commitment is limited to what remains.
            </p>
          </div>
        )}

        <div className="cmd-grid">
          <div className="cmd-main">
            <MoneyStates d={d} allocationId={snap.allocation.allocationId} />
            <ForecastPanel forecast={forecast} fundingCase={fundingCase} />
            <RequestsTable
              decisions={cashCrisis.decisions[id]}
              requestedTotal={d.requestedTotal}
              allocation={d.cash}
              shortfall={d.contingentShortfall}
            />
          </div>
          <aside className="cmd-side" aria-label="Controls and explanation">
            {tour > 0 ? <TourPanel step={tour} scenario={id} fundingCase={fundingCase} /> : null}
            <ApprovalsPanel />
            <RoleNotes />
            <section className="card wallet">
              <h2>
                {snap.sandboxWallet.label} <Pill tone="synthetic">NOT PROJECT CASH</Pill>
              </h2>
              <div className="figure">
                <div className="value">{m(d.walletAmount)}</div>
              </div>
              <p>A provider sandbox balance. It is never counted in CASH, AVAIL or any capacity figure on this page.</p>
            </section>
          </aside>
        </div>

        <RecorderStrip />

        <details className="evidence">
          <summary>
            Full evidence: recorded-schedule forecast, 13-week table, assumptions, reconciliation and provenance
          </summary>

          <section className="card">
            <h2>Requests against the allocation</h2>
            <dl className="kv">
              <dt>Requested outflows</dt>
              <dd>{m(d.requestedTotal)}</dd>
              <dt>Project allocation (CASH)</dt>
              <dd>{m(d.cash)}</dd>
              <dt>Contingent shortfall</dt>
              <dd style={{ color: "var(--danger)", fontWeight: 700 }}>{m(d.contingentShortfall)}</dd>
            </dl>
            <div className="bar" style={{ marginTop: 10 }} aria-hidden="true">
              <span className="seg-d" style={{ width: `${Math.min(100, gapPct)}%` }} />
              <span className="seg-u" style={{ width: `${Math.max(0, 100 - gapPct)}%` }} />
            </div>
            <div className="legend">
              <span>Covered by allocation</span>
              <span>Contingent shortfall</span>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              The shortfall is contingent: two of the requests are excluded (disputed steel, unapproved change order) and
              one is on hold.
            </p>
          </section>

          <section className="card">
            <h2>13-week forecast (recorded schedule)</h2>
            <p>
              <Pill tone="warn">INCOMPLETE</Pill>{" "}
              <span className="muted">
                Schedules are recorded through week {snap.forecast.scheduleRecordedThroughWeek}. Weeks{" "}
                {snap.forecast.scheduleRecordedThroughWeek + 1} to 13 are not estimated.
              </span>
            </p>
            <ForecastChart weeks={d.weeks} />
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Timing</th>
                    <th scope="col" style={{ textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.forecast.dated.map((x) => (
                    <tr key={x.label}>
                      <td>{x.label}</td>
                      <td>
                        {x.dueDay === null ? (
                          <Pill tone="warn">no date</Pill>
                        ) : x.delayDays > 0 ? (
                          `day ${x.dueDay} → day ${x.dueDay + x.delayDays} (delayed ${x.delayDays} days)`
                        ) : (
                          `day ${x.dueDay}`
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {x.direction === "IN" ? "+" : "−"}
                        {m(parseMoney(x.amount))}
                      </td>
                    </tr>
                  ))}
                  {snap.forecast.recurring.map((x) => (
                    <tr key={x.label}>
                      <td>
                        {x.label} {x.illustrative ? <Pill tone="synthetic">illustrative</Pill> : null}
                      </td>
                      <td>
                        weeks {x.fromWeek}–{x.toWeek}
                      </td>
                      <td style={{ textAlign: "right" }}>−{m(parseMoney(x.amount))} / wk</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <CashCrisisForecast scenario={id} fundingCase={fundingCase} />
        </details>
      </div>
    </Shell>
  );
}
