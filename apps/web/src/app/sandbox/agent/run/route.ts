import { handleAgentRun } from "../../../../server/agentRuntime.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleAgentRun(request);
}
