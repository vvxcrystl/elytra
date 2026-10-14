import clsx from "clsx";
import { Heart, Repeat2, User } from "lucide-react";
import { VerifiedBadge } from "@/components/verified-badge";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { MarkNotificationsRead } from "@/components/mark-notifications-read";
import { PageHeader } from "@/components/page-header";
import { PostCard } from "@/components/post-card";
import { RelativeTime } from "@/components/relative-time";
import { Tabs } from "@/components/tabs";
import type { Notification } from "@/lib/types";
import { getNotifications } from "@/server/queries";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: PageProps<"/notifications">) {
  const { tab } = await searchParams;
  const mentionsOnly = tab === "mentions";
  const notifications = await getNotifications({ mentionsOnly });
  const hasUnread = notifications.some((n) => !n.read);

  return (
    <>
      <PageHeader title="Notifications">
        <Tabs
          tabs={[
            { label: "All", href: "/notifications" },
            { label: "Mentions", href: "/notifications?tab=mentions" },
          ]}
        />
      </PageHeader>
      {hasUnread && (
        <MarkNotificationsRead key={notifications.filter((n) => !n.read).map((n) => n.id).join(",")} />
      )}
      {notifications.length === 0 ? (
        mentionsOnly ? (
          <EmptyState
            title="Nothing to see here, yet"
            body="When someone mentions you or replies to you, you'll find it here."
          />
        ) : (
          <EmptyState
            title="Nothing to see here, yet"
            body="Likes, reposts, follows and replies will show up here."
          />
        )
      ) : (
        notifications.map((n) => <NotificationRow key={n.id} notification={n} />)
      )}
    </>
  );
}

const ACTIVITY = {
  like: { icon: Heart, color: "text-like", fill: true, text: "liked your post" },
  repost: { icon: Repeat2, color: "text-repost", fill: false, text: "reposted your post" },
  follow: { icon: User, color: "text-accent-ink", fill: true, text: "followed you" },
} as const;

function NotificationRow({ notification: n }: { notification: Notification }) {
  if ((n.type === "reply" || n.type === "mention" || n.type === "quote") && n.post) {
    return (
      <div className={clsx(!n.read && "bg-accent-soft/40")}>
        <PostCard post={n.post} />
      </div>
    );
  }
  if (!(n.type in ACTIVITY)) return null;

  const activity = ACTIVITY[n.type as keyof typeof ACTIVITY];
  const Icon = activity.icon;
  const href = n.post ? `/${n.post.author.username}/status/${n.post.id}` : `/${n.actor.username}`;

  return (
    <Link
      href={href}
      className={clsx(
        "flex gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-bg-hover",
        !n.read && "bg-accent-soft/40",
      )}
    >
      <div className="flex w-10 justify-end">
        <Icon className={clsx("size-7", activity.color, activity.fill && "fill-current")} />
      </div>
      <div className="min-w-0 flex-1">
        <Avatar user={n.actor} size="sm" />
        <p className="mt-2 text-[15px]">
          <span className="font-bold">{n.actor.displayName}</span>
          <VerifiedBadge user={n.actor} className="mx-0.5" /> {activity.text}
          <span className="text-fg-muted">
            {" · "}
            <RelativeTime iso={n.createdAt} />
          </span>
        </p>
        {n.post && (n.post.content || n.post.imageUrls.length > 0) && (
          <p className="mt-1 line-clamp-3 text-[15px] break-words whitespace-pre-wrap text-fg-muted">
            {n.post.content || "Image"}
          </p>
        )}
      </div>
    </Link>
  );
}
