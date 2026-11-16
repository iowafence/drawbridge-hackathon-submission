// One operation of the system under test, run in its own process. TEST CODE ONLY.
// Used for cross-process races and for crash recovery (the mock provider can kill this process mid-call).
import "./netGuard.ts";
import { World } from "./port.ts";
import { resolvePort } from "./ports.ts";
import type { PortSpec } from "./ports.ts";

type Args = { dir: string; spec: PortSpec; op: "approve" | "submit" | "approve_then_die"; actor: string; flow_id: string; digests: string[] };
const a = JSON.parse(process.argv[2]) as Args;
const sys = await (await resolvePort(a.spec)).open(new World(a.dir));
if (a.op === "approve_then_die") {
  const out = await sys.approve(a.actor, a.flow_id, a.digests[0], a.digests[1]);
  if (!out.ok) {
    process.stderr.write(`approval refused: ${out.code}`);
    process.exit(3);
  }
  process.kill(process.pid, "SIGKILL"); // no clean shutdown: nothing after the approval commit gets to run
}
const out = a.op === "approve" ? await sys.approve(a.actor, a.flow_id, a.digests[0], a.digests[1]) : await sys.submit(a.actor, a.flow_id, a.digests[0]);
process.stdout.write(JSON.stringify(out));
