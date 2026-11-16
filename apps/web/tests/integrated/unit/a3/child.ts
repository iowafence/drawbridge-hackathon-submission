// TEST CODE ONLY. A separate OS process that attempts one submit against a shared flow store and a shared file-backed
// mock provider. Used to prove cross-process single-attempt behavior and crash recovery. A "crash" is a real SIGKILL
// of this process at the named point, so nothing after that point (no cleanup, no handler) runs.
//
//   node child.ts <dir> <flow_id> <crash: none|beforeIntent|afterIntent|afterCreate|afterRead> <clock_ms>
// "afterRead" runs reconcile (not submit) and dies after the provider read returned, before anything is written.
import { OPERATOR, submit, world } from "./support.ts";

const [dir, flowId, crash, clockMs] = process.argv.slice(2);
const die = () => {
  process.kill(process.pid, "SIGKILL");
  for (;;) { /* wait for the signal; never continue */ }
};
const w = world(dir, { clock: { t: Number(clockMs) }, hooks: crash === "none" ? {} : { [crash]: die } });
const r = crash === "afterRead" ? await w.svc.reconcile(OPERATOR, flowId) : await submit(w, flowId, OPERATOR);
process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code, state: w.svc.getFlow(flowId)?.state ?? null }) + "\n");
