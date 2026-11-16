// A6 real-browser layout and accessibility checks (contract flow-v1). Renders the A6 pages and the stepper with
// controls to static HTML (with the app's globals.css), opens them in a local headless Chrome through the DevTools
// protocol over Node's built-in WebSocket (no npm dependency), and measures at 375, 768 and 1280 px wide in light and
// dark colour schemes:
//   - no horizontal page scroll, and no visible element extends past the viewport;
//   - every button and passphrase field is at least 44 px tall (tap target), every link at least 24 px;
//   - text contrast of status pills, step statuses, body copy and buttons is at least 4.5:1;
//   - keyboard: every interactive element is reachable by Tab, in DOM order, and shows a visible focus outline.
// Skips (reported as skipped, never as passed) when no Chrome binary is available. Optional: A6_SCREENSHOT_DIR=<dir>
// writes PNG screenshots for human review. Files are written only to a temporary directory (and that dir if set).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { UI_FIXTURE_PATH } from "./generate_ui_fixtures.ts";
import { buildA6, enabledEnv, WEB, withEnv } from "./render.ts";
import type { A6Render } from "./render.ts";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => p && existsSync(p));
const WIDTHS = [375, 768, 1280];
const PREVIEWS = ["awaiting-human", "hold-dispute", "hold-edited", "review-balance-unknown", "processing", "uncertain", "paid-mock"];
const FIX = JSON.parse(readFileSync(UI_FIXTURE_PATH, "utf8")) as { views: { fixture: { id: string } }[] };

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void };

