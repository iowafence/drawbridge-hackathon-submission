// Command screen (the redesigned /overview): server-rendered markup checks. Presentation only; every figure is the E3 snapshot's own.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, webRoot } from "./ui_harness.ts";
import type { Harness } from "./ui_harness.ts";

let h: Harness;
const fixture = JSON.parse(readFileSync(join(webRoot, "fixtures/cash_crisis_evidence_v1.json"), "utf8")) as { events: { sha256: string; sequence: number }[] };
const render = (params: Record<string, string>) => h.render("overview", params);
before(async () => {
  h = await buildHarness(["overview"]);
});
after(() => h.dispose());

test("CMD-1 the screen is named Command, keeps the /overview route and the six-screen navigation", async () => {
  const h = await render({ s: "S0" });
  assert.ok(h.includes("<h1>Command</h1>"));
  assert.ok(h.includes("Incident Room · screen 1 of 6"));
  assert.ok(h.includes('<a href="/overview?s=S0" aria-current="page"><span class="n">1</span><span>Command</span></a>'));
  assert.equal([...h.matchAll(/<nav /g)].length, 1);
});

test("CMD-2 the answer states the week-two gap (delayed) or no gap (on time), and ready to send is $0.00", async () => {
  const late = await render({ s: "S0", d: "delayed" });
  assert.match(late, /Projected funding gap of \$1,300,000\.00 in week 2/);
  assert.ok(late.includes("FUNDING GAP"));
  const onTime = await render({ s: "S0", d: "on_time" });
  assert.match(onTime, /No projected funding gap/);
  assert.doesNotMatch(onTime, /Projected funding gap of/);
  for (const h of [late, onTime]) {
    assert.match(h, /Ready to send now: <strong>\$0\.00<\/strong>/);
    assert.match(h, /Ready to send now<\/div><div class="state-value ">\$0\.00<\/div>/);
  }
  assert.match(late, /\$450,000\.00 = \$760,000\.00 − \$0\.00 − \$310,000\.00/, "AVAIL derivation");
});

test("CMD-3 the draw toggle is two plain links that keep the scenario and mark the shown case", async () => {
  for (const s of ["S0", "S1"]) {
    for (const d of ["on_time", "delayed"]) {
      const h = await render({ s, d });
      const links = [...h.matchAll(/<a href="([^"]+)"( aria-current="true")? data-command-case="([a-z_]+)">/g)].map((m) => [m[1], m[2] !== undefined, m[3]]);
      assert.deepEqual(links, [
        [`/overview?s=${s}&amp;d=on_time`, d === "on_time", "on_time"],
        [`/overview?s=${s}&amp;d=delayed`, d === "delayed", "delayed"],
      ]);
    }
  }
});

