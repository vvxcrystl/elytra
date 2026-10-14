import { EmptyState } from "@/components/empty-state";
import { Timeline } from "@/components/timeline";
import type { ProfileTab, TimelineSource } from "@/lib/types";
import { getProfile, getTimeline } from "@/server/queries";

const EMPTY: Record<ProfileTab, { self: [string, string]; other: [string, string] }> = {
  posts: {
    self: ["You haven't posted yet", "When you post, it'll show up here."],
    other: ["No posts yet", "When they post, their posts will show up here."],
  },
  replies: {
    self: ["No replies yet", "When you reply to a post, it'll show up here."],
    other: ["No replies yet", "When they reply to someone, it'll show up here."],
  },
  media: {
    self: ["Lights, camera… attachments!", "When you post photos, they'll show up here."],
    other: ["No media yet", "When they post photos, they'll show up here."],
  },
  likes: {
    self: ["You don't have any likes yet", "Tap the heart on any post to show it some love."],
    other: ["No likes yet", "When they like posts, they'll show up here."],
  },
};

export async function ProfileTimeline({ username, tab }: { username: string; tab: ProfileTab }) {
  const source: TimelineSource = { kind: "user", username, tab };
  const [profile, initial] = await Promise.all([getProfile(username), getTimeline(source)]);
  const [title, body] = EMPTY[tab][profile?.isSelf ? "self" : "other"];

  return <Timeline source={source} initial={initial} empty={<EmptyState title={title} body={body} />} />;
}
