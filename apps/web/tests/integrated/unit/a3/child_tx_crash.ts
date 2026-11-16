// TEST CODE ONLY. A separate OS process that submits one flow and is SIGKILLed INSIDE the intent transaction:
// after the submission-history INTENT line has been appended and fsynced, before the database transaction commits.
// The kill is placed in the audit append for the intent event, which runs inside that transaction after the
// history write. Nothing after the kill runs: no rollback handler, no INTENT_NOT_COMMITTED line.
//
//   node child_tx_crash.ts <dir> <flow_id> <clock_ms>
import { createFlowService } from "../../../../integrated/flowService.ts";
import { OPERATOR, world } from "./support.ts";

const [dir, flowId, clockMs] = process.argv.slice(2);
const w = world(dir, { clock: { t: Number(clockMs) } });
const real = w.deps.audit;
w.deps.audit = {
  ddl: real.ddl,
  verify: (tx, id) => real.verify(tx, id),
  append: (tx, ev) => {
    if (ev.type === "SUBMIT_INTENT_RECORDED") {
      process.kill(process.pid, "SIGKILL");
      for (;;) { /* wait for the signal; never continue */ }
    }
    return real.append(tx, ev);
  },
};
const svc = createFlowService(w.deps);
const r = await svc.submit(OPERATOR, flowId, svc.getFlow(flowId)!.authorization!.authorization_digest);
process.stdout.write(JSON.stringify(r) + "\n");
