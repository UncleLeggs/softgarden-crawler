import { createHash } from 'node:crypto';
import { config } from './config.js';

/**
 * All SQL lives here, written to run on both backends:
 *   - `?` placeholders (the Postgres adapter rewrites them to $1..$n)
 *   - ON CONFLICT ... DO UPDATE SET x = excluded.x  (supported by both)
 *   - INSERT ... RETURNING id                        (supported by both)
 *   - no SQLite-only scalars: no MAX(a,b), no datetime('now'); timestamps are
 *     ISO strings produced in JS so both backends store and sort them alike
 */

const now = () => new Date().toISOString();

export function contentHash(job) {
  return createHash('sha256').update(JSON.stringify([
    job.title ?? null, job.descriptionText ?? null, job.city ?? null, job.region ?? null,
    job.country ?? null, job.employmentType ?? null, job.salary ?? null, job.validThrough ?? null,
  ])).digest('hex').slice(0, 32);
}

export async function startRun(store, mode) {
  return store.insertReturningId(
    'INSERT INTO runs (mode, started_at) VALUES (?, ?) RETURNING id', [mode, now()]);
}

export async function finishRun(store, runId, stats = {}, errors = []) {
  await store.run(
    `UPDATE runs SET finished_at = ?, ok = ?, tenants_seen = ?, tenants_live = ?, jobs_seen = ?,
       jobs_new = ?, jobs_updated = ?, jobs_closed = ?, details_ok = ?, errors = ?
     WHERE id = ?`,
    [now(), errors.length ? 0 : 1, stats.tenantsSeen ?? 0, stats.tenantsLive ?? 0,
      stats.jobsSeen ?? 0, stats.jobsNew ?? 0, stats.jobsUpdated ?? 0, stats.jobsClosed ?? 0,
      stats.detailsOk ?? 0, errors.length ? JSON.stringify(errors.slice(0, 50)) : null, runId]);
}

export async function upsertTenant(store, t, seenOn) {
  const ts = now();
  await store.run(
    `INSERT INTO tenants (slug, platform, host, custom_domain, company_name, locale,
       user_id, project_id, page_id, seen_on, feed_available, live, note, first_seen, last_checked)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (slug) DO UPDATE SET
       platform = excluded.platform, host = excluded.host,
       custom_domain = excluded.custom_domain,
       company_name = COALESCE(excluded.company_name, tenants.company_name),
       locale = excluded.locale, user_id = excluded.user_id,
       project_id = excluded.project_id, page_id = excluded.page_id,
       seen_on = excluded.seen_on,
       feed_available = COALESCE(excluded.feed_available, tenants.feed_available),
       live = excluded.live, note = excluded.note, last_checked = excluded.last_checked`,
    [t.slug, t.platform, t.host, t.customDomain, t.companyName, t.locale,
      t.userId, t.projectId, t.pageId, seenOn ?? null,
      t.feedAvailable == null ? null : (t.feedAvailable ? 1 : 0),
      t.live ? 1 : 0, t.note, ts, ts]);
}

const rowToTenant = (r) => ({
  slug: r.slug, platform: r.platform, host: r.host, customDomain: r.custom_domain,
  companyName: r.company_name, locale: r.locale, userId: r.user_id, projectId: r.project_id,
  pageId: r.page_id, seenOn: r.seen_on, live: Number(r.live) === 1,
  detailHost: r.detail_host ?? null,
});

export async function getTenants(store, { liveOnly = true, platform = null, slugs = null } = {}) {
  const where = [];
  const params = [];
  if (liveOnly) where.push('live = 1');
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (slugs?.length) { where.push(`slug IN (${slugs.map(() => '?').join(',')})`); params.push(...slugs); }
  const rows = await store.all(
    `SELECT * FROM tenants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY slug`, params);
  return rows.map(rowToTenant);
}

