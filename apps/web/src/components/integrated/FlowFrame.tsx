// Page chrome for the integrated flow routes. Server component. Keeps the integrated flow visibly separate from the
// synthetic E3 Incident Room and from the historic one-transfer /sandbox screen.
import type { ReactNode } from "react";

export function FlowFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header>
        <div className="synthetic-bar" role="note">
          <div className="wrap">INTEGRATED FLOW (PRIVATE PROTOTYPE) · SYNTHETIC OBLIGATIONS · MOCK PROVIDER BY DEFAULT · NOT PROJECT CASH · NO REAL MONEY</div>
        </div>
      </header>
      <main id="main-content" className="wrap" tabIndex={-1} style={{ paddingTop: 16, paddingBottom: 40 }}>
        <p className="muted">
          <a href="/sandbox/flow">All flows</a> · <a href="/sandbox">Historic sandbox screen</a> · <a href="/overview?s=S0">Incident Room (synthetic E3, separate)</a>
        </p>
        <h1>{title}</h1>
        {children}
      </main>
    </>
  );
}
