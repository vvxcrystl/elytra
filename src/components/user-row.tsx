import Link from "next/link";
import type { UserListItem } from "@/lib/types";
import { Avatar } from "./avatar";
import { AiOperatedBadge } from "./ai-labels";
import { VerifiedBadge } from "./verified-badge";
import { FollowButton } from "./follow-button";

export function UserRow({ user, showBio = true }: { user: UserListItem; showBio?: boolean }) {
  return (
    <div className="relative flex gap-3 px-4 py-3 transition-colors hover:bg-bg-hover">
      <Link
        href={`/${user.username}`}
        className="absolute inset-0"
        aria-label={`${user.displayName} (@${user.username})`}
      />
      <Avatar user={user} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 leading-5">
            <p className="truncate font-bold">
              {user.displayName}
              <VerifiedBadge user={user} className="ml-1" />
              <AiOperatedBadge user={user} className="ml-1" />
            </p>
            <p className="flex items-center gap-1 truncate text-[15px] text-fg-muted">
              @{user.username}
              {user.followsYou && (
                <FollowsYouBadge />
              )}
            </p>
          </div>
          {!user.isSelf && (
            <div className="relative">
              <FollowButton userId={user.id} following={user.isFollowing} />
            </div>
          )}
        </div>
        {showBio && user.bio && (
          <p className="mt-1 text-[15px] leading-5 break-words">{user.bio}</p>
        )}
      </div>
    </div>
  );
}

export function FollowsYouBadge() {
  return <span className="rounded bg-bg-muted px-1 text-[11px] font-medium text-fg-muted">Follows you</span>;
}
