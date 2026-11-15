// SIM-ENG-002-E3 / E3-D10 — frontend tests for the E3 cash-crisis sections of the Overview and Incident screens
// (E3-AT-7 to E3-AT-10) and for the strict snapshot reader.
// The pages and components are React server components in .tsx files. As in the accepted eligibility and Shell tests,
// they are transpiled with the project's TypeScript compiler into a temporary directory OUTSIDE the source tree, their
// imports are rewritten to absolute locations, and they are rendered with react-dom/server. Each page is also rendered
// a second time with the E3 component replaced by an empty stand-in, which gives the page exactly as it was before E3.
// No network, no backend, no repository write: everything written lives under os.tmpdir().
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMoney, formatMoneyShort } from "../src/contract/money.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = join(here, "..");
const fixturePath = join(webRoot, "fixtures", "cash_crisis_evidence_v1.json");
const eligibilityPath = join(webRoot, "fixtures", "eligibility_evidence_v1.json");

// Accepted inputs that E3 must leave byte-identical (task record section 2.4).
const ACCEPTED_SHA256 = {
  overviewPage: "17268931d31a13839347ba97da0836e5fc6ed8bca6b12296d5271ae889b8432a",
  incidentPage: "d4d1aea0a2a30d28e165b50246043ccc92c5de774465776597e99a12405f1310",
  shell: "1561ff27ff6dfc2f5f7c3dc2c572c582cb3f98db5deb01ddaca19ae5bdf3fa88",
  globalsCss: "8f956e9e621b89a193ff854c46d377f5125daf3c97ed505be423431fc19358a2",
  eligibilityEvidence: "60c18bb46bb3a8d774c55a77d0592d3608340c5d346740cd2d31543bc7779350",
} as const;

// UI redesign candidate (ui/erp-redesign): explicit pins for the files the redesign deliberately changed. See UI_BASELINE.md.
// The ACCEPTED_SHA256 values above are the HISTORICAL accepted-E3 pins; tests/ui_baseline.test.ts reproduces them from Git.
const UI_BASELINE = JSON.parse(readFileSync(join(webRoot, "tests/ui-baseline.json"), "utf8")) as { candidate: Record<string, string>; preserved: Record<string, string> };

const SCENARIOS = ["S0", "S1"] as const;
const CASES = ["on_time", "delayed"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Case = (typeof CASES)[number];

// ---- The fixture as the tests read it: raw JSON, independently of the application's reader ----

type RawRow = {
  week: number; start: string; end: string; opening_cents: number; receipts_cents: number; owner_draw_receipt_cents: number;
  other_receipts_cents: number; outflows_cents: number; closing_cents: number; quality: string; negative: boolean;
};
type RawForecast = {
  case: string; draw_week: number; draw_date: string; rows: RawRow[]; ending_cash_cents: number; minimum_closing_cents: number;
  peak_projected_funding_gap_cents: number; funding_gap_basis: string; worst_week: number; negative_week_count: number;
  first_negative_week: number | null; incomplete_weeks: number[]; limitations: string[];
};
type RawDecision = {
  decision_id: string; request_id: string; obligation_id: string; scenario: string; description: string; party: string;
  amount_cents: number; status: string; rule_ids: string[]; rationale: string[]; evidence_ids: string[]; release_status: string;
  repeat_attempt: string; in_immediate_requests: boolean; new_reservation_permitted: boolean; provider_writes: number; database_writes: number;
};
type RawSnapshot = {
  schema: string; task: string; synthetic: boolean; classification: string; snapshot_content_sha256: string;
  fixture: { fixture_id: string; path: string; sha256: string };
  project: { project_id: string; label: string; contract_cents: number; projected_gross_profit_cents: number };
  forecast_inputs: { opening_operating_cash_cents: number; start_date: string };
  scenarios: { id: Scenario; new_commitment_authority: boolean; note: string }[];
  draw: { amount_cents: number; delay_days: number; scheduled_date: string; delayed_date: string; on_time_week: number; delayed_week: number; evidence_id: string };
  capital: {
    allocation_cents: number; concrete_hold_cents: number; available_after_hold_cents: number; immediate_requests_cents: number;
    nominal_gap_cents: number; separate_payable_cents: number; hold_application_count: number;
    hold_applications: { request_id: string; obligation_id: string; amount_cents: number; evidence_ids: string[] }[];
    eligibility_demo_reference: { reserve_cents: number; initial_availability_cents: number; applied_in_this_model: boolean; note: string };
    calculated_available_by_scenario_cents: Record<Scenario, number>;
    new_reservable_by_scenario_cents: Record<Scenario, number>; notes: string[];
  };
  decisions: Record<Scenario, RawDecision[]>;
  decision_counts: Record<Scenario, Record<string, number>>;
  forecasts: Record<Case, RawForecast>;
  events: { id: string; sequence: number; when: string; title: string; finding: string; evidence_ids: string[]; sha256: string; prev_sha256: string }[];
  evidence: { id: string; kind: string; status: string; title: string; detail: string }[];
  findings: { role: string; finding: string; boundary: string; evidence_ids: string[] }[];
  assumptions: { id: string; label: string; subject: string; text: string }[];
  rules: Record<string, string>;
  limitations: string[];
  controls: Record<string, boolean | number>;
};

// The authoritative snapshot as the finance lane reported it: the committed file must be these exact bytes.
const AUTHORITATIVE = {
  fileSha256: "2cb989455cc6ba0fe18d2a604010ac7fdf96c797afaca53e8bbc156d058187a0",
  fileBytes: 41928,
  finalEventSha256: "3dbd1bff4908a1963776ac34dd9b9c82e41423db6aa2eb47e6490f98cb162ac1",
  topLevelKeys: [
    "amount_unit", "assumptions", "capital", "classification", "controls", "currency", "decision_counts", "decisions", "draw",
    "events", "evidence", "findings", "fixture", "forecast_inputs", "forecasts", "limitations", "project", "rules", "scenarios",
    "schema", "snapshot_content_sha256", "synthetic", "task",
  ],
} as const;

/** The finance simulation's digest form: keys sorted at every level, no insignificant whitespace, ASCII. */
function canonicalCompact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCompact).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalCompact(o[k])}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  assert.match(text, /^[\x20-\x7e]*$/, "ASCII only");
  return text;
}
const without = (o: object, k: string) => Object.fromEntries(Object.entries(o).filter(([name]) => name !== k));

let fixture: RawSnapshot;
let eligibility: { project: { availability_initial: { restricted_reserves: number; available_to_commit: number } } };
let data: typeof import("../src/data/cashCrisis.ts");
let tmp = "";

type PageModule = { default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown> };
const pages: Record<"overview" | "incident", { full: PageModule; base: PageModule }> = {} as never;
const html: Record<string, string> = {};

const money = (centsValue: number) => formatMoney(BigInt(centsValue));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
/** Rendered snapshot text with the keep-together wrappers around currency amounts removed; the text itself is unchanged. */
const plain = (text: string) => text.replace(/<span style="white-space:nowrap">([^<]*)<\/span>/g, "$1");

function transpile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true },
  }).outputText;
}
function rewrite(code: string, map: Record<string, string>): string {
  for (const [from, to] of Object.entries(map)) code = code.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`"${to}"`);
  return code;
}

async function render(screen: "overview" | "incident", variant: "full" | "base", params: Record<string, string>): Promise<string> {
  return renderToStaticMarkup((await pages[screen][variant].default({ searchParams: Promise.resolve(params) })) as never);
}
const key = (screen: string, s: string, d: string) => `${screen}:${s}:${d}`;
const page = (screen: "overview" | "incident", s: Scenario, d: Case | "default" = "default") => html[key(screen, s, d)];
const SECTION_ID = { overview: "e3-cash-crisis", incident: "e3-incident" } as const;
/** The E3 section: from its opening tag to what follows it directly (the Shell's footer; on the redesigned Command screen, the close of its "Full evidence" expander). */
function e3(screen: "overview" | "incident", s: Scenario, d: Case | "default" = "default"): string {
  const h = page(screen, s, d);
  const start = h.indexOf(`<section id="${SECTION_ID[screen]}"`);
  const end = h.indexOf("</details>", start);
  assert.ok(start >= 0 && end > start, `${screen} ${s} ${d}: E3 section rendered before the footer`);
  return h.slice(start, end);
}

