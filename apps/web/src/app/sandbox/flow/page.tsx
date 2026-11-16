// Integrated flow index (contract flow-v1, A6). Server component. 404 unless DB_INTEGRATED_FLOW_ENABLED=1 with a valid
// configuration (A7 readIntegratedFlags, fail closed). Until A7 wires A3's flow service, this page lists only the
// labelled UI fixture previews; it never shows a fixture as a live flow.
import { notFound } from "next/navigation";
import { readIntegratedFlags } from "../../../../integrated/flags.ts";
import { FlowFrame } from "../../../components/integrated/FlowFrame.tsx";
import { FIXTURE_PROVENANCE, FIXTURE_VIEWS } from "../../../components/integrated/fixtureViews.ts";
import { STATE_COPY } from "../../../components/integrated/labels.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "DRAWBRIDGE · Integrated flow" };

export default async function FlowIndex() {
  if (typeof readIntegratedFlags() === "string") notFound();
  return (
    <FlowFrame title="Integrated transaction flow">
      <p>
        One flow ID carries a synthetic obligation through evidence, the deterministic 11-proof gate, a separate human approval, at most one
        provider submission and provider read-back. <b>Eligible is not approved, approved is not sent, and processing is not paid.</b>
      </p>
      <section className="card" aria-labelledby="h-live">
        <h2 id="h-live">Live flows</h2>
        <p>The live flow service is not connected in this build. No live flow is listed.</p>
      </section>
      <section className="card" aria-labelledby="h-prev">
        <h2 id="h-prev">UI fixture previews (not live flows)</h2>
        <p className="muted">{FIXTURE_PROVENANCE}</p>
        <ul className="ifs-index">
          {FIXTURE_VIEWS.map((v) => (
            <li key={v.fixture.id}>
              <a href={`/sandbox/flow/${v.fixture.id}`}>{v.fixture.label}</a>{" "}
              <span className="muted">· preview state {STATE_COPY[v.state].label} · {v.proposal.reference} · {v.proposal.amount_display} (synthetic)</span>
            </li>
          ))}
        </ul>
      </section>
    </FlowFrame>
  );
}
