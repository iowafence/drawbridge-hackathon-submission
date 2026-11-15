import { derive } from "../contract/derive.ts";
import type { Derived } from "../contract/derive.ts";
import type { ScenarioId, Snapshot } from "../contract/types.ts";
import { fixtureAdapter, isScenarioId } from "./adapter.ts";

export type SearchParams = Promise<{ s?: string | string[] }>;

export async function loadScenario(searchParams: SearchParams): Promise<{ id: ScenarioId; snap: Snapshot; d: Derived }> {
  const raw = (await searchParams).s;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id: ScenarioId = isScenarioId(value) ? value : "S0";
  const snap = await fixtureAdapter.getSnapshot(id);
  return { id, snap, d: derive(snap) };
}
