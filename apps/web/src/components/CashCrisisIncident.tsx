// SIM-ENG-002-E3 / E3-D7 — the E3 obligation and evidence workflow appended to the Incident screen.
// A server-rendered, read-only view of the committed evidence snapshot. Decisions, rules, evidence and the event
// chain are displayed exactly as the snapshot records them; none is evaluated here. Links only: there is no payment,
// approval, release or resend control. Synthetic, non-operational demonstration.
import Link from "next/link";
import { Pill } from "./Figure.tsx";
import { FundingCaseLinks } from "./CashCrisisForecast.tsx";
import { formatMoney } from "../contract/money.ts";
import type { ScenarioId } from "../contract/types.ts";
import {
  E3_EVIDENCE_LIST_ANCHOR,
  E3_INCIDENT_ANCHOR,
  E3_OVERVIEW_ANCHOR,
  FUNDING_CASE_LABEL,
  cashCrisis,
  cashCrisisHref,
  decisionAnchor,
  eligibilityReference,
  eventAnchor,
  evidenceAnchor,
} from "../data/cashCrisis.ts";
import type { CashCrisisDecision, DecisionStatus, FundingCase } from "../data/cashCrisis.ts";

const m = formatMoney;
const wrapText = { overflowWrap: "anywhere" } as const;

const STATUS_TONE: Record<DecisionStatus, "danger" | "warn" | "ok"> = {
  BLOCKED: "danger",
  UNRESOLVED: "warn",
  EVIDENCE_ELIGIBLE: "ok",
};
const STATUS_MEANING: Record<DecisionStatus, string> = {
  BLOCKED: "Not financially eligible: at least one rule blocks it.",
  UNRESOLVED: "Not decided: required information is unknown. A repeat attempt is blocked.",
  EVIDENCE_ELIGIBLE: "Evidence complete. This is financial eligibility only; it is not a payment authorization.",
};

/** Snapshot text, unchanged, with each currency amount kept on one line so that a minus sign never wraps away from it. */
function AmountSafeText(props: { text: string }) {
  return (
    <>
      {props.text.split(/(-?\$[0-9][0-9,]*\.[0-9]{2})/).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} style={{ whiteSpace: "nowrap" }}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Links from a decision, event or note to the evidence records it cites. Each target exists once on this page. */
function EvidenceLinks(props: { ids: string[]; from: string }) {
  return (
    <>
      {props.ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ", " : ""}
          <a href={`#${evidenceAnchor(id)}`} className="mono" data-e3-evidence-link={id} data-e3-link-from={props.from}>
            {id}
          </a>
        </span>
      ))}
    </>
  );
}

