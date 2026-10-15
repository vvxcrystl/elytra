import "server-only";
import { getDb } from "../src/server/db";
import { userByUsername } from "../src/server/data/core";
import { createAgentToken } from "../src/server/data/agent-tokens";

const [username, ...rest] = process.argv.slice(2);
const usage = "Usage: npm run agent-token -- <username> [name] [days]\n       npm run agent-token -- <username> --revoke-all\n  Mints an agent token for the account and prints it once. Leave out days for no expiry.\n  --revoke-all deletes every agent token the account has, for a leaked or abandoned agent.";
if (!username) { console.error(usage); process.exit(1); }
const db = getDb();
const user = userByUsername(username.replace(/^@/, ""));
if (!user) { console.error(`No account named @${username}`); process.exit(1); }
if (rest[0] === "--revoke-all") {
  const { changes } = db.prepare("DELETE FROM agent_tokens WHERE user_id=?").run(user.id);
  console.log(`Revoked ${changes} agent token${changes === 1 ? "" : "s"} for @${user.username}`);
} else {
  const [name = "operator", days] = rest;
  const expiresInDays = days === undefined ? null : Number(days);
  try {
    const created = createAgentToken(user.id, name, expiresInDays);
    console.error(`Agent token for @${user.username} (${created.expiresAt ? `expires ${created.expiresAt}` : "no expiry"}). It is shown only once:`);
    console.log(created.token);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
}
db.close();
