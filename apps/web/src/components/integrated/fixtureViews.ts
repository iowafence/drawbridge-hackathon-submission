// A6 UI fixture views (fixtures/integrated/ui/flow_views_v1.json). Read-only, frozen at load. Used for the labelled
// preview until A3's flow service is wired by A7. Never presented as a live flow, approval or transfer.
import doc from "../../../fixtures/integrated/ui/flow_views_v1.json" with { type: "json" };
import type { FlowView } from "../../../integrated/flowTypes.ts";

export type FixtureMeta = { id: string; label: string; description: string; gate_reason: string | null; gate_balance_input: string | null; note: string | null };
export type FixtureView = FlowView & { fixture: FixtureMeta };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export const FIXTURE_PROVENANCE: string = (doc as { provenance: string }).provenance;
export const FIXTURE_VIEWS: readonly FixtureView[] = deepFreeze(structuredClone((doc as unknown as { views: FixtureView[] }).views));

/** Strict id lookup: exact fixture id only (^[a-z0-9-]{1,40}$). Anything else is null. */
export function fixtureById(id: unknown): FixtureView | null {
  if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id)) return null;
  return FIXTURE_VIEWS.find((v) => v.fixture.id === id) ?? null;
}
