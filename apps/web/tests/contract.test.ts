import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { derive, checkInvariants } from "../src/contract/derive.ts";
import { addCents, compareCents, formatMoney, parseMoney, subtractCents } from "../src/contract/money.ts";
import { fixtureAdapter, parseSyntheticSnapshot } from "../src/data/adapter.ts";
import type { Snapshot } from "../src/contract/types.ts";

const c = (text: string) => parseMoney(text);

test("money parsing is exact and strict", () => {
  assert.equal(parseMoney("760000.00"), 76_000_000n);
  assert.equal(formatMoney(76_000_000n), "$760,000.00");
  assert.equal(formatMoney(-15_500_000n), "−$155,000.00");
  assert.equal(addCents(parseMoney("0.01"), parseMoney("0.02")), 3n);
  assert.equal(subtractCents(parseMoney("1.00"), parseMoney("0.01")), 99n);
  assert.equal(compareCents(99n, 100n), -1);
  assert.equal(compareCents(100n, 100n), 0);
  assert.equal(compareCents(101n, 100n), 1);
  for (const bad of ["1", "1.5", "1e3", "-0.00", "01.00", "1.000", ""]) {
    assert.throws(() => parseMoney(bad), Error, bad);
  }
  assert.throws(() => parseMoney(1 as never), Error);
});

test("S0: known holds, spending open", async () => {
  const s = await fixtureAdapter.getSnapshot("S0");
  const d = derive(s);
  assert.equal(d.cash, c("760000.00"));
  assert.equal(d.unc, c("310000.00"));
  assert.equal(d.res, 0n);
  assert.equal(d.avail, c("450000.00"));
  assert.equal(d.requestedTotal, c("915000.00"));
  assert.equal(d.additionalNotRequestedTotal, c("90000.00"));
  assert.equal(d.requestedTotal + d.additionalNotRequestedTotal, c("1005000.00"));
  assert.equal(d.contingentShortfall, c("155000.00"));
  assert.equal(d.blocksCapacity, false);
  assert.equal(d.authorizedNewCommitment, c("450000.00"));
  assert.equal(d.walletAmount, c("10000000.00"));
  assert.equal(d.dispatchableNowTotal, 0n);
  const by = Object.fromEntries(d.obligations.map((o) => [o.facts.obligationId, o]));
  assert.equal(by["OBL-CONCRETE"].newReservable, 0n, "held and blocked");
  assert.equal(by["OBL-STEEL"].newReservable, 0n, "disputed");
  assert.equal(by["OBL-ELEC-CO"].newReservable, 0n, "unapproved");
  assert.equal(by["OBL-FRAMING"].newReservable, c("90000.00"), "min(room, authorized)");
});

test("S1: positive AVAIL but zero authorized new commitment", async () => {
  const s = await fixtureAdapter.getSnapshot("S1");
  const d = derive(s);
  assert.equal(d.avail, c("450000.00"));
  assert.ok(d.avail > 0n);
  assert.equal(d.blocksCapacity, true);
  assert.equal(d.spendingBlocked, true);
  assert.equal(d.authorizedNewCommitment, 0n);
  assert.equal(d.newReservableTotal, 0n);
  assert.equal(d.dispatchableNowTotal, 0n);
  assert.equal(d.requestedTotal, c("915000.00"));
  assert.equal(d.additionalNotRequestedTotal, c("90000.00"));
});

test("the wallet is never project cash", async () => {
  for (const id of ["S0", "S1"] as const) {
    const s = await fixtureAdapter.getSnapshot(id);
    const d = derive(s);
    assert.equal(s.sandboxWallet.isProjectCash, false);
    assert.notEqual(d.cash, d.walletAmount);
    assert.equal(d.avail, d.cash - d.res - d.unc, "AVAIL ignores the wallet");
  }
});