function DecisionCard(props: { decision: CashCrisisDecision; scenario: ScenarioId }) {
  const { decision: d, scenario } = props;
  return (
    <li
      id={decisionAnchor(d.id)}
      data-e3-decision={d.id}
      data-e3-request={d.requestId}
      data-e3-status={d.status}
      data-e3-release={d.releaseStatus}
      data-e3-amount-cents={d.amount.toString()}
      data-e3-in-immediate={d.inImmediateRequests ? "true" : "false"}
    >
      <h4 style={{ margin: "0 0 4px", fontSize: "0.95rem" }}>
        <span className="mono">{d.id}</span> · {d.description} <Pill tone={STATUS_TONE[d.status]}>{d.status}</Pill>
      </h4>
      <p className="muted" style={{ marginBottom: 6 }}>
        Request <span className="mono">{d.requestId}</span> · obligation <span className="mono">{d.obligationId}</span> ·{" "}
        {d.party} · requested {m(d.amount)}
      </p>
      <dl className="kv" style={{ gridTemplateColumns: "1fr" }}>
        <dt>Financial eligibility (evidence decision)</dt>
        <dd style={{ textAlign: "left" }} data-e3-eligibility="">
          <strong>{d.status}</strong>. {STATUS_MEANING[d.status]}
        </dd>
        <dt>Payment authorization (separate; never granted here)</dt>
        <dd style={{ textAlign: "left" }} data-e3-authorization="">
          <strong>{d.releaseStatus}</strong>. No release exists in this application. Human approval is required and is
          outside it. Provider writes: {d.providerWrites}. Database writes: {d.databaseWrites}.
        </dd>
        <dt>Repeat transfer attempt</dt>
        <dd style={{ textAlign: "left" }} data-e3-repeat-attempt={d.repeatAttempt}>
          {d.repeatAttempt === "BLOCKED" ? <strong>BLOCKED</strong> : "NOT_APPLICABLE"}
        </dd>
        <dt>New reservation in {scenario}</dt>
        <dd style={{ textAlign: "left" }} data-e3-new-reservation="">
          {d.newReservationPermitted ? "May be reviewed. A reservation is not a payment." : "Not permitted."}
        </dd>
        <dt>Rules applied</dt>
        <dd style={{ textAlign: "left" }}>
          <ul className="clean" data-e3-rules="">
            {d.rationale.map((line, i) => (
              <li key={d.ruleIds[i]} data-e3-rule={d.ruleIds[i]} style={wrapText}>
                <span className="mono">{d.ruleIds[i]}</span>: {line}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Evidence</dt>
        <dd style={{ textAlign: "left" }}>
          <EvidenceLinks ids={d.evidenceIds} from={`decision:${d.id}`} />
        </dd>
      </dl>
    </li>
  );
}

export function CashCrisisIncident(props: { scenario: ScenarioId; fundingCase: FundingCase }) {
  const { scenario, fundingCase } = props;
  const { capital, draw, controls } = cashCrisis;
  const decisions = cashCrisis.decisions[scenario];
  const immediate = decisions.filter((d) => d.inImmediateRequests);
  const separate = decisions.filter((d) => !d.inImmediateRequests);
  const repeatBlocked = decisions.filter((d) => d.repeatAttempt === "BLOCKED");
  const scenarioNote = cashCrisis.scenarios.filter((x) => x.id === scenario);
  const forecast = cashCrisis.forecasts[fundingCase];
  return (
    <section
      id={E3_INCIDENT_ANCHOR}
      aria-labelledby="e3-incident-title"
      data-e3-section="incident"
      data-e3-scenario={scenario}
      data-e3-funding-case={fundingCase}
      style={{ marginTop: 24, borderTop: "3px solid var(--synthetic)", paddingTop: 16 }}
    >
      <h2 id="e3-incident-title">
        E3 cash-crisis incident: obligations, evidence and decisions <Pill tone="synthetic">SYNTHETIC</Pill>{" "}
        <Pill tone="synthetic">NON-OPERATIONAL</Pill>
      </h2>
      <p className="muted" data-e3-status="">
        {cashCrisis.classification}. Project {cashCrisis.project.id}, scenario {scenario}. Displayed from one committed,
        deterministic evidence snapshot; no decision is evaluated on this page.{" "}
        {scenarioNote.map((x) => (
          <span key={x.id} data-e3-scenario-note={x.id}>
            {x.id}: {x.note}
          </span>
        ))}
      </p>

      <section className="card" aria-labelledby="e3-incident-funding-title" data-e3-funding-context={fundingCase}>
        <h3 id="e3-incident-funding-title">Funding case shown: {FUNDING_CASE_LABEL[fundingCase].toLowerCase()}</h3>
        <p>
          The {m(draw.amount)} owner draw is modeled in week {forecast.drawWeek} of the E3 calendar ({forecast.drawDate}
          ). {forecast.peakFundingGap > 0n
            ? `Peak projected funding gap ${m(forecast.peakFundingGap)} in week ${forecast.worstWeek}: a projection of a synthetic, unfinanced path.`
            : `No week of this case closes below zero; the lowest weekly closing is ${m(forecast.minimumClosing)}.`}{" "}
          The funding case changes the forecast only. The obligations, evidence and decisions below are the same in
          both cases. Draw schedule evidence: <EvidenceLinks ids={[draw.evidenceId]} from="draw" />.
        </p>
        <FundingCaseLinks screen="incident" scenario={scenario} fundingCase={fundingCase} fragment={E3_INCIDENT_ANCHOR} />
        <p style={{ marginBottom: 0 }}>
          <Link href={cashCrisisHref("overview", scenario, fundingCase, E3_OVERVIEW_ANCHOR)}>
            13-week forecast and capital reconciliation on the Overview screen
          </Link>
          . E3 week numbers follow E3&apos;s own synthetic calendar (week {cashCrisis.forecasts.on_time.drawWeek} on
          time, week {cashCrisis.forecasts.delayed.drawWeek} delayed) and are not comparable with the day 18 and day 30
          convention of the E2 forecast, where the same draw lands in week 5.
        </p>
      </section>

      <section className="card alert-warn" aria-labelledby="e3-separation-title" data-e3-disclosure="separation">
        <h3 id="e3-separation-title">Financial eligibility is not payment authorization</h3>
        <p>
          Each request below carries two separate answers. <strong>Financial eligibility</strong> is the evidence
          decision recorded in the snapshot: BLOCKED, UNRESOLVED or EVIDENCE_ELIGIBLE.{" "}
          <strong>Payment authorization</strong> is a different question, and for every request the recorded answer is{" "}
          <span className="mono">NOT_AUTHORIZED</span>.
        </p>
        <p style={{ marginBottom: 0 }}>
          An eligible request is not an approved payment. This application has no payment, approval or release
          function, and human approval is outside it.
        </p>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="e3-obligations-title" data-e3-obligations="">
          <h3 id="e3-obligations-title">Immediate requests against the allocation</h3>
          <dl className="kv">
            {immediate.map((d) => (
              <ObligationRow key={d.id} decision={d} />
            ))}
            <dt>
              <strong>Immediate requests</strong>
            </dt>
            <dd data-e3-total="immediate-requests">
              <strong>{m(capital.immediateRequests)}</strong>
            </dd>
            <dt>Project capital allocation</dt>
            <dd data-e3-total="allocation">{m(capital.allocation)}</dd>
            <dt>Requests over the allocation (nominal)</dt>
            <dd data-e3-total="nominal-gap" style={{ color: "var(--danger)", fontWeight: 700 }}>
              {m(capital.nominalOverAllocation)}
            </dd>
          </dl>
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
            None of the three is an eligible disbursement.{" "}
            {separate.map((d) => `The separate ${m(d.amount)} payable (${d.requestId}) is outside the ${m(capital.immediateRequests)}.`).join(" ")}
          </p>
        </section>

        <section className="card" aria-labelledby="e3-hold-title" data-e3-hold="">
          <h3 id="e3-hold-title">Capital after the concrete hold</h3>
          <dl className="kv">
            <dt>Project capital allocation</dt>
            <dd>{m(capital.allocation)}</dd>
            <dt>Uncertain concrete hold, applied once</dt>
            <dd data-e3-total="hold">{m(capital.concreteHold)}</dd>
            <dt>
              <strong>Available after the concrete hold</strong>
            </dt>
            <dd data-e3-total="after-hold">
              <strong>{m(capital.availableAfterHold)}</strong>
            </dd>
            <dt>New-reservable authority in {scenario}</dt>
            <dd data-e3-total="new-reservable">{m(capital.newReservable[scenario])}</dd>
          </dl>
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }} data-e3-disclosure="capital">
            E3 shows {m(capital.availableAfterHold)} after the concrete hold. The E2 eligibility demonstration (screen
            6) shows {m(eligibilityReference.availableToCommit)} because it applies an additional{" "}
            {m(eligibilityReference.restrictedReserves)} reserve. The assumptions differ and neither figure is changed
            to match the other.
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="e3-decisions-title" data-e3-decisions={scenario}>
        <h3 id="e3-decisions-title">Evidence-linked decisions, scenario {scenario}</h3>
        <h4 style={{ margin: "8px 0 4px", fontSize: "0.9rem" }} className="muted">
          Inside the {m(capital.immediateRequests)} immediate requests
        </h4>
        <ul className="clean" data-e3-decision-group="immediate">
          {immediate.map((d) => (
            <DecisionCard key={d.id} decision={d} scenario={scenario} />
          ))}
        </ul>
        <h4 style={{ margin: "12px 0 4px", fontSize: "0.9rem" }} className="muted">
          Separate payable, outside the {m(capital.immediateRequests)}
        </h4>
        <ul className="clean" data-e3-decision-group="separate">
          {separate.map((d) => (
            <DecisionCard key={d.id} decision={d} scenario={scenario} />
          ))}
        </ul>
      </section>

      <section className="card alert-danger" aria-labelledby="e3-duplicate-title" data-e3-duplicate-protection="">
        <h3 id="e3-duplicate-title">Duplicate transfer protection</h3>
        {repeatBlocked.map((d) => (
          <div key={d.id} data-e3-duplicate-for={d.id}>
            <p>
              The state of the earlier {m(d.amount)} concrete transfer (<a href={`#${decisionAnchor(d.id)}`} className="mono">{d.id}</a>
              ) is unknown, so the request is <strong>{d.status}</strong> and a second transfer attempt is blocked
              (repeat attempt: <strong>{d.repeatAttempt}</strong>). The {m(capital.concreteHold)} is held against the
              allocation once, not twice: {capital.holdApplicationCount} hold application recorded.
            </p>
            <ul className="clean">
              {d.rationale.map((line, i) => (
                <li key={d.ruleIds[i]} style={wrapText}>
                  <span className="mono">{d.ruleIds[i]}</span>: {line}
                </li>
              ))}
            </ul>
            <p style={{ marginTop: 8, marginBottom: 0 }}>
              Evidence: <EvidenceLinks ids={d.evidenceIds} from={`duplicate:${d.id}`} />. Nothing on this page can send,
              resend or retry a transfer.
            </p>
          </div>
        ))}
        <ul className="clean" style={{ marginTop: 8 }} data-e3-hold-applications="">
          {capital.holdApplications.map((h) => (
            <li key={h.requestId} data-e3-hold-application={h.requestId} data-cents={h.amount.toString()}>
              Hold of {m(h.amount)} for request <span className="mono">{h.requestId}</span>, obligation{" "}
              <span className="mono">{h.obligationId}</span>. Evidence:{" "}
              <EvidenceLinks ids={h.evidenceIds} from={`hold:${h.requestId}`} />
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="e3-evidence-title" id={E3_EVIDENCE_LIST_ANCHOR} data-e3-evidence-list="">
        <h3 id="e3-evidence-title">Evidence records ({cashCrisis.evidence.length}, synthetic)</h3>
        <ul className="clean">
          {cashCrisis.evidence.map((ev) => (
            <li key={ev.id} id={evidenceAnchor(ev.id)} data-e3-evidence={ev.id} tabIndex={-1}>
              <strong className="mono">{ev.id}</strong> · {ev.title} <Pill>{ev.status}</Pill>
              <div className="muted" style={{ fontSize: "0.85rem" }}>{ev.kind}</div>
              <div style={wrapText}>{ev.detail}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="e3-events-title" data-e3-events="">
        <h3 id="e3-events-title">Event chain ({cashCrisis.events.length} events)</h3>
        <p className="muted">
          Each event records the SHA-256 of its content and the digest of the event before it. The digests show that
          the recorded sequence is unchanged; they are not signatures and attest to no external fact.
        </p>
        <ol className="timeline">
          {cashCrisis.events.map((ev) => (
            <li key={ev.id} id={eventAnchor(ev.id)} data-e3-event={ev.id} data-e3-sequence={ev.sequence}>
              <div>
                <strong>
                  {ev.sequence}. {ev.title}
                </strong>{" "}
                <Pill>{ev.type}</Pill>
              </div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                <span className="mono">{ev.id}</span> · {ev.when} · role {ev.role}
              </div>
              <div style={wrapText}>
                <AmountSafeText text={ev.finding} />
              </div>
              <div>
                Evidence: <EvidenceLinks ids={ev.evidenceIds} from={`event:${ev.id}`} />
              </div>
              <div className="mono muted" style={wrapText} data-e3-event-sha256="">sha256 {ev.sha256}</div>
              <div className="mono muted" style={wrapText} data-e3-event-prev="">previous {ev.prevSha256}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card" aria-labelledby="e3-findings-title" data-e3-findings="">
        <h3 id="e3-findings-title">Role notes</h3>
        <p className="muted">
          Static, rule-grounded notes recorded in the snapshot for four workflow roles. No inference runs in this
          application and no note carries decision authority.
        </p>
        <ul className="clean">
          {cashCrisis.findings.map((f) => (
            <li key={`${f.role}:${f.finding}`} data-e3-finding={f.role}>
              <strong>{f.role}</strong>:{" "}
              <span style={wrapText}>
                <AmountSafeText text={f.finding} />
              </span>
              <div className="muted">Boundary: {f.boundary}</div>
              <div>
                Evidence: <EvidenceLinks ids={f.evidenceIds} from={`finding:${f.role}`} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="e3-rules-title" data-e3-rule-table="">
        <h3 id="e3-rules-title">Rule reference ({cashCrisis.rules.length} rules)</h3>
        <p className="muted">The rule texts as the snapshot records them. They are applied by the finance simulation, not here.</p>
        <ul className="clean">
          {cashCrisis.rules.map((r) => (
            <li key={r.id} data-e3-rule-entry={r.id} style={wrapText}>
              <span className="mono">{r.id}</span>: {r.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="e3-controls-title" data-e3-controls="">
        <h3 id="e3-controls-title">Control boundary</h3>
        <dl className="kv">
          <dt>Provider writes</dt>
          <dd data-e3-control="provider-writes">{controls.providerWrites}</dd>
          <dt>Database writes</dt>
          <dd data-e3-control="database-writes">{controls.databaseWrites}</dd>
          <dt>Real payment authority</dt>
          <dd data-e3-control="payment-authority">{controls.realPaymentAuthority ? "Yes" : "None"}</dd>
          <dt>Release interface</dt>
          <dd data-e3-control="release-interface">{controls.releaseInterfaceExists ? "Yes" : "None"}</dd>
          <dt>Automated decision authority</dt>
          <dd data-e3-control="automated-authority">{controls.automatedDecisionAuthority ? "Yes" : "None"}</dd>
          <dt>Verified human identity</dt>
          <dd data-e3-control="human-identity">{controls.humanIdentityVerified ? "Yes" : "None"}</dd>
          <dt>Read-only, synthetic data</dt>
          <dd data-e3-control="read-only">{controls.readOnly && controls.syntheticOnly ? "Yes" : "No"}</dd>
        </dl>
        <ul className="clean" style={{ marginTop: 8 }} data-e3-capital-notes="">
          {capital.notes.map((text) => (
            <li key={text} className="muted">{text}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function ObligationRow(props: { decision: CashCrisisDecision }) {
  const d = props.decision;
  return (
    <>
      <dt>
        <a href={`#${decisionAnchor(d.id)}`}>{d.description}</a> <Pill tone={STATUS_TONE[d.status]}>{d.status}</Pill>
      </dt>
      <dd data-e3-obligation={d.id} data-cents={d.amount.toString()}>{m(d.amount)}</dd>
    </>
  );
}
