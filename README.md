# softgarden-crawler

Discovers [Softgarden](https://softgarden.de) ATS customers from the Common Crawl index and
crawls their job postings across **all three** of Softgarden's career-site generations.

SQLite or Postgres storage, per-job change detection, confirmed expiry, drop alerting, a
weekly schedule, a dashboard, and Docker. **No required dependencies** — the default path is
Node's built-ins only (`node:sqlite`, `node:test`, `fetch`), so there is nothing to install.

```bash
npm run discover     # find customers, detect each one's front end
npm run crawl        # listings + per-job details into the database
npm run stats        # what's in the database
npm run dashboard    # http://localhost:8080
npm run schedule     # stay running, crawl weekly
```

Or the whole stack:

```bash
docker compose up -d        # dashboard + weekly scheduler, data on a volume
```

## Why this is not a one-selector scraper

Softgarden runs three different career-site front ends, and a crawler that assumes one of them
silently loses most of the market. Current snapshot: **775 customers discovered, 761 live.**

| | `career.softgarden.de` (Next.js) | `career.softgarden.de` (server-rendered) | `softgarden.io` (Wicket) |
|---|---|---|---|
| Share of live customers | ~8% | a handful | **~91%** |
| `jobs.feed.json` | yes | yes | **404** |
| Widget list API | yes | yes | **no** |
| Widget IDs found in | `__NEXT_DATA__` | plain `"userId"/"projectId"/"pageId"` keys | n/a |
| Listings from | widget API, paginated | widget API, paginated | one server-rendered page |
| Details from | `context.job` | `context.job` | JSON-LD `JobPosting` |

The naive plan — "take the feed, keep whatever responds" — would have discarded about 90% of
customers, because the feed only exists on one of the three.

## Where the data actually comes from

### Discovery: Common Crawl's index files, not its API

`index.commoncrawl.org` rate-limits hard and goes down for long stretches — sustained 504s on
every query, including `url=example.com&limit=1`. So discovery reads the static index under
`data.commoncrawl.org`:

1. download `cluster.idx` once per snapshot (~100 MB) and cache it
2. scan it locally for the blocks covering the SURT prefixes `de,softgarden,career,` and
   `io,softgarden,`
3. range-fetch only those blocks (1 block + 5 blocks respectively) and extract hostnames

**Do not binary-search `cluster.idx` over HTTP range requests.** It is elegant — ~14 small
requests instead of a 100 MB download — and CloudFront's WAF treats that burst as abuse, then
returns an immediate `403 Request blocked` for *every* request from your IP for the next
15–30 minutes. One cached bulk GET is both friendlier and simpler. This is in the code as a
comment, because it is the kind of mistake that gets reintroduced.

`--index-server` keeps the old CDX API path available as a fallback.

### Listings: the widget API, paginated

`POST https://pcw-api.softgarden.de/widgets/job-list/job-ads` — undocumented, no auth. Needs
three UUIDs, all extractable from the career page itself.

Measured behaviour, which the [pagination tests](test/pagination.test.js) pin:

- `jobsLength` is the **authoritative** total. The career page's own `context.jobAds.count`
  disagrees with it (1058 vs 1049 on one tenant) — never use that for completeness.
- `pagination.dataSource.length` gives the page count, but it is only trusted when the total
  is unknown: a page count that contradicts `jobsLength` must not cost rows.
- `numberOfJobsOnPage` is honoured well past 200 (a 1049-job tenant returns all of them at
  2000), but relying on an unbounded page size is fragile. Default is 100.
- Verified live: a 1049-job tenant yields 1049 unique jobs across 11 pages, no overlap.

### Details: the job page, because the list endpoint has no descriptions

The widget list endpoint is a *listing* endpoint — its records carry title, location, category,
career level, work time, coordinates and dates, but **no description field at all**. There is no
widget detail endpoint either: `/widgets/job-ad`, `/widgets/job-detail/job-ad` and friends all
404. So detail comes from the job page:

- **career pages** → `__NEXT_DATA__` → `props.pageProps.data.context.job`. The richest source
  available: full HTML description, `remoteStatusKey` (`FULLY_REMOTE`), career level, work
  experience, employment type, **ISO country code**, apply link, and a per-job `versionId`.
- **legacy board** → `<script type="application/ld+json">` `JobPosting`: description,
  `datePosted`, `validThrough`, `baseSalary`, full `PostalAddress`.

`versionId` matters because the feeds have **no per-job `dateModified`** — only a feed-level one.
It is the exact change signal on the career stack; elsewhere a content hash stands in.
(`context.job` does also carry its own `createdAt`/`updatedAt`, which the feeds do not expose —
those are stored too, but `versionId` remains what change detection compares.)

### Everything else the payload carries

`context.job` has **47 keys** and this mapped about 20 of them, which threw away `createdAt`,
`updatedAt`, `published`, `imported`, `jobBoardType`, `totalApplications`, `sgJobAdProjectNumber`,
`additionalLocations`, the ATS's own content `hash`, and more. The useful ones are now columns.
The rest is not lost either: `job_payloads` keeps the verbatim source JSON per job, as text
rather than compressed so SQL can read into it.

```sql
-- a field nobody thought to map, straight out of the stored payload
SELECT job_id,
       json_extract(payload, '$.category')   AS category,
       json_extract(payload, '$.coords.lat') AS lat
FROM job_payloads WHERE source = 'career';
```

It costs roughly 9 KB per career job and 4 KB per board job, which the dashboard never reads —
that is the point: recovering a field later should not mean re-crawling 30,000 pages.
`SG_STORE_RAW=0` turns it off. Payloads are written when a job is new or changed, and otherwise
only if absent, so a weekly run does not rewrite 30k identical blobs.

#### When a tenant cannot serve its own job pages

Some career pages advertise jobs they have no route for. The first full run lost 1,288
descriptions this way, concentrated in 11 of 761 tenants:

- A **landing-role project** (`context.projectRole === 'landing'`) lists jobs through the widget
  and even reports a `/jobs/<id>/<slug>/` link for each, but the landing app has no job route, so
  every one of those URLs 404s. `ueber-uns-schuelerhilfe` is 1,047 jobs of exactly this.
- A few `root` career tenants publish their postings only on the legacy board.

Both are the same shape — the postings live on a `*.softgarden.io` board under a shorter slug —
so `resolveDetailHost` drops leading slug segments (`ueber-uns-schuelerhilfe` → `schuelerhilfe`)
and **verifies each candidate by fetching a real job id** before accepting it. Nothing is
inferred from the name alone: a host only counts if it returns a `JobPosting`. The result is
stored in `tenants.detail_host`, so later runs skip the search, and resolution is attempted only
for a tenant whose details *all* failed — a healthy tenant pays nothing.

A job ID is not globally addressable, by the way: `schuelerhilfe.softgarden.io/job/<id>` serves
it, and every other board host 404s the same ID. Only the owning tenant can answer.

When a detail fetch still fails, the reason is written to `jobs.detail_note` and shown by
`npm run stats`. An earlier version produced that reason and dropped it, because the column did
not exist — so a whole run's failures left no trace and had to be re-diagnosed against the live
sites. `syncColumns` now adds schema columns to databases that predate them.

### Feeds: for timing, not for truth

`{host}/jobs.feed.json` is read only to answer "did this customer change at all". Its values are
the messiest of the three sources. From home24's live feed:

- `addressRegion` mixes languages: `Niedersachsen` **and** `Lower Saxony` in one document
- `addressCountry` mixes `Deutschland` and `Germany`
- `postalCode` is sometimes `"-"`
- no job carries `validThrough`

[`normalize.js`](src/normalize.js) folds all of that to ISO country codes, canonical German
region names, and `NULL` for junk placeholders.

## Rate limits are the real constraint

Not parsing. Two different WAFs will stop you:

- **Career hosts (Cloudflare).** Start returning 429 above ~3 concurrent requests. An early
  run at concurrency 8 had **554 of 775 tenants fail** — they looked dead, but it was pure
  throttling. Defaults are `SG_CONCURRENCY=3`, `SG_RPS=4`, with `Retry-After` honoured.
- **`data.commoncrawl.org` (CloudFront).** See the discovery note above. A 403 there is not
  retried, because retrying extends the block; the error says to wait or use `--index-server`.

## Expiry is confirmed, never assumed

A job missing from a crawl is a *candidate* for closing. It is closed only when fetching its URL
returns a definitive **404/410** — a throttled or timed-out request must never look like a
removed job. Each run also snapshots per-tenant counts and raises an alert when a count falls by
more than `SG_DROP_THRESHOLD` (default 30%), since a cliff is usually a crawl problem rather
than a customer closing 80% of its roles.

## Commands

| | |
|---|---|
| `npm run discover` | Find slugs in Common Crawl, detect each tenant's front end, record feed availability |
| `npm run crawl` | Listings for every live tenant + per-job details (`--no-details` to skip) |
| `npm run details` | Backfill details for jobs that have none (`--limit n`) |
| `npm run weekly` | `discover` + `crawl` with details — what the schedule runs |
| `npm run schedule` | Long-running scheduler on `SG_CRON` (default Mondays 03:17 UTC) |
| `npm run stats` | Database summary, recent runs, alerts, next scheduled run |
| `npm run alerts` | Recent drop alerts |
| `npm run export` | `--what jobs\|tenants --format csv\|ndjson --out path` |
| `npm test` | 30 unit tests, no network |

Useful flags: `--crawls n` (merge several snapshots), `--slug a,b` (restrict), `--detail-limit n`
(cap details per tenant).

## Scheduling

Two options, both weekly:

- **In-process:** `npm run schedule` parses `SG_CRON` with a small dependency-free 5-field cron
  implementation (`*`, lists, ranges, steps, `7` as Sunday), sleeps to the next match, and
  **skips rather than queues** a tick if the previous run is still going.
- **CI:** [`.github/workflows/weekly.yml`](.github/workflows/weekly.yml) runs it on GitHub
  Actions, caching both the SQLite database and `cluster.idx` between runs so change detection
  and drop alerts have history to compare against, and uploading CSV exports as artifacts.

## Storage

Two backends behind one interface ([`src/storage/`](src/storage/)), chosen by env var:

| | |
|---|---|
| **SQLite** (default) | `node:sqlite`, no install. `git clone && npm run crawl` just works. |
| **Postgres** | set `SG_DB_URL`; needs `npm install pg` (an optionalDependency, so it is not pulled in by default). |

All SQL lives in [`src/repository.js`](src/repository.js) and is written to run on both: `?`
placeholders (rewritten to `$1..$n` for Postgres), `ON CONFLICT ... DO UPDATE`, `INSERT ...
RETURNING id`, and no SQLite-only scalars — no `MAX(a,b)`, no `datetime('now')`. A test asserts
the two schema files declare identical tables and columns, so a column added to one and
forgotten in the other fails CI rather than production.

`node:sqlite` is synchronous and `pg` is not, so the repository is async throughout.

Tables ([`schema.sqlite.sql`](src/storage/schema.sqlite.sql) /
[`schema.postgres.sql`](src/storage/schema.postgres.sql)):

- `tenants` — slug, platform, host, branded domain, company, widget IDs, feed availability
- `jobs` — the unified job record, keyed `(tenant_slug, job_id)`, with `version_id` /
  `content_hash` for change detection and `is_open` / `closed_at` for lifecycle
- `runs` — one row per run: counts of new/updated/closed, details filled, errors
- `tenant_snapshots` — per-run job counts, the basis for drop detection
- `alerts` — what fired, when

Note that SQLite runs in WAL mode: the `.db` file alone is not the whole database. Copy
`*.db*` (including `-wal` and `-shm`) or close the writer first, or you will silently move an
older snapshot — which is exactly what happened the first time I seeded a Docker volume by hand.

## Setup

Needs **Node ≥ 22.5** (for `node:sqlite`). No `npm install` for the default SQLite path — there
are no required dependencies.

```bash
git clone https://github.com/UncleLeggs/softgarden-crawler.git && cd softgarden-crawler
cp .env.example .env          # optional; every value has a default
npm test
npm run discover              # ~2 min, downloads and caches a ~100 MB index file
npm run crawl -- --no-details # listings only, fast
npm run crawl                 # with details: one request per job, so be patient
npm run stats
npm run dashboard             # http://localhost:8080
```

### Docker

```bash
docker compose up -d                              # dashboard :8080 + weekly scheduler
docker compose run --rm crawler-once discover     # one-off commands
docker compose run --rm crawler-once crawl --no-details
docker compose logs -f scheduler
```

Two named volumes persist the state that has to outlive containers: `sgdata` for the database
(change detection and drop alerts compare against previous runs) and `ccindex` for the ~100 MB
Common Crawl index.

Postgres instead of SQLite:

```bash
npm install pg
SG_DB_URL=postgres://softgarden:softgarden@db:5432/softgarden \
  docker compose --profile postgres up -d
```

## Dashboard

`npm run dashboard`, or port 8080 from the compose stack. A zero-dependency Node server
([`src/dashboard/server.js`](src/dashboard/server.js)) serving `/api/summary`, `/api/jobs` and
`/healthz`, plus a single-file front end with hand-rolled inline SVG charts — no CDN, so it works
in an offline container.

Front-end generation split, open jobs by country, top tenants, and a crawl-history line chart
over runs; plus run and alert tables. Light and dark are both selected (not an automatic flip),
every chart has a hover tooltip, and a **Table view** toggle gives the same numbers as text —
which is also what the palette's one sub-3:1 contrast slot requires. The categorical palette was
validated with the data-viz validator (all checks pass in both modes).

Details are one request per job. At 30k open jobs and a deliberately polite rate, a full detail
pass is an overnight job — use `--detail-limit` or the incremental `details` command, which is
what the weekly schedule relies on.

## Deploying the public dashboard

The live dashboard serves a **publication-safe snapshot**, not the crawl database:

```bash
npm run build:public      # data/softgarden.db -> data/public.db
fly auth login            # once
fly launch --copy-config --name <app> --ha=false --no-deploy   # once
fly deploy --remote-only --ha=false                            # ~18 MB baked in
```

### Deploying on every weekly run

`weekly.yml` chains it: crawl → export → build the snapshot → `flyctl deploy`. To enable it,
create a deploy token and store it as a repository secret:

```bash
fly tokens create deploy -a softgarden-crawler   # then add as secret FLY_API_TOKEN
```

`--ha=false` on both: `launch` and `deploy` each default to adding a spare machine for
zero-downtime rollout, which doubles the footprint of a read-only dashboard that can afford a
second of resume.

A deploy can be run on its own, without a crawl:

```
Actions -> weekly-crawl -> Run workflow -> mode: publish-only
```

That restores the cached database, rebuilds the snapshot and deploys. Worth having: a deploy
path only reachable through a two-hour crawl is one you cannot test or re-run.

Without that secret the crawl still runs and simply logs that publishing was skipped, so a fork
is not expected to hold deploy credentials. The publish step runs `--min-jobs=20000`: a snapshot
below that floor means the crawl broke rather than the market emptying, and it is better to keep
serving the previous deploy than to publish a hollow one.

`job_payloads` is dropped from the published copy, not filtered — it holds the raw descriptions.

`scripts/build-public-db.mjs` strips `description_html` and `description_text` and refuses to
emit a file that still contains them, or that matches an email or phone pattern in any other
text column. That is not cosmetic: descriptions are 180 MB of the 220 MB, and in a sample of
4,000 of them **26% contained an email address and 36% a phone number** — recruiter contact
details belonging to other companies, which do not belong on a public URL. The dashboard never
rendered that text anyway; it shows aggregates and links out to the original posting.

Coverage still reports after the strip because `jobs.has_description` records the fact
separately from the text — that is the reason the column exists.

The deployed container is read-only: no volume, no scheduler, no crawling. Publishing newer
numbers is `npm run build:public && fly deploy`.

## Limits, stated plainly

- Coverage is bounded by the Common Crawl snapshot. `home24` is a live Softgarden customer that
  was **not** in `CC-MAIN-2026-43`, so production should also seed slugs from the vendor side or
  from certificate transparency (`crt.sh` finds only the handful with dedicated certs — most
  hide behind a `*.career.softgarden.de` wildcard).
- `pcw-api` is undocumented and could change without notice. The official
  [Frontend API v3](https://dev.softgarden.de/frontend-v3/) is a different, OAuth-based surface
  that never mentions it.
- `validThrough` exists only on the legacy board; the career stack does not expose it.
- Salary is present in the payload but usually empty.
- The legacy board renders every job server-side, so its counts are exact — but if Softgarden
  ever switches it to real server-side pagination, `fetchBoardListings` needs a page loop.
- A small number of board job pages (42 of 29,897 in the last full run, mostly one tenant) carry
  **no JSON-LD at all**; their description sits in `div.free-text` / `div.section-content__body`.
  Scraping those class names is deliberately *not* implemented: it is 0.14% of rows, and a
  regex over nested `<div>`s is the kind of selector that rots silently. They are recorded as
  `no JSON-LD JobPosting` in `detail_note` and counted, which is the honest alternative.

## License

MIT
