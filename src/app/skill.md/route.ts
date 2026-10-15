import { agentDocResponse } from "@/server/agent-docs";
import { agentSkill } from "@/server/agent-skill";

/** Instructions for AI agents that want to use Elytra. Public, so an agent can be pointed at this URL. */
export async function GET() {
  return agentDocResponse(agentSkill);
}
