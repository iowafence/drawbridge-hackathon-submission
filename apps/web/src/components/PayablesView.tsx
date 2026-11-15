// Payables screen building blocks (ERP redesign). Server components only: no script, no control, no new figure.
// Obligation figures are the derived scenario values; rules, approvals and evidence come from the E3 evidence snapshot.
import { Pill } from "./Figure.tsx";
import { formatMoney } from "../contract/money.ts";
import type { Derived } from "../contract/derive.ts";
import { cashCrisis } from "../data/cashCrisis.ts";
import type { CashCrisisDecision } from "../data/cashCrisis.ts";
import type { ScenarioId } from "../contract/types.ts";

const m = formatMoney;
type Obligation = Derived["obligations"][number];
const KIND: Record<string, string> = { MATERIAL: "Material", SUBCONTRACTOR: "Subcontractor", CHANGE_ORDER: "Change order" };
const decisionFor = (scenario: ScenarioId, obligationId: string): CashCrisisDecision | undefined =>
  cashCrisis.decisions[scenario].find((x) => x.obligationId === obligationId);
const ruleText = (id: string) => cashCrisis.rules.find((r) => r.id === id)?.text ?? "";
const eligTone = (o: Obligation): "ok" | "danger" | "warn" => (o.eligible ? "ok" : o.facts.eligibility === "ELIGIBLE" ? "warn" : "danger");

export function PayablesSummary(props: { d: Derived }) {
  const { d } = props;
  const eligible = d.obligations.filter((o) => o.eligible).length;
  const cells: { label: string; value: string; note: string; tone?: string }[] = [
    { label: "Obligations", value: String(d.obligations.length), note: `${eligible} eligible, ${d.obligations.length - eligible} excluded.` },
    { label: "Requested outflows", value: m(d.requestedTotal), note: "Steel, electrical and concrete." },
    { label: "Separate payable", value: m(d.additionalNotRequestedTotal), note: "Outside the requested total. Not releasable.", tone: "ok" },
    { label: "Ready to send now", value: m(d.dispatchableNowTotal), note: "Approved, eligible, reserved amounts only." },
  ];
  return (
    <section className="panel" aria-label="Payables summary" data-payables-summary="">
      <div className="states">
        {cells.map((c) => (
          <div key={c.label} className="state">
            <div className="state-label">{c.label}</div>
            <div className={`state-value ${c.tone === "ok" ? "" : ""}`}>{c.value}</div>
            <div className="state-note">{c.note}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One row per obligation: status, request, and the plainest reason it cannot be paid. */
export function ObligationTable(props: { d: Derived; scenario: ScenarioId }) {
  return (
    <section id="pay-table" className="panel" aria-labelledby="pay-table-title">
      <div className="panel-head">
        <h2 id="pay-table-title">All obligations</h2>
        <span className="muted">Eligibility is evidence status. It is not a payment authorization.</span>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Obligations, scrollable">
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">Obligation</th>
              <th scope="col" className="num">Amount</th>
              <th scope="col">Eligibility</th>
              <th scope="col">Request</th>
              <th scope="col" className="num">Ready to send</th>
              <th scope="col">Reason and rules</th>
            </tr>
          </thead>
          <tbody>
            {props.d.obligations.map((o) => {
              const f = o.facts;
              const dec = decisionFor(props.scenario, f.obligationId);
              return (
                <tr key={f.obligationId}>
                  <td>
                    <strong>{f.label}</strong>
                    <div className="muted">{f.counterpartyLabel}</div>
                  </td>
                  <td className="num">{m(o.amount)}</td>
                  <td>
                    <div className="chips" style={{ marginTop: 0 }}>
                      <Pill tone={eligTone(o)}>{f.eligibility}</Pill>
                      {o.blockedByCase ? <Pill tone="danger">BLOCKING CASE</Pill> : null}
                      {f.barred ? <Pill tone="danger">PERMANENT BAR</Pill> : null}
                    </div>
                  </td>
                  <td>{f.requested ? <Pill>requested</Pill> : <Pill tone="synthetic">not requested</Pill>}</td>
                  <td className="num">{m(o.dispatchableNow)}</td>
                  <td>
                    {f.eligibilityNote}
                    {dec ? (
                      <div>
                        {dec.ruleIds
                          .filter((r) => r !== "E3-RULE-108")
                          .map((r) => (
                            <div key={r}>
                              <span className="mono rule-id">{r}</span> {ruleText(r)}
                            </div>
                          ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Per obligation: approval dependency, evidence gaps and the derived capacity figures. */
export function ObligationDetail(props: { o: Obligation; scenario: ScenarioId }) {
  const { o, scenario } = props;
  const f = o.facts;
  const dec = decisionFor(scenario, f.obligationId);
  const evidence = dec ? dec.evidenceIds.map((id) => cashCrisis.evidence.find((e) => e.id === id)).filter((e) => e !== undefined) : [];
  return (
    <section className="panel" aria-labelledby={`pay-${f.obligationId}`} data-obligation={f.obligationId}>
      <div className="panel-head">
        <h2 id={`pay-${f.obligationId}`}>{f.label}</h2>
        <span className="mono muted">
          {f.obligationId} · {KIND[f.kind]}
        </span>
      </div>
      <div className="panel-body">
        <div className="state-label">Approval dependency</div>
        <p>
          {dec
            ? dec.humanApprovalRequired
              ? "A person must approve any release. No approval is recorded, and no release interface exists."
              : "No human approval is required by the snapshot."
            : "No decision is recorded for this obligation in the E3 snapshot."}
        </p>
        <div className="state-label">Evidence and gaps</div>
        {evidence.length > 0 ? (
          <ul className="clean evidence-list">
            {evidence.map((e) => (
              <li key={e.id}>
                <span className="mono rule-id">{e.id}</span> <span className="chip nowrap">{e.status}</span>
                <div className="muted">{e.detail}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No evidence records are linked.</p>
        )}
        {o.reasons.length > 0 ? (
          <>
            <div className="state-label" style={{ marginTop: 8 }}>Why capacity is zero</div>
            <p className="muted">{o.reasons.join("; ")}.</p>
          </>
        ) : null}
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Settled (CONS)</dt>
          <dd>{m(o.cons)}</dd>
          <dt>Reserved (RV)</dt>
          <dd>{m(o.rv)}</dd>
          <dt>Uncovered hold (UNCOV)</dt>
          <dd>{m(o.uncov)}</dd>
          <dt>Room</dt>
          <dd>{m(o.room)}</dd>
          <dt>Additional reservable</dt>
          <dd>{m(o.newReservable)}</dd>
          <dt>Ready to send now</dt>
          <dd>{m(o.dispatchableNow)}</dd>
        </dl>
        <p className="muted" style={{ marginTop: 8 }}>
          Identity: {f.payableClass === "INVOICE_BACKED" ? "REFERENCE_KEYED" : "ATTESTED_ONLY"} · {f.invoiceRefDisplay ?? "no usable reference"} · Lineage {f.lineageId}
        </p>
      </div>
    </section>
  );
}
