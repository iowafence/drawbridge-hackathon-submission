// DRAWBRIDGE integrated flow — contract flow-v1 feature flags. OWNER: A7. Server-only; read from process env.
// Parsing is fail-closed: a flag is ON only for the exact text "1". Any malformed or unsafe configuration returns a
// fixed refusal code instead of a config, and the integrated flow does not run. No frontend flag can enable anything.
import { isAbsolute, relative, resolve } from "node:path";
import type { ProviderMode } from "./flowTypes.ts";

export type IntegratedFlags = {
  flow: true;
  ledger: boolean;
  e3: boolean;
  externalAudit: boolean;
  providerMode: ProviderMode;
  dataDir: string;
  /** Owner release for exactly one sandbox create: "<flow_id>:<authorization_digest>". Ignored in mock mode. */
  submitRelease: string | null;
};

const on = (v: string | undefined) => v === "1";
const offOrOn = (v: string | undefined) => v === undefined || v === "" || v === "0" || v === "1";

function inside(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export function readIntegratedFlags(env: Record<string, string | undefined> = process.env, repoRoot: string = resolve(process.cwd(), "..", "..")): IntegratedFlags | string {
  for (const k of ["DB_INTEGRATED_FLOW_ENABLED", "DB_INTEGRATED_LEDGER_ENABLED", "DB_INTEGRATED_E3_ENABLED", "DB_INTEGRATED_EXTERNAL_AUDIT_ENABLED"]) {
    if (!offOrOn(env[k])) return `FLAG_MALFORMED ${k}`;
  }
  if (!on(env.DB_INTEGRATED_FLOW_ENABLED)) return "INTEGRATED_FLOW_DISABLED";
  const mode = env.DB_INTEGRATED_PROVIDER_MODE ?? "mock";
  if (mode !== "mock" && mode !== "sandbox") return "PROVIDER_MODE_INVALID";
  const dir = env.DB_INTEGRATED_DATA_DIR;
  if (!dir || !isAbsolute(dir)) return "INTEGRATED_STORAGE_NOT_CONFIGURED";
  if (inside(dir, repoRoot)) return "INTEGRATED_STORAGE_INSIDE_REPOSITORY";
  const historic = env.DRAWBRIDGE_DATA_DIR;
  if (historic && (inside(dir, historic) || inside(historic, dir))) return "INTEGRATED_STORAGE_OVERLAPS_HISTORIC_CHAIN";
  const release = env.DB_INTEGRATED_SUBMIT_RELEASE ?? null;
  if (mode === "sandbox") {
    if (!env.AWX_TRANSFER_ENV_FILE) return "SANDBOX_TRANSFER_CREDENTIAL_NOT_CONFIGURED";
    if (release !== null && !/^[0-9a-f-]{36}:[0-9a-f]{64}$/.test(release)) return "SUBMIT_RELEASE_MALFORMED";
  }
  return {
    flow: true,
    ledger: on(env.DB_INTEGRATED_LEDGER_ENABLED),
    e3: on(env.DB_INTEGRATED_E3_ENABLED),
    externalAudit: on(env.DB_INTEGRATED_EXTERNAL_AUDIT_ENABLED),
    providerMode: mode,
    dataDir: resolve(dir),
    submitRelease: mode === "sandbox" ? release : null,
  };
}
