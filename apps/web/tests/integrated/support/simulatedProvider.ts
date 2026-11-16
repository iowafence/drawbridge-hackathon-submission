// SIMULATED PROVIDER for the A8-11 and R-3 tests. TEST CODE ONLY. In memory, held by the test, OUTSIDE the server's
// data dir: nothing a data-folder writer does can touch it, as with a real provider.
//
// It models provider properties that are UNVERIFIED for the real Airwallex API. Nothing here is evidence about the
// real provider: not its request-id deduplication, not how soon a created transfer becomes visible to a request-id
// lookup, and not the shape of its list responses. Each knob exists so a test can show what the SYSTEM does when the
// provider behaves that way.
import { randomUUID } from "node:crypto";
import type { ProviderCallResult, ProviderPort, ProviderTransferBody } from "../../../integrated/flowTypes.ts";

/** How the request-id lookup answers. Every shape except NORMAL describes a provider that HOLDS the record but
 *  presents it in a form a careless reader would take for "no record". */
export type LookupShape =
  | "NORMAL"                   // { items: [records with request_id], has_more: false }
  | "CURSOR_WITHOUT_HAS_MORE"  // A8-11 (a): an empty first page with a pagination cursor and NO has_more; the record is on a later page
  | "KEYED_CLIENT_REQUEST_ID"  // A8-11 (b): the record carries our id under client_request_id, with no request_id field
  | "REQUEST_ID_UPPERCASE";    // A8-11 (c): the record's request_id equals ours only case-insensitively

export type SimulatedTransfer = { id: string; status: string; request_id: string; transfer_amount: string; transfer_currency: string; beneficiary_id: string; reference: string };

const http = (status: number, body: unknown): ProviderCallResult => ({ kind: "HTTP", status, body });

export class SimulatedProvider implements ProviderPort {
  readonly mode = "mock" as const;
  /** UNVERIFIED provider property: does a second create with the same request_id get refused as a duplicate? */
  dedup = true;
  /** UNVERIFIED provider property: an accepted transfer that the request-id lookup does not show (yet). */
  lookupLags = false;
  /** While true, a create call does not reach the provider's books until `releaseCreates()`: it is in flight. */
  holdCreates = false;
  createCalls = 0;
  validateCalls = 0;
  lookupCalls = 0;
  /** The provider's own books: one entry per transfer the provider actually created. */
  readonly transfers: SimulatedTransfer[] = [];
  #held: (() => void)[] = [];
  #shape: LookupShape = "NORMAL";
  #armedAt = 0;
  #from = 1;

  /** From the `fromLookup`-th lookup after this call, answer in `shape`. Earlier lookups after this call answer with
   *  an empty, well-formed list (the record is not visible to them yet). */
  arm(shape: LookupShape, fromLookup: 1 | 2 | 3): void {
    this.#shape = shape;
    this.#armedAt = this.lookupCalls;
    this.#from = fromLookup;
  }
  releaseCreates(): void {
    this.holdCreates = false;
    for (const go of this.#held.splice(0)) go();
  }

  async validate(_body: ProviderTransferBody): Promise<ProviderCallResult> {
    this.validateCalls++;
    return http(200, {});
  }
  async create(body: ProviderTransferBody): Promise<ProviderCallResult> {
    this.createCalls++;
    if (this.holdCreates) await new Promise<void>((go) => this.#held.push(go));
    if (this.dedup && this.transfers.some((t) => t.request_id === body.request_id)) return http(400, { code: "request_id_duplicate" });
    const t: SimulatedTransfer = { id: randomUUID(), status: "PROCESSING", request_id: body.request_id, transfer_amount: body.transfer_amount, transfer_currency: body.transfer_currency, beneficiary_id: body.beneficiary_id, reference: body.reference };
    this.transfers.push(t);
    return http(201, t);
  }
  async readById(id: string): Promise<ProviderCallResult> {
    const t = this.transfers.find((x) => x.id === id);
    return t ? http(200, t) : http(404, { code: "not_found" });
  }
  async readByRequestId(requestId: string): Promise<ProviderCallResult> {
    this.lookupCalls++;
    const mine = this.transfers.filter((t) => t.request_id === requestId);
    if (this.#shape === "NORMAL") return http(200, { items: this.lookupLags ? [] : mine, has_more: false });
    if (this.lookupCalls - this.#armedAt < this.#from) return http(200, { items: [], has_more: false });
    switch (this.#shape) {
      case "CURSOR_WITHOUT_HAS_MORE": return http(200, { items: [], page_after: "cursor-page-2" });
      case "KEYED_CLIENT_REQUEST_ID": return http(200, { items: mine.map(({ request_id, ...rest }) => ({ ...rest, client_request_id: request_id })), has_more: false });
      default: return http(200, { items: mine.map((t) => ({ ...t, request_id: t.request_id.toUpperCase() })), has_more: false });
    }
  }
}
