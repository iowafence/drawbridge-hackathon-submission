// Recorder screen (redesigned): server-rendered markup checks. Events and digests are the snapshot's own and are never altered.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, webRoot } from "./ui_harness.ts";
import type { Harness } from "./ui_harness.ts";

type RawEvent = { sequence: number; id: string; role: string; type: string; title: string; finding: string; when: string; evidence_ids: string[]; sha256: string; prev_sha256: string };
const fixture = JSON.parse(readFileSync(join(webRoot, "fixtures/cash_crisis_evidence_v1.json"), "utf8")) as {
  events: RawEvent[];
  evidence: { id: string }[];
  schema: string;
  task: string;
  snapshot_content_sha256: string;
  fixture: { sha256: string };
  limitations: string[];
};
const events = fixture.events.slice().sort((a, b) => a.sequence - b.sequence);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
let h: Harness;
let html = "";
before(async () => {
  h = await buildHarness(["recorder"]);
  html = await h.render("recorder", { s: "S0" });
});
after(() => h.dispose());

test("REC-1 the summary states the link count and does not claim an external anchor", () => {
  assert.ok(html.includes("LINKS CONSISTENT") && html.includes("6 recorded events, 6 of 6 predecessor links match"));
  assert.ok(html.includes("It is not an externally anchored proof"));
  assert.equal([...html.matchAll(/externally anchored/g)].length, 1, "the only mention is the disclaimer");
  assert.ok(html.includes("<h1>Flight recorder</h1>") && html.includes("Incident Room · screen 5 of 6"));
});

test("REC-2 the six events appear in order with the snapshot's own full digests and predecessor links", () => {
  const chain = html.match(/<ol class="chain">([\s\S]*?)<\/ol>/)![1];
  const prevs = [...chain.matchAll(/<dt>prev<\/dt><dd class="digest">([0-9a-f]{64})<\/dd><dt>sha256<\/dt><dd class="digest digest-own">([0-9a-f]{64})<\/dd>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(prevs, events.map((e) => [e.prev_sha256, e.sha256]));
  assert.equal(prevs[0][0], "0".repeat(64));
  for (let i = 1; i < prevs.length; i++) assert.equal(prevs[i][0], prevs[i - 1][1], `event ${i + 1} links to event ${i}`);
  assert.ok(chain.includes("ROOT · ZERO PREDECESSOR"));
  for (let n = 2; n <= 6; n++) assert.ok(chain.includes(`LINKED TO #${n - 1}`));
  const order = events.map((e) => chain.indexOf(esc(e.title)));
  assert.ok(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1])), "titles appear in event order");
});

test("REC-3 event content is displayed unaltered: title, finding, role, date and evidence ids", () => {
  const chain = html.match(/<ol class="chain">([\s\S]*?)<\/ol>/)![1];
  for (const e of events) {
    assert.ok(chain.includes(esc(e.finding)), `finding of event ${e.sequence}`);
    assert.ok(chain.includes(`<span class="chip">${e.role}</span>`) && chain.includes(e.when));
    for (const ev of e.evidence_ids) assert.ok(chain.includes(`<span class="chip mono">${ev}</span>`), ev);
  }
});

test("REC-4 human decisions are separated from agent findings", () => {
  const section = html.match(/<section id="rec-authorship"[\s\S]*?<\/section>/)![0];
  assert.ok(section.includes('<div class="state-value">0</div>') && section.includes("No approval, release or resolution by a person is recorded."));
  assert.ok(section.includes("not implemented") && section.includes("automated decision authority is none"));
  assert.ok(section.includes('<div class="state-value">6</div>'));
  for (const [role, n] of [["TREASURY", 2], ["PAYMASTER", 2], ["PRECON", 1], ["PROJECT CFO", 1]] as const) assert.ok(section.includes(`${role}</span>: ${n} ${n === 1 ? "event" : "events"}`), role);
});

test("REC-5 the evidence index lists every record with the events that cite it", () => {
  const section = html.match(/<section id="rec-evidence"[\s\S]*?<\/section>/)![0];
  for (const ev of fixture.evidence) assert.ok(section.includes(`>${ev.id}<`), ev.id);
  assert.ok(section.includes("8 records, all synthetic."));
  assert.match(section, /EV-DRAW-001<\/span>[\s\S]*?#1, #5, #6/);
  assert.match(section, /EV-ELIG-001<\/span>[\s\S]*?>none</);
});

test("REC-6 provenance and simulation-only disclosures come from the snapshot", () => {
  assert.ok(html.includes(fixture.schema) && html.includes(fixture.task) && html.includes(fixture.snapshot_content_sha256) && html.includes(fixture.fixture.sha256));
  const lim = html.match(/<section id="rec-limits"[\s\S]*?<\/section>/)![0];
  for (const t of fixture.limitations) assert.ok(lim.includes(esc(t).replace(/&#x27;/g, "&#x27;")) || lim.includes(t.replace(/'/g, "&#x27;")), t.slice(0, 40));
  assert.ok(lim.includes("Provider writes") && lim.includes("None"));
});

test("REC-7 no control and no script; the earlier ledger detail is collapsed but present", () => {
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea|<script|onclick=/i);
  assert.match(html, /<details class="evidence"><summary>Scenario ledger and reconciliation/);
  for (const t of ["Reconciliation state", "When a bar or stop arrives near a send", "Event history"]) assert.ok(html.includes(t), t);
});
