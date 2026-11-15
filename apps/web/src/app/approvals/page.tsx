import { Pill } from "../../components/Figure.tsx";
import { Shell } from "../../components/Shell.tsx";
import { formatMoney, parseMoney } from "../../contract/money.ts";
import { loadScenario } from "../../data/load.ts";
import type { SearchParams } from "../../data/load.ts";

export default async function Approvals({ searchParams }: { searchParams: SearchParams }) {
  const { id, snap, d } = await loadScenario(searchParams);
  const m = formatMoney;
  const p = snap.approvalPreview;
  const target = d.obligations.find((o) => o.facts.obligationId === p.obligationId)!;
  return (
    <Shell scenario={id} active="approvals" requestedTotal={d.requestedTotal} additionalNotRequestedTotal={d.additionalNotRequestedTotal}>
      <div className="card alert-warn">
        <h2>
          Approval is disabled <Pill tone="warn">NO BACKEND ENFORCEMENT</Pill>
        </h2>
        <p>
          This screen shows what an approver would see. The action stays disabled until a backend enforces the approval
          checks. Nothing here approves, reserves, claims or sends anything.
        </p>
      </div>

      <section className="card">
        <h2>Authority path</h2>
        <div className="stepper">
          <div className="step"><b>1 RESERVE</b>Active reservations: {snap.reservations.length}</div>
          <div className="step"><b>2 APPROVE</b>Signed by a person who is not the preparer</div>
          <div className="step"><b>3 CLAIM</b>One claim per intent</div>
          <div className="step"><b>4 DISPATCH</b>One begin_send, one POST, no resend</div>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Ready to send now: {m(d.dispatchableNowTotal)}. Reservable capacity is not an approval, and an approval is
          not a send.
        </p>
      </section>

      <section className="card">
        <h2>Readiness of each request</h2>
        <ul className="clean">
          {d.obligations.map((o) => (
            <li key={o.facts.obligationId}>
              <b>{o.facts.label}</b> {m(o.amount)}{" "}
              {o.newReservable > 0n ? <Pill tone="ok">can be reserved up to {m(o.newReservable)}</Pill> : <Pill tone="danger">cannot be reserved</Pill>}
              {o.reasons.length > 0 ? <div className="muted">{o.reasons.join("; ")}.</div> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>
          Approval preview <Pill tone="synthetic">PREVIEW ONLY</Pill>
        </h2>
        <p className="muted">What the approver's signer would display for {target.facts.label}.</p>
        <dl className="kv">
          <dt>Beneficiary</dt>
          <dd>{p.beneficiaryLabel}</dd>
          <dt>Beneficiary fingerprint</dt>
          <dd className="mono">{p.beneficiaryFingerprint}</dd>
          <dt>Amount</dt>
          <dd>{m(parseMoney(p.amount))}</dd>
          <dt>Currency</dt>
          <dd>{p.currency}</dd>
          <dt>Evidence</dt>
          <dd>{p.evidenceKind}</dd>
          <dt>Evidence digest</dt>
          <dd className="mono">{p.evidenceDigestShort}</dd>
          <dt>Policy revision</dt>
          <dd className="mono">{p.policyRevision}</dd>
          <dt>Prepared by</dt>
          <dd>{p.preparer}</dd>
          <dt>Approver</dt>
          <dd>{p.approver}</dd>
        </dl>
        {target.newReservable === 0n ? (
          <p className="muted" style={{ marginTop: 8 }}>
            In this scenario the request cannot even be reserved: {target.reasons.join("; ")}.
          </p>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="disabled-action" disabled aria-disabled="true">
            Approve — disabled (backend enforcement not connected)
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Fingerprints and digests here are synthetic strings. A fingerprint is not proof of bank ownership.
        </p>
      </section>
    </Shell>
  );
}
