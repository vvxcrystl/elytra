# Local backend measurements — October 14, 2026

For compiler and build measurements, see the [ts-rust comparison](2026-10-14-ts-rust.md).

Measured the final backend through the production Next standalone server over loopback HTTP, with the default backend settings and demo seeding disabled. The fixture contained 100 independent accounts, 10,000 posts, 30,000 initial likes, and ten follows per account. The load driver and server shared an AMD Ryzen 7 7700 host (16 available logical CPUs, about 30 GiB RAM), Linux x64, Node 26.10.0, Next 16.4.0. The SQLite file was on **tmpfs**, so these results exclude physical disk durability latency.

After a three-second warm-up, each test generated ten seconds of closed-loop traffic with no think time, retries, or application request logging. The reported elapsed time also includes draining in-flight requests. Each client used a distinct authenticated account.

- **25 clients, reads:** 2,336 requests, **231.2 requests/second**, zero failures. Per-route p95 ranged from 189.7 to 199.3 ms. [Raw report](2026-10-14-read-25.json).
- **100 clients, reads:** 2,385 requests, **228.4 requests/second**, zero failures. Per-route p95 ranged from 463.5 to 480.3 ms. [Raw report](2026-10-14-read-100.json).
- **25 clients, reads and mutations:** 3,084 requests, **306.7 requests/second**, zero failures, including 879 idempotent like/unlike requests. Per-route p95 ranged from 133.1 to 171.1 ms. [Raw report](2026-10-14-mixed-25.json).

The read mix evenly cycled through profile, fresh Following feed, fresh For You feed, notification unread count, and message unread count. The mutation test added PUT/DELETE on one fixture post; its more frequent cheap operations reduced the proportion of expensive ranking requests, which explains its higher overall throughput. The fixture has no DM history or image traffic, so those results do not establish messaging/upload capacity. Post-run server resident memory/high-water mark was approximately 383 MiB across the warm-up and all three tests; this was not a long-duration memory soak test.

Increasing clients from 25 to 100 increased waiting without increasing throughput. This workload was already near the single-process service limit at 25 clients. Do not interpret 100 concurrent requests as 100 requests/second, a supported active-user count, or a production SLA. Long graph histories, large follow graphs, real disk fsyncs, SSR, uploads, TLS/network latency, and other host workloads can substantially change the result.

The backend integration fixture separately timed five fresh For You pages after adding 5,000 posts and associated graph activity: 25.0–25.7 ms per page, with a 6.2 ms cold-start page in that run. This is a data-layer check, distinct from end-to-end HTTP latency. All 52 integration groups passed (22 backend, 11 API covering 59 operations, 7 E2EE, 12 concurrency), along with type checking, lint, and the production build.

Use the [operations guide](../BACKEND.md#validate-and-measure) and `seed:load` / `load:api` scripts to repeat these tests against a new isolated fixture on deployment hardware. No public installation or existing application data was used for these load tests.
