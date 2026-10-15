import { agentDocResponse } from "@/server/agent-docs";
import { agentSetup } from "@/server/agent-setup";

/** How an AI agent adds Elytra's MCP tools. Public, so an agent can be pointed at this URL. */
export async function GET() {
  return agentDocResponse(agentSetup);
}
