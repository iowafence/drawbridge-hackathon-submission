// Owner directive 8 coverage that A7 can own before A3 merges: canonical encoding and malformed input, uppercase proof
// keys, and strict subprocess confinement. Implementation coverage (beneficiary re-check, persistence before provider,
// crash/timeout/replay/duplicate refusal) runs against the merged A3/A1 code; see contracts/integrated/flow-v1.md §15.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalText, CanonicalError, flowDigest, gateDigest } from "../../../integrated/flowCanonical.ts";
import { PROOF_IDS } from "../../../integrated/flowTypes.ts";
import { subprocessViolations } from "./rules.ts";

const refusedWith = (v: unknown, code: string) => assert.throws(() => canonicalText(v), (e: unknown) => e instanceof CanonicalError && e.code === code, `${code}: ${String(v)}`);

test("SEC-C1 malformed inputs are refused, never silently encoded", () => {
  const sparse = [1, 2, 3]; delete (sparse as unknown[])[1];
  const extra = Object.assign([1, 2], { x: 3 });
  const getter = Object.defineProperty({}, "a", { get: () => "x", enumerable: true });
  const sym = { a: 1, [Symbol("s")]: 2 };
  refusedWith([, 1], "CANON_ARRAY_MALFORMED");
  refusedWith(sparse, "CANON_ARRAY_MALFORMED");
  refusedWith({ a: [1, , 2] }, "CANON_ARRAY_MALFORMED");
  refusedWith(extra, "CANON_ARRAY_MALFORMED");
  refusedWith(getter, "CANON_ACCESSOR_REFUSED");
  refusedWith(sym, "CANON_KEY_INVALID");
  refusedWith({ a: { b: { c: undefined } } }, "CANON_UNDEFINED");
  refusedWith({ a: Infinity }, "CANON_NUMBER_NOT_SAFE_INTEGER");
  refusedWith({ a: -Infinity }, "CANON_NUMBER_NOT_SAFE_INTEGER");
  refusedWith({ a: 0.1 }, "CANON_NUMBER_NOT_SAFE_INTEGER");
  refusedWith({ a: Symbol("x") }, "CANON_TYPE_REFUSED");
  refusedWith({ a: () => 1 }, "CANON_TYPE_REFUSED");
  refusedWith({ a: new Map() }, "CANON_NOT_PLAIN_OBJECT");
  refusedWith({ a: new (class X { y = 1 })() }, "CANON_NOT_PLAIN_OBJECT");
  refusedWith({ _a: 1 }, "CANON_KEY_INVALID");
  refusedWith({ __proto__x: 1 }, "CANON_KEY_INVALID");
  refusedWith({ "é": 1 }, "CANON_KEY_INVALID");
  refusedWith({ [`a${"b".repeat(64)}`]: 1 }, "CANON_KEY_INVALID");
  refusedWith({ a: "\uDC00x" }, "CANON_STRING_NOT_WELL_FORMED");
  assert.throws(() => flowDigest("nonsense" as "gate", {}), (e: unknown) => e instanceof CanonicalError && e.code === "CANON_DOMAIN_UNKNOWN");
});

test("SEC-C2 encoding is deterministic and unambiguous", () => {
  assert.equal(canonicalText({ b: 1, a: [true, null, "x"] }), canonicalText({ a: [true, null, "x"], b: 1 }), "insertion order irrelevant");
  assert.equal(canonicalText(Object.assign(Object.create(null), { a: 1 })), '{"a":1}', "null-prototype plain object accepted");
  assert.notEqual(flowDigest("claims", { a: "1" }), flowDigest("claims", { a: 1 }), "string vs integer");
  assert.notEqual(flowDigest("claims", { a: [] }), flowDigest("claims", { a: {} }));
  assert.notEqual(flowDigest("claims", { a: "" }), flowDigest("claims", { a: null }));
  assert.equal(canonicalText({ a: 'q"\\\n\u0001' }), JSON.stringify({ a: 'q"\\\n\u0001' }), "string escaping is JSON's");
});

