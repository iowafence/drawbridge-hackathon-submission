// Regenerates tests/ui-baseline.json: explicit SHA-256 pins for the UI redesign candidate (ui/erp-redesign).
// Usage: node scripts/ui-baseline.mjs
//   candidate  = files the redesign deliberately changes or adds. Re-run this script when one of them changes.
//   preserved  = files the redesign must leave byte-identical to the accepted E3 commit (finance, data, evidence).
// The historical accepted-E3 pins stay in tests/cashcrisis.test.ts and are reproduced from Git by tests/ui_baseline.test.ts.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ACCEPTED_E3_COMMIT = "f88af200a3e76b31c1f6129bfeae04e2ca64a24a";
const CANDIDATE = [
  "src/app/globals.css",
  "src/components/Shell.tsx",
  "src/components/Command.tsx",
  "src/app/overview/page.tsx",
  "src/components/IncidentRoom.tsx",
  "src/app/incident/page.tsx",
  "src/components/RecorderView.tsx",
  "src/app/recorder/page.tsx",
  "src/components/PayablesView.tsx",
  "src/app/payables/page.tsx",
];
const PRESERVED = [
  "src/contract/derive.ts",
  "src/contract/money.ts",
  "src/contract/types.ts",
  "src/data/adapter.ts",
  "src/data/cashCrisis.ts",
  "src/data/load.ts",
  "src/components/CashCrisisForecast.tsx",
  "src/components/CashCrisisIncident.tsx",
  "src/components/ForecastChart.tsx",
  "src/components/Figure.tsx",
  "fixtures/s0.json",
  "fixtures/s1.json",
  "fixtures/cash_crisis_evidence_v1.json",
  "fixtures/eligibility_evidence_v1.json",
];
const sha = (rel) => createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
const out = {
  note: "UI redesign candidate pins. Not the accepted E3 baseline; that remains reproducible from the accepted commit.",
  acceptedE3Commit: ACCEPTED_E3_COMMIT,
  candidate: Object.fromEntries(CANDIDATE.map((f) => [f, sha(f)])),
  preserved: Object.fromEntries(PRESERVED.map((f) => [f, sha(f)])),
};
writeFileSync(join(root, "tests/ui-baseline.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote tests/ui-baseline.json");
