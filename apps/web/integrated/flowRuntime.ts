// DRAWBRIDGE integrated flow — runtime wiring (contract flow-v1 §9, §12, R9, R11). OWNER: A7. Server-only.
// One flow service per server process. The approval key (R11) is generated here, in memory, once per process; it is
// never written anywhere. Every misconfiguration returns a fixed refusal code (fail closed); nothing falls back.
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { getSession } from "../src/server/auth.ts";
import { getRun } from "../src/server/agentRuntime.ts";
import { liveBalances, parseAllowlist, usdAvailable } from "../src/server/runtime.ts";
import { readIntegratedFlags } from "./flags.ts";
import type { IntegratedFlags } from "./flags.ts";
import { createFlowService } from "./flowService.ts";
import { gatePort } from "./gateBinding.ts";
import { INTEGRATED_REGISTRY, buildProposal, replayEvidence } from "./proposalBuilder.ts";
import { MOCK_ALLOWLIST, mockProvider, sandboxProvider } from "./paymentAdapter.ts";
import { auditPort } from "./auditChain.ts";
import type { FlowDeps, FlowPageSession, FlowRuntimeSurface, FlowService, FlowView } from "./flowTypes.ts";

/** Fixed balance used by mock mode for proof I. Not money; labelled as such in the UI. */
export const MOCK_BALANCE_USD = "10000000.00";

export type FlowRuntime = { service: FlowService; flags: IntegratedFlags; surface: FlowRuntimeSurface };

type Cache = { key: string; runtime: FlowRuntime | string };
const g = globalThis as unknown as { __drawbridgeFlowRuntime?: Cache };

/** Builds the dependency set. Exported for tests, which inject env and a fixed key. */
export function buildFlowDeps(flags: IntegratedFlags, env: Record<string, string | undefined>, approvalKey: Uint8Array): FlowDeps | string {
  if (flags.ledger) return "LEDGER_NOT_AVAILABLE"; // A2 is not part of this candidate; the flag must not silently no-op
  const sandbox = flags.providerMode === "sandbox";
  const allowlist = sandbox ? parseAllowlist(env.AWX_ALLOWED_BENEFICIARIES) : MOCK_ALLOWLIST;
  if (allowlist.size === 0) return "BENEFICIARY_ALLOWLIST_EMPTY";
  return {
    approvalKey,
    dataDir: flags.dataDir,
    providerMode: flags.providerMode,
    submitRelease: flags.submitRelease,
    gate: gatePort,
    provider: sandbox ? sandboxProvider() : mockProvider({ stateFile: join(flags.dataDir, "mock-provider-state.json") }),
    audit: auditPort,
    ledger: null,
    registry: INTEGRATED_REGISTRY,
    allowlist,
    buildProposal,
    replayEvidence,
    runLookup: (runId) => {
      const run = getRun(runId);
      return run ? { evidence: run.evidence, claims: run.claims } : null;
    },
    balanceUsd: sandbox ? async () => usdAvailable(await liveBalances()) : async () => MOCK_BALANCE_USD,
    ledgerAllocationFor: () => null,
    now: Date.now,
    uuid: () => randomUUID(),
  };
}

function surfaceFor(service: FlowService): FlowRuntimeSurface {
  return {
    session(cookieToken: string | undefined): FlowPageSession | null {
      const s = getSession(cookieToken ?? null);
      return s ? { operator: `human:${s.name}`, csrf: s.csrf } : null;
    },
    views(): FlowView[] | string {
      try {
        return service.listFlowViews();
      } catch {
        return "INTEGRATED_FLOW_UNAVAILABLE";
      }
    },
    view(flowId: string): FlowView | null | string {
      try {
        return service.getFlowView(flowId);
      } catch {
        return "INTEGRATED_FLOW_UNAVAILABLE";
      }
    },
  };
}

/** The process-wide runtime, or a refusal code. Rebuilt only when the relevant configuration changes. */
export function flowRuntime(env: Record<string, string | undefined> = process.env): FlowRuntime | string {
  const flags = readIntegratedFlags(env);
  if (typeof flags === "string") return flags;
  const cacheKey = JSON.stringify([flags, env.AWX_ALLOWED_BENEFICIARIES ?? ""]);
  if (g.__drawbridgeFlowRuntime?.key === cacheKey) return g.__drawbridgeFlowRuntime.runtime;
  let runtime: FlowRuntime | string;
  try {
    const deps = buildFlowDeps(flags, env, randomBytes(32));
    if (typeof deps === "string") runtime = deps;
    else {
      const service = createFlowService(deps);
      runtime = { service, flags, surface: surfaceFor(service) };
    }
  } catch {
    runtime = "INTEGRATED_FLOW_UNAVAILABLE";
  }
  g.__drawbridgeFlowRuntime = { key: cacheKey, runtime };
  return runtime;
}

/** Page helper (A6): the FlowRuntimeSurface or a refusal code. */
export function flowPageSurface(): FlowRuntimeSurface | string {
  const r = flowRuntime();
  return typeof r === "string" ? r : r.surface;
}

export function resetFlowRuntimeForTests(): void {
  g.__drawbridgeFlowRuntime = undefined;
}
