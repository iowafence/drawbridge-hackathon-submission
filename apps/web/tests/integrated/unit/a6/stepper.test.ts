// A6 integrated stepper tests (contract flow-v1). Offline, no network, no browser: server-rendered markup only.
// What is asserted is what the screen CLAIMS: one flow id, the 11 proofs exactly as the gate reported them, HOLD
// reasons, the human-approval requirement, authorization status, and provider truth (submitted / processing / not
// settled). Plus the action surface per state, money separation, import boundaries and markup accessibility.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FLOW_ACTION_OPS, PROOF_IDS, STEP_UP_OPS } from "../../../../integrated/flowTypes.ts";
import type { FlowState, FlowView } from "../../../../integrated/flowTypes.ts";
import { generate, UI_FIXTURE_PATH } from "./generate_ui_fixtures.ts";
import { buildA6, enabledEnv, NotFound, WEB, withEnv } from "./render.ts";
import type { A6Render } from "./render.ts";

type FV = FlowView & { fixture: { id: string; label: string } };
const FIX = JSON.parse(readFileSync(UI_FIXTURE_PATH, "utf8")) as { views: FV[]; kind: string };
const V = (id: string) => {
  const v = FIX.views.find((x) => x.fixture.id === id);
  assert.ok(v, `fixture ${id}`);
  return v!;
};
const CONTROLS = { csrf: "c".repeat(43) };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const formCount = (html: string) => (html.match(/<form[\s>]/g) ?? []).length;
const forms = (html: string) => {
  const out = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => {
  const fields = Object.fromEntries([...m[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    assert.match(m[1], /\bmethod="post"/, "every form posts");
    return { action: m[1].match(/\baction="([^"]+)"/)?.[1], op: fields.op, fields, passphrase: [...m[2].matchAll(/<input\b[^>]*>/g)].some((i) => /type="password"/.test(i[0]) && /name="passphrase"/.test(i[0]) && /required=""/.test(i[0])), body: m[2] };
  });
  assert.equal(out.length, formCount(html), "form parser saw every form");
  return out;
};
const noStyle = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "");
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

let r: A6Render;
before(async () => { r = await buildA6(); });
after(() => r?.dispose());

test("A6-01 fixtures: the gate sections are exactly what the real gate produces today (drift check)", () => {
  assert.equal(FIX.kind, "UI_FIXTURE");
  assert.equal(JSON.stringify(generate(), null, 2) + "\n", readFileSync(UI_FIXTURE_PATH, "utf8"), "regenerate: node tests/integrated/unit/a6/generate_ui_fixtures.ts");
  const ids = FIX.views.map((v) => v.fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(FIX.views.map((v) => v.flow_id)).size, ids.length, "distinct flow ids");
});

test("A6-02 one flow id: shown once as the flow id, carried by the root, by every form, and no other flow's id appears", () => {
  for (const v of FIX.views) {
    for (const controls of [null, CONTROLS]) {
      const html = r.stepper(v, { controls });
      assert.match(html, new RegExp(`<article class="ifs" data-flow-id="${v.flow_id}"`));
      assert.equal((html.match(/Flow ID <code>/g) ?? []).length, 1, `${v.fixture.id}: one flow id line`);
      assert.ok(html.includes(`Flow ID <code>${v.flow_id}</code>`));
      assert.match(html, new RegExp(`<code data-state-code="[^"]*">${v.state}</code>`), `${v.fixture.id}: exact contract state name shown`);
      for (const f of forms(html)) assert.equal(f.fields.flow_id, v.flow_id, `${v.fixture.id}/${f.op}: form flow id`);
      const others = new Set(FIX.views.filter((o) => o !== v).map((o) => o.flow_id));
      for (const u of html.match(UUID) ?? []) assert.ok(!others.has(u), `${v.fixture.id}: foreign flow id ${u}`);
    }
  }
});

test("A6-03 all 11 proofs render in published order with the gate's own state and reason, verbatim", () => {
  for (const v of FIX.views.filter((x) => x.gate)) {
    const html = r.stepper(v);
    const rows = [...html.matchAll(/<tr data-proof="([A-Z])" data-state="([A-Z]+)"><th scope="row">([A-Z])<\/th>[\s\S]*?<td data-label="Reason">([\s\S]*?)<\/td><\/tr>/g)];
    assert.deepEqual(rows.map((m) => m[1]), [...PROOF_IDS], `${v.fixture.id}: S,A..J in order`);
    for (const m of rows) {
      const id = m[1] as (typeof PROOF_IDS)[number];
      assert.equal(m[2], v.gate!.proof_states[id]);
      assert.equal(text(m[4]).trim(), v.gate!.proof_reasons[id].replace(/\s+/g, " ").trim(), `${v.fixture.id}/${id}: reason verbatim`);
    }
    assert.ok(html.includes(`<code>${v.gate!.rule}</code>`), "deciding rule shown");
  }
  assert.doesNotMatch(r.stepper(V("evidence-ready")), /data-proof=/, "no proof table before the gate runs");
});

test("A6-04 HOLD and REVIEW: every non-VERIFIED proof is listed as a reason; approval and submission are not available; no form", () => {
  for (const id of ["hold-dispute", "hold-edited", "review-balance-unknown"]) {
    const v = V(id);
    for (const controls of [null, CONTROLS]) {
      const html = r.stepper(v, { controls });
      const t = text(html);
      const failing = PROOF_IDS.filter((p) => v.gate!.proof_states[p] !== "VERIFIED");
      assert.ok(failing.length > 0);
      const callout = html.match(/<div class="ifs-callout[^"]*" role="note" aria-labelledby="ifs-hold-h">([\s\S]*?)<\/div>/);
      assert.ok(callout, `${id}: reasons callout`);
      for (const p of failing) assert.ok(text(callout![1]).includes(`${p} ·`) && text(callout![1]).includes(v.gate!.proof_states[p]), `${id}: lists ${p}`);
      assert.ok(t.includes(v.gate!.decision === "HOLD" ? "Why this is on HOLD" : "Why this is not eligible (REVIEW)"));
      assert.ok(t.includes("cannot be approved or submitted"));
      assert.ok(t.includes("Authorization status: not available"));
      assert.match(html, /class="ifs-step ifs-bad"><span class="ifs-n" aria-hidden="true">4<\/span><span class="ifs-step-body"><a href="#ifs-approval">Human approval<\/a><span class="ifs-step-status">Not available<\/span>/);
      assert.equal(formCount(html), 0, `${id}: no action form`);
      assert.doesNotMatch(t, /ELIGIBLE FOR HUMAN REVIEW/);
    }
  }
});

test("A6-05 human approval is always stated as a requirement; eligible is never shown as approved or as permission to pay", () => {
  for (const v of FIX.views) assert.ok(text(r.stepper(v)).includes("an authenticated operator must re-enter their passphrase to approve this exact proposal"), v.fixture.id);
  const t = text(r.stepper(V("awaiting-human")));
  assert.ok(t.includes("ELIGIBLE FOR HUMAN REVIEW (not authority to pay)"));
  assert.ok(t.includes("Eligible for human review is not permission to pay"));
  assert.ok(t.includes("Authorization status: not approved"));
  assert.ok(t.includes("Not approved. Nothing has been sent."));
});

test("A6-06 authorization status follows the recorded state: approved-unused, consumed by the attempt, expired unused", () => {
  assert.ok(text(r.stepper(V("human-approved"))).includes("Approved, not yet used"));
  assert.ok(text(r.stepper(V("human-approved"))).includes("No transfer has been requested or made."));
  for (const id of ["submitted", "processing", "uncertain", "paid-mock"]) assert.ok(text(r.stepper(V(id))).includes("Approved and consumed by the single submission attempt"), id);
  assert.ok(text(r.stepper(V("expired"))).includes("Approved, then expired unused"));
  assert.ok(text(r.stepper(V("human-approved"))).includes("Approved by human:operator"));
});

test("A6-07 provider truth: nothing short of a provider READ of PAID is shown as paid; create responses are never a status", () => {
  for (const v of FIX.views) {
    const html = r.stepper(v);
    const settle = html.match(/<b data-settlement="[^"]*">([^<]+)<\/b>/)?.[1] ?? "";
    if (v.state === "PROVIDER_PAID") {
      assert.match(settle, /^Mock provider read reported PAID\. Mock mode: no provider was called and no money exists or moved$/);
    } else {
      assert.match(settle, /Not settled$/, `${v.fixture.id}: ${settle}`);
      assert.doesNotMatch(text(html), /\bsettled\b(?<!Not settled)|reported PAID/i);
    }
  }
  const sub = text(r.stepper(V("submitted")));
  assert.ok(sub.includes("Submitted (accepted by provider)") && sub.includes("Not scheduled, not processing, not paid."));
  assert.ok(sub.includes("HTTP 201, create response said PROCESSING (not a status read; never treated as the transfer's state)"));
  assert.ok(sub.includes("No provider read recorded"));
  const proc = text(r.stepper(V("processing")));
  assert.ok(proc.includes("Last provider read PROCESSING at") && proc.includes("Not settled. Not paid."));
  const unc = text(r.stepper(V("uncertain")));
  assert.ok(unc.includes("Outcome unknown.") && unc.includes("will not resend it"));
  assert.ok(unc.includes("Unknown whether a transfer exists. Not settled"));
  assert.ok(unc.includes("No response recorded"));
});

test("A6-08 sandbox-mode PAID wording names sandbox test funds and is never project cash", () => {
  const v = { ...V("paid-mock"), provider_mode: "sandbox" as const };
  assert.ok(text(r.stepper(v)).includes("Airwallex sandbox read reported PAID. Sandbox test funds only, not real money and not project cash"));
});

const ALLOWED_OPS: Partial<Record<FlowState, string[]>> = {
  EVIDENCE_READY: ["evaluate_gate"],
  GATE_ELIGIBLE: ["request_human_review"],
  AWAITING_HUMAN: ["approve", "reject"],
  HUMAN_APPROVED: ["submit"],
  SUBMIT_INTENT_RECORDED: ["reconcile"],
  SUBMITTED: ["reconcile"],
  SUBMISSION_UNCERTAIN: ["reconcile"],
  PROVIDER_SCHEDULED: ["reconcile"],
  PROVIDER_PROCESSING: ["reconcile"],
};
const ALL_STATES: FlowState[] = ["DRAFT", "EVIDENCE_READY", "GATE_HOLD", "GATE_REVIEW", "GATE_ELIGIBLE", "AWAITING_HUMAN", "HUMAN_APPROVED", "HUMAN_REJECTED", "EXPIRED", "SUBMIT_INTENT_RECORDED", "SUBMITTED", "SUBMISSION_UNCERTAIN", "PROVIDER_REFUSED", "PROVIDER_SCHEDULED", "PROVIDER_PROCESSING", "PROVIDER_FAILED", "PROVIDER_PAID"];
const TERMINAL = new Set<FlowState>(["GATE_HOLD", "GATE_REVIEW", "HUMAN_REJECTED", "EXPIRED", "PROVIDER_REFUSED", "PROVIDER_FAILED", "PROVIDER_PAID"]);

test("A6-09 action surface per state (all 17 states): only the legal next op, step-up where required, digests echoed, posted to A7's route", () => {
  for (const state of ALL_STATES) {
    const v = { ...V("human-approved"), state, terminal: TERMINAL.has(state) };
    const fs = forms(r.stepper(v, { controls: CONTROLS }));
    assert.deepEqual(fs.map((f) => f.op), ALLOWED_OPS[state] ?? [], state);
    for (const f of fs) {
      assert.equal(f.action, "/sandbox/flow/action");
      assert.equal(f.fields.csrf, CONTROLS.csrf);
      const fieldNames = Object.keys(f.fields).concat(f.passphrase ? ["passphrase"] : []);
      for (const k of fieldNames) assert.ok(["op", "csrf", "flow_id", "case_id", "document_id", "run_id", "proposal_digest", "gate_digest", "authorization_digest", "passphrase"].includes(k), `${state}/${f.op}: field ${k} is in the contract list`);
      assert.ok((FLOW_ACTION_OPS as readonly string[]).includes(f.op), `${state}: ${f.op} is a flow-v1.1 FLOW_ACTION_OPS value`);
      assert.equal(f.passphrase, (STEP_UP_OPS as readonly string[]).includes(f.op), `${state}/${f.op}: passphrase step-up per STEP_UP_OPS`);
      const digests = Object.fromEntries(Object.entries(f.fields).filter(([k]) => k.endsWith("_digest")));
      const expected = f.op === "approve" ? { proposal_digest: v.echo.proposal_digest, gate_digest: v.echo.gate_digest } : f.op === "reject" ? { proposal_digest: v.echo.proposal_digest } : f.op === "submit" ? { authorization_digest: v.echo.authorization_digest } : {};
      assert.deepEqual(digests, expected, `${state}/${f.op}: echoes exactly the server's FlowView.echo`);
      assert.doesNotMatch(f.body, /name="(decision|state|status|verdict|proof|approved|paid)/i, "no client-asserted result");
    }
  }
});

test("A6-10 preview and read-only views render no form at all, whatever the state", () => {
  for (const v of FIX.views) {
    assert.equal(formCount(r.stepper(v, { preview: true, controls: CONTROLS })), 0, `${v.fixture.id}: preview`);
    assert.equal(formCount(r.stepper(v)), 0, `${v.fixture.id}: no controls`);
    assert.ok(r.stepper(v, { preview: true }).includes("UI FIXTURE PREVIEW. Not a live flow."));
  }
});

test("A6-11 money separation: synthetic obligation, mock/sandbox provider balance and E3 project figures are separate and labelled", () => {
  const E3_FIGURES = ["1,300,000", "1300000", "420,000", "185,000", "310,000"];
  for (const v of FIX.views) {
    const html = r.stepper(v);
    const money = html.match(/<section id="ifs-money"[\s\S]*?<\/section>/)![0];
    assert.match(money, /<h4>Synthetic obligation<\/h4><p class="ifs-big">[^<]+<\/p><p>From the synthetic registry fixture\. Not a real invoice and not project cash\.<\/p>/);
    assert.ok(money.includes(v.provider_mode === "mock" ? "<h4>Mock provider balance</h4>" : "<h4>Airwallex sandbox USD balance</h4>"));
    assert.ok(text(money).includes("Never project cash."));
    const e3 = money.match(/<h4>E3 project figures<\/h4><p>([\s\S]*?)<\/p>/)![1];
    assert.doesNotMatch(text(e3), /\$|\d{2,}|USD/, "E3 cell carries no figure");
    for (const fig of E3_FIGURES) assert.ok(!html.includes(fig), `${v.fixture.id}: no E3 figure ${fig}`);
  }
  assert.ok(text(r.stepper(V("review-balance-unknown"))).includes("live read of the Airwallex sandbox USD balance: test funds, not real money"));
});

test("A6-12 ledger appears only when the flow carries a binding, and only as 'drawn against allocation', never paid", () => {
  assert.doesNotMatch(r.stepper(V("processing")), /ifs-ledger/);
  const v = { ...V("processing"), ledger: { allocation_id: "ALLOC-SYN-1", funding_check_version: "g2c1-v1", funding_checked_at_ms: 1, reduction_event_id: "EV-1", reduced_at_ms: 2, label: "drawn against allocation" as const } };
  const t = text(r.stepper(v));
  assert.ok(t.includes("drawn against allocation: event EV-1"));
  assert.ok(t.includes("not a payment, not settlement and not proof that cash moved"));
});

test("A6-13 accessibility (markup): landmarks, headings, labels, unique ids, one current step, status not by colour alone", () => {
  for (const v of FIX.views) {
    for (const controls of [null, CONTROLS]) {
      const html = noStyle(r.stepper(v, { controls }));
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(new Set(ids).size, ids.length, `${v.fixture.id}: unique ids`);
      for (const m of html.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${v.fixture.id}: ${m[1]} exists`);
      for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${v.fixture.id}: anchor #${m[1]} exists`);
      assert.ok((html.match(/aria-current="step"/g) ?? []).length <= 1, `${v.fixture.id}: at most one current step`);
      assert.equal((html.match(/<h2[ >]/g) ?? []).length, 1);
      const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
      for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `${v.fixture.id}: no skipped heading level`);
      assert.match(html, /<nav aria-label="Transaction progress"><ol class="ifs-steps">/);
      assert.equal((html.match(/<li class="ifs-step /g) ?? []).length, 6);
      for (const m of html.matchAll(/<span class="ifs-step-status">([^<]*)<\/span>/g)) assert.ok(m[1].length > 0, "every step has a text status");
      for (const m of html.matchAll(/<span class="ifs-pill[^"]*"[^>]*>([^<]*)<\/span>/g)) assert.ok(m[1].trim().length > 0, "every pill has text");
      for (const m of html.matchAll(/<input id="([^"]+)"[^>]*type="password"/g)) assert.ok(html.includes(`<label for="${m[1]}">`), "password labelled");
      const passLabels = [...html.matchAll(/<label for="[^"]+-pass">([^<]*(?:<!-- -->[^<]*)*)<\/label>/g)].map((m) => m[1].replace(/<!-- -->/g, ""));
      assert.equal(new Set(passLabels).size, passLabels.length, `${v.fixture.id}: each passphrase field has a distinct label`);
      for (const l of passLabels) assert.match(l, /^Operator passphrase, re-entered to (approve|reject|submit)$/);
      for (const m of html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)) assert.ok(m[1].trim().length > 2, "button has a name");
      assert.doesNotMatch(html, /tabindex="[1-9]/i, "no positive tabindex");
      assert.doesNotMatch(html, / on[a-z]+=/i, "no inline handlers");
      assert.match(html, /role="status"/);
      const tbl = html.match(/<table class="ifs-proofs">/);
      if (v.gate) assert.ok(tbl && html.includes("<caption>") && html.includes('<th scope="col">Proof</th>'), "proof table has caption and header scope");
    }
  }
});

test("A6-14 responsive rules exist for 375px: stacked proof table under 640px, 44px targets, no fixed width beyond a phone", () => {
  const css = readFileSync(join(WEB, "src/components/integrated/FlowStepper.tsx"), "utf8").match(/const CSS = `([\s\S]*?)`;/)![1];
  assert.match(css, /@media \(max-width:640px\)\{[\s\S]*\.ifs-proofs tr\{display:grid/);
  assert.match(css, /\.ifs-act button\{min-height:44px/);
  assert.match(css, /input\[type=password\]\{min-height:44px/);
  assert.match(css, /overflow-wrap:anywhere/);
  for (const m of css.replace(/@media \([^)]*\)/g, "").matchAll(/(?<![a-z-])(?:min-|max-)?width:(\d+)px/g)) assert.ok(Number(m[1]) <= 343, `fixed width ${m[1]}px exceeds a 375px phone with 16px gutters`);
});

test("A6-15 boundaries: A6 components import contract types only; pages import only flags from integrated/; server components only", () => {
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
  // Scope (contract §12): A6 owns src/components/integrated/** and the two flow pages. A7 owns the routes under
  // src/app/sandbox/flow/action/** and src/app/sandbox/flow/agent-run/**; those are excluded here, by exact prefix only.
  // Every other file under src/app/sandbox/flow/** must be an A6 page, so a new file there cannot escape this scan.
  const A7_ROUTE_PREFIXES = ["src/app/sandbox/flow/action/", "src/app/sandbox/flow/agent-run/"];
  const A6_PAGES = ["src/app/sandbox/flow/page.tsx", "src/app/sandbox/flow/[flowId]/page.tsx"];
  const relOf = (f: string) => relative(WEB, f).split("\\").join("/");
  const all = [...walk(join(WEB, "src/components/integrated")), ...walk(join(WEB, "src/app/sandbox/flow"))].filter((f) => /\.tsx?$/.test(f));
  const files = all.filter((f) => !A7_ROUTE_PREFIXES.some((p) => relOf(f).startsWith(p)));
  for (const f of files) {
    const rel = relOf(f);
    assert.ok(rel.startsWith("src/components/integrated/") || A6_PAGES.includes(rel), `${rel}: unexpected file under src/app/sandbox/flow (not A6 per §12, not an excluded A7 route)`);
  }
  for (const pg of A6_PAGES) assert.ok(files.some((f) => relOf(f) === pg), `${pg}: A6 page present and scanned`);
  assert.ok(files.length >= 6);
  for (const f of files) {
    const rel = relOf(f);
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /^\s*["']use client["']/m, `${rel}: server only`);
    assert.doesNotMatch(src, /NEXT_PUBLIC_|localStorage|sessionStorage|fetch\(/, `${rel}: no client state or network`);
    assert.doesNotMatch(src, /from\s+"[^"]*src\/server\/|from\s+"[^"]*\/server\/(transfers|awx|runtime|audit|handler|auth|agent)/, `${rel}: no historic server import`);
    for (const m of src.matchAll(/^import\s+(type\s+)?[^"]*from\s+"([^"]*\/integrated\/[^"]+)"/gm)) {
      const target = m[2];
      if (target.includes("/fixtures/integrated/ui/")) continue;
      if (rel.startsWith("src/components/")) assert.ok(m[1], `${rel}: value import from ${target}; components import types only`);
      else assert.ok(m[1] || /integrated\/flags\.ts$/.test(target) || /components\/integrated\//.test(target), `${rel}: may only import flags.ts values from integrated/ (got ${target})`);
    }
    assert.doesNotMatch(src, /flowDigest|proposalDigest|gateDigest|authorizationDigest|evaluate\(|isLegal\(/, `${rel}: UI computes no digest, decision or transition`);
  }
});

test("A6-16 pages: 404 unless the integrated flow is enabled and valid; previews are labelled and never offered as live flows", async () => {
  for (const env of [{}, { DB_INTEGRATED_FLOW_ENABLED: "0" }, { DB_INTEGRATED_FLOW_ENABLED: "true" }, { DB_INTEGRATED_FLOW_ENABLED: "1" }, { ...enabledEnv(), DB_INTEGRATED_PROVIDER_MODE: "production" }]) {
    await withEnv(env, async () => {
      await assert.rejects(r.index(), NotFound, JSON.stringify(env));
      await assert.rejects(r.detail("awaiting-human"), NotFound);
    });
  }
  await withEnv(enabledEnv(), async () => {
    const idx = await r.index();
    assert.ok(text(idx).includes("The live flow service is not connected in this build. No live flow is listed."));
    assert.ok(text(idx).includes("UI fixture previews (not live flows)"));
    for (const v of FIX.views) assert.ok(idx.includes(`href="/sandbox/flow/${v.fixture.id}"`), v.fixture.id);
    assert.doesNotMatch(idx, /<form/);
    const d = await r.detail("hold-dispute");
    assert.ok(d.includes("UI FIXTURE PREVIEW. Not a live flow.") && d.includes("Preview: HOLD: open dispute, pending approval"));
    assert.doesNotMatch(d, /<form/);
    for (const bad of ["nope", "../etc", "AWAITING-HUMAN", "awaiting-human/x", V("awaiting-human").flow_id]) await assert.rejects(r.detail(bad), NotFound, bad);
  });
});

test("A6-17 flow-v1.1 echo: a missing echo digest fails closed (no form); the stepper's step-up list equals STEP_UP_OPS", () => {
  const ap = { ...V("awaiting-human"), echo: { ...V("awaiting-human").echo, gate_digest: null } };
  const h1 = r.stepper(ap, { controls: CONTROLS });
  assert.equal(formCount(h1), 0);
  assert.ok(text(h1).includes("Action not offered: the server supplied no gate digest to confirm."));
  const sb = { ...V("human-approved"), echo: { ...V("human-approved").echo, authorization_digest: null } };
  const h2 = r.stepper(sb, { controls: CONTROLS });
  assert.equal(formCount(h2), 0);
  assert.ok(text(h2).includes("no authorization digest to confirm"));
  const src = readFileSync(join(WEB, "src/components/integrated/FlowStepper.tsx"), "utf8");
  const listed = JSON.parse(src.match(/A6_STEP_UP_OPS: readonly FlowActionOp\[\] = (\[[^\]]*\])/)![1]);
  assert.deepEqual(listed, [...STEP_UP_OPS]);
  for (const v of FIX.views) {
    assert.ok(/^[0-9a-f]{64}$/.test(v.echo.proposal_digest));
    assert.equal(v.echo.gate_digest === null, v.gate === null, `${v.fixture.id}: gate echo exists iff a gate result exists`);
    assert.equal(v.echo.authorization_digest === null, v.authorization === null, `${v.fixture.id}: authorization echo exists iff an authorization exists`);
  }
});

test("A6-18 flow-v1.1 balance_display is shown with a mode-specific label and never as project cash", () => {
  const mock = text(r.stepper(V("awaiting-human")));
  assert.ok(mock.includes(`Fixed mock value: ${V("awaiting-human").balance_display} (not money)`));
  const sbx = text(r.stepper({ ...V("awaiting-human"), provider_mode: "sandbox", balance_display: "1234.56" }));
  assert.ok(sbx.includes("Sandbox USD available: 1234.56 (test funds)"));
  assert.ok(text(r.stepper(V("review-balance-unknown"))).includes("No balance reading was available to the gate."));
  assert.equal(V("review-balance-unknown").balance_display, null);
  for (const v of FIX.views) {
    const money = r.stepper(v).match(/<section id="ifs-money"[\s\S]*?<\/section>/)![0];
    const bal = money.indexOf("data-balance"), syn = money.indexOf("<h4>Synthetic obligation</h4>"), e3 = money.indexOf("<h4>E3 project figures</h4>");
    assert.ok(syn < bal && bal < e3, `${v.fixture.id}: balance sits in its own provider cell, between obligation and E3`);
  }
});