test("exposure conservation and fixture self-check", async () => {
  for (const id of ["S0", "S1"] as const) {
    const s = await fixtureAdapter.getSnapshot(id);
    assert.deepEqual(checkInvariants(s), []);
    for (const e of s.exposures) {
      const parts = [e.r, e.d, e.u, e.nRet, e.nRes].map(c).reduce((a, b) => a + b, 0n);
      assert.equal(parts, c(e.amount));
    }
  }
});

test("self-check catches a broken exposure and a wrong provenance", async () => {
  const s = structuredClone(await fixtureAdapter.getSnapshot("S0"));
  s.exposures[0].u = "300000.00";
  assert.ok(checkInvariants(s).some((p) => p.includes("R+D+U")));
  const t = structuredClone(await fixtureAdapter.getSnapshot("S0")) as unknown as { provenance: string };
  t.provenance = "LIVE";
  assert.ok(checkInvariants(t as never).some((p) => p.includes("provenance")));
});

test("forecast: owner draw lands in week 5; weeks 10 to 13 are not charted", async () => {
  const d = derive(await fixtureAdapter.getSnapshot("S0"));
  assert.equal(d.weeks[2].recordedNet, -c("60000.00"), "draw is not in week 3 any more");
  assert.equal(d.weeks[4].recordedNet, c("2100000.00") - c("60000.00"));
  assert.equal(d.weeks[0].runningBalance, c("390000.00"));
  assert.equal(d.weeks[8].scheduled, true);
  for (const w of d.weeks.slice(9)) {
    assert.equal(w.scheduled, false);
    assert.equal(w.runningBalance, null);
  }
  assert.equal(d.forecastComplete, false);
});

test("fixture decoder rejects field-name, meaning, type, and provenance drift", async () => {
  const original = await fixtureAdapter.getSnapshot("S0");
  const missingField = structuredClone(original) as unknown as Record<string, unknown>;
  delete (missingField.allocation as Record<string, unknown>).cash;
  assert.throws(() => parseSyntheticSnapshot(missingField), /fields differ/);

  const unexpectedField = structuredClone(original) as Snapshot & { allocation: Record<string, unknown> };
  unexpectedField.allocation.cash_available = unexpectedField.allocation.cash;
  assert.throws(() => parseSyntheticSnapshot(unexpectedField), /fields differ/);

  const numberInsteadOfDecimal = structuredClone(original) as unknown as { allocation: { cash: unknown } };
  numberInsteadOfDecimal.allocation.cash = 760000;
  assert.throws(() => parseSyntheticSnapshot(numberInsteadOfDecimal), /expected non-empty string/);

  const walletIsCash = structuredClone(original) as unknown as { sandboxWallet: { isProjectCash: boolean } };
  walletIsCash.sandboxWallet.isProjectCash = true;
  assert.throws(() => parseSyntheticSnapshot(walletIsCash), /isProjectCash must remain false/);

  const liveProvenance = structuredClone(original) as unknown as { provenance: string };
  liveProvenance.provenance = "LIVE";
  assert.throws(() => parseSyntheticSnapshot(liveProvenance), /unsupported value LIVE/);

  assert.throws(() => parseSyntheticSnapshot(original, "S1"), /fixture id mismatch/);
});

test("contract meanings: requested outflows exclude the added framing illustration", async () => {
  for (const id of ["S0", "S1"] as const) {
    const snapshot = await fixtureAdapter.getSnapshot(id);
    const derived = derive(snapshot);
    const framing = snapshot.obligations.find((o) => o.obligationId === "OBL-FRAMING");
    assert.ok(framing);
    assert.equal(framing.amount, "90000.00");
    assert.equal(framing.requested, false);
    assert.equal(derived.requestedTotal, c("915000.00"));
    assert.equal(derived.additionalNotRequestedTotal, c("90000.00"));
    assert.equal(
      derived.requestedTotal,
      snapshot.obligations.filter((o) => o.requested).map((o) => c(o.amount)).reduce((a, b) => a + b, 0n),
    );
    assert.equal(snapshot.forecast.recurring[0].amount, "60000.00");
    assert.equal(snapshot.forecast.recurring[0].illustrative, true);
    assert.equal(snapshot.forecast.scheduleRecordedThroughWeek, 9);
    assert.equal(derived.weeks.slice(9).every((w) => !w.scheduled && w.runningBalance === null), true);
  }
});

