// Payables screen (redesigned): server-rendered markup checks. No payment total is invented and nothing can be sent.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, webRoot } from "./ui_harness.ts";
import type { Harness } from "./ui_harness.ts";

const s0 = JSON.parse(readFileSync(join(webRoot, "fixtures/s0.json"), "utf8")) as { obligations: { obligationId: string; label: string; eligibility: string; eligibilityNote: string; amount: string }[] };
const e3 = JSON.parse(readFileSync(join(webRoot, "fixtures/cash_crisis_evidence_v1.json"), "utf8")) as { evidence: { id: string; status: string; detail: string }[] };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
let h: Harness;
before(async () => {
  h = await buildHarness(["payables"]);
});
after(() => h.dispose());

test("PAY-1 the summary counts obligations and shows only existing totals", async () => {
  const html = await h.render("payables", { s: "S0" });
  assert.ok(html.includes("<h1>Obligations and exclusions</h1>") && html.includes("Incident Room · screen 2 of 6"));
  const sum = html.match(/<section class="panel" aria-label="Payables summary"[\s\S]*?<\/section>/)![0];
  assert.ok(sum.includes(">4<") && sum.includes("2 eligible, 2 excluded."));
  assert.ok(sum.includes("$915,000.00") && sum.includes("$90,000.00") && sum.includes("$0.00"));
  assert.ok(!html.includes("$1,005,000.00"), "no total across all obligations is invented");
});

test("PAY-2 every obligation shows its eligibility, request status, ready-to-send $0.00 and refusal reason", async () => {
  const html = await h.render("payables", { s: "S0" });
  const table = html.match(/<section id="pay-table"[\s\S]*?<\/section>/)![0];
  for (const o of s0.obligations) {
    assert.ok(table.includes(esc(o.label)), o.label);
    assert.ok(table.includes(esc(o.eligibilityNote)), `reason for ${o.obligationId}`);
    assert.ok(table.includes(`>${o.eligibility}<`), `eligibility ${o.eligibility}`);
  }
  assert.equal([...table.matchAll(/<td class="num">\$0\.00<\/td>/g)].length, 4, "nothing is ready to send");
  assert.equal([...table.matchAll(/<span class="pill ">requested<\/span>/g)].length, 3);
  assert.equal([...table.matchAll(/not requested/g)].length, 1);
  for (const id of ["E3-RULE-101", "E3-RULE-102", "E3-RULE-103", "E3-RULE-104", "E3-RULE-106"]) assert.ok(table.includes(id), id);
});

test("PAY-3 approval dependencies and evidence gaps are shown per obligation, with the snapshot's own evidence", async () => {
  const html = await h.render("payables", { s: "S0" });
  assert.equal([...html.matchAll(/A person must approve any release\. No approval is recorded/g)].length, 4);
  const steel = html.match(/<section class="panel" aria-labelledby="pay-OBL-STEEL"[\s\S]*?<\/section>/)![0];
  for (const ev of e3.evidence.filter((x) => x.id.startsWith("EV-STEEL"))) {
    assert.ok(steel.includes(ev.id) && steel.includes(`<span class="chip nowrap">${ev.status}</span>`) && steel.includes(esc(ev.detail)), ev.id);
  }
  assert.ok(steel.includes("OPEN"), "the open steel scope gap is visible");
  const concrete = html.match(/<section class="panel" aria-labelledby="pay-OBL-CONCRETE"[\s\S]*?<\/section>/)![0];
  assert.ok(concrete.includes("UNKNOWN") && concrete.includes("HELD"));
});

test("PAY-4 no control, no script, and the S1 scenario renders the same refusals", async () => {
  for (const s of ["S0", "S1"]) {
    const html = await h.render("payables", { s });
    assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea|<script|onclick=/i);
    assert.equal([...html.matchAll(/data-obligation="/g)].length, 4);
    assert.ok(html.includes("no release interface exists"));
  }
});
