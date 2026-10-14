# Elytra For You implementation

The only changed timeline source is `{ kind: "home", tab: "for-you" }`. `getTimeline(source, cursor)` and `fetchTimeline(source, cursor)` retain their contracts and 20-item pages. Following and all other timelines retain their previous selection and ordering. No shared types, UI files, seed data, or package scripts changed.

This is original TypeScript and SQL, based on the design documented in [Home Mixer](https://github.com/twitter/the-algorithm/tree/main/home-mixer) and the [recap heavy-ranker README](https://github.com/twitter/the-algorithm-ml/blob/main/projects/home/recap/README.md). No AGPL source code was copied. The linked March 31, 2023 engineering blog returned 404 when checked; the primary repository documentation was used instead.

## Pipeline stages

1. **Candidate sourcing / Earlybird, UTEG and SimClusters analogues.** Four independent pools each cap at 150 results: recent followed-author posts; followed-account reposts; posts liked, reposted, bookmarked, replied to or quoted by followed accounts; and posts with strong author/hashtag affinity. Candidates must be no older than 14 days. A personalized snapshot has at most 600 candidates before canonical post deduplication. Signed-out viewers and users with neither follows nor engagement history get up to 150 globally popular recent posts instead. Popular retrieval uses age-adjusted likes, reposts, replies and bookmarks. Cold start is the sole exception to the out-of-network proof requirement.
2. **Feature hydration / RealGraph and sparse interest analogues.** SQL batches hydrate post and author engagement counts, distinct impression exposures, six-hour engagement velocity, media, replies, mentions, followed-account social proof, reciprocal interactions, and negative feedback. Ninety-day viewer history gives likes weight 1, bookmarks/quotes 2, reposts 3 and replies 4, attenuated by `1 / (1 + eventAgeDays / 30)`. Author relationship is `min(1, 1-exp(-historyStrength/6) + 0.2*isFollowed)`. Similarity combines direct relationship, two-hop follows, and matching tags from the viewer's twelve most-used engaged-with hashtags. Out-of-network proof requires a followed engager or similarity at least 0.6.
3. **Heavy-ranker stand-in.** Smoothed post, author and personal engagement estimates are combined with relationship, similarity, social proof, mentions and velocity. These are transparent heuristics, not trained or calibrated probabilities.
4. **Home Mixer filters and heuristics.** Exclude own posts, physically deleted posts, explicitly dismissed posts and posts seen within 24 hours. If no unseen recommendations remain, retry candidate ranking with viewed posts included; fatigue penalties still apply and explicit dismissals remain excluded. Canonicalize originals and reposts by post ID. Resolve reply ancestry with one recursive SQL query, then retain only one item per conversation. Discard corrupt cycles/chains deeper than 100. Greedy mixing targets 50/50 in-network and out-of-network while both eligible pools exist. Repeated-author penalties apply, with a hard limit of two consecutive items from the same author. If no other author is eligible, the snapshot ends instead of violating the limit.
5. **Serving / cursoring.** Reuse the 24-hour database snapshot: rank once for a refresh and page the stored order with the existing opaque cursor. Snapshot lookup checks both viewer and source. New posts, engagement changes and impressions do not reorder or remove items from an active snapshot. Explicit dismissals, deletions and undone reposts are skipped at serving time. Impressions affect the next refresh only.

## Scoring details

The supported historical recap weights, published April 5, 2023, are:

```text
W = 0.5 P(like) + 1 P(repost) + 13.5 P(reply)
  + 12 P(good profile click) + 75 P(reply engaged by author)
  + 11 P(good conversation click) - 74 P(negative feedback)
score = exp(-ageHours/72) * (max(0,W)/(1+0.25*recentSeenCount) + min(0,W))
```

For each engagement `k`, let `r` be its prior: like .035, repost .012, reply .008, bookmark .01, quote .005. Post exposure is `max(20, distinctPostImpressions, 3*postEngagements)`; author exposure is `max(20, distinctAuthorPostImpressions, 20*authorPosts30d, 3*authorEngagements)`. Then:

```text
postRate = (postCount[k] + 20*r) / (postExposure + 20)
authorRate = (authorCount[k] + 40*r) / (authorExposure + 40)
personalRate = (viewerAuthorCount[k] + 20*r) / (viewerAuthorImpressions + 20)
affinity = 1 + 3*relationship + 1.2*similarity
         + min(.8,.15*socialProofCount) + .4*mentionsViewer
velocity = 1 + min(.5,recent6hEngagements/(6+max(1,ageHours)))
P(k) = clamp((.55*postRate+.30*authorRate+.15*personalRate)*affinity*velocity,0,.95)
```

Media multiplies the like estimate by 1.1; reply candidates multiply the reply estimate by 1.15. The repost estimate includes half the quote estimate. Derived profile probability is `.12*like + .2*reply`; good conversation click is `.25*like + .5*reply + .4*bookmark`; reply engaged by author is `reply * min(.7,.05+.15*relationship+.08*reciprocalInteractions)`. Derived outputs are also clamped. Negative probability is `n/(n+3) * exp(-daysSinceLastFeedback/7)` for feedback on that author during the last 30 days. An explicitly dismissed post stays excluded regardless of author penalty decay.

Diversity selection utility subtracts `abs(score)*min(.8,.15*priorAuthorItems)` plus another `.3*abs(score)` when the preceding item has that author. Content balance takes precedence when both pools have eligible candidates. Stable ties use creation time and post ID.

## Additive schema

- `impressions(user_id, post_id, first_seen_at, last_seen_at, seen_count)`, primary key `(user_id,post_id)`, user/post foreign keys with delete cascades.
- `negative_feedback(user_id, post_id, author_id, created_at)`, primary key `(user_id,post_id)`, user/post/author foreign keys with delete cascades.
- New indexes: `posts_quote(quote_id,created_at)`, `impressions_post(post_id)`, `impressions_viewer_time(user_id,last_seen_at)`, `negative_feedback_author(user_id,author_id,created_at)`, `negative_feedback_post(post_id)`.

All additions use `CREATE ... IF NOT EXISTS`; there are no destructive migrations or altered existing columns. A module-local connection guard reapplies the idempotent schema when HMR reuses an existing global connection. Tests exercise both cached-connection migration and reconnecting a populated file-backed database.

## UI handoff

Exports from `src/server/actions.ts`:

```typescript
recordImpressions(postIds: string[]): Promise<ActionResult>
markNotInterested(postId: string): Promise<ActionResult>
```

Both return `{ok:false,error:"You need to sign in"}` when signed out and `{ok:true,data:undefined}` on success. `recordImpressions` intentionally returns `ActionResult`, rather than the brief's `void`, to satisfy its explicit standard authentication-error requirement. Call it for actually visible posts, in batches of at most 100 valid IDs. IDs must match `[A-Za-z0-9_-]{1,100}`. Duplicate batch IDs are collapsed; nonexistent/deleted IDs are ignored. Repeated callbacks within a minute update last-seen time without inflating seen count. It does not revalidate or refresh the feed. Negative feedback validates existence, is idempotent per viewer/post, and revalidates through the existing `refresh()` helper. Claude owns all UI wiring.

## Verification and limits

`npm run test:backend` covers existing functionality plus ranking, proof, topic similarity, own-post exclusion, 50/50 mixing, author diversity, original/repost deduplication, nested conversation deduplication, snapshot completeness/isolation/expiry, both cold-start cases, seen filtering/fatigue, negative feedback, deletion cascades, migrations and latency. The benchmark adds 5,000 posts, 10,000 likes, 1,667 reposts and 10,000 hashtag associations, then times five fresh ranked pages and a cold-start page; each has a 100 ms budget. `npx tsc --noEmit` and `npx eslint src/server scripts` are the static checks.

There is no neural model, learned embedding, profile-visit telemetry, mute/block/report system, safety classifier, video playback, two-minute dwell prediction, ads or conversation-module UI. Profile and conversation click outputs are proxies from observed engagements; unavailable recap outputs are omitted rather than fabricated. Counts are exact SQL aggregates over bounded history, not approximate distributed features. Candidate/result caps, a 14-day window and strict diversity may shorten feeds. Optional signals only become useful after the UI reports them. The demo remains eight users and 42 posts, with `theo` and `demo` passwords unchanged.
