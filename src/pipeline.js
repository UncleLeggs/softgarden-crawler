import { config } from './config.js';
import { log } from './logger.js';
import { pool } from './http.js';
import { discoverSlugs } from './commoncrawl.js';
import { detectTenant, PLATFORM } from './tenants.js';
import { fetchAllWidgetJobs } from './sources/widget.js';
import { fetchBoardListings } from './sources/board.js';
import { fetchJobDetail, absoluteJobUrl } from './sources/detail.js';
import { fetchFeedMeta } from './sources/feed.js';
import { normalizeRegion, nullIfBlank, numOrNull, toIso, decodeEntities } from './normalize.js';
import * as db from './db.js';

/** Widget listing record -> unified shape (no description; that needs detail). */
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
    lat: numOrNull(j.coords?.lat), lng: numOrNull(j.coords?.lng),
    categories: Array.isArray(j.categories) && j.categories.length ? j.categories : null,
    datePosted: toIso(j.date),
    detailOk: false,
  };
}

export async function runDiscover({ crawls = config.crawls, database } = {}) {
  const d = database ?? db.openDb();
  const runId = db.startRun(d, 'discover');
  const errors = [];
  let seen;
  try {
    seen = await discoverSlugs({ crawls });
  } catch (err) {
    errors.push(String(err.message));
    db.finishRun(d, runId, {}, errors);
    throw err;
  }

  const entries = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  log.info(`discovered ${entries.length} slugs; detecting front ends (concurrency ${config.concurrency})`);

  let live = 0;
  const results = await pool(entries, config.concurrency, async ([slug, domains]) => {
    const tenant = await detectTenant(slug, [...domains]);
    // Feed presence is a cheap, useful fact to record once.
    if (tenant.live && tenant.platform !== PLATFORM.BOARD) {
      const feed = await fetchFeedMeta(tenant);
      tenant.feedAvailable = feed.available;
    } else if (tenant.live) {
      tenant.feedAvailable = false;
    }
    if (tenant.live) live++;
    db.upsertTenant(d, tenant, [...domains].sort().join('|'));
    return tenant;
  }, (done, total) => { if (done % 50 === 0) log.info(`  detected ${done}/${total} (live ${live})`); });

  const byPlatform = {};
  for (const t of results) if (t?.live) byPlatform[t.platform] = (byPlatform[t.platform] ?? 0) + 1;
  db.finishRun(d, runId, { tenantsSeen: entries.length, tenantsLive: live }, errors);
  log.info(`discover done: ${live}/${entries.length} live ${JSON.stringify(byPlatform)}`);
  return { runId, total: entries.length, live, byPlatform };
}

/**
 * Crawl listings for every live tenant, then optionally fetch per-job details.
 * Missing jobs are confirmed with a URL check before being closed -- a 404/410
 * closes it, anything else leaves it open, because a throttled request must
 * never look like a removed job.
 */
