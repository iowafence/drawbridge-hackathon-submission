// SIM-ENG-002-E3 / E3-D5 — read-only access to the committed cash-crisis evidence snapshot (E3-D4).
// This module validates the snapshot strictly and exposes it to the Overview and Incident screens. It computes no
// decision and no forecast figure: every amount shown comes from the snapshot in integer cents and is only checked
// for internal agreement and formatted. A snapshot that fails any check is refused, never repaired or defaulted.
// Synthetic, non-operational demonstration. No network, provider, database or credential pathway exists here.
import snapshot from "../../fixtures/cash_crisis_evidence_v1.json" with { type: "json" };
import eligibilityEvidence from "../../fixtures/eligibility_evidence_v1.json" with { type: "json" };
import { addCents, subtractCents } from "../contract/money.ts";
import type { Cents } from "../contract/money.ts";
import type { ScenarioId } from "../contract/types.ts";

export const CASH_CRISIS_SCHEMA = "drawbridge.sim-eng-002-e3.cash-crisis-evidence.v1";
export const CASH_CRISIS_TASK = "SIM-ENG-002-E3";
export const CASH_CRISIS_FIXTURE_PATH = "apps/web/fixtures/cash_crisis_evidence_v1.json";
export const SCENARIO_IDS = ["S0", "S1"] as const;

export const FUNDING_CASES = ["on_time", "delayed"] as const;
export type FundingCase = (typeof FUNDING_CASES)[number];
/** The documented default: a link that carries no funding case (the Shell's scenario switch) shows the delayed case. */
export const DEFAULT_FUNDING_CASE: FundingCase = "delayed";
export const FUNDING_CASE_PARAM = "d";
export const FUNDING_CASE_LABEL: Record<FundingCase, string> = {
  on_time: "Owner draw on time",
  delayed: "Owner draw 12 days late",
};

export const DECISION_STATUSES = ["BLOCKED", "UNRESOLVED", "EVIDENCE_ELIGIBLE"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export const RELEASE_NOT_AUTHORIZED = "NOT_AUTHORIZED";
export const REPEAT_ATTEMPTS = ["BLOCKED", "NOT_APPLICABLE"] as const;
export type RepeatAttempt = (typeof REPEAT_ATTEMPTS)[number];
export const ROW_QUALITIES = ["ILLUSTRATIVE", "INCOMPLETE_LATE_HORIZON"] as const;
export type RowQuality = (typeof ROW_QUALITIES)[number];
export const FORECAST_WEEKS = 13;

export const E3_OVERVIEW_ANCHOR = "e3-cash-crisis";
export const E3_INCIDENT_ANCHOR = "e3-incident";
export const E3_EVIDENCE_LIST_ANCHOR = "e3-evidence";

export interface CashCrisisDecision {
  /** The snapshot's decision_id, unique across both scenarios. */
  id: string;
  requestId: string;
  obligationId: string;
  scenario: ScenarioId;
  description: string;
  party: string;
  amount: Cents;
  status: DecisionStatus;
  ruleIds: string[];
  rationale: string[];
  evidenceIds: string[];
  releaseStatus: string;
  repeatAttempt: RepeatAttempt;
  humanApprovalRequired: boolean;
  inImmediateRequests: boolean;
  newCommitmentAuthority: boolean;
  newReservationPermitted: boolean;
  providerWrites: number;
  databaseWrites: number;
}

export interface ForecastRow {
  week: number;
  start: string;
  end: string;
  opening: Cents;
  receipts: Cents;
  ownerDrawReceipt: Cents;
  otherReceipts: Cents;
  receiptIds: string[];
  outflow: Cents;
  payroll: Cents;
  projectSpend: Cents;
  closing: Cents;
  negative: boolean;
  quality: RowQuality;
  basis: string;
}

export interface CashCrisisForecastView {
  rows: ForecastRow[];
  drawWeek: number;
  drawDate: string;
  openingCash: Cents;
  totalReceipts: Cents;
  totalOutflows: Cents;
  endingCash: Cents;
  minimumClosing: Cents;
  peakFundingGap: Cents;
  fundingGapBasis: string;
  worstWeek: number;
  negativeWeekCount: number;
  firstNegativeWeek: number | null;
  incompleteWeeks: number[];
  limitations: string[];
}

export interface CashCrisisEvidence {
  id: string;
  kind: string;
  status: string;
  title: string;
  detail: string;
}

export interface CashCrisisEvent {
  id: string;
  sequence: number;
  when: string;
  role: string;
  type: string;
  title: string;
  finding: string;
  evidenceIds: string[];
  sha256: string;
  prevSha256: string;
}

export interface CashCrisisFinding {
  role: string;
  finding: string;
  boundary: string;
  evidenceIds: string[];
}

export interface CashCrisisView {
  schema: string;
  task: string;
  classification: string;
  currency: string;
  amountUnit: string;
  fixture: { id: string; path: string; sha256: string };
  snapshotContentSha256: string;
  project: {
    id: string;
    label: string;
    contract: Cents;
    projectedGrossProfit: Cents;
    grossMarginBasisPoints: number;
    openingOperatingCash: Cents;
  };
  scenarios: { id: ScenarioId; newCommitmentAuthority: boolean; note: string }[];
  draw: {
    amount: Cents;
    delayDays: number;
    onTimeDate: string;
    delayedDate: string;
    onTimeWeek: number;
    delayedWeek: number;
    evidenceId: string;
    receiptId: string;
    basis: string;
    status: string;
  };
  forecastInputs: {
    startDate: string;
    weeks: number;
    openingBasis: string;
    otherReceipts: { id: string; date: string; amount: Cents; basis: string; status: string }[];
  };
  capital: {
    allocation: Cents;
    concreteHold: Cents;
    holdApplicationCount: number;
    holdApplications: { requestId: string; obligationId: string; amount: Cents; evidenceIds: string[] }[];
    availableAfterHold: Cents;
    calculatedAvailable: Record<ScenarioId, Cents>;
    immediateRequests: Cents;
    immediateRequestIds: string[];
    nominalOverAllocation: Cents;
    separatePayable: Cents;
    separatePayableRequestIds: string[];
    eligibilityReference: { reserve: Cents; initialAvailability: Cents; note: string };
    newReservable: Record<ScenarioId, Cents>;
    notes: string[];
  };
  decisions: Record<ScenarioId, CashCrisisDecision[]>;
  decisionCounts: Record<ScenarioId, Record<DecisionStatus | "TOTAL", number>>;
  forecasts: Record<FundingCase, CashCrisisForecastView>;
  events: CashCrisisEvent[];
  evidence: CashCrisisEvidence[];
  findings: CashCrisisFinding[];
  assumptions: { id: string; label: string; subject: string; text: string }[];
  rules: { id: string; text: string }[];
  limitations: string[];
  controls: {
    syntheticOnly: boolean;
    readOnly: boolean;
    providerWrites: number;
    databaseWrites: number;
    realPaymentAuthority: boolean;
    releaseInterfaceExists: boolean;
    humanIdentityVerified: boolean;
    automatedDecisionAuthority: boolean;
  };
}

/** The accepted E2 eligibility demonstration's own figures, read from its committed evidence and never altered. */
export interface EligibilityReference {
  allocation: Cents;
  holdsDeducted: Cents;
  restrictedReserves: Cents;
  availableToCommit: Cents;
}

type Obj = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/;
const ZERO_DIGEST = "0".repeat(64);
const ISO_DATE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
// Identifiers become element ids and link fragments, so only a closed, fragment-safe shape is accepted.
const IDENTIFIER = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;

function fail(path: string, problem: string): never {
  throw new Error(`cash-crisis snapshot: ${path}: ${problem}`);
}
function obj(v: unknown, path: string, keys: readonly string[]): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(path, "expected object");
  const have = Object.keys(v as Obj).sort();
  const want = [...keys].sort();
  const missing = want.filter((k) => !have.includes(k));
  const unknown = have.filter((k) => !want.includes(k));
  if (missing.length > 0) fail(path, `missing key(s) ${missing.join(", ")}`);
  if (unknown.length > 0) fail(path, `unknown key(s) ${unknown.join(", ")}`);
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "expected array");
  return v as unknown[];
}
function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) fail(path, "expected non-empty string");
  return v as string;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "expected boolean");
  return v as boolean;
}
function int(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(path, "expected integer");
  return v as number;
}
function count(v: unknown, path: string): number {
  const n = int(v, path);
  if (n < 0) fail(path, "expected non-negative integer");
  return n;
}
/** Integer minor units only. A float, a string, a boolean or a missing value is refused, never read as zero. */
function cents(v: unknown, path: string): Cents {
  return BigInt(int(v, path));
}
function nonNegativeCents(v: unknown, path: string): Cents {
  const c = cents(v, path);
  if (c < 0n) fail(path, "expected non-negative amount");
  return c;
}
function identifier(v: unknown, path: string): string {
  const s = str(v, path);
  if (!IDENTIFIER.test(s)) fail(path, `malformed identifier ${JSON.stringify(s)}`);
  return s;
}
function digest(v: unknown, path: string): string {
  const s = str(v, path);
  if (!SHA256.test(s)) fail(path, "expected lowercase SHA-256");
  return s;
}
function isoDate(v: unknown, path: string): string {
  const s = str(v, path);
  if (!ISO_DATE.test(s)) fail(path, "expected YYYY-MM-DD date");
  return s;
}
function strings(v: unknown, path: string): string[] {
  return arr(v, path).map((x, i) => str(x, `${path}[${i}]`));
}
function identifiers(v: unknown, path: string): string[] {
  const ids = arr(v, path).map((x, i) => identifier(x, `${path}[${i}]`));
  if (ids.length === 0) fail(path, "expected at least one identifier");
  if (new Set(ids).size !== ids.length) fail(path, "duplicate identifier");
  return ids;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  const s = str(v, path);
  if (!(allowed as readonly string[]).includes(s)) fail(path, `unknown value ${JSON.stringify(s)}`);
  return s as T;
}

