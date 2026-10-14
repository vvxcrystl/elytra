import type { Metadata } from "next";
import { Composer } from "@/components/composer";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { MobileTopBar } from "@/components/sidebar-nav";
import { Tabs } from "@/components/tabs";
import { Timeline } from "@/components/timeline";
import type { HomeTab, TimelineSource } from "@/lib/types";
import { getTimeline } from "@/server/queries";
import Link from "next/link";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage({ searchParams }: PageProps<"/home">) {
  const { tab: rawTab } = await searchParams;
  const tab: HomeTab = rawTab === "following" ? "following" : "for-you";
  const source: TimelineSource = { kind: "home", tab };
  const initial = await getTimeline(source);

  return (
    <>
      <PageHeader>
        <h1 className="sr-only">Home</h1>
        <MobileTopBar />
        <Tabs
          tabs={[
            { label: "For you", href: "/home" },
            { label: "Following", href: "/home?tab=following" },
          ]}
        />
      </PageHeader>
      <div className="hidden border-b border-border px-4 pt-1 pb-2 sm:block">
        <Composer />
      </div>
      <Timeline
        key={tab}
        source={source}
        initial={initial}
        empty={
          tab === "following" ? (
            <EmptyState
              title="Welcome to your timeline"
              body="Posts from the people you follow show up here. Find a few accounts to follow to get started."
              action={
                <Link href="/explore?tab=people" className="btn-primary h-[52px] px-8 text-[17px]">
                  Find people
                </Link>
              }
            />
          ) : (
            <EmptyState title="Nothing here yet" body="Be the first to post something." />
          )
        }
      />
    </>
  );
}