export async function runCrawl({ withDetails = true, slugs = null, database, detailLimit = config.detailLimit } = {}) {
  const d = database ?? db.openDb();
  const runId = db.startRun(d, withDetails ? 'crawl+details' : 'crawl');
  const errors = [];
  const tenants = db.getTenants(d, { liveOnly: true, slugs });
  if (!tenants.length) {
    db.finishRun(d, runId, {}, ['no live tenants -- run discover first']);
    throw new Error('no live tenants in the database; run `npm run discover` first');
  }

  const stats = { tenantsSeen: tenants.length, tenantsLive: tenants.length,
    jobsSeen: 0, jobsNew: 0, jobsUpdated: 0, jobsClosed: 0, detailsOk: 0 };

  log.info(`crawling ${tenants.length} tenants (concurrency ${config.concurrency}, details ${withDetails})`);

  let processed = 0;
  await pool(tenants, config.concurrency, async (tenant) => {
    try {
      const { jobs } = tenant.platform === PLATFORM.BOARD
        ? await fetchBoardListings(tenant)
        : await fetchAllWidgetJobs(tenant).then((r) => ({ jobs: r.jobs.map((j) => listingFromWidget(tenant, j)) }));

      stats.jobsSeen += jobs.length;
      db.snapshot(d, runId, tenant.slug, jobs.length);

      const wanted = detailLimit > 0 ? jobs.slice(0, detailLimit) : jobs;
      const details = new Map();
      if (withDetails && wanted.length) {
        // Details are one request per job, so they dominate the budget.
        const got = await pool(wanted, Math.max(1, Math.min(2, config.concurrency)), async (listing) => {
          try { return [listing.jobId, await fetchJobDetail(tenant, listing)]; }
          catch (err) { return [listing.jobId, { detailOk: false, note: err.message }]; }
        });
        for (const entry of got) if (Array.isArray(entry)) details.set(entry[0], entry[1]);
      }

      for (const listing of jobs) {
        const detail = details.get(listing.jobId);
        if (detail?.detailOk) stats.detailsOk++;
        const merged = { ...listing, ...(detail?.detailOk ? detail : {}),
          jobId: listing.jobId, url: detail?.url ?? listing.url,
          detailOk: Boolean(detail?.detailOk),
          companyName: detail?.companyName ?? tenant.companyName ?? null };
        const outcome = db.upsertJob(d, tenant.slug, merged);
        if (outcome === 'new') stats.jobsNew++;
        else if (outcome === 'updated') stats.jobsUpdated++;
      }

      // Close only what we can confirm is gone.
      for (const row of db.missingJobs(d, tenant.slug, jobs.map((j) => j.jobId))) {
        if (await confirmGone(row.url)) { db.closeJob(d, tenant.slug, row.job_id); stats.jobsClosed++; }
      }
    } catch (err) {
      errors.push(`${tenant.slug}: ${err.message}`);
      log.warn(`${tenant.slug}: ${err.message}`);
    } finally {
      if (++processed % 25 === 0) log.info(`  ${processed}/${tenants.length} tenants, ${stats.jobsSeen} listings`);
    }
  });

  const drops = db.detectDrops(d, runId);
  db.finishRun(d, runId, stats, errors);
  log.info(`crawl done: ${JSON.stringify(stats)}`);
  if (drops.length) log.warn(`job-count drops: ${drops.map((x) => `${x.tenant_slug} -${x.dropPct}%`).join(', ')}`);
  return { runId, stats, drops, errors };
}

/** A missing job is only closed on a definitive 404/410. */
async function confirmGone(url) {
  if (!url) return false;
  const { request } = await import('./http.js');
  try {
    const res = await request(url, { method: 'GET', ua: config.browserUA, retries: 2,
      timeoutMs: 30_000, label: `confirm ${url}` });
    return res.status === 404 || res.status === 410;
  } catch { return false; }
}

/** Fill in details for jobs that have none yet, oldest first. */
export async function runDetails({ limit = 500, database } = {}) {
  const d = database ?? db.openDb();
  const runId = db.startRun(d, 'details');
  const rows = d.prepare(`SELECT j.tenant_slug, j.job_id, j.url, j.title FROM jobs j
    WHERE j.is_open=1 AND j.detail_ok=0 ORDER BY j.last_seen ASC LIMIT ?`).all(limit);
  if (!rows.length) { db.finishRun(d, runId, {}); log.info('no jobs missing details'); return { runId, filled: 0 }; }

  const tenants = new Map(db.getTenants(d, { liveOnly: true }).map((t) => [t.slug, t]));
  let filled = 0;
  await pool(rows, Math.max(1, Math.min(2, config.concurrency)), async (row) => {
    const tenant = tenants.get(row.tenant_slug);
    if (!tenant) return;
    try {
      const detail = await fetchJobDetail(tenant, { jobId: row.job_id, url: row.url, title: row.title });
      if (!detail.detailOk) return;
      db.upsertJob(d, tenant.slug, { ...detail, jobId: row.job_id, detailOk: true });
      filled++;
    } catch { /* counted as not filled */ }
  }, (done, total) => { if (done % 100 === 0) log.info(`  details ${done}/${total}`); });

  db.finishRun(d, runId, { detailsOk: filled });
  log.info(`details filled: ${filled}/${rows.length}`);
  return { runId, filled };
}

/** What the weekly schedule runs: refresh tenants, then crawl with details. */
export async function runWeekly({ crawls = config.crawls } = {}) {
  const d = db.openDb();
  log.info('weekly: discover');
  await runDiscover({ crawls, database: d });
  log.info('weekly: crawl + details');
  const res = await runCrawl({ withDetails: true, database: d });
  return res;
}
