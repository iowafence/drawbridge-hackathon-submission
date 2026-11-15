// SIM-ENG-002-E1 / AT-9 — frontend tests for the capital eligibility screen (D4), extended by SIM-ENG-002-E2 for the
// Incident Room integration: the page now renders inside the shared Shell (screen 6 of 6).
// The page, the Shell and Figure are React server components in .tsx files. Node's type stripping does not read JSX, so
// the test transpiles them with the project's TypeScript compiler into a temporary directory OUTSIDE the source tree,
// rewrites their imports to absolute locations (the fixture, the workspace's .ts modules and React, and a one-line
// stand-in for next/link), renders with react-dom/server and asserts on the static markup.
// No network, no backend, no repository write: everything generated lives under os.tmpdir().
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = join(here, "..");
const fixturePath = join(webRoot, "fixtures", "eligibility_evidence_v1.json");
const EXPECTED_SCHEMA = "drawbridge.sim-eng-002-e1.demo-eligibility-evidence.v1";

type Decision = { decision_id: string; request_id: string; state: string; rule_ids: string[]; evidence_sha256: string; measures: Record<string, unknown> };
type Evidence = { schema: string; synthetic: boolean; non_operational: boolean; counts: Record<string, number>; decisions: Decision[] };

let fixture: Evidence;
let page: {
  default: (props: { searchParams: Promise<{ s?: string }> }) => Promise<unknown>;
  EligibilityContent: () => unknown;
  buildView: (raw: unknown) => { counts: Record<string, number>; total: number };
  evidenceAnchor: (decisionId: string) => string;
  decisionAnchor: (decisionId: string) => string;
  UNAVAILABLE: string;
  EVIDENCE_SCHEMA: string;
};
let html = "";       // the full /eligibility?s=S0 page, rendered through the Shell
let htmlS1 = "";     // the same screen for scenario S1
let content = "";    // the eligibility content alone, without the Shell
let tmp = "";

function transpile(source: string, fileName: string): string {
  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true },
  });
  return out.outputText;
}

function rewrite(code: string, map: Record<string, string>): string {
  for (const [from, to] of Object.entries(map)) {
    code = code.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`"${to}"`);
  }
  return code;
}

