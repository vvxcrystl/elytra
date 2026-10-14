import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Timeline } from "@/components/timeline";
import type { TimelineSource } from "@/lib/types";
import { requireViewer } from "@/server/auth";
import { getTimeline } from "@/server/queries";

export const metadata: Metadata = { title: "Bookmarks" };

const source: TimelineSource = { kind: "bookmarks" };

export default async function BookmarksPage() {
  const [viewer, initial] = await Promise.all([requireViewer(), getTimeline(source)]);

  return (
    <>
      <PageHeader title="Bookmarks" subtitle={`@${viewer.username}`} back />
      <Timeline
        source={source}
        initial={initial}
        empty={
          <EmptyState
            title="Save posts for later"
            body="Bookmark posts to easily find them again in the future."
          />
        }
      />
    </>
  );
}
