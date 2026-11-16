// A6 integrated transaction stepper (contract flow-v1). React SERVER component: no "use client", no browser state,
// type-only imports. It renders exactly one FlowView and computes nothing that matters: no decision, no digest, no
// provider status. Step progress is a presentation of the recorded server state only.
//
// Truth rules shown on screen (contract §1): eligible is not approved; approved is not sent; submitted is not
// processing; processing is not settled; PAID only from a provider READ; a ledger reduction is "drawn against
// allocation", never paid. Synthetic obligation figures, the mock/sandbox provider balance and E3 project figures are
// three different things and are shown in separate, labelled places.
import type { ReactNode } from "react";
import type { FlowActionOp, FlowState, FlowView, ProofId } from "../../../integrated/flowTypes.ts";
import { DECISION_COPY, PROOF_LABELS, PROOF_STATE_HELP, STATE_COPY, timeText } from "./labels.ts";

export const PROOF_ORDER: readonly ProofId[] = ["S", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

/** Live-page controls: the signed-in operator's CSRF token (flow-v1.1 FlowPageSession.csrf). Digests come only from
 *  the server's FlowView.echo. Absent => the stepper is read-only. */
export type StepperControls = { csrf: string };

export type StepStatus = "complete" | "current" | "pending" | "blocked" | "stopped" | "unknown";
export type Step = { key: string; title: string; status: StepStatus; summary: string };

const STATUS_TEXT: Record<StepStatus, string> = {
  complete: "Done",
  current: "Current step",
  pending: "Not reached",
  blocked: "Not available",
  stopped: "Stopped",
  unknown: "Outcome unknown",
};

const AFTER_INTENT: FlowState[] = ["SUBMIT_INTENT_RECORDED", "SUBMITTED", "SUBMISSION_UNCERTAIN", "PROVIDER_REFUSED", "PROVIDER_SCHEDULED", "PROVIDER_PROCESSING", "PROVIDER_FAILED", "PROVIDER_PAID"];
const READ_STATES: FlowState[] = ["PROVIDER_SCHEDULED", "PROVIDER_PROCESSING", "PROVIDER_FAILED", "PROVIDER_PAID"];

/** Presentation of the recorded state as six steps. Pure mapping from `view.state` (+ whether an approval exists). */
export function stepsFor(v: FlowView): Step[] {
  const s = v.state;
  const gateDone = v.gate !== null;
  const gateStop = s === "GATE_HOLD" || s === "GATE_REVIEW";
  const approved = v.authorization !== null;
  const afterIntent = AFTER_INTENT.includes(s);
  const st = (cond: [boolean, StepStatus][], dflt: StepStatus): StepStatus => cond.find(([c]) => c)?.[1] ?? dflt;

  return [
    { key: "obligation", title: "Obligation and exact proposal", status: "complete", summary: `${v.proposal.reference} · ${v.proposal.payee} · ${v.proposal.amount_display}` },
    {
      key: "evidence",
      title: "Source evidence",
      status: st([[s === "DRAFT", "current"]], "complete"),
      summary: s === "DRAFT" ? "No evidence attached" : v.gate ? `${v.gate.evidence_source === "FIXTURE_REPLAY" ? "Fixture replay" : "Live agent run"} · ${v.gate.document_id ?? "no registered document"}` : "Attached; not yet evaluated",
    },
    {
      key: "gate",
      title: "Deterministic 11-proof gate",
      status: st([[!gateDone && s === "EVIDENCE_READY", "current"], [!gateDone, "pending"], [gateStop, "stopped"]], "complete"),
      summary: v.gate ? DECISION_COPY[v.gate.decision] ?? v.gate.decision : "Not evaluated",
    },
    {
      key: "approval",
      title: "Human approval",
      status: st(
        [
          [gateStop, "blocked"],
          [s === "GATE_ELIGIBLE" || s === "AWAITING_HUMAN", "current"],
          [s === "HUMAN_REJECTED", "stopped"],
          [s === "EXPIRED" && !approved, "stopped"],
          [approved, "complete"],
        ],
        "pending",
      ),
      summary: gateStop
        ? "Cannot be approved: the gate did not find it eligible"
        : s === "HUMAN_REJECTED"
          ? "Rejected"
          : approved
            ? `Approved by ${v.authorization!.operator_id}`
            : s === "EXPIRED"
              ? "Expired before approval"
              : s === "AWAITING_HUMAN" || s === "GATE_ELIGIBLE"
                ? "Required. Not approved yet"
                : "Required after the gate",
    },
    {
      key: "submission",
      title: "Single submission attempt",
      status: st(
        [
          [gateStop || s === "HUMAN_REJECTED", "blocked"],
          [s === "EXPIRED", approved ? "stopped" : "blocked"],
          [s === "HUMAN_APPROVED" || s === "SUBMIT_INTENT_RECORDED", "current"],
          [s === "SUBMISSION_UNCERTAIN", "unknown"],
          [s === "PROVIDER_REFUSED", "stopped"],
          [afterIntent, "complete"],
        ],
        "pending",
      ),
      summary:
        s === "SUBMISSION_UNCERTAIN"
          ? "Outcome unknown. No retry"
          : s === "PROVIDER_REFUSED"
            ? "Refused by provider"
            : afterIntent
              ? s === "SUBMIT_INTENT_RECORDED"
                ? "Intent recorded; provider response not recorded"
                : "One create request accepted"
              : s === "EXPIRED" && approved
                ? "Approval expired unused"
                : "Not submitted",
    },
    {
      key: "provider",
      title: "Provider status (read-back)",
      status: st([[READ_STATES.includes(s) && s !== "PROVIDER_PAID" && s !== "PROVIDER_FAILED", "current"], [s === "PROVIDER_PAID", "complete"], [s === "PROVIDER_FAILED", "stopped"], [s === "SUBMITTED" || s === "SUBMISSION_UNCERTAIN", "current"], [gateStop || s === "HUMAN_REJECTED" || s === "EXPIRED" || s === "PROVIDER_REFUSED", "blocked"]], "pending"),
      summary: v.submission.last_provider_status ? `Last read: ${v.submission.last_provider_status} · ${settlementLine(v)}` : afterIntent ? "No provider read yet · not settled" : "Nothing submitted",
    },
  ];
}

/** The one sentence about money movement. Never claims settlement unless a provider READ said PAID. */
export function settlementLine(v: FlowView): string {
  if (v.state === "PROVIDER_PAID") {
    return v.provider_mode === "mock"
      ? "Mock provider read reported PAID. Mock mode: no provider was called and no money exists or moved"
      : "Airwallex sandbox read reported PAID. Sandbox test funds only, not real money and not project cash";
  }
  if (v.state === "PROVIDER_FAILED") return "Provider reported a failed or cancelled transfer. Not settled";
  if (v.state === "SUBMISSION_UNCERTAIN") return "Unknown whether a transfer exists. Not settled";
  return "Not settled";
}

const tone = (status: StepStatus) => (status === "complete" ? "ok" : status === "current" ? "info" : status === "pending" ? "idle" : "bad");

function ProofTable({ g }: { g: NonNullable<FlowView["gate"]> }) {
  return (
    <table className="ifs-proofs">
      <caption>All 11 proofs, in published order. Only VERIFIED satisfies a requirement.</caption>
      <thead>
        <tr><th scope="col">Proof</th><th scope="col">Requirement</th><th scope="col">State</th><th scope="col">Reason given by the gate</th></tr>
      </thead>
      <tbody>
        {PROOF_ORDER.map((id) => {
          const state = g.proof_states[id];
          return (
            <tr key={id} data-proof={id} data-state={state}>
              <th scope="row">{id}</th>
              <td data-label="Requirement">{PROOF_LABELS[id]}</td>
              <td data-label="State"><span className={`ifs-pill ifs-${state === "VERIFIED" ? "ok" : state === "UNTRUSTED" || state === "UNKNOWN" ? "warn" : "bad"}`} title={PROOF_STATE_HELP[state]}>{state}</span></td>
              <td data-label="Reason">{g.proof_reasons[id]}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HoldReasons({ g }: { g: NonNullable<FlowView["gate"]> }) {
  const failing = PROOF_ORDER.filter((id) => g.proof_states[id] !== "VERIFIED");
  if (g.decision === "ELIGIBLE_FOR_HUMAN_REVIEW") return null;
  return (
    <div className={`ifs-callout ifs-${g.decision === "HOLD" ? "bad" : "warn"}`} role="note" aria-labelledby="ifs-hold-h">
      <h4 id="ifs-hold-h">{g.decision === "HOLD" ? "Why this is on HOLD" : "Why this is not eligible (REVIEW)"}</h4>
      <p>Deciding rule: <code>{g.rule}</code>{g.gate_refused ? ". The gate refused to decide (proof R reported)" : ""}.</p>
      <ul>
        {failing.map((id) => (
          <li key={id}><b>{id} · {PROOF_LABELS[id]}: {g.proof_states[id]}.</b> {g.proof_reasons[id]}</li>
        ))}
      </ul>
      <p>This flow is closed. It cannot be approved or submitted, through this page or the API. A new evaluation needs a new flow.</p>
    </div>
  );
}

const PASS_VERB: Record<string, string> = { approve: "approve", reject: "reject", submit: "submit" };
/** Mirrors flow-v1.1 STEP_UP_OPS (type-only import rule: the A6 test asserts equality with the contract constant). */
export const A6_STEP_UP_OPS: readonly FlowActionOp[] = ["approve", "reject", "submit"];

function ActionForm(props: { op: FlowActionOp; flowId: string; c: StepperControls; label: string; echo?: Record<string, string>; note: string }) {
  const id = `ifs-${props.op}`;
  return (
    <form method="post" action="/sandbox/flow/action" className="ifs-act" aria-describedby={`${id}-note`}>
      <input type="hidden" name="op" value={props.op} />
      <input type="hidden" name="csrf" value={props.c.csrf} />
      <input type="hidden" name="flow_id" value={props.flowId} />
      {Object.entries(props.echo ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {A6_STEP_UP_OPS.includes(props.op) ? (
        <>
          <label htmlFor={`${id}-pass`}>Operator passphrase, re-entered to {PASS_VERB[props.op] ?? props.op}</label>
          <input id={`${id}-pass`} type="password" name="passphrase" required autoComplete="off" />
        </>
      ) : null}
      <button type="submit">{props.label}</button>
      <p id={`${id}-note`} className="muted">{props.note}</p>
    </form>
  );
}

function Actions({ v, c }: { v: FlowView; c: StepperControls | null }) {
  const s = v.state;
  if (v.terminal) return <p className="muted">No actions: this flow is closed ({STATE_COPY[s].label}).</p>;
  if (!c) return <p className="muted">Read-only view. Actions are available only on a live flow to a signed-in operator.</p>;
  const f = v.flow_id;
  const e = v.echo;
  const missing = (what: string) => <p className="muted">Action not offered: the server supplied no {what} to confirm. Reload the flow.</p>;
  switch (s) {
    case "EVIDENCE_READY":
      return <ActionForm op="evaluate_gate" flowId={f} c={c} label="Run the 11-proof gate" note="The server evaluates its stored evidence. Nothing the browser sends is read as a result." />;
    case "GATE_ELIGIBLE":
      return <ActionForm op="request_human_review" flowId={f} c={c} label="Send for human review" note="Re-checks the gate result on the server. Does not approve anything." />;
    case "AWAITING_HUMAN":
      if (!e.gate_digest) return missing("gate digest");
      return (
        <>
          <ActionForm op="approve" flowId={f} c={c} echo={{ proposal_digest: e.proposal_digest, gate_digest: e.gate_digest }} label="Approve exactly this proposal" note={`Approves proposal digest ${e.proposal_digest.slice(0, 12)}… with gate result ${e.gate_digest.slice(0, 12)}… only. Expires after 10 minutes. Does not send anything.`} />
          <ActionForm op="reject" flowId={f} c={c} echo={{ proposal_digest: e.proposal_digest }} label="Reject" note="Closes the flow permanently." />
        </>
      );
    case "HUMAN_APPROVED":
      if (!e.authorization_digest) return missing("authorization digest");
      return <ActionForm op="submit" flowId={f} c={c} echo={{ authorization_digest: e.authorization_digest }} label={v.provider_mode === "mock" ? "Submit once to the mock provider" : "Submit once to the Airwallex sandbox"} note="Records the single attempt before calling the provider. Exactly one create request per flow; there is no retry." />;
    case "SUBMIT_INTENT_RECORDED":
    case "SUBMITTED":
    case "SUBMISSION_UNCERTAIN":
    case "PROVIDER_SCHEDULED":
    case "PROVIDER_PROCESSING":
      return <ActionForm op="reconcile" flowId={f} c={c} label="Read provider status" note="Read-only. Never creates or resends a transfer." />;
    default:
      return <p className="muted">No action from this page in the current state.</p>;
  }
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (<><dt>{k}</dt><dd>{children}</dd></>);
}

export function FlowStepper({ view: v, controls = null, preview = false }: { view: FlowView; controls?: StepperControls | null; preview?: boolean }) {
  const copy = STATE_COPY[v.state];
  const steps = stepsFor(v);
  const g = v.gate;
  const sub = v.submission;
  const modeText = v.provider_mode === "mock" ? "MOCK PROVIDER · no network · no money" : "AIRWALLEX SANDBOX · test data · not real money";
  return (
    <article className="ifs" data-flow-id={v.flow_id} data-state={v.state} aria-labelledby="ifs-title">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {preview ? (
        <p className="ifs-banner ifs-warn" role="note">
          <b>UI FIXTURE PREVIEW. Not a live flow.</b> The gate section is real gate output on synthetic registry data. The state,
          approval, submission and audit sections are illustrative fixtures for interface testing; no approval or transfer exists.
        </p>
      ) : null}
      <header className="ifs-head">
        <h2 id="ifs-title">Transaction {v.proposal.reference}</h2>
        <p className="ifs-flowid">Flow ID <code>{v.flow_id}</code> <span className="muted">· version {v.version}</span></p>
        <p className="ifs-status" role="status">
          <span className={`ifs-pill ifs-${copy.tone === "ok" ? "ok" : copy.tone === "danger" ? "bad" : copy.tone === "warn" ? "warn" : "idle"}`}>{copy.label}</span> <code data-state-code>{v.state}</code>{" "}
          {copy.means}{copy.notMeans ? <> <b>{copy.notMeans}</b></> : null}
        </p>
        <p className={`ifs-mode ifs-mode-${v.provider_mode}`}>{modeText}</p>
      </header>

      <nav aria-label="Transaction progress">
        <ol className="ifs-steps">
          {steps.map((st, i) => (
            <li key={st.key} className={`ifs-step ifs-${tone(st.status)}`} aria-current={st.status === "current" ? "step" : undefined}>
              <span className="ifs-n" aria-hidden="true">{i + 1}</span>
              <span className="ifs-step-body">
                <a href={`#ifs-${st.key}`}>{st.title}</a>
                <span className="ifs-step-status">{STATUS_TEXT[st.status]}</span>
                <span className="ifs-step-sum">{st.summary}</span>
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <section id="ifs-obligation" className="card" aria-labelledby="ifs-h-ob">
        <h3 id="ifs-h-ob">1. Obligation and exact proposal</h3>
        <p className="muted">Every field below was derived by the server from the synthetic registry and the binding fixture. The browser supplies none of them.</p>
        <dl className="ifs-dl">
          <Row k="Obligation">{v.proposal.obligation_id}</Row>
          <Row k="Payee (registry)">{v.proposal.payee}</Row>
          <Row k="Beneficiary">{v.proposal.beneficiary_label} <span className="muted">(provider id …{v.proposal.beneficiary_id_suffix})</span></Row>
          <Row k="Amount">{v.proposal.amount_display} <span className="muted">({v.proposal.amount_minor} minor units)</span></Row>
          <Row k="Reference">{v.proposal.reference}</Row>
          <Row k="Method · reason">{v.proposal.transfer_method} · {v.proposal.reason}</Row>
          <Row k="Provider request id"><code>{v.proposal.provider_request_id}</code></Row>
        </dl>
      </section>

      <section id="ifs-evidence" className="card" aria-labelledby="ifs-h-ev">
        <h3 id="ifs-h-ev">2. Source evidence</h3>
        {g ? (
          <dl className="ifs-dl">
            <Row k="Source">{g.evidence_source === "FIXTURE_REPLAY" ? "FIXTURE_REPLAY: stored synthetic facts replayed, no model call" : "AGENT_RUN: a live read-only model analysis (untrusted; can only block)"}</Row>
            <Row k="Document">{g.document_id ?? "No registered document matched"}</Row>
            <Row k="Binding">{g.document_binding === "REGISTERED_DOCUMENT" ? "REGISTERED_DOCUMENT: exact registered text (the only trusted binding)" : g.document_binding === "UNTRUSTED_REFERENCE" ? "UNTRUSTED_REFERENCE: matched by reference only; proves nothing" : "NONE: no record"}</Row>
          </dl>
        ) : (
          <p>{v.state === "DRAFT" ? "No evidence attached yet." : "Evidence is attached and stored server-side. Source details appear after the gate evaluates it."}</p>
        )}
        <p className="muted">Evidence text is never shown or stored in this view; only the registered document id is.</p>
      </section>

      <section id="ifs-gate" className="card" aria-labelledby="ifs-h-gate">
        <h3 id="ifs-h-gate">3. Deterministic 11-proof gate</h3>
        {g ? (
          <>
            <p>
              Decision: <b data-decision={g.decision}>{DECISION_COPY[g.decision] ?? g.decision}</b> · rule <code>{g.rule}</code>
            </p>
            <p className="muted">Policy {g.policy_version} · evaluated {timeText(g.evaluated_at_ms)} · result valid until {timeText(g.expires_at_ms)}</p>
            <HoldReasons g={g} />
            <ProofTable g={g} />
            {g.decision === "ELIGIBLE_FOR_HUMAN_REVIEW" ? <p><b>Eligible for human review is not permission to pay.</b> Proof J holds by design: a person must still approve.</p> : null}
          </>
        ) : (
          <p>Not evaluated yet. The gate runs on the server, on server-held evidence only.</p>
        )}
      </section>

      <section id="ifs-approval" className="card" aria-labelledby="ifs-h-ap">
        <h3 id="ifs-h-ap">4. Human approval</h3>
        <p>Requirement: an authenticated operator must re-enter their passphrase to approve this exact proposal and gate result. Approval expires after 10 minutes and authorizes one submission attempt.</p>
        {v.authorization ? (
          <dl className="ifs-dl">
            <Row k="Status">{v.state === "EXPIRED" ? "Approved, then expired unused" : AFTER_INTENT.includes(v.state) ? "Approved and consumed by the single submission attempt" : "Approved, not yet used"}</Row>
            <Row k="Approved by">{v.authorization.operator_id}</Row>
            <Row k="Approved at">{timeText(v.authorization.approved_at_ms)}</Row>
            <Row k="Expires">{timeText(v.authorization.expires_at_ms)}</Row>
          </dl>
        ) : (
          <p><b>Authorization status: {v.state === "GATE_HOLD" || v.state === "GATE_REVIEW" ? "not available (gate did not find it eligible)" : v.state === "HUMAN_REJECTED" ? "rejected" : v.state === "EXPIRED" ? "none (expired before approval)" : "not approved"}.</b></p>
        )}
      </section>

      <section id="ifs-submission" className="card" aria-labelledby="ifs-h-sub">
        <h3 id="ifs-h-sub">5. Single submission attempt</h3>
        {sub.attempt_id ? (
          <dl className="ifs-dl">
            <Row k="Attempt">{sub.attempt_id} <span className="muted">recorded {timeText(sub.attempt_recorded_at_ms)}, before the provider call</span></Row>
            <Row k="Provider">{sub.provider_mode === "mock" ? "Mock provider (no network)" : sub.provider_mode === "sandbox" ? "Airwallex sandbox" : "not recorded"}</Row>
            <Row k="Create response">{sub.create_http_status === null ? "No response recorded" : <>HTTP {sub.create_http_status}{sub.create_reported_status ? <>, create response said <code>{sub.create_reported_status}</code> <span className="muted">(not a status read; never treated as the transfer's state)</span></> : null}</>}</Row>
            <Row k="Transfer id">{sub.provider_transfer_id ?? "unknown"}</Row>
          </dl>
        ) : (
          <p>No submission attempt exists for this flow.</p>
        )}
        {v.state === "SUBMISSION_UNCERTAIN" ? (
          <p className="ifs-callout ifs-bad" role="note"><b>Outcome unknown.</b> The create call may or may not have reached the provider. DRAWBRIDGE will not resend it. Only a provider read can establish what happened.</p>
        ) : null}
      </section>

      <section id="ifs-provider" className="card" aria-labelledby="ifs-h-pr">
        <h3 id="ifs-h-pr">6. Provider status (read-back)</h3>
        <dl className="ifs-dl">
          <Row k="Last provider read">{sub.last_provider_status ? <><code>{sub.last_provider_status}</code> at {timeText(sub.last_provider_read_at_ms)}</> : "No provider read recorded"}</Row>
          <Row k="Settlement"><b data-settlement>{settlementLine(v)}</b></Row>
        </dl>
        <p className="muted">Submitted, scheduled and processing are not settlement. Only a provider read returning PAID for the matching record is shown as PAID.</p>
      </section>

      {v.ledger ? (
        <section id="ifs-ledger" className="card" aria-labelledby="ifs-h-led">
          <h3 id="ifs-h-led">Funding ledger (synthetic)</h3>
          <dl className="ifs-dl">
            <Row k="Allocation">{v.ledger.allocation_id} · check {v.ledger.funding_check_version}</Row>
            <Row k="Reduction">{v.ledger.reduction_event_id ? <>{v.ledger.label}: event {v.ledger.reduction_event_id} at {timeText(v.ledger.reduced_at_ms)}</> : "No reduction posted"}</Row>
          </dl>
          <p className="muted">A reduction is drawn against a synthetic funding allocation. It is not a payment, not settlement and not proof that cash moved.</p>
        </section>
      ) : null}

      <section id="ifs-money" className="card" aria-labelledby="ifs-h-money">
        <h3 id="ifs-h-money">Which money is this?</h3>
        <div className="ifs-money">
          <div className="ifs-money-cell ifs-synthetic">
            <h4>Synthetic obligation</h4>
            <p className="ifs-big">{v.proposal.amount_display}</p>
            <p>From the synthetic registry fixture. Not a real invoice and not project cash.</p>
          </div>
          <div className="ifs-money-cell ifs-sandbox">
            <h4>{v.provider_mode === "mock" ? "Mock provider balance" : "Airwallex sandbox USD balance"}</h4>
            <p>
              {v.provider_mode === "mock"
                ? "Proof I was checked against the fixed test balance the contract defines for mock mode. It is not a provider balance."
                : "Proof I was checked against a live read of the Airwallex sandbox USD balance: test funds, not real money."}{" "}
              Never project cash.
            </p>
            <p data-balance>
              {v.balance_display === null
                ? "No balance reading was available to the gate."
                : v.provider_mode === "mock"
                  ? <>Fixed mock value: <b>{v.balance_display}</b> (not money)</>
                  : <>Sandbox USD available: <b>{v.balance_display}</b> (test funds)</>}
            </p>
            <p> Proof I: {g ? <>{g.proof_states.I}, “{g.proof_reasons.I}”</> : "not evaluated"}
            </p>
          </div>
          <div className="ifs-money-cell">
            <h4>E3 project figures</h4>
            <p>The E3 construction scenario (funding gap, project payables, ready to send) is a separate synthetic scenario. None of its figures appear here or feed this flow. <a href="/overview?s=S0">Open the Incident Room</a>.</p>
          </div>
        </div>
      </section>

      <section id="ifs-audit" className="card" aria-labelledby="ifs-h-au">
        <h3 id="ifs-h-au">Audit trail</h3>
        <p>
          {v.audit.verified ? "Chain verified" : <b>Chain NOT verified{v.audit.code ? ` (${v.audit.code})` : ""}</b>} · {v.audit.count} events · head <code>{v.audit.head.slice(0, 16)}…</code>
        </p>
        <p className="muted">A local hash chain detects accidental edits. It does not stop a same-user rewrite.</p>
      </section>

      <section id="ifs-actions" className="card" aria-labelledby="ifs-h-act">
        <h3 id="ifs-h-act">Next action</h3>
        <Actions v={v} c={preview ? null : controls} />
      </section>
    </article>
  );
}

// Scoped styles (globals.css is frozen). Uses the existing design tokens, so light/dark follow the app.
const CSS = `
.ifs{display:grid;gap:12px;min-width:0}
.ifs code{font-family:var(--mono);font-size:.85em;overflow-wrap:anywhere}
.ifs .card{min-width:0}
.ifs h3{font-size:1rem}
.ifs h4{font-size:.9rem;margin:0 0 4px}
.ifs-banner{padding:10px 12px;border-radius:var(--radius);border:1px solid var(--border)}
.ifs-head h2{margin:0 0 4px;font-size:1.15rem}
.ifs-flowid{font-size:.9rem}
.ifs-flowid code{font-size:.95em}
.ifs-pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78rem;font-weight:700;letter-spacing:.02em;border:1px solid currentColor;white-space:nowrap}
.ifs-ok{color:var(--ok);background:var(--ok-bg)}
.ifs-warn{color:var(--warn);background:var(--warn-bg)}
.ifs-bad{color:var(--danger);background:var(--danger-bg)}
.ifs-idle{color:var(--muted);background:var(--surface-2)}
.ifs-info{color:var(--accent);background:var(--surface-2)}
.ifs-banner.ifs-warn,.ifs-callout{color:var(--text)}
.ifs-callout{padding:10px 12px;border-radius:var(--radius);border-left:4px solid currentColor;margin:8px 0}
.ifs-callout.ifs-bad{border-left-color:var(--danger)}
.ifs-callout.ifs-warn{border-left-color:var(--warn)}
.ifs-callout ul{margin:4px 0 8px;padding-left:20px}
.ifs-mode{display:inline-block;font-size:.78rem;font-weight:700;padding:2px 8px;border-radius:6px;background:var(--synthetic-bg);color:var(--synthetic)}
.ifs-steps{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ifs-step{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text)}
.ifs-step[aria-current="step"]{border:2px solid var(--accent)}
.ifs-n{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:.85rem;border:2px solid currentColor}
.ifs-step.ifs-ok .ifs-n{color:var(--ok)}.ifs-step.ifs-bad .ifs-n{color:var(--danger)}.ifs-step.ifs-info .ifs-n{color:var(--accent)}.ifs-step.ifs-idle .ifs-n{color:var(--muted)}
.ifs-step-body{display:grid;gap:1px;min-width:0}
.ifs-step-body a{font-weight:600}
.ifs-step-status{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.ifs-step.ifs-ok .ifs-step-status{color:var(--ok)}.ifs-step.ifs-bad .ifs-step-status{color:var(--danger)}.ifs-step.ifs-info .ifs-step-status{color:var(--accent)}.ifs-step.ifs-idle .ifs-step-status{color:var(--muted)}
.ifs-step-sum{font-size:.85rem;color:var(--muted);overflow-wrap:anywhere}
.ifs-dl{display:grid;grid-template-columns:1fr;gap:2px 12px;margin:0}
.ifs-dl dt{font-size:.8rem;color:var(--muted);margin-top:6px}
.ifs-dl dd{margin:0;overflow-wrap:anywhere}
.ifs-proofs{width:100%;border-collapse:collapse;font-size:.9rem}
.ifs-proofs caption{text-align:left;color:var(--muted);font-size:.82rem;padding-bottom:4px}
.ifs-proofs th,.ifs-proofs td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.ifs-money{display:grid;gap:8px}
.ifs-money-cell{border:1px solid var(--border);border-radius:var(--radius);padding:10px}
.ifs-synthetic{border-left:4px solid var(--synthetic)}
.ifs-sandbox{border-left:4px solid var(--warn)}
.ifs-big{font-size:1.25rem;font-weight:700;margin:0}
.ifs-act{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 12px}
.ifs-act label{flex-basis:100%;font-size:.85rem}
.ifs-act input[type=password]{min-height:44px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font:inherit;width:100%;max-width:320px;background:var(--surface);color:var(--text)}
.ifs-act button{min-height:44px;padding:8px 14px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--surface);font:inherit;font-weight:600;cursor:pointer}
.ifs-act button:focus-visible,.ifs-act input:focus-visible,.ifs a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.ifs-act p{flex-basis:100%;margin:0;font-size:.82rem}
@media (max-width:640px){
  .ifs-proofs thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .ifs-proofs tr{display:grid;grid-template-columns:2.2em 1fr;gap:2px 8px;padding:8px 0;border-bottom:1px solid var(--border)}
  .ifs-proofs th,.ifs-proofs td{border:0;padding:0}
  .ifs-proofs th[scope=row]{grid-row:span 3;font-weight:700}
}
@media (min-width:720px){
  .ifs-dl{grid-template-columns:minmax(150px,max-content) 1fr}
  .ifs-dl dt{margin-top:0}
  .ifs-money{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (min-width:1000px){
  .ifs-steps{grid-template-columns:repeat(6,minmax(0,1fr))}
  .ifs-step{flex-direction:column}
}
`;
