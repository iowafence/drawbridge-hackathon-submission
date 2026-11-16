// Self-check of the test suite itself. It says NOTHING about the product.
//   1. Every scenario is satisfiable: it passes against the reference model (a test oracle under tests/).
//   2. Every scenario has teeth: with one safety rule removed from the reference model (a mutant), at least the
//      scenarios named for that rule fail.
import "../support/netGuard.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { networkAttempts } from "../support/netGuard.ts";
import { MUTANTS, referencePort } from "../support/reference/referenceFlow.ts";
import type { Mutant } from "../support/reference/referenceFlow.ts";
import { SCENARIOS } from "./scenarios.ts";

for (const s of SCENARIOS) {
  test(`${s.id} [reference model, not the product] ${s.title}`, async () => {
    await s.run({ port: referencePort(), spec: { impl: "reference", mutant: null } });
  });
}

/** The scenarios that MUST fail when the rule is removed. Others may fail too. */
const EXPECTED_KILLERS: Record<Mutant, string[]> = {
  APPROVE_NON_ELIGIBLE: ["IT-02", "IT-03", "IT-04", "IT-18"],
  SKIP_PROPOSAL_BINDING: ["IT-04"],
  SKIP_DIGEST_CHECK: ["IT-06", "IT-10"],
  SKIP_GATE_EXPIRY: ["IT-07"],
  SKIP_APPROVAL_EXPIRY: ["IT-07"],
  SKIP_REGISTRY_FRESHNESS: ["IT-09"],
  SKIP_REEVALUATION: ["IT-09"],
  SKIP_BENEFICIARY_RECHECK: ["IT-19"],
  ANY_ACTOR_MAY_APPROVE: ["IT-05"],
  ANY_HUMAN_MAY_SUBMIT: ["IT-05"],
  SUBMIT_WITHOUT_APPROVAL: ["IT-05", "IT-18"],
  GATE_REUSABLE: ["IT-10"],
  SKIP_PROVIDER_VALIDATION: ["IT-01", "IT-14"],
  NO_SINGLE_ATTEMPT_GUARD: ["IT-11", "IT-12"],
  // RETRY_AFTER_UNCERTAIN removes only the no-retry rule. Before the request-id lookup existed, IT-13 (the provider
  // holds a record) and IT-14 (it holds none) both caught it. With the lookup in place a retry in IT-13 is stopped by
  // the lookup as well, so IT-13 can no longer tell this mutant apart; IT-14 still does, because there the provider
  // holds nothing for the lookup to find. IT-13's own power to catch a retry is kept by the next row, which removes
  // the no-retry rule AND bypasses the lookup guard.
  RETRY_AFTER_UNCERTAIN: ["IT-14"],
  RETRY_AFTER_UNCERTAIN_LOOKUP_BYPASSED: ["IT-13", "IT-14"],
  RESUBMIT_ON_RECOVERY: ["IT-15"],
  ACCEPTANCE_IS_PAID: ["IT-01", "IT-16"],
  TRUST_UNKNOWN_STATUS: ["IT-16"],
  SKIP_RECORD_MATCH: ["IT-16"],
  CREATE_ON_RECONCILE: ["IT-14", "IT-18"],
  TERMINAL_NOT_FINAL: ["IT-16"],
  SKIP_APPROVAL_MAC: ["IT-15", "IT-20", "IT-21"],
};

for (const mutant of MUTANTS) {
  test(`MUT ${mutant}: removing this rule from the reference model is detected`, async (t) => {
    const failed: string[] = [];
    for (const s of SCENARIOS) {
      try {
        await s.run({ port: referencePort(mutant), spec: { impl: "reference", mutant } });
      } catch {
        failed.push(s.id);
      }
    }
    t.diagnostic(`${mutant} detected by: ${failed.join(", ") || "NOTHING"}`);
    for (const id of EXPECTED_KILLERS[mutant]) assert.ok(failed.includes(id), `${id} must fail under ${mutant}; failing scenarios: ${failed.join(", ") || "none"}`);
  });
}

test("SELF-NET [reference model] the self-check attempted no real network connection", () => {
  assert.deepEqual(networkAttempts(), []);
});