const TOP_KEYS = [
  "amount_unit", "assumptions", "capital", "classification", "controls", "currency", "decision_counts", "decisions",
  "draw", "events", "evidence", "findings", "fixture", "forecast_inputs", "forecasts", "limitations", "project",
  "rules", "scenarios", "schema", "snapshot_content_sha256", "synthetic", "task",
] as const;
const FIXTURE_KEYS = ["fixture_id", "path", "sha256"] as const;
const PROJECT_KEYS = ["contract_cents", "gross_margin_basis_points", "label", "project_id", "projected_gross_profit_cents"] as const;
const SCENARIO_KEYS = ["id", "new_commitment_authority", "note"] as const;
const DRAW_KEYS = [
  "amount_cents", "basis", "delay_days", "delayed_date", "delayed_week", "evidence_id", "on_time_week", "receipt_id",
  "scheduled_date", "status",
] as const;
const FORECAST_INPUT_KEYS = ["opening_basis", "opening_operating_cash_cents", "other_receipts", "start_date", "weeks"] as const;
const OTHER_RECEIPT_KEYS = ["amount_cents", "basis", "date", "id", "status"] as const;
const CAPITAL_KEYS = [
  "allocation_cents", "available_after_hold_cents", "calculated_available_by_scenario_cents", "concrete_hold_cents",
  "eligibility_demo_reference", "hold_application_count", "hold_applications", "immediate_request_ids",
  "immediate_requests_cents", "new_reservable_by_scenario_cents", "nominal_gap_cents", "notes", "separate_payable_cents",
  "separate_payable_in_immediate_requests", "separate_payable_request_ids",
] as const;
const ELIGIBILITY_REFERENCE_KEYS = ["applied_in_this_model", "initial_availability_cents", "note", "reserve_cents"] as const;
const HOLD_APPLICATION_KEYS = ["amount_cents", "evidence_ids", "obligation_id", "request_id"] as const;
const DECISION_KEYS = [
  "amount_cents", "database_writes", "decision_id", "description", "evidence_ids", "facts", "human_approval_required",
  "in_immediate_requests", "new_commitment_authority", "new_reservation_permitted", "obligation_id", "party",
  "provider_writes", "rationale", "release_status", "repeat_attempt", "request_id", "rule_ids", "scenario", "status",
] as const;
// The evidence flags are checked for shape only. They are never read to reach a decision in this application.
const FACT_KEYS = ["change_order_signed", "disputed", "evidence_complete", "prior_transfer_state"] as const;
const DECISION_COUNT_KEYS = ["BLOCKED", "EVIDENCE_ELIGIBLE", "TOTAL", "UNRESOLVED"] as const;
const FORECAST_KEYS = [
  "case", "draw_date", "draw_week", "ending_cash_cents", "first_negative_week", "funding_gap_basis", "incomplete_weeks",
  "limitations", "minimum_closing_cents", "negative_week_count", "opening_cash_cents",
  "peak_projected_funding_gap_cents", "rows", "total_outflows_cents", "total_receipts_cents", "worst_week",
] as const;
const ROW_KEYS = [
  "basis", "closing_cents", "end", "negative", "opening_cents", "other_receipts_cents", "outflows_cents",
  "owner_draw_receipt_cents", "payroll_cents", "project_spend_cents", "quality", "receipt_ids", "receipts_cents",
  "start", "week",
] as const;
const EVENT_KEYS = [
  "evidence_ids", "finding", "id", "prev_sha256", "role", "sequence", "sha256", "title", "type", "when",
] as const;
const EVIDENCE_KEYS = ["detail", "id", "kind", "status", "title"] as const;
const FINDING_KEYS = ["boundary", "evidence_ids", "finding", "role"] as const;
const ASSUMPTION_KEYS = ["id", "label", "subject", "text"] as const;
const CONTROL_KEYS = [
  "automated_decision_authority", "database_writes", "human_identity_verified", "provider_writes", "read_only",
  "real_payment_authority", "release_interface_exists", "synthetic_only",
] as const;

