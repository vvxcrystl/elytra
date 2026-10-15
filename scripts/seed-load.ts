import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { getDb, transaction } from "../src/server/db";
import { createUser, createSession } from "../src/server/data/core";

const path = process.env.ELYTRA_LOAD_FIXTURE_DB, tokensFile = process.env.ELYTRA_LOAD_TOKENS_FILE;
if (!path || !tokensFile || path === ":memory:") throw new Error("Set ELYTRA_LOAD_FIXTURE_DB to a NEW file and ELYTRA_LOAD_TOKENS_FILE to a NEW private JSON file");
for (const file of [path, tokensFile]) {
  const exists = await access(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (exists) throw new Error(`Refusing to replace existing file: ${file}`);
}
function size(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 2 || value > max) throw new Error(`${name} must be between 2 and ${max}`);
  return value;
}
const users = size("ELYTRA_LOAD_USERS", 100, 10000), posts = size("ELYTRA_LOAD_POSTS", 10000, 1000000);
process.env.ELYTRA_DB_PATH = resolve(path);
process.env.ELYTRA_SEED_DEMO = "false";
const db = getDb(), accounts: { id: string; username: string; accessToken: string }[] = [];
try {
  for (let i = 0; i < users; i++) {
    const username = `load_${String(i).padStart(6, "0")}`;
    const user = await createUser(username, `Load user ${i}`, randomBytes(24).toString("hex"));
    accounts.push({ id: user.id, username, accessToken: createSession(user.id).token });
  }
  const now = Date.now();
  const post = db.prepare("INSERT INTO posts VALUES(?,?,?,?,?,?)"), like = db.prepare("INSERT INTO likes VALUES(?,?,?)");
  const follow = db.prepare("INSERT OR IGNORE INTO follows VALUES(?,?,?)"), tag = db.prepare("INSERT INTO hashtags VALUES(?,?)");
  transaction(() => {
    accounts.forEach((account, i) => {
      for (let j = 1; j <= Math.min(10, users - 1); j++) follow.run(account.id, accounts[(i + j) % users].id, now);
    });
    for (let i = 0; i < posts; i++) {
      const id = `load_post_${i}`, time = now - i * 1000;
      post.run(id, accounts[i % users].id, `Load test post ${i} #loadtest`, null, null, time);
      tag.run(id, "loadtest");
      for (let j = 1; j <= 3; j++) like.run(accounts[(i + j) % users].id, id, time);
    }
  });
  db.exec("PRAGMA optimize");
  await writeFile(resolve(tokensFile), JSON.stringify(accounts), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ users, posts, likes: posts * 3, database: resolve(path), tokensFile: resolve(tokensFile) }));
} finally { db.close(); }
