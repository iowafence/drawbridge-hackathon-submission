import { handleFlowAction } from "../../../../../integrated/flowHandler.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleFlowAction(request);
}
