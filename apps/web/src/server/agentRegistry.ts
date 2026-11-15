// Trusted, read-only SYNTHETIC registry for the evidence agent: obligations, approvals, document manifest,
// dispute status and registered source documents. Server-only. It is fixture data standing in for systems of record;
// it is not a real approval system. Nothing here is writable at runtime and no model or document can change it.
import { createHash } from "node:crypto";
import registryDoc from "../../fixtures/agent_registry_synthetic_v1.json" with { type: "json" };
import { toMinor } from "./policy.ts";

export type LineItem = { description: string; unit_price: string; quantity: string };
export type Approval = { approval_id: string; status: string; authority: string; payee: string; amount: string; currency: string; conditions: string[]; required_documents: string[] };
export type Obligation = {
  case_id: string; reference: string; payee: string; currency: string; kind: string; funding_source: string;
  amount: { line_items: LineItem[]; retainage: string; retainage_percent?: string; tax: string; credits: string; net_payable: string };
  approval: Approval | null;
  documents: { type: string; status: string }[];
  dispute: { status: string; as_of: string } | null;
  registered_documents: { document_id: string; text: string }[];
};
export type Registry = { provenance: string; authorities: string[]; obligations: Obligation[] };
export type Example = { key: string; label: string; text: string };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
/** The shipped registry. Frozen: no code path can change it at runtime. */
export const SYNTHETIC_REGISTRY: Registry = deepFreeze(structuredClone(registryDoc) as unknown as Registry);
export const EXAMPLES: Example[] = (registryDoc as unknown as { examples: Example[] }).examples;

/** Canonical form of a document for identity: line endings unified, each line trimmed, inner whitespace collapsed,
 *  empty lines dropped. Everything else, including case and punctuation, is significant. */
export function canonicalDocument(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim().replace(/[ \t]+/g, " ")).filter(Boolean).join("\n");
}
export function documentDigest(text: string): string {
  return createHash("sha256").update(canonicalDocument(text), "utf8").digest("hex");
}

const str = (v: unknown): v is string => typeof v === "string";
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

/** Strict structural check of the trusted registry. The gate refuses to decide on a registry that fails it.
 *  Returns null when the registry is well formed, otherwise a short reason. Ambiguity is a failure: case ids,
 *  references, document ids, registered texts and document types within a manifest must each be unique. */
export function validateRegistry(r: unknown): string | null {
  try {
    const reg = r as Registry;
    if (!reg || typeof reg !== "object" || Array.isArray(reg)) return "registry is not an object";
    if (!Array.isArray(reg.authorities) || !reg.authorities.every(text)) return "authorities must be a list of non-empty strings";
    if (!Array.isArray(reg.obligations)) return "obligations must be a list";
    const cases = new Set<string>(), refs = new Set<string>(), docIds = new Set<string>(), digests = new Set<string>();
    for (const o of reg.obligations) {
      if (!o || typeof o !== "object" || Array.isArray(o)) return "an obligation is not an object";
      for (const f of ["case_id", "reference", "payee", "currency", "kind", "funding_source"] as const) if (!text(o[f])) return `obligation field ${f} must be a non-empty string`;
      if (cases.has(o.case_id)) return `duplicate case_id ${o.case_id}`;
      if (refs.has(o.reference.trim())) return `duplicate reference ${o.reference}`;
      cases.add(o.case_id);
      refs.add(o.reference.trim());
      const a = o.amount;
      if (!a || typeof a !== "object" || !Array.isArray(a.line_items)) return `${o.case_id}: amount must have line_items`;
      for (const li of a.line_items) if (!li || typeof li !== "object" || !str(li.unit_price) || !str(li.quantity) || !str(li.description)) return `${o.case_id}: malformed line item`;
      for (const f of ["retainage", "tax", "credits", "net_payable"] as const) if (!str(a[f])) return `${o.case_id}: amount.${f} must be a string`;
      if (a.retainage_percent !== undefined && !str(a.retainage_percent)) return `${o.case_id}: amount.retainage_percent must be a string`;
      if (o.approval !== null) {
        const ap = o.approval;
        if (!ap || typeof ap !== "object" || Array.isArray(ap)) return `${o.case_id}: approval must be an object or null`;
        for (const f of ["approval_id", "status", "authority", "payee", "amount", "currency"] as const) if (!str(ap[f])) return `${o.case_id}: approval.${f} must be a string`;
        if (!strings(ap.conditions)) return `${o.case_id}: approval.conditions must be a list of strings`;
        if (!strings(ap.required_documents)) return `${o.case_id}: approval.required_documents must be a list of strings`;
      }
      if (!Array.isArray(o.documents)) return `${o.case_id}: documents must be a list`;
      const types = new Set<string>();
      for (const d of o.documents) {
        if (!d || typeof d !== "object" || !text(d.type) || !str(d.status)) return `${o.case_id}: malformed document entry`;
        if (types.has(d.type)) return `${o.case_id}: document type ${d.type} is listed more than once`;
        types.add(d.type);
      }
      if (o.dispute !== null && (!o.dispute || typeof o.dispute !== "object" || !str(o.dispute.status) || !str(o.dispute.as_of))) return `${o.case_id}: dispute must be an object with status and as_of, or null`;
      if (!Array.isArray(o.registered_documents)) return `${o.case_id}: registered_documents must be a list`;
      for (const d of o.registered_documents) {
        if (!d || typeof d !== "object" || !text(d.document_id) || !str(d.text)) return `${o.case_id}: malformed registered document`;
        if (canonicalDocument(d.text).length < 20) return `${o.case_id}: registered document ${d.document_id} is empty or too short`;
        const dg = documentDigest(d.text);
        if (docIds.has(d.document_id)) return `duplicate document_id ${d.document_id}`;
        if (digests.has(dg)) return `the same document text is registered more than once (${d.document_id})`;
        docIds.add(d.document_id);
        digests.add(dg);
      }
    }
    return null;
  } catch {
    return "registry could not be read";
  }
}

