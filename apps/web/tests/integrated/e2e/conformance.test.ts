// End-to-end conformance of the MERGED implementation to the flow-v1 scenarios, through its public exports only
// (createFlowService, gatePort, buildProposal, replayEvidence, auditPort). Offline: the provider is this suite's
// mock, and the network guard fails any real connection attempt.
// When the implementation is not merged, every scenario is reported as SKIPPED. A skip is not a pass.
import "../support/netGuard.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS } from "../contract/scenarios.ts";
import { loadRealPort } from "../support/adapter/realPort.ts";
import { networkAttempts } from "../support/netGuard.ts";

const real = await loadRealPort();
const skip = real.port || real.broken ? false : `NOT RUN: ${real.reason}`;

test("E2E-00 [implementation] the merged modules expose the flow-v1 public exports", { skip }, (t) => {
  assert.equal(real.broken, false, real.reason);
  t.diagnostic(`audit port in use: ${real.audit}`);
});

for (const s of SCENARIOS) {
  test(`${s.id} [implementation] ${s.title}`, { skip }, async () => {
    assert.ok(real.port, real.reason);
    await s.run({ port: real.port, spec: { impl: "real" } });
  });
}

test("E2E-NET [implementation] the conformance run attempted no real network connection", { skip }, () => {
  assert.deepEqual(networkAttempts(), []);
});
