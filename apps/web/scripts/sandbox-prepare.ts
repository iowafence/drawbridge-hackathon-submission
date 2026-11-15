// Operator-side preparation tool for the sandbox integration. It can only READ and PREPARE:
//   node scripts/sandbox-prepare.ts beneficiaries          list existing sandbox beneficiaries (non-sensitive fields)
//   node scripts/sandbox-prepare.ts prepare <beneficiary>  draft the fixed proposal, request review, provider pre-validation
// It cannot approve, formally validate, submit or create anything. Uses the same server environment as the app.
import { listBeneficiaries, SandboxClient } from "../src/server/awx.ts";
import { evaluate, PROPOSAL } from "../src/server/policy.ts";
import { runtimeCtx } from "../src/server/runtime.ts";
import { createDraft, fold, prevalidate, requestReview } from "../src/server/transfers.ts";

const ACTOR = "agent:prepare-cli";
const [cmd, arg] = process.argv.slice(2);
const mask = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

if (cmd === "beneficiaries") {
  const res = await listBeneficiaries(new SandboxClient("transfer"));
  console.log(JSON.stringify(res.ok ? { ...res, items: res.items.map((b) => ({ ...b, id: process.env.SHOW_FULL_ID === "1" ? b.id : mask(b.id) })) } : res, null, 1));
} else if (cmd === "prepare" && arg) {
  const ctx = runtimeCtx();
  if (typeof ctx === "string") throw new Error(ctx);
  const d = evaluate(await ctx.availableUsd());
  console.log(JSON.stringify({ policy: d.recommendation, rule: d.rule, reason: d.reason, proposal: PROPOSAL.proposal_id }));
  const draft = createDraft(ctx, ACTOR, arg);
  console.log(JSON.stringify({ step: "draft", code: draft.code, request_id: draft.request_id }));
  if (draft.ok) {
    console.log(JSON.stringify({ step: "review", ...requestReview(ctx, ACTOR, draft.request_id) }));
    console.log(JSON.stringify({ step: "prevalidate", ...(await prevalidate(ctx, ACTOR, draft.request_id)) }));
    const t = fold(ctx.audit.read()).get(draft.request_id!)!;
    console.log(JSON.stringify({ state: t.state, digest: t.digest, amount_minor: t.amount_minor, currency: t.currency, reference: t.reference, beneficiary: mask(t.beneficiary_id) }));
  }
} else {
  console.error("usage: sandbox-prepare.ts beneficiaries | prepare <beneficiary uuid>");
  process.exit(2);
}