before(async () => {
  fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RawSnapshot;
  eligibility = JSON.parse(readFileSync(eligibilityPath, "utf8"));
  data = await import("../src/data/cashCrisis.ts");

  tmp = mkdtempSync(join(tmpdir(), "e3-cashcrisis-"));
  const resolve = (spec: string) => fileURLToPath(import.meta.resolve(spec));
  const url = (file: string) => pathToFileURL(join(tmp, file)).href;
  const src = (rel: string) => pathToFileURL(join(webRoot, "src", rel)).href;
  const read = (rel: string) => readFileSync(join(webRoot, "src", rel), "utf8");
  const jsx = pathToFileURL(resolve("react/jsx-runtime")).href;
  const emit = (file: string, rel: string, map: Record<string, string>) =>
    writeFileSync(join(tmp, file), rewrite(transpile(read(rel), rel), { "react/jsx-runtime": jsx, ...map }));

  writeFileSync(join(tmp, "link.mjs"), `import { createElement } from ${JSON.stringify(pathToFileURL(resolve("react")).href)};\nexport default function Link(p){ const { href, children, ...rest } = p; return createElement("a", { href, ...rest }, children); }\n`);
  writeFileSync(join(tmp, "absent.mjs"), "export function CashCrisisForecast(){ return null; }\nexport function CashCrisisIncident(){ return null; }\n");
  const shared = {
    "next/link": url("link.mjs"),
    "../contract/money.ts": src("contract/money.ts"),
    "../data/adapter.ts": src("data/adapter.ts"),
    "../data/cashCrisis.ts": src("data/cashCrisis.ts"),
    "./Figure.tsx": url("Figure.mjs"),
    "./CashCrisisForecast.tsx": url("CashCrisisForecast.mjs"),
  };
  emit("Figure.mjs", "components/Figure.tsx", {});
  emit("Shell.mjs", "components/Shell.tsx", shared);
  emit("ForecastChart.mjs", "components/ForecastChart.tsx", shared);
  emit("CashCrisisForecast.mjs", "components/CashCrisisForecast.tsx", shared);
  emit("CashCrisisIncident.mjs", "components/CashCrisisIncident.tsx", shared);
  emit("Command.mjs", "components/Command.tsx", { ...shared, "../contract/derive.ts": src("contract/derive.ts") });
  emit("IncidentRoom.mjs", "components/IncidentRoom.tsx", { ...shared, "../contract/derive.ts": src("contract/derive.ts") });
  const pageMap = (variant: "full" | "base") => ({
    "../../components/Figure.tsx": url("Figure.mjs"),
    "../../components/ForecastChart.tsx": url("ForecastChart.mjs"),
    "../../components/Shell.tsx": url("Shell.mjs"),
    "../../components/Command.tsx": url("Command.mjs"),
    "../../components/IncidentRoom.tsx": url("IncidentRoom.mjs"),
    "../../components/CashCrisisForecast.tsx": variant === "full" ? url("CashCrisisForecast.mjs") : url("absent.mjs"),
    "../../components/CashCrisisIncident.tsx": variant === "full" ? url("CashCrisisIncident.mjs") : url("absent.mjs"),
    "../../contract/money.ts": src("contract/money.ts"),
    "../../data/load.ts": src("data/load.ts"),
    "../../data/cashCrisis.ts": src("data/cashCrisis.ts"),
  });
  for (const screen of ["overview", "incident"] as const) {
    for (const variant of ["full", "base"] as const) {
      emit(`${screen}.${variant}.mjs`, `app/${screen}/page.tsx`, pageMap(variant));
    }
    pages[screen] = {
      full: (await import(url(`${screen}.full.mjs`))) as PageModule,
      base: (await import(url(`${screen}.base.mjs`))) as PageModule,
    };
    for (const s of SCENARIOS) {
      html[key(screen, s, "default")] = await render(screen, "full", { s });
      html[key(screen, s, "base")] = await render(screen, "base", { s });
      for (const d of CASES) html[key(screen, s, d)] = await render(screen, "full", { s, d });
    }
  }
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---- The snapshot and its strict reader ----

test("E3-W1 the committed snapshot passes the strict reader and is marked synthetic, non-operational and without authority", () => {
  const view = data.buildCashCrisisView(fixture);
  assert.equal(view.schema, data.CASH_CRISIS_SCHEMA);
  assert.ok(fixture.classification.includes("SYNTHETIC") && fixture.classification.includes("NON-OPERATIONAL"));
  assert.equal(fixture.controls.synthetic_only, true);
  assert.equal(fixture.controls.read_only, true);
  assert.equal(fixture.controls.provider_writes, 0);
  assert.equal(fixture.controls.database_writes, 0);
  assert.equal(fixture.controls.real_payment_authority, false);
  assert.deepEqual(Object.keys(view.decisions), ["S0", "S1"]);
  assert.deepEqual(Object.keys(view.forecasts), ["on_time", "delayed"]);
  for (const d of CASES) assert.equal(view.forecasts[d].rows.length, 13);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.task, "SIM-ENG-002-E3");
  assert.equal(fixture.schema, "drawbridge.sim-eng-002-e3.cash-crisis-evidence.v1");
  assert.equal(data.cashCrisis.snapshotContentSha256, fixture.snapshot_content_sha256);
});

test("E3-W2 the reader exposes the snapshot's own cents and derives no figure of its own", () => {
  const view = data.buildCashCrisisView(fixture);
  assert.equal(view.capital.allocation, BigInt(fixture.capital.allocation_cents));
  assert.equal(view.capital.concreteHold, BigInt(fixture.capital.concrete_hold_cents));
  assert.equal(view.capital.availableAfterHold, BigInt(fixture.capital.available_after_hold_cents));
  assert.equal(view.capital.immediateRequests, BigInt(fixture.capital.immediate_requests_cents));
  assert.equal(view.capital.nominalOverAllocation, BigInt(fixture.capital.nominal_gap_cents));
  for (const s of SCENARIOS) {
    assert.equal(view.capital.newReservable[s], BigInt(fixture.capital.new_reservable_by_scenario_cents[s]));
    assert.deepEqual(view.decisions[s].map((x) => [x.id, x.requestId, x.status, x.amount, x.releaseStatus, x.ruleIds, x.repeatAttempt]), fixture.decisions[s].map((x) => [x.decision_id, x.request_id, x.status, BigInt(x.amount_cents), x.release_status, x.rule_ids, x.repeat_attempt]));
  }
  for (const d of CASES) {
    assert.deepEqual(
      view.forecasts[d].rows.map((r) => [r.week, r.opening, r.receipts, r.outflow, r.closing, r.quality]),
      fixture.forecasts[d].rows.map((r) => [r.week, BigInt(r.opening_cents), BigInt(r.receipts_cents), BigInt(r.outflows_cents), BigInt(r.closing_cents), r.quality]),
    );
    assert.equal(view.forecasts[d].peakFundingGap, BigInt(fixture.forecasts[d].peak_projected_funding_gap_cents));
    assert.equal(view.forecasts[d].worstWeek, fixture.forecasts[d].worst_week);
  }
  const source = readFileSync(join(webRoot, "src/data/cashCrisis.ts"), "utf8");
  assert.doesNotMatch(source, /E3-RULE-|RULE-1[0-9]{2}|classify|facts\.(disputed|change_order_signed|evidence_complete|prior_transfer_state)\s*(\)|[=!?&|])/, "the reader re-implements no finance rule");
  for (const s of SCENARIOS) for (const x of view.decisions[s]) assert.equal("facts" in x, false, "the evidence flags are not exposed to the screens");
  assert.deepEqual(view.rules, Object.entries(fixture.rules).map(([id, text]) => ({ id, text })));
  assert.deepEqual(view.assumptions, fixture.assumptions);
  assert.equal(view.capital.eligibilityReference.reserve, BigInt(fixture.capital.eligibility_demo_reference.reserve_cents));
  assert.equal(view.capital.eligibilityReference.initialAvailability, BigInt(fixture.capital.eligibility_demo_reference.initial_availability_cents));
});

