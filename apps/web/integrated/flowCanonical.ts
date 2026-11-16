// DRAWBRIDGE integrated flow — contract flow-v1 canonical encoding and digests. OWNER: A7 (contract).
// Every lane computes digests ONLY through these functions. Golden vectors: tests/integrated/a7/contract_pins.test.ts.
//
// Encoding (CANON-1): the same sorted-key JSON form as audit.ts `canonical`, but STRICT:
//   - allowed values: string (well-formed UTF-16, Unicode NFC), safe integer, boolean, null, array, plain object;
//   - refused: undefined (anywhere, including object values), non-integer or unsafe numbers, -0, NaN, Infinity,
//     bigint, Date, Map, class instances, functions, symbols; (flow-v1.1.1) sparse arrays, arrays with extra
//     properties, accessor (getter/setter) properties and symbol-keyed properties;
//   - object keys must match ^[A-Za-z][A-Za-z0-9_]{0,63}$ (flow-v1.1; uppercase needed for proof ids S, A..J);
//     keys are sorted by JavaScript default (UTF-16 code unit) order, so uppercase sorts before lowercase;
//   - absent and null are different: an absent key is not encoded; null is encoded as null. Digest inputs defined
//     in flowTypes.ts have NO optional keys, so every field is always present.
// Digest: sha256 hex (lowercase) of  "DRAWBRIDGE-FLOW-V1" 0x00 <domain> 0x00 <CANON-1 text>  encoded as UTF-8.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AuthorizationRecord, FlowProposal, GateRecord } from "./flowTypes.ts";

export const DIGEST_PREFIX = "DRAWBRIDGE-FLOW-V1";
export type DigestDomain = "proposal" | "gate" | "authorization" | "registry" | "claims" | "audit_event";
const DOMAINS: readonly DigestDomain[] = ["proposal", "gate", "authorization", "registry", "claims", "audit_event"];

export class CanonicalError extends Error {
  code: string;
  constructor(code: string, path: string) {
    super(`${code} at ${path}`);
    this.code = code;
  }
}

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function enc(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      if (LONE_SURROGATE.test(v)) throw new CanonicalError("CANON_STRING_NOT_WELL_FORMED", path);
      if (v.normalize("NFC") !== v) throw new CanonicalError("CANON_STRING_NOT_NFC", path);
      return JSON.stringify(v);
    case "number":
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new CanonicalError("CANON_NUMBER_NOT_SAFE_INTEGER", path);
      return String(v);
    case "boolean":
      return v ? "true" : "false";
    case "object": {
      if (Object.getOwnPropertySymbols(v).length) throw new CanonicalError("CANON_KEY_INVALID", path);
      if (Array.isArray(v)) {
        // flow-v1.1.1: holes ([,1]) or extra non-index properties would otherwise encode silently (holes as "[,1]").
        if (Object.keys(v).length !== v.length) throw new CanonicalError("CANON_ARRAY_MALFORMED", path);
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) parts.push(enc(v[i], `${path}[${i}]`));
        return `[${parts.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError("CANON_NOT_PLAIN_OBJECT", path);
      for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) if (!("value" in d)) throw new CanonicalError("CANON_ACCESSOR_REFUSED", path);
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => {
        if (!KEY.test(k)) throw new CanonicalError("CANON_KEY_INVALID", `${path}.${k}`);
        if (o[k] === undefined) throw new CanonicalError("CANON_UNDEFINED", `${path}.${k}`);
        return `${JSON.stringify(k)}:${enc(o[k], `${path}.${k}`)}`;
      }).join(",")}}`;
    }
    default:
      throw new CanonicalError(v === undefined ? "CANON_UNDEFINED" : "CANON_TYPE_REFUSED", path);
  }
}

/** CANON-1 text of a value. Throws CanonicalError; callers must fail closed. */
export function canonicalText(v: unknown): string {
  return enc(v, "$");
}

