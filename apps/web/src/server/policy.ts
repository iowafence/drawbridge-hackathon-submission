// Deterministic payment policy for the sandbox demonstration. Integer minor units only; no floats.
// The result is a RECOMMENDATION. ALLOW never authorizes anything: a human approval is always required.
import proposalDoc from "../../fixtures/sandbox_proposal_v1.json" with { type: "json" };

export const CURRENCY = "USD";
export const EXPONENT = 2;
/** Hard server-side demo cap: 10.00 USD. Not configurable at runtime. */
export const DEMO_CAP_MINOR = 1000n;

export function toMinor(dec: string, exponent = EXPONENT): bigint {
  if (typeof dec !== "string" || !/^-?\d{1,18}(\.\d{1,8})?$/.test(dec)) throw new Error("INVALID_AMOUNT");
  const neg = dec.startsWith("-");
  const [whole, frac = ""] = dec.replace("-", "").split(".");
  if (/[1-9]/.test(frac.slice(exponent))) throw new Error("INVALID_AMOUNT");
  const v = BigInt(whole) * 10n ** BigInt(exponent) + BigInt((frac + "0".repeat(exponent)).slice(0, exponent) || "0");
  return neg ? -v : v;
}

export function fromMinor(minor: bigint, exponent = EXPONENT): string {
  const neg = minor < 0n;
  const s = (neg ? -minor : minor).toString().padStart(exponent + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

export type Proposal = {
  proposal_id: string;
  description: string;
  amount: string;
  currency: string;
  reference: string;
  reason: string;
  transfer_method: string;
  reserve_threshold: string;
};

/** The single synthetic supplier-payment proposal. It is fixture data, not a real payable. */
export const PROPOSAL: Proposal = proposalDoc.proposal;

export type Decision = {
  recommendation: "ALLOW" | "HOLD";
  rule: string;
  reason: string;
  availableMinor: bigint | null;
  amountMinor: bigint | null;
  reserveMinor: bigint;
  capMinor: bigint;
  humanApprovalRequired: true;
};

/** Rules are evaluated in this fixed order; the first that fires decides. */
export function evaluate(availableDec: string | null, proposal: Proposal = PROPOSAL): Decision {
  const reserveMinor = toMinor(proposal.reserve_threshold);
  const base = { reserveMinor, capMinor: DEMO_CAP_MINOR, humanApprovalRequired: true as const };
  const hold = (rule: string, reason: string, availableMinor: bigint | null, amountMinor: bigint | null): Decision =>
    ({ recommendation: "HOLD", rule, reason, availableMinor, amountMinor, ...base });
  let amountMinor: bigint;
  try {
    amountMinor = toMinor(proposal.amount);
  } catch {
    return hold("P-1 INVALID_AMOUNT", "The proposed amount is not a valid decimal amount.", null, null);
  }
  if (proposal.currency !== CURRENCY) return hold("P-2 CURRENCY_NOT_APPROVED", `Only ${CURRENCY} is approved for this demonstration.`, null, amountMinor);
  if (amountMinor <= 0n) return hold("P-1 INVALID_AMOUNT", "The proposed amount must be greater than zero.", null, amountMinor);
  if (amountMinor > DEMO_CAP_MINOR) return hold("P-3 ABOVE_DEMO_CAP", `Proposed ${fromMinor(amountMinor)} exceeds the demo cap of ${fromMinor(DEMO_CAP_MINOR)} ${CURRENCY}.`, null, amountMinor);
  let availableMinor: bigint;
  try {
    if (availableDec === null) throw new Error("none");
    availableMinor = toMinor(availableDec);
  } catch {
    return hold("P-4 SANDBOX_BALANCE_UNAVAILABLE", `No usable ${CURRENCY} available balance was read from the Airwallex sandbox.`, null, amountMinor);
  }
  const after = availableMinor - amountMinor;
  if (after < reserveMinor) {
    return hold("P-5 RESERVE_BREACH", `Available ${fromMinor(availableMinor)} minus proposed ${fromMinor(amountMinor)} leaves ${fromMinor(after)}, below the reserve threshold ${fromMinor(reserveMinor)} ${CURRENCY}.`, availableMinor, amountMinor);
  }
  return {
    recommendation: "ALLOW",
    rule: "P-6 WITHIN_RESERVE",
    reason: `Available ${fromMinor(availableMinor)} minus proposed ${fromMinor(amountMinor)} leaves ${fromMinor(after)}, at or above the reserve threshold ${fromMinor(reserveMinor)} ${CURRENCY}.`,
    availableMinor,
    amountMinor,
    ...base,
  };
}
