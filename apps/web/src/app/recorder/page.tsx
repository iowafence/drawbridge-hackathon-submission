import { Pill } from "../../components/Figure.tsx";
import { Shell } from "../../components/Shell.tsx";
import { loadScenario } from "../../data/load.ts";
import type { SearchParams } from "../../data/load.ts";
import {
  Authorship,
  ChainSummary,
  EvidenceIndex,
  HashChain,
  Provenance,
  SimulationDisclosures,
} from "../../components/RecorderView.tsx";

// Recorder: the evidence chain as a demonstration feature. The six recorded events, their order and digest links, the
// evidence behind them, who decided what, and the simulation-only limits. The scenario ledger detail that was here before
// is unchanged and sits one click away under "Scenario ledger and reconciliation".
export default async function Recorder({ searchParams }: { searchParams: SearchParams }) {
  const { id, snap, d } = await loadScenario(searchParams);
  return (
    <Shell scenario={id} active="recorder" requestedTotal={d.requestedTotal} additionalNotRequestedTotal={d.additionalNotRequestedTotal}>
      <p className="muted">
        An append-only view of what happened, oldest first. Entries are never edited or removed; a correction is a new
        entry. Times are synthetic labels, not clock readings.
      </p>
      <div className="cmd">
        <ChainSummary />
        <div className="cmd-grid">
          <div className="cmd-main">
            <HashChain />
            <EvidenceIndex />
          </div>
          <aside className="cmd-side" aria-label="Authorship, provenance and limits">
            <Authorship />
            <Provenance />
            <SimulationDisclosures />
          </aside>
        </div>

        <details className="evidence">
          <summary>Scenario ledger and reconciliation: allocation events, open cases and send-timing cases</summary>
          <section className="card">
            <h2>
              Event history <Pill tone="synthetic">SYNTHETIC</Pill>
            </h2>
            <ol className="timeline">
              {snap.events.map((e) => (
                <li key={e.seq}>
                  <div>
                    <Pill>{e.kind}</Pill> <span className="muted">{e.at}</span>
                  </div>
                  <div>{e.text}</div>
                  {e.reference ? <div className="mono muted">{e.reference}</div> : null}
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h2>Reconciliation state</h2>
            <ul className="clean">
              {snap.cases.map((c) => (
                <li key={c.caseId}>
                  <b>{c.caseId}</b> <Pill tone={c.state === "OPEN" ? "danger" : "ok"}>{c.state}</Pill>{" "}
                  <Pill>{c.scope === "ALLOCATION" ? "allocation-wide" : "obligation"}</Pill>
                  <div className="muted">{c.summary}</div>
                </li>
              ))}
            </ul>
            <p className="muted">Open cases: {d.openCases}. Resending is not possible from any screen.</p>
          </section>

          <section className="card">
            <h2>When a bar or stop arrives near a send</h2>
            <p className="muted">
              The database orders its own commits. It cannot reach into the provider. The contract states three cases and
              does not claim to eliminate the second.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>When the bar or stop commits</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>A</td>
                    <td>Before the final pre-send check</td>
                    <td>The check refuses. No POST. Marked UNCERTAIN, never resent.</td>
                  </tr>
                  <tr>
                    <td>B</td>
                    <td>After a successful check, before the POST leaves</td>
                    <td>The POST may still proceed. An incident is opened.</td>
                  </tr>
                  <tr>
                    <td>C</td>
                    <td>After the POST was transmitted</td>
                    <td>Nothing can be recalled. An incident is opened.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </details>
      </div>
    </Shell>
  );
}
