import Link from "next/link";
import { Fragment } from "react";

// Matches URLs, @mentions and #hashtags in one pass.
const TOKEN = /(https?:\/\/[^\s]+)|(@[A-Za-z0-9_]{1,15})|(#[A-Za-z0-9_]+)/g;

const linkClass = "text-accent-ink hover:underline";

export function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [token, url, mention, tag] = match;

    if (url) {
      const trimmed = url.replace(/[.,!?)]+$/, "");
      const trailing = url.slice(trimmed.length);
      parts.push(
        <Fragment key={index}>
          <a
            href={trimmed}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={linkClass}
          >
            {trimmed.replace(/^https?:\/\//, "").slice(0, 40)}
            {trimmed.replace(/^https?:\/\//, "").length > 40 ? "…" : ""}
          </a>
          {trailing}
        </Fragment>,
      );
    } else if (mention) {
      parts.push(
        <Link key={index} href={`/${mention.slice(1)}`} className={linkClass}>
          {mention}
        </Link>,
      );
    } else if (tag) {
      parts.push(
        <Link
          key={index}
          href={`/explore?q=${encodeURIComponent(tag)}`}
          className={linkClass}
        >
          {tag}
        </Link>,
      );
    } else {
      parts.push(token);
    }
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return <>{parts}</>;
}
