// Read-only data boundary. Everything the screens show passes through ReadOnlyAdapter.
// The only implementation here reads bundled synthetic fixtures. There is no network call, no credential,
// no write method, and no backend. A future adapter for an authorized read API must implement this same
// interface and must still declare its provenance; this UI refuses any provenance other than SYNTHETIC_FIXTURE.

import s0 from "../../fixtures/s0.json" with { type: "json" };
import s1 from "../../fixtures/s1.json" with { type: "json" };
import { checkInvariants } from "../contract/derive.ts";
import { parseMoney } from "../contract/money.ts";
import type { ScenarioId, Snapshot } from "../contract/types.ts";

export interface ScenarioMeta {
  id: ScenarioId;
  label: string;
  summary: string;
}

export interface ReadOnlyAdapter {
  readonly kind: "FIXTURE";
  listScenarios(): ScenarioMeta[];
  getSnapshot(id: ScenarioId): Promise<Snapshot>;
}

const RAW: Record<ScenarioId, unknown> = { S0: s0, S1: s1 };

type Row = Record<string, unknown>;

function row(value: unknown, path: string, keys: readonly string[]): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path}: fields differ from the fixture contract (expected ${expected.join(", ")})`);
  }
  return value as Row;
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path}: expected non-empty string`);
}

function money(value: unknown, path: string): asserts value is string {
  string(value, path);
  try {
    parseMoney(value);
  } catch {
    throw new Error(`${path}: expected exact decimal money string`);
  }
}

function boolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
}