function scenarioId(v: unknown, path: string): ScenarioId {
  return oneOf(v, SCENARIO_IDS, path);
}

function decision(raw: unknown, path: string, scenario: ScenarioId, rules: Map<string, string>): CashCrisisDecision {
  const o = obj(raw, path, DECISION_KEYS);
  const facts = obj(o.facts, `${path}.facts`, FACT_KEYS);
  bool(facts.change_order_signed, `${path}.facts.change_order_signed`);
  bool(facts.disputed, `${path}.facts.disputed`);
  bool(facts.evidence_complete, `${path}.facts.evidence_complete`);
  str(facts.prior_transfer_state, `${path}.facts.prior_transfer_state`);
  if (scenarioId(o.scenario, `${path}.scenario`) !== scenario) fail(`${path}.scenario`, `decision is not filed under ${scenario}`);
  const releaseStatus = str(o.release_status, `${path}.release_status`);
  if (releaseStatus !== RELEASE_NOT_AUTHORIZED) fail(`${path}.release_status`, "a release status other than NOT_AUTHORIZED is refused");
  const providerWrites = count(o.provider_writes, `${path}.provider_writes`);
  if (providerWrites !== 0) fail(`${path}.provider_writes`, "must be 0");
  const databaseWrites = count(o.database_writes, `${path}.database_writes`);
  if (databaseWrites !== 0) fail(`${path}.database_writes`, "must be 0");
  const humanApprovalRequired = bool(o.human_approval_required, `${path}.human_approval_required`);
  if (!humanApprovalRequired) fail(`${path}.human_approval_required`, "must be true");
  const ruleIds = identifiers(o.rule_ids, `${path}.rule_ids`);
  const rationale = strings(o.rationale, `${path}.rationale`);
  if (rationale.length !== ruleIds.length) fail(`${path}.rationale`, "one rationale line per rule identifier is required");
  ruleIds.forEach((rule, i) => {
    if (!rules.has(rule)) fail(`${path}.rule_ids[${i}]`, `cites unknown rule ${rule}`);
    if (rules.get(rule) !== rationale[i]) fail(`${path}.rationale[${i}]`, `is not the text of ${rule}`);
  });
  const requestId = identifier(o.request_id, `${path}.request_id`);
  const id = identifier(o.decision_id, `${path}.decision_id`);
  if (!id.includes(scenario) || !id.endsWith(requestId)) fail(`${path}.decision_id`, "does not name its scenario and request");
  return {
    id,
    requestId,
    obligationId: identifier(o.obligation_id, `${path}.obligation_id`),
    scenario,
    description: str(o.description, `${path}.description`),
    party: str(o.party, `${path}.party`),
    amount: nonNegativeCents(o.amount_cents, `${path}.amount_cents`),
    status: oneOf(o.status, DECISION_STATUSES, `${path}.status`),
    ruleIds,
    rationale,
    evidenceIds: identifiers(o.evidence_ids, `${path}.evidence_ids`),
    releaseStatus,
    repeatAttempt: oneOf(o.repeat_attempt, REPEAT_ATTEMPTS, `${path}.repeat_attempt`),
    humanApprovalRequired,
    inImmediateRequests: bool(o.in_immediate_requests, `${path}.in_immediate_requests`),
    newCommitmentAuthority: bool(o.new_commitment_authority, `${path}.new_commitment_authority`),
    newReservationPermitted: bool(o.new_reservation_permitted, `${path}.new_reservation_permitted`),
    providerWrites,
    databaseWrites,
  };
}

