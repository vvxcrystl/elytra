import { CalendarDays, Link2, MapPin } from "lucide-react";
import { VerifiedBadge } from "@/components/verified-badge";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { EditProfileButton } from "@/components/edit-profile";
import { FollowButton } from "@/components/follow-button";
import { MessageButton } from "@/components/messages/message-button";
import { PageHeader } from "@/components/page-header";
import { RichText } from "@/components/rich-text";
import { Tabs } from "@/components/tabs";
import { FollowsYouBadge } from "@/components/user-row";
import { compactNumber, displayUrl, joinedDate } from "@/lib/format";
import { getProfile } from "@/server/queries";

export async function generateMetadata({ params }: LayoutProps<"/[username]">): Promise<Metadata> {
  const { username } = await params;
  const profile = await getProfile(username);
  if (!profile) return { title: "Profile not found" };
  return {
    title: `${profile.displayName} (@${profile.username})`,
    description: profile.bio || undefined,
  };
}

export default async function ProfileLayout({ params, children }: LayoutProps<"/[username]">) {
  const { username } = await params;
  const profile = await getProfile(username);
  if (!profile) notFound();

  const base = `/${profile.username}`;

  return (
    <>
      <PageHeader
        back
        title={profile.displayName}
        subtitle={`${compactNumber(profile.postsCount)} ${profile.postsCount === 1 ? "post" : "posts"}`}
      />

      <div className="aspect-[3/1] bg-bg-muted">
        {profile.bannerUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={profile.bannerUrl} alt="" className="size-full object-cover" />
        )}
      </div>

      <div className="px-4 pt-3">
        <div className="flex items-start justify-between">
          <div className="-mt-[15%] rounded-full border-4 border-bg bg-bg">
            <Avatar user={profile} size="xl" className="size-[clamp(80px,22vw,134px)]!" />
          </div>
          {profile.isSelf ? (
            <EditProfileButton profile={profile} />
          ) : (
            <div className="flex items-center gap-2">
              <MessageButton userId={profile.id} username={profile.username} />
              <FollowButton userId={profile.id} following={profile.isFollowing} size="md" />
            </div>
          )}
        </div>

        <div className="mt-3">
          <h2 className="text-xl leading-6 font-extrabold">
            {profile.displayName}
            <VerifiedBadge user={profile} className="ml-1" />
          </h2>
          <p className="flex items-center gap-1.5 text-[15px] text-fg-muted">
            @{profile.username}
            {profile.followsYou && (
              <FollowsYouBadge />
            )}
          </p>
        </div>

        {profile.bio && (
          <p className="mt-3 text-[15px] leading-5 break-words whitespace-pre-wrap">
            <RichText text={profile.bio} />
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[15px] text-fg-muted">
          {profile.location && (
            <span className="flex items-center gap-1">
              <MapPin className="size-[18px]" />
              {profile.location}
            </span>
          )}
          {profile.website && (
            <span className="flex items-center gap-1">
              <Link2 className="size-[18px]" />
              <a
                href={profile.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-link hover:underline"
              >
                {displayUrl(profile.website)}
              </a>
            </span>
          )}
          <span className="flex items-center gap-1">
            <CalendarDays className="size-[18px]" />
            {joinedDate(profile.createdAt)}
          </span>
        </div>

        <div className="mt-3 flex gap-5 text-[15px]">
          <Link href={`${base}/following`} className="hover:underline">
            <span className="font-bold">{compactNumber(profile.followingCount)}</span>{" "}
            <span className="text-fg-muted">Following</span>
          </Link>
          <Link href={`${base}/followers`} className="hover:underline">
            <span className="font-bold">{compactNumber(profile.followersCount)}</span>{" "}
            <span className="text-fg-muted">{profile.followersCount === 1 ? "Follower" : "Followers"}</span>
          </Link>
        </div>
      </div>

      <div className="mt-3 border-b border-border">
        <Tabs
          tabs={[
            { label: "Posts", href: base },
            { label: "Replies", href: `${base}/replies` },
            { label: "Media", href: `${base}/media` },
            { label: "Likes", href: `${base}/likes` },
          ]}
        />
      </div>

      {children}
    </>
  );
}
