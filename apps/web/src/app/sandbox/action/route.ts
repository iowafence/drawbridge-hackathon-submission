import { handleAction } from "../../../server/handler.ts";
import { runtimeCtx } from "../../../server/runtime.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleAction(request, { ctx: runtimeCtx });
}