test("SEC-C3 uppercase proof keys S, A..J encode, sort before lowercase, and are each bound", () => {
  const states = Object.fromEntries(PROOF_IDS.map((id) => [id, "VERIFIED"]));
  assert.equal(canonicalText(states), `{${[...PROOF_IDS].sort().map((k) => `"${k}":"VERIFIED"`).join(",")}}`);
  assert.equal(canonicalText({ a: 1, A: 1, S: 1 }), '{"A":1,"S":1,"a":1}');
  assert.notEqual(flowDigest("claims", { A: 1 }), flowDigest("claims", { a: 1 }), "case-sensitive keys");
  const base = { flow_id: "00000000-0000-4000-8000-000000000001", proposal_digest: "0".repeat(64), evidence_source: "FIXTURE_REPLAY" as const, evidence_digest: "1".repeat(64), document_id: null, document_binding: "REGISTERED_DOCUMENT" as const, registry_digest: "2".repeat(64), claims_digest: null, policy_version: "agentPolicy.evaluate/11-proof/v1@6063b1c" as const, decision: "ELIGIBLE_FOR_HUMAN_REVIEW" as const, rule: "P-ALL VERIFIED", gate_refused: false, proof_states: states as never, balance_minor: null, evaluated_at_ms: 1, expires_at_ms: 2 };
  const d = gateDigest(base);
  for (const id of PROOF_IDS) assert.notEqual(gateDigest({ ...base, proof_states: { ...states, [id]: "MISSING" } as never }), d, `proof ${id} bound`);
  assert.notEqual(gateDigest({ ...base, proof_states: { ...states, s: "VERIFIED" } as never }), d, "a smuggled lowercase key changes the digest");
});

test("SEC-C4 subprocess confinement rule catches every escape (self-test of the isolation rule)", () => {
  const F = "integrated/ledgerPsql.ts";
  assert.deepEqual(subprocessViolations(F, 'import { execFile } from "node:child_process";\nexecFile(bin, ["-X", "-c", sql], cb);'), []);
  const bad = [
    'import { exec } from "node:child_process";',
    'import { execFile, spawn } from "node:child_process";',
    'import { execFileSync } from "node:child_process";',
    'import * as cp from "node:child_process";',
    'import cp from "node:child_process";',
    'import { execFile } from "child_process";',
    'import { execFile } from "node:child_process"; execFile("psql", [], { shell: true });',
    'import { execFile } from "node:child_process"; execFile("bash", ["-c", x]);',
    'const cp = require("node:child_process");',
    'const cp = await import("node:child_process");',
    'import { execFile } from "node:child_process"; const m = "child_process";',
    'import { execFile } from "node:child_process"; new Function("x")();',
  ];
  for (const b of bad) assert.notDeepEqual(subprocessViolations(F, b), [], `must refuse: ${b}`);
  assert.notDeepEqual(subprocessViolations("integrated/ledgerAdapter.ts", 'import { execFile } from "node:child_process";'), []);
  assert.notDeepEqual(subprocessViolations("integrated/flowService.ts", "// child_process"), []);
});

test("SEC-C5 flow-v1.2 R11 approval MAC: golden vector, key binding, fail-closed inputs", async () => {
  const { approvalMac, approvalMacValid, APPROVAL_KEY_MIN_BYTES } = await import("../../../integrated/flowCanonical.ts");
  const K = new Uint8Array(32).fill(7);
  const D = "b385dc9b438e60fe01eb94a88c01224e0d90b0bcedfbd29c7c9f6757498fcaa7";
  assert.equal(approvalMac(K, D), "967056a4a7775a80699c3b0a941057b2e24a8bd0700918c36a2b25213379aeb3", "Python hmac reproduces this");
  assert.equal(approvalMacValid(K, D, approvalMac(K, D)), true);
  assert.equal(approvalMacValid(new Uint8Array(32).fill(8), D, approvalMac(K, D)), false, "another process's key does not verify");
  assert.equal(approvalMacValid(K, "c" + D.slice(1), approvalMac(K, D)), false, "bound to the exact authorization digest");
  for (const bad of [null, undefined, "", "x".repeat(64), approvalMac(K, D).toUpperCase(), approvalMac(K, D).slice(1)]) assert.equal(approvalMacValid(K, D, bad), false);
  assert.equal(APPROVAL_KEY_MIN_BYTES, 32);
  assert.throws(() => approvalMac(new Uint8Array(31), D), (e: unknown) => e instanceof CanonicalError && e.code === "APPROVAL_KEY_INVALID");
  assert.throws(() => approvalMac(K, "nothex"), (e: unknown) => e instanceof CanonicalError && e.code === "APPROVAL_DIGEST_INVALID");
  assert.equal(approvalMacValid(new Uint8Array(0), D, approvalMac(K, D)), false, "a missing key never verifies");
});
