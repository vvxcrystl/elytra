"use client";

import { VerifiedBadge } from "./verified-badge";
import { AiOperatedBadge } from "./ai-labels";
import clsx from "clsx";
import {
  Bookmark,
  ChartNoAxesColumn,
  Heart,
  Link2,
  MessageCircle,
  MoreHorizontal,
  PenLine,
  Repeat2,
  Frown,
  Share,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { compactNumber, fullTime } from "@/lib/format";
import type { Post, UserSummary } from "@/lib/types";
import {
  deletePost,
  markNotInterested,
  toggleBookmark,
  toggleRepost,
} from "@/server/actions";
import { Avatar } from "./avatar";
import { useCompose } from "./compose-dialog";
import { ImageGrid } from "./image-grid";
import { Menu } from "./menu";
import { PostAnalyticsDialog } from "./post-analytics-dialog";
import { recordPostVisit, setPostLiked } from "./post-api";
import { QuoteCard } from "./quote-card";
import { RelativeTime } from "./relative-time";
import { PostContent } from "./post-content";
import { useToast } from "./toast";
import { useOptionalViewer } from "./viewer-context";

type Variant = "feed" | "ancestor" | "detail";

type Engagement = Pick<
  Post,
  "likeCount" | "repostCount" | "bookmarkCount" | "replyCount" | "viewer"
>;

function engagementOf(post: Post): Engagement {
  return {
    likeCount: post.likeCount,
    repostCount: post.repostCount,
    bookmarkCount: post.bookmarkCount,
    replyCount: post.replyCount,
    viewer: post.viewer,
  };
}

export function postHref(post: Pick<Post, "id" | "author">) {
  return `/${post.author.username}/status/${post.id}`;
}

export function PostCard({
  post,
  repostedBy,
  variant = "feed",
  showReplyContext = true,
  connectBelow = false,
}: {
  post: Post;
  repostedBy?: UserSummary | null;
  variant?: Variant;
  showReplyContext?: boolean;
  /** Draw a thread line under the avatar to the next post. */
  connectBelow?: boolean;
}) {
  const router = useRouter();
  const viewer = useOptionalViewer();
  const toast = useToast();
  const openCompose = useCompose();
  const [, startTransition] = useTransition();
  const [deleted, setDeleted] = useState(false);
  const likePending = useRef(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  // Local engagement state for instant feedback. Resets whenever the server sends a fresh post.
  const [engagement, setEngagement] = useState(() => engagementOf(post));
  const [syncedPost, setSyncedPost] = useState(post);
  if (post !== syncedPost) {
    setSyncedPost(post);
    setEngagement(engagementOf(post));
  }

  const isOwn = post.author.id === viewer?.id;
  const detail = variant === "detail";
  const viewerId = viewer?.id;

  // Opening a post counts as a detail expand. The server ignores the author and repeats within a minute.
  useEffect(() => {
    if (detail && viewerId && !isOwn) recordPostVisit(post.id, "detail");
  }, [detail, viewerId, isOwn, post.id]);

  if (deleted) return null;

  const href = postHref(post);
  // Counts a click from the post to its author's profile.
  const onAuthorClick = () => {
    if (viewerId && !isOwn) recordPostVisit(post.id, "profile");
  };

  function onLike() {
    if (!viewer) return router.push("/login");
    if (likePending.current) return;
    likePending.current = true;
    const prev = engagement;
    const liked = !prev.viewer.liked;
    setEngagement({
      ...prev,
      likeCount: prev.likeCount + (liked ? 1 : -1),
      viewer: { ...prev.viewer, liked },
    });
    startTransition(async () => {
      const res = await setPostLiked(post.id, liked);
      likePending.current = false;
      if (!res.ok) {
        setEngagement(prev);
        toast(res.error);
        return;
      }
      setEngagement((e) => ({
        ...e,
        likeCount: res.data.likeCount,
        viewer: { ...e.viewer, liked: res.data.liked },
      }));
    });
  }

  function onRepost() {
    if (!viewer) return router.push("/login");
    const prev = engagement;
    const reposted = !prev.viewer.reposted;
    setEngagement({
      ...prev,
      repostCount: prev.repostCount + (reposted ? 1 : -1),
      viewer: { ...prev.viewer, reposted },
    });
    startTransition(async () => {
      const res = await toggleRepost(post.id);
      if (!res.ok) {
        setEngagement(prev);
        toast(res.error);
        return;
      }
      setEngagement((e) => ({
        ...e,
        repostCount: res.data.repostCount,
        viewer: { ...e.viewer, reposted: res.data.reposted },
      }));
    });
  }

  function onBookmark() {
    if (!viewer) return router.push("/login");
    const prev = engagement;
    const bookmarked = !prev.viewer.bookmarked;
    setEngagement({
      ...prev,
      bookmarkCount: prev.bookmarkCount + (bookmarked ? 1 : -1),
      viewer: { ...prev.viewer, bookmarked },
    });
    startTransition(async () => {
      const res = await toggleBookmark(post.id);
      if (!res.ok) {
        setEngagement(prev);
        toast(res.error);
        return;
      }
      toast(res.data.bookmarked ? "Added to your Bookmarks" : "Removed from your Bookmarks", {
        href: "/bookmarks",
        label: "View",
      });
    });
  }

  function onDelete() {
    if (!confirm("Delete this post? This can't be undone.")) return;
    startTransition(async () => {
      const res = await deletePost(post.id);
      if (!res.ok) {
        toast(res.error);
        return;
      }
      setDeleted(true);
      toast("Your post was deleted");
      if (detail) router.push("/home");
    });
  }

  function onNotInterested() {
    setDeleted(true);
    startTransition(async () => {
      const res = await markNotInterested(post.id);
      if (!res.ok) {
        setDeleted(false);
        toast(res.error);
        return;
      }
      toast("Thanks. You'll see fewer posts like this.");
    });
  }

  async function copyLink() {
    await navigator.clipboard.writeText(`${window.location.origin}${href}`);
    toast("Copied to clipboard");
  }

  function onCardClick(e: React.MouseEvent) {
    if (detail) return;
    const target = e.target as HTMLElement;
    if (target.closest("a, button, [role=menu], [role=dialog]")) return;
    if (window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
    else router.push(href);
  }

  const replyContext =
    showReplyContext && post.replyToUsername ? (
      <p className="text-[15px] text-fg-muted">
        Replying to{" "}
        <Link href={`/${post.replyToUsername}`} className="text-link hover:underline">
          @{post.replyToUsername}
        </Link>
      </p>
    ) : null;

  const menu = (
    <Menu
      label="Post options"
      items={[
        ...(isOwn
          ? [{ label: "Delete", danger: true, icon: <Trash2 className="size-[18px]" />, onSelect: onDelete }]
          : []),
        ...(viewer && !isOwn && !detail
          ? [
              {
                label: "Not interested in this post",
                icon: <Frown className="size-[18px]" />,
                onSelect: onNotInterested,
              },
            ]
          : []),
        { label: "Copy link", icon: <Link2 className="size-[18px]" />, onSelect: copyLink },
      ]}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="More"
          className="-my-1.5 -mr-2 flex size-[34px] items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-accent-soft hover:text-accent-ink"
        >
          <MoreHorizontal className="size-[18px]" />
        </button>
      )}
    />
  );

  const media = (
    <>
      {post.imageUrls.length > 0 && (
        <div className="mt-3">
          <ImageGrid urls={post.imageUrls} />
        </div>
      )}
      {post.quote && (
        <div className="mt-3">
          <QuoteCard quote={post.quote} />
        </div>
      )}
    </>
  );

  const analyticsDialog = analyticsOpen && (
    <PostAnalyticsDialog post={post} onClose={() => setAnalyticsOpen(false)} />
  );

  const actions = (
    <ActionBar
      engagement={engagement}
      viewCount={post.viewCount}
      onAnalytics={() => setAnalyticsOpen(true)}
      detail={detail}
      onReply={() => viewer ? openCompose({ replyTo: post }) : router.push("/login")}
      onRepost={onRepost}
      onQuote={() => viewer ? openCompose({ quote: post }) : router.push("/login")}
      onLike={onLike}
      onBookmark={onBookmark}
      onShare={copyLink}
    />
  );

  if (detail) {
    return (
      <article data-post-id={post.id} className="border-b border-border px-4 pt-3">
        <div className="flex items-center gap-3">
          <Link href={`/${post.author.username}`} onClick={onAuthorClick}>
            <Avatar user={post.author} />
          </Link>
          <div className="min-w-0 flex-1 text-[15px] leading-5">
            <Link
              href={`/${post.author.username}`}
              onClick={onAuthorClick}
              className="block truncate font-bold hover:underline"
            >
              {post.author.displayName}
              <VerifiedBadge user={post.author} className="ml-1" />
              <AiOperatedBadge user={post.author} className="ml-1" />
            </Link>
            <Link href={`/${post.author.username}`} onClick={onAuthorClick} className="block truncate text-fg-muted">
              @{post.author.username}
            </Link>
          </div>
          {menu}
        </div>
        <div className="mt-3">{replyContext}</div>
        {post.content && (
          <PostContent text={post.content} className="mt-2 text-[17px] leading-6" />
        )}
        {media}
        <p className="my-4 text-[15px] text-fg-muted">
          <time dateTime={post.createdAt} suppressHydrationWarning>
            {fullTime(post.createdAt)}
          </time>
        </p>
        <div className="border-t border-border py-1">{actions}</div>
        {analyticsDialog}
      </article>
    );
  }

  return (
    <article
      data-post-id={post.id}
      onClick={onCardClick}
      className={clsx(
        "cursor-pointer px-4 transition-colors hover:bg-bg-hover",
        variant === "feed" && !connectBelow && "border-b border-border",
        repostedBy ? "pt-2" : "pt-3",
      )}
    >
      {repostedBy && (
        <div className="mb-1 flex items-center gap-3 text-[13px] font-semibold text-fg-muted">
          <div className="flex w-10 justify-end">
            <Repeat2 className="size-4" />
          </div>
          <Link href={`/${repostedBy.username}`} className="truncate hover:underline">
            {repostedBy.id === viewer?.id ? "You" : repostedBy.displayName} reposted
          </Link>
        </div>
      )}
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <Link href={`/${post.author.username}`} onClick={onAuthorClick} className="rounded-full">
            <Avatar user={post.author} />
          </Link>
          {connectBelow && <div className="mt-1 w-0.5 flex-1 bg-border" />}
        </div>
        <div className="min-w-0 flex-1 pb-1">
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 text-[15px] leading-5">
              <Link
                href={`/${post.author.username}`}
                onClick={onAuthorClick}
                className="truncate font-bold hover:underline"
              >
                {post.author.displayName}
              </Link>
              <VerifiedBadge user={post.author} />
              <AiOperatedBadge user={post.author} />
              <Link href={`/${post.author.username}`} onClick={onAuthorClick} className="truncate text-fg-muted">
                @{post.author.username}
              </Link>
              <span className="text-fg-muted" aria-hidden>
                ·
              </span>
              <Link href={href} className="shrink-0 text-fg-muted hover:underline">
                <RelativeTime iso={post.createdAt} />
              </Link>
            </div>
            {menu}
          </div>
          {replyContext}
          {post.content && (
            <PostContent text={post.content} className="mt-0.5 text-[15px] leading-5" />
          )}
          {media}
          <div className="mt-1.5 mb-1">{actions}</div>
        </div>
      </div>
      {analyticsDialog}
    </article>
  );
}

/**
 * Reply, repost, like, bookmark and share, spread edge to edge, with bookmark and share grouped
 * at the end. The detail view uses larger icons and also shows the bookmark count, since it has
 * no separate stats row.
 */
function ActionBar({
  engagement,
  viewCount,
  onAnalytics,
  detail,
  onReply,
  onRepost,
  onQuote,
  onLike,
  onBookmark,
  onShare,
}: {
  engagement: Engagement;
  /** Set only on the viewer's own posts, which also get an analytics button. */
  viewCount: number | null;
  onAnalytics: () => void;
  detail: boolean;
  onReply: () => void;
  onRepost: () => void;
  onQuote: () => void;
  onLike: () => void;
  onBookmark: () => void;
  onShare: () => void;
}) {
  // X's glyphs are small and thin; a lighter stroke at a smaller size matches that look.
  const icon = clsx(detail ? "size-5" : "size-4", "[stroke-width:1.75]");
  const { viewer } = engagement;

  return (
    <div className="-mx-2 flex items-center justify-between">
      <ActionButton label="Reply" count={engagement.replyCount} onClick={onReply} tone="accent">
        <MessageCircle className={icon} />
      </ActionButton>

      <Menu
        label="Repost options"
        align="left"
        items={[
          {
            label: viewer.reposted ? "Undo repost" : "Repost",
            icon: <Repeat2 className="size-[18px]" />,
            onSelect: onRepost,
          },
          { label: "Quote", icon: <PenLine className="size-[18px]" />, onSelect: onQuote },
        ]}
        trigger={({ toggle }) => (
          <ActionButton
            label={viewer.reposted ? "Undo repost" : "Repost"}
            count={engagement.repostCount}
            active={viewer.reposted}
            onClick={toggle}
            tone="repost"
          >
            <Repeat2 className={icon} />
          </ActionButton>
        )}
      />

      <ActionButton
        label={viewer.liked ? "Unlike" : "Like"}
        count={engagement.likeCount}
        active={viewer.liked}
        onClick={onLike}
        tone="like"
      >
        <Heart className={clsx(icon, viewer.liked && "fill-current")} />
      </ActionButton>

      {viewCount !== null && (
        <ActionButton label="View post analytics" count={viewCount} onClick={onAnalytics} tone="accent">
          <ChartNoAxesColumn className={icon} />
        </ActionButton>
      )}

      {/* Bookmark and share form one pair at the end, so they stay together at every width. */}
      <div className="flex items-center gap-1">
        <ActionButton
          label={viewer.bookmarked ? "Remove bookmark" : "Bookmark"}
          count={detail ? engagement.bookmarkCount : undefined}
          active={viewer.bookmarked}
          onClick={onBookmark}
          tone="accent"
        >
          <Bookmark className={clsx(icon, viewer.bookmarked && "fill-current")} />
        </ActionButton>

        <ActionButton label="Copy link" onClick={onShare} tone="accent">
          <Share className={icon} />
        </ActionButton>
      </div>
    </div>
  );
}

const TONES = {
  accent: { active: "text-accent-ink", hover: "group-hover:text-accent-ink", bg: "group-hover:bg-accent-soft" },
  like: { active: "text-like", hover: "group-hover:text-like", bg: "group-hover:bg-like-soft" },
  repost: { active: "text-repost", hover: "group-hover:text-repost", bg: "group-hover:bg-repost-soft" },
} as const;

function ActionButton({
  label,
  count,
  active,
  tone,
  onClick,
  children,
}: {
  label: string;
  count?: number;
  active?: boolean;
  tone: keyof typeof TONES;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={clsx(
        "group flex items-center text-[13px] tabular-nums transition-colors",
        active ? t.active : "text-fg-muted",
      )}
    >
      <span
        className={clsx(
          "flex size-[34px] items-center justify-center rounded-full transition-colors",
          t.bg,
          !active && t.hover,
        )}
      >
        {children}
      </span>
      {/* Fixed slot so the row doesn't shift when a count appears. */}
      {count !== undefined && (
        <span className={clsx("-ml-0.5 min-w-6 transition-colors", !active && t.hover)}>
          {count > 0 ? compactNumber(count) : ""}
        </span>
      )}
    </button>
  );
}