test("E3-W3 the reader fails closed on malformed, inconsistent or over-claiming snapshots", () => {
  const broken = (label: string, edit: (s: any) => void, expected: RegExp) => {
    const copy = structuredClone(fixture) as any;
    edit(copy);
    assert.throws(() => data.buildCashCrisisView(copy), expected, label);
  };
  broken("float cents", (s) => { s.capital.allocation_cents = 76000000.5; }, /expected integer/);
  broken("string cents", (s) => { s.decisions.S0[0].amount_cents = "42000000"; }, /expected integer/);
  broken("boolean cents", (s) => { s.forecasts.delayed.rows[0].closing_cents = true; }, /expected integer/);
  broken("non-finite", (s) => { s.draw.amount_cents = Number.POSITIVE_INFINITY; }, /expected integer/);
  broken("unsafe integer", (s) => { s.project.contract_cents = 2 ** 60; }, /expected integer/);
  broken("negative request", (s) => { s.decisions.S0[0].amount_cents = -1; }, /non-negative/);
  broken("missing key", (s) => { delete s.capital.concrete_hold_cents; }, /missing key/);
  broken("missing top-level block", (s) => { delete s.assumptions; }, /missing key/);
  broken("stored verdict", (s) => { s.decisions.S0[0].verdict = "PAY"; }, /unknown key/);
  broken("unknown top-level key", (s) => { s.approved = true; }, /unknown key/);
  broken("prototype key", (s) => { s.schema_version = "E3-OFFLINE-1"; }, /unknown key/);
  broken("preformatted amount", (s) => { s.capital.allocation = "$760,000.00"; }, /unknown key/);
  broken("wrong schema", (s) => { s.schema = "other"; }, /schema/);
  broken("wrong task", (s) => { s.task = "SIM-ENG-002-E2"; }, /task/);
  broken("not synthetic", (s) => { s.synthetic = false; }, /synthetic/);
  broken("not classified synthetic", (s) => { s.classification = "LIVE"; }, /synthetic/);
  broken("other currency", (s) => { s.currency = "EUR"; }, /USD/);
  broken("other unit", (s) => { s.amount_unit = "DOLLARS"; }, /minor units/);
  broken("payment authority", (s) => { s.controls.real_payment_authority = true; }, /authority/);
  broken("release interface", (s) => { s.controls.release_interface_exists = true; }, /authority/);
  broken("provider write", (s) => { s.controls.provider_writes = 1; }, /must be 0/);
  broken("release authorized", (s) => { s.decisions.S1[3].release_status = "AUTHORIZED"; }, /NOT_AUTHORIZED/);
  broken("decision provider write", (s) => { s.decisions.S0[2].provider_writes = 1; }, /must be 0/);
  broken("decision database write", (s) => { s.decisions.S0[2].database_writes = 1; }, /must be 0/);
  broken("no human approval", (s) => { s.decisions.S0[3].human_approval_required = false; }, /must be true/);
  broken("unknown status", (s) => { s.decisions.S0[0].status = "ALLOWED"; }, /unknown value/);
  broken("unknown rule", (s) => { s.decisions.S0[0].rule_ids[0] = "E3-RULE-999"; }, /unknown rule/);
  broken("rationale not the rule text", (s) => { s.decisions.S0[0].rationale[0] = "Pay it."; }, /is not the text of/);
  broken("decision in the wrong scenario", (s) => { s.decisions.S0[0].scenario = "S1"; }, /not filed under S0/);
  broken("malformed identifier", (s) => { s.evidence[0].id = "ev draw <1>"; }, /malformed identifier/);
  broken("unknown evidence cited", (s) => { s.decisions.S0[0].evidence_ids = ["EV-NONE-999"]; s.decisions.S1[0].evidence_ids = ["EV-NONE-999"]; }, /unknown evidence/);
  broken("unknown evidence cited by event", (s) => { s.events[1].evidence_ids = ["EV-NONE-999"]; }, /unknown evidence/);
  broken("unknown draw evidence", (s) => { s.draw.evidence_id = "EV-NONE-999"; }, /unknown evidence/);
  broken("duplicate evidence", (s) => { s.evidence[1].id = s.evidence[0].id; }, /duplicate evidence/);
  broken("broken event chain", (s) => { s.events[2].prev_sha256 = "f".repeat(64); }, /does not chain/);
  broken("event out of sequence", (s) => { s.events[1].sequence = 5; }, /sequence/);
  broken("unlabelled assumption", (s) => { s.assumptions[0].label = "VERIFIED"; }, /SYNTHETIC/);
  broken("twelve rows", (s) => { s.forecasts.on_time.rows.pop(); }, /13 weekly rows/);
  broken("row does not reconcile", (s) => { s.forecasts.delayed.rows[4].closing_cents += 1; }, /reconcile/);
  broken("rows do not chain", (s) => { s.forecasts.delayed.rows[5].opening_cents += 100; s.forecasts.delayed.rows[5].closing_cents += 100; }, /previous closing/);
  broken("unknown quality", (s) => { s.forecasts.on_time.rows[12].quality = "VERIFIED"; }, /unknown value/);
  broken("draw relabelled as another receipt", (s) => { const r = s.forecasts.delayed.rows[2]; r.other_receipts_cents = r.owner_draw_receipt_cents; r.owner_draw_receipt_cents = 0; }, /exactly once/);
  broken("draw week misreported", (s) => { s.forecasts.delayed.draw_week = 1; }, /draw_week/);
  broken("gap not a projection", (s) => { s.forecasts.delayed.funding_gap_basis = "OBSERVED_OVERDRAFT"; }, /projection/);
  broken("incomplete weeks hidden", (s) => { s.forecasts.on_time.incomplete_weeks = []; }, /incomplete_weeks/);
  broken("second hold", (s) => { s.capital.available_after_hold_cents -= s.capital.concrete_hold_cents; }, /single hold/);
  broken("hold applied twice", (s) => { s.capital.hold_applications.push(structuredClone(s.capital.hold_applications[0])); }, /exactly once/);
  broken("availability differs by scenario", (s) => { s.capital.calculated_available_by_scenario_cents.S1 = 0; }, /same in both scenarios/);
  broken("S1 authority", (s) => { s.capital.new_reservable_by_scenario_cents.S1 = 45000000; }, /must be 0/);
  broken("eligibility reserve applied", (s) => { s.capital.eligibility_demo_reference.applied_in_this_model = true; }, /must not be applied/);
  broken("counts disagree", (s) => { s.decision_counts.S0.BLOCKED = 3; }, /disagrees with the decisions/);
  broken("S1 facts differ", (s) => { s.decisions.S1[0].description = "Other"; }, /facts differ/);
  broken("retry not blocked", (s) => { s.decisions.S0[2].repeat_attempt = "NOT_APPLICABLE"; }, /repeat attempt blocked/);
  broken("payable folded into the requests", (s) => { s.decisions.S0[3].in_immediate_requests = true; s.decisions.S1[3].in_immediate_requests = true; }, /immediate requests disagree/);
  const accepted = data.buildEligibilityReference(eligibility);
  const drifted = structuredClone(fixture) as any;
  drifted.capital.eligibility_demo_reference.reserve_cents = 1;
  assert.throws(() => data.checkEligibilityReference(data.buildCashCrisisView(drifted), accepted), /accepted eligibility evidence/);
  data.checkEligibilityReference(data.buildCashCrisisView(fixture), accepted);
  assert.throws(() => data.buildCashCrisisView(null), /expected object/);
  assert.throws(() => data.buildCashCrisisView([]), /expected object/);
});

test("E3-W4 the funding case comes only from the link parameter d and defaults to the delayed case", () => {
  assert.equal(data.DEFAULT_FUNDING_CASE, "delayed");
  assert.equal(data.selectFundingCase({}), "delayed");
  assert.equal(data.selectFundingCase({ s: "S1" }), "delayed");
  assert.equal(data.selectFundingCase({ d: "on_time" }), "on_time");
  assert.equal(data.selectFundingCase({ d: "delayed" }), "delayed");
  assert.equal(data.selectFundingCase({ d: ["on_time", "delayed"] }), "on_time");
  for (const bad of ["ON_TIME", "", "late", "on_time ", "0"]) assert.equal(data.selectFundingCase({ d: bad }), "delayed", bad);
  assert.equal(data.cashCrisisHref("overview", "S0", "on_time", "e3-cash-crisis"), "/overview?s=S0&d=on_time#e3-cash-crisis");
  assert.equal(data.cashCrisisHref("incident", "S1", "delayed"), "/incident?s=S1&d=delayed");
});

test("E3-W5 the committed fixture is the authoritative snapshot, byte for byte, with its 23 top-level keys", () => {
  const bytes = readFileSync(fixturePath);
  assert.equal(bytes.length, AUTHORITATIVE.fileBytes);
  assert.equal(sha256(bytes), AUTHORITATIVE.fileSha256);
  assert.deepEqual(Object.keys(fixture).sort(), [...AUTHORITATIVE.topLevelKeys]);
  assert.equal(AUTHORITATIVE.topLevelKeys.length, 23);
  assert.deepEqual(
    [fixture.evidence.length, fixture.events.length, fixture.findings.length, fixture.assumptions.length, Object.keys(fixture.rules).length],
    [8, 6, 4, 8, 8],
  );
  for (const s of SCENARIOS) assert.deepEqual(fixture.decision_counts[s], { BLOCKED: 2, EVIDENCE_ELIGIBLE: 1, TOTAL: 4, UNRESOLVED: 1 });
  assert.deepEqual(fixture.decisions.S0.map((x) => x.request_id), ["REQ-STEEL-001", "REQ-ELEC-001", "REQ-CONC-001", "REQ-ELIG-001"]);
  assert.deepEqual(fixture.decisions.S1.map((x) => x.request_id), fixture.decisions.S0.map((x) => x.request_id));
  for (const a of fixture.assumptions) assert.equal(a.label, "SYNTHETIC");
});

test("E3-W6 the snapshot's in-band content digest and its six-event chain recompute from the committed bytes", () => {
  assert.equal(sha256(canonicalCompact(without(fixture, "snapshot_content_sha256"))), fixture.snapshot_content_sha256, "content digest");
  assert.notEqual(fixture.snapshot_content_sha256, AUTHORITATIVE.fileSha256, "the content digest is not the file hash");
  let prior = "0".repeat(64);
  fixture.events.forEach((ev, i) => {
    assert.equal(ev.sequence, i + 1);
    assert.equal(ev.prev_sha256, prior, `${ev.id}: predecessor digest`);
    assert.equal(sha256(canonicalCompact(without(ev, "sha256"))), ev.sha256, `${ev.id}: digest of its content`);
    prior = ev.sha256;
  });
  assert.equal(fixture.events.length, 6);
  assert.equal(prior, AUTHORITATIVE.finalEventSha256);
});

