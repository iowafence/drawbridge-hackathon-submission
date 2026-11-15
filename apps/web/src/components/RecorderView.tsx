// Recorder screen building blocks (ERP redesign). Server components only: nothing is edited, recomputed or invented.
// Events, digests, evidence and provenance are displayed exactly as the committed E3 evidence snapshot records them.
// The only check made here is that each event's recorded predecessor digest equals the previous event's recorded digest.
import { Pill } from "./Figure.tsx";
import { cashCrisis } from "../data/cashCrisis.ts";

const ZERO = "0".repeat(64);
const events = [...cashCrisis.events].sort((a, b) => a.sequence - b.sequence);

function linkedCount(): number {
  return events.filter((e, i) => (i === 0 ? e.prevSha256 === ZERO : e.prevSha256 === events[i - 1].sha256)).length;
}

/** What the chain shows, and what it does not claim. */
export function ChainSummary() {
  const linked = linkedCount();
  const ok = linked === events.length;
  return (
    <section className={`answer ${ok ? "answer-ok" : "answer-gap"}`} aria-label="Chain summary" data-recorder-summary="">
      <div className="answer-head">
        <span className={`answer-tag ${ok ? "ok" : "gap"}`}>{ok ? "LINKS CONSISTENT" : "LINK MISMATCH"}</span>
        <h2>
          {events.length} recorded events, {linked} of {events.length} predecessor links match
        </h2>
      </div>
      <p>
        Each event records the SHA-256 digest of the event before it, so changing an earlier event would break every
        later link. This detects edits to the recorded history. It is not an externally anchored proof: no outside
        timestamp, ledger or witness holds these digests.
      </p>
    </section>
  );
}

