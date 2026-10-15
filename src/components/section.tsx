import Link from "next/link";
import { compactNumber } from "@/lib/format";
import type { Trend } from "@/lib/types";

/** Heading for a list section, used in the right rail and on Explore. */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="px-4 pt-3 pb-1 text-xl font-extrabold">{children}</h2>;
}

export function ShowMoreLink({ href }: { href: string }) {
  return (
    <Link href={href} className="block px-4 py-4 text-[15px] text-link transition-colors hover:bg-bg-hover">
      Show more
    </Link>
  );
}

export function TrendLink({ trend, rank }: { trend: Trend; rank?: number }) {
  return (
    <Link
      href={`/explore?q=${encodeURIComponent(`#${trend.tag}`)}`}
      className="block px-4 py-2.5 transition-colors hover:bg-bg-hover"
    >
      {/* The rail's "Trends for you" heading already says these are trending. */}
      {rank && <p className="text-[13px] text-fg-muted">{rank} · Trending</p>}
      <p className="font-bold">#{trend.tag}</p>
      <p className="text-[13px] text-fg-muted">
        {compactNumber(trend.postCount)} {trend.postCount === 1 ? "post" : "posts"}
      </p>
    </Link>
  );
}
