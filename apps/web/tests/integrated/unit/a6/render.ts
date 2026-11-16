// A6 test render helper. Transpiles the A6 .tsx server components and pages with the project's TypeScript compiler
// into a temporary directory OUTSIDE the source tree, rewrites their relative imports to absolute file URLs (the .ts
// modules load directly through Node type stripping), stubs next/navigation's notFound, and renders with
// react-dom/server. No network, no write to the repository.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowView } from "../../../../integrated/flowTypes.ts";

export const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

const TSX = [
  "src/components/integrated/FlowStepper.tsx",
  "src/components/integrated/FlowFrame.tsx",
  "src/app/sandbox/flow/page.tsx",
  "src/app/sandbox/flow/[flowId]/page.tsx",
];

export class NotFound extends Error {}

export type A6Render = {
  stepper: (view: FlowView, opts?: { controls?: unknown; preview?: boolean }) => string;
  index: () => Promise<string>;
  detail: (flowId: string) => Promise<string>;
  dispose: () => void;
};

export async function buildA6(): Promise<A6Render> {
  const tmp = mkdtempSync(join(tmpdir(), "a6-render-"));
  const res = (spec: string) => pathToFileURL(fileURLToPath(import.meta.resolve(spec))).href;
  const out = (rel: string) => join(tmp, rel.replace(/[\/\[\]]/g, "_").replace(/\.tsx$/, ".mjs"));
  writeFileSync(join(tmp, "navigation.mjs"), `export class NotFound extends Error {}\nexport function notFound(){ throw new NotFound("NEXT_NOT_FOUND"); }\n`);
  for (const rel of TSX) {
    const abs = join(WEB, rel);
    let code = ts.transpileModule(readFileSync(abs, "utf8"), {
      fileName: rel,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true },
    }).outputText;
    code = code.replace(/from\s+"([^"]+)"/g, (_m, spec: string) => {
      if (spec === "react/jsx-runtime" || spec === "react") return `from "${res(spec)}"`;
      if (spec === "next/navigation") return `from "${pathToFileURL(join(tmp, "navigation.mjs")).href}"`;
      if (!spec.startsWith(".")) throw new Error(`${rel}: unexpected package import ${spec}`);
      const target = join(dirname(abs), spec);
      const trel = relative(WEB, target).split("\\").join("/");
      return `from "${TSX.includes(trel) ? pathToFileURL(out(trel)).href : pathToFileURL(target).href}"`;
    });
    // JSON import attributes survive transpile; keep them.
    writeFileSync(out(rel), code);
  }
  const nav = (await import(pathToFileURL(join(tmp, "navigation.mjs")).href)) as { NotFound: typeof Error };
  const stepperMod = (await import(pathToFileURL(out(TSX[0])).href)) as { FlowStepper: (p: unknown) => unknown };
  const indexMod = (await import(pathToFileURL(out(TSX[2])).href)) as { default: () => Promise<unknown> };
  const detailMod = (await import(pathToFileURL(out(TSX[3])).href)) as { default: (p: unknown) => Promise<unknown> };
  const wrapNotFound = async (f: () => Promise<unknown>) => {
    try {
      return renderToStaticMarkup((await f()) as never);
    } catch (e) {
      if (e instanceof nav.NotFound) throw new NotFound("notFound()");
      throw e;
    }
  };
  return {
    stepper: (view, opts = {}) => renderToStaticMarkup(createElement(stepperMod.FlowStepper as never, { view, ...opts } as never)),
    index: () => wrapNotFound(() => indexMod.default()),
    detail: (flowId) => wrapNotFound(() => detailMod.default({ params: Promise.resolve({ flowId }) })),
    dispose: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Environment under which readIntegratedFlags returns a config (mock mode, data dir outside the repository). */
export function enabledEnv(): Record<string, string> {
  return { DB_INTEGRATED_FLOW_ENABLED: "1", DB_INTEGRATED_PROVIDER_MODE: "mock", DB_INTEGRATED_DATA_DIR: join(tmpdir(), "a6-flow-data-not-created") };
}

export function withEnv<T>(env: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const keys = ["DB_INTEGRATED_FLOW_ENABLED", "DB_INTEGRATED_PROVIDER_MODE", "DB_INTEGRATED_DATA_DIR", "DB_INTEGRATED_LEDGER_ENABLED", "DB_INTEGRATED_E3_ENABLED", "DB_INTEGRATED_EXTERNAL_AUDIT_ENABLED", "DB_INTEGRATED_SUBMIT_RELEASE", "AWX_TRANSFER_ENV_FILE", "DRAWBRIDGE_DATA_DIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  return f().finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}
