// One integrated flow, rendered by the A6 stepper (contract flow-v1). Server component. 404 unless the integrated flow is
// enabled (fail closed) and the id names a known view. Until A7 wires A3's flow service, only labelled UI fixture
// previews resolve here, and they render without any action form.
import { notFound } from "next/navigation";
import { readIntegratedFlags } from "../../../../../integrated/flags.ts";
import { FlowFrame } from "../../../../components/integrated/FlowFrame.tsx";
import { FlowStepper } from "../../../../components/integrated/FlowStepper.tsx";
import { fixtureById } from "../../../../components/integrated/fixtureViews.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "DRAWBRIDGE · Integrated flow" };

export default async function FlowPage({ params }: { params: Promise<{ flowId: string }> }) {
  if (typeof readIntegratedFlags() === "string") notFound();
  const v = fixtureById((await params).flowId);
  if (!v) notFound();
  return (
    <FlowFrame title={`Preview: ${v.fixture.label}`}>
      <p className="muted">{v.fixture.description}{v.fixture.note ? ` ${v.fixture.note}` : ""}</p>
      <FlowStepper view={v} preview />
    </FlowFrame>
  );
}
