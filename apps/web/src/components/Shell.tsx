import Link from "next/link";
import type { ReactNode } from "react";
import { fixtureAdapter } from "../data/adapter.ts";
import type { ScenarioId } from "../contract/types.ts";
import { formatMoney } from "../contract/money.ts";

export type ScreenKey = "overview" | "payables" | "incident" | "approvals" | "recorder" | "eligibility";

const SCREENS: { key: ScreenKey; n: number; label: string; long: string }[] = [
  { key: "overview", n: 1, label: "Command", long: "Command" },
  { key: "payables", n: 2, label: "Payables", long: "Obligations and exclusions" },
  { key: "incident", n: 3, label: "Incident", long: "Incident detail" },
  { key: "approvals", n: 4, label: "Approvals", long: "Approval queue" },
  { key: "recorder", n: 5, label: "Recorder", long: "Flight recorder" },
  { key: "eligibility", n: 6, label: "Eligibility", long: "Capital eligibility (synthetic)" },
];

export function screenHref(key: ScreenKey, scenario: ScenarioId): string {
  return `/${key}?s=${scenario}`;
}

export function Shell(props: {
  scenario: ScenarioId;
  active: ScreenKey;
  requestedTotal: bigint;
  additionalNotRequestedTotal: bigint;
  children: ReactNode;
}) {
  const { scenario, active, requestedTotal, additionalNotRequestedTotal, children } = props;
  const current = SCREENS.find((s) => s.key === active)!;
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header>
        <div className="synthetic-bar" role="note">
          <div className="wrap">
            SYNTHETIC DEMONSTRATION DATA. This is not authoritative financial state. Read-only. No bank connection, no
            money authority.
          </div>
        </div>
        <div className="wrap topbar">
          <div className="brand">
            <b className="brand-name">DRAWBRIDGE</b>
            <span className="muted">Incident Room · screen {current.n} of {SCREENS.length}</span>
          </div>
          <div className="scenario-switch" role="group" aria-label="Synthetic scenario">
            {fixtureAdapter.listScenarios().map((sc) => (
              <Link
                key={sc.id}
                href={screenHref(active, sc.id)}
                aria-current={sc.id === scenario ? "true" : undefined}
                title={sc.summary}
              >
                {sc.label}
              </Link>
            ))}
          </div>
        </div>
      </header>
      <aside className="wrap scenario-scope" aria-label="Scenario amount populations">
        <strong>Original requested outflows: {formatMoney(requestedTotal)}.</strong>{" "}
        Separate framing payable: {formatMoney(additionalNotRequestedTotal)}; excluded from the original total.
      </aside>
      <nav className="tabs" aria-label="Incident Room screens">
        <div className="side-brand" aria-hidden="true">
          <span className="side-mark" />
          <b>DRAWBRIDGE</b>
          <span className="side-sub">DB-DEMO-001</span>
        </div>
        {SCREENS.map((s) => (
          <Link
            key={s.key}
            href={screenHref(s.key, scenario)}
            aria-current={s.key === active ? "page" : undefined}
          >
            <span className="n">{s.n}</span>
            <span>{s.label}</span>
          </Link>
        ))}
      </nav>
      <main className="wrap" id="main-content" tabIndex={-1}>
        <h1>{current.long}</h1>
        {children}
        <footer className="provenance">
          Source: SYNTHETIC_FIXTURE via the read-only fixture adapter. Figures are derived on screen from fixture facts
          using the formulas of the financial contract candidate (design only, not frozen, tests not run). Nothing here
          is a payment authority, an approval, or a record of a real bank balance.
        </footer>
      </main>
    </>
  );
}
