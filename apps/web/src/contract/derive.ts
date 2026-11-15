// Derived figures. Pure functions of a Snapshot, following the financial contract (G1O candidate):
//   AVAIL(a) = CASH(a) - RES(a) - UNC(a)                          (section 3.3)
//   AUTHORIZED_NEW_COMMITMENT(a) = 0 if BLOCKS_CAPACITY else max(0, AVAIL)
//   NEW_RESERVABLE(o) and DISPATCHABLE_NOW(o)                     (section 3.5)
//   R(e) + D(e) + U(e) + N_ret(e) + N_res(e) = A(e)               (section 3.2)
// This is a DISPLAY derivation over synthetic facts. It is not an authority and grants nothing.

import { max0, min, parseMoney, sum } from "./money.ts";
import type { Cents } from "./money.ts";
import type { ObligationFacts, Snapshot } from "./types.ts";

export interface ObligationView {
  facts: ObligationFacts;
  amount: Cents;
  cons: Cents;
  rv: Cents;
  uncov: Cents;
  committed: Cents;
  room: Cents;
  blockedByCase: boolean;
  eligible: boolean;
  newReservable: Cents;
  dispatchableNow: Cents;
  reasons: string[]; // why capacity or dispatch is zero, in plain words
}

interface LineageTotals {
  cons: Cents;
  rv: Cents;
  uncov: Cents;
  committed: Cents;
  room: Cents;
  overcommit: boolean;
  hasNonterminalIntent: boolean;
}

export interface WeekRow {
  week: number;
  recordedNet: Cents;
  scheduled: boolean; // false = no schedule recorded for this week
  runningBalance: Cents | null; // null once the schedule is incomplete
}

export interface Derived {
  cash: Cents;
  res: Cents;
  unc: Cents;
  avail: Cents;
  blocksCapacity: boolean;
  authorizedNewCommitment: Cents;
  spendingBlocked: boolean;
  newReservableTotal: Cents;
  dispatchableNowTotal: Cents;
  requestedTotal: Cents;
  additionalNotRequestedTotal: Cents;
  contingentShortfall: Cents; // max(0, requested outflows - allocation cash)
  walletAmount: Cents;
  obligations: ObligationView[];
  weeks: WeekRow[];
  forecastComplete: boolean;
  openCases: number;
}

export function weekOfDay(day: number): number {
  return Math.ceil(day / 7);
}

