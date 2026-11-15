// Incident screen (redesigned): server-rendered markup checks. Presentation only; nothing is evaluated or invented here.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, webRoot } from "./ui_harness.ts";
import type { Harness } from "./ui_harness.ts";

let h: Harness;
const fixture = JSON.parse(readFileSync(join(webRoot, "fixtures/cash_crisis_evidence_v1.json"), "utf8")) as { events: { sha256: string; sequence: number }[] };
const render = (params: Record<string, string>) => h.render("incident", params);
before(async () => {
  h = await buildHarness(["incident"]);
});
after(() => h.dispose());

test("INC-1 status and trigger: the week-two shortfall (delayed) or no incident (on time), with the draw dates", async () => {
  const late = await render({ s: "S0", d: "delayed" });
  assert.ok(late.includes("OPEN INCIDENT") && late.includes("Week-two funding shortfall of $1,300,000.00"));
  assert.match(late, /scheduled for 2026-11-18 arrives 2026-11-30, 12 days late/);
  assert.ok(late.includes("<h1>Incident detail</h1>") && late.includes("Incident Room · screen 3 of 6"));
  const onTime = await render({ s: "S0", d: "on_time" });
  assert.ok(onTime.includes("NOT TRIGGERED") && !onTime.includes("OPEN INCIDENT"));
  assert.ok(onTime.includes("the three immediate requests stay stopped"));
  assert.match(late, /Ready to send now<\/div><div class="kpi-value ">\$0\.00<\/div>/);
});

test("INC-2 the funding-case links are plain links on the Incident route and keep the scenario", async () => {
  for (const s of ["S0", "S1"]) {
    for (const d of ["on_time", "delayed"]) {
      const html = await render({ s, d });
      const links = [...html.matchAll(/<a href="([^"]+)"( aria-current="true")? data-command-case="([a-z_]+)">/g)].map((m) => [m[1], m[2] !== undefined, m[3]]);
      assert.deepEqual(links, [
        [`/incident?s=${s}&amp;d=on_time`, d === "on_time", "on_time"],
        [`/incident?s=${s}&amp;d=delayed`, d === "delayed", "delayed"],
      ]);
      assert.ok(!html.includes("Start guided tour"), "the tour belongs to Command");
    }
  }
});

test("INC-3 stopped commitments carry their statuses, E3 rule references and evidence", async () => {
  const html = await render({ s: "S0" });
  for (const id of ["E3-RULE-101", "E3-RULE-102", "E3-RULE-103", "E3-RULE-104", "E3-RULE-106", "E3-RULE-108"]) assert.ok(html.includes(id), id);
  for (const id of ["EV-STEEL-001", "EV-ELEC-001", "EV-CONC-001", "EV-CONC-002", "EV-ELIG-001"]) assert.ok(html.includes(id), id);
  const section = html.match(/<section id="inc-commitments"[\s\S]*?<\/section>/)![0];
  assert.equal([...section.matchAll(/<span class="pill danger">BLOCKED<\/span>/g)].length, 2);
  assert.ok(section.includes('<span class="pill warn">UNRESOLVED</span>') && section.includes('<span class="pill ok">EVIDENCE ELIGIBLE</span>'));
  assert.ok(section.includes("SEPARATE PAYABLE") && section.includes("Repeat attempt: blocked"));
  assert.equal([...section.matchAll(/Release: not authorized/g)].length, 4, "no decision authorizes a release");
});

test("INC-4 operational effects are stated from the decisions; nothing is sent or stored", async () => {
  const html = await render({ s: "S0" });
  assert.ok(html.includes("Not permitted for 3 of 4 decisions.") && html.includes("Not authorized on 4 of 4 decisions."));
  assert.ok(html.includes("Required on 4 of 4 decisions. None is recorded.") && html.includes("Blocked for REQ-CONC-001."));
  assert.match(html, /reduces it from \$760,000\.00 to \$450,000\.00/);
  assert.ok(html.includes("0 and 0. Nothing is sent or stored."));
});

test("INC-5 four bounded agent findings, each with its boundary and evidence", async () => {
  const html = await render({ s: "S0" });
  const agents = html.match(/<section id="inc-agents"[\s\S]*?<\/section>/)![0];
  for (const role of ["PRECON", "PROJECT CFO", "TREASURY", "PAYMASTER"]) assert.ok(agents.includes(`>${role}<`), role);
  assert.equal([...agents.matchAll(/Boundary: /g)].length, 4);
  assert.ok(agents.includes("No payment authority.") && agents.includes("Zero provider writes; no release command exists."));
  assert.ok(agents.includes("No model runs here"));
});

test("INC-6 decision history lists the six events in order with the snapshot's own hashes", async () => {
  const html = await render({ s: "S0" });
  const hist = html.match(/<ol class="history">([\s\S]*?)<\/ol>/)![1];
  const shown = [...hist.matchAll(/sha256 ([0-9a-f]{8})…([0-9a-f]{8})/g)].map((m) => m[1] + m[2]);
  assert.deepEqual(shown, fixture.events.slice().sort((a, b) => a.sequence - b.sequence).map((e) => e.sha256.slice(0, 8) + e.sha256.slice(-8)));
  assert.ok(html.includes("No human approval or decision is recorded in this scenario."));
});

test("INC-7 no control, no script, no enabled release or resend affordance", async () => {
  for (const s of ["S0", "S1"]) {
    for (const d of ["on_time", "delayed"]) {
      const html = await render({ s, d });
      assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea|<script|onclick=|formaction/i);
    }
  }
  assert.ok((await render({ s: "S0" })).includes("Manual resend is disabled."));
});

test("INC-8 S1 keeps the allocation-wide alert; S0 does not show it", async () => {
  const s1 = await render({ s: "S1" });
  assert.ok(s1.includes('role="alert"') && s1.includes("ALLOCATION-WIDE") && s1.includes("Authorized new commitment: $0.00"));
  assert.ok(!(await render({ s: "S0" })).includes("ALLOCATION-WIDE"));
});

test("INC-9 the full E3 evidence is collapsed but present, once", async () => {
  const html = await render({ s: "S0" });
  assert.match(html, /<details class="evidence"><summary>/);
  assert.equal([...html.matchAll(/<section id="e3-incident"/g)].length, 1);
});
