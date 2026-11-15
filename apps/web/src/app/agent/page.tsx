import { redirect } from "next/navigation";

// The agent lives under /sandbox so that it shares the operator session cookie (Path=/sandbox).
export default function AgentAlias() {
  redirect("/sandbox/agent");
}
