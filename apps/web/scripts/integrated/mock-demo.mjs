// Reproducible run of the integrated mock flow against a locally started server (mock provider only).
//
//   1. Choose a demo operator passphrase (12+ characters) and keep it in your shell only:
//        export DEMO_PASSPHRASE='choose-a-local-demo-passphrase'
//   2. Print the matching operator hash and start the server with it (see docs/integrated/INTEGRATED_MOCK_BACKEND.md):
//        node scripts/integrated/mock-demo.mjs hash
//   3. With the server running in mock mode, drive the flow through the real action endpoints:
//        DB_INTEGRATED_DATA_DIR=/absolute/demo/data node scripts/integrated/mock-demo.mjs run
//
// Every step is an HTTP request to the running server (/sandbox/action, /sandbox/flow/action), and every printed result
// is the server's own answer. The browser flow pages are UI previews and are not wired to live flows in this build, so
// the two echo digests a human would read on screen (proposal and gate for approval, authorization for submit) are read
// READ-ONLY from the server's store. The server re-verifies them, the passphrase step-up and the approval signature.
// This script never writes to the store and never contacts a payment provider. Node 22.5+ (node:sqlite).
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BASE = process.env.DEMO_BASE ?? "http://127.0.0.1:3191";
const PASS = process.env.DEMO_PASSPHRASE ?? "";
const CASE = process.env.DEMO_CASE ?? "CASE-SBX-0002";
const DOC = process.env.DEMO_DOCUMENT ?? "DOC-SBX-0002-INV";
const mode = process.argv[2];

if (PASS.length < 12) {
  console.error("Set DEMO_PASSPHRASE (12+ characters) in your shell first.");
  process.exit(2);
}

if (mode === "hash") {
  const salt = randomBytes(16);
  const hash = scryptSync(PASS, salt, 32, { N: 16384, r: 8, p: 1 });
  console.log(`DRAWBRIDGE_OPERATOR_SCRYPT=scrypt:16384:8:1:${salt.toString("base64")}:${hash.toString("base64")}`);
  process.exit(0);
}
if (mode !== "run") {
  console.error("usage: node scripts/integrated/mock-demo.mjs hash|run");
  process.exit(2);
}

const DATA = process.env.DB_INTEGRATED_DATA_DIR;
if (!DATA) {
  console.error("Set DB_INTEGRATED_DATA_DIR to the same absolute data directory the server uses.");
  process.exit(2);
}

let cookie = "";
let csrf = "";

async function post(path, fields) {
  const r = await fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const loc = r.headers.get("location") ?? "";
  const code = new URL(loc || "/", BASE).searchParams.get("m") ?? (await r.text()).trim();
  const flow = /\/sandbox\/flow\/([0-9a-f-]{36})/.exec(loc)?.[1] ?? null;
  return { status: r.status, code, flow };
}

function row(flowId) {
  const db = new DatabaseSync(join(DATA, "flow-v1.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT state, proposal_digest, gate_digest, authorization_json, last_provider_status FROM flow WHERE flow_id = ?").get(flowId);
  } finally {
    db.close();
  }
}

function createCalls() {
  const f = join(DATA, "mock-provider-state.json.creates");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length : 0;
}

function show(step, res, flowId) {
  const r = flowId ? row(flowId) : null;
  console.log(`${step.padEnd(28)} HTTP ${res.status}  ${String(res.code).padEnd(24)} state=${r?.state ?? "-"}  mock creates=${createCalls()}`);
  return r;
}

const login = await post("/sandbox/action", { op: "login", passphrase: PASS });
console.log(`${"login".padEnd(28)} HTTP ${login.status}  ${login.code}`);
csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(BASE + "/sandbox", { headers: { Cookie: cookie } })).text())?.[1] ?? "";
if (!csrf) {
  console.error("Sign-in failed: no session. Check DRAWBRIDGE_OPERATOR_SCRYPT on the server and DEMO_PASSPHRASE here.");
  process.exit(1);
}

const act = (fields) => post("/sandbox/flow/action", { csrf, ...fields });
const created = await act({ op: "create_flow", case_id: CASE });
const id = created.flow;
show(`create_flow ${CASE}`, created, id);
if (!id) process.exit(1);
show("attach_evidence", await act({ op: "attach_evidence", flow_id: id, document_id: DOC }), id);
show("evaluate_gate", await act({ op: "evaluate_gate", flow_id: id }), id);
let r = show("request_human_review", await act({ op: "request_human_review", flow_id: id }), id);
r = show("approve (passphrase step-up)", await act({ op: "approve", flow_id: id, proposal_digest: r.proposal_digest, gate_digest: r.gate_digest, passphrase: PASS }), id);
const authorization = JSON.parse(r.authorization_json ?? "{}").authorization_digest ?? "";
show("submit (once)", await act({ op: "submit", flow_id: id, authorization_digest: authorization, passphrase: PASS }), id);
show("submit again (replay)", await act({ op: "submit", flow_id: id, authorization_digest: authorization, passphrase: PASS }), id);
r = show("reconcile (read status)", await act({ op: "reconcile", flow_id: id }), id);
console.log(`\nflow ${id}: final state ${r.state}, last provider status ${r.last_provider_status}, mock-provider create calls ${createCalls()}.`);
console.log("Mock provider only: nothing was sent to any payment provider and no money exists or moved.");