export function derive(s: Snapshot): Derived {
  const cash = parseMoney(s.allocation.cash);
  const res = sum(s.reservations.map((r) => parseMoney(r.amount)));
  const unc = sum(s.exposures.map((e) => parseMoney(e.u)));
  const avail = cash - res - unc; // signed, never floored
  const blocksCapacity = s.cases.some(
    (c) => c.scope === "ALLOCATION" && c.state === "OPEN" && c.executionBlocking,
  );
  const authorizedNewCommitment = blocksCapacity ? 0n : max0(avail);

  // Contract §3.4: reservations and exposure are aggregated across every member of a payable lineage.
  const lineageTotals = new Map<string, LineageTotals>();
  for (const o of s.obligations) {
    const members = s.obligations.filter((member) => member.lineageId === o.lineageId);
    const head = members.find((member) => member.isLineageHead);
    if (!head) throw new Error(`lineage ${o.lineageId} has no head`);
    const cons = sum(s.exposures.filter((e) => members.some((m) => m.obligationId === e.obligationId)).map((e) => parseMoney(e.d)));
    const uncov = sum(s.exposures.filter((e) => members.some((m) => m.obligationId === e.obligationId)).map((e) => parseMoney(e.u)));
    const rv = sum(s.reservations.filter((r) => members.some((m) => m.obligationId === r.obligationId)).map((r) => parseMoney(r.amount)));
    const committed = cons + rv + uncov;
    const headAmount = parseMoney(head.amount);
    lineageTotals.set(o.lineageId, {
      cons,
      rv,
      uncov,
      committed,
      room: headAmount - committed,
      overcommit: committed > headAmount,
      hasNonterminalIntent: members.some((member) => member.hasNonterminalIntent),
    });
  }

  const obligations: ObligationView[] = s.obligations.map((o) => {
    const amount = parseMoney(o.amount);
    const lineage = lineageTotals.get(o.lineageId)!;
    const { cons, rv, uncov, committed, room } = lineage;
    const rvs = s.reservations.filter((r) => r.obligationId === o.obligationId);
    const blockedByCase = s.cases.some(
      (c) => c.state === "OPEN" && c.executionBlocking && c.scope === "OBLIGATION" && c.obligationId === o.obligationId,
    );
    const eligible = o.eligibility === "ELIGIBLE";
    const overcommit = lineage.overcommit;

    const reasons: string[] = [];
    if (blocksCapacity) reasons.push("Allocation-wide block: authorized new commitment is zero");
    if (blockedByCase) reasons.push("Open blocking case on this obligation");
    if (!eligible) reasons.push(`Not eligible: ${o.eligibility.toLowerCase()}`);
    if (o.barred) reasons.push("Permanent replacement bar");
    if (overcommit) reasons.push("Over-committed");
    if (avail <= 0n) reasons.push("No available capacity");
    if (room <= 0n && eligible && !blockedByCase) reasons.push("No room: obligation fully committed");

    const gated = blocksCapacity || blockedByCase || !eligible || o.barred || overcommit || avail <= 0n ||
      !o.isLineageHead || lineage.hasNonterminalIntent;
    const newReservable = gated ? 0n : max0(min(room, authorizedNewCommitment));

    // DISPATCHABLE_NOW: approved, ready reservations only; never a hypothetical amount.
    const dispatchGated = blocksCapacity || blockedByCase || !eligible || o.barred || overcommit || avail < 0n;
    const dispatchableNow = dispatchGated
      ? 0n
      : sum(rvs.filter((r) => r.state === "APPROVED_READY").map((r) => parseMoney(r.amount)));

    return { facts: o, amount, cons, rv, uncov, committed, room, blockedByCase, eligible, newReservable, dispatchableNow, reasons };
  });

  const requestedTotal = sum(s.obligations.filter((o) => o.requested).map((o) => parseMoney(o.amount)));
  const additionalNotRequestedTotal = sum(s.obligations.filter((o) => !o.requested).map((o) => parseMoney(o.amount)));
  const contingentShortfall = max0(requestedTotal - cash);

  // Forecast: start from AVAIL; add what is scheduled; stop charting where the schedule is not recorded.
  const f = s.forecast;
  const net = new Array<Cents>(f.weeks + 1).fill(0n);
  for (const r of f.recurring) {
    for (let w = r.fromWeek; w <= r.toWeek; w++) net[w] -= parseMoney(r.amount);
  }
  for (const d of f.dated) {
    if (d.dueDay === null) continue;
    const w = weekOfDay(d.dueDay + d.delayDays);
    if (w >= 1 && w <= f.weeks) net[w] += (d.direction === "IN" ? 1n : -1n) * parseMoney(d.amount);
  }
  const weeks: WeekRow[] = [];
  let running: Cents | null = avail;
  for (let w = 1; w <= f.weeks; w++) {
    const scheduled = w <= f.scheduleRecordedThroughWeek;
    if (!scheduled) running = null;
    else if (running !== null) running += net[w];
    weeks.push({ week: w, recordedNet: net[w], scheduled, runningBalance: running });
  }

  return {
    cash,
    res,
    unc,
    avail,
    blocksCapacity,
    authorizedNewCommitment,
    spendingBlocked: blocksCapacity,
    newReservableTotal: sum(obligations.map((o) => o.newReservable)),
    dispatchableNowTotal: sum(obligations.map((o) => o.dispatchableNow)),
    requestedTotal,
    additionalNotRequestedTotal,
    contingentShortfall,
    walletAmount: parseMoney(s.sandboxWallet.amount),
    obligations,
    weeks,
    forecastComplete: f.scheduleRecordedThroughWeek >= f.weeks && f.dated.every((d) => d.dueDay !== null),
    openCases: s.cases.filter((c) => c.state === "OPEN").length,
  };
}

// Self-check of a snapshot against the contract identities. Returns a list of violations (empty = consistent).
export function checkInvariants(s: Snapshot): string[] {
  const out: string[] = [];
  if (s.provenance !== "SYNTHETIC_FIXTURE") out.push("provenance is not SYNTHETIC_FIXTURE");
  if (s.sandboxWallet.isProjectCash !== false) out.push("sandbox wallet marked as project cash");
  for (const e of s.exposures) {
    const a = parseMoney(e.amount);
    const parts = parseMoney(e.r) + parseMoney(e.d) + parseMoney(e.u) + parseMoney(e.nRet) + parseMoney(e.nRes);
    if (parts !== a) out.push(`${e.exposureId}: R+D+U+N_ret+N_res != A`);
    if (parseMoney(e.d) < 0n || parseMoney(e.d) > a) out.push(`${e.exposureId}: D outside 0..A`);
  }
  const ids = new Set(s.obligations.map((o) => o.obligationId));
  for (const e of s.exposures) if (!ids.has(e.obligationId)) out.push(`${e.exposureId}: unknown obligation`);
  for (const r of s.reservations) if (!ids.has(r.obligationId)) out.push(`${r.reservationId}: unknown obligation`);
  const d = derive(s);
  if (d.avail !== d.cash - d.res - d.unc) out.push("AVAIL identity broken");
  return out;
}