function forecast(raw: unknown, path: string, fundingCase: FundingCase, drawAmount: Cents): CashCrisisForecastView {
  const o = obj(raw, path, FORECAST_KEYS);
  if (str(o.case, `${path}.case`) !== fundingCase) fail(`${path}.case`, `is not ${fundingCase}`);
  const rawRows = arr(o.rows, `${path}.rows`);
  if (rawRows.length !== FORECAST_WEEKS) fail(`${path}.rows`, `expected ${FORECAST_WEEKS} weekly rows`);
  const rows = rawRows.map((r, i): ForecastRow => {
    const p = `${path}.rows[${i}]`;
    const x = obj(r, p, ROW_KEYS);
    const row: ForecastRow = {
      week: int(x.week, `${p}.week`),
      start: isoDate(x.start, `${p}.start`),
      end: isoDate(x.end, `${p}.end`),
      opening: cents(x.opening_cents, `${p}.opening_cents`),
      receipts: nonNegativeCents(x.receipts_cents, `${p}.receipts_cents`),
      ownerDrawReceipt: nonNegativeCents(x.owner_draw_receipt_cents, `${p}.owner_draw_receipt_cents`),
      otherReceipts: nonNegativeCents(x.other_receipts_cents, `${p}.other_receipts_cents`),
      receiptIds: arr(x.receipt_ids, `${p}.receipt_ids`).map((id, j) => identifier(id, `${p}.receipt_ids[${j}]`)),
      outflow: nonNegativeCents(x.outflows_cents, `${p}.outflows_cents`),
      payroll: nonNegativeCents(x.payroll_cents, `${p}.payroll_cents`),
      projectSpend: nonNegativeCents(x.project_spend_cents, `${p}.project_spend_cents`),
      closing: cents(x.closing_cents, `${p}.closing_cents`),
      negative: bool(x.negative, `${p}.negative`),
      quality: oneOf(x.quality, ROW_QUALITIES, `${p}.quality`),
      basis: str(x.basis, `${p}.basis`),
    };
    if (row.week !== i + 1) fail(`${p}.week`, "weeks must run 1 to 13 in order");
    if (row.start > row.end) fail(`${p}.start`, "week starts after it ends");
    if (addCents(row.ownerDrawReceipt, row.otherReceipts) !== row.receipts) fail(`${p}.receipts_cents`, "receipt components disagree");
    if (addCents(row.payroll, row.projectSpend) !== row.outflow) fail(`${p}.outflows_cents`, "outflow components disagree");
    if (subtractCents(addCents(row.opening, row.receipts), row.outflow) !== row.closing) fail(`${p}.closing_cents`, "row does not reconcile");
    if (row.negative !== row.closing < 0n) fail(`${p}.negative`, "flag disagrees with closing");
    return row;
  });
  rows.forEach((row, i) => {
    if (i > 0 && rows[i - 1].closing !== row.opening) fail(`${path}.rows[${i}].opening_cents`, "does not continue the previous closing");
    if (i > 0 && rows[i - 1].end >= row.start) fail(`${path}.rows[${i}].start`, "weeks overlap or run backwards");
  });

  const view: CashCrisisForecastView = {
    rows,
    drawWeek: int(o.draw_week, `${path}.draw_week`),
    drawDate: isoDate(o.draw_date, `${path}.draw_date`),
    openingCash: cents(o.opening_cash_cents, `${path}.opening_cash_cents`),
    totalReceipts: nonNegativeCents(o.total_receipts_cents, `${path}.total_receipts_cents`),
    totalOutflows: nonNegativeCents(o.total_outflows_cents, `${path}.total_outflows_cents`),
    endingCash: cents(o.ending_cash_cents, `${path}.ending_cash_cents`),
    minimumClosing: cents(o.minimum_closing_cents, `${path}.minimum_closing_cents`),
    peakFundingGap: nonNegativeCents(o.peak_projected_funding_gap_cents, `${path}.peak_projected_funding_gap_cents`),
    fundingGapBasis: str(o.funding_gap_basis, `${path}.funding_gap_basis`),
    worstWeek: int(o.worst_week, `${path}.worst_week`),
    negativeWeekCount: count(o.negative_week_count, `${path}.negative_week_count`),
    firstNegativeWeek: o.first_negative_week === null ? null : int(o.first_negative_week, `${path}.first_negative_week`),
    incompleteWeeks: arr(o.incomplete_weeks, `${path}.incomplete_weeks`).map((w, i) => int(w, `${path}.incomplete_weeks[${i}]`)),
    limitations: strings(o.limitations, `${path}.limitations`),
  };
  // The summary must agree with the rows it summarizes. These are agreement checks; nothing shown is taken from them.
  if (!view.fundingGapBasis.includes("PROJECTED") || !view.fundingGapBasis.includes("SYNTHETIC")) {
    fail(`${path}.funding_gap_basis`, "the funding gap must be recorded as a projection of a synthetic path");
  }
  if (rows[0].opening !== view.openingCash) fail(`${path}.opening_cash_cents`, "disagrees with week 1");
  const drawRows = rows.filter((row) => row.ownerDrawReceipt !== 0n);
  if (drawRows.length !== 1 || drawRows[0].ownerDrawReceipt !== drawAmount) fail(`${path}.rows`, "the owner draw must be received exactly once, in full");
  if (drawRows[0].week !== view.drawWeek) fail(`${path}.draw_week`, "disagrees with the row that receives the draw");
  if (!(drawRows[0].start <= view.drawDate && view.drawDate <= drawRows[0].end)) fail(`${path}.draw_date`, "is outside the draw week");
  const worst = rows.find((row) => row.week === view.worstWeek);
  if (!worst) fail(`${path}.worst_week`, "names no forecast week");
  if (worst!.closing !== view.minimumClosing) fail(`${path}.minimum_closing_cents`, "disagrees with the worst week's closing");
  if (rows.some((row) => row.closing < view.minimumClosing)) fail(`${path}.minimum_closing_cents`, "a week closes lower");
  if (rows[rows.length - 1].closing !== view.endingCash) fail(`${path}.ending_cash_cents`, "disagrees with week 13");
  if (rows.reduce((a, row) => addCents(a, row.receipts), 0n) !== view.totalReceipts) fail(`${path}.total_receipts_cents`, "disagrees with the rows");
  if (rows.reduce((a, row) => addCents(a, row.outflow), 0n) !== view.totalOutflows) fail(`${path}.total_outflows_cents`, "disagrees with the rows");
  const negatives = rows.filter((row) => row.negative);
  if (negatives.length !== view.negativeWeekCount) fail(`${path}.negative_week_count`, "disagrees with the rows");
  if ((negatives[0]?.week ?? null) !== view.firstNegativeWeek) fail(`${path}.first_negative_week`, "disagrees with the rows");
  const expectedGap = view.minimumClosing < 0n ? -view.minimumClosing : 0n;
  if (view.peakFundingGap !== expectedGap) fail(`${path}.peak_projected_funding_gap_cents`, "disagrees with the minimum closing");
  const late = rows.filter((row) => row.quality === "INCOMPLETE_LATE_HORIZON").map((row) => row.week);
  if (late.join() !== view.incompleteWeeks.join()) fail(`${path}.incomplete_weeks`, "disagrees with the rows");
  if (view.limitations.length === 0) fail(`${path}.limitations`, "forecast limitations are required");
  return view;
}

