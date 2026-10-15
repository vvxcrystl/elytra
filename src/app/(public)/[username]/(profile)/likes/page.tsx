import { ProfileTimeline } from "../profile-timeline";

export default async function Page({ params }: PageProps<"/[username]/likes">) {
  const { username } = await params;
  return <ProfileTimeline username={username} tab="likes" />;
}
