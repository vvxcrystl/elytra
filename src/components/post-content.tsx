import Link from "next/link";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkSocialLinks } from "@/lib/post-markdown";

/** Shared rendering for posts and composer previews. Raw HTML is never executed. */
export function PostContent({
  text,
  className = "",
  interactive = true,
}: {
  text: string;
  className?: string;
  /** Quotes already have a surrounding link, so their contents cannot contain links. */
  interactive?: boolean;
}) {
  return (
    <div className={`post-markdown min-w-0 break-words ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkSocialLinks]}
        components={{
          a: ({ href, children }) => {
            if (!interactive || !href) return <span>{children}</span>;
            const internal = href.startsWith("/") && !href.startsWith("//");
            return internal ? (
              <Link href={href} className="text-link hover:underline">{children}</Link>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-link hover:underline">
                {children}
              </a>
            );
          },
          // Images use the post attachment flow rather than loading arbitrary remote resources.
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
