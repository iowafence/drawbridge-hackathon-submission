import { Shell } from "../../components/Shell.tsx";
import { loadScenario } from "../../data/load.ts";
import type { SearchParams } from "../../data/load.ts";
import { ObligationDetail, ObligationTable, PayablesSummary } from "../../components/PayablesView.tsx";

// Payables: request status, the eligible / excluded distinction, the reason each obligation cannot be paid, its approval
// dependency and its evidence gaps. Presentation only: no payment total is invented and nothing can be sent.
export default async function Payables({ searchParams }: { searchParams: SearchParams }) {
  const { id, d } = await loadScenario(searchParams);
  return (
    <Shell scenario={id} active="payables" requestedTotal={d.requestedTotal} additionalNotRequestedTotal={d.additionalNotRequestedTotal}>
      <p className="muted">
        Material and subcontractor payment exposure, with the holds and exclusions that keep money from moving.
        Capacity figures are derived per obligation from the lineage, never from a typed-in value.
      </p>
      <div className="cmd">
        <PayablesSummary d={d} />
        <ObligationTable d={d} scenario={id} />
        <div className="grid-2">
          {d.obligations.map((o) => (
            <ObligationDetail key={o.facts.obligationId} o={o} scenario={id} />
          ))}
        </div>
      </div>
    </Shell>
  );
}
