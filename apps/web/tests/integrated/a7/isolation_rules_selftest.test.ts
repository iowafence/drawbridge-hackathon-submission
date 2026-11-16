// Self-test for the A8-03 isolation scanner (rules.ts). OWNER: A7 paths; written by the SEC remediation lane.
//
// Each "BYPASS" test feeds the scanner one form that the reviewer (A8-03) showed passing the original rules with zero
// violations, and asserts it is now refused. Each "CONTROL" test is a form the original rules already refused and that
// must stay refused. Each "LEGIT" test is something the current tree does and must stay allowed.
//
// rules.ts is imported as a namespace on purpose: run against the original rules.ts (1e10588), which has no
// syntax-tree scanner, every test here fails on its own with "scanner missing" instead of the file failing to load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as rules from "./rules.ts";

const WEB = join(import.meta.dirname, "..", "..", "..");
type Scan = (rel: string, src: string) => string[];
const api = rules as unknown as Partial<Record<"integratedSourceViolations" | "boundaryViolations" | "authorityViolations" | "uiReachViolations", Scan>> & {
  treeViolations?: (files: Record<string, string>) => string[];
  resolveSpec?: (rel: string, spec: string) => string;
  specifierProblem?: (rel: string, spec: string) => string | null;
  KEYED_ACCESS?: Record<string, readonly string[]>;
  REFLECTION_NAMES?: Record<string, readonly string[]>;
  REFLECTION_REFUSED?: readonly string[];
  INTEGRATED_SOURCE_EXT?: RegExp;
  NODE_BUILTINS?: Record<string, Record<string, readonly string[]>>;
  CAPABILITY_SURFACE?: Record<string, Record<string, readonly string[]>>;
  PROCESS_MEMBERS?: Record<string, readonly string[]>;
  AWX_NAMES?: Record<string, readonly string[]>;
  REFUSED_IDENTIFIERS?: readonly string[];
  ALLOWED?: Record<string, { names: string[] | "*"; only?: string[] }>;
  SCANNED_EXT?: RegExp;
  GLOBAL_ALLOWANCE?: Record<string, { property: string; globalThisMentions: number }>;
};

function scan(rel: string, src: string): string[] {
  assert.equal(typeof api.integratedSourceViolations, "function", "scanner missing: these rules cannot see this form at all");
  return api.integratedSourceViolations!(rel, src);
}
/** Asserts the source is refused and that at least one violation matches `why`. */
function refused(rel: string, src: string, why: RegExp): void {
  const v = scan(rel, src);
  assert.ok(v.length > 0, `must be refused: ${rel}: ${src}`);
  assert.ok(v.some((x) => why.test(x)), `expected a violation matching ${why}, got ${JSON.stringify(v)}`);
}
const allowed = (rel: string, src: string) => assert.deepEqual(scan(rel, src), [], `${rel}: ${src}`);

const ANY = "integrated/anyFile.ts"; // a file with no special permission

// ---- BYPASS forms from the A8-03 corpus (each returned [] or was skipped under the original rules) --------------------

test("BYPASS v1: single-quoted import specifier and single-quoted transfer role", () => {
  refused(ANY, `import { SandboxClient } from '../src/server/awx.ts';\nexport const c = () => new SandboxClient('transfer');`, /only integrated\/paymentAdapter\.ts, integrated\/flowRuntime\.ts may import src\/server\/awx\.ts/);
  refused(ANY, `import { SandboxClient } from '../src/server/awx.ts';\nexport const c = () => new SandboxClient('transfer');`, /transfer role/);
  refused(ANY, "import { runAgent } from '../src/server/agent.ts';", /may import src\/server\/agent\.ts/);
  refused(ANY, "import { runtimeCtx } from '../src/server/runtime.ts';", /src\/server\/runtime\.ts/);
  refused(ANY, "import x from 'left-pad';", /only node: built-ins/);
  refused("integrated/flowRuntime.ts", "const c = new SandboxClient(`transfer`);", /transfer role|"read" role/);
});

test("BYPASS v2: export ... from and export * re-exports", () => {
  refused(ANY, `export { runAgent, SYSTEM } from "../src/server/agent.ts";`, /re-export of src\/server\/agent\.ts refused/);
  refused(ANY, `export { runAgent, SYSTEM } from "../src/server/agent.ts";`, /SYSTEM from src\/server\/agent\.ts is not an allowed symbol/);
  refused(ANY, `export * from "../src/server/transfers.ts";`, /export \* reference to src\/server\/transfers\.ts refused/);
  refused(ANY, `export * as awx from '../src/server/awx.ts';`, /src\/server\/awx\.ts/);
  refused(ANY, `export { submit } from "../src/server/transfers.ts";`, /submit from src\/server\/transfers\.ts is not an allowed symbol/);
  refused(ANY, `export { handleAction } from "../src/server/handler.ts";`, /may not import src\/server\/handler\.ts/);
});

test("BYPASS v3: side-effect import of a historic module", () => {
  refused(ANY, `import "../src/server/runtime.ts";`, /src\/server\/runtime\.ts/);
  refused("integrated/flowRuntime.ts", `import "../src/server/runtime.ts";`, /side-effect reference to src\/server\/runtime\.ts refused/);
  refused(ANY, `import '../src/server/transfers.ts';`, /side-effect reference to src\/server\/transfers\.ts refused/);
  refused(ANY, `import "../src/server/audit.ts";`, /may not import src\/server\/audit\.ts/);
});

test("BYPASS v3 / A8-03 text: globalThis and the __drawbridge process-wide state", () => {
  const v3 = `const g = globalThis as any;\nexport const t = () => g.__drawbridgeAwx?.["transfer"] ?? g.__drawbridgeAgent?.runs;`;
  refused(ANY, v3, /globalThis may not be used here/);
  refused(ANY, v3, /__drawbridgeAwx: process-wide DRAWBRIDGE state may not be named here/);
  refused(ANY, v3, /__drawbridgeAgent/);
  refused(ANY, `export const s = (globalThis as any)["__drawbridge" + "Auth"];`, /globalThis/);
  refused(ANY, `export const s = (global as any).x;`, /Node `global` object/);
  refused(ANY, `// reads __drawbridgeAuth\nexport const k = "__drawbridge" + "Awx";`, /__drawbridge/);
  // the one file with an allowance gets exactly its own property and exactly its current single use
  refused("integrated/flowRuntime.ts", `const g = globalThis as unknown as { __drawbridgeFlowRuntime?: 1 };\nexport const a = (g as any).__drawbridgeAwx;`, /__drawbridgeAwx/);
  refused("integrated/flowRuntime.ts", `const g = globalThis as unknown as { __drawbridgeFlowRuntime?: 1 };\nexport const h = globalThis;`, /globalThis used 2 times/);
  refused("integrated/flowRuntime.ts", `export const h = globalThis["x" + "y"];`, /computed access on globalThis/);
  refused(ANY, `const g = globalThis as unknown as { __drawbridgeFlowRuntime?: 1 };`, /globalThis may not be used here/);
});