/** Builds the screens' view of the snapshot, refusing anything malformed, inconsistent or not marked synthetic. */
export function buildCashCrisisView(raw: unknown): CashCrisisView {
  const e = obj(raw, "snapshot", TOP_KEYS);
  const schema = str(e.schema, "schema");
  if (schema !== CASH_CRISIS_SCHEMA) fail("schema", `mismatch: ${schema}`);
  const task = str(e.task, "task");
  if (task !== CASH_CRISIS_TASK) fail("task", `mismatch: ${task}`);
  if (e.synthetic !== true) fail("synthetic", "snapshot is not marked synthetic");
  const classification = str(e.classification, "classification");
  if (!classification.includes("SYNTHETIC") || !classification.includes("NON-OPERATIONAL")) {
    fail("classification", "snapshot is not marked synthetic and non-operational");
  }
  const currency = str(e.currency, "currency");
  if (currency !== "USD") fail("currency", "only USD is accepted");
  const amountUnit = str(e.amount_unit, "amount_unit");
  if (amountUnit !== "INTEGER_MINOR_UNITS_CENTS") fail("amount_unit", "only integer minor units are accepted");

  const c = obj(e.controls, "controls", CONTROL_KEYS);
  const controls = {
    syntheticOnly: bool(c.synthetic_only, "controls.synthetic_only"),
    readOnly: bool(c.read_only, "controls.read_only"),
    providerWrites: count(c.provider_writes, "controls.provider_writes"),
    databaseWrites: count(c.database_writes, "controls.database_writes"),
    realPaymentAuthority: bool(c.real_payment_authority, "controls.real_payment_authority"),
    releaseInterfaceExists: bool(c.release_interface_exists, "controls.release_interface_exists"),
    humanIdentityVerified: bool(c.human_identity_verified, "controls.human_identity_verified"),
    automatedDecisionAuthority: bool(c.automated_decision_authority, "controls.automated_decision_authority"),
  };
  if (!controls.syntheticOnly || !controls.readOnly) fail("controls", "snapshot must be synthetic and read-only");
  if (controls.providerWrites !== 0 || controls.databaseWrites !== 0) fail("controls", "provider and database writes must be 0");
  if (controls.realPaymentAuthority || controls.releaseInterfaceExists || controls.humanIdentityVerified || controls.automatedDecisionAuthority) {
    fail("controls", "snapshot claims an authority this demonstration does not have");
  }

  const fx = obj(e.fixture, "fixture", FIXTURE_KEYS);
  const fixture = {
    id: identifier(fx.fixture_id, "fixture.fixture_id"),
    path: str(fx.path, "fixture.path"),
    sha256: digest(fx.sha256, "fixture.sha256"),
  };

  const fi = obj(e.forecast_inputs, "forecast_inputs", FORECAST_INPUT_KEYS);
  const openingOperatingCash = nonNegativeCents(fi.opening_operating_cash_cents, "forecast_inputs.opening_operating_cash_cents");
  const forecastInputs = {
    startDate: isoDate(fi.start_date, "forecast_inputs.start_date"),
    weeks: int(fi.weeks, "forecast_inputs.weeks"),
    openingBasis: str(fi.opening_basis, "forecast_inputs.opening_basis"),
    otherReceipts: arr(fi.other_receipts, "forecast_inputs.other_receipts").map((x, i) => {
      const o = obj(x, `forecast_inputs.other_receipts[${i}]`, OTHER_RECEIPT_KEYS);
      return {
        id: identifier(o.id, `forecast_inputs.other_receipts[${i}].id`),
        date: isoDate(o.date, `forecast_inputs.other_receipts[${i}].date`),
        amount: nonNegativeCents(o.amount_cents, `forecast_inputs.other_receipts[${i}].amount_cents`),
        basis: str(o.basis, `forecast_inputs.other_receipts[${i}].basis`),
        status: str(o.status, `forecast_inputs.other_receipts[${i}].status`),
      };
    }),
  };
  if (forecastInputs.weeks !== FORECAST_WEEKS) fail("forecast_inputs.weeks", `expected ${FORECAST_WEEKS}`);
  if (!forecastInputs.openingBasis.includes("SYNTHETIC")) fail("forecast_inputs.opening_basis", "opening cash must be a synthetic assumption");

  const p = obj(e.project, "project", PROJECT_KEYS);
  const project = {
    id: identifier(p.project_id, "project.project_id"),
    label: str(p.label, "project.label"),
    contract: nonNegativeCents(p.contract_cents, "project.contract_cents"),
    projectedGrossProfit: nonNegativeCents(p.projected_gross_profit_cents, "project.projected_gross_profit_cents"),
    grossMarginBasisPoints: count(p.gross_margin_basis_points, "project.gross_margin_basis_points"),
    openingOperatingCash,
  };

  const scenarios = arr(e.scenarios, "scenarios").map((x, i) => {
    const o = obj(x, `scenarios[${i}]`, SCENARIO_KEYS);
    return {
      id: scenarioId(o.id, `scenarios[${i}].id`),
      newCommitmentAuthority: bool(o.new_commitment_authority, `scenarios[${i}].new_commitment_authority`),
      note: str(o.note, `scenarios[${i}].note`),
    };
  });
  if (scenarios.map((x) => x.id).join() !== SCENARIO_IDS.join()) fail("scenarios", "expected exactly S0 and S1, in order");

  const d = obj(e.draw, "draw", DRAW_KEYS);
  const draw = {
    amount: nonNegativeCents(d.amount_cents, "draw.amount_cents"),
    delayDays: count(d.delay_days, "draw.delay_days"),
    onTimeDate: isoDate(d.scheduled_date, "draw.scheduled_date"),
    delayedDate: isoDate(d.delayed_date, "draw.delayed_date"),
    onTimeWeek: int(d.on_time_week, "draw.on_time_week"),
    delayedWeek: int(d.delayed_week, "draw.delayed_week"),
    evidenceId: identifier(d.evidence_id, "draw.evidence_id"),
    receiptId: identifier(d.receipt_id, "draw.receipt_id"),
    basis: str(d.basis, "draw.basis"),
    status: str(d.status, "draw.status"),
  };
  if (draw.onTimeDate >= draw.delayedDate) fail("draw.delayed_date", "must be later than the scheduled date");
  if (!draw.basis.includes("SYNTHETIC")) fail("draw.basis", "the draw must be a synthetic assumption");

  // The rule table is keyed by rule identifier, so its key set is open; every key and every text is still checked.
  if (e.rules === null || typeof e.rules !== "object" || Array.isArray(e.rules)) fail("rules", "expected object");
  const rules = Object.entries(e.rules as Obj).map(([id, text]) => ({ id: identifier(id, `rules.${id}`), text: str(text, `rules.${id}`) }));
  if (rules.length === 0) fail("rules", "no rules");
  const ruleText = new Map(rules.map((r) => [r.id, r.text]));

  const k = obj(e.capital, "capital", CAPITAL_KEYS);
  const reservable = obj(k.new_reservable_by_scenario_cents, "capital.new_reservable_by_scenario_cents", SCENARIO_IDS);
  const calculated = obj(k.calculated_available_by_scenario_cents, "capital.calculated_available_by_scenario_cents", SCENARIO_IDS);
  const ref = obj(k.eligibility_demo_reference, "capital.eligibility_demo_reference", ELIGIBILITY_REFERENCE_KEYS);
  if (bool(ref.applied_in_this_model, "capital.eligibility_demo_reference.applied_in_this_model")) {
    fail("capital.eligibility_demo_reference.applied_in_this_model", "the eligibility demonstration's reserve must not be applied in this model");
  }
  if (bool(k.separate_payable_in_immediate_requests, "capital.separate_payable_in_immediate_requests")) {
    fail("capital.separate_payable_in_immediate_requests", "the separate payable must stay outside the immediate requests");
  }
  const capital = {
    allocation: nonNegativeCents(k.allocation_cents, "capital.allocation_cents"),
    concreteHold: nonNegativeCents(k.concrete_hold_cents, "capital.concrete_hold_cents"),
    holdApplicationCount: count(k.hold_application_count, "capital.hold_application_count"),
    holdApplications: arr(k.hold_applications, "capital.hold_applications").map((x, i) => {
      const o = obj(x, `capital.hold_applications[${i}]`, HOLD_APPLICATION_KEYS);
      return {
        requestId: identifier(o.request_id, `capital.hold_applications[${i}].request_id`),
        obligationId: identifier(o.obligation_id, `capital.hold_applications[${i}].obligation_id`),
        amount: nonNegativeCents(o.amount_cents, `capital.hold_applications[${i}].amount_cents`),
        evidenceIds: identifiers(o.evidence_ids, `capital.hold_applications[${i}].evidence_ids`),
      };
    }),
    availableAfterHold: nonNegativeCents(k.available_after_hold_cents, "capital.available_after_hold_cents"),
    calculatedAvailable: {
      S0: nonNegativeCents(calculated.S0, "capital.calculated_available_by_scenario_cents.S0"),
      S1: nonNegativeCents(calculated.S1, "capital.calculated_available_by_scenario_cents.S1"),
    },
    immediateRequests: nonNegativeCents(k.immediate_requests_cents, "capital.immediate_requests_cents"),
    immediateRequestIds: identifiers(k.immediate_request_ids, "capital.immediate_request_ids"),
    nominalOverAllocation: nonNegativeCents(k.nominal_gap_cents, "capital.nominal_gap_cents"),
    separatePayable: nonNegativeCents(k.separate_payable_cents, "capital.separate_payable_cents"),
    separatePayableRequestIds: identifiers(k.separate_payable_request_ids, "capital.separate_payable_request_ids"),
    eligibilityReference: {
      reserve: nonNegativeCents(ref.reserve_cents, "capital.eligibility_demo_reference.reserve_cents"),
      initialAvailability: nonNegativeCents(ref.initial_availability_cents, "capital.eligibility_demo_reference.initial_availability_cents"),
      note: str(ref.note, "capital.eligibility_demo_reference.note"),
    },
    newReservable: {
      S0: nonNegativeCents(reservable.S0, "capital.new_reservable_by_scenario_cents.S0"),
      S1: nonNegativeCents(reservable.S1, "capital.new_reservable_by_scenario_cents.S1"),
    },
    notes: strings(k.notes, "capital.notes"),
  };
  if (subtractCents(capital.allocation, capital.concreteHold) !== capital.availableAfterHold) {
    fail("capital.available_after_hold_cents", "allocation less the single hold disagrees");
  }
  if (subtractCents(capital.immediateRequests, capital.allocation) !== capital.nominalOverAllocation) {
    fail("capital.nominal_gap_cents", "requests less allocation disagrees");
  }
  const held = capital.holdApplications;
  if (
    held.length !== capital.holdApplicationCount ||
    new Set(held.map((h) => h.requestId)).size !== held.length ||
    held.reduce((a, h) => addCents(a, h.amount), 0n) !== capital.concreteHold
  ) {
    fail("capital.hold_applications", "the hold is not applied exactly once per held request");
  }
  for (const s of SCENARIO_IDS) {
    if (capital.calculatedAvailable[s] !== capital.availableAfterHold) {
      fail(`capital.calculated_available_by_scenario_cents.${s}`, "calculated availability must be the same in both scenarios");
    }
  }

  const dec = obj(e.decisions, "decisions", SCENARIO_IDS);
  const decisions = {
    S0: arr(dec.S0, "decisions.S0").map((x, i) => decision(x, `decisions.S0[${i}]`, "S0", ruleText)),
    S1: arr(dec.S1, "decisions.S1").map((x, i) => decision(x, `decisions.S1[${i}]`, "S1", ruleText)),
  };
  const rawCounts = obj(e.decision_counts, "decision_counts", SCENARIO_IDS);
  const countsFor = (s: ScenarioId) => {
    const o = obj(rawCounts[s], `decision_counts.${s}`, DECISION_COUNT_KEYS);
    return {
      BLOCKED: count(o.BLOCKED, `decision_counts.${s}.BLOCKED`),
      UNRESOLVED: count(o.UNRESOLVED, `decision_counts.${s}.UNRESOLVED`),
      EVIDENCE_ELIGIBLE: count(o.EVIDENCE_ELIGIBLE, `decision_counts.${s}.EVIDENCE_ELIGIBLE`),
      TOTAL: count(o.TOTAL, `decision_counts.${s}.TOTAL`),
    };
  };
  const decisionCounts = { S0: countsFor("S0"), S1: countsFor("S1") };
  for (const s of SCENARIO_IDS) {
    const list = decisions[s];
    const authority = scenarios.find((x) => x.id === s)!.newCommitmentAuthority;
    if (list.length === 0) fail(`decisions.${s}`, "no decisions");
    if (new Set(list.map((x) => x.requestId)).size !== list.length) fail(`decisions.${s}`, "duplicate request identifier");
    if (decisionCounts[s].TOTAL !== list.length) fail(`decision_counts.${s}.TOTAL`, "disagrees with the decisions");
    for (const st of DECISION_STATUSES) {
      if (decisionCounts[s][st] !== list.filter((x) => x.status === st).length) fail(`decision_counts.${s}.${st}`, "disagrees with the decisions");
    }
    const immediate = list.filter((x) => x.inImmediateRequests);
    const outside = list.filter((x) => !x.inImmediateRequests);
    if (immediate.reduce((a, x) => addCents(a, x.amount), 0n) !== capital.immediateRequests) {
      fail(`decisions.${s}`, "immediate requests disagree with capital.immediate_requests_cents");
    }
    if (immediate.map((x) => x.requestId).join() !== capital.immediateRequestIds.join()) {
      fail(`decisions.${s}`, "immediate requests disagree with capital.immediate_request_ids");
    }
    if (outside.reduce((a, x) => addCents(a, x.amount), 0n) !== capital.separatePayable) {
      fail(`decisions.${s}`, "separate payable disagrees with capital.separate_payable_cents");
    }
    if (outside.map((x) => x.requestId).join() !== capital.separatePayableRequestIds.join()) {
      fail(`decisions.${s}`, "separate payable disagrees with capital.separate_payable_request_ids");
    }
    const repeatBlocked = list.filter((x) => x.repeatAttempt === "BLOCKED").map((x) => x.requestId);
    if (repeatBlocked.join() !== held.map((h) => h.requestId).join()) {
      fail(`decisions.${s}`, "every held request, and no other, must have its repeat attempt blocked");
    }
    for (const [i, x] of list.entries()) {
      if (x.newCommitmentAuthority !== authority) fail(`decisions.${s}[${i}].new_commitment_authority`, "disagrees with the scenario");
      if (x.newReservationPermitted && (!authority || x.status !== "EVIDENCE_ELIGIBLE")) {
        fail(`decisions.${s}[${i}].new_reservation_permitted`, "a reservation may be permitted only with authority and complete evidence");
      }
    }
    if (!authority && capital.newReservable[s] !== 0n) fail(`capital.new_reservable_by_scenario_cents.${s}`, "must be 0 without new commitment authority");
  }
  if (new Set([...decisions.S0, ...decisions.S1].map((x) => x.id)).size !== decisions.S0.length + decisions.S1.length) {
    fail("decisions", "duplicate decision identifier");
  }
  // The two scenarios hold identical facts: the same requests, amounts and evidence. Only new authority may differ.
  if (decisions.S0.length !== decisions.S1.length) fail("decisions", "S0 and S1 list different requests");
  decisions.S0.forEach((a, i) => {
    const b = decisions.S1[i];
    const same =
      a.requestId === b.requestId && a.obligationId === b.obligationId && a.amount === b.amount && a.status === b.status &&
      a.description === b.description && a.party === b.party && a.inImmediateRequests === b.inImmediateRequests &&
      a.repeatAttempt === b.repeatAttempt && a.evidenceIds.join() === b.evidenceIds.join();
    if (!same) fail(`decisions.S1[${i}]`, "facts differ from S0");
  });

  const evidence = arr(e.evidence, "evidence").map((x, i): CashCrisisEvidence => {
    const o = obj(x, `evidence[${i}]`, EVIDENCE_KEYS);
    return {
      id: identifier(o.id, `evidence[${i}].id`),
      kind: str(o.kind, `evidence[${i}].kind`),
      status: str(o.status, `evidence[${i}].status`),
      title: str(o.title, `evidence[${i}].title`),
      detail: str(o.detail, `evidence[${i}].detail`),
    };
  });
  const evidenceIds = new Set(evidence.map((x) => x.id));
  if (evidence.length === 0) fail("evidence", "no evidence");
  if (evidenceIds.size !== evidence.length) fail("evidence", "duplicate evidence identifier");
  const cited = (ids: string[], path: string) => {
    for (const id of ids) if (!evidenceIds.has(id)) fail(path, `cites unknown evidence ${id}`);
  };
  for (const s of SCENARIO_IDS) decisions[s].forEach((x, i) => cited(x.evidenceIds, `decisions.${s}[${i}].evidence_ids`));
  held.forEach((h, i) => cited(h.evidenceIds, `capital.hold_applications[${i}].evidence_ids`));
  cited([draw.evidenceId], "draw.evidence_id");

  const events = arr(e.events, "events").map((x, i): CashCrisisEvent => {
    const o = obj(x, `events[${i}]`, EVENT_KEYS);
    return {
      id: identifier(o.id, `events[${i}].id`),
      sequence: int(o.sequence, `events[${i}].sequence`),
      when: isoDate(o.when, `events[${i}].when`),
      role: str(o.role, `events[${i}].role`),
      type: str(o.type, `events[${i}].type`),
      title: str(o.title, `events[${i}].title`),
      finding: str(o.finding, `events[${i}].finding`),
      evidenceIds: identifiers(o.evidence_ids, `events[${i}].evidence_ids`),
      sha256: digest(o.sha256, `events[${i}].sha256`),
      prevSha256: digest(o.prev_sha256, `events[${i}].prev_sha256`),
    };
  });
  if (events.length === 0) fail("events", "no events");
  if (new Set(events.map((x) => x.id)).size !== events.length) fail("events", "duplicate event identifier");
  events.forEach((ev, i) => {
    if (ev.sequence !== i + 1) fail(`events[${i}].sequence`, "events must run in sequence from 1");
    const expectedPrev = i === 0 ? ZERO_DIGEST : events[i - 1].sha256;
    if (ev.prevSha256 !== expectedPrev) fail(`events[${i}].prev_sha256`, "does not chain to the previous event");
    cited(ev.evidenceIds, `events[${i}].evidence_ids`);
  });

  const findings = arr(e.findings, "findings").map((x, i): CashCrisisFinding => {
    const o = obj(x, `findings[${i}]`, FINDING_KEYS);
    const ids = identifiers(o.evidence_ids, `findings[${i}].evidence_ids`);
    cited(ids, `findings[${i}].evidence_ids`);
    return {
      role: str(o.role, `findings[${i}].role`),
      finding: str(o.finding, `findings[${i}].finding`),
      boundary: str(o.boundary, `findings[${i}].boundary`),
      evidenceIds: ids,
    };
  });

  const assumptions = arr(e.assumptions, "assumptions").map((x, i) => {
    const o = obj(x, `assumptions[${i}]`, ASSUMPTION_KEYS);
    const label = str(o.label, `assumptions[${i}].label`);
    if (label !== "SYNTHETIC") fail(`assumptions[${i}].label`, "every assumption must be labelled SYNTHETIC");
    return {
      id: identifier(o.id, `assumptions[${i}].id`),
      label,
      subject: str(o.subject, `assumptions[${i}].subject`),
      text: str(o.text, `assumptions[${i}].text`),
    };
  });
  if (assumptions.length === 0) fail("assumptions", "no assumptions");
  if (new Set(assumptions.map((a) => a.id)).size !== assumptions.length) fail("assumptions", "duplicate assumption identifier");

  const f = obj(e.forecasts, "forecasts", FUNDING_CASES);
  const forecasts = {
    on_time: forecast(f.on_time, "forecasts.on_time", "on_time", draw.amount),
    delayed: forecast(f.delayed, "forecasts.delayed", "delayed", draw.amount),
  };
  for (const fc of FUNDING_CASES) {
    if (forecasts[fc].openingCash !== project.openingOperatingCash) {
      fail(`forecasts.${fc}.opening_cash_cents`, "disagrees with forecast_inputs.opening_operating_cash_cents");
    }
    if (forecasts[fc].rows[0].start !== forecastInputs.startDate) fail(`forecasts.${fc}.rows[0].start`, "disagrees with forecast_inputs.start_date");
  }
  if (forecasts.on_time.drawWeek !== draw.onTimeWeek || forecasts.on_time.drawDate !== draw.onTimeDate) fail("draw.on_time_week", "disagrees with the on-time forecast");
  if (forecasts.delayed.drawWeek !== draw.delayedWeek || forecasts.delayed.drawDate !== draw.delayedDate) fail("draw.delayed_week", "disagrees with the delayed forecast");

  return {
    schema,
    task,
    classification,
    currency,
    amountUnit,
    fixture,
    snapshotContentSha256: digest(e.snapshot_content_sha256, "snapshot_content_sha256"),
    project,
    scenarios,
    draw,
    forecastInputs,
    capital,
    decisions,
    decisionCounts,
    forecasts,
    events,
    evidence,
    findings,
    assumptions,
    rules,
    limitations: strings(e.limitations, "limitations"),
    controls,
  };
}

