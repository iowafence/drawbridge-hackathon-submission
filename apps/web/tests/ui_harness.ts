// Shared render harness for the UI redesign tests: transpiles the server components and pages with the project's TypeScript
// compiler into a temporary directory OUTSIDE the source tree and renders them with react-dom/server. No network, no write to the repo.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

export const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
type PageModule = { default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown> };

const transpile = (source: string, fileName: string) =>
  ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true } }).outputText;
const rewrite = (code: string, map: Record<string, string>) => {
  for (const [from, to] of Object.entries(map)) code = code.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`"${to}"`);
  return code;
};

export type Harness = { render: (screen: string, params: Record<string, string>) => Promise<string>; dispose: () => void };

/** Builds every component and the named page(s) once. Pages import components as "../../components/X.tsx". */
export async function buildHarness(screens: string[]): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "ui-harness-"));
  const resolve = (spec: string) => fileURLToPath(import.meta.resolve(spec));
  const url = (file: string) => pathToFileURL(join(tmp, file)).href;
  const src = (rel: string) => pathToFileURL(join(webRoot, "src", rel)).href;
  const jsx = pathToFileURL(resolve("react/jsx-runtime")).href;
  writeFileSync(join(tmp, "link.mjs"), `import { createElement } from ${JSON.stringify(pathToFileURL(resolve("react")).href)};\nexport default function Link(p){ const { href, children, ...rest } = p; return createElement("a", { href, ...rest }, children); }\n`);
  const common: Record<string, string> = { "react/jsx-runtime": jsx, "next/link": url("link.mjs") };
  for (const mod of ["contract/money", "contract/derive", "data/adapter", "data/cashCrisis", "data/load"]) {
    common[`../contract/${mod.split("/")[1]}.ts`] = src(`${mod}.ts`);
    common[`../data/${mod.split("/")[1]}.ts`] = src(`${mod}.ts`);
    common[`../../contract/${mod.split("/")[1]}.ts`] = src(`${mod}.ts`);
    common[`../../data/${mod.split("/")[1]}.ts`] = src(`${mod}.ts`);
  }
  const components = readdirSync(join(webRoot, "src/components")).filter((f) => f.endsWith(".tsx")).map((f) => f.replace(/\.tsx$/, ""));
  const compMap: Record<string, string> = {};
  for (const c of components) {
    compMap[`./${c}.tsx`] = url(`${c}.mjs`);
    compMap[`../../components/${c}.tsx`] = url(`${c}.mjs`);
  }
  for (const c of components) writeFileSync(join(tmp, `${c}.mjs`), rewrite(transpile(readFileSync(join(webRoot, `src/components/${c}.tsx`), "utf8"), `${c}.tsx`), { ...common, ...compMap }));
  const pages: Record<string, PageModule> = {};
  for (const s of screens) {
    writeFileSync(join(tmp, `page_${s}.mjs`), rewrite(transpile(readFileSync(join(webRoot, `src/app/${s}/page.tsx`), "utf8"), `${s}/page.tsx`), { ...common, ...compMap }));
    pages[s] = (await import(url(`page_${s}.mjs`))) as PageModule;
  }
  return {
    render: async (screen, params) => renderToStaticMarkup((await pages[screen].default({ searchParams: Promise.resolve(params) })) as never),
    dispose: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