/** The six events in order, each joined to its predecessor by digest. */
export function HashChain() {
  return (
    <section id="rec-chain" className="panel" aria-labelledby="rec-chain-title">
      <div className="panel-head">
        <h2 id="rec-chain-title">Hash chain</h2>
        <span className="muted">Oldest first. Digests are shown in full, as recorded.</span>
      </div>
      <ol className="chain">
        {events.map((e, i) => {
          const linked = i === 0 ? e.prevSha256 === ZERO : e.prevSha256 === events[i - 1].sha256;
          return (
            <li key={e.id} data-recorder-event={e.sequence}>
              <div className="decision-head">
                <span className="chip">#{e.sequence}</span>
                <strong>{e.title}</strong>
                <span className="chip">{e.role}</span>
                <span className="muted history-when">{e.when}</span>
                <Pill tone={linked ? "ok" : "danger"}>{i === 0 ? (linked ? "ROOT · ZERO PREDECESSOR" : "ROOT MISMATCH") : linked ? `LINKED TO #${events[i - 1].sequence}` : "LINK MISMATCH"}</Pill>
              </div>
              <div className="history-text">{e.finding}</div>
              <div className="chips">
                <span className="state-label">Evidence</span>
                {e.evidenceIds.map((ev) => (
                  <span key={ev} className="chip mono">
                    {ev}
                  </span>
                ))}
                <span className="chip">{e.type.replace("_", " ")}</span>
              </div>
              <dl className="digests">
                <dt>prev</dt>
                <dd className="digest">{e.prevSha256}</dd>
                <dt>sha256</dt>
                <dd className="digest digest-own">{e.sha256}</dd>
              </dl>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Who decided what: agent findings are not human decisions. */
export function Authorship() {
  const byRole = new Map<string, number>();
  for (const e of events) byRole.set(e.role, (byRole.get(e.role) ?? 0) + 1);
  const c = cashCrisis.controls;
  return (
    <section id="rec-authorship" className="panel" aria-labelledby="rec-authorship-title">
      <div className="panel-head">
        <h2 id="rec-authorship-title">Human decisions and agent recommendations</h2>
      </div>
      <div className="split">
        <div className="split-col">
          <div className="state-label">Human decisions recorded</div>
          <div className="state-value">0</div>
          <p className="muted">
            No approval, release or resolution by a person is recorded. Human identity verification is{" "}
            {c.humanIdentityVerified ? "enabled" : "not implemented"}, and automated decision authority is{" "}
            {c.automatedDecisionAuthority ? "granted" : "none"}.
          </p>
        </div>
        <div className="split-col">
          <div className="state-label">Agent findings recorded</div>
          <div className="state-value">{events.length}</div>
          <ul className="clean">
            {[...byRole.entries()].map(([role, n]) => (
              <li key={role}>
                <span className="mono">{role}</span>: {n} {n === 1 ? "event" : "events"}
              </li>
            ))}
          </ul>
          <p className="muted">Findings recommend and explain. They are not approvals.</p>
        </div>
      </div>
    </section>
  );
}

/** Every evidence record, with the events that cite it. */
export function EvidenceIndex() {
  return (
    <section id="rec-evidence" className="panel" aria-labelledby="rec-evidence-title">
      <div className="panel-head">
        <h2 id="rec-evidence-title">Evidence index</h2>
        <span className="muted">{cashCrisis.evidence.length} records, all synthetic.</span>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Evidence index, scrollable">
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
              <th scope="col">Cited by events</th>
            </tr>
          </thead>
          <tbody>
            {cashCrisis.evidence.map((ev) => (
              <tr key={ev.id}>
                <td>
                  <span className="mono rule-id">{ev.id}</span>
                  <div>{ev.title}</div>
                </td>
                <td>{ev.kind}</td>
                <td>
                  <span className="chip nowrap">{ev.status}</span>
                </td>
                <td>{ev.detail}</td>
                <td className="mono">
                  {events
                    .filter((e) => e.evidenceIds.includes(ev.id))
                    .map((e) => `#${e.sequence}`)
                    .join(", ") || "none"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Provenance() {
  const c = cashCrisis;
  return (
    <section id="rec-provenance" className="panel" aria-labelledby="rec-provenance-title">
      <div className="panel-head">
        <h2 id="rec-provenance-title">Source and provenance</h2>
      </div>
      <dl className="kv panel-body prov">
        <dt>Classification</dt>
        <dd>{c.classification}</dd>
        <dt>Snapshot schema</dt>
        <dd className="mono">{c.schema}</dd>
        <dt>Task</dt>
        <dd className="mono">{c.task}</dd>
        <dt>Synthetic input fixture</dt>
        <dd className="mono">
          {c.fixture.id} · {c.fixture.path}
        </dd>
        <dt>Input fixture SHA-256</dt>
        <dd className="mono">{c.fixture.sha256}</dd>
        <dt>Snapshot content SHA-256</dt>
        <dd className="mono">{c.snapshotContentSha256}</dd>
      </dl>
      <div className="panel-foot">The snapshot content digest is recorded inside the snapshot; it is not the file hash.</div>
    </section>
  );
}

export function SimulationDisclosures() {
  const c = cashCrisis.controls;
  const rows: [string, string][] = [
    ["Synthetic only", c.syntheticOnly ? "Yes" : "No"],
    ["Read-only", c.readOnly ? "Yes" : "No"],
    ["Provider writes", String(c.providerWrites)],
    ["Database writes", String(c.databaseWrites)],
    ["Real payment authority", c.realPaymentAuthority ? "Yes" : "None"],
    ["Release interface", c.releaseInterfaceExists ? "Exists" : "None"],
  ];
  return (
    <section id="rec-limits" className="panel" aria-labelledby="rec-limits-title">
      <div className="panel-head">
        <h2 id="rec-limits-title">Simulation-only disclosures</h2>
      </div>
      <div className="states">
        {rows.map(([k, v]) => (
          <div key={k} className="state">
            <div className="state-label">{k}</div>
            <div className="state-value">{v}</div>
          </div>
        ))}
      </div>
      <ul className="clean roles">
        {cashCrisis.limitations.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}