function integer(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path}: expected integer in ${min}..${max}`);
  }
}

function member(value: unknown, path: string, allowed: readonly string[]): asserts value is string {
  string(value, path);
  if (!allowed.includes(value)) throw new Error(`${path}: unsupported value ${value}`);
}

function validateSnapshotShape(raw: unknown): asserts raw is Snapshot {
  const top = row(raw, "snapshot", [
    "provenance", "scenarioId", "title", "description", "asOf", "project", "allocation", "sandboxWallet",
    "obligations", "exposures", "reservations", "cases", "events", "forecast", "approvalPreview",
  ]);
  member(top.provenance, "provenance", ["SYNTHETIC_FIXTURE"]);
  member(top.scenarioId, "scenarioId", ["S0", "S1"]);
  for (const key of ["title", "description", "asOf"]) string(top[key], key);

  const project = row(top.project, "project", ["projectId", "name", "contractAmount", "grossProfitBaseline"]);
  string(project.projectId, "project.projectId");
  string(project.name, "project.name");
  money(project.contractAmount, "project.contractAmount");
  money(project.grossProfitBaseline, "project.grossProfitBaseline");

  const allocation = row(top.allocation, "allocation", ["allocationId", "basis", "cash"]);
  string(allocation.allocationId, "allocation.allocationId");
  member(allocation.basis, "allocation.basis", ["PRE_DEBIT"]);
  money(allocation.cash, "allocation.cash");

  const wallet = row(top.sandboxWallet, "sandboxWallet", ["label", "amount", "isProjectCash"]);
  string(wallet.label, "sandboxWallet.label");
  money(wallet.amount, "sandboxWallet.amount");
  if (wallet.isProjectCash !== false) throw new Error("sandboxWallet.isProjectCash must remain false");

  if (!Array.isArray(top.obligations) || !Array.isArray(top.exposures) || !Array.isArray(top.reservations) ||
      !Array.isArray(top.cases) || !Array.isArray(top.events)) throw new Error("snapshot collections must be arrays");
  top.obligations.forEach((value, i) => {
    const path = `obligations[${i}]`;
    const o = row(value, path, ["obligationId", "label", "kind", "counterpartyLabel", "amount", "eligibility", "eligibilityNote", "payableClass", "invoiceRefDisplay", "lineageId", "isLineageHead", "hasNonterminalIntent", "barred", "requested"]);
    for (const key of ["obligationId", "label", "counterpartyLabel", "eligibilityNote", "lineageId"]) string(o[key], `${path}.${key}`);
    member(o.kind, `${path}.kind`, ["MATERIAL", "SUBCONTRACTOR", "CHANGE_ORDER"]);
    member(o.eligibility, `${path}.eligibility`, ["ELIGIBLE", "DISPUTED", "UNAPPROVED"]);
    member(o.payableClass, `${path}.payableClass`, ["INVOICE_BACKED", "EVIDENCE_ATTESTED"]);
    money(o.amount, `${path}.amount`);
    if (o.invoiceRefDisplay !== null) string(o.invoiceRefDisplay, `${path}.invoiceRefDisplay`);
    for (const key of ["isLineageHead", "hasNonterminalIntent", "barred", "requested"]) boolean(o[key], `${path}.${key}`);
  });
  top.exposures.forEach((value, i) => {
    const path = `exposures[${i}]`;
    const e = row(value, path, ["exposureId", "obligationId", "amount", "r", "d", "u", "nRet", "nRes"]);
    for (const key of ["exposureId", "obligationId"]) string(e[key], `${path}.${key}`);
    for (const key of ["amount", "r", "d", "u", "nRet", "nRes"]) money(e[key], `${path}.${key}`);
  });
  top.reservations.forEach((value, i) => {
    const path = `reservations[${i}]`;
    const r = row(value, path, ["reservationId", "obligationId", "amount", "state"]);
    string(r.reservationId, `${path}.reservationId`);
    string(r.obligationId, `${path}.obligationId`);
    money(r.amount, `${path}.amount`);
    member(r.state, `${path}.state`, ["ACTIVE", "APPROVED_READY"]);
  });
  top.cases.forEach((value, i) => {
    const path = `cases[${i}]`;
    const c = row(value, path, ["caseId", "scope", "obligationId", "kind", "state", "executionBlocking", "unknownAmount", "summary"]);
    string(c.caseId, `${path}.caseId`);
    member(c.scope, `${path}.scope`, ["OBLIGATION", "ALLOCATION"]);
    if (c.obligationId !== null) string(c.obligationId, `${path}.obligationId`);
    for (const key of ["kind", "summary"]) string(c[key], `${path}.${key}`);
    member(c.state, `${path}.state`, ["OPEN", "RESOLVED"]);
    boolean(c.executionBlocking, `${path}.executionBlocking`);
    boolean(c.unknownAmount, `${path}.unknownAmount`);
  });
  top.events.forEach((value, i) => {
    const path = `events[${i}]`;
    const e = row(value, path, ["seq", "at", "kind", "text", "reference"]);
    integer(e.seq, `${path}.seq`, 1, Number.MAX_SAFE_INTEGER);
    for (const key of ["at", "kind", "text"]) string(e[key], `${path}.${key}`);
    if (e.reference !== null) string(e.reference, `${path}.reference`);
  });

  const forecast = row(top.forecast, "forecast", ["weeks", "scheduleRecordedThroughWeek", "recurring", "dated"]);
  if (forecast.weeks !== 13) throw new Error("forecast.weeks must be 13");
  integer(forecast.scheduleRecordedThroughWeek, "forecast.scheduleRecordedThroughWeek", 0, 13);
  if (!Array.isArray(forecast.recurring) || !Array.isArray(forecast.dated)) throw new Error("forecast schedules must be arrays");
  forecast.recurring.forEach((value, i) => {
    const path = `forecast.recurring[${i}]`;
    const item = row(value, path, ["label", "amount", "fromWeek", "toWeek", "illustrative"]);
    string(item.label, `${path}.label`);
    money(item.amount, `${path}.amount`);
    integer(item.fromWeek, `${path}.fromWeek`, 1, 13);
    integer(item.toWeek, `${path}.toWeek`, item.fromWeek as number, 13);
    boolean(item.illustrative, `${path}.illustrative`);
  });
  forecast.dated.forEach((value, i) => {
    const path = `forecast.dated[${i}]`;
    const item = row(value, path, ["label", "direction", "amount", "dueDay", "delayDays", "illustrative"]);
    string(item.label, `${path}.label`);
    member(item.direction, `${path}.direction`, ["IN", "OUT"]);
    money(item.amount, `${path}.amount`);
    if (item.dueDay !== null) integer(item.dueDay, `${path}.dueDay`, 0, 3660);
    integer(item.delayDays, `${path}.delayDays`, 0, 3660);
    boolean(item.illustrative, `${path}.illustrative`);
  });

  const approval = row(top.approvalPreview, "approvalPreview", ["obligationId", "beneficiaryLabel", "beneficiaryFingerprint", "currency", "amount", "evidenceKind", "evidenceDigestShort", "policyRevision", "preparer", "approver"]);
  for (const key of ["obligationId", "beneficiaryLabel", "beneficiaryFingerprint", "evidenceKind", "evidenceDigestShort", "policyRevision", "preparer", "approver"]) string(approval[key], `approvalPreview.${key}`);
  member(approval.currency, "approvalPreview.currency", ["USD"]);
  money(approval.amount, "approvalPreview.amount");
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return value === "S0" || value === "S1";
}

export function parseSyntheticSnapshot(raw: unknown, id?: ScenarioId): Snapshot {
  validateSnapshotShape(raw);
  const snap = raw;
  if (snap.provenance !== "SYNTHETIC_FIXTURE") {
    throw new Error("refused: snapshot is not marked SYNTHETIC_FIXTURE");
  }
  if (id !== undefined && snap.scenarioId !== id) throw new Error(`refused: fixture id mismatch for ${id}`);
  const obligations = new Map<string, Snapshot["obligations"][number]>();
  const heads = new Map<string, number>();
  for (const o of snap.obligations) {
    if (obligations.has(o.obligationId)) throw new Error(`refused: duplicate obligation ${o.obligationId}`);
    obligations.set(o.obligationId, o);
    if (o.isLineageHead) heads.set(o.lineageId, (heads.get(o.lineageId) ?? 0) + 1);
  }
  for (const o of snap.obligations) {
    if (heads.get(o.lineageId) !== 1) throw new Error(`refused: lineage ${o.lineageId} must have exactly one head`);
  }
  for (const e of snap.exposures) {
    if (!obligations.has(e.obligationId)) throw new Error(`refused: exposure ${e.exposureId} has unknown obligation`);
  }
  for (const r of snap.reservations) {
    if (!obligations.has(r.obligationId)) throw new Error(`refused: reservation ${r.reservationId} has unknown obligation`);
  }
  for (const c of snap.cases) {
    if (c.scope === "ALLOCATION" && c.obligationId !== null) throw new Error(`refused: allocation case ${c.caseId} cannot name an obligation`);
    if (c.scope === "OBLIGATION" && (c.obligationId === null || !obligations.has(c.obligationId))) {
      throw new Error(`refused: obligation case ${c.caseId} must name a known obligation`);
    }
  }
  if (!obligations.has(snap.approvalPreview.obligationId)) throw new Error("refused: approval preview has unknown obligation");
  const sequence = snap.events.map((event) => event.seq);
  if (new Set(sequence).size !== sequence.length || sequence.some((seq, i) => i > 0 && seq <= sequence[i - 1])) {
    throw new Error("refused: event sequence must be unique and ascending");
  }
  if (snap.scenarioId === "S1" && !snap.cases.some((c) => c.scope === "ALLOCATION" && c.state === "OPEN" && c.unknownAmount)) {
    throw new Error("refused: S1 must include an open allocation case with unknown amount");
  }
  const problems = checkInvariants(snap);
  if (problems.length > 0) throw new Error(`refused: fixture violates contract identities: ${problems.join("; ")}`);
  return snap;
}

export const fixtureAdapter: ReadOnlyAdapter = {
  kind: "FIXTURE",
  listScenarios() {
    return [
      { id: "S0", label: "S0 Known holds", summary: "Spending open; one unresolved transfer held" },
      { id: "S1", label: "S1 Blocked", summary: "Unknown exposure blocks new commitment" },
    ];
  },
  async getSnapshot(id) {
    return parseSyntheticSnapshot(RAW[id], id);
  },
};
