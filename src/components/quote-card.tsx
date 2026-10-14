import clsx from "clsx";
import Link from "next/link";
import type { QuotedPost } from "@/lib/types";
import { Avatar } from "./avatar";
import { ImageGrid } from "./image-grid";
import { RelativeTime } from "./relative-time";
import { VerifiedBadge } from "./verified-badge";

export function QuoteCard({
  quote,
  linked = true,
}: {
  quote: QuotedPost;
  linked?: boolean;
}) {
  if (quote.deleted) return <UnavailablePost />;

  const body = (
    <>
      <div className="flex items-center gap-1 text-[15px]">
        <Avatar user={quote.author} size="xs" />
        <span className="ml-1 truncate font-bold text-fg">{quote.author.displayName}</span>
        <VerifiedBadge user={quote.author} />
        <span className="truncate text-fg-muted">@{quote.author.username}</span>
        <span className="text-fg-muted">·</span>
        <span className="shrink-0 text-fg-muted">
          <RelativeTime iso={quote.createdAt} />
        </span>
      </div>
      {quote.content && (
        <p className="mt-1 text-[15px] leading-5 break-words whitespace-pre-wrap text-fg">
          {quote.content}
        </p>
      )}
      {quote.imageUrls.length > 0 && (
        <div className="mt-2">
          <ImageGrid urls={quote.imageUrls} interactive={false} />
        </div>
      )}
    </>
  );

  const className = clsx(
    "block rounded-2xl border border-border px-3 py-2.5",
    linked && "transition-colors hover:bg-bg-hover",
  );

  return linked ? (
    <Link href={`/${quote.author.username}/status/${quote.id}`} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function UnavailablePost() {
  return (
    <div className="rounded-2xl border border-border bg-bg-muted px-4 py-3 text-[15px] text-fg-muted">
      This post is unavailable.
    </div>
  );
}