test("E3-W7 all 26 forecast rows hold the reported figures and S0 and S1 share one calculated availability", () => {
  const expected: Record<Case, number[][]> = {
    on_time: [[105000000, 210000000, 135000000, 180000000], [180000000, 0, 100000000, 80000000], [80000000, 0, 75000000, 5000000]],
    delayed: [[105000000, 0, 135000000, -30000000], [-30000000, 0, 100000000, -130000000], [-130000000, 210000000, 75000000, 5000000]],
  };
  const shared = [
    [5000000, 120000000, 62000000, 63000000], [63000000, 0, 59000000, 4000000], [4000000, 110000000, 61000000, 53000000],
    [53000000, 0, 48000000, 5000000], [5000000, 120000000, 40000000, 85000000], [85000000, 0, 36000000, 49000000],
    [49000000, 110000000, 31000000, 128000000], [128000000, 0, 25000000, 103000000], [103000000, 100000000, 21500000, 181500000],
    [181500000, 0, 18000000, 163500000],
  ];
  let rows = 0;
  for (const d of CASES) {
    const f = fixture.forecasts[d];
    assert.deepEqual(f.rows.map((r) => [r.opening_cents, r.receipts_cents, r.outflows_cents, r.closing_cents]), [...expected[d], ...shared], d);
    assert.deepEqual(f.rows.map((r) => r.week), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.deepEqual(f.rows.filter((r) => r.quality === "INCOMPLETE_LATE_HORIZON").map((r) => r.week), [10, 11, 12, 13]);
    assert.deepEqual(f.incomplete_weeks, [10, 11, 12, 13]);
    assert.deepEqual(f.rows.filter((r) => r.owner_draw_receipt_cents !== 0).map((r) => [r.week, r.owner_draw_receipt_cents]), [[f.draw_week, 210000000]]);
    assert.equal(f.rows[0].opening_cents, 105000000);
    assert.equal(f.ending_cash_cents, 163500000);
    rows += f.rows.length;
  }
  assert.equal(rows, 26);
  const on = fixture.forecasts.on_time;
  const late = fixture.forecasts.delayed;
  assert.deepEqual([on.draw_week, on.negative_week_count, on.first_negative_week, on.minimum_closing_cents, on.worst_week, on.peak_projected_funding_gap_cents], [1, 0, null, 4000000, 5, 0]);
  assert.deepEqual([late.draw_week, late.negative_week_count, late.first_negative_week, late.minimum_closing_cents, late.worst_week, late.peak_projected_funding_gap_cents], [3, 2, 1, -130000000, 2, 130000000]);
  assert.deepEqual(late.rows.filter((r) => r.negative).map((r) => r.week), [1, 2]);
  assert.deepEqual(fixture.capital.calculated_available_by_scenario_cents, { S0: 45000000, S1: 45000000 });
  assert.deepEqual(fixture.capital.new_reservable_by_scenario_cents, { S0: 45000000, S1: 0 });
  assert.equal(fixture.capital.eligibility_demo_reference.applied_in_this_model, false);
});

// ---- E3-AT-7: rendered views ----

test("E3-AT-7.1 Overview and Incident render the E3 section once for S0 and S1 and for both funding cases", () => {
  for (const screen of ["overview", "incident"] as const) {
    for (const s of SCENARIOS) {
      for (const d of [...CASES, "default"] as const) {
        const h = page(screen, s, d);
        assert.equal(count(h, new RegExp(`<section id="${SECTION_ID[screen]}"`, "g")), 1, `${screen} ${s} ${d}`);
        const shown = d === "default" ? "delayed" : d;
        assert.ok(e3(screen, s, d).startsWith(`<section id="${SECTION_ID[screen]}" aria-labelledby="${SECTION_ID[screen]}-title" data-e3-section="${screen}" data-e3-scenario="${s}" data-e3-funding-case="${shown}"`), `${screen} ${s} ${d}: section attributes`);
      }
      assert.equal(page(screen, s, "default"), page(screen, s, "delayed"), `${screen} ${s}: no parameter shows the delayed case`);
      assert.notEqual(page(screen, s, "on_time"), page(screen, s, "delayed"), `${screen} ${s}: the cases differ`);
    }
  }
});

test("E3-AT-7.2 the Overview shows the project, gross profit and delayed draw from the snapshot", () => {
  for (const s of SCENARIOS) {
    const h = e3("overview", s);
    for (const [label, centsValue] of [["contract", fixture.project.contract_cents], ["gross profit", fixture.project.projected_gross_profit_cents], ["draw", fixture.draw.amount_cents]] as const) {
      assert.ok(h.includes(`<div class="value">${money(centsValue)}</div>`), `${s}: ${label} ${money(centsValue)}`);
      assert.ok(h.includes(formatMoneyShort(BigInt(centsValue))), `${s}: ${label} short form`);
    }
    assert.equal(money(fixture.project.contract_cents), "$24,800,000.00");
    assert.equal(money(fixture.project.projected_gross_profit_cents), "$3,200,000.00");
    assert.equal(money(fixture.draw.amount_cents), "$2,100,000.00");
    assert.ok(h.includes(`${fixture.draw.delay_days} days late`));
    assert.ok(h.includes(esc(data.isoDateLabel(fixture.draw.scheduled_date))) && h.includes(esc(data.isoDateLabel(fixture.draw.delayed_date))));
    assert.ok(h.includes(fixture.project.project_id));
  }
});

test("E3-AT-7.3 the 13-week table has 13 rows whose cells equal the snapshot, in both cases and both scenarios", () => {
  for (const s of SCENARIOS) {
    for (const d of CASES) {
      const h = e3("overview", s, d);
      const table = h.match(new RegExp(`<table data-e3-forecast-table="${d}">([\\s\\S]*?)</table>`));
      assert.ok(table, `${s} ${d}: forecast table`);
      assert.equal(count(h, /<table data-e3-forecast-table=/g), 1);
      const rows = [...table![1].matchAll(/<tr data-e3-week="(\d+)" data-quality="([A-Z_]+)">([\s\S]*?)<\/tr>/g)];
      assert.equal(rows.length, 13, `${s} ${d}: 13 rows`);
      rows.forEach((row, i) => {
        const raw = fixture.forecasts[d].rows[i];
        assert.equal(Number(row[1]), raw.week);
        assert.equal(row[2], raw.quality);
        assert.ok(row[3].includes(`<th scope="row" style="white-space:nowrap">Week ${raw.week}</th>`));
        assert.ok(row[3].includes(`${raw.start} to ${raw.end}`));
        const cells = [...row[3].matchAll(/<td style="[^"]*" data-cents="(-?\d+)" data-col="([a-z]+)">([^<]*)<\/td>/g)].map((c) => [c[2], c[1], c[3]]);
        assert.deepEqual(cells, [
          ["opening", String(raw.opening_cents), money(raw.opening_cents)],
          ["receipts", String(raw.receipts_cents), money(raw.receipts_cents)],
          ["outflow", String(raw.outflows_cents), money(raw.outflows_cents)],
          ["closing", String(raw.closing_cents), money(raw.closing_cents)],
        ], `${s} ${d} week ${raw.week}`);
      });
    }
  }
});

test("E3-AT-7.4 the chart and the table show the same 13 rows", () => {
  for (const d of CASES) {
    const h = e3("overview", "S0", d);
    const bars = [...h.matchAll(/<g data-e3-bar="(\d+)" data-closing-cents="(-?\d+)" data-quality="([A-Z_]+)">/g)].map((b) => [Number(b[1]), b[2], b[3]]);
    const cells = [...h.matchAll(/<tr data-e3-week="(\d+)" data-quality="([A-Z_]+)">[\s\S]*?data-cents="(-?\d+)" data-col="closing"/g)].map((c) => [Number(c[1]), c[3], c[2]]);
    assert.equal(bars.length, 13);
    assert.deepEqual(bars, cells, `${d}: chart bars equal table rows`);
    assert.deepEqual(bars, fixture.forecasts[d].rows.map((r) => [r.week, String(r.closing_cents), r.quality]), `${d}: chart bars equal the snapshot`);
    for (const r of fixture.forecasts[d].rows) assert.ok(h.includes(`<title>Week ${r.week}: closing ${money(r.closing_cents)} (`), `${d}: bar title week ${r.week}`);
    assert.equal(count(h, /<svg /g), 1);
    assert.match(h, /<svg [^>]*role="img" aria-label="E3 synthetic 13-week projection, [^"]+"/);
  }
});

test("E3-AT-7.5 on-time versus delayed outcome and the week of the peak funding gap equal the snapshot", () => {
  const drawWeek = (d: Case) => {
    const date = d === "on_time" ? fixture.draw.scheduled_date : fixture.draw.delayed_date;
    const week = fixture.forecasts[d].rows.find((r) => r.start <= date && date <= r.end)!.week;
    assert.equal(week, fixture.forecasts[d].draw_week);
    assert.equal(week, d === "on_time" ? fixture.draw.on_time_week : fixture.draw.delayed_week);
    return week;
  };
  for (const s of SCENARIOS) {
    for (const shown of CASES) {
      const h = e3("overview", s, shown);
      const cell = (d: Case, k: string) => {
        const found = h.match(new RegExp(`<td style="[^"]*" data-e3-outcome="${d}:${k}"(?: data-cents="(-?\\d+)")?>([^<]*)</td>`));
        assert.ok(found, `${s} ${shown}: outcome ${d}:${k}`);
        return { cents: found![1], text: found![2] };
      };
      for (const d of CASES) {
        const f = fixture.forecasts[d];
        assert.deepEqual(cell(d, "minimum-closing"), { cents: String(f.minimum_closing_cents), text: money(f.minimum_closing_cents) });
        assert.deepEqual(cell(d, "peak-gap"), { cents: String(f.peak_projected_funding_gap_cents), text: money(f.peak_projected_funding_gap_cents) });
        assert.deepEqual(cell(d, "ending-cash"), { cents: String(f.ending_cash_cents), text: money(f.ending_cash_cents) });
        assert.equal(cell(d, "negative-weeks").text, String(f.negative_week_count));
        assert.equal(cell(d, "peak-week").text, f.peak_projected_funding_gap_cents > 0 ? `Week ${f.worst_week}` : "None (no negative week)");
        assert.ok(cell(d, "draw-week").text.startsWith(`Week ${drawWeek(d)} (`));
      }
      const gap = fixture.forecasts.delayed;
      assert.ok(h.includes(`Peak projected funding gap: ${money(gap.peak_projected_funding_gap_cents)} in week ${gap.worst_week}, delayed case.`));
    }
  }
  assert.equal(money(fixture.forecasts.delayed.peak_projected_funding_gap_cents), "$1,300,000.00");
  assert.equal(drawWeek("on_time"), 1);
  assert.equal(drawWeek("delayed"), 3);
});

test("E3-AT-7.6 capital reconciliation, the single hold, the availability and the S0/S1 authority equal the snapshot", () => {
  const c = fixture.capital;
  for (const s of SCENARIOS) {
    const other = s === "S0" ? "S1" : "S0";
    const h = e3("overview", s);
    const immediate = fixture.decisions[s].filter((x) => x.in_immediate_requests);
    assert.ok(h.includes(`${immediate.map((x) => money(x.amount_cents)).join(" + ")} = ${money(c.immediate_requests_cents)}`), `${s}: requests`);
    assert.ok(h.includes(`${money(c.immediate_requests_cents)} − ${money(c.allocation_cents)} = ${money(c.nominal_gap_cents)}`), `${s}: nominal gap`);
    assert.ok(h.includes(`${money(c.allocation_cents)} − ${money(c.concrete_hold_cents)} = ${money(c.available_after_hold_cents)}`), `${s}: after hold`);
    assert.equal(count(h, /data-e3-eq="after-hold"/g), 1, "the hold is applied in one place");
    assert.ok(h.includes(`<dd data-e3-available="">${money(c.available_after_hold_cents)}</dd>`));
    assert.ok(h.includes(`<dd data-e3-new-reservable="${s}">${money(c.new_reservable_by_scenario_cents[s])}</dd>`));
    assert.ok(h.includes(`<dd data-e3-new-reservable="${other}">${money(c.new_reservable_by_scenario_cents[other])}</dd>`));
    assert.ok(h.includes(`A separate ${money(c.separate_payable_cents)} payable`) && h.includes(`is outside the ${money(c.immediate_requests_cents)}`));
  }
  assert.deepEqual([c.immediate_requests_cents, c.allocation_cents, c.nominal_gap_cents, c.concrete_hold_cents, c.available_after_hold_cents].map(money), ["$915,000.00", "$760,000.00", "$155,000.00", "$310,000.00", "$450,000.00"]);
  assert.deepEqual([c.new_reservable_by_scenario_cents.S0, c.new_reservable_by_scenario_cents.S1].map(money), ["$450,000.00", "$0.00"]);
});

test("E3-AT-7.7 the Incident shows the four decisions of the selected scenario exactly as the snapshot records them", () => {
  for (const s of SCENARIOS) {
    for (const d of CASES) {
      const h = e3("incident", s, d);
      // One rendered decision runs from its opening tag to the next decision or to the end of the decisions card.
      const opens = [...h.matchAll(/<li id="e3-decision-([A-Z0-9-]+)" data-e3-decision="([A-Z0-9-]+)" data-e3-request="[A-Z0-9-]+" data-e3-status="([A-Z_]+)" data-e3-release="([A-Z_]+)" data-e3-amount-cents="(\d+)" data-e3-in-immediate="(true|false)">/g)];
      const cardEnd = h.indexOf("</section>", h.indexOf(`data-e3-decisions="${s}"`));
      const rendered = opens.map((o, i) => [...o, h.slice(o.index + o[0].length, i + 1 < opens.length ? opens[i + 1].index : cardEnd)]);
      assert.equal(rendered.length, 4, `${s} ${d}: four decisions`);
      const byId = new Map(rendered.map((r) => [r[2], r]));
      assert.equal(byId.size, 4);
      for (const raw of fixture.decisions[s]) {
        const r = byId.get(raw.decision_id);
        assert.ok(r, `${s}: ${raw.decision_id} rendered`);
        assert.equal(r![1], raw.decision_id);
        assert.ok(r![0].includes(`data-e3-request="${raw.request_id}"`));
        assert.deepEqual([r![3], r![4], r![5], r![6]], [raw.status, raw.release_status, String(raw.amount_cents), String(raw.in_immediate_requests)]);
        const body = r![7];
        assert.ok(body.includes(`requested ${money(raw.amount_cents)}`));
        assert.ok(body.includes(esc(raw.description)) && body.includes(esc(raw.party)));
        assert.deepEqual([...body.matchAll(/<li data-e3-rule="([A-Z0-9-]+)"[^>]*><span class="mono">([A-Z0-9-]+)<\/span>: ([^<]*)<\/li>/g)].map((x) => [x[1], x[2], x[3]]), raw.rule_ids.map((rule, i) => [rule, rule, esc(raw.rationale[i])]), `${s} ${raw.decision_id}: rules`);
        for (const [i, rule] of raw.rule_ids.entries()) assert.equal(raw.rationale[i], fixture.rules[rule], `${rule}: rationale is the rule text`);
        assert.deepEqual([...body.matchAll(/data-e3-evidence-link="([A-Z0-9-]+)"/g)].map((x) => x[1]), raw.evidence_ids, `${s} ${raw.decision_id}: evidence links`);
        assert.ok(body.includes(`<span class="mono">${raw.request_id}</span>`) && body.includes(`<span class="mono">${raw.obligation_id}</span>`), `${raw.decision_id}: request and obligation identifiers`);
        assert.ok(body.includes(`data-e3-repeat-attempt="${raw.repeat_attempt}"`), `${raw.decision_id}: repeat attempt`);
        assert.ok(body.includes(`<dd style="text-align:left" data-e3-eligibility=""><strong>${raw.status}</strong>`));
        assert.ok(body.includes(`<dd style="text-align:left" data-e3-authorization=""><strong>NOT_AUTHORIZED</strong>`));
        assert.ok(body.includes(raw.new_reservation_permitted ? "May be reviewed. A reservation is not a payment." : "Not permitted."));
      }
      const group = (name: string) => h.match(new RegExp(`<ul class="clean" data-e3-decision-group="${name}">([\\s\\S]*?)</ul>(?=<h4|</section>)`))![1];
      assert.deepEqual([...group("immediate").matchAll(/ data-e3-decision="([A-Z0-9-]+)"/g)].map((x) => x[1]), fixture.decisions[s].filter((x) => x.in_immediate_requests).map((x) => x.decision_id));
      assert.deepEqual([...group("separate").matchAll(/ data-e3-decision="([A-Z0-9-]+)"/g)].map((x) => x[1]), fixture.decisions[s].filter((x) => !x.in_immediate_requests).map((x) => x.decision_id));
      assert.equal(count(h, new RegExp(`E3-DEC-${s === "S0" ? "S1" : "S0"}-`, "g")), 0, `${s}: the other scenario's decisions are not shown`);
    }
  }
  const statuses = (s: Scenario) => fixture.decisions[s].map((x) => [money(x.amount_cents), x.status, x.release_status]);
  assert.deepEqual(statuses("S0"), [["$420,000.00", "BLOCKED", "NOT_AUTHORIZED"], ["$185,000.00", "BLOCKED", "NOT_AUTHORIZED"], ["$310,000.00", "UNRESOLVED", "NOT_AUTHORIZED"], ["$90,000.00", "EVIDENCE_ELIGIBLE", "NOT_AUTHORIZED"]]);
  assert.deepEqual(statuses("S1"), statuses("S0"));
  assert.deepEqual(fixture.decisions.S0.map((x) => x.repeat_attempt), ["NOT_APPLICABLE", "NOT_APPLICABLE", "BLOCKED", "NOT_APPLICABLE"]);
  assert.equal(fixture.decisions.S1[3].rule_ids.includes("E3-RULE-107"), true);
  assert.equal(fixture.decisions.S0[3].rule_ids.includes("E3-RULE-107"), false);
  assert.equal(fixture.decisions.S0[3].new_reservation_permitted, true);
  assert.equal(fixture.decisions.S1[3].new_reservation_permitted, false);
});

test("E3-AT-7.8 the Incident shows the obligations, the allocation, the hold and the availability from the snapshot", () => {
  const c = fixture.capital;
  for (const s of SCENARIOS) {
    const h = e3("incident", s);
    assert.deepEqual(
      [...h.matchAll(/<dd data-e3-obligation="([A-Z0-9-]+)" data-cents="(\d+)">([^<]*)<\/dd>/g)].map((x) => [x[1], x[2], x[3]]),
      fixture.decisions[s].filter((x) => x.in_immediate_requests).map((x) => [x.decision_id, String(x.amount_cents), money(x.amount_cents)]),
    );
    assert.ok(h.includes(`<dd data-e3-total="immediate-requests"><strong>${money(c.immediate_requests_cents)}</strong></dd>`));
    assert.ok(h.includes(`<dd data-e3-total="allocation">${money(c.allocation_cents)}</dd>`));
    assert.ok(h.includes(`<dd data-e3-total="hold">${money(c.concrete_hold_cents)}</dd>`));
    assert.ok(h.includes(`<dd data-e3-total="after-hold"><strong>${money(c.available_after_hold_cents)}</strong></dd>`));
    assert.ok(h.includes(`<dd data-e3-total="new-reservable">${money(c.new_reservable_by_scenario_cents[s])}</dd>`));
    assert.ok(h.includes("applied once"));
  }
  assert.deepEqual(fixture.decisions.S0.filter((x) => x.in_immediate_requests).map((x) => money(x.amount_cents)), ["$420,000.00", "$185,000.00", "$310,000.00"]);
});

test("E3-AT-7.9 the funding case changes the forecast only: obligations, decisions, evidence and events are identical in both cases", () => {
  for (const s of SCENARIOS) {
    const tail = (d: Case) => {
      const h = e3("incident", s, d);
      return h.slice(h.indexOf('data-e3-disclosure="separation"'));
    };
    assert.equal(tail("on_time"), tail("delayed"), `${s}: workflow does not depend on the funding case`);
    for (const d of CASES) {
      const f = fixture.forecasts[d];
      const context = e3("incident", s, d).match(/<section class="card" aria-labelledby="e3-incident-funding-title" data-e3-funding-context="([a-z_]+)">([\s\S]*?)<\/section>/);
      assert.ok(context);
      assert.equal(context![1], d);
      if (f.peak_projected_funding_gap_cents > 0) assert.ok(context![2].includes(`Peak projected funding gap ${money(f.peak_projected_funding_gap_cents)} in week ${f.worst_week}`));
      else assert.ok(context![2].includes(`the lowest weekly closing is ${money(f.minimum_closing_cents)}`));
    }
  }
});

// ---- E3-AT-8: disclosure ----

test("E3-AT-8.1 the funding gap is always called a projection of a synthetic unfinanced path", () => {
  for (const s of SCENARIOS) {
    const gap = e3("overview", s).match(/<p data-e3-gap-statement=""[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(gap);
    assert.ok(gap![1].includes("projected funding requirement of a synthetic, unfinanced path"));
    assert.ok(gap![1].includes("not an observed balance") && gap![1].includes("not a verified contractual fact"));
    for (const screen of ["overview", "incident"] as const) {
      for (const d of CASES) {
        const h = e3(screen, s, d);
        // The words may appear only where the sentence denies them ("not an observed overdraft", "no live bank balance").
        for (const found of h.matchAll(/overdraft|\bloss(es)?\b|bank(ing)? balance|contractual fact/gi)) {
          const lead = h.slice(Math.max(0, found.index - 90), found.index);
          assert.match(lead, /\b(not|no|never|nothing|neither)\b/i, `${screen} ${s} ${d}: "${found[0]}" appears only in a denial: …${lead}`);
        }
      }
    }
  }
});

test("E3-AT-8.2 weeks 10 to 13 are visibly and textually marked incomplete", () => {
  for (const d of CASES) {
    const h = e3("overview", "S0", d);
    const late = fixture.forecasts[d].rows.filter((r) => r.quality === "INCOMPLETE_LATE_HORIZON").map((r) => r.week);
    assert.deepEqual(late, [10, 11, 12, 13]);
    for (const r of fixture.forecasts[d].rows) {
      const row = h.match(new RegExp(`<tr data-e3-week="${r.week}" data-quality="[A-Z_]+">([\\s\\S]*?)</tr>`))![1];
      const marked = row.includes('<span class="pill warn">INCOMPLETE</span>') && row.includes("INCOMPLETE_LATE_HORIZON") && row.includes("not a verified projection");
      assert.equal(marked, late.includes(r.week), `${d} week ${r.week}`);
      const bar = h.match(new RegExp(`<g data-e3-bar="${r.week}"[^>]*>([\\s\\S]*?)</g>`))![1];
      assert.equal(bar.includes('fill="url(#e3-hatch)"'), late.includes(r.week), `${d} week ${r.week}: hatched bar`);
      assert.equal(bar.includes(`>${r.week}*</text>`), late.includes(r.week), `${d} week ${r.week}: starred label`);
    }
    assert.ok(h.includes("Weeks 10 to 13 carry the quality"));
    assert.ok(h.includes("weeks 10 to 13 incomplete"));
    for (const text of fixture.forecasts[d].limitations) assert.ok(h.includes(esc(text)), `${d}: limitation shown: ${text}`);
  }
});

test("E3-AT-8.3 the calendar disclosure states that E3 weeks and E2 days are distinct and not comparable", () => {
  for (const s of SCENARIOS) {
    const h = e3("overview", s).match(/<section class="card alert-warn" aria-labelledby="e3-calendar-title" data-e3-disclosure="calendar">([\s\S]*?)<\/section>/);
    assert.ok(h, `${s}: calendar disclosure`);
    const text = h![1];
    assert.ok(text.includes("week numbers are not comparable"));
    assert.ok(text.includes("<strong>week 1</strong> on time") && text.includes("<strong>week 3</strong> when delayed"));
    assert.ok(text.includes("<strong>day 18</strong>") && text.includes("<strong>day 30</strong>"));
    assert.ok(text.includes("distinct synthetic calendars"));
    assert.ok(text.includes("neither is adjusted to match the other"));
    const incident = e3("incident", s);
    assert.ok(incident.includes("not comparable with the day 18 and day 30 convention of the E2 forecast"));
  }
});

test("E3-AT-8.4 the capital disclosure keeps E3's and E2's figures side by side and reconciles neither", () => {
  assert.equal(sha256(readFileSync(eligibilityPath)), ACCEPTED_SHA256.eligibilityEvidence, "the accepted eligibility evidence is unchanged");
  const e2 = eligibility.project.availability_initial;
  for (const s of SCENARIOS) {
    const h = e3("overview", s).match(/<section class="card alert-warn" aria-labelledby="e3-capital-disclosure-title" data-e3-disclosure="capital">([\s\S]*?)<\/section>/);
    assert.ok(h, `${s}: capital disclosure`);
    assert.ok(h![1].includes(`<dd data-e3-capital-figure="e3">${money(fixture.capital.available_after_hold_cents)}</dd>`));
    assert.ok(h![1].includes(`<dd data-e3-capital-figure="e2">${money(e2.available_to_commit)}</dd>`));
    assert.ok(h![1].includes(`less an additional ${money(e2.restricted_reserves)} reserve`));
    assert.ok(h![1].includes("is not applied in E3"));
    assert.ok(h![1].includes(esc(fixture.capital.eligibility_demo_reference.note)), "the snapshot's own note on the reserve is shown");
    assert.equal(fixture.capital.eligibility_demo_reference.reserve_cents, e2.restricted_reserves, "snapshot and accepted evidence agree on the reserve");
    assert.equal(fixture.capital.eligibility_demo_reference.initial_availability_cents, e2.available_to_commit, "and on the initial availability");
    assert.ok(h![1].includes("neither is changed to agree with the other"));
    const incident = e3("incident", s).match(/<p class="muted"[^>]*data-e3-disclosure="capital">([\s\S]*?)<\/p>/);
    assert.ok(incident && incident[1].includes(money(fixture.capital.available_after_hold_cents)) && incident[1].includes(money(e2.available_to_commit)) && incident[1].includes(money(e2.restricted_reserves)));
    const terms = e3("overview", s).match(/data-e3-disclosure="terms">([\s\S]*?)<\/section>/)![1];
    assert.ok(terms.includes(`<dd>${money(fixture.forecast_inputs.opening_operating_cash_cents)}</dd>`) && terms.includes("Actual payment authority</dt><dd>None</dd>"));
    assert.ok(terms.includes("not the allocation, not a wallet and not a bank balance"));
  }
  assert.deepEqual([fixture.capital.available_after_hold_cents, e2.available_to_commit, e2.restricted_reserves, fixture.capital.eligibility_demo_reference.reserve_cents].map(money), ["$450,000.00", "$300,000.00", "$150,000.00", "$150,000.00"]);
});

test("E3-AT-8.5 synthetic and non-operational status and the evidence provenance are shown on both screens", () => {
  for (const screen of ["overview", "incident"] as const) {
    for (const s of SCENARIOS) {
      const h = e3(screen, s);
      assert.ok(h.includes('<span class="pill synthetic">SYNTHETIC</span>') && h.includes('<span class="pill synthetic">NON-OPERATIONAL</span>'), `${screen} ${s}: pills`);
      assert.ok(h.includes(esc(fixture.classification)), `${screen} ${s}: classification`);
    }
  }
  const h = e3("overview", "S0");
  assert.ok(h.includes(`data-e3-fixture-sha256="">${fixture.fixture.sha256}</dd>`));
  assert.ok(h.includes(`data-e3-snapshot-sha256="">${fixture.snapshot_content_sha256}</dd>`));
  assert.ok(h.includes(fixture.fixture.fixture_id) && h.includes(fixture.schema) && h.includes(fixture.fixture.path) && h.includes(fixture.task));
  assert.ok(h.includes(esc(fixture.project.label)));
  assert.ok(h.includes(fixture.forecasts.delayed.funding_gap_basis));
  const assumptions = [...h.matchAll(/<li data-e3-assumption="([A-Z0-9-]+)"><span class="mono">[A-Z0-9-]+<\/span> <span class="pill synthetic">SYNTHETIC<\/span> <span[^>]*>([^<]*)<\/span><\/li>/g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(assumptions, fixture.assumptions.map((a) => [a.id, esc(a.text)]), "all eight assumptions, each labelled SYNTHETIC");
  assert.equal(assumptions.length, 8);
  assert.ok(h.includes("apps/web/fixtures/cash_crisis_evidence_v1.json"));
  for (const text of fixture.limitations) assert.ok(h.includes(esc(text)), `limitation shown: ${text}`);
  const incident = e3("incident", "S0");
  assert.ok(incident.includes('<dd data-e3-control="provider-writes">0</dd>') && incident.includes('<dd data-e3-control="database-writes">0</dd>'));
  assert.ok(incident.includes('<dd data-e3-control="payment-authority">None</dd>') && incident.includes('<dd data-e3-control="release-interface">None</dd>'));
  for (const s of SCENARIOS) assert.ok(e3("incident", s).includes(`<span data-e3-scenario-note="${s}">${s}: ${esc(fixture.scenarios.find((x) => x.id === s)!.note)}</span>`), `${s}: scenario note`);
  for (const text of fixture.capital.notes) assert.ok(incident.includes(esc(text)), `capital note shown: ${text}`);
});

test("E3-AT-8.6 financial eligibility and payment authorization are stated separately, with duplicate transfer protection", () => {
  for (const s of SCENARIOS) {
    const h = e3("incident", s);
    const sep = h.match(/data-e3-disclosure="separation">([\s\S]*?)<\/section>/);
    assert.ok(sep);
    assert.ok(sep![1].includes("Financial eligibility is not payment authorization"));
    assert.ok(sep![1].includes("An eligible request is not an approved payment."));
    assert.equal(count(h, /data-e3-eligibility=""/g), 4);
    assert.equal(count(h, /data-e3-authorization=""/g), 4);
    const unresolved = fixture.decisions[s].filter((x) => x.repeat_attempt === "BLOCKED");
    assert.equal(unresolved.length, 1);
    assert.deepEqual([unresolved[0].request_id, unresolved[0].status], ["REQ-CONC-001", "UNRESOLVED"]);
    const dup = h.match(/data-e3-duplicate-protection="">([\s\S]*?)<\/section>/);
    assert.ok(dup);
    assert.ok(dup![1].includes(`data-e3-duplicate-for="${unresolved[0].decision_id}"`));
    assert.ok(dup![1].includes("a second transfer attempt is blocked") && dup![1].includes("once, not twice"));
    assert.ok(dup![1].includes("repeat attempt: <strong>BLOCKED</strong>"));
    unresolved[0].rule_ids.forEach((rule, i) => assert.ok(dup![1].includes(`<span class="mono">${rule}</span>: ${esc(unresolved[0].rationale[i])}`), `duplicate protection cites ${rule}`));
    assert.deepEqual([...dup![1].matchAll(/data-e3-evidence-link="([A-Z0-9-]+)" data-e3-link-from="duplicate:/g)].map((x) => x[1]), unresolved[0].evidence_ids);
    assert.equal(fixture.capital.hold_application_count, 1);
    assert.deepEqual(
      [...dup![1].matchAll(/<li data-e3-hold-application="([A-Z0-9-]+)" data-cents="(\d+)">/g)].map((x) => [x[1], x[2]]),
      fixture.capital.hold_applications.map((x) => [x.request_id, String(x.amount_cents)]),
      "the hold is listed once",
    );
  }
});

// ---- E3-AT-9: anchors and access ----

test("E3-AT-9.1 every evidence link resolves to exactly one target on the page and no evidence is invented", () => {
  for (const s of SCENARIOS) {
    for (const d of CASES) {
      const h = page("incident", s, d);
      const ids = [...h.matchAll(/\sid="([^"]*)"/g)].map((x) => x[1]);
      const links = [...h.matchAll(/<a href="#(e3-evidence-[^"]+)" class="mono" data-e3-evidence-link="([^"]+)" data-e3-link-from="([^"]+)">([^<]*)<\/a>/g)];
      assert.ok(links.length > 0);
      for (const [, target, id, , text] of links) {
        assert.equal(target, data.evidenceAnchor(id));
        assert.equal(text, id);
        assert.equal(ids.filter((x) => x === target).length, 1, `${target} exists exactly once`);
      }
      assert.equal(count(h, /data-e3-evidence-link="/g), links.length, "every evidence link is a real fragment link");
      const targets = [...h.matchAll(/<li id="e3-evidence-([A-Z0-9-]+)" data-e3-evidence="([A-Z0-9-]+)" tabindex="-1">([\s\S]*?)<\/li>/g)];
      assert.deepEqual(targets.map((t) => [t[1], t[2]]), fixture.evidence.map((ev) => [ev.id, ev.id]), "evidence records equal the snapshot, in order");
      targets.forEach((t, i) => {
        const ev = fixture.evidence[i];
        for (const text of [ev.title, ev.kind, ev.status, ev.detail]) assert.ok(t[3].includes(esc(text)), `${ev.id}: ${text}`);
      });
      const cited = new Set([...fixture.decisions[s].flatMap((x) => x.evidence_ids), ...fixture.events.flatMap((x) => x.evidence_ids), ...fixture.findings.flatMap((x) => x.evidence_ids), ...fixture.capital.hold_applications.flatMap((x) => x.evidence_ids), fixture.draw.evidence_id]);
      assert.equal(targets.length, 8);
      assert.deepEqual([...new Set(links.map((l) => l[2]))].sort(), [...cited].sort(), "linked evidence equals cited evidence");
      const fragments = [...h.matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
      for (const f of fragments) assert.ok(ids.includes(f), `dangling fragment #${f}`);
    }
  }
});

test("E3-AT-9.2 the event chain is shown in order with each event's digest and its predecessor's", () => {
  const h = e3("incident", "S0");
  const events = [...h.matchAll(/<li id="e3-event-([A-Z0-9-]+)" data-e3-event="([A-Z0-9-]+)" data-e3-sequence="(\d+)">([\s\S]*?)<\/li>/g)];
  assert.deepEqual(events.map((x) => [x[1], x[2], Number(x[3])]), fixture.events.map((ev) => [ev.id, ev.id, ev.sequence]));
  events.forEach((x, i) => {
    const ev = fixture.events[i];
    assert.ok(x[4].includes(`data-e3-event-sha256="">sha256 ${ev.sha256}</div>`));
    assert.ok(x[4].includes(`data-e3-event-prev="">previous ${ev.prev_sha256}</div>`));
    assert.equal(ev.prev_sha256, i === 0 ? "0".repeat(64) : fixture.events[i - 1].sha256);
    assert.ok(x[4].includes(esc(ev.title)) && plain(x[4]).includes(esc(ev.finding)) && x[4].includes(ev.when));
    assert.deepEqual([...x[4].matchAll(/data-e3-evidence-link="([A-Z0-9-]+)"/g)].map((m) => m[1]), ev.evidence_ids);
  });
  assert.ok(h.includes("they are not signatures and attest to no external fact"));
  const findings = [...h.matchAll(/<li data-e3-finding="([^"]+)">([\s\S]*?)<\/li>/g)];
  assert.deepEqual(findings.map((x) => x[1]), fixture.findings.map((f) => esc(f.role)));
  findings.forEach((x, i) => assert.ok(plain(x[2]).includes(esc(fixture.findings[i].finding)) && x[2].includes(esc(fixture.findings[i].boundary))));
  assert.deepEqual(
    [...h.matchAll(/<li data-e3-rule-entry="([A-Z0-9-]+)"[^>]*><span class="mono">[A-Z0-9-]+<\/span>: ([^<]*)<\/li>/g)].map((x) => [x[1], x[2]]),
    Object.entries(fixture.rules).map(([id, text]) => [id, esc(text)]),
    "the rule reference lists the snapshot's eight rules",
  );
});

test("E3-AT-9.3 element ids are unique on every rendered page and every aria-labelledby names an existing heading", () => {
  for (const screen of ["overview", "incident"] as const) {
    for (const s of SCENARIOS) {
      for (const d of CASES) {
        const h = page(screen, s, d);
        const ids = [...h.matchAll(/\sid="([^"]*)"/g)].map((x) => x[1]);
        assert.equal(new Set(ids).size, ids.length, `${screen} ${s} ${d}: duplicate ids ${ids.filter((x, i) => ids.indexOf(x) !== i).join(", ")}`);
        for (const id of ids) assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, `${id} is a valid fragment id`);
        for (const [, ref] of h.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(new RegExp(`<h[2-4] id="${ref}"`).test(h), `${screen}: aria-labelledby ${ref}`);
      }
    }
  }
});

test("E3-AT-9.4 tables have a caption and header cells; the case links are plain links in document order", () => {
  for (const s of SCENARIOS) {
    for (const d of CASES) {
      const h = e3("overview", s, d);
      const tables = [...h.matchAll(/<table [^>]*>([\s\S]*?)<\/table>/g)];
      assert.equal(tables.length, 2, "outcome table and forecast table");
      for (const t of tables) {
        assert.ok(t[1].startsWith("<caption"), "caption first");
        assert.ok(count(t[1], /<th scope="col"/g) >= 3 && count(t[1], /<th scope="row"/g) >= 6);
      }
      assert.equal(count(h, /<div class="table-scroll"[^>]*tabindex="0" role="region" aria-label="[^"]+"/g), 2, "wide tables scroll inside their own focusable region");
      for (const screen of ["overview", "incident"] as const) {
        const section = e3(screen, s, d);
        const group = section.match(new RegExp(`<div role="group" aria-label="E3 owner-draw funding case" data-e3-case-links="${screen}"[^>]*>([\\s\\S]*?)</div>`));
        assert.ok(group, `${screen}: case links`);
        const links = [...group![1].matchAll(/<a href="([^"]+)"( aria-current="true")? data-e3-case="([a-z_]+)"[^>]*>([^<]*)<\/a>/g)].map((x) => [x[1], x[2] !== undefined, x[3], x[4]]);
        assert.deepEqual(links, CASES.map((c) => [`/${screen}?s=${s}&amp;d=${c}#${SECTION_ID[screen]}`, c === d, c, `${data.FUNDING_CASE_LABEL[c]}${c === d ? " (shown)" : ""}`]), `${screen} ${s} ${d}`);
        assert.doesNotMatch(section, /tabindex="[1-9]/, "no positive tabindex: keyboard order is document order");
      }
    }
  }
});

test("E3-AT-9.5 the E3 sections use only the accepted stylesheet's classes and cannot widen the page at 375 px", () => {
  const css = readFileSync(join(webRoot, "src/app/globals.css"), "utf8");
  // SUPERSEDED (UI redesign): the historical invariant "globals.css is the accepted E3 file" cannot hold for a redesign.
  // Replaced by the explicit candidate pin; the original accepted hash stays in ACCEPTED_SHA256 and in Git history.
  assert.equal(sha256(css), UI_BASELINE.candidate["src/app/globals.css"], "globals.css is the pinned UI candidate");
  for (const screen of ["overview", "incident"] as const) {
    const h = e3(screen, "S0");
    const classes = new Set([...h.matchAll(/class="([^"]+)"/g)].flatMap((x) => x[1].split(/\s+/)).filter(Boolean));
    classes.delete("plain"); // the accepted Figure component's default tone, which the stylesheet leaves unstyled
    for (const c of classes) assert.ok(new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(css), `${screen}: class ${c} exists in globals.css`);
    for (const t of h.matchAll(/<table /g)) assert.equal(h.lastIndexOf('<div class="table-scroll"', t.index) > h.lastIndexOf("</div>", t.index), true, `${screen}: table sits directly in a scroll container`);
    assert.doesNotMatch(h, /style="[^"]*(?:min-width|[^-]width):\s*[0-9]{3,}px/, `${screen}: no fixed pixel width`);
    assert.doesNotMatch(h, /white-space:nowrap[^"]*"[^>]*>[^<]{40,}</, `${screen}: no long unbreakable text`);
    for (const svg of h.matchAll(/<svg [^>]*>/g)) assert.ok(svg[0].includes('width="100%"') && svg[0].includes("viewBox="), `${screen}: chart scales with its container`);
    for (const hash of h.matchAll(/<(dd|div) class="mono[^"]*" style="([^"]*)"[^>]*>(?:sha256 |previous )?[0-9a-f]{64}</g)) assert.ok(hash[2].includes("overflow-wrap:anywhere"), `${screen}: digests wrap`);
  }
});

test("E3-AT-9.6 a negative amount never wraps apart from its minus sign", () => {
  let seen = 0;
  for (const screen of ["overview", "incident"] as const) {
    for (const s of SCENARIOS) {
      for (const d of CASES) {
        // Visible text only: titles and attribute values are not laid out in lines.
        const visible = e3(screen, s, d).replace(/<title>[^<]*<\/title>/g, "").replace(/="[^"]*"/g, (attr) => (attr.includes("white-space:nowrap") ? '="nowrap"' : '=""'));
        for (const found of visible.matchAll(/[−-]\$[0-9][0-9,]*\.[0-9]{2}/g)) {
          const open = visible.lastIndexOf("<", found.index);
          const tag = visible.slice(open, found.index);
          assert.match(tag, /^<(td|span) [^>]*="nowrap"[^>]*>$/, `${screen} ${s} ${d}: ${found[0]} sits alone at the start of a no-wrap element: ${tag}`);
          seen += 1;
        }
      }
    }
  }
  assert.ok(seen > 0, "the delayed case and the event chain show negative amounts");
  const outcome = e3("overview", "S0", "delayed").match(/<td style="([^"]*)" data-e3-outcome="delayed:minimum-closing" data-cents="-130000000">−\$1,300,000\.00<\/td>/);
  assert.ok(outcome && outcome[1].includes("white-space:nowrap"), "the delayed minimum closing is kept on one line");
});

// ---- E3-AT-10: existing screens intact ----

test("E3-AT-10.1 (superseded invariant, re-based) the E3 component is still the last section of its page, rendered once with its own props; E3 sources are untouched", () => {
  // SUPERSEDED (UI redesign): the original test required each page to be the accepted pre-E3 page plus three added lines
  // (page hashes in ACCEPTED_SHA256). A redesign cannot satisfy that. Re-based here: the E3 component stays wired exactly once,
  // the UI candidate files match their explicit pins, and every E3 source, finance module and fixture is byte-identical to the
  // accepted commit (pins in tests/ui-baseline.json; reproduced from Git by tests/ui_baseline.test.ts).
  const wiring: Record<"overview" | "incident", string> = {
    overview: "<CashCrisisForecast scenario={id} fundingCase={fundingCase} />",
    incident: "<CashCrisisIncident scenario={id} fundingCase={fundingCase} />",
  };
  for (const screen of ["overview", "incident"] as const) {
    const source = readFileSync(join(webRoot, `src/app/${screen}/page.tsx`), "utf8");
    assert.equal(source.split(wiring[screen]).length, 2, `${screen}: the E3 component is wired exactly once`);
  }
  for (const [rel, hash] of Object.entries(UI_BASELINE.candidate)) assert.equal(sha256(readFileSync(join(webRoot, rel))), hash, `${rel} is the pinned UI candidate`);
  for (const [rel, hash] of Object.entries(UI_BASELINE.preserved)) assert.equal(sha256(readFileSync(join(webRoot, rel))), hash, `${rel} is preserved from the accepted E3 commit`);
});

test("E3-AT-10.2 (superseded invariant, re-based) the rest of each page renders identically with or without the E3 section", async () => {
  // SUPERSEDED (UI redesign): the original appended the E3 section before the footer. In the redesign it is the last child of the
  // "Full evidence" expander, and the Command screen's own panels follow the funding-case link, so the stand-in page is rendered with the
  // same case. The invariant that matters is unchanged: the E3 section is the only difference between the two renders.
  const insertBefore: Record<"overview" | "incident", string> = { overview: "</details>", incident: "</details>" };
  for (const screen of ["overview", "incident"] as const) {
    for (const s of SCENARIOS) {
      for (const d of [...CASES, "default"] as const) {
        const base = d === "default" ? html[key(screen, s, "base")] : await render(screen, "base", { s, d });
        assert.ok(!base.includes("e3-"), `${screen} ${s} ${d}: the stand-in page carries no E3 content`);
        assert.equal(base.split(insertBefore[screen]).length, 2, `${screen} ${s} ${d}: one insertion point`);
        const h = page(screen, s, d);
        assert.equal(h, base.replace(insertBefore[screen], e3(screen, s, d) + insertBefore[screen]), `${screen} ${s} ${d}: page without E3 + the E3 section`);
        assert.ok(e3(screen, s, d).endsWith("</section>"));
      }
    }
  }
});

test("E3-AT-10.3 the Shell still shows six screens, and its scenario switch returns E3 to the default delayed case", () => {
  const expectedNav = (s: Scenario) => [["overview", 1, "Command"], ["payables", 2, "Payables"], ["incident", 3, "Incident"], ["approvals", 4, "Approvals"], ["recorder", 5, "Recorder"], ["eligibility", 6, "Eligibility"]].map(([k, n, label]) => [`/${k}?s=${s}`, String(n), label]);
  for (const [screen, n, title] of [["overview", 1, "Command"], ["incident", 3, "Incident detail"]] as const) {
    for (const s of SCENARIOS) {
      for (const d of CASES) {
        const h = page(screen, s, d);
        const nav = h.match(/<nav class="tabs" aria-label="Incident Room screens">([\s\S]*?)<\/nav>/);
        assert.ok(nav);
        assert.deepEqual([...nav![1].matchAll(/<a href="([^"]+)"(?: aria-current="page")?><span class="n">(\d+)<\/span><span>([^<]+)<\/span><\/a>/g)].map((x) => [x[1], x[2], x[3]]), expectedNav(s), `${screen} ${s} ${d}: six screens, unchanged hrefs`);
        assert.ok(h.includes(`Incident Room · screen ${n} of 6`) && h.includes(`<h1>${title}</h1>`));
        for (const tag of ["<nav ", "<main ", "<h1>", "<header>", "<footer "]) assert.equal(h.split(tag).length - 1, 1, `${screen} ${s} ${d}: one ${tag.trim()}`);
        const sw = h.match(/<div class="scenario-switch"[^>]*>([\s\S]*?)<\/div>/);
        assert.deepEqual([...sw![1].matchAll(/<a href="([^"]+)"( aria-current="true")?/g)].map((x) => [x[1], x[2] !== undefined]), [[`/${screen}?s=S0`, s === "S0"], [`/${screen}?s=S1`, s === "S1"]], `${screen} ${s} ${d}: scenario switch unchanged and without a funding case`);
        assert.equal(count(h, /class="scenario-switch"/g), 1, "the E3 case links do not imitate the scenario switch");
      }
      // Following the Shell's scenario switch means a request with s only: the E3 view is then the delayed case.
      assert.ok(e3(screen, s, "default").includes('data-e3-funding-case="delayed"'));
    }
    assert.ok(e3(screen, "S0").includes("returns this section to that default") || screen === "incident");
  }
});

// ---- Boundary: no controls, no pathway, no recomputation ----

test("E3-B1 links only: no control element and no payment, approval or release affordance on either page", () => {
  for (const screen of ["overview", "incident"] as const) {
    for (const s of SCENARIOS) {
      for (const d of CASES) {
        const section = e3(screen, s, d);
        assert.doesNotMatch(section, /<(button|form|input|select|textarea|script|iframe|dialog)\b/i, `${screen} ${s} ${d}: no control or script element`);
        assert.doesNotMatch(section, /\son[a-z]+=/i, `${screen} ${s} ${d}: no event handler attribute`);
        assert.doesNotMatch(section, /pay now|release payment|approve payment|send funds|authorize payment|resend transfer/i);
        const hrefs = [...section.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
        for (const href of hrefs) assert.match(href, /^(#e3-[A-Za-z0-9-]+|\/(overview|incident)\?s=S[01]&amp;d=(on_time|delayed)(#e3-[a-z-]+)?)$/, `${screen}: only E3 fragments and the two read-only screens: ${href}`);
      }
    }
    assert.equal(count(page(screen, "S0"), /<button/gi), count(html[key(screen, "S0", "base")], /<button/gi), `${screen}: E3 adds no button to the page`);
  }
});

test("E3-B2 the E3 sources hold no network, provider, database, credential or client-side pathway and no finance rule", () => {
  const files = ["src/data/cashCrisis.ts", "src/components/CashCrisisForecast.tsx", "src/components/CashCrisisIncident.tsx"];
  for (const file of files) {
    const source = readFileSync(join(webRoot, file), "utf8");
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|\/api\/|psycopg|sqlalchemy|airwallex|process\.env|require\(|child_process|node:(net|http|https|fs|dgram|tls)|\bSELECT\b|\bINSERT\b/, `${file}: no network, provider, database or credential pathway`);
    assert.doesNotMatch(source, /"use client"|'use client'|useState|useEffect|onClick|onChange|onSubmit|addEventListener|localStorage/, `${file}: server-rendered only`);
    assert.doesNotMatch(source, /<button|<form|<input|<select|<textarea/i, `${file}: no control element`);
    assert.doesNotMatch(source, /parseFloat|toFixed|Math\.round|Number\.parseFloat/, `${file}: no float money handling`);
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((x) => x[1]);
    for (const spec of imports) {
      assert.match(spec, /^(next\/link|\.\/(Figure|CashCrisisForecast)\.tsx|\.\.\/contract\/(money|types)\.ts|\.\.\/data\/cashCrisis\.ts|\.\.\/\.\.\/fixtures\/(cash_crisis_evidence_v1|eligibility_evidence_v1)\.json)$/, `${file}: unexpected import ${spec}`);
    }
  }
  const reader = readFileSync(join(webRoot, "src/data/cashCrisis.ts"), "utf8");
  assert.ok(reader.includes('from "../../fixtures/cash_crisis_evidence_v1.json"'), "the committed snapshot is the only source of E3 figures");
  for (const file of files.slice(1)) {
    const source = readFileSync(join(webRoot, file), "utf8");
    assert.doesNotMatch(source, /[0-9]{3,}(_[0-9]{3})*n\b|\$[0-9]{1,3}(,[0-9]{3})+/, `${file}: no literal money amount; figures come from the snapshot`);
    assert.doesNotMatch(source, /addCents|subtractCents|\bsum\(|max0\(|\bmin\(/, `${file}: no money arithmetic in a component`);
  }
});