test("CMD-4 the guided tour is six server-rendered steps joined by plain links", async () => {
  const none = await render({ s: "S0" });
  assert.ok(none.includes("Start guided tour") && !none.includes("GUIDED TOUR"));
  assert.ok((await render({ s: "S0", tour: "0" })).includes("Start guided tour"));
  assert.ok(!(await render({ s: "S0", tour: "7" })).includes("GUIDED TOUR"), "an invalid step shows no tour");
  for (let n = 1; n <= 6; n++) {
    const h = await render({ s: "S0", d: "on_time", tour: String(n) });
    assert.ok(h.includes(`GUIDED TOUR · STEP ${n} OF 6`));
    assert.ok(h.includes(`data-tour-step="${n}"`));
    assert.ok(!h.includes("Start guided tour"));
    const tour = h.match(/<section class="panel tour"[\s\S]*?<\/section>/)![0];
    const hrefs = [...tour.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) assert.match(href, /^\/overview\?s=S0&amp;d=(on_time|delayed)(&amp;tour=[1-6])?(#cmd-[a-z]+)?$/, `tour link stays on the Command route: ${href}`);
    assert.equal(tour.includes(">Next<"), n < 6);
    assert.equal(tour.includes(">Finish<"), n === 6);
    assert.equal(tour.includes(">Back<"), n > 1);
  }
  assert.ok((await render({ s: "S0", d: "on_time", tour: "2" })).includes("&amp;d=delayed&amp;tour=1"), "step 2 Back returns to step 1 on the delayed case");
});

test("CMD-5 no enabled payment, transfer, approval or release control and no script", async () => {
  for (const s of ["S0", "S1"]) {
    for (const d of ["on_time", "delayed"]) {
      const h = await render({ s, d, tour: "5" });
      assert.doesNotMatch(h, /<button|<form|<input|<select|<textarea|<script|onclick=|formaction/i);
      assert.match(h, /<div class="disabled-action" aria-disabled="true">Approve release \(unavailable\)<\/div>/);
      assert.ok(h.includes("Ready for human approval") && h.includes("No release interface exists") || h.includes("no release interface exists"));
    }
  }
});

test("CMD-6 S1 keeps the spending-blocked warning; S0 keeps the capacity-open card", async () => {
  const s1 = await render({ s: "S1" });
  assert.ok(s1.includes("ALLOCATION_BLOCKED") && s1.includes("Do not treat the available figure as spendable") && s1.includes('role="alert"'));
  assert.ok(s1.includes("Positive but NOT spendable while blocked"));
  const s0 = await render({ s: "S0" });
  assert.ok(s0.includes("Capacity open, with known holds") && !s0.includes("ALLOCATION_BLOCKED"));
});

test("CMD-7 requests show their E3 rules and blocked status; the separate payable stays outside the total", async () => {
  const h = await render({ s: "S0" });
  for (const id of ["E3-RULE-101", "E3-RULE-102", "E3-RULE-103", "E3-RULE-104", "E3-RULE-106", "E3-RULE-108"]) assert.ok(h.includes(id), id);
  assert.equal([...h.matchAll(/<span class="pill danger">BLOCKED<\/span>/g)].length, 2);
  assert.ok(h.includes('<span class="pill warn">UNRESOLVED</span>') && h.includes('<span class="pill ok">EVIDENCE ELIGIBLE</span>'));
  assert.ok(h.includes("Separate payable, outside the $915,000.00 above"));
  assert.equal([...h.matchAll(/Not authorized/g)].length, 4, "no request is authorized");
});

test("CMD-8 the six recorded events appear in order with the snapshot's own hashes; no paid figure; wallet disclosed", async () => {
  const h = await render({ s: "S0" });
  const rec = h.match(/<ol class="events">([\s\S]*?)<\/ol>/)![1];
  const shown = [...rec.matchAll(/([0-9a-f]{8})…([0-9a-f]{8})/g)].map((m) => `${m[1]}${m[2]}`);
  assert.deepEqual(shown, fixture.events.slice().sort((a, b) => a.sequence - b.sequence).map((e) => e.sha256.slice(0, 8) + e.sha256.slice(-8)));
  assert.doesNotMatch(h, />Paid</i, "no paid figure is invented");
  assert.ok(h.includes("NOT PROJECT CASH"));
  assert.equal([...h.matchAll(/<div class="state-label role-name">/g)].length, 4, "four bounded agent notes");
  assert.ok(h.includes("no model runs in this application"));
});

test("CMD-9 the chart marks weeks 10 to 13 incomplete and the full evidence is collapsed but present", async () => {
  const h = await render({ s: "S0", d: "delayed" });
  for (const w of [10, 11, 12, 13]) assert.ok(h.includes(`W${w}*`), `week ${w} marked`);
  assert.ok(h.includes('fill="url(#cmd-hatch)"'));
  assert.match(h, /<details class="evidence"><summary>/, "collapsed by default");
  assert.equal([...h.matchAll(/<section id="e3-cash-crisis"/g)].length, 1, "the full E3 evidence section is rendered once");
});
