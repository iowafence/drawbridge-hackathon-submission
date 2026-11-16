// A7 source rules shared by isolation.test.ts and their self-tests. OWNER: A7.
//
// A8-03 repair: module references are now read from the TypeScript syntax tree (the `typescript` devDependency, used
// from tests only), so quote style, spacing, re-exports, side-effect imports and file extension no longer decide
// whether a reference is seen. Every earlier regex check is kept and still runs; these rules are an added layer.
//
// WHAT THIS FILE IS, AND IS NOT (owner classification, candidate 4):
//   A defense-in-depth security LINT. It is NOT a security boundary, a sandbox, or proof of code-execution isolation.
//   It reads source text and syntax; it does not run or type-check anything. It makes each KNOWN way of reaching
//   payment or model authority from apps/web/integrated/** an explicit, reviewed change (an entry in a table below),
//   and it refuses the known ways of hiding one. JavaScript has more reflective paths than any list can name, so a
//   determined author who is allowed to commit under integrated/ can still get past it. A pass here means "none of
//   the known forms is present", never "this code cannot reach X". Code review of every change under integrated/,
//   and of every edit to the tables in this file, is the control. Known gaps are listed in the lane handoff.
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/** Historic modules integrated code may import, and exactly which names. `*` = any (types and pure functions). */
export const ALLOWED: Record<string, { names: string[] | "*"; only?: string[] }> = {
  "src/server/agentPolicy.ts": { names: "*" }, // pure deterministic gate, no model
  "src/server/agentRegistry.ts": { names: "*" }, // pure registry checks, no model
  "src/server/agent.ts": { names: ["groundFacts", "FACTS_SCHEMA", "runAgent", "TOOLS", "Run", "Deps", "ModelProvider"], only: ["integrated/agentBridge.ts", "integrated/flowService.ts", "integrated/gateBinding.ts"] },
  "src/server/policy.ts": { names: ["toMinor", "fromMinor", "CURRENCY", "DEMO_CAP_MINOR", "PROPOSAL", "Proposal"] },
  "src/server/transfers.ts": { names: ["APPROVAL_TTL_MS", "KNOWN_PROVIDER_STATUS", "MAX_SUBMISSIONS", "Result"] },
  "src/server/awx.ts": { names: ["SandboxClient", "AwxError", "AwxResponse", "readBalances", "BalanceRead"], only: ["integrated/paymentAdapter.ts", "integrated/flowRuntime.ts"] },
  "src/server/runtime.ts": { names: ["parseAllowlist", "usdAvailable", "liveBalances"], only: ["integrated/flowRuntime.ts"] },
  "src/server/auth.ts": { names: ["authConfigured", "verifyPassphrase", "getSession", "cookieToken", "sameCsrf", "sameOrigin", "COOKIE"], only: ["integrated/flowHandler.ts", "integrated/flowRuntime.ts", "integrated/agentBridge.ts"] }, // flowRuntime: getSession for the R9 page surface
  "src/server/agentRuntime.ts": { names: ["getRun", "handleAgentRun"], only: ["integrated/agentBridge.ts", "integrated/flowRuntime.ts"] },
  "src/server/agentClaude.ts": { names: ["claudeProvider", "anthropicEnvOverrides", "DEFAULT_CLAUDE_MODEL"], only: ["integrated/agentBridge.ts"] },
  "src/server/agentOllama.ts": { names: ["ollamaProvider", "DEFAULT_OLLAMA_MODEL"], only: ["integrated/agentBridge.ts"] },
  "src/server/aiConfig.ts": { names: ["loadAiConfig"], only: ["integrated/agentBridge.ts"] },
};

