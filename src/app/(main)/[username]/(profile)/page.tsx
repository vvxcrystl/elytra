import { ProfileTimeline } from "./profile-timeline";

export default async function Page({ params }: PageProps<"/[username]">) {
  const { username } = await params;
  return <ProfileTimeline username={username} tab="posts" />;
}