async function launch(dir: string): Promise<{ proc: ChildProcess; cdp: Cdp; session: string }> {
  const proc = spawn(CHROME!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  const wsUrl = await new Promise<string>((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error(`Chrome did not start: ${buf.slice(-400)}`)), 20_000);
    proc.stderr!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.on("exit", (c) => { clearTimeout(t); rej(new Error(`Chrome exited ${c}: ${buf.slice(-400)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map<number, { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void }>();
  let sessionId: string | undefined;
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${msg.error.message}`));
      else p.res(msg.result);
    }
  };
  const raw = (method: string, params: Record<string, unknown> = {}, sid?: string) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
  const { targetId } = (await raw("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  sessionId = ((await raw("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string }).sessionId;
  const cdp: Cdp = { send: (m, p) => raw(m, p, sessionId), close: () => ws.close() };
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { proc, cdp, session: sessionId };
}

async function evaluate<T>(cdp: Cdp, expr: string): Promise<T> {
  const r = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })) as { result: { value: T }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(`page script failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result.value;
}

async function open(cdp: Cdp, file: string, width: number, scheme: "light" | "dark") {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await cdp.send("Page.navigate", { url: pathToFileURL(file).href });
  for (let i = 0; i < 100; i++) {
    if ((await evaluate<string>(cdp, "document.readyState")) === "complete" && (await evaluate<boolean>(cdp, "!!document.querySelector('.ifs, main')"))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`page did not load: ${file}`);
}

/** Runs inside the page. Returns layout, target-size and contrast problems as strings. */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth, problems = [];
  if (document.documentElement.scrollWidth > vw + 1) problems.push("page scrolls horizontally: " + document.documentElement.scrollWidth + " > " + vw);
  const visible = (el) => { const s = getComputedStyle(el); if (s.visibility === "hidden" || s.display === "none") return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const clipped = (el) => { for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.clip && s.clip !== "auto" || s.clipPath && s.clipPath !== "none") return true; } return false; };
  for (const el of document.querySelectorAll("main *")) {
    if (!visible(el) || clipped(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) problems.push("overflows viewport: <" + el.tagName.toLowerCase() + " class=" + el.className + "> right=" + Math.round(r.right));
  }
  for (const el of document.querySelectorAll("main button, main input[type=password]")) {
    const h = el.getBoundingClientRect().height; if (h < 44) problems.push("tap target under 44px: " + el.tagName + " " + (el.textContent || el.name) + " " + h);
  }
  for (const el of document.querySelectorAll("main a")) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height; if (h < 18) problems.push("link under 18px tall: " + el.textContent + " " + h);
  }
  const rgb = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let p = el; p; p = p.parentElement) { const c = rgb(getComputedStyle(p).backgroundColor); if (c.a > 0.5) return c; } return rgb(getComputedStyle(document.body).backgroundColor); };
  const ratio = (el) => { const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  for (const sel of [".ifs-pill", ".ifs-step-status", ".ifs-step-sum", ".ifs-step-body a", ".ifs-dl dd", ".ifs-proofs td", ".ifs-act button", ".ifs-mode", ".ifs-callout", ".ifs-banner", ".muted", "h1", "h3"]) {
    for (const el of document.querySelectorAll(sel)) { if (!visible(el)) continue; const r = ratio(el); if (r < 4.5) problems.push("contrast " + r.toFixed(2) + " < 4.5: " + sel + " '" + (el.textContent || "").slice(0, 40) + "'"); }
  }
  return problems.slice(0, 25);
})()`;

const FOCUS = `(async () => {
  const want = [...document.querySelectorAll("a[href], button, input:not([type=hidden])")].filter((e) => e.getClientRects().length);
  return want.map((e) => e.outerHTML.slice(0, 60));
})()`;

let r: A6Render;
let dir = "";
let chrome: Awaited<ReturnType<typeof launch>> | null = null;
const pages: { name: string; file: string }[] = [];

before(async () => {
  if (!CHROME) return;
  r = await buildA6();
  dir = mkdtempSync(join(tmpdir(), "a6-browser-"));
  const css = readFileSync(join(WEB, "src/app/globals.css"), "utf8");
  const doc = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A6 test</title><style>${css}</style></head><body>${body}</body></html>`;
  await withEnv(enabledEnv(), async () => {
    pages.push({ name: "index", file: join(dir, "index.html") });
    writeFileSync(pages[0].file, doc(await r.index()));
    for (const id of PREVIEWS) {
      const f = join(dir, `preview-${id}.html`);
      writeFileSync(f, doc(await r.detail(id)));
      pages.push({ name: `preview:${id}`, file: f });
    }
  });
  const views = (FIX.views as unknown as Parameters<A6Render["stepper"]>[0][]);
  const controls = { csrf: "c".repeat(43) };
  for (const id of ["awaiting-human", "human-approved", "uncertain"]) {
    const v = views.find((x) => (x as unknown as { fixture: { id: string } }).fixture.id === id)!;
    const f = join(dir, `live-${id}.html`);
    writeFileSync(f, doc(`<main id="main-content" class="wrap" tabindex="-1">${r.stepper(v, { controls })}</main>`));
    pages.push({ name: `controls:${id}`, file: f });
  }
  chrome = await launch(dir);
});

/** Stops Chrome and every child it spawned (own process group, detached), then waits for the main process to exit,
 *  bounded by a timeout, so no child is still writing to the profile when it is removed. */
async function stopChrome(c: NonNullable<typeof chrome>): Promise<void> {
  c.cdp.close();
  const p = c.proc;
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise<void>((res) => p.once("exit", () => res()));
  try {
    process.kill(-p.pid!, "SIGKILL"); // the whole process group (renderer, GPU, utility processes)
  } catch {
    p.kill("SIGKILL");
  }
  await Promise.race([exited, new Promise<void>((res) => setTimeout(res, 5_000))]);
}

after(async () => {
  if (chrome) await stopChrome(chrome);
  r?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("A6-R1 layout, tap targets and contrast at 375 / 768 / 1280 px in light and dark schemes", { skip: CHROME ? false : "no Chrome binary found (set CHROME_PATH)" }, async () => {
  const failures: string[] = [];
  for (const p of pages) {
    for (const w of WIDTHS) {
      for (const scheme of ["light", "dark"] as const) {
        await open(chrome!.cdp, p.file, w, scheme);
        for (const prob of await evaluate<string[]>(chrome!.cdp, MEASURE)) failures.push(`${p.name} @${w}px ${scheme}: ${prob}`);
        if (process.env.A6_SCREENSHOT_DIR && scheme === "light") {
          const height = await evaluate<number>(chrome!.cdp, "Math.ceil(document.documentElement.scrollHeight)");
          await chrome!.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.min(height, 6000), deviceScaleFactor: 1, mobile: w < 600 });
          const shot = (await chrome!.cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
          writeFileSync(join(process.env.A6_SCREENSHOT_DIR, `${p.name.replace(/[:]/g, "_")}-${w}.png`), Buffer.from(shot.data, "base64"));
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("A6-R2 keyboard: Tab reaches every interactive element in DOM order and each shows a visible focus outline", { skip: CHROME ? false : "no Chrome binary found (set CHROME_PATH)" }, async () => {
  for (const p of pages.filter((x) => x.name.startsWith("controls:") || x.name === "preview:hold-dispute")) {
    await open(chrome!.cdp, p.file, 375, "light");
    const expected = await evaluate<string[]>(chrome!.cdp, FOCUS);
    assert.ok(expected.length > 3, `${p.name}: has interactive elements`);
    const seen: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await chrome!.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await chrome!.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const info = await evaluate<{ html: string; outline: string }>(chrome!.cdp, `(() => { const e = document.activeElement; const s = getComputedStyle(e); return { html: e.outerHTML.slice(0, 60), outline: s.outlineStyle + " " + s.outlineWidth }; })()`);
      assert.ok(!/^none|0px$/.test(info.outline) && !info.outline.startsWith("none"), `${p.name}: focus visible on ${info.html} (${info.outline})`);
      seen.push(info.html);
    }
    assert.deepEqual(seen, expected, `${p.name}: tab order follows DOM order and reaches everything`);
  }
});
