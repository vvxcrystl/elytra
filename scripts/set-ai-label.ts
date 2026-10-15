import "server-only";
import { getDb } from "../src/server/db";

const [username, mode] = process.argv.slice(2);
const values = { on: 1, off: 0, clear: null } as const;
if (!username || !(mode in values)) {
  console.error("Usage: npm run ai-label -- <username> on|off|clear\n  on: force the AI label on\n  off: force it off\n  clear: remove the override so the account's own setting applies");
  process.exit(1);
}
const db = getDb();
const result = db.prepare("UPDATE users SET ai_operated_override=? WHERE username_lower=?").run(values[mode as keyof typeof values], username.replace(/^@/, "").toLowerCase());
if (!result.changes) { console.error(`No account named @${username}`); process.exit(1); }
console.log(mode === "clear" ? `Removed the AI label override for @${username}` : `AI label forced ${mode} for @${username}`);
db.close();