export function flowDigest(domain: DigestDomain, v: unknown): string {
  if (!DOMAINS.includes(domain)) throw new CanonicalError("CANON_DOMAIN_UNKNOWN", domain);
  return createHash("sha256").update(`${DIGEST_PREFIX}\u0000${domain}\u0000${canonicalText(v)}`, "utf8").digest("hex");
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Field rules for FlowProposal. Mirrors transfers.ts localChecks (not exported there) plus flow-v1 additions.
 *  Returns null when valid, otherwise a fixed refusal code. */
export function proposalProblem(p: FlowProposal): string | null {
  const keys = ["flow_id", "obligation_id", "payee", "beneficiary_id", "beneficiary_label", "amount_minor", "currency", "reference", "transfer_method", "reason", "provider_request_id"];
  if (!p || typeof p !== "object" || Object.keys(p).sort().join(",") !== [...keys].sort().join(",")) return "PROPOSAL_SHAPE";
  if (!UUID4.test(p.flow_id)) return "INVALID_FLOW_ID";
  if (!UUID4.test(p.provider_request_id)) return "INVALID_PROVIDER_REQUEST_ID";
  if (!UUID_ANY.test(p.beneficiary_id)) return "INVALID_BENEFICIARY_ID";
  if (typeof p.obligation_id !== "string" || !/^[A-Z0-9-]{3,40}$/.test(p.obligation_id)) return "INVALID_OBLIGATION_ID";
  if (typeof p.payee !== "string" || p.payee.trim() !== p.payee || p.payee.length < 1 || p.payee.length > 120) return "INVALID_PAYEE";
  if (typeof p.beneficiary_label !== "string" || !/^[A-Za-z0-9 ()._-]{1,60}$/.test(p.beneficiary_label)) return "INVALID_BENEFICIARY_LABEL";
  if (typeof p.amount_minor !== "string" || !/^[1-9][0-9]{0,17}$/.test(p.amount_minor)) return "INVALID_AMOUNT";
  if (p.currency !== "USD") return "CURRENCY_NOT_APPROVED";
  if (typeof p.reference !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(p.reference)) return "INVALID_REFERENCE";
  if (p.transfer_method !== "LOCAL") return "METHOD_NOT_APPROVED";
  if (typeof p.reason !== "string" || !/^[a-z_]{3,40}$/.test(p.reason)) return "INVALID_REASON";
  return null;
}

export function proposalDigest(p: FlowProposal): string {
  return flowDigest("proposal", p);
}

export function gateDigest(g: Omit<GateRecord, "gate_digest">): string {
  return flowDigest("gate", g);
}

export function authorizationDigest(a: Omit<AuthorizationRecord, "authorization_digest">): string {
  return flowDigest("authorization", a);
}

/** flow-v1.2 R11: approval MAC. HMAC-SHA256 over a domain-separated authorization digest with the server-held key.
 *  Throws on a key shorter than 32 bytes or a malformed digest (callers fail closed). */
export const APPROVAL_KEY_MIN_BYTES = 32;
export function approvalMac(key: Uint8Array, authorizationDigestHex: string): string {
  if (!(key instanceof Uint8Array) || key.length < APPROVAL_KEY_MIN_BYTES) throw new CanonicalError("APPROVAL_KEY_INVALID", "approvalKey");
  if (typeof authorizationDigestHex !== "string" || !/^[0-9a-f]{64}$/.test(authorizationDigestHex)) throw new CanonicalError("APPROVAL_DIGEST_INVALID", "authorization_digest");
  return createHmac("sha256", key).update(`${DIGEST_PREFIX}\u0000approval_mac\u0000${authorizationDigestHex}`, "utf8").digest("hex");
}
/** Constant-time check. False for any malformed input; never throws. */
export function approvalMacValid(key: Uint8Array, authorizationDigestHex: string, mac: unknown): boolean {
  try {
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
    return timingSafeEqual(Buffer.from(approvalMac(key, authorizationDigestHex), "hex"), Buffer.from(mac, "hex"));
  } catch {
    return false;
  }
}