test("BYPASS v4: createRequire", () => {
  const v4 = `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const rt = () => load("../src/server/agentRuntime.ts");`;
  refused(ANY, v4, /createRequire refused/);
  refused(ANY, v4, /node:module refused/);
  refused(ANY, `import * as m from 'node:module';\nexport const l = m["create" + "Require"](import.meta.url);`, /node:module refused/);
  refused(ANY, `import m from "module";`, /only node: built-ins/);
});

test("BYPASS v5/v5b: .js .mjs .cjs .jsx .mts .cts files are scanned, not skipped", () => {
  assert.ok(api.SCANNED_EXT instanceof RegExp, "scanner missing: the original filter is /\\.tsx?$/");
  for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) assert.ok(api.SCANNED_EXT!.test(`integrated/x.${ext}`), `.${ext} must be scanned`);
  for (const other of ["integrated/x.json", "integrated/x.md", "integrated/x.sql"]) assert.ok(!api.SCANNED_EXT!.test(other));
  refused("integrated/v5_plain.js", `import { runAgent } from "../src/server/agent.ts";\nexport { runAgent };`, /may import src\/server\/agent\.ts/);
  refused("integrated/v5b_module.mts", `import { SandboxClient } from "../src/server/awx.ts"; export const c = () => new SandboxClient("transfer");`, /src\/server\/awx\.ts/);
  refused("integrated/x.mjs", `import { runAgent } from '../src/server/agent.ts';`, /src\/server\/agent\.ts/);
  refused("integrated/x.cjs", `const a = require("../src/server/awx.ts");`, /require refused/);
  refused("integrated/x.cts", `import a = require("../src/server/awx.ts");`, /import-equals refused/);
  refused("integrated/x.jsx", `import { runAgent } from "../src/server/agent.ts";\nexport const X = () => <b>{String(runAgent)}</b>;`, /src\/server\/agent\.ts/);
  // the isolation test itself must walk with the widened filter
  const iso = readFileSync(join(WEB, "tests/integrated/a7/isolation.test.ts"), "utf8");
  assert.match(iso, /walk\(join\(WEB, "integrated"\)\)\.filter\(\(f\) => SCANNED_EXT\.test\(f\)\)/);
  assert.doesNotMatch(iso, /walk\(join\(WEB, "integrated"\)\)\.filter\(\(f\) => \/\\\.tsx\?\$\//);
});

test("BYPASS v6: dynamic import with any spacing; non-literal specifiers fail closed", () => {
  refused(ANY, `export const m = () => import ("../src/server/awx.ts");`, /dynamic-import refused \(literal specifier\)/);
  refused(ANY, `export const m = () => import\n(\n'../src/server/awx.ts'\n);`, /dynamic-import refused/);
  refused(ANY, `export const m = () => import(/* x */ "./flowTypes.ts");`, /dynamic-import refused/); // even inside the boundary
  refused(ANY, `const p = "../src/server/" + "awx.ts";\nexport const m = () => import(p);`, /dynamic-import refused \(non-literal specifier\)/);
  refused(ANY, "export const m = (n: string) => import(`../src/server/${n}.ts`);", /non-literal specifier/);
  refused(ANY, `export const m = (n: string) => require (n);`, /require refused \(non-literal specifier\)/);
  refused(ANY, `export const m = () => module.require("../src/server/awx.ts");`, /require refused/);
  refused(ANY, `export type T = typeof import ('../src/server/awx.ts');`, /import-type refused/);
});

test("BYPASS v7: built-in modules reached through process", () => {
  refused(ANY, `export const cp = () => (process as any).getBuiltinModule("node:child" + "_process");`, /getBuiltinModule refused/);
  refused(ANY, `export const cp = () => (process as any)["get" + "BuiltinModule"]("node:fs");`, /process may not be used in integrated\/anyFile\.ts/);
  refused(ANY, `export const cp = () => process["get" + "BuiltinModule"]("node:fs");`, /computed access on process/);
  refused(ANY, `const p = process;\nexport const cp = () => (p as any)["get" + "BuiltinModule"]("node:fs");`, /process may (only|not) be used/);
  refused(ANY, `const { getBuiltinModule: g } = process as any;\nexport const cp = () => g("node:fs");`, /getBuiltinModule refused/);
  refused(ANY, `export const m = () => process.mainModule;`, /process may (only|not) be used/);
  refused(ANY, `export const b = () => (process as any).binding("fs");`, /process may (only|not) be used/);
  refused(ANY, `export const b = () => process.binding("fs");`, /process\.binding/);
  refused(ANY, `export const f = () => new Function("return process")();`, /eval \/ Function constructor/);
  refused(ANY, `export const f = () => eval ("1");`, /eval \/ Function constructor/);
});

test("BYPASS (A8-03 text): transitive reach through a file that is allowed to import", () => {
  // paymentAdapter.ts may import awx.ts; it must not hand the client class on to every other integrated file
  const P = "integrated/paymentAdapter.ts";
  refused(P, `export { SandboxClient } from "../src/server/awx.ts";`, /re-export of src\/server\/awx\.ts refused/);
  refused(P, `import { SandboxClient } from "../src/server/awx.ts";\nexport { SandboxClient };`, /export list re-exports SandboxClient/);
  refused(P, `import { SandboxClient as C } from '../src/server/awx.ts';\nexport { C as Client };`, /export list re-exports C/);
  refused(P, `import { SandboxClient } from "../src/server/awx.ts";\nexport default SandboxClient;`, /default export re-exports SandboxClient/);
  refused(P, `import { SandboxClient } from "../src/server/awx.ts";\nexport const Client = SandboxClient as unknown;`, /exported constant re-exports SandboxClient/);
  refused("integrated/flowRuntime.ts", `import { liveBalances } from "../src/server/runtime.ts";\nexport { liveBalances };`, /re-exports liveBalances/);
  // path spellings that name the same file
  refused(ANY, `import { SandboxClient } from "./../integrated/../src/server/awx.ts";`, /may import src\/server\/awx\.ts/);
  refused(ANY, `import { SandboxClient } from "./../integrated/../src/server/awx.ts";`, /not in canonical form/);
  refused(ANY, `import { SandboxClient } from "../src/server/awx";`, /may not import src\/server\/awx$/);
  refused(ANY, `import { SandboxClient } from "../src/server/awx.js";`, /may not import src\/server\/awx\.js/);
  refused(ANY, `import { x } from "../../../etc/passwd";`, /may not import/);
});

test("a file the parser cannot read cleanly is a violation, never a skip", () => {
  refused(ANY, `import { from "./flowTypes.ts";`, /unparseable source/);
  refused("integrated/x.js", `export const a = ;`, /unparseable source/);
  refused("integrated/x.mjs", `import { runAgent } from "../src/server/agent.ts" export`, /unparseable source/);
  refused(ANY, "export const a = `unterminated", /unparseable source/);
});

// ---- CONTROLS: refused by the original rules, must stay refused ------------------------------------------------------

test("CONTROL v0/v8/v9: forms the original rules already refused are still refused", () => {
  refused(ANY, `import { SandboxClient } from "../src/server/awx.ts";\nexport const c = () => new SandboxClient("transfer");`, /may import src\/server\/awx\.ts/);
  refused("integrated/v8_transfer_via_var.ts", `import { SandboxClient } from "../src/server/awx.ts";\nconst role = "transfer" as const;\nexport const c = () => new SandboxClient(role);`, /may import src\/server\/awx\.ts/);
  refused("integrated/v9_allowed_runtime_reach.ts", `import { getRun } from "../src/server/agentRuntime.ts";\nexport const r = getRun;`, /may import src\/server\/agentRuntime\.ts/);
  refused(ANY, `import * as p from "../src/server/policy.ts";`, /namespace\/default reference to src\/server\/policy\.ts refused/);
  refused(ANY, `import { evaluate } from "../src/server/policy.ts";`, /evaluate from src\/server\/policy\.ts is not an allowed symbol/);
  refused(ANY, `import x from "lodash";`, /only node: built-ins/);
  refused(ANY, `const x = await import("./flowTypes.ts");`, /dynamic-import refused/);
  // the role-through-a-variable form is also refused inside a file that MAY import awx.ts
  refused("integrated/flowRuntime.ts", `import { SandboxClient } from "../src/server/awx.ts";\nconst role = "transfer" as const;\nexport const c = () => new SandboxClient(role);`, /"read" role/);
});

test("CONTROL: the ALLOWED table is the reviewed 1e10588 table, entry for entry", () => {
  assert.ok(api.ALLOWED, "scanner missing: ALLOWED is not exported by these rules");
  const canon = JSON.stringify(Object.keys(api.ALLOWED!).sort().map((k) => [k, api.ALLOWED![k].names, api.ALLOWED![k].only ?? null]));
  // Any change to a permission changes this digest. Loosening needs a reviewed contract change, not an edit here.
  assert.equal(createHash("sha256").update(canon).digest("hex"), ALLOWED_DIGEST_1E10588);
  assert.deepEqual(api.GLOBAL_ALLOWANCE, { "integrated/flowRuntime.ts": { property: "__drawbridgeFlowRuntime", globalThisMentions: 1 } });
});
const ALLOWED_DIGEST_1E10588 = "822cdd40914704204da9a717a6c0f825cce6451648f553b7212653b5a8aba4e0";

// ---- LEGIT: what the tree does today must stay allowed ---------------------------------------------------------------

test("LEGIT: every current file under integrated/ has zero violations", () => {
  assert.ok(api.SCANNED_EXT instanceof RegExp, "scanner missing");
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
  const files = walk(join(WEB, "integrated")).filter((f) => api.SCANNED_EXT!.test(f));
  assert.ok(files.length >= 3);
  for (const f of files) allowed(relative(WEB, f).split("\\").join("/"), readFileSync(f, "utf8"));
});

test("LEGIT: every ALLOWED entry still admits its named symbols from its permitted files, in either quote style", () => {
  assert.ok(api.ALLOWED && api.boundaryViolations, "scanner missing");
  // The ALLOWED table is the import-boundary layer; capability pinning of the importing file is tested separately.
  const ok = (file: string, src: string) => assert.deepEqual(api.boundaryViolations!(file, src), [], `${file}: ${src}`);
  for (const [target, rule] of Object.entries(api.ALLOWED!)) {
    const spec = `../${target}`;
    for (const file of rule.only ?? [ANY]) {
      if (rule.names === "*") {
        ok(file, `import * as ns from "${spec}";\nimport { anything } from '${spec}';\nexport const use = [ns, anything].length;`);
        continue;
      }
      ok(file, `import { ${rule.names.join(", ")} } from "${spec}";\nexport const use = 1;`);
      ok(file, `import type { ${rule.names[0]} } from '${spec}';\nimport { ${rule.names.at(-1)} as alias } from '${spec}';\nexport const use = 1;`);
    }
  }
});

test("LEGIT: ordinary integrated code is unaffected", () => {
  allowed("integrated/flowRuntime.ts", `import { randomUUID } from "node:crypto";\nimport { join } from 'node:path';\nimport type { FlowState } from "./flowTypes.ts";\nimport fixture from "../fixtures/integrated/flow_bindings_v1.json" with { type: "json" };\nimport { flowDigest } from "./flowCanonical.ts";\nvoid flowDigest;\nconst x = [randomUUID, join, fixture].length as number satisfies number;\nvoid x;`);
  allowed("integrated/flags.ts", `export const env = process.env; export const here = process.cwd();`);
  allowed("integrated/auditExport.ts", `export const tmp = "x." + String(process.pid); export const last = (out: string[]) => out[out.length - 1] ?? out[1];`);
  allowed(ANY, `export const o = { global: 1, process: 2 };\nexport const y = o.global + o.process; // "global" as a property name is not the Node global`);
  allowed("integrated/flowRuntime.ts", `const g = globalThis as unknown as { __drawbridgeFlowRuntime?: { key: string } };\nconst k = () => g.__drawbridgeFlowRuntime?.key;\nexport const resetFlowRuntimeForTests = () => { g.__drawbridgeFlowRuntime = undefined; void k; };`);
  allowed("integrated/flowRuntime.ts", `import { SandboxClient, readBalances } from "../src/server/awx.ts";\nexport const flowPageSurface = () => readBalances(new SandboxClient("read"));`);
  allowed("integrated/paymentAdapter.ts", `import { AwxError, SandboxClient } from "../src/server/awx.ts";\nexport function sandboxProvider(opts: { client?: () => SandboxClient } = {}) { return opts.client ? opts.client() : new SandboxClient("transfer"); }\nconst isAwx = (e: unknown) => e instanceof AwxError;\nvoid isAwx;`);
});

test("UI components: service modules are refused in any import form; types stay allowed", () => {
  assert.equal(typeof api.uiReachViolations, "function", "scanner missing: the original UI rule only sees double-quoted from clauses");
  const ui = api.uiReachViolations!;
  const C = "src/components/integrated/FlowStepper.tsx";
  assert.notDeepEqual(ui(C, `import { createFlowService } from '../../../integrated/flowService.ts';`), []);
  assert.notDeepEqual(ui(C, `export { auditPort } from "../../../integrated/auditChain.ts";`), []);
  assert.notDeepEqual(ui(C, `import '../../../integrated/flowStore.ts';`), []);
  assert.notDeepEqual(ui(C, `const m = () => import ("../../../integrated/paymentAdapter.ts");`), []);
  assert.notDeepEqual(ui(C, `import { x } from "../../../integrated/gateBinding";`), []);
  assert.notDeepEqual(ui(C, `const m = (p: string) => import(p);`), []);
  assert.deepEqual(ui(C, `import type { FlowView } from "../../../integrated/flowTypes.ts";\nimport { useId } from 'react';\nexport const X = () => <b>{useId()}</b>;`), []);
});

// =====================================================================================================================
// A8-03 RESIDUAL (candidate 2 review). Each "RESIDUAL" test is a form the reviewer showed passing the candidate-2
// scanner with zero violations (scratch/a8/c2/attacks/scanner_probe.ts). Sources are the reviewer's, unedited.
// Against the 0121ba8 rules these tests fail on the assertion itself: the scanner exists there and returns [].
// =====================================================================================================================

const X = "integrated/x.ts";

test("RESIDUAL 1: aliased indirect eval reaching the process-wide caches", () => {
  refused(X, `const e = eval; const k = "__drawb" + "ridgeAwx"; export const leak = () => (e("global" + "This") as any)[k];`, /eval: identifier refused/);
  refused(X, `export const run = (s: string) => (0, eval)(s);`, /eval: identifier refused/);
  refused(X, `const { eval: e } = { eval }; export const r = e;`, /eval: identifier refused/);
});

test("RESIDUAL 2, 3, 6: node:vm, node:worker_threads and node:inspector (built-ins are an exact allowlist)", () => {
  refused(X, `import { runInThisContext } from "node:vm"; export const leak = () => runInThisContext("global" + "This");`, /node:vm is not an allowed built-in for integrated\/x\.ts/);
  refused(X, `import { Worker } from "node:worker_threads"; export const w = () => new Worker(new URL("../src/server/" + "awx.ts", import.meta.url));`, /node:worker_threads is not an allowed built-in/);
  refused(X, `import { Worker } from "node:worker_threads"; export const w = () => new Worker(new URL("../src/server/" + "awx.ts", import.meta.url));`, /import\.meta refused/);
  refused(X, `import { Session } from "node:inspector"; export const s = new Session();`, /node:inspector is not an allowed built-in/);
  for (const mod of ["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram", "node:dns", "node:child_process", "node:cluster", "node:repl", "node:v8", "node:wasi", "node:os", "node:process", "node:fs/promises"]) {
    refused("integrated/paymentAdapter.ts", `import { x } from "${mod}";`, /is not an allowed built-in for integrated\/paymentAdapter\.ts|child_process/);
  }
  // a file with an fs allowance gets exactly its inventoried names, by name
  refused("integrated/flowStore.ts", `import { readFileSync } from "node:fs";`, /readFileSync from node:fs is not an allowed built-in name for integrated\/flowStore\.ts/);
  refused("integrated/flowStore.ts", `import * as fs from "node:fs";`, /namespace\/default reference to node:fs refused/);
  refused("integrated/flowStore.ts", `import fs from 'node:fs';`, /namespace\/default reference to node:fs refused/);
  refused("integrated/flowStore.ts", `export { mkdirSync } from "node:fs";`, /re-export of node:fs refused/);
  refused("integrated/flowStore.ts", `import "node:sqlite";`, /side-effect reference to node:sqlite refused/);
  refused("integrated/flowStore.ts", `import { DatabaseSync } from "node:sqlite"; export const d = (db: DatabaseSync) => (db as any).loadExtension("/tmp/x.so");`, /SQLite extension loading refused/);
  refused("integrated/flowCanonical.ts", `import { randomBytes } from "node:crypto";`, /randomBytes from node:crypto is not an allowed built-in name/);
  allowed("integrated/flowStore.ts", `import { chmodSync, existsSync, mkdirSync } from "node:fs";\nimport { DatabaseSync } from 'node:sqlite';\nexport const u = [chmodSync, existsSync, mkdirSync, DatabaseSync].length;`);
  allowed("integrated/auditChain.ts", `export { flowDigest } from "./flowCanonical.ts";\nexport * from './flowTypes.ts';`); // re-exports inside the boundary, between non-holders
});

test("RESIDUAL 4: reading the transfer credential and calling the provider directly (fs + env + fetch)", () => {
  const probe = `import { readFileSync } from "node:fs"; const f = process.env["AWX_TRANSFER" + "_ENV_FILE"]; export async function pay(body: unknown) { const cred = readFileSync(String(f), "utf8"); return fetch("ht" + "tps://api-demo.airwallex" + ".com/api/v1/transfers/cre" + "ate", { method: "POST", headers: { authorization: cred }, body: JSON.stringify(body) }); }`;
  refused(X, probe, /node:fs is not an allowed built-in for integrated\/x\.ts/);
  refused(X, probe, /fetch: identifier refused/);
  refused(X, probe, /AWX_TRANSFER: provider environment or credential name may not appear/);
  refused(X, probe, /process may not be used in integrated\/x\.ts/);
  refused(X, probe, /property key assembled at run time refused/);
  // each leg is refused on its own, including inside the files that hold fs or process.env
  refused("integrated/paymentAdapter.ts", `export const call = (u: string) => fetch(u);`, /fetch: identifier refused/);
  refused("integrated/paymentAdapter.ts", `const f = fetch; export const call = (u: string) => f(u);`, /fetch: identifier refused/);
  refused("integrated/paymentAdapter.ts", `export const cred = process.env.AWX_TRANSFER_ENV_FILE;`, /AWX_TRANSFER_ENV_FILE: provider environment or credential name may not appear in integrated\/paymentAdapter\.ts/);
  refused("integrated/paymentAdapter.ts", `export const cred = process.env.HOME;`, /process may only be used as process\.pid in integrated\/paymentAdapter\.ts/);
  refused("integrated/flowRuntime.ts", `export const cred = process.env.AWX_TRANSFER_ENV_FILE;`, /AWX_TRANSFER_ENV_FILE/);
  refused("integrated/flowRuntime.ts", `export const cred = process.env["AWX_TRANSFER" + "_ENV_FILE"];`, /property key assembled at run time refused/);
  refused("integrated/flowRuntime.ts", "export const cred = (k: string) => process.env[`AWX_${k}`];", /property key assembled at run time refused|AWX_/);
  refused("integrated/flowService.ts", `export const e = process.env;`, /process may not be used in integrated\/flowService\.ts/);
  refused(X, `export const s = new WebSocket("ws://127.0.0.1");`, /WebSocket: identifier refused/);
  refused(X, `export const s = new XMLHttpRequest();`, /XMLHttpRequest: identifier refused/);
  refused(X, `export const w = WebAssembly.instantiate;`, /WebAssembly: identifier refused/);
  // the names each file legitimately mentions stay allowed there, and only there
  allowed("integrated/flags.ts", `export const set = (env: Record<string, string | undefined>) => !!env.AWX_TRANSFER_ENV_FILE;`);
  allowed("integrated/flowRuntime.ts", `const list = (env: Record<string, string | undefined>) => env.AWX_ALLOWED_BENEFICIARIES ?? "";\nvoid list;`);
  refused("integrated/flags.ts", `export const list = (env: Record<string, string | undefined>) => env.AWX_ALLOWED_BENEFICIARIES;`, /AWX_ALLOWED_BENEFICIARIES/);
});

test("RESIDUAL 5: the Function constructor without the identifier Function", () => {
  refused(X, `export const F = (() => {}).constructor; export const leak = () => F("return global" + "This")();`, /\.constructor access refused/);
  refused(X, `export const F = (() => {})["constructor"];`, /\.constructor access refused/);
  refused(X, `export const F = (() => {})["con" + "structor"];`, /property key assembled at run time refused/);
  refused(X, "export const F = (k: string) => (() => {})[`${k}structor` as never];", /property key assembled at run time refused/);
  refused(X, `export const F = (() => {})[["con", "structor"].join("") as never];`, /property key assembled at run time refused/);
  refused(X, `export const F = Reflect.get(() => {}, "constructor");`, /Reflect: identifier refused/);
  refused(X, `export const F = Object.getPrototypeOf(async () => {}).constructor;`, /\.constructor access refused/);
  refused(X, `const G = Function; export const f = new G("return 1");`, /Function: identifier refused/);
  allowed(X, `export class C { constructor(readonly n: number) {} }\nexport const c = new C(1).n;`); // declaring a constructor is not accessing one
});

test("RESIDUAL (probe extras): import.meta module URLs and reading historic sources from disk", () => {
  refused(X, `import { readFileSync } from "node:fs"; export const s = readFileSync(new URL("../src/server/awx.ts", import.meta.url), "utf8");`, /node:fs is not an allowed built-in/);
  refused("integrated/paymentAdapter.ts", `import { readFileSync } from "node:fs"; export const s = readFileSync(new URL("../src/server/awx.ts", import.meta.url), "utf8");`, /import\.meta refused/);
  refused(X, `export const u = import.meta.resolve("../src/server/awx.ts");`, /import\.meta refused/);
  refused(X, `export const d = import.meta.dirname;`, /import\.meta refused/);
  refused(X, `export const m = "node:mod" + "ule";`, /node: specifier outside a static import refused/);
  refused(X, "export const m = (n: string) => `node:${n}`;", /node: specifier outside a static import refused/);
});

// ---- the import graph (rules over the whole tree) --------------------------------------------------------------------

function realTree(): Record<string, string> {
  assert.ok(api.SCANNED_EXT instanceof RegExp, "scanner missing");
  const dir = join(WEB, "integrated");
  return Object.fromEntries(readdirSync(dir).filter((f) => api.SCANNED_EXT!.test(f)).map((f) => [`integrated/${f}`, readFileSync(join(dir, f), "utf8")]));
}
/** The real tree with some files replaced, appended to (`+`) or added; returns the graph violations. */
function graph(change: Record<string, string>): string[] {
  assert.equal(typeof api.treeViolations, "function", "graph rules missing: the 0121ba8 scanner judges one file at a time");
  const files = realTree();
  for (const [rel, src] of Object.entries(change)) files[rel] = src.startsWith("+") ? `${files[rel]}\n${src.slice(1)}` : src;
  return api.treeViolations!(files);
}
const graphRefused = (change: Record<string, string>, why: RegExp) => {
  const v = graph(change);
  assert.ok(v.some((x) => why.test(x)), `expected a graph violation matching ${why}, got ${JSON.stringify(v)}`);
};

test("RESIDUAL 7: wrapper re-exports of a file-restricted import cannot leave the file that holds it", () => {
  assert.deepEqual(graph({}), [], "the merged tree is clean");
  const R = "integrated/flowRuntime.ts";
  // the reviewer's three forms, appended to the real flowRuntime.ts (which already imports getRun)
  graphRefused({ [R]: `+export const runs = { getRun };` }, /flowRuntime\.ts: export runs is not pinned/);
  graphRefused({ [R]: `+export function lookup(id: string) { return getRun(id); }` }, /flowRuntime\.ts: export lookup is not pinned/);
  graphRefused({ [R]: `+export const g = getRun.bind(null);` }, /flowRuntime\.ts: export g is not pinned/);
  graphRefused({ [R]: `+export default getRun;` }, /export default is not pinned/);
  graphRefused({ [R]: `+export * from "./paymentAdapter.ts";` }, /re-export of capability holder integrated\/paymentAdapter\.ts refused/);
  graphRefused({ [R]: `+const leak = { getRun }; export { leak as innocuous };` }, /export innocuous is not pinned/);
  graphRefused({ [R]: `+export const { a, b: [c] } = { a: getRun, b: [liveBalances] };` }, /export c is not pinned/);
  // the same forms are refused when one file is judged on its own (the reviewer's probe calls the per-file function)
  refused(R, `import { getRun } from "../src/server/agentRuntime.ts"; export const runs = { getRun }; export function lookup(id: string) { return getRun(id); }`, /export runs is not pinned/);
  refused(R, `import { getRun } from "../src/server/agentRuntime.ts"; export const g = getRun.bind(null);`, /export g is not pinned/);
  refused("integrated/other.ts", `import { lookup } from "./flowRuntime.ts"; export const x = lookup("r");`, /lookup is not a pinned export of integrated\/flowRuntime\.ts/);
  refused("integrated/other.ts", `import { sandboxProvider } from "./paymentAdapter.ts"; export const p = sandboxProvider();`, /may not import sandboxProvider from capability holder/);
  // ...then consumed from another integrated file
  graphRefused({ "integrated/other.ts": `import { lookup } from "./flowRuntime.ts"; export const x = lookup("r");` }, /other\.ts: lookup is not a pinned export of integrated\/flowRuntime\.ts/);
  graphRefused({ "integrated/other.ts": `import { sandboxProvider } from "./paymentAdapter.ts"; export const p = sandboxProvider();` }, /other\.ts: may not import sandboxProvider from capability holder integrated\/paymentAdapter\.ts/);
  graphRefused({ "integrated/other.ts": `import { sandboxProvider } from "./paymentAdapter.ts"; export const p = sandboxProvider();` }, /other\.ts: reaches a file-restricted capability but has no pinned export surface/);
  graphRefused({ "integrated/other.ts": `import * as pa from './paymentAdapter.ts'; export const p = pa;` }, /namespace, default or side-effect reference to capability holder/);
  graphRefused({ "integrated/other.ts": `export { flowRuntime } from "./flowRuntime.ts";` }, /re-export of capability holder integrated\/flowRuntime\.ts refused/);
  // an existing, listed consumer may not widen what it takes
  graphRefused({ "integrated/flowService.ts": `+import { sandboxProvider } from "./paymentAdapter.ts";` }, /flowService\.ts: may not import sandboxProvider from capability holder/);
  graphRefused({ "integrated/auditChain.ts": `+import { createFlowService } from "./flowService.ts";` }, /auditChain\.ts: may not import createFlowService/);
  // a new file that takes a restricted historic import is a holder with no pinned surface, even if ALLOWED lists it
  graphRefused({ "integrated/gateBinding.ts": `+import { groundFacts } from "../src/server/agent.ts";\nexport const gf = groundFacts;` }, /gateBinding\.ts: reaches a file-restricted capability but has no pinned export surface/);
  // removing a pinned export is reported too: the table must describe the tree exactly
  graphRefused({ "integrated/flowHandler.ts": `export const unrelated = 1;` }, /flowHandler\.ts: pinned export handleFlowAction is missing/);
});

test("RESIDUAL: allowances are exact, so an unused or misplaced one is a violation", () => {
  assert.ok(api.NODE_BUILTINS && api.CAPABILITY_SURFACE && api.PROCESS_MEMBERS && api.AWX_NAMES && api.REFUSED_IDENTIFIERS, "tables missing: the 0121ba8 rule allows every node: built-in");
  // every allowance is exercised by the merged tree (graph({}) is clean above), and dropping a use makes it stale
  graphRefused({ "integrated/flowCanonical.ts": `export const nothing = 1;` }, /flowCanonical\.ts: built-in allowance node:crypto createHash is unused/);
  const without = realTree();
  delete without["integrated/auditExport.ts"];
  assert.ok(api.treeViolations!(without).some((v) => /auditExport\.ts: NODE_BUILTINS entry for a file that is not in the tree/.test(v)));
  assert.ok(api.treeViolations!(without).some((v) => /auditExport\.ts: PROCESS_MEMBERS entry for a file that is not in the tree/.test(v)));
  // child_process is granted to nobody, and no built-in that executes code, loads modules or opens a socket is listed
  const granted = new Set(Object.values(api.NODE_BUILTINS!).flatMap((m) => Object.keys(m)));
  assert.deepEqual([...granted].sort(), ["node:crypto", "node:fs", "node:path", "node:sqlite"]);
  for (const f of Object.keys(api.NODE_BUILTINS!)) assert.ok(!Object.hasOwn(api.NODE_BUILTINS![f], "node:child_process"), `${f}: child_process`);
  // only flags.ts may name the transfer credential variable; only three files may take process.env
  assert.deepEqual(Object.entries(api.AWX_NAMES!).filter(([, v]) => v.includes("AWX_TRANSFER_ENV_FILE")).map(([k]) => k), ["integrated/flags.ts"]);
  assert.deepEqual(Object.entries(api.PROCESS_MEMBERS!).filter(([, v]) => v.includes("env")).map(([k]) => k).sort(), ["integrated/flags.ts", "integrated/flowHandler.ts", "integrated/flowRuntime.ts"]);
  for (const id of ["eval", "Function", "fetch", "WebAssembly"]) assert.ok(api.REFUSED_IDENTIFIERS!.includes(id), id);
});

// =====================================================================================================================
// CANDIDATE 4 (review of 76367b0). N19, N12 and N18 are the owner's required fixes. Each test below uses the
// reviewer's source unedited (~/.cache/a8/c3agent/scanner_probe_c3.ts) or A7's round-3 probe forms, and each is
// MISSED by the 76367b0 rules: there the scanner returns no violation, so the assertion itself fails.
// =====================================================================================================================

test("N19: percent-encoded specifier resolved to its real runtime target (A8 forms a, b, c)", () => {
  refused(X, `import { SandboxClient as S } from "./%2e%2e/src/server/awx.ts"; export const c = () => new S("transfer");`, /only integrated\/paymentAdapter\.ts, integrated\/flowRuntime\.ts may import src\/server\/awx\.ts/);
  refused(X, `import { SandboxClient as S } from "./%2e%2e/src/server/awx.ts"; export const c = () => new S("transfer");`, /percent-encoding, backslash, query or fragment/);
  refused(X, `import { getRun } from "./%2e%2e/src/server/agentRuntime.ts"; export const g = getRun;`, /may import src\/server\/agentRuntime\.ts/);
  refused(X, `import * as T from "./%2E%2E/src/server/transfers.ts"; export const t = T;`, /namespace\/default reference to src\/server\/transfers\.ts refused/);
  // the resolver itself: the judged path is the one Node loads
  assert.equal(typeof api.resolveSpec, "function", "resolver missing");
  assert.equal(api.resolveSpec!("integrated/x.ts", "./%2e%2e/src/server/awx.ts"), "src/server/awx.ts");
  assert.equal(api.resolveSpec!("integrated/x.ts", "./%2E%2E/src/server/awx.ts"), "src/server/awx.ts");
  assert.equal(api.resolveSpec!("integrated/x.ts", "./.%2e/src/server/awx.ts"), "src/server/awx.ts");
  assert.equal(api.resolveSpec!("integrated/x.ts", "./flowCanonical.ts"), "integrated/flowCanonical.ts");
  assert.equal(api.resolveSpec!("integrated/x.ts", "../src/server/policy.ts"), "src/server/policy.ts");
  assert.ok(api.resolveSpec!("integrated/x.ts", "../../../etc/passwd").startsWith("../"), "a target outside apps/web is not mistaken for one inside");
});

test("N19 class (A7 round 3): every spelling that reaches outside integrated/ is refused, loadable or not", () => {
  for (const spec of [
    "./%2e%2e/src/server/transfers.ts", "./%2E%2E/src/server/transfers.ts", "./.%2e/src/server/transfers.ts", "./%2e./src/server/transfers.ts",
    "./x/../../src/server/transfers.ts", // plain dot segments through a directory that does not exist
    "..%2fsrc/server/transfers.ts", "./..%2Fsrc/server/transfers.ts", ".\\..\\src\\server\\transfers.ts", "./..\\src/server/transfers.ts",
    "./%74ransfers/../../src/server/transfers.ts", "../src/server/transfers.ts?x=1", "../src/server/transfers.ts#frag", ".//../src/server/transfers.ts",
    "./flowTypes.ts/../../src/server/transfers.ts", "../integrated/../src/server/transfers.ts", "./../src/server/transfers.ts",
  ]) {
    for (const stmt of [`import { MAX_SUBMISSIONS } from ${JSON.stringify(spec)};`, `export { MAX_SUBMISSIONS } from ${JSON.stringify(spec)};`, `import ${JSON.stringify(spec)};`, `import * as T from ${JSON.stringify(spec)};`]) {
      refused(X, stmt, /percent-encoding, backslash, query or fragment|not in canonical form|only node: built-ins/);
    }
    assert.notEqual(api.specifierProblem!(X, spec), null, spec);
  }
  // other ways to name a file: all were already refused and stay refused
  for (const spec of ["file:///etc/passwd", "/abs/src/server/transfers.ts", "data:text/javascript,export default 1", "src/server/transfers.ts", "~/x.ts", "@/server/transfers.ts"]) {
    refused(X, `import x from ${JSON.stringify(spec)};`, /only node: built-ins may be imported as packages/);
  }
  // controls: ordinary spellings are untouched
  for (const [file, spec] of [[X, "./flowCanonical.ts"], [X, "./flowTypes.ts"], [X, "../src/server/policy.ts"], [X, "../src/server/agentPolicy.ts"], ["integrated/proposalBuilder.ts", "../fixtures/integrated/flow_bindings_v1.json"]] as const) {
    assert.equal(api.specifierProblem!(file, spec), null, spec);
  }
  allowed(X, `import { flowDigest } from "./flowCanonical.ts";\nimport type { FlowState } from './flowTypes.ts';\nimport { toMinor } from "../src/server/policy.ts";\nvoid [flowDigest, toMinor];`);
});

test("N24 (not in the required list): only .json may be imported from the fixtures directories, only TypeScript from integrated/", () => {
  refused(X, `import { x } from "../fixtures/integrated/evil.ts"; export const y = x;`, /fixtures\/integrated\/evil\.ts is not a permitted module type inside the boundary/);
  refused(X, `import x from "./helper.cjs";`, /integrated\/helper\.cjs is not a permitted module type/);
  refused(X, `import x from "./native.node";`, /is not a permitted module type/);
});

test("N12a: Function constructor through a VARIABLE key (A8 form N12)", () => {
  refused(X, `const k = "con" + "structor"; const F = (() => {})[k]; export const leak = () => F("return pro" + "cess")();`, /\(\(\) => \{\}\)\[k\]: element access with a non-literal key is not listed for integrated\/x\.ts/);
  refused(X, `const k = "constr" + "uctor"; export const F = (function () {})[k as never];`, /element access with a non-literal key is not listed/);
  refused(X, `const k = ["con", "structor"].join(""); const o = {}; export const F = (o as any)[k][k];`, /element access with a non-literal key is not listed/);
  // a listed access is listed for one file and one exact expression
  refused("integrated/flags.ts", `export const f = (env: any, k: string, j: string) => env[k] + env[j];`, /env\[j\]: element access with a non-literal key is not listed for integrated\/flags\.ts/);
  refused("integrated/flowService.ts", `export const f = (env: any, k: string) => env[k];`, /env\[k\]: element access with a non-literal key is not listed for integrated\/flowService\.ts/);
  allowed("integrated/flags.ts", `const f = (env: Record<string, string | undefined>, k: string) => env[k];\nvoid f;`);
});

test("N12b: Function constructor through DESTRUCTURING (A8 form N12b)", () => {
  refused(X, `const { constructor: F } = () => {}; export const leak = () => (F as any)("return pro" + "cess")();`, /constructor: reflection name refused/);
  refused(X, `const { constructor } = () => {}; export const F = constructor;`, /constructor: reflection name refused/);
  refused(X, `const { "constructor": F } = () => {}; export const G = F;`, /"constructor": reflection name refused/);
  refused(X, `const k = "con" + "structor"; const { [k]: F } = (() => {}) as any; export const G = F;`, /computed property name with a non-literal key refused/);
  refused(X, `export const f = ({ constructor: F }: any) => F;`, /constructor: reflection name refused/);
  refused(X, `export const o = { constructor: 1 };`, /constructor: reflection name refused/);
});

test("N12c: Function constructor through a property descriptor (A8 form N12c)", () => {
  refused(X, `const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), "constructor")!.value; export const leak = () => F("return fe" + "tch")("ht" + "tps://example.invalid");`, /getOwnPropertyDescriptor: reflection name refused/);
  refused(X, `const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), "constructor")!.value; export const G = F;`, /"constructor": reflection name refused/);
  refused(X, `const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), "constructor")!.value; export const G = F;`, /getPrototypeOf: reflection name refused/);
  refused(X, `export const n = Object.getOwnPropertyNames(() => {});`, /getOwnPropertyNames: reflection name refused/);
  refused(X, `export const p = (() => {}).__proto__;`, /__proto__: reflection name refused/);
  refused(X, `export const p = Function.prototype;`, /prototype: reflection name refused/);
  refused("integrated/auditChain.ts", `export const d = Object.getOwnPropertyDescriptors({});`, /getOwnPropertyDescriptors: reflection name refused/);
  // the reviewer's full chain with no computed key inside brackets (N12e)
  refused(X, `const { constructor: F } = () => {}; const p = (F as any)("return pro" + "cess")(); const gb = "getBuilt" + "inModule"; export const fs = p[gb]("fs");`, /constructor: reflection name refused/);
  // controls: a class may declare a constructor, and the plain-object checks the tree performs stay allowed where they are
  allowed(X, `export class C { readonly n: number; constructor(n: number) { this.n = n; } }\nexport const c = new C(1).n;`);
  allowed("integrated/flowCanonical.ts", `const plain = (v: object) => Object.getPrototypeOf(v) === Object.prototype && Object.getOwnPropertySymbols(v).length === 0;\nvoid plain;`);
});

test("N18: the CommonJS wrapper's hidden arguments (A8 form), and no JavaScript files under integrated/", () => {
  const n18 = `const r = arguments[1]; const https = r("https"); exports.p = (b) => https.request({ host: ["api-demo", "airwallex", "com"].join("."), method: "POST" }).end(b);`;
  refused("integrated/x.cjs", n18, /JavaScript module files \(\.js \.cjs \.mjs \.jsx\) are not permitted under integrated\//);
  refused("integrated/x.cjs", n18, /arguments: identifier refused/);
  refused("integrated/x.cjs", n18, /exports: identifier refused/);
  refused("integrated/x.cts", `const r = arguments[1]; export const https = r("https");`, /arguments: identifier refused/); // the same wrapper exists for .cts
  refused("integrated/x.cjs", `const r = module.require; exports.x = r("https");`, /module: identifier refused/);
  refused("integrated/x.cjs", `const p = __filename + __dirname;`, /__filename: identifier refused/);
  // a JavaScript file is refused even when its content is harmless
  assert.ok(api.INTEGRATED_SOURCE_EXT instanceof RegExp, "extension rule missing: 76367b0 scans .js files and accepts a clean one");
  for (const f of ["integrated/ok.js", "integrated/ok.mjs", "integrated/ok.cjs", "integrated/ok.jsx"]) refused(f, `const one = 1;`, /JavaScript module files .* are not permitted under integrated\//);
  for (const f of ["integrated/ok.ts", "integrated/ok.tsx", "integrated/ok.mts", "integrated/ok.cts"]) allowed(f, `const one = 1;\nvoid one;`);
  graphRefused({ "integrated/ok.js": `export const one = 1;` }, /integrated\/ok\.js: JavaScript module files are not permitted under integrated\//);
});

test("N3, N20, N21, N22, N26, N8, N9c (not in the required list; added because they cost no allowance)", () => {
  // N3 / N3b: sloppy-mode `this`
  refused("integrated/x.cts", `function g(this: any) { return this; } const k = ["__drawb", "ridgeAwx"].join(""); export const leak = () => (g as any)()[k];`, /`this` outside a class refused/);
  // N20: aliasing a restricted class
  refused("integrated/flowRuntime.ts", `import { SandboxClient } from "../src/server/awx.ts";\nconst SC = SandboxClient; void new SC("transfer");`, /SandboxClient \(from src\/server\/awx\.ts\) may only be called, constructed, tested with instanceof or used as a type/);
  // N21 / N22: storing or passing a restricted binding
  refused("integrated/flowRuntime.ts", `import { getRun } from "../src/server/agentRuntime.ts";\nconst reg: Record<string, unknown> = {}; reg.getRun = getRun;`, /getRun \(from src\/server\/agentRuntime\.ts\) may only be called/);
  refused("integrated/flowRuntime.ts", `import { getRun } from "../src/server/agentRuntime.ts";\nconst stash = (f: unknown) => f; stash(getRun);`, /getRun \(from src\/server\/agentRuntime\.ts\) may only be called/);
  refused("integrated/flowRuntime.ts", `import { getRun } from "../src/server/agentRuntime.ts";\nconst o = { getRun }; void o;`, /getRun \(from src\/server\/agentRuntime\.ts\) may only be called/);
  refused("integrated/flowRuntime.ts", `import { getRun } from "../src/server/agentRuntime.ts";\nconst f = () => getRun; void f;`, /getRun \(from src\/server\/agentRuntime\.ts\) may only be called/);
  allowed("integrated/flowRuntime.ts", `import { getRun } from "../src/server/agentRuntime.ts";\nconst look = (id: string) => getRun(id);\nvoid look;`);
  allowed("integrated/paymentAdapter.ts", `import { AwxError, SandboxClient } from "../src/server/awx.ts";\nconst mk = (): SandboxClient => new SandboxClient("transfer");\nconst is = (e: unknown) => e instanceof AwxError;\nvoid [mk, is];`);
  // N26: namespace merge onto a pinned type
  refused("integrated/flowRuntime.ts", `export namespace FlowRuntime { export const g = 1; }`, /namespace \/ module declarations refused/);
  // N8: string-evaluating timers
  refused(X, `setTimeout("1+1" as any, 0);`, /setTimeout: identifier refused/);
  // N9c: a split-name environment read in a file that may read the environment
  refused("integrated/flags.ts", `const kk = ["AW", "X_TRANSFER_ENV_FILE"].join(""); void process.env[kk];`, /process\.env\[kk\]: element access with a non-literal key is not listed for integrated\/flags\.ts/);
});

test("candidate 4: the new allowances are exact, and the scanner still describes itself as a lint", () => {
  assert.ok(api.KEYED_ACCESS && api.REFLECTION_NAMES && api.REFLECTION_REFUSED, "tables missing");
  assert.deepEqual(graph({}), [], "the merged tree is clean, and every listed keyed access and reflection name is in use");
  graphRefused({ "integrated/stateMachine.ts": `export const nothing = 1;` }, /stateMachine\.ts: keyed-access allowance set\[k\] is unused/);
  graphRefused({ "integrated/gateBinding.ts": `export const nothing = 1;` }, /gateBinding\.ts: reflection allowance getPrototypeOf is unused/);
  assert.ok(api.REFLECTION_REFUSED!.includes("constructor"));
  for (const names of Object.values(api.REFLECTION_NAMES!)) assert.ok(!names.includes("constructor") && !names.includes("getOwnPropertyDescriptor"));
  const rulesText = readFileSync(join(WEB, "tests/integrated/a7/rules.ts"), "utf8");
  assert.match(rulesText, /defense-in-depth security LINT\. It is NOT a security boundary, a sandbox, or proof of code-execution isolation/);
});