/** flow-v1.1 R3: the only file allowed to run a subprocess. execFile with argv only. Returns violations (empty = ok). */
export function subprocessViolations(rel: string, src: string): string[] {
  const out: string[] = [];
  if (rel !== "integrated/ledgerPsql.ts") {
    if (/child_process/.test(src)) out.push("child_process outside integrated/ledgerPsql.ts");
    return out;
  }
  if (/\bexec\(|execSync|execFileSync|spawn|fork\(|shell\s*:|\bsh\b|bash|eval\(|new Function/.test(src)) out.push("exec/spawn/fork/shell/eval forbidden; execFile with argv only");
  if (/require\(|import\(/.test(src)) out.push("no require or dynamic import");
  const cp = [...src.matchAll(/import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']node:child_process["']/g)];
  if (/["']child_process["']/.test(src)) out.push("bare child_process specifier; use node:child_process");
  for (const m of cp) {
    const names = m[1].startsWith("{") ? m[1].slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean) : [m[1]];
    if (names.length !== 1 || names[0] !== "execFile") out.push(`only { execFile } may be imported (got ${m[1]})`);
  }
  const mentions = (src.match(/child_process/g) ?? []).length;
  if (mentions !== cp.length) out.push("child_process referenced other than by a named import");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// A8-03: syntax-tree scanner for apps/web/integrated/** (and src/ files that must not reach integrated code).
// ---------------------------------------------------------------------------------------------------------------------

/** Every extension Node, the TypeScript stripper or the bundler would load as a module. All are scanned. */
export const SCANNED_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The only place integrated code may use the process-wide object, and the only property it may hold there.
 *  Exact file, exact property. The historic globals (__drawbridgeAwx, __drawbridgeAgent, __drawbridgeAuth) hold the
 *  transfer client, the agent runs and the sessions; no integrated file may name them. */
export const GLOBAL_ALLOWANCE: Record<string, { property: string; globalThisMentions: number }> = {
  "integrated/flowRuntime.ts": { property: "__drawbridgeFlowRuntime", globalThisMentions: 1 },
};

/** The only members of `process` each integrated file uses today (exact file, exact member). `process` in any other
 *  position (cast, alias, computed access, another member such as getBuiltinModule, binding or dlopen), or in any
 *  other file, is refused. Reading the environment is therefore confined to the three files that take `process.env`. */
export const PROCESS_MEMBERS: Record<string, readonly string[]> = {
  "integrated/flags.ts": ["env", "cwd"],
  "integrated/flowRuntime.ts": ["env"],
  "integrated/flowHandler.ts": ["env"],
  "integrated/paymentAdapter.ts": ["pid"],
  "integrated/auditExport.ts": ["pid"],
};

/**
 * A8-03 residual. The node: built-ins each integrated file imports, by exact name, inventoried from the merged tree.
 * Nothing else may be imported from a built-in: not another module (node:vm, node:worker_threads, node:inspector,
 * node:http, node:https, node:net, node:child_process, ...), not another name from an allowed module, and never a
 * namespace or default import. A new file, module or name needs an explicit entry here, which is a reviewed change.
 * node:child_process may only ever be granted to integrated/ledgerPsql.ts (flow-v1.1 R3); that file is not in the
 * tree, so nothing holds it today.
 */
export const NODE_BUILTINS: Record<string, Record<string, readonly string[]>> = {
  "integrated/auditExport.ts": {
    "node:fs": ["closeSync", "existsSync", "fsyncSync", "openSync", "readFileSync", "realpathSync", "renameSync", "writeSync"],
    "node:path": ["dirname", "isAbsolute", "join", "sep"],
  },
  "integrated/flags.ts": { "node:path": ["isAbsolute", "relative", "resolve"] },
  "integrated/flowCanonical.ts": { "node:crypto": ["createHash", "createHmac", "timingSafeEqual"] },
  "integrated/flowRuntime.ts": { "node:crypto": ["randomBytes", "randomUUID"], "node:path": ["join"] },
  "integrated/flowStore.ts": { "node:fs": ["chmodSync", "existsSync", "mkdirSync"], "node:path": ["isAbsolute", "join"], "node:sqlite": ["DatabaseSync"] },
  "integrated/paymentAdapter.ts": {
    "node:fs": ["appendFileSync", "existsSync", "readFileSync", "renameSync", "writeFileSync"],
    "node:crypto": ["createHash", "randomUUID"],
    "node:path": ["isAbsolute"],
  },
  // candidate 3 (A3, 4c40a17): the durable submission history. Imports no historic module and no capability holder.
  "integrated/submissionHistory.ts": {
    "node:fs": ["closeSync", "existsSync", "fsyncSync", "openSync", "readFileSync", "writeSync"],
    "node:crypto": ["createHash"],
    "node:path": ["join"],
  },
};

/** Provider environment and error names (`AWX_...`) each file may mention, exactly. Any other AWX_ text is refused,
 *  so the transfer credential variable can be named only by flags.ts, which checks that it is set and never reads it. */
export const AWX_NAMES: Record<string, readonly string[]> = {
  "integrated/flags.ts": ["AWX_TRANSFER_ENV_FILE"],
  "integrated/flowRuntime.ts": ["AWX_ALLOWED_BENEFICIARIES"],
  "integrated/paymentAdapter.ts": ["AWX_E_UNEXPECTED"],
};

/** Identifiers that give code execution, reflection or a network transport without any import. Refused as values
 *  anywhere under integrated/ (calling them, aliasing them, passing them). No integrated file uses any of them. */
export const REFUSED_IDENTIFIERS: readonly string[] = [
  "eval", "Function", "fetch", "WebAssembly", "Reflect", "Proxy", "Worker", "WebSocket", "XMLHttpRequest", "EventSource", "require", "module", "importScripts",
  // candidate 4: the CommonJS wrapper arguments (N18: `arguments[1]` is require) and string-evaluating timers
  "arguments", "exports", "__filename", "__dirname", "setTimeout", "setInterval", "setImmediate",
];

/**
 * A8-03 residual, transitive reach. A "capability holder" is an integrated file that imports a file-restricted
 * historic module (an ALLOWED entry with `only`) or imports from another holder. Its export surface is pinned here:
 * every exported name, and for each the integrated files that may import it (empty = none; Next.js routes and tests
 * are outside integrated/ and are not governed by this table). A new export on a holder, or a new consumer, needs an
 * entry here. That is how a wrapper around a restricted import (`export const runs = { getRun }`, a pass-through
 * function, `getRun.bind(null)`) is stopped: not by guessing what the wrapper does, but because it is a new export.
 */
export const CAPABILITY_SURFACE: Record<string, Record<string, readonly string[]>> = {
  "integrated/flowHandler.ts": { FlowHandlerDeps: [], handleFlowAction: [] },
  "integrated/flowRuntime.ts": {
    MOCK_BALANCE_USD: [], FlowRuntime: ["integrated/flowHandler.ts"], buildFlowDeps: [], flowRuntime: ["integrated/flowHandler.ts"], flowPageSurface: [], resetFlowRuntimeForTests: [],
  },
  "integrated/flowService.ts": { FlowTestHooks: [], createFlowService: ["integrated/flowRuntime.ts"] },
  "integrated/paymentAdapter.ts": {
    MOCK_ALLOWLIST: ["integrated/flowRuntime.ts"], providerBody: ["integrated/flowService.ts"], CreateClass: [], classifyCreate: ["integrated/flowService.ts"], ReadClass: [],
    classifyRead: ["integrated/flowService.ts"], MockScript: [], MockRecord: [], MockProvider: [], mockProvider: ["integrated/flowRuntime.ts"], sandboxProvider: ["integrated/flowRuntime.ts"],
  },
};

/** Candidate 4 (N12). Every element access whose key is not a literal, by exact file and exact expression text
 *  (whitespace collapsed), inventoried from the merged tree. A key held in a variable can evaluate to "constructor"
 *  (`(() => {})[k]`), and without types the scanner cannot tell an array index from a property name, so each use is
 *  listed. A new variable-key access, or the same access in another file, needs an entry here. */
export const KEYED_ACCESS: Record<string, readonly string[]> = {
  "integrated/auditChain.ts": ["e[k]", "rows[i]"],
  "integrated/auditExport.ts": ["out[out.length - 1]", "rollingHeads(chain.events)[seq]", "rollingHeads(chain.events.slice(0, cp.seq))[cp.seq]"],
  "integrated/flags.ts": ["env[k]"],
  "integrated/flowCanonical.ts": ["o[k]", "v[i]"],
  "integrated/flowService.ts": ["g.proof_states[k]", "PROVIDER_STATUS_TO_STATE[c.status]"],
  "integrated/flowTypes.ts": ["LEGAL_TRANSITIONS[op]"],
  "integrated/gateBinding.ts": ["fresh.proof_states[id]", "proof_states[id]", "record.proof_states[id]"],
  "integrated/paymentAdapter.ts": ["extra[requestId]", "load().records[requestId]", "s.records[body.request_id]", "s.records[requestId]"],
  "integrated/proposalBuilder.ts": ["BINDINGS[caseId]", "REPLAY[documentId]"],
  "integrated/stateMachine.ts": ["set[k]"],
  "integrated/submissionHistory.ts": ["KEYS[o.kind]", "rows[i]"],
};

/** Candidate 4 (N12). Reflection names that reach prototypes or property descriptors, by exact file. The tree uses
 *  them only for plain-object checks. Anywhere else, and every other name in REFLECTION_REFUSED, is refused. */
export const REFLECTION_NAMES: Record<string, readonly string[]> = {
  "integrated/auditChain.ts": ["getPrototypeOf", "prototype"],
  "integrated/flowCanonical.ts": ["getPrototypeOf", "prototype", "getOwnPropertyDescriptors", "getOwnPropertySymbols"],
  "integrated/flowService.ts": ["getPrototypeOf", "prototype"], // candidate 4 (A3, 5988313): plain-object check in providerRecordProblem
  "integrated/gateBinding.ts": ["getPrototypeOf", "prototype"],
};
const REFLECTION_PER_FILE: readonly string[] = ["getPrototypeOf", "prototype", "getOwnPropertyDescriptors", "getOwnPropertySymbols"];
/** Names refused in ANY position (property, key, binding, shorthand, variable): there is no legitimate use in the tree. */
export const REFLECTION_REFUSED: readonly string[] = [
  "constructor", "__proto__", "getOwnPropertyDescriptor", "getOwnPropertyNames", "setPrototypeOf", "defineProperty", "defineProperties",
  "__lookupGetter__", "__lookupSetter__", "__defineGetter__", "__defineSetter__",
];

/** Module file types permitted under integrated/. JavaScript files (.js .cjs .mjs .jsx) are refused outright: the
 *  application has none, and a CommonJS file receives `require` and `module` as hidden function arguments (N18). */
export const INTEGRATED_SOURCE_EXT = /\.(?:[cm]?ts|tsx)$/;

export type ModuleRef = {
  form: "import" | "side-effect-import" | "export-from" | "dynamic-import" | "require" | "import-equals" | "import-type";
  /** The literal specifier, or null when it is not a plain string literal. */
  spec: string | null;
  /** Named bindings requested (source names, before any `as`). */
  names: string[];
  /** true for default, namespace, `export *` and side-effect forms: the whole module is taken. */
  whole: boolean;
  line: number;
};

function scriptKind(rel: string): ts.ScriptKind {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

type Parsed = { ok: true; sf: ts.SourceFile } | { ok: false; why: string };

/** Parses one source file. Anything that prevents a complete, error-free parse is a failure, never a skip. */
function parse(rel: string, src: string): Parsed {
  try {
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const diags = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
    if (!Array.isArray(diags)) return { ok: false, why: "parser diagnostics unavailable" };
    if (diags.length > 0) return { ok: false, why: `${diags.length} syntax error(s)` };
    return { ok: true, sf };
  } catch {
    return { ok: false, why: "parser threw" };
  }
}

const literal = (n: ts.Node | undefined): string | null => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);

function collectRefs(sf: ts.SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      if (!c) refs.push({ form: "side-effect-import", spec: literal(n.moduleSpecifier), names: [], whole: true, line: line(n) });
      else {
        const nb = c.namedBindings;
        const names = nb && ts.isNamedImports(nb) ? nb.elements.map((e) => (e.propertyName ?? e.name).text) : [];
        refs.push({ form: "import", spec: literal(n.moduleSpecifier), names, whole: !!c.name || (!!nb && ts.isNamespaceImport(nb)), line: line(n) });
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const ec = n.exportClause;
      const names = ec && ts.isNamedExports(ec) ? ec.elements.map((e) => (e.propertyName ?? e.name).text) : [];
      refs.push({ form: "export-from", spec: literal(n.moduleSpecifier), names, whole: !ec || ts.isNamespaceExport(ec), line: line(n) });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      refs.push({ form: "import-equals", spec: literal(n.moduleReference.expression), names: [], whole: true, line: line(n) });
    } else if (ts.isImportTypeNode(n)) {
      const arg = n.argument;
      refs.push({ form: "import-type", spec: ts.isLiteralTypeNode(arg) ? literal(arg.literal) : null, names: [], whole: true, line: line(n) });
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isRequire = (ts.isIdentifier(callee) && callee.text === "require") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "require");
      if (callee.kind === ts.SyntaxKind.ImportKeyword) refs.push({ form: "dynamic-import", spec: literal(n.arguments[0]), names: [], whole: true, line: line(n) });
      else if (isRequire) refs.push({ form: "require", spec: literal(n.arguments[0]), names: [], whole: true, line: line(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return refs;
}

/** Every module reference in a source file, whatever its syntax. `error` is set when the file could not be parsed. */
export function moduleRefs(rel: string, src: string): { refs: ModuleRef[]; error: string | null } {
  const p = parse(rel, src);
  return p.ok ? { refs: collectRefs(p.sf), error: null } : { refs: [], error: p.why };
}

/** Path of the module a relative specifier names, relative to apps/web, with `.` and `..` resolved. */
export function resolveSpec(rel: string, spec: string): string {
  // Candidate 4 (N19): resolve the way Node's ESM loader does. A relative specifier is a URL reference, so it is
  // percent-decoded AFTER dot segments are resolved: "./%2e%2e/src/x.ts" names ../src/x.ts at run time. The path
  // judged against ALLOWED, the boundary and the pinned surfaces is this real target. A target outside apps/web
  // comes back starting with "../" and matches no rule, so it is refused.
  const root = "/__drawbridge_web__/";
  try {
    const abs = fileURLToPath(new URL(spec, pathToFileURL(root + rel))).split("\\").join("/");
    return abs.startsWith(root) ? abs.slice(root.length) : posix.relative(root, abs);
  } catch {
    return `<unresolvable>/${spec}`;
  }
}

/** The only shape a relative specifier may take: "./" or a leading run of "../", then plain path segments. No
 *  percent-encoding, backslash, query, fragment, empty segment, or "." / ".." after the leading run. With this shape
 *  the URL resolution above and a bundler's path resolution agree, so there is one target to judge. */
const CANONICAL_RELATIVE = /^(?:\.\/|(?:\.\.\/)+)(?:[A-Za-z0-9_@[\]-][A-Za-z0-9_.@[\]-]*\/)*[A-Za-z0-9_@[\]-][A-Za-z0-9_.@[\]-]*$/;

/** Why a relative specifier is refused before its target is even judged, or null. */
export function specifierProblem(rel: string, spec: string): string | null {
  if (/[%\\?#]/.test(spec)) return "percent-encoding, backslash, query or fragment in a relative specifier";
  if (!CANONICAL_RELATIVE.test(spec)) return "relative specifier is not in canonical form (./ or leading ../ only, plain segments)";
  if (resolveSpec(rel, spec) !== posix.normalize(posix.join(posix.dirname(rel), spec))) return "relative specifier resolves differently as a URL and as a path";
  return null;
}

const insideIntegratedBoundary = (target: string) => target.startsWith("integrated/") || target.startsWith("fixtures/integrated/") || target === "fixtures/sandbox_proposal_v1.json";

/**
 * The module boundary for one integrated source file. Returns violations (empty = ok).
 *
 * Same policy as the original regex rule (ALLOWED names and `only` lists, node: built-ins only, nothing dynamic),
 * applied to EVERY reference form. Added, all stricter:
 *   - side-effect, default, namespace and `export *` references to a names-restricted module are refused;
 *   - `export ... from` an `only`-restricted module is refused in every file, and a binding imported from such a
 *     module may not be re-exported (`export { x }`, `export default x`, `export const y = x`), because either would
 *     let any other integrated file reach it through an allowed one;
 *   - dynamic import, require and import-equals are refused whether or not the specifier is a literal;
 *   - node:module is refused (createRequire);
 *   - a file that does not parse cleanly is a violation.
 */
export function boundaryViolations(rel: string, src: string): string[] {
  const p = parse(rel, src);
  if (!p.ok) return [`unparseable source (${p.why}): refused, not skipped`];
  const out: string[] = [];
  const restricted = new Map<string, string>(); // local binding -> only-restricted module it came from
  for (const ref of collectRefs(p.sf)) {
    const at = `line ${ref.line}`;
    if (ref.form === "dynamic-import" || ref.form === "require" || ref.form === "import-equals" || ref.form === "import-type") {
      out.push(`${at}: ${ref.form} refused (${ref.spec === null ? "non-literal specifier" : "literal specifier"}); static imports only`);
      continue;
    }
    if (ref.spec === null) {
      out.push(`${at}: ${ref.form} with a non-literal specifier`);
      continue;
    }
    if (!ref.spec.startsWith(".")) {
      if (!ref.spec.startsWith("node:")) out.push(`${at}: only node: built-ins may be imported as packages (got ${ref.spec})`);
      else if (ref.spec === "node:module") out.push(`${at}: node:module refused (createRequire)`);
      else {
        // A8-03 residual: built-ins are an exact per-file, per-name allowlist, no longer "any node: module".
        const mods = Object.hasOwn(NODE_BUILTINS, rel) ? NODE_BUILTINS[rel] : {};
        const names = Object.hasOwn(mods, ref.spec) ? mods[ref.spec] : undefined;
        if (!names) out.push(`${at}: ${ref.spec} is not an allowed built-in for ${rel}`);
        else {
          if (ref.whole) out.push(`${at}: ${ref.form === "side-effect-import" ? "side-effect" : ref.form === "export-from" ? "export *" : "namespace/default"} reference to ${ref.spec} refused; name each import`);
          if (ref.form === "export-from") out.push(`${at}: re-export of ${ref.spec} refused`);
          for (const n of ref.names) if (!names.includes(n)) out.push(`${at}: ${n} from ${ref.spec} is not an allowed built-in name for ${rel}`);
        }
      }
      continue;
    }
    const shape = specifierProblem(rel, ref.spec);
    if (shape) out.push(`${at}: ${shape}`);
    const target = resolveSpec(rel, ref.spec); // the real runtime target is judged even when the spelling is refused
    if (insideIntegratedBoundary(target)) {
      // candidate 4 (N24): only data may come from the fixtures directories, and only TypeScript from integrated/
      if (target.startsWith("integrated/") ? !INTEGRATED_SOURCE_EXT.test(target) : !target.endsWith(".json")) out.push(`${at}: ${target} is not a permitted module type inside the boundary`);
      continue;
    }
    const rule = Object.hasOwn(ALLOWED, target) ? ALLOWED[target] : undefined;
    if (!rule) {
      out.push(`${at}: may not import ${target}`);
      continue;
    }
    if (rule.only && !rule.only.includes(rel)) out.push(`${at}: only ${rule.only.join(", ")} may import ${target}`);
    if (ref.form === "export-from" && rule.only) out.push(`${at}: re-export of ${target} refused (it would bypass the file restriction)`);
    if (rule.names !== "*") {
      if (ref.whole) out.push(`${at}: ${ref.form === "side-effect-import" ? "side-effect" : ref.form === "export-from" ? "export *" : "namespace/default"} reference to ${target} refused`);
      for (const n of ref.names) if (!rule.names.includes(n)) out.push(`${at}: ${n} from ${target} is not an allowed symbol`);
    }
  }
  // Bindings imported from an only-restricted module must stay inside the file that imported them.
  for (const st of p.sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = literal(st.moduleSpecifier);
    if (spec === null || !spec.startsWith(".")) continue;
    const target = resolveSpec(rel, spec);
    if (!Object.hasOwn(ALLOWED, target) || !ALLOWED[target].only) continue;
    const c = st.importClause;
    if (c.name) restricted.set(c.name.text, target);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) restricted.set(c.namedBindings.name.text, target);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly && !c.isTypeOnly) restricted.set(e.name.text, target);
  }
  // Candidate 4 (N20, N21, N22): a binding imported from a file-restricted module may only be called, constructed,
  // tested with instanceof or used as a type. Aliasing it, storing it, passing it or returning it is refused; that is
  // every way the tree does NOT use these bindings today.
  const position = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && restricted.has(n.text) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent) && !ts.isNamespaceImport(n.parent)) {
      const par = n.parent;
      const ok =
        ((ts.isCallExpression(par) || ts.isNewExpression(par)) && par.expression === n) ||
        (ts.isBinaryExpression(par) && par.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && par.right === n) ||
        ts.isTypeReferenceNode(par) || ts.isExpressionWithTypeArguments(par) || ts.isTypeQueryNode(par) ||
        ((ts.isPropertyAccessExpression(par) || ts.isPropertyAssignment(par) || ts.isPropertySignature(par) || ts.isPropertyDeclaration(par) || ts.isMethodDeclaration(par) || ts.isMethodSignature(par)) && par.name === n) ||
        ts.isExportSpecifier(par); // already reported by the re-export rule below
      if (!ok) out.push(`line ${p.sf.getLineAndCharacterOfPosition(n.getStart(p.sf)).line + 1}: ${n.text} (from ${restricted.get(n.text)}) may only be called, constructed, tested with instanceof or used as a type`);
    }
    ts.forEachChild(n, position);
  };
  const bare = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) ? bare(e.expression) : e);
  const leak = (id: ts.Node | undefined, how: string) => {
    if (id && ts.isIdentifier(id) && restricted.has(id.text)) out.push(`${how} re-exports ${id.text}, imported from ${restricted.get(id.text)} (file-restricted)`);
  };
  position(p.sf);
  for (const st of p.sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) leak(e.propertyName ?? e.name, "export list");
    else if (ts.isExportAssignment(st)) leak(bare(st.expression), "default export");
    else if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of st.declarationList.declarations) if (d.initializer) leak(bare(d.initializer), "exported constant");
  }
  return out;
}

/**
 * Ways to reach authority without a module reference the boundary rule can judge. Returns violations (empty = ok).
 * Text rules run on the raw source, comments and strings included, so they err towards refusing.
 */
export function authorityViolations(rel: string, src: string): string[] {
  const out: string[] = [];
  if (!INTEGRATED_SOURCE_EXT.test(rel)) out.push("JavaScript module files (.js .cjs .mjs .jsx) are not permitted under integrated/");
  if (/createRequire/.test(src)) out.push("createRequire refused");
  if (/getBuiltinModule/.test(src)) out.push("process.getBuiltinModule refused");
  if (/\bprocess\s*(?:\?\.)?\s*\[/.test(src)) out.push("computed access on process refused");
  if (/\bprocess\s*\.\s*(?:binding|dlopen|_linkedBinding)\b/.test(src)) out.push("process.binding/dlopen refused");
  if (/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(src)) out.push("eval / Function constructor refused");
  if (/node:module/.test(src)) out.push("node:module refused");
  if (/loadExtension/i.test(src)) out.push("SQLite extension loading refused (native code)");
  const awx = Object.hasOwn(AWX_NAMES, rel) ? AWX_NAMES[rel] : [];
  for (const m of new Set(src.match(/AWX_\w*/g) ?? [])) if (!awx.includes(m)) out.push(`${m}: provider environment or credential name may not appear in ${rel}`);

  // Process-wide state. The historic globals hold the transfer client, agent runs and sessions.
  const allowance = Object.hasOwn(GLOBAL_ALLOWANCE, rel) ? GLOBAL_ALLOWANCE[rel] : undefined;
  for (const m of new Set(src.match(/__drawbridge\w*/g) ?? [])) {
    if (!allowance || m !== allowance.property) out.push(`${m}: process-wide DRAWBRIDGE state may not be named here`);
  }
  if (/\bglobalThis\s*(?:\?\.)?\s*\[/.test(src)) out.push("computed access on globalThis refused");
  const p = parse(rel, src);
  if (!p.ok) {
    out.push(`unparseable source (${p.why}): refused, not skipped`);
    return out;
  }
  let globalThisCount = 0;
  let nodeGlobal = false;
  let computedName = false;
  let looseThis = false;
  let namespaceDecl = false;
  const reflection = new Set<string>();
  const unlistedKeyed = new Set<string>();
  const keyed = Object.hasOwn(KEYED_ACCESS, rel) ? KEYED_ACCESS[rel] : [];
  const reflectionAllowed = Object.hasOwn(REFLECTION_NAMES, rel) ? REFLECTION_NAMES[rel] : [];
  const insideClass = (n: ts.Node): boolean => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) if (ts.isClassLike(c)) return true;
    return false;
  };
  let nonReadClient = false;
  let processMisuse = false;
  let constructorAccess = false;
  let importMeta = false;
  let builtinString = false;
  let builtKey = false;
  const refusedIds = new Set<string>();
  const processMembers = Object.hasOwn(PROCESS_MEMBERS, rel) ? PROCESS_MEMBERS[rel] : [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      if (n.text === "globalThis") globalThisCount++;
      // `global` as a value (the Node alias), not as a property or member name such as `x.global` or `{ global: 1 }`
      const par = n.parent;
      const isName = (ts.isPropertyAccessExpression(par) && par.name === n) || ((ts.isPropertyAssignment(par) || ts.isPropertySignature(par) || ts.isPropertyDeclaration(par) || ts.isMethodDeclaration(par) || ts.isMethodSignature(par)) && par.name === n);
      if (n.text === "global" && !isName) nodeGlobal = true;
      if (n.text === "process" && !isName && !(ts.isPropertyAccessExpression(par) && par.expression === n && processMembers.includes(par.name.text))) processMisuse = true;
      if (REFUSED_IDENTIFIERS.includes(n.text) && !isName) refusedIds.add(n.text);
      if (n.text === "constructor" && ts.isPropertyAccessExpression(par) && par.name === n) constructorAccess = true;
    }
    if (ts.isMetaProperty(n)) importMeta = true;
    // candidate 4 (N12): the name `constructor`, and the other reflection names, in any position at all
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
      if (REFLECTION_REFUSED.includes(n.text)) reflection.add(n.text);
      if (REFLECTION_PER_FILE.includes(n.text) && !reflectionAllowed.includes(n.text)) reflection.add(n.text);
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && [...REFLECTION_REFUSED, "prototype"].includes(n.text)) reflection.add(`"${n.text}"`);
    if (ts.isElementAccessExpression(n) && literal(n.argumentExpression) === null && !ts.isNumericLiteral(n.argumentExpression)) {
      const text = n.getText(p.sf).replace(/\s+/g, " ");
      if (!keyed.includes(text)) unlistedKeyed.add(text.length > 60 ? `${text.slice(0, 57)}...` : text);
    }
    if (ts.isComputedPropertyName(n) && literal(n.expression) === null && !ts.isNumericLiteral(n.expression)) computedName = true;
    if (n.kind === ts.SyntaxKind.ThisKeyword && !insideClass(n)) looseThis = true;
    if (ts.isModuleDeclaration(n)) namespaceDecl = true;
    // a built-in specifier that is not the specifier of a static import is only useful to a loader
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && /node:/.test(n.text) && !(ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent))) builtinString = true;
    if (ts.isElementAccessExpression(n)) {
      let key: ts.Expression = n.argumentExpression;
      while (ts.isParenthesizedExpression(key) || ts.isAsExpression(key) || ts.isNonNullExpression(key) || ts.isSatisfiesExpression(key)) key = key.expression;
      if (literal(key) === "constructor") constructorAccess = true;
      // a property name assembled at run time hides which member is read: "con" + "structor", `${a}Module`
      // Index arithmetic (`out[out.length - 1]`, `xs[i + 1]`) is not a name: `+` is accepted only next to a number.
      const numericPlus = ts.isBinaryExpression(key) && key.operatorToken.kind === ts.SyntaxKind.PlusToken && (ts.isNumericLiteral(key.left) || ts.isNumericLiteral(key.right));
      const arithmetic = ts.isBinaryExpression(key) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PercentToken].includes(key.operatorToken.kind);
      if ((ts.isBinaryExpression(key) && !numericPlus && !arithmetic) || ts.isTemplateExpression(key) || ts.isCallExpression(key)) builtKey = true;
    }
    // Outside the payment adapter a provider client may only ever be the literal "read" role, however it is quoted.
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === "SandboxClient" && rel !== "integrated/paymentAdapter.ts") {
      const args = n.arguments ?? [];
      if (args.length !== 1 || literal(args[0]) !== "read") nonReadClient = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  if (globalThisCount > 0 && !allowance) out.push("globalThis may not be used here");
  if (allowance && globalThisCount > allowance.globalThisMentions) out.push(`globalThis used ${globalThisCount} times; ${rel} is allowed ${allowance.globalThisMentions}`);
  if (processMisuse) out.push(processMembers.length ? `process may only be used as process.${processMembers.join(", process.")} in ${rel}` : `process may not be used in ${rel}`);
  for (const id of refusedIds) out.push(`${id}: identifier refused (code execution, reflection or network transport)`);
  if (constructorAccess) out.push(".constructor access refused (reaches the Function constructor)");
  if (builtinString) out.push("a node: specifier outside a static import refused");
  if (importMeta) out.push("import.meta refused (module URLs, resolve)");
  if (builtKey) out.push("property key assembled at run time refused");
  for (const name of reflection) out.push(`${name}: reflection name refused (reaches constructors, prototypes or property descriptors)`);
  for (const text of unlistedKeyed) out.push(`${text}: element access with a non-literal key is not listed for ${rel} (KEYED_ACCESS)`);
  if (computedName) out.push("computed property name with a non-literal key refused");
  if (looseThis) out.push("`this` outside a class refused (sloppy-mode `this` is the global object)");
  if (namespaceDecl) out.push("namespace / module declarations refused (they can extend a pinned export)");
  if (nodeGlobal) out.push("the Node `global` object may not be used");
  if (nonReadClient) out.push('SandboxClient may only be constructed with the literal "read" role outside integrated/paymentAdapter.ts');
  if (rel !== "integrated/paymentAdapter.ts" && /SandboxClient\s*\(\s*["'`]transfer["'`]/.test(src)) out.push("only paymentAdapter.ts holds the transfer role (any quote style)");
  return out;
}

/**
 * A8-03 residual, transitive reach, judged for one file (the same rules treeViolations applies to the whole tree,
 * so a single planted or probed file is refused on its own). Returns violations (empty = ok).
 *   - a file that imports a file-restricted historic module, or imports from a pinned holder, must have a
 *     CAPABILITY_SURFACE entry;
 *   - a pinned holder may not export anything that is not pinned (wrappers, objects, bound functions, defaults);
 *   - an import from a holder must name pinned exports this file is listed for; namespace, side-effect and
 *     re-export references to a holder are refused.
 */
export function capabilityViolations(rel: string, src: string): string[] {
  const { refs, error } = moduleRefs(rel, src);
  if (error) return [`unparseable source (${error}): refused, not skipped`];
  const out: string[] = [];
  let holder = false;
  for (const ref of refs) {
    if (ref.spec === null || !ref.spec.startsWith(".")) continue;
    const target = resolveSpec(rel, ref.spec);
    if (Object.hasOwn(ALLOWED, target) && ALLOWED[target].only) holder = true;
    if (!Object.hasOwn(CAPABILITY_SURFACE, target)) continue;
    holder = true;
    const surface = CAPABILITY_SURFACE[target];
    if (ref.form === "export-from") out.push(`line ${ref.line}: re-export of capability holder ${target} refused`);
    if (ref.whole) out.push(`line ${ref.line}: namespace, default or side-effect reference to capability holder ${target} refused`);
    for (const n of ref.names) {
      if (!Object.hasOwn(surface, n)) out.push(`line ${ref.line}: ${n} is not a pinned export of ${target}`);
      else if (!surface[n].includes(rel)) out.push(`line ${ref.line}: ${rel} may not import ${n} from capability holder ${target}`);
    }
  }
  const pinned = Object.hasOwn(CAPABILITY_SURFACE, rel) ? Object.keys(CAPABILITY_SURFACE[rel]) : null;
  if (holder && !pinned) out.push(`${rel} reaches a file-restricted capability but has no pinned export surface (CAPABILITY_SURFACE)`);
  if (pinned) for (const n of exportedNames(rel, src).names) if (!pinned.includes(n)) out.push(`export ${n} is not pinned; a capability holder may not grow its export surface without review`);
  return out;
}

/** Everything the A8-03 layer checks for one file under integrated/. Returns violations (empty = ok). */
export function integratedSourceViolations(rel: string, src: string): string[] {
  return [...new Set([...boundaryViolations(rel, src), ...authorityViolations(rel, src), ...capabilityViolations(rel, src)])];
}

/** UI components may import integrated TYPES modules only; never the service, store, adapters or audit chain. */
export function uiReachViolations(rel: string, src: string): string[] {
  const { refs, error } = moduleRefs(rel, src);
  if (error) return [`unparseable source (${error}): refused, not skipped`];
  const out: string[] = [];
  for (const ref of refs) {
    const target = ref.spec === null ? null : ref.spec.startsWith("@/") ? `src/${ref.spec.slice(2)}` : ref.spec.startsWith(".") ? resolveSpec(rel, ref.spec) : ref.spec;
    if (target === null) out.push(`line ${ref.line}: ${ref.form} with a non-literal specifier`);
    else if (/(^|\/)integrated\/(flowService|flowStore|stateMachine|paymentAdapter|ledgerAdapter|gateBinding|auditChain)(\.[cm]?[jt]sx?)?$/.test(target)) out.push(`line ${ref.line}: UI may not import ${target}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// A8-03 residual: rules over the WHOLE integrated tree (the resolved import graph), not one file at a time.
// ---------------------------------------------------------------------------------------------------------------------

/** Every name a module exports, or an error string when it cannot be read. `export *` is reported as "*". */
export function exportedNames(rel: string, src: string): { names: string[]; error: string | null } {
  const p = parse(rel, src);
  if (!p.ok) return { names: [], error: p.why };
  const names: string[] = [];
  const bind = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) names.push(n.text);
    else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bind(e.name);
  };
  for (const st of p.sf.statements) {
    const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) names.push(e.name.text);
      else if (st.exportClause && ts.isNamespaceExport(st.exportClause)) names.push(st.exportClause.name.text);
      else names.push("*");
    } else if (ts.isExportAssignment(st)) names.push("default");
    else if (!exported) continue;
    else if (isDefault) names.push("default");
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bind(d.name);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) && st.name) names.push(st.name.text);
    else names.push("<unrecognised export>");
  }
  return { names, error: null };
}

/**
 * Graph rules for the integrated tree. `files` maps every scanned path under integrated/ to its source.
 * Returns violations (empty = ok).
 *   1. Capability holders: any file that imports a file-restricted historic module, or imports from a pinned holder,
 *      must itself have a CAPABILITY_SURFACE entry.
 *   2. A holder's exports must be exactly its pinned names: nothing added, nothing missing, no `export *`, no default.
 *   3. An import from a holder must name pinned exports, and the importing file must be listed for each.
 *      Namespace, side-effect and re-export references to a holder are refused.
 *   4. Allowances are exact both ways: a NODE_BUILTINS, PROCESS_MEMBERS, AWX_NAMES, GLOBAL_ALLOWANCE or
 *      CAPABILITY_SURFACE entry for a file that is not in the tree, or a built-in name that is allowed but unused,
 *      is a violation. An allowance that nothing uses is a hole waiting for a file.
 */
export function treeViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  const present = new Set(Object.keys(files));
  const used: Record<string, Record<string, Set<string>>> = {};
  for (const [rel, src] of Object.entries(files)) {
    const { refs, error } = moduleRefs(rel, src);
    if (error) {
      out.push(`${rel}: unparseable source (${error}): refused, not skipped`);
      continue;
    }
    let holder = false;
    for (const ref of refs) {
      if (ref.spec === null) continue;
      if (ref.spec.startsWith("node:")) {
        const set = ((used[rel] ??= {})[ref.spec] ??= new Set<string>());
        for (const n of ref.names) set.add(n);
        continue;
      }
      if (!ref.spec.startsWith(".")) continue;
      const target = resolveSpec(rel, ref.spec);
      if (Object.hasOwn(ALLOWED, target) && ALLOWED[target].only) holder = true;
      if (!Object.hasOwn(CAPABILITY_SURFACE, target)) continue;
      holder = true;
      const surface = CAPABILITY_SURFACE[target];
      if (ref.form === "export-from") out.push(`${rel}: re-export of capability holder ${target} refused`);
      if (ref.whole) out.push(`${rel}: namespace, default or side-effect reference to capability holder ${target} refused`);
      for (const n of ref.names) {
        if (!Object.hasOwn(surface, n)) out.push(`${rel}: ${n} is not a pinned export of ${target}`);
        else if (!surface[n].includes(rel)) out.push(`${rel}: may not import ${n} from capability holder ${target}`);
      }
    }
    if (holder && !Object.hasOwn(CAPABILITY_SURFACE, rel)) out.push(`${rel}: reaches a file-restricted capability but has no pinned export surface (CAPABILITY_SURFACE)`);
  }
  for (const [rel, surface] of Object.entries(CAPABILITY_SURFACE)) {
    if (!present.has(rel)) {
      out.push(`${rel}: CAPABILITY_SURFACE entry for a file that is not in the tree`);
      continue;
    }
    const { names, error } = exportedNames(rel, files[rel]);
    if (error) continue; // already reported above
    const pinned = Object.keys(surface);
    for (const n of names) if (!pinned.includes(n)) out.push(`${rel}: export ${n} is not pinned; a capability holder may not grow its export surface without review`);
    for (const n of pinned) if (!names.includes(n)) out.push(`${rel}: pinned export ${n} is missing`);
    for (const [n, consumers] of Object.entries(surface)) for (const c of consumers) {
      if (!present.has(c)) out.push(`${rel}: export ${n} names a consumer that is not in the tree (${c})`);
      else if (!Object.hasOwn(CAPABILITY_SURFACE, c)) out.push(`${rel}: export ${n} names a consumer with no pinned surface (${c})`);
    }
  }
  for (const [rel, mods] of Object.entries(NODE_BUILTINS)) {
    if (!present.has(rel)) {
      out.push(`${rel}: NODE_BUILTINS entry for a file that is not in the tree`);
      continue;
    }
    for (const [mod, names] of Object.entries(mods)) {
      if (mod === "node:child_process" && rel !== "integrated/ledgerPsql.ts") out.push(`${rel}: node:child_process may only be granted to integrated/ledgerPsql.ts`);
      for (const n of names) if (!used[rel]?.[mod]?.has(n)) out.push(`${rel}: built-in allowance ${mod} ${n} is unused; remove it`);
    }
  }
  for (const [rel, texts] of Object.entries(KEYED_ACCESS)) for (const t of texts) if (present.has(rel) && !files[rel].replace(/\s+/g, " ").includes(t)) out.push(`${rel}: keyed-access allowance ${t} is unused; remove it`);
  for (const [rel, names] of Object.entries(REFLECTION_NAMES)) for (const n of names) if (present.has(rel) && !new RegExp(`\\b${n}\\b`).test(files[rel])) out.push(`${rel}: reflection allowance ${n} is unused; remove it`);
  for (const rel of present) if (!INTEGRATED_SOURCE_EXT.test(rel)) out.push(`${rel}: JavaScript module files are not permitted under integrated/`);
  for (const [table, entries] of Object.entries({ PROCESS_MEMBERS, AWX_NAMES, GLOBAL_ALLOWANCE, KEYED_ACCESS, REFLECTION_NAMES })) {
    for (const rel of Object.keys(entries)) if (!present.has(rel)) out.push(`${rel}: ${table} entry for a file that is not in the tree`);
  }
  for (const [rel, names] of Object.entries(AWX_NAMES)) for (const n of names) if (present.has(rel) && !files[rel].includes(n)) out.push(`${rel}: AWX name allowance ${n} is unused; remove it`);
  for (const [rel, members] of Object.entries(PROCESS_MEMBERS)) for (const m of members) if (present.has(rel) && !new RegExp(`\\bprocess\\.${m}\\b`).test(files[rel])) out.push(`${rel}: process.${m} allowance is unused; remove it`);
  return out;
}
