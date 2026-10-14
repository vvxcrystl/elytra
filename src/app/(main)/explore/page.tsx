import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SearchBox } from "@/components/search-box";
import { SectionHeading, ShowMoreLink, TrendLink } from "@/components/section";
import { Tabs } from "@/components/tabs";
import { Timeline } from "@/components/timeline";
import { UserRow } from "@/components/user-row";
import type { SearchTab, TimelineSource } from "@/lib/types";
import { getTimeline, getTrends, getWhoToFollow, searchUsers } from "@/server/queries";

export async function generateMetadata({ searchParams }: PageProps<"/explore">): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: typeof q === "string" && q ? `${q} - Search` : "Explore" };
}

const TABS = ["top", "latest", "people", "media"] as const;
type Tab = (typeof TABS)[number];

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "top";

  if (!q) return <ExploreHome peopleOnly={tab === "people"} />;

  // Build hrefs with URLSearchParams so they match what usePathname/useSearchParams report.
  const href = (t: Tab) => `/explore?${new URLSearchParams({ q, ...(t === "top" ? {} : { tab: t }) })}`;

  return (
    <>
      <PageHeader>
        <div className="px-4 py-1.5">
          <SearchBox defaultValue={q} />
        </div>
        <Tabs
          tabs={[
            { label: "Top", href: href("top") },
            { label: "Latest", href: href("latest") },
            { label: "People", href: href("people") },
            { label: "Media", href: href("media") },
          ]}
        />
      </PageHeader>
      {tab === "people" ? (
        <PeopleResults q={q} />
      ) : (
        <PostResults key={`${q}:${tab}`} q={q} tab={tab} />
      )}
    </>
  );
}

async function PostResults({ q, tab }: { q: string; tab: SearchTab }) {
  const source: TimelineSource = { kind: "search", q, tab };
  const initial = await getTimeline(source);
  return (
    <Timeline
      source={source}
      initial={initial}
      empty={
        <EmptyState
          title={`No results for "${q}"`}
          body="Try searching for something else, or check your spelling."
        />
      }
    />
  );
}

async function PeopleResults({ q }: { q: string }) {
  const users = await searchUsers(q, 30);
  if (users.length === 0) {
    return <EmptyState title={`No people found for "${q}"`} body="Try a different name or username." />;
  }
  return users.map((user) => <UserRow key={user.id} user={user} />);
}

async function ExploreHome({ peopleOnly }: { peopleOnly: boolean }) {
  const [trends, people] = await Promise.all([
    peopleOnly ? Promise.resolve([]) : getTrends(10),
    getWhoToFollow(peopleOnly ? 30 : 5),
  ]);

  return (
    <>
      <PageHeader>
        <div className="px-4 py-1.5">
          <SearchBox />
        </div>
      </PageHeader>
      {trends.length > 0 && (
        <section className="border-b border-border">
          <SectionHeading>Trending</SectionHeading>
          {trends.map((trend, i) => (
            <TrendLink key={trend.tag} trend={trend} rank={i + 1} />
          ))}
        </section>
      )}
      <section>
        <SectionHeading>{peopleOnly ? "Suggested for you" : "Who to follow"}</SectionHeading>
        {people.length === 0 ? (
          <p className="px-4 py-3 text-[15px] text-fg-muted">You follow everyone. Nice.</p>
        ) : (
          people.map((user) => <UserRow key={user.id} user={user} />)
        )}
        {!peopleOnly && people.length > 0 && <ShowMoreLink href="/explore?tab=people" />}
      </section>
    </>
  );
}
