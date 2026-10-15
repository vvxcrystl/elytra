import { getTrends, getWhoToFollow } from "@/server/queries";
import { HideOnExploreHome } from "./hide-on-explore-home";
import { SearchBox } from "./search-box";
import { SectionHeading, ShowMoreLink, TrendLink } from "./section";
import { UserRow } from "./user-row";

// shrink-0 keeps the panels at full height inside the scrolling column.
const PANEL = "shrink-0 overflow-hidden rounded-2xl border border-border";

export async function RightRail() {
  const [trends, suggestions] = await Promise.all([getTrends(5), getWhoToFollow(3)]);

  return (
    <div className="sticky top-0 flex max-h-dvh flex-col gap-4 overflow-y-auto pt-1.5 pb-16 [scrollbar-width:none]">
      <SearchBox hideOnExplore className="sticky top-0 z-10 shrink-0 bg-bg pb-1" />

      <HideOnExploreHome>
        {trends.length > 0 && (
          <section className={PANEL}>
            <SectionHeading>Trends for you</SectionHeading>
            {trends.map((trend) => (
              <TrendLink key={trend.tag} trend={trend} />
            ))}
            <ShowMoreLink href="/explore" />
          </section>
        )}

        {suggestions.length > 0 && (
          <section className={PANEL}>
            <SectionHeading>Who to follow</SectionHeading>
            {suggestions.map((user) => (
              <UserRow key={user.id} user={user} showBio={false} />
            ))}
            <ShowMoreLink href="/explore?tab=people" />
          </section>
        )}
      </HideOnExploreHome>
    </div>
  );
}
