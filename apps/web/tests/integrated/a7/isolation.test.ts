// flow-v1 boundary rules for apps/web/integrated/**. OWNER: A7.
//
// Why this exists: the reviewed tests AGT-07 (tests/agent/agent.test.ts) and SBX-14 (tests/sandbox/sandbox.test.ts)
// encode the 6063b1c boundaries "payment code never imports the gate or the agent" and "only src/server and
// src/app/sandbox import the sandbox integration". flow-v1 DELIBERATELY changes the first boundary: integrated payment
// code imports the deterministic, model-free 11-proof gate (agentPolicy.ts / agentRegistry.ts) so approval can be
// bound to it. Integrated code therefore lives in apps/web/integrated/, outside both reviewed scans, which stay
// byte-identical and passing. This file states the replacement boundary explicitly and more strictly; A8 must review it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ALLOWED, integratedSourceViolations, resolveSpec, SCANNED_EXT, specifierProblem, subprocessViolations, treeViolations, uiReachViolations } from "./rules.ts";

const WEB = join(import.meta.dirname, "..", "..", "..");
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const rel = (f: string) => relative(WEB, f).split("\\").join("/");
// A8-03: every module extension is scanned (.ts .tsx .mts .cts .js .jsx .mjs .cjs), not only .ts/.tsx.
const integrated = walk(join(WEB, "integrated")).filter((f) => SCANNED_EXT.test(f));
const read = (f: string) => readFileSync(f, "utf8");

const IMPORT = /import\s+(type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s+"([^"]+)"/g;

