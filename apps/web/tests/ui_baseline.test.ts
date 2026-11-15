// UI redesign acceptance baseline (ui/erp-redesign). Separate from the historical E3 acceptance.
// 1. The candidate files match their explicit pins in tests/ui-baseline.json (regenerate with scripts/ui-baseline.mjs).
// 2. Finance, data, evidence and E3 component sources are byte-identical to the accepted E3 commit.
// 3. When Git is available, the historical accepted-E3 pins (kept in tests/cashcrisis.test.ts) are reproduced from the accepted commit.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(join(webRoot, "tests/ui-baseline.json"), "utf8")) as {
  acceptedE3Commit: string;
  candidate: Record<string, string>;
  preserved: Record<string, string>;
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// The historical accepted-E3 pins, as recorded in tests/cashcrisis.test.ts (ACCEPTED_SHA256).
const HISTORICAL = {
  overviewPage: "17268931d31a13839347ba97da0836e5fc6ed8bca6b12296d5271ae889b8432a",
  incidentPage: "d4d1aea0a2a30d28e165b50246043ccc92c5de774465776597e99a12405f1310",
  shell: "1561ff27ff6dfc2f5f7c3dc2c572c582cb3f98db5deb01ddaca19ae5bdf3fa88",
  globalsCss: "8f956e9e621b89a193ff854c46d377f5125daf3c97ed505be423431fc19358a2",
} as const;
const E3_ADDED_LINES: Record<"overview" | "incident", string[]> = {
  overview: [
    'import { CashCrisisForecast } from "../../components/CashCrisisForecast.tsx";\n',
    'import { selectFundingCase } from "../../data/cashCrisis.ts";\n',
    "      <CashCrisisForecast scenario={id} fundingCase={selectFundingCase(await searchParams)} />\n",
  ],
  incident: [
    'import { CashCrisisIncident } from "../../components/CashCrisisIncident.tsx";\n',
    'import { selectFundingCase } from "../../data/cashCrisis.ts";\n',
    "      <CashCrisisIncident scenario={id} fundingCase={selectFundingCase(await searchParams)} />\n",
  ],
};

function gitShow(rel: string): Buffer | null {
  try {
    return execFileSync("git", ["show", `${baseline.acceptedE3Commit}:apps/web/${rel}`], { cwd: webRoot, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}
const gitAvailable = gitShow("package.json") !== null;

test("UI-B1 the candidate files match their explicit UI pins", () => {
  for (const [rel, hash] of Object.entries(baseline.candidate)) assert.equal(sha(readFileSync(join(webRoot, rel))), hash, `${rel}: regenerate tests/ui-baseline.json with scripts/ui-baseline.mjs if this change is intended`);
});

test("UI-B2 finance, data, evidence and E3 components are byte-identical to their pins", () => {
  for (const [rel, hash] of Object.entries(baseline.preserved)) assert.equal(sha(readFileSync(join(webRoot, rel))), hash, `${rel} must not change in a presentation-layer redesign`);
});

test("UI-B3 the preserved files are byte-identical to the accepted E3 commit in Git", { skip: !gitAvailable && "accepted E3 commit not available in this checkout" }, () => {
  for (const rel of Object.keys(baseline.preserved)) {
    const accepted = gitShow(rel);
    assert.ok(accepted, `${rel} exists at the accepted commit`);
    assert.equal(sha(accepted), baseline.preserved[rel], `${rel} equals the accepted E3 blob`);
  }
});

test("UI-B4 the historical accepted-E3 pins are reproducible from the accepted commit", { skip: !gitAvailable && "accepted E3 commit not available in this checkout" }, () => {
  assert.equal(sha(gitShow("src/app/globals.css")!), HISTORICAL.globalsCss, "accepted globals.css");
  assert.equal(sha(gitShow("src/components/Shell.tsx")!), HISTORICAL.shell, "accepted Shell.tsx");
  for (const screen of ["overview", "incident"] as const) {
    let source = gitShow(`src/app/${screen}/page.tsx`)!.toString("utf8");
    for (const line of E3_ADDED_LINES[screen]) {
      assert.equal(source.split(line).length, 2, `${screen}: E3 line present once at the accepted commit`);
      source = source.replace(line, "");
    }
    assert.equal(sha(source), screen === "overview" ? HISTORICAL.overviewPage : HISTORICAL.incidentPage, `${screen}: accepted pre-E3 page`);
  }
});