/** Reads the accepted eligibility demonstration's own availability figures. Read-only; nothing is reconciled. */
export function buildEligibilityReference(raw: unknown): EligibilityReference {
  const loose = (v: unknown, path: string): Obj => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`eligibility evidence: ${path}: expected object`);
    return v as Obj;
  };
  const initial = loose(loose(loose(raw, "evidence").project, "project").availability_initial, "project.availability_initial");
  return {
    allocation: nonNegativeCents(initial.allocation, "eligibility.allocation"),
    holdsDeducted: nonNegativeCents(initial.holds_deducted, "eligibility.holds_deducted"),
    restrictedReserves: nonNegativeCents(initial.restricted_reserves, "eligibility.restricted_reserves"),
    availableToCommit: nonNegativeCents(initial.available_to_commit, "eligibility.available_to_commit"),
  };
}

/** The snapshot's statement of the accepted eligibility figures must be what the accepted evidence itself records. */
export function checkEligibilityReference(view: CashCrisisView, accepted: EligibilityReference): void {
  const stated = view.capital.eligibilityReference;
  if (stated.reserve !== accepted.restrictedReserves) fail("capital.eligibility_demo_reference.reserve_cents", "disagrees with the accepted eligibility evidence");
  if (stated.initialAvailability !== accepted.availableToCommit) fail("capital.eligibility_demo_reference.initial_availability_cents", "disagrees with the accepted eligibility evidence");
}