test("integrated imports of historic modules are limited to named, reviewed symbols", () => {
  assert.ok(integrated.length >= 3, "contract files present");
  for (const f of integrated) {
    const r = rel(f);
    for (const m of read(f).matchAll(IMPORT)) {
      const spec = m[6];
      if (!spec.startsWith(".")) {
        assert.ok(spec.startsWith("node:"), `${r}: only node: built-ins may be imported as packages (got ${spec})`);
        continue;
      }
      // Candidate 4 (N19): this regex layer joins the specifier as a plain path, so an encoded specifier fooled it.
      // It now refuses the spelling and judges the same real target as the syntax-tree layer (rules.ts resolveSpec).
      assert.equal(specifierProblem(r, spec), null, `${r}: relative specifier ${JSON.stringify(spec)}`);
      assert.equal(rel(join(f, "..", spec)), resolveSpec(r, spec), `${r}: path and runtime resolution of ${JSON.stringify(spec)} must agree`);
      const target = rel(join(f, "..", spec));
      if (target.startsWith("integrated/") || target.startsWith("fixtures/integrated/") || target === "fixtures/sandbox_proposal_v1.json") continue;
      const rule = ALLOWED[target];
      assert.ok(rule, `${r}: may not import ${target}`);
      if (rule.only) assert.ok(rule.only.includes(r), `${r}: only ${rule.only.join(", ")} may import ${target}`);
      if (rule.names !== "*") {
        assert.ok(!m[3] && !m[4], `${r}: namespace/default import of ${target} refused`);
        const names = `${m[2] ?? ""},${m[5] ?? ""}`.split(",").map((s) => s.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const n of names) assert.ok(rule.names.includes(n), `${r}: ${n} from ${target} is not an allowed symbol`);
      }
    }
    assert.doesNotMatch(read(f), /import\(|require\(/, `${r}: no dynamic import or require`);
    // flow-v1.1 R3: exactly one file may run a subprocess (rule + self-tests in rules.ts / security_coverage.test.ts).
    assert.deepEqual(subprocessViolations(r, read(f)), [], `${r}: subprocess confinement`);
  }
});

// A8-03. The regex rule above only sees double-quoted `import ... from "..."`. This layer reads the syntax tree, so it
// also judges single-quoted specifiers, `export ... from`, side-effect imports, spaced dynamic imports, require,
// createRequire, process.getBuiltinModule and process-wide state. Rules and self-tests: rules.ts,
// isolation_rules_selftest.test.ts. It is in addition to every check in this file; none was removed or relaxed.
test("A8-03: every module reference form in integrated/** obeys the boundary (syntax-tree scan)", () => {
  assert.ok(integrated.length >= 3, "contract files present");
  for (const f of integrated) assert.deepEqual(integratedSourceViolations(rel(f), read(f)), [], `${rel(f)}: integrated boundary`);
});

// A8-03 residual. Capabilities, not only import syntax: exact per-file built-in names, no eval/Function/fetch/vm/
// worker/inspector, provider environment names confined to named files, and the import graph between integrated
// files (a file holding a restricted import may not grow its exports, and only named files may consume them).
test("A8-03 residual: built-in, capability and import-graph rules hold for the whole integrated tree", () => {
  const files = Object.fromEntries(integrated.map((f) => [rel(f), read(f)]));
  assert.deepEqual(treeViolations(files), [], "integrated tree: capability graph and exact allowances");
});

test("model, transfer-credential, historic-chain and float rules", () => {
  for (const f of integrated) {
    const r = rel(f);
    const src = read(f);
    assert.doesNotMatch(src, /^\s*["']use client["']/m, `${r}: server only`);
    assert.doesNotMatch(src, /NEXT_PUBLIC_/, `${r}: no public env`);
    assert.doesNotMatch(src, /parseFloat|toFixed|Math\.round|Number\(.*amount/i, `${r}: no float money handling`);
    if (r !== "integrated/agentBridge.ts") assert.doesNotMatch(src, /runAgent\(|@anthropic-ai|anthropic|ollama/i, `${r}: only agentBridge.ts reaches a model`);
    if (r !== "integrated/paymentAdapter.ts") assert.doesNotMatch(src, /SandboxClient\("transfer"\)|transfers\/create|transfers\/validate/, `${r}: only paymentAdapter.ts holds the transfer role`);
    assert.doesNotMatch(src, /AWX_SUBMIT_RELEASE|runtimeCtx|AuditLog|AWX_SANDBOX_INTEGRATION_V1/, `${r}: never touches the historic DB-SBX-0001 chain or release`);
    if (r !== "integrated/flags.ts") assert.doesNotMatch(src, /DRAWBRIDGE_DATA_DIR/, `${r}: historic data dir is referenced only by flags.ts (to refuse overlap)`);
    assert.doesNotMatch(src, /api\.airwallex\.com|https?:\/\/(?!127\.0\.0\.1)/, `${r}: no hosts; sandbox host lives only in awx.ts`);
  }
  // agentBridge may build a model session but may not reach any payment write path
  const bridge = join(WEB, "integrated/agentBridge.ts");
  if (existsSync(bridge)) assert.doesNotMatch(read(bridge), /flowService|paymentAdapter|flowStore|stateMachine|transfers\.ts|SandboxClient\("transfer"\)/, "agentBridge cannot reach payments");
});

test("nothing reviewed imports integrated code; the model cannot see the flow", () => {
  for (const f of walk(join(WEB, "src")).filter((x) => SCANNED_EXT.test(x))) {
    const r = rel(f);
    const src = read(f);
    if (r.startsWith("src/server/")) assert.doesNotMatch(src, /integrated\//, `${r}: historic server code is unchanged and never imports integrated/`);
    if (r.startsWith("src/server/agent") || r === "src/server/aiConfig.ts" || r.startsWith("src/app/sandbox/agent/") || r === "src/app/agent/page.tsx") assert.doesNotMatch(src, /integrated/, `${r}: agent surfaces cannot reach the flow`);
    if (r.startsWith("src/components/integrated/")) assert.doesNotMatch(src, /from\s+"[^"]*integrated\/(flowService|flowStore|stateMachine|paymentAdapter|ledgerAdapter|gateBinding|auditChain)\.ts"/, `${r}: UI imports types only`);
    if (r.startsWith("src/components/integrated/")) assert.deepEqual(uiReachViolations(r, src), [], `${r}: UI imports types only (any quote style or import form)`);
  }
});
