import { ProfileTimeline } from "../profile-timeline";

export default async function Page({ params }: PageProps<"/[username]/replies">) {
  const { username } = await params;
  return <ProfileTimeline username={username} tab="replies" />;
}
