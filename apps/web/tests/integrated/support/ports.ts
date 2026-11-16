// Resolves a PortSpec to a FlowPort, in the test process and in child processes alike. TEST CODE ONLY.
import { loadRealPort } from "./adapter/realPort.ts";
import type { FlowPort } from "./port.ts";
import { MUTANTS, referencePort } from "./reference/referenceFlow.ts";
import type { Mutant } from "./reference/referenceFlow.ts";

/** How a child process finds the same port. */
export type PortSpec = { impl: "reference"; mutant: string | null } | { impl: "real" };

export async function resolvePort(spec: PortSpec): Promise<FlowPort> {
  if (spec.impl === "reference") {
    if (spec.mutant !== null && !(MUTANTS as readonly string[]).includes(spec.mutant)) throw new Error("UNKNOWN_MUTANT");
    return referencePort(spec.mutant as Mutant | null);
  }
  const real = await loadRealPort();
  if (!real.port) throw new Error(`REAL_PORT_UNAVAILABLE ${real.reason}`);
  return real.port;
}