test("new reservable capacity uses lineage-wide consumption and the lineage head", async () => {
  const s = structuredClone(await fixtureAdapter.getSnapshot("S0"));
  const root = s.obligations.find((o) => o.obligationId === "OBL-CONCRETE")!;
  root.isLineageHead = false;
  const replacement = {
    ...root,
    obligationId: "OBL-CONCRETE-REPLACEMENT",
    label: "Replacement concrete payable",
    amount: "400000.00",
    isLineageHead: true,
    requested: false,
  };
  s.obligations.push(replacement);
  s.exposures[0].d = "310000.00";
  s.exposures[0].u = "0.00";
  s.cases = s.cases.map((c) => ({ ...c, state: "RESOLVED" }));
  s.allocation.cash = "450000.00";

  const d = derive(s);
  const head = d.obligations.find((o) => o.facts.obligationId === replacement.obligationId)!;
  const prior = d.obligations.find((o) => o.facts.obligationId === root.obligationId)!;
  assert.equal(prior.newReservable, 0n, "non-head member cannot accept a new reservation");
  assert.equal(head.committed, c("310000.00"), "prior member's settlement remains committed");
  assert.equal(head.room, c("90000.00"));
  assert.equal(head.newReservable, c("90000.00"));
});

test("NEW_RESERVABLE is zero for a non-head or a lineage with a nonterminal intent", async () => {
  const s = structuredClone(await fixtureAdapter.getSnapshot("S0"));
  const framing = s.obligations.find((o) => o.obligationId === "OBL-FRAMING")!;
  assert.equal(derive(s).obligations.find((o) => o.facts.obligationId === framing.obligationId)?.newReservable, c("90000.00"));
  framing.hasNonterminalIntent = true;
  assert.equal(derive(s).obligations.find((o) => o.facts.obligationId === framing.obligationId)?.newReservable, 0n);
});

test("approved-ready is not dispatchable for an ineligible payable", async () => {
  const s = structuredClone(await fixtureAdapter.getSnapshot("S0"));
  s.reservations.push({ reservationId: "RES-STEEL-SYN", obligationId: "OBL-STEEL", amount: "1.00", state: "APPROVED_READY" });
  const d = derive(s);
  assert.equal(d.obligations.find((o) => o.facts.obligationId === "OBL-STEEL")?.dispatchableNow, 0n);
});

test("clean-room reset sources are byte-identical and approval preview cannot execute", () => {
  for (const id of ["s0", "s1"]) {
    assert.deepEqual(
      readFileSync(new URL(`../fixtures/${id}.json`, import.meta.url)),
      readFileSync(new URL(`../fixtures/canonical/${id}.json`, import.meta.url)),
    );
  }
  const approval = readFileSync(new URL("../src/app/approvals/page.tsx", import.meta.url), "utf8");
  assert.match(approval, /<button[^>]*disabled[^>]*aria-disabled="true"/s);
  assert.doesNotMatch(approval, /onClick\s*=|fetch\s*\(|\/api\//);
  assert.equal(existsSync(new URL("../src/app/api", import.meta.url)), false);
});

test("all screens share the synthetic provenance banner and keyboard skip link", () => {
  const shell = readFileSync(new URL("../src/components/Shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.indexOf("className=\"skip-link\"") < shell.indexOf("className=\"synthetic-bar\""));
  assert.match(shell, /SYNTHETIC DEMONSTRATION DATA/);
  assert.match(shell, /Source: SYNTHETIC_FIXTURE/);
  assert.match(shell, /aria-label="Incident Room screens"/);
});