/** Returns 'new' | 'updated' | 'unchanged'. */
export async function upsertJob(store, tenantSlug, job) {
  const ts = now();
  const jobId = String(job.jobId);
  const hash = job.contentHash ?? contentHash(job);
  const prev = await store.get(
    'SELECT version_id, content_hash, is_open FROM jobs WHERE tenant_slug = ? AND job_id = ?',
    [tenantSlug, jobId]);

  if (!prev) {
    await store.run(
      `INSERT INTO jobs (tenant_slug, job_id, url, title, description_html, description_text,
         date_posted, valid_through, employment_type, career_level, work_experience, work_time,
         remote_status, remote_key, salary, city, region, country, postal_code, street_address,
         lat, lng, categories, company_name, apply_url, version_id, content_hash, is_open,
         detail_ok, detail_note, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      [tenantSlug, jobId, job.url, job.title, job.descriptionHtml, job.descriptionText,
        job.datePosted, job.validThrough, job.employmentType, job.careerLevel, job.workExperience,
        job.workTime, job.remoteStatus, job.remoteStatusKey, job.salary, job.city, job.region,
        job.country, job.postalCode, job.streetAddress, job.lat, job.lng,
        job.categories ? JSON.stringify(job.categories) : null, job.companyName, job.applyUrl,
        job.versionId, hash, job.detailOk ? 1 : 0, job.detailNote ?? null, ts, ts]);
    return 'new';
  }

  // versionId is exact where both sides have one; otherwise compare a hash.
  const changed = job.versionId != null && prev.version_id != null
    ? Number(job.versionId) !== Number(prev.version_id)
    : hash !== prev.content_hash;

  if (!changed && Number(prev.is_open) === 1) {
    await store.run('UPDATE jobs SET last_seen = ? WHERE tenant_slug = ? AND job_id = ?',
      [ts, tenantSlug, jobId]);
    return 'unchanged';
  }

  // COALESCE keeps a description a listing-only pass could not supply, and the
  // CASE is the portable form of SQLite's MAX(detail_ok, ?).
  await store.run(
    `UPDATE jobs SET url = ?, title = ?,
       description_html = COALESCE(?, description_html),
       description_text = COALESCE(?, description_text),
       date_posted = COALESCE(?, date_posted), valid_through = ?, employment_type = ?,
       career_level = ?, work_experience = ?, work_time = ?, remote_status = ?, remote_key = ?,
       salary = ?, city = ?, region = ?, country = ?, postal_code = ?, street_address = ?,
       lat = ?, lng = ?, categories = ?, company_name = ?, apply_url = ?, version_id = ?,
       content_hash = ?, is_open = 1, closed_at = NULL,
       detail_ok = CASE WHEN ? = 1 THEN 1 ELSE detail_ok END,
       detail_note = CASE WHEN ? = 1 THEN NULL ELSE ? END,
       last_seen = ?
     WHERE tenant_slug = ? AND job_id = ?`,
    [job.url, job.title, job.descriptionHtml, job.descriptionText, job.datePosted,
      job.validThrough, job.employmentType, job.careerLevel, job.workExperience, job.workTime,
      job.remoteStatus, job.remoteStatusKey, job.salary, job.city, job.region, job.country,
      job.postalCode, job.streetAddress, job.lat, job.lng,
      job.categories ? JSON.stringify(job.categories) : null, job.companyName, job.applyUrl,
      job.versionId, hash, job.detailOk ? 1 : 0,
      job.detailOk ? 1 : 0, job.detailNote ?? null, ts, tenantSlug, jobId]);
  return 'updated';
}

/**
 * Remember the board host that serves a tenant's job pages, so later runs skip
 * rediscovering it.
 */
export async function setDetailHost(store, slug, host) {
  await store.run('UPDATE tenants SET detail_host = ? WHERE slug = ?', [host, slug]);
}

/** Open jobs we did not see this run. Candidates for closing, not closed yet. */
export async function missingJobs(store, tenantSlug, seenIds) {
  const ids = seenIds.map(String);
  return store.all(
    `SELECT job_id, url FROM jobs WHERE tenant_slug = ? AND is_open = 1
     ${ids.length ? `AND job_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
    [tenantSlug, ...ids]);
}

export async function closeJob(store, tenantSlug, jobId) {
  await store.run('UPDATE jobs SET is_open = 0, closed_at = ? WHERE tenant_slug = ? AND job_id = ?',
    [now(), tenantSlug, String(jobId)]);
}

export async function jobsNeedingDetail(store, limit) {
  return store.all(
    `SELECT tenant_slug, job_id, url, title FROM jobs
     WHERE is_open = 1 AND detail_ok = 0 ORDER BY last_seen ASC LIMIT ?`, [limit]);
}

export async function snapshot(store, runId, tenantSlug, jobCount) {
  await store.run(
    `INSERT INTO tenant_snapshots (run_id, tenant_slug, job_count, captured_at)
     VALUES (?,?,?,?)
     ON CONFLICT (run_id, tenant_slug) DO UPDATE SET job_count = excluded.job_count`,
    [runId, tenantSlug, jobCount, now()]);
}

export async function addAlert(store, runId, tenantSlug, kind, detail) {
  await store.run(
    'INSERT INTO alerts (run_id, tenant_slug, kind, detail, created_at) VALUES (?,?,?,?,?)',
    [runId, tenantSlug, kind, detail, now()]);
}

/**
 * Compare this run's per-tenant counts with the previous run's and flag sharp
 * drops -- usually a crawl problem (throttling, markup change) rather than a
 * customer that really closed most of its jobs.
 */
export async function detectDrops(store, runId, threshold = config.dropThreshold) {
  const prev = await store.get(
    `SELECT run_id FROM tenant_snapshots WHERE run_id < ?
     GROUP BY run_id ORDER BY run_id DESC LIMIT 1`, [runId]);
  if (!prev) return [];

  const rows = await store.all(
    `SELECT c.tenant_slug, p.job_count AS before_count, c.job_count AS after_count
     FROM tenant_snapshots c
     JOIN tenant_snapshots p ON p.tenant_slug = c.tenant_slug AND p.run_id = ?
     WHERE c.run_id = ? AND p.job_count > 0`, [prev.run_id, runId]);

  const drops = [];
  for (const r of rows) {
    const before = Number(r.before_count);
    const after = Number(r.after_count);
    const delta = (before - after) / before;
    if (delta > threshold) {
      const dropPct = Math.round(delta * 100);
      drops.push({ tenantSlug: r.tenant_slug, before, after, dropPct });
      await addAlert(store, runId, r.tenant_slug, 'job_count_drop', `${before} -> ${after} (-${dropPct}%)`);
    }
  }
  return drops;
}

export async function stats(store) {
  const n = async (sql, params = []) => Number((await store.get(sql, params))?.n ?? 0);
  return {
    tenants: await n('SELECT COUNT(*) AS n FROM tenants'),
    tenantsLive: await n('SELECT COUNT(*) AS n FROM tenants WHERE live = 1'),
    brandedDomains: await n("SELECT COUNT(*) AS n FROM tenants WHERE live = 1 AND custom_domain IS NOT NULL AND custom_domain <> ''"),
    byPlatform: await store.all(
      'SELECT platform, COUNT(*) AS n FROM tenants WHERE live = 1 GROUP BY platform ORDER BY n DESC'),
    jobsOpen: await n('SELECT COUNT(*) AS n FROM jobs WHERE is_open = 1'),
    jobsClosed: await n('SELECT COUNT(*) AS n FROM jobs WHERE is_open = 0'),
    withDescription: await n(
      "SELECT COUNT(*) AS n FROM jobs WHERE is_open = 1 AND description_text IS NOT NULL AND description_text <> ''"),
    remote: await n("SELECT COUNT(*) AS n FROM jobs WHERE is_open = 1 AND remote_key IS NOT NULL AND remote_key <> ''"),
    countries: await store.all(
      `SELECT country, COUNT(*) AS n FROM jobs WHERE is_open = 1 AND country IS NOT NULL
       GROUP BY country ORDER BY n DESC LIMIT 10`),
    topTenants: await store.all(
      `SELECT j.tenant_slug, t.company_name, t.platform, COUNT(*) AS n FROM jobs j
       LEFT JOIN tenants t ON t.slug = j.tenant_slug WHERE j.is_open = 1
       GROUP BY j.tenant_slug, t.company_name, t.platform ORDER BY n DESC LIMIT 15`),
    lastRuns: await store.all(
      `SELECT id, mode, started_at, finished_at, ok, tenants_live, jobs_seen, jobs_new,
         jobs_updated, jobs_closed, details_ok FROM runs ORDER BY id DESC LIMIT 10`),
    recentAlerts: await store.all(
      'SELECT tenant_slug, kind, detail, created_at FROM alerts ORDER BY id DESC LIMIT 20'),
    // Why details are missing. Without this the failures are a single number
    // and the reason has to be re-derived from the live sites.
    detailFailures: await store.all(
      `SELECT COALESCE(detail_note, '(no reason recorded)') AS reason, COUNT(*) AS n
       FROM jobs WHERE is_open = 1 AND detail_ok = 0
       GROUP BY reason ORDER BY n DESC LIMIT 8`),
  };
}
