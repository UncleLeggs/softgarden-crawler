import { config } from './config.js';
import { log } from './logger.js';
import { pool, request } from './http.js';
import { discoverSlugs } from './commoncrawl.js';
import { detectTenant, PLATFORM } from './tenants.js';
import { fetchAllWidgetJobs } from './sources/widget.js';
import { fetchBoardListings } from './sources/board.js';
import { fetchJobDetail, absoluteJobUrl } from './sources/detail.js';
import { fetchFeedMeta } from './sources/feed.js';
import { normalizeRegion, nullIfBlank, numOrNull, toIso, decodeEntities } from './normalize.js';
import { createStore } from './storage/index.js';
import * as repo from './repository.js';

/** Widget listing record -> unified shape (no description; that needs a detail fetch). */
function listingFromWidget(tenant, j) {
  return {
    jobId: String(j.id ?? j.jobPostingId),
    url: absoluteJobUrl(tenant, { url: j.link }),
    title: nullIfBlank(decodeEntities(j.title)),
    city: nullIfBlank(decodeEntities(j.location)),
    region: normalizeRegion(j.region),
    careerLevel: nullIfBlank(j.careerLevel),
    workTime: nullIfBlank(j.workTime),
    streetAddress: nullIfBlank(decodeEntities(j.geoLocationName)),
    lat: numOrNull(j.coords?.lat),
    lng: numOrNull(j.coords?.lng),
    categories: Array.isArray(j.categories) && j.categories.length ? j.categories : null,
    datePosted: toIso(j.date),
    detailOk: false,
  };
}

async function listingsFor(tenant) {
  if (tenant.platform === PLATFORM.BOARD) return fetchBoardListings(tenant);
  const r = await fetchAllWidgetJobs(tenant);
  return { jobs: r.jobs.map((j) => listingFromWidget(tenant, j)), total: r.total };
}

export async function runDiscover({ crawls = config.crawls, store: given } = {}) {
  const store = given ?? await createStore();
  const runId = await repo.startRun(store, 'discover');
  const errors = [];

  let seen;
  try {
    seen = await discoverSlugs({ crawls });
  } catch (err) {
    errors.push(String(err.message));
    await repo.finishRun(store, runId, {}, errors);
    throw err;
  }

  const entries = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  log.info(`discovered ${entries.length} slugs; detecting front ends (concurrency ${config.concurrency})`);

  let live = 0;
  const results = await pool(entries, config.concurrency, async ([slug, domains]) => {
    const tenant = await detectTenant(slug, [...domains]);
    if (tenant.live) {
      live++;
      // Feed presence is a cheap fact worth recording once per tenant.
      tenant.feedAvailable = tenant.platform === PLATFORM.BOARD
        ? false
        : (await fetchFeedMeta(tenant)).available;
    }
    await repo.upsertTenant(store, tenant, [...domains].sort().join('|'));
    return tenant;
  }, (done, total) => { if (done % 50 === 0) log.info(`  detected ${done}/${total} (live ${live})`); });

  const byPlatform = {};
  for (const t of results) if (t?.live) byPlatform[t.platform] = (byPlatform[t.platform] ?? 0) + 1;
  await repo.finishRun(store, runId, { tenantsSeen: entries.length, tenantsLive: live }, errors);
  log.info(`discover done: ${live}/${entries.length} live ${JSON.stringify(byPlatform)}`);
  if (!given) await store.close();
  return { runId, total: entries.length, live, byPlatform };
}

/**
 * Crawl listings for every live tenant, then optionally fetch per-job details.
 * Jobs that vanished are confirmed with a URL check before being closed -- a
 * throttled or timed-out request must never look like a removed job.
 */
