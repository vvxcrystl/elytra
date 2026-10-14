import "server-only";
import { getDb } from "../src/server/db";
import { seedDatabase } from "../src/server/seed";
import { removeImages } from "../src/server/media";

const db = getDb();
const uploads = db.prepare("SELECT url FROM post_images UNION SELECT avatar_url AS url FROM users WHERE avatar_url IS NOT NULL UNION SELECT banner_url AS url FROM users WHERE banner_url IS NOT NULL").all() as { url: string }[];
db.exec("BEGIN IMMEDIATE");
try {
  db.exec("DELETE FROM timeline_snapshots; DELETE FROM users;");
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
await removeImages(uploads.map(row => row.url));
seedDatabase(db);
console.log("Seeded Elytra: 8 users, 42 posts, follows, likes, reposts, and notifications. Demo password: password123");
db.close();
