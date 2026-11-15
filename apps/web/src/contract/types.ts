// Read-only snapshot shapes. Field names follow the financial contract (G1O candidate) vocabulary.
// Fixture files carry FACTS only. Every derived figure (AVAIL, NEW_RESERVABLE, ...) is computed in derive.ts.

export type ScenarioId = "S0" | "S1";

// The only provenance this front end accepts. Anything else is refused at the adapter boundary.
export type Provenance = "SYNTHETIC_FIXTURE";

export interface ProjectFacts {
  projectId: string;
  name: string;
  contractAmount: string;
  grossProfitBaseline: string;
}

export interface AllocationFacts {
  allocationId: string;
  basis: "PRE_DEBIT";
  // CASH(alpha): the posted journal balance of this allocation (accounting fact).
  cash: string;
}

export interface SandboxWalletFacts {
  label: string;
  amount: string;
  // Always false. The provider sandbox wallet is never project cash.
  isProjectCash: false;
}

export type Eligibility = "ELIGIBLE" | "DISPUTED" | "UNAPPROVED";

export interface ObligationFacts {
  obligationId: string;
  label: string;
  kind: "MATERIAL" | "SUBCONTRACTOR" | "CHANGE_ORDER";
  counterpartyLabel: string;
  amount: string;
  eligibility: Eligibility;
  eligibilityNote: string;
  payableClass: "INVOICE_BACKED" | "EVIDENCE_ATTESTED";
  // Display only. The authoritative reference is a database-normalized value this UI never computes.
  invoiceRefDisplay: string | null;
  lineageId: string;
  isLineageHead: boolean;
  hasNonterminalIntent: boolean;
  barred: boolean;
  // Part of the requested outflows of the scenario.
  requested: boolean;
}

export interface ExposureFacts {
  exposureId: string;
  obligationId: string;
  amount: string; // A(e)
  r: string; // reserved portion
  d: string; // debit-covered (settled net)
  u: string; // uncovered hold
  nRet: string; // returned
  nRes: string; // resolved, no exposure
}

export interface ReservationFacts {
  reservationId: string;
  obligationId: string;
  amount: string;
  state: "ACTIVE" | "APPROVED_READY";
}

export interface CaseFacts {
  caseId: string;
  scope: "OBLIGATION" | "ALLOCATION";
  obligationId: string | null;
  kind: string;
  state: "OPEN" | "RESOLVED";
  executionBlocking: boolean;
  unknownAmount: boolean;
  summary: string;
}

export interface RecorderEvent {
  seq: number;
  at: string; // fixed synthetic label, not a real clock reading
  kind: string;
  text: string;
  reference: string | null;
}

export interface RecurringItem {
  label: string;
  amount: string;
  fromWeek: number;
  toWeek: number;
  illustrative: boolean;
}

export interface DatedItem {
  label: string;
  direction: "IN" | "OUT";
  amount: string;
  dueDay: number | null; // day offset from the as-of date; null = no date known
  delayDays: number;
  illustrative: boolean;
}

export interface ForecastFacts {
  weeks: 13;
  scheduleRecordedThroughWeek: number;
  recurring: RecurringItem[];
  dated: DatedItem[];
}

export interface ApprovalPreview {
  obligationId: string;
  beneficiaryLabel: string;
  beneficiaryFingerprint: string;
  currency: "USD";
  amount: string;
  evidenceKind: string;
  evidenceDigestShort: string;
  policyRevision: string;
  preparer: string;
  approver: string;
}

export interface Snapshot {
  provenance: Provenance;
  scenarioId: ScenarioId;
  title: string;
  description: string;
  asOf: string;
  project: ProjectFacts;
  allocation: AllocationFacts;
  sandboxWallet: SandboxWalletFacts;
  obligations: ObligationFacts[];
  exposures: ExposureFacts[];
  reservations: ReservationFacts[];
  cases: CaseFacts[];
  events: RecorderEvent[];
  forecast: ForecastFacts;
  approvalPreview: ApprovalPreview;
}
