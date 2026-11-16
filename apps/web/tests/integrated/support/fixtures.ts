// Non-mutating fixture factories for the integrated-flow tests (contract flow-v1). TEST CODE ONLY.
// Every factory returns a fresh object. Registries are only ever cloned, never edited in place.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AmountClaim, Claim, Claims } from "../../../src/server/agentPolicy.ts";
import { SYNTHETIC_REGISTRY } from "../../../src/server/agentRegistry.ts";
import type { Obligation, Registry } from "../../../src/server/agentRegistry.ts";

export const T0 = 1_800_000_000_000;
/** flow-v1 §7: mock mode reads a fixed sandbox balance. */
export const BALANCE = "10000000.00";

// flow-v1 §5 and §12: the one obligation that can become eligible, and the mock allowlist entry it binds to.
export const CASE = "CASE-SBX-0002";
export const CASE_REFERENCE = "DB-SBX-0002";
export const CASE_DOCUMENT = "DOC-SBX-0002-INV";
export const BEN_ID = "00000000-0000-4000-8000-0000000000be";
export const BEN_LABEL = "Synthetic test supplier";
export const BENEFICIARIES: [string, string][] = [[BEN_ID, BEN_LABEL]];
export const E3_RESERVED_BENEFICIARY_ID = "00000000-0000-4000-8000-0000000e3000";

export const HUMAN = "human:operator";
export const OTHER_HUMAN = "human:second-operator";
/** Callers that are not an authenticated human operator. */
export const NOT_HUMAN = ["agent:evidence-analysis", "server", "system:recovery", "", "humanoid:operator", "HUMAN:operator"];

/** The registry the reference model uses: the shipped synthetic registry, unchanged, plus the flow-v1 §5 additions
 *  built here independently of the gate-binding lane's fixture. The real binding uses that lane's registry instead. */
export function testRegistry(): Registry {
  const r = structuredClone(SYNTHETIC_REGISTRY) as Registry;
  const payable = (case_id: string, reference: string, payee: string, net: string, funding_source: string, document_id: string, scope: string): Obligation => ({
    case_id, reference, payee, currency: "USD", kind: "PAYABLE", funding_source,
    amount: { line_items: [{ description: scope, unit_price: net, quantity: "1" }], retainage: "0.00", tax: "0.00", credits: "0.00", net_payable: net },
    approval: { approval_id: `PM-${reference}`, status: "APPROVED", authority: "PM-SYNTH-01", payee, amount: net, currency: "USD", conditions: [], required_documents: ["SIGNED_DELIVERY_TICKET", "CONDITIONAL_LIEN_WAIVER"] },
    documents: [{ type: "SIGNED_DELIVERY_TICKET", status: "RECEIVED" }, { type: "CONDITIONAL_LIEN_WAIVER", status: "RECEIVED" }],
    dispute: { status: "CLEAR", as_of: "2026-11-15" },
    registered_documents: [{ document_id, text: `SYNTHETIC TEST DOCUMENT - SUPPLIER PAYMENT REQUEST\nFrom: ${payee} (synthetic supplier)\nInvoice: ${reference}\nAmount due: $${net} USD\nScope: ${scope}.\nNo disputes are open on this invoice.` }],
  });
  r.obligations.push(
    payable(CASE, CASE_REFERENCE, "Prairie Test Concrete LLC", "5.00", "SANDBOX_DEMO", CASE_DOCUMENT, "sample cylinder testing, pour 5"),
    payable("CASE-E3-OBL-STEEL", "REQ-STEEL-001", "Synthetic Steel Erectors", "420000.00", "E3_PROJECT", "DOC-E3-STEEL", "structural steel, sequence 2"),
  );
  return r;
}
/** Case bindings the reference model uses (flow-v1 §5 `flow_bindings_v1.json` shape, reduced). */
export const TEST_BINDINGS: Record<string, { beneficiary_label: string; reason: string; e3: boolean }> = {
  [CASE]: { beneficiary_label: BEN_LABEL, reason: "goods_purchased", e3: false },
  "CASE-E3-OBL-STEEL": { beneficiary_label: "E3 no provider beneficiary", reason: "goods_purchased", e3: true },
};