before(async () => {
  fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Evidence;
  tmp = mkdtempSync(join(tmpdir(), "e2-eligibility-"));
  const resolve = (spec: string) => fileURLToPath(import.meta.resolve(spec));
  const jsx = pathToFileURL(resolve("react/jsx-runtime")).href;
  const src = (rel: string) => pathToFileURL(join(webRoot, "src", rel)).href;
  writeFileSync(join(tmp, "link.mjs"), `import { createElement } from ${JSON.stringify(pathToFileURL(resolve("react")).href)};\nexport default function Link(p){ const { href, children, ...rest } = p; return createElement("a", { href, ...rest }, children); }\n`);
  const figure = transpile(readFileSync(join(webRoot, "src/components/Figure.tsx"), "utf8"), "Figure.tsx");
  writeFileSync(join(tmp, "Figure.mjs"), rewrite(figure, { "react/jsx-runtime": jsx }));
  const shell = transpile(readFileSync(join(webRoot, "src/components/Shell.tsx"), "utf8"), "Shell.tsx");
  writeFileSync(
    join(tmp, "Shell.mjs"),
    rewrite(shell, {
      "react/jsx-runtime": jsx,
      "next/link": pathToFileURL(join(tmp, "link.mjs")).href,
      "../data/adapter.ts": src("data/adapter.ts"),
      "../contract/money.ts": src("contract/money.ts"),
    }),
  );
  const pageSrc = transpile(readFileSync(join(webRoot, "src/app/eligibility/page.tsx"), "utf8"), "page.tsx");
  writeFileSync(
    join(tmp, "page.mjs"),
    rewrite(pageSrc, {
      "react/jsx-runtime": jsx,
      "../../../fixtures/eligibility_evidence_v1.json": pathToFileURL(fixturePath).href,
      "../../components/Figure.tsx": pathToFileURL(join(tmp, "Figure.mjs")).href,
      "../../components/Shell.tsx": pathToFileURL(join(tmp, "Shell.mjs")).href,
      "../../contract/money.ts": src("contract/money.ts"),
      "../../data/load.ts": src("data/load.ts"),
    }),
  );
  page = (await import(pathToFileURL(join(tmp, "page.mjs")).href)) as typeof page;
  content = renderToStaticMarkup(createElement(page.EligibilityContent as never));
  html = renderToStaticMarkup((await page.default({ searchParams: Promise.resolve({ s: "S0" }) })) as never);
  htmlS1 = renderToStaticMarkup((await page.default({ searchParams: Promise.resolve({ s: "S1" }) })) as never);
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const count = (re: RegExp) => (html.match(re) ?? []).length;
// The whole rendered row of one decision: from its <li id="decision-…"> to the next decision row or the end of its group.
const li = (id: string) => {
  const open = `<li id="${page.decisionAnchor(id)}" data-decision-id="${id}"`;
  const start = html.indexOf(open);
  assert.ok(start >= 0, `decision ${id} rendered`);
  assert.equal(html.indexOf(open, start + 1), -1, `decision ${id} rendered once`);
  const nextRow = html.indexOf(`<li id="decision-`, start + 1);
  const endGroup = html.indexOf("</section>", start);
  const end = nextRow >= 0 && nextRow < endGroup ? nextRow : endGroup;
  const span = html.slice(start, end);
  const row = span.slice(0, span.lastIndexOf("</li>") + "</li>".length);
  assert.ok(row.endsWith("</details></li>"), `row ${id} is complete`);
  return row;
};

test("AT-9.1 evidence fixture loads and is synthetic and non-operational", () => {
  assert.equal(typeof fixture, "object");
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.non_operational, true);
  assert.ok(Array.isArray(fixture.decisions) && fixture.decisions.length > 0);
});

test("AT-9.2 schema identifier is correct in the fixture and in the page", () => {
  assert.equal(fixture.schema, EXPECTED_SCHEMA);
  assert.equal(page.EVIDENCE_SCHEMA, EXPECTED_SCHEMA);
  assert.ok(html.includes(EXPECTED_SCHEMA));
});

test("AT-9.3 three groups are rendered, distinct, each with its heading", () => {
  for (const s of ["ALLOWED", "BLOCKED", "UNRESOLVED"]) {
    assert.equal(count(new RegExp(`<section class="card" data-group="${s}"`, "g")), 1, s);
    assert.ok(html.includes(`id="group-${s}"`), `heading ${s}`);
  }
  assert.equal(count(/data-group="/g), 3);
});

test("AT-9.4 displayed counts are derived from the decisions array and agree with it", () => {
  const derived: Record<string, number> = { ALLOWED: 0, BLOCKED: 0, UNRESOLVED: 0 };
  for (const d of fixture.decisions) derived[d.state] += 1;
  const view = page.buildView(fixture);
  for (const s of Object.keys(derived)) {
    assert.equal(view.counts[s], derived[s], s);
    const m = html.match(new RegExp(`<span data-count="${s}">(\\d+)</span>`));
    assert.ok(m, `count span ${s}`);
    assert.equal(Number(m![1]), derived[s], `rendered count ${s}`);
    assert.equal(count(new RegExp(`<li id="decision-[^"]+" data-decision-id="[^"]+" data-state="${s}"`, "g")), derived[s], `rows in group ${s}`);
  }
  assert.equal(view.total, fixture.decisions.length);
  assert.equal(derived.ALLOWED + derived.BLOCKED + derived.UNRESOLVED, fixture.decisions.length);
});

test("AT-9.4b the view refuses evidence whose counts block disagrees with its decisions", () => {
  const tampered = structuredClone(fixture) as Evidence;
  tampered.counts.ALLOWED += 1;
  assert.throws(() => page.buildView(tampered), /counts\.ALLOWED disagrees/);
  const wrongSchema = structuredClone(fixture) as Evidence;
  wrongSchema.schema = "other";
  assert.throws(() => page.buildView(wrongSchema), /schema mismatch/);
});

test("AT-9.5 every decision appears exactly once", () => {
  for (const d of fixture.decisions) {
    assert.equal(count(new RegExp(`data-decision-id="${d.decision_id}"`, "g")), 1, d.decision_id);
  }
});

test("AT-9.6 no decision is invented", () => {
  const rendered = [...html.matchAll(/data-decision-id="([^"]+)"/g)].map((m) => m[1]).sort();
  const expected = fixture.decisions.map((d) => d.decision_id).sort();
  assert.deepEqual(rendered, expected);
});

test("AT-9.7 invalid or missing amounts are never shown as $0.00", () => {
  let nulls = 0;
  for (const d of fixture.decisions) {
    const row = li(d.decision_id);
    const amount = d.measures.amount_minor;
    if (typeof amount === "number" && Number.isSafeInteger(amount)) {
      assert.ok(row.includes(`data-amount="${amount}"`), `${d.decision_id} amount attribute`);
    } else {
      nulls += 1;
      assert.ok(row.includes('data-amount="unavailable"'), `${d.decision_id} unavailable marker`);
      assert.ok(row.includes(page.UNAVAILABLE), `${d.decision_id} unavailable text`);
      assert.ok(!/Requested amount: <span[^>]*>\$0\.00</.test(row), `${d.decision_id} must not show $0.00`);
    }
  }
  assert.ok(nulls > 0, "the fixture exercises at least one invalid amount");
});

test("AT-9.8 every decision shows its actual rule ids and evidence hash", () => {
  for (const d of fixture.decisions) {
    const row = li(d.decision_id);
    assert.ok(row.includes(d.evidence_sha256), `${d.decision_id} evidence hash`);
    for (const r of d.rule_ids) assert.ok(row.includes(r), `${d.decision_id} rule ${r}`);
    assert.ok(row.includes(d.rule_ids[d.rule_ids.length - 1]), "deciding rule shown");
  }
});

test("AT-9.9 ALLOWED is not displayed as an actual payment approval or release", () => {
  assert.ok(html.includes("Eligible under the demonstrated rules. Not a payment authorization, not an approval, not a release."));
  assert.ok(!/<button/i.test(html), "no action buttons");
  assert.ok(!/release payment|pay now|approve payment|send funds/i.test(html));
  assert.ok(html.includes("not cryptographic authorization"));
  assert.ok(html.includes("not signatures and do not establish independent custody"));
});

test("AT-9.10 synthetic / non-operational labelling is present", () => {
  assert.ok(html.includes("SYNTHETIC / NON-OPERATIONAL DEMO"));
  assert.ok(html.includes("no real parties, accounts, banking"));
  assert.ok(html.includes("provider connection"));
});

// ---- Evidence navigation (LOOM-2 finding: decision ids must be navigable evidence links, not text) ----

const allIds = () => [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
const FRAGMENT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

test("AT-9.11 every decision row carries a real anchor whose href is a valid fragment to its own evidence record", () => {
  for (const d of fixture.decisions) {
    const row = li(d.decision_id);
    const anchors = [...row.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.equal(anchors.length, 1, `${d.decision_id} has exactly one link`);
    const [, href, text] = anchors[0];
    assert.notEqual(href, "#", `${d.decision_id} link is not a placeholder`);
    assert.ok(href.startsWith("#"), `${d.decision_id} link is an in-page fragment`);
    assert.ok(FRAGMENT_ID.test(href.slice(1)), `${d.decision_id} fragment is a valid element id`);
    assert.equal(href, `#${page.evidenceAnchor(d.decision_id)}`, `${d.decision_id} href targets its own evidence id`);
    assert.equal(text.trim(), d.decision_id, `${d.decision_id} link text is the decision id`);
    assert.ok(anchors[0][0].includes(`data-evidence-link="${d.decision_id}"`));
  }
});

test("AT-9.12 every link target exists exactly once, inside the same row's evidence details, and carries that decision's evidence", () => {
  const ids = allIds();
  for (const d of fixture.decisions) {
    const target = page.evidenceAnchor(d.decision_id);
    assert.equal(ids.filter((x) => x === target).length, 1, `${target} exists exactly once in the document`);
    const row = li(d.decision_id);
    assert.ok(row.includes(`id="${target}"`), `${target} is inside the row of ${d.decision_id}`);
    const details = row.match(/<details[^>]*>([\s\S]*?)<\/details>/);
    assert.ok(details, `${d.decision_id} has an evidence details element`);
    assert.ok(details![0].includes(`data-evidence-for="${d.decision_id}"`));
    assert.ok(details![1].includes(`id="${target}"`), `${target} sits inside the details so navigation reveals it`);
    const record = details![1].slice(details![1].indexOf(`id="${target}"`));
    assert.ok(record.includes(d.evidence_sha256), `${target} shows the matching evidence hash`);
    assert.ok(record.includes(`<dd class="mono">${d.decision_id}</dd>`), `${target} names the matching decision id`);
    for (const other of fixture.decisions) {
      if (other.decision_id !== d.decision_id) assert.ok(!record.includes(other.evidence_sha256), `${target} does not show another decision's evidence`);
    }
    assert.equal(ids.filter((x) => x === page.decisionAnchor(d.decision_id)).length, 1, `row id for ${d.decision_id} exists once`);
  }
});

test("AT-9.13 all 21 decisions have evidence navigation and every element id on the page is unique", () => {
  const ids = allIds();
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(", ")}`);
  const links = [...html.matchAll(/data-evidence-link="([^"]+)"/g)].map((m) => m[1]).sort();
  const targets = ids.filter((x) => x.startsWith("evidence-")).map((x) => x.slice("evidence-".length)).sort();
  const expected = fixture.decisions.map((d) => d.decision_id).sort();
  assert.equal(expected.length, 21);
  assert.deepEqual(links, expected, "one evidence link per decision, none invented");
  assert.deepEqual(targets, expected, "one evidence target per decision, none invented");
  const hrefs = [...html.matchAll(/href="#(evidence-[^"]+)"/g)].map((m) => m[1]);
  for (const h of hrefs) assert.ok(ids.includes(h), `dangling fragment link #${h}`);
  assert.equal(hrefs.length, 21);
});

test("AT-9.14 evidence links are not controls: no buttons, no forms, no release or payment hrefs", () => {
  assert.ok(!/<button/i.test(html));
  assert.ok(!/<form/i.test(html));
  const external = [...html.matchAll(/href="([^"#][^"]*)"/g)].map((m) => m[1]);
  // Payment-action paths are forbidden; the Incident Room route /payables is a read-only screen, not an action.
  assert.deepEqual(external.filter((h) => /\/(release|pay|approve|fund|transfer)(?![a-z])/i.test(h)), []);
  for (const h of external) assert.ok(h.startsWith("/"), `only same-origin navigation: ${h}`);
});

// ---- SIM-ENG-002-E2: Incident Room integration ----

test("E2-1 the page renders through the real Shell as screen 6 of 6 with Eligibility current in the navigation", () => {
  assert.ok(html.includes('aria-label="Incident Room screens"'), "shell navigation present");
  assert.ok(/<a href="\/eligibility\?s=S0" aria-current="page"[^>]*>/.test(html), "Eligibility is the current screen");
  assert.ok(html.includes("Incident Room · screen 6 of 6"));
  assert.ok(html.includes("<h1>Capital eligibility (synthetic)</h1>"));
  assert.ok(html.includes("SYNTHETIC DEMONSTRATION DATA"), "shell synthetic bar present");
  assert.ok(html.includes("Source: SYNTHETIC_FIXTURE"), "shell footer present");
});

test("E2-2 the Shell navigation lists all six screens in order and the five existing routes are unchanged", () => {
  const nav = html.match(/<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, "nav rendered");
  const links = [...nav![1].matchAll(/<a href="([^"]+)"[^>]*>(?:<span class="n">(\d+)<\/span>)<span>([^<]+)<\/span><\/a>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(links, [
    ["/overview?s=S0", "1", "Command"],
    ["/payables?s=S0", "2", "Payables"],
    ["/incident?s=S0", "3", "Incident"],
    ["/approvals?s=S0", "4", "Approvals"],
    ["/recorder?s=S0", "5", "Recorder"],
    ["/eligibility?s=S0", "6", "Eligibility"],
  ]);
});

test("E2-3 no duplicated chrome: exactly one skip link, header, synthetic bar, navigation, main and footer; the E1 standalone header is gone", () => {
  assert.equal(count(/class="skip-link"/g), 1);
  assert.equal(count(/<header>/g), 1);
  assert.equal(count(/class="synthetic-bar"/g), 1);
  assert.equal(count(/<nav /g), 1);
  assert.equal(count(/<main /g), 1);
  assert.equal(count(/<footer /g), 1);
  assert.equal(count(/<h1>/g), 1);
  assert.ok(!html.includes('aria-label="Related screens"'), "E1 standalone navigation removed");
  assert.equal(count(/id="main-content"/g), 1);
});

test("E2-4 the scenario switch works on the eligibility screen and the eligibility content does not depend on it", () => {
  assert.ok(/<a href="\/eligibility\?s=S0" aria-current="true"/.test(html), "S0 current on S0 page");
  assert.ok(/<a href="\/eligibility\?s=S1" aria-current="true"/.test(htmlS1), "S1 current on S1 page");
  assert.ok(/<a href="\/eligibility\?s=S1" aria-current="page"/.test(htmlS1), "Eligibility current on S1 page");
  const ids = (h: string) => [...h.matchAll(/<li id="decision-([^"]+)" data-decision-id="[^"]+" data-state="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(ids(htmlS1), ids(html));
  assert.equal(ids(html).length, 21);
  for (const s of ["ALLOWED", "BLOCKED", "UNRESOLVED"]) {
    assert.equal(htmlS1.match(new RegExp(`<span data-count="${s}">(\\d+)</span>`))![1], html.match(new RegExp(`<span data-count="${s}">(\\d+)</span>`))![1]);
  }
});

test("E2-5 the content rendered inside the Shell is the accepted E1 content: same decisions, states, counts and evidence anchors as the standalone content", () => {
  const rows = (h: string) => [...h.matchAll(/<li id="decision-([^"]+)" data-decision-id="[^"]+" data-state="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows(html), rows(content));
  const targets = (h: string) => [...h.matchAll(/ id="(evidence-[^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(targets(html), targets(content));
  assert.equal(targets(html).length, 21);
  for (const d of fixture.decisions) {
    const row = li(d.decision_id);
    assert.ok(row.includes(`data-state="${d.state}"`), `${d.decision_id} keeps the fixture's state ${d.state}`);
  }
  assert.ok(content.includes("SYNTHETIC / NON-OPERATIONAL DEMO") && html.includes("SYNTHETIC / NON-OPERATIONAL DEMO"));
});

test("E2-6 no eligibility recomputation and no payment, provider or database pathway in the page or the Shell", () => {
  const pageSrc = readFileSync(join(webRoot, "src/app/eligibility/page.tsx"), "utf8");
  const shellSrc = readFileSync(join(webRoot, "src/components/Shell.tsx"), "utf8");
  for (const [name, src] of [["page", pageSrc], ["shell", shellSrc]] as const) {
    assert.doesNotMatch(src, /fetch\s*\(|\/api\/|psycopg|sqlalchemy|airwallex|process\.env|require\(|child_process|node:net|node:http/, `${name}: no network, provider or database pathway`);
    assert.doesNotMatch(src, /<button|<form|onClick|release payment|pay now|approve payment|send funds/i, `${name}: no controls`);
  }
  assert.doesNotMatch(pageSrc, /DEMO-R0[1-7]|evaluate_availability|commitments_v4|classif/i, "page does not re-implement the engine's rules");
  assert.ok(pageSrc.includes('from "../../../fixtures/eligibility_evidence_v1.json"'), "the sealed evidence fixture is the only source of decisions");
  assert.equal(count(/<button/gi), 0);
  assert.equal(count(/<form/gi), 0);
});