export async function runCrawl({
  withDetails = true, slugs = null, store: given, detailLimit = config.detailLimit,
} = {}) {
  const store = given ?? await createStore();
  const runId = await repo.startRun(store, withDetails ? 'crawl+details' : 'crawl');
  const errors = [];

  const tenants = await repo.getTenants(store, { liveOnly: true, slugs });
  if (!tenants.length) {
    await repo.finishRun(store, runId, {}, ['no live tenants -- run discover first']);
    if (!given) await store.close();
    throw new Error('no live tenants in the database; run `npm run discover` first');
  }

  const stats = { tenantsSeen: tenants.length, tenantsLive: tenants.length,
    jobsSeen: 0, jobsNew: 0, jobsUpdated: 0, jobsClosed: 0, detailsOk: 0 };

  log.info(`crawling ${tenants.length} tenants (concurrency ${config.concurrency}, details ${withDetails})`);
  let processed = 0;

  await pool(tenants, config.concurrency, async (tenant) => {
    try {
      const { jobs } = await listingsFor(tenant);
      stats.jobsSeen += jobs.length;
      await repo.snapshot(store, runId, tenant.slug, jobs.length);

      const wanted = detailLimit > 0 ? jobs.slice(0, detailLimit) : jobs;
      const details = new Map();
      if (withDetails && wanted.length) {
        // One request per job, so details dominate the budget; keep them gentle.
        const got = await pool(wanted, Math.max(1, Math.min(2, config.concurrency)), async (listing) => {
          try { return [listing.jobId, await fetchJobDetail(tenant, listing)]; }
          catch (err) { return [listing.jobId, { detailOk: false, note: err.message }]; }
        });
        for (const entry of got) if (Array.isArray(entry)) details.set(entry[0], entry[1]);
      }

      for (const listing of jobs) {
        const detail = details.get(listing.jobId);
        if (detail?.detailOk) stats.detailsOk++;
        const merged = {
          ...listing,
          ...(detail?.detailOk ? detail : {}),
          jobId: listing.jobId,
          url: detail?.url ?? listing.url,
          detailOk: Boolean(detail?.detailOk),
          companyName: detail?.companyName ?? tenant.companyName ?? null,
        };
        const outcome = await repo.upsertJob(store, tenant.slug, merged);
        if (outcome === 'new') stats.jobsNew++;
        else if (outcome === 'updated') stats.jobsUpdated++;
      }

      for (const row of await repo.missingJobs(store, tenant.slug, jobs.map((j) => j.jobId))) {
        if (await confirmGone(row.url)) {
          await repo.closeJob(store, tenant.slug, row.job_id);
          stats.jobsClosed++;
        }
      }
    } catch (err) {
      errors.push(`${tenant.slug}: ${err.message}`);
      log.warn(`${tenant.slug}: ${err.message}`);
    } finally {
      if (++processed % 25 === 0) log.info(`  ${processed}/${tenants.length} tenants, ${stats.jobsSeen} listings`);
    }
  });

  const drops = await repo.detectDrops(store, runId);
  await repo.finishRun(store, runId, stats, errors);
  log.info(`crawl done: ${JSON.stringify(stats)}`);
  if (drops.length) log.warn(`job-count drops: ${drops.map((d) => `${d.tenantSlug} -${d.dropPct}%`).join(', ')}`);
  if (!given) await store.close();
  return { runId, stats, drops, errors };
}

/** A missing job is closed only on a definitive 404/410. */
async function confirmGone(url) {
  if (!url) return false;
  try {
    const res = await request(url, { ua: config.browserUA, retries: 2, timeoutMs: 30_000,
      label: `confirm ${url}` });
    return res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

/** Fill in details for open jobs that have none yet, oldest first. */
export async function runDetails({ limit = 500, store: given } = {}) {
  const store = given ?? await createStore();
  const runId = await repo.startRun(store, 'details');
  const rows = await repo.jobsNeedingDetail(store, limit);

  if (!rows.length) {
    await repo.finishRun(store, runId, {});
    log.info('no jobs missing details');
    if (!given) await store.close();
    return { runId, filled: 0 };
  }

  const tenants = new Map((await repo.getTenants(store, { liveOnly: true })).map((t) => [t.slug, t]));
  let filled = 0;
  await pool(rows, Math.max(1, Math.min(2, config.concurrency)), async (row) => {
    const tenant = tenants.get(row.tenant_slug);
    if (!tenant) return;
    try {
      const detail = await fetchJobDetail(tenant, { jobId: row.job_id, url: row.url, title: row.title });
      if (!detail.detailOk) return;
      await repo.upsertJob(store, tenant.slug, { ...detail, jobId: row.job_id, detailOk: true });
      filled++;
    } catch { /* counted as not filled */ }
  }, (done, total) => { if (done % 100 === 0) log.info(`  details ${done}/${total}`); });

  await repo.finishRun(store, runId, { detailsOk: filled });
  log.info(`details filled: ${filled}/${rows.length}`);
  if (!given) await store.close();
  return { runId, filled };
}

/** What the weekly schedule runs: refresh tenants, then crawl with details. */
export async function runWeekly({ crawls = config.crawls } = {}) {
  const store = await createStore();
  try {
    log.info('weekly: discover');
    await runDiscover({ crawls, store });
    log.info('weekly: crawl + details');
    return await runCrawl({ withDetails: true, store });
  } finally {
    await store.close();
  }
}