/** Find the obligation whose registered source document is exactly this text. This is the only trusted binding. */
export function findRegisteredDocument(registry: Registry, text: string): { obligation: Obligation; document_id: string } | null {
  const digest = documentDigest(text);
  for (const obligation of registry.obligations) {
    for (const d of obligation.registered_documents) if (documentDigest(d.text) === digest) return { obligation, document_id: d.document_id };
  }
  return null;
}

/** Exact, case-insensitive comparison key for identifiers and names. Not a substring test. */
export const key = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "").toLowerCase();

/** Lookup by reference: exact equality after trimming. Used only for the untrusted path. */
export function findByReference(registry: Registry, reference: string): Obligation | null {
  const hits = registry.obligations.filter((o) => o.reference.trim() === reference.trim());
  return hits.length === 1 ? hits[0] : null;
}

/** Quantity as an exact integer of thousandths. Up to three decimal places; anything else is refused. */
export function quantityThousandths(q: string): bigint {
  if (typeof q !== "string" || !/^\d{1,9}(\.\d{1,3})?$/.test(q)) throw new Error("INVALID_QUANTITY");
  const [w, f = ""] = q.split(".");
  return BigInt(w) * 1000n + BigInt((f + "000").slice(0, 3));
}

export type Reconciled =
  | { ok: true; subtotal: bigint; retainage: bigint; tax: bigint; credits: bigint; net: bigint; unitPrices: bigint[]; quantities: bigint[] }
  | { ok: false; reason: string };

/** Recompute the net payable from its components with integer arithmetic and require it to equal the recorded net.
 *  net = sum(unit_price x quantity) - retainage + tax - credits. Every step must be exact to the cent. */
export function reconcile(o: Obligation): Reconciled {
  try {
    const a = o.amount;
    if (!Array.isArray(a.line_items) || a.line_items.length === 0) return { ok: false, reason: "no line items recorded" };
    let subtotal = 0n;
    const unitPrices: bigint[] = [];
    const quantities: bigint[] = [];
    for (const li of a.line_items) {
      const unit = toMinor(li.unit_price);
      const qty = quantityThousandths(li.quantity);
      if (unit < 0n) return { ok: false, reason: "negative unit price" };
      const extended = unit * qty;
      if (extended % 1000n !== 0n) return { ok: false, reason: "unit price times quantity is not exact to the cent" };
      subtotal += extended / 1000n;
      unitPrices.push(unit);
      quantities.push(qty);
    }
    const retainage = toMinor(a.retainage);
    const tax = toMinor(a.tax);
    const credits = toMinor(a.credits);
    if (retainage < 0n || tax < 0n || credits < 0n) return { ok: false, reason: "negative retainage, tax or credit" };
    if (a.retainage_percent !== undefined) {
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(a.retainage_percent)) return { ok: false, reason: "invalid retainage percent" };
      const bp = toMinor(a.retainage_percent); // percent with two decimals = basis points
      if ((subtotal * bp) % 10000n !== 0n || (subtotal * bp) / 10000n !== retainage) return { ok: false, reason: "retainage does not equal the recorded percent of the subtotal" };
    }
    const net = subtotal - retainage + tax - credits;
    if (net !== toMinor(a.net_payable)) return { ok: false, reason: "components do not add up to the recorded net payable" };
    return { ok: true, subtotal, retainage, tax, credits, net, unitPrices, quantities };
  } catch {
    return { ok: false, reason: "an amount in the record is not a valid decimal" };
  }
}