/** Named changes to the trusted registry. Each one edits a clone. "baseline" changes nothing. */
const VARIANTS = {
  baseline: () => {},
  dispute_opened: (r: Registry) => { ob(r).dispute = { status: "OPEN", as_of: "2026-11-16" }; },
  approval_revoked: (r: Registry) => { ob(r).approval!.status = "REVOKED"; },
  approval_conditional: (r: Registry) => { ob(r).approval!.conditions = ["RECEIPT_OF_LIEN_WAIVER"]; },
  document_missing: (r: Registry) => { ob(r).documents[1].status = "MISSING"; },
  amount_changed: (r: Registry) => { const o = ob(r); o.amount.line_items[0].unit_price = "6.00"; o.amount.net_payable = "6.00"; o.approval!.amount = "6.00"; },
  payee_changed: (r: Registry) => { const o = ob(r); o.payee = "Redwing Test Electric Co."; o.approval!.payee = "Redwing Test Electric Co."; },
  reference_changed: (r: Registry) => { ob(r).reference = "DB-SBX-0003"; },
  currency_changed: (r: Registry) => { const o = ob(r); o.currency = "EUR"; o.approval!.currency = "EUR"; },
  // no dispute record at all: unknown is not clearance, so the gate answers REVIEW
  dispute_unrecorded: (r: Registry) => { ob(r).dispute = null; },
  // a different obligation changes; this one is untouched, but the registry is no longer the evaluated version
  unrelated_change: (r: Registry) => { ob(r, "CASE-RTE-0101").dispute = { status: "CLEAR", as_of: "2026-11-16" }; },
  // structurally invalid registry: the gate must refuse to decide
  invalid_duplicate_reference: (r: Registry) => { ob(r, "CASE-RTE-0101").reference = CASE_REFERENCE; },
} satisfies Record<string, (r: Registry) => void>;
export type RegistryVariant = keyof typeof VARIANTS;
export const REGISTRY_VARIANTS = Object.keys(VARIANTS) as RegistryVariant[];

function ob(r: Registry, case_id: string = CASE): Obligation {
  const o = r.obligations.find((x) => x.case_id === case_id);
  if (!o) throw new Error(`FIXTURE_OBLIGATION_MISSING ${case_id}`);
  return o;
}
export function applyVariant(base: Registry, variant: RegistryVariant): Registry {
  const r = structuredClone(base) as Registry;
  VARIANTS[variant](r);
  return r;
}
export const obligation = (base: Registry, case_id: string = CASE): Obligation => ob(structuredClone(base) as Registry, case_id);
export const registeredText = (base: Registry, case_id: string = CASE): string => obligation(base, case_id).registered_documents[0].text;

const q = (value: string): Claim => ({ value, quote: value, start: 0, end: value.length, grounding: "QUOTED" });
const amt = (kind: string, value: string): AmountClaim => ({ kind, ...q(value) });
/** The worst-case model: it claims exactly what eligibility needs and reports nothing adverse. */
export function cooperativeClaims(o: Obligation, extra: Partial<Claims> = {}): Claims {
  return { reference: q(o.reference), payee: q(o.payee), currency: q(o.currency), amounts: [amt("NET_PAYABLE", o.amount.net_payable)], adverse: [], ...extra };
}

const REPO_APP_ROOT = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", ".."));
const REPO_ROOT = realpathSync(join(REPO_APP_ROOT, "..", ".."));

/** A private directory for one test, under the OS temp directory. Never inside the checkout, never shared. */
export function privateDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `dbit-${label}-`)));
  if (dir === REPO_ROOT || dir.startsWith(REPO_ROOT + sep)) throw new Error("TEST_DIR_INSIDE_CHECKOUT");
  return dir;
}
