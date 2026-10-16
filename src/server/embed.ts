import "server-only";
import { headers } from "next/headers";
import type { Post } from "@/lib/types";

export const EMBED_COLOR = "#c5a7ff";

/** Link-preview crawlers (Discord, Slack, Telegram, Twitterbot, and similar) read the first theme-color tag. */
const CRAWLER = /bot|crawler|spider|discord|slack|telegram|whatsapp|facebookexternalhit|skype|embedly|preview/i;

export async function isCrawler(): Promise<boolean> {
  return CRAWLER.test((await headers()).get("user-agent") ?? "");
}

/** The public origin, from ELYTRA_PUBLIC_ORIGIN or the forwarded request headers.
 * Clients can set forwarded headers when the app is reachable without the tunnel, and the result
 * ends up in meta tags and oEmbed links, so the ordinary Host header wins, forwarded hosts are
 * only a fallback, and only a plausible http(s) origin is accepted — anything else falls back to
 * localhost:3000. Pin ELYTRA_PUBLIC_ORIGIN in production to take request headers out entirely. */
export async function publicOrigin(): Promise<string> {
  if (process.env.ELYTRA_PUBLIC_ORIGIN) return process.env.ELYTRA_PUBLIC_ORIGIN;
  const requestHeaders = await headers();
  const proto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() || "http";
  // The Host header is set by the tunnel itself; a client-set x-forwarded-host only counts if no Host arrived.
  const host = (requestHeaders.get("host") ?? requestHeaders.get("x-forwarded-host") ?? "").split(",")[0].trim();
  if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) {
    const origin = `${proto === "https" ? "https" : "http"}://${host}`;
    // new URL also rejects malformed ports and normalizes case, so compare on the canonical form.
    try { if (origin === new URL(origin).origin) return origin; } catch { /* fall through */ }
  }
  return "http://localhost:3000";
}

export function postUrl(post: Post, origin: string): string {
  return new URL(`/${post.author.username}/status/${post.id}`, origin).toString();
}

export function authorLine(post: Post): string {
  return `${post.author.displayName} (@${post.author.username})`;
}

/** Stats shown in the oEmbed provider line, which Discord renders above the title. */
export function statsLine(post: Post): string {
  return `💬 ${post.replyCount}   🔁 ${post.repostCount}   ❤️ ${post.likeCount}`;
}

/** Post text, plus the quoted post when there is one, the way fxtwitter shows a quote tweet. */
export function embedDescription(post: Post): string {
  const parts: string[] = [];
  if (post.content) parts.push(post.content);
  const { quote } = post;
  if (quote && !quote.deleted) {
    const quoted = quote.content || (quote.imageUrls.length ? "[image]" : "");
    parts.push(`Quoting @${quote.author.username}: ${quoted}`);
  }
  return parts.join("\n\n") || (post.imageUrls.length ? "" : `View @${post.author.username}'s post on Elytra.`);
}

/** Post images first, then the quoted post's images, then the avatar as a fallback thumbnail. */
export function embedImages(post: Post, origin: string): { images: string[]; large: boolean } {
  const media = [...post.imageUrls, ...(post.quote && !post.quote.deleted ? post.quote.imageUrls : [])];
  if (media.length) return { images: media.map((url) => new URL(url, origin).toString()), large: true };
  if (post.author.avatarUrl) return { images: [new URL(post.author.avatarUrl, origin).toString()], large: false };
  return { images: [], large: false };
}
