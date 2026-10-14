import { notFound } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Tabs } from "@/components/tabs";
import { UserRow } from "@/components/user-row";
import { getFollowers, getFollowing, getProfile } from "@/server/queries";

export async function Connections({
  username,
  kind,
}: {
  username: string;
  kind: "followers" | "following";
}) {
  const profile = await getProfile(username);
  if (!profile) notFound();

  const users = await (kind === "followers" ? getFollowers : getFollowing)(profile.username);
  const base = `/${profile.username}`;

  return (
    <>
      <PageHeader back title={profile.displayName} subtitle={`@${profile.username}`}>
        <Tabs
          tabs={[
            { label: "Followers", href: `${base}/followers` },
            { label: "Following", href: `${base}/following` },
          ]}
        />
      </PageHeader>
      {users.length === 0 ? (
        kind === "followers" ? (
          <EmptyState
            title={profile.isSelf ? "You don't have any followers yet" : `@${profile.username} has no followers yet`}
            body="When someone follows this account, they'll show up here."
          />
        ) : (
          <EmptyState
            title={profile.isSelf ? "You aren't following anyone yet" : `@${profile.username} isn't following anyone`}
            body="Accounts this profile follows will show up here."
          />
        )
      ) : (
        users.map((user) => <UserRow key={user.id} user={user} />)
      )}
    </>
  );
}
