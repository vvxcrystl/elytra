import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./security";

export function seedDatabase(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check under the write lock when two server processes initialize together.
    if (db.prepare("SELECT id FROM users LIMIT 1").get()) { db.exec("COMMIT"); return; }
    const now = Date.now();
    const people = [
      ["theo", "Theo", "Building things for the web. TypeScript enjoyer. San Francisco ☀️"],
      ["demo", "Demo User", "A little curious about everything. Say hello!"],
      ["sarah", "Sarah Chen", "Design engineer. Making the internet a little more human."],
      ["marcus", "Marcus Rivera", "Full stack developer, weekend cyclist, excellent coffee finder."],
      ["priya", "Priya Patel", "Open source maintainer. Teaching what I learn along the way."],
      ["alex", "Alex Morgan", "Photography, accessible interfaces, and long walks."],
      ["jules", "Jules Park", "Indie hacker turning small ideas into useful things."],
      ["maya", "Maya Johnson", "Frontend engineer. CSS is my creative outlet."],
    ];
    const user = db.prepare("INSERT INTO users(id,username,username_lower,display_name,password_hash,bio,location,created_at) VALUES(?,?,?,?,?,?,?,?)");
    people.forEach(([name, display, bio], i) => user.run(`seed_${name}`, name, name, display, hashPassword("password123"), bio, ["San Francisco", "", "New York", "Austin", "London", "Portland", "Toronto", "Brooklyn"][i], now - 86400000 * (120 + i)));
    const follow = db.prepare("INSERT INTO follows VALUES(?,?,?)");
    people.forEach(([name], i) => people.forEach(([other], j) => { if (i !== j && (i + j) % 3 !== 0) follow.run(`seed_${name}`, `seed_${other}`, now - 86400000); }));
    const messages = [
      "Shipped a tiny improvement today. The best part of building software is watching someone actually use it. #webdev",
      "A good interface makes the next step feel obvious. Spent the morning removing things instead of adding them.",
      "The new #nextjs project is finally coming together. What are you building this week?",
      "Type safety is a love letter to your future self. #typescript #webdev",
      "Went for a walk without headphones. Came back with three ideas and a much better mood.",
      "Small components. Clear names. Fewer clever abstractions. That's the whole plan today. #webdev",
      "Nothing beats a slow Sunday morning and a fresh notebook ☕",
      "Accessibility isn't a final checklist. It's a design constraint from the first sketch.",
      "Trying out node:sqlite for a side project. Sometimes the simplest tool is exactly what you need. #typescript",
      "Reminder to write down what you learned. Someone else is stuck where you were yesterday.",
      "Just discovered a great little coffee shop. The wifi is terrible, which might be the best feature.",
      "The web is still an incredible place to make things. Keep it weird, keep it open. #webdev",
      "Working on a little social app with #nextjs and #typescript. The details are where the fun starts.",
      "How do you organize your design tokens? Curious to hear what works on a small team.",
      "Merged my first contribution to an open source project this week. The maintainers were so kind.",
      "A beautiful sunset, a good playlist, and absolutely no unread notifications. Perfect evening.",
      "Today’s win: deleted 200 lines of code and all the tests still pass. #typescript",
      "The hardest part of a side project is deciding when it's ready to share. This is your sign to ship it.",
      "CSS grid continues to feel like a superpower. #webdev",
      "What’s one small thing that made your day better?",
      "I keep coming back to this: make it work, then make it clear, then make it fast.",
      "Learning in public is awkward until someone tells you your notes helped them. Worth it every time.",
      "A fast app starts with doing less work. Profiling before optimizing saved me an entire afternoon. #nextjs",
      "Built a keyboard shortcut for something I do 50 times a day. Tiny tools add up.",
      "Spent the afternoon pairing with @priya on a tricky bug. A fresh perspective changes everything.",
      "Friendly reminder to back up your side projects. And maybe water your plants too.",
      "The first version doesn't need to impress everyone. It needs to help one person.",
      "What's your favorite underrated browser feature? Mine is the accessibility tree. #webdev",
      "Reading source code is such an underrated way to learn. #typescript",
      "Good morning, internet. Let's make something useful today ☀️",
      "The best documentation includes the reason a decision was made. Future teammates will thank you.",
      "A little progress every day really does add up. Here's to showing up.",
      "Thanks @theo for the deep dive on server rendering. Finally clicked for me! #nextjs",
      "This is exactly why I like building in the open. So much to learn from each other.",
      "Absolutely. We started with one small screen and iterated from there.",
      "Same here! Keeping the first version small made a huge difference.",
      "Have you tried measuring the keyboard navigation too? It caught a few surprises for us.",
      "Yes! The focus order needed a little work. Fixed it this morning.",
      "This resonates. Shipping is a skill you practice, not a finish line.",
      "A thoughtful take on keeping the web simple. More of this please. #webdev",
      "End of the week: one feature shipped, two bugs fixed, and a very long walk. I'll take it.",
      "The joy of a side project is getting to care about every little detail. #nextjs",
    ];
    const post = db.prepare("INSERT INTO posts VALUES(?,?,?,?,?,?)");
    messages.forEach((content, i) => {
      const replyTo = ({33: "seed_post_0", 34: "seed_post_33", 35: "seed_post_34", 36: "seed_post_7", 37: "seed_post_36", 38: "seed_post_17"} as Record<number,string>)[i] || null;
      const quote = i === 39 ? "seed_post_11" : i === 40 ? "seed_post_20" : null;
      post.run(`seed_post_${i}`, `seed_${people[i % 8][0]}`, content, replyTo, quote, now - (messages.length - i) * 7 * 3600000);
      for (const tag of new Set(Array.from(content.matchAll(/#([\p{L}\p{N}_]+)/gu), m => m[1].toLowerCase()))) db.prepare("INSERT INTO hashtags VALUES(?,?)").run(`seed_post_${i}`, tag);
      for (const match of content.matchAll(/@([A-Za-z0-9_]+)/g)) {
        const mentioned = people.find(([name]) => name === match[1].toLowerCase());
        if (mentioned) db.prepare("INSERT OR IGNORE INTO mentions VALUES(?,?)").run(`seed_post_${i}`, `seed_${mentioned[0]}`);
      }
    });
    messages.forEach((_, i) => people.forEach(([name], j) => {
      if ((i + j) % 3 === 0) {
        const actor = `seed_${name}`, author = `seed_${people[i % 8][0]}`, time = now - (messages.length - i) * 6 * 3600000;
        db.prepare("INSERT INTO likes VALUES(?,?,?)").run(actor, `seed_post_${i}`, time);
        if (actor !== author) db.prepare("INSERT INTO notifications VALUES(?,?,?,?,?,?,?)").run(`seed_like_${i}_${j}`, author, actor, "like", `seed_post_${i}`, time, i < 32 ? 1 : 0);
      }
      if ((i + j) % 11 === 0) db.prepare("INSERT INTO reposts VALUES(?,?,?)").run(`seed_${name}`, `seed_post_${i}`, now - (messages.length - i) * 5 * 3600000);
    }));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
