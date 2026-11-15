// SIM-ENG-002-E2 — Incident Room Shell: six screens, navigation, numbering and the preserved five existing routes.
// Shell.tsx is a React server component in a .tsx file; it is transpiled with the project's TypeScript compiler into a
// temporary directory OUTSIDE the source tree, its imports are rewritten to absolute locations (the workspace's .ts
// modules and React, a one-line stand-in for next/link), and it is rendered with react-dom/server. No network, no
// backend, no repository write.
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

// The five screens that existed before E2, exactly as the baseline Shell defined them. E2 may only append to this list.
const BASELINE_SCREENS = [
  ["overview", 1, "Command", "Command"], // renamed from Overview / Treasury overview by the UI redesign (route unchanged)
  ["payables", 2, "Payables", "Obligations and exclusions"],
  ["incident", 3, "Incident", "Incident detail"],
  ["approvals", 4, "Approvals", "Approval queue"],
  ["recorder", 5, "Recorder", "Flight recorder"],
] as const;
const E2_SCREEN = ["eligibility", 6, "Eligibility", "Capital eligibility (synthetic)"] as const;
const ALL = [...BASELINE_SCREENS, E2_SCREEN];

type ShellModule = {
  Shell: (props: { scenario: string; active: string; requestedTotal: bigint; additionalNotRequestedTotal: bigint; children?: unknown }) => unknown;
  screenHref: (key: string, scenario: string) => string;
};
let shell: ShellModule;
let tmp = "";
let shellSource = "";

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
const render = (active: string, scenario: string) =>
  renderToStaticMarkup(
    createElement(shell.Shell as never, { scenario, active, requestedTotal: 123456n, additionalNotRequestedTotal: 7890n }, createElement("p", { id: "child-marker" }, "child")),
  );

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "e2-shell-"));
  const resolve = (spec: string) => fileURLToPath(import.meta.resolve(spec));
  const src = (rel: string) => pathToFileURL(join(webRoot, "src", rel)).href;
  writeFileSync(join(tmp, "link.mjs"), `import { createElement } from ${JSON.stringify(pathToFileURL(resolve("react")).href)};\nexport default function Link(p){ const { href, children, ...rest } = p; return createElement("a", { href, ...rest }, children); }\n`);
  shellSource = readFileSync(join(webRoot, "src/components/Shell.tsx"), "utf8");
  writeFileSync(
    join(tmp, "Shell.mjs"),
    rewrite(transpile(shellSource, "Shell.tsx"), {
      "react/jsx-runtime": pathToFileURL(resolve("react/jsx-runtime")).href,
      "next/link": pathToFileURL(join(tmp, "link.mjs")).href,
      "../data/adapter.ts": src("data/adapter.ts"),
      "../contract/money.ts": src("contract/money.ts"),
    }),
  );
  shell = (await import(pathToFileURL(join(tmp, "Shell.mjs")).href)) as ShellModule;
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const navLinks = (html: string) => {
  const nav = html.match(/<nav class="tabs" aria-label="Incident Room screens">([\s\S]*?)<\/nav>/);
  assert.ok(nav, "navigation rendered");
  return [...nav![1].matchAll(/<a href="([^"]+)"( aria-current="page")?><span class="n">(\d+)<\/span><span>([^<]+)<\/span><\/a>/g)].map((m) => ({
    href: m[1],
    current: m[2] !== undefined,
    n: Number(m[3]),
    label: m[4],
  }));
};

test("S-1 the Shell defines exactly six screens: the five baseline screens unchanged, plus Eligibility as number 6", () => {
  const defined = [...shellSource.matchAll(/\{ key: "([a-z]+)", n: (\d+), label: "([^"]+)", long: "([^"]+)" \}/g)].map((m) => [m[1], Number(m[2]), m[3], m[4]]);
  assert.deepEqual(defined, ALL.map((s) => [...s]));
  assert.match(shellSource, /export type ScreenKey = "overview" \| "payables" \| "incident" \| "approvals" \| "recorder" \| "eligibility";/);
  assert.doesNotMatch(shellSource, /of 5</, "screen total is no longer a literal");
  assert.match(shellSource, /screen \{current\.n\} of \{SCREENS\.length\}/);
});

test("S-2 screenHref is unchanged for every screen and scenario", () => {
  for (const [key] of ALL) for (const sc of ["S0", "S1"]) assert.equal(shell.screenHref(key, sc), `/${key}?s=${sc}`);
});

test("S-3 each of the six screens renders the full navigation, marks itself current, numbers itself n of 6 and shows its title", () => {
  for (const [key, n, label, long] of ALL) {
    const html = render(key, "S0");
    const links = navLinks(html);
    assert.deepEqual(
      links.map((l) => [l.href, l.n, l.label]),
      ALL.map(([k, num, lab]) => [`/${k}?s=S0`, num, lab]),
      `${key}: all six links in order`,
    );
    assert.deepEqual(links.filter((l) => l.current).map((l) => l.href), [`/${key}?s=S0`], `${key}: exactly one current link`);
    assert.ok(html.includes(`Incident Room · screen ${n} of 6`), `${key}: numbering`);
    assert.ok(html.includes(`<h1>${long}</h1>`), `${key}: title`);
    assert.ok(html.includes('<p id="child-marker">child</p>'), `${key}: children rendered inside main`);
    assert.equal((html.match(/<nav /g) ?? []).length, 1, `${key}: one navigation`);
    assert.ok(html.indexOf('class="skip-link"') < html.indexOf('class="synthetic-bar"'), `${key}: skip link precedes the synthetic bar`);
    assert.ok(html.includes("SYNTHETIC DEMONSTRATION DATA") && html.includes("Source: SYNTHETIC_FIXTURE"), `${key}: provenance text`);
    assert.doesNotMatch(html, /<button|<form/i, `${key}: no controls`);
  }
});

test("S-4 the scenario switch carries the active screen and marks the active scenario, for S0 and S1", () => {
  for (const [key] of ALL) {
    for (const sc of ["S0", "S1"]) {
      const html = render(key, sc);
      const sw = html.match(/<div class="scenario-switch"[^>]*>([\s\S]*?)<\/div>/);
      assert.ok(sw, `${key}/${sc}: scenario switch rendered`);
      const links = [...sw![1].matchAll(/<a href="([^"]+)"( aria-current="true")?/g)].map((m) => [m[1], m[2] !== undefined]);
      assert.deepEqual(links, [[`/${key}?s=S0`, sc === "S0"], [`/${key}?s=S1`, sc === "S1"]]);
      for (const l of navLinks(html)) assert.ok(l.href.endsWith(`?s=${sc}`), `${key}/${sc}: nav keeps the scenario`);
    }
  }
});

test("S-5 the five baseline routes render exactly the same navigation entries as before E2 (prefix of the six)", () => {
  const links = navLinks(render("overview", "S0"));
  assert.deepEqual(
    links.slice(0, 5).map((l) => [l.href, l.n, l.label]),
    BASELINE_SCREENS.map(([k, n, lab]) => [`/${k}?s=S0`, n, lab]),
  );
  assert.equal(links.length, 6);
});