export const cashCrisis: CashCrisisView = buildCashCrisisView(snapshot);
export const eligibilityReference: EligibilityReference = buildEligibilityReference(eligibilityEvidence);
checkEligibilityReference(cashCrisis, eligibilityReference);

export function isFundingCase(value: unknown): value is FundingCase {
  return typeof value === "string" && (FUNDING_CASES as readonly string[]).includes(value);
}

export type QueryParams = Readonly<Record<string, string | string[] | undefined>>;

/** The funding case named by the link parameter `d`; anything else, or no parameter, is the documented default. */
export function selectFundingCase(params: QueryParams): FundingCase {
  const raw = params[FUNDING_CASE_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isFundingCase(value) ? value : DEFAULT_FUNDING_CASE;
}

/** A same-origin, read-only link to one of the two screens that carry the E3 sections, keeping scenario and case. */
export function cashCrisisHref(
  screen: "overview" | "incident",
  scenario: ScenarioId,
  fundingCase: FundingCase,
  fragment?: string,
): string {
  return `/${screen}?s=${scenario}&${FUNDING_CASE_PARAM}=${fundingCase}${fragment ? `#${fragment}` : ""}`;
}

export function evidenceAnchor(evidenceId: string): string {
  return `e3-evidence-${evidenceId}`;
}
export function decisionAnchor(decisionId: string): string {
  return `e3-decision-${decisionId}`;
}
export function eventAnchor(eventId: string): string {
  return `e3-event-${eventId}`;
}

export function isoDateLabel(date: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = date.split("-");
  return `${months[Number(month) - 1]} ${Number(day)}, ${year}`;
}
