import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();

export function openDb(path = config.dbPath) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  return db;
}

/**
 * node:sqlite rejects `undefined` where SQL wants NULL, and listing records
 * legitimately lack detail fields until a detail fetch fills them in. Bind
 * through this so a missing key becomes NULL instead of throwing.
 */
const P = (...vals) => vals.map((v) => (v === undefined ? null : v));

export function contentHash(job) {
  return createHash('sha256').update(JSON.stringify([
    job.title, job.descriptionText, job.city, job.region, job.country,
    job.employmentType, job.salary, job.validThrough,
  ])).digest('hex').slice(0, 32);
}

export function startRun(db, mode) {
  db.prepare('INSERT INTO runs (mode, started_at) VALUES (?, ?)').run(mode, now());
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export function finishRun(db, runId, stats, errors = []) {
  db.prepare(`UPDATE runs SET finished_at=?, ok=?, tenants_seen=?, tenants_live=?, jobs_seen=?,
    jobs_new=?, jobs_updated=?, jobs_closed=?, details_ok=?, errors=? WHERE id=?`)
    .run(now(), errors.length ? 0 : 1, stats.tenantsSeen ?? 0, stats.tenantsLive ?? 0,
      stats.jobsSeen ?? 0, stats.jobsNew ?? 0, stats.jobsUpdated ?? 0, stats.jobsClosed ?? 0,
      stats.detailsOk ?? 0, errors.length ? JSON.stringify(errors.slice(0, 50)) : null, runId);
}

export function upsertTenant(db, t, seenOn) {
  const ts = now();
  db.prepare(`INSERT INTO tenants (slug, platform, host, custom_domain, company_name, locale,
      user_id, project_id, page_id, seen_on, feed_available, live, note, first_seen, last_checked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET
      platform=excluded.platform, host=excluded.host, custom_domain=excluded.custom_domain,
      company_name=COALESCE(excluded.company_name, tenants.company_name),
      locale=excluded.locale, user_id=excluded.user_id, project_id=excluded.project_id,
      page_id=excluded.page_id, seen_on=excluded.seen_on,
      feed_available=COALESCE(excluded.feed_available, tenants.feed_available),
      live=excluded.live, note=excluded.note, last_checked=excluded.last_checked`)
    .run(...P(t.slug, t.platform, t.host, t.customDomain, t.companyName, t.locale,
      t.userId, t.projectId, t.pageId, seenOn ?? null,
      t.feedAvailable == null ? null : (t.feedAvailable ? 1 : 0),
      t.live ? 1 : 0, t.note, ts, ts));
}

export function getTenants(db, { liveOnly = true, platform = null, slugs = null } = {}) {
  const where = [];
  const params = [];
  if (liveOnly) where.push('live = 1');
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (slugs?.length) { where.push(`slug IN (${slugs.map(() => '?').join(',')})`); params.push(...slugs); }
  const sql = `SELECT * FROM tenants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY slug`;
  return db.prepare(sql).all(...params).map(rowToTenant);
}

const rowToTenant = (r) => ({
  slug: r.slug, platform: r.platform, host: r.host, customDomain: r.custom_domain,
  companyName: r.company_name, locale: r.locale, userId: r.user_id, projectId: r.project_id,
  pageId: r.page_id, seenOn: r.seen_on, live: !!r.live,
});

/** Returns 'new' | 'updated' | 'unchanged'. */
export function upsertJob(db, tenantSlug, job) {
  const ts = now();
  const hash = job.contentHash ?? contentHash(job);
  const prev = db.prepare('SELECT version_id, content_hash, is_open FROM jobs WHERE tenant_slug=? AND job_id=?')
    .get(tenantSlug, String(job.jobId));

  if (!prev) {
    db.prepare(`INSERT INTO jobs (tenant_slug, job_id, url, title, description_html, description_text,
        date_posted, valid_through, employment_type, career_level, work_experience, work_time,
        remote_status, remote_key, salary, city, region, country, postal_code, street_address,
        lat, lng, categories, company_name, apply_url, version_id, content_hash, is_open,
        detail_ok, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
      .run(...P(tenantSlug, String(job.jobId), job.url, job.title, job.descriptionHtml, job.descriptionText,
        job.datePosted, job.validThrough, job.employmentType, job.careerLevel, job.workExperience,
        job.workTime, job.remoteStatus, job.remoteStatusKey, job.salary, job.city, job.region,
        job.country, job.postalCode, job.streetAddress, job.lat, job.lng,
        job.categories ? JSON.stringify(job.categories) : null, job.companyName, job.applyUrl,
        job.versionId, hash, job.detailOk ? 1 : 0, ts, ts));
    return 'new';
  }

  // versionId is exact where available; fall back to a content hash.
  const changed = job.versionId != null && prev.version_id != null
    ? job.versionId !== prev.version_id
    : hash !== prev.content_hash;

  if (!changed && prev.is_open) {
    db.prepare('UPDATE jobs SET last_seen=? WHERE tenant_slug=? AND job_id=?').run(ts, tenantSlug, String(job.jobId));
    return 'unchanged';
  }

  db.prepare(`UPDATE jobs SET url=?, title=?,
      description_html=COALESCE(?, description_html), description_text=COALESCE(?, description_text),
      date_posted=COALESCE(?, date_posted), valid_through=?, employment_type=?, career_level=?,
      work_experience=?, work_time=?, remote_status=?, remote_key=?, salary=?, city=?, region=?,
      country=?, postal_code=?, street_address=?, lat=?, lng=?, categories=?, company_name=?,
      apply_url=?, version_id=?, content_hash=?, is_open=1, closed_at=NULL,
      detail_ok=MAX(detail_ok, ?), last_seen=? WHERE tenant_slug=? AND job_id=?`)
    .run(...P(job.url, job.title, job.descriptionHtml, job.descriptionText, job.datePosted,
      job.validThrough, job.employmentType, job.careerLevel, job.workExperience, job.workTime,
      job.remoteStatus, job.remoteStatusKey, job.salary, job.city, job.region, job.country,
      job.postalCode, job.streetAddress, job.lat, job.lng,
      job.categories ? JSON.stringify(job.categories) : null, job.companyName, job.applyUrl,
      job.versionId, hash, job.detailOk ? 1 : 0, ts, tenantSlug, String(job.jobId)));
  return 'updated';
}

/** Jobs we did not see this run. Candidates for closing, not closed yet. */
export function missingJobs(db, tenantSlug, seenIds) {
  const ids = seenIds.map(String);
  const sql = `SELECT job_id, url FROM jobs WHERE tenant_slug=? AND is_open=1
    ${ids.length ? `AND job_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`;
  return db.prepare(sql).all(tenantSlug, ...ids);
}

export function closeJob(db, tenantSlug, jobId) {
  const ts = now();
  db.prepare('UPDATE jobs SET is_open=0, closed_at=? WHERE tenant_slug=? AND job_id=?')
    .run(ts, tenantSlug, String(jobId));
}

export function snapshot(db, runId, tenantSlug, jobCount) {
  db.prepare(`INSERT INTO tenant_snapshots (run_id, tenant_slug, job_count, captured_at)
    VALUES (?,?,?,?) ON CONFLICT(run_id, tenant_slug) DO UPDATE SET job_count=excluded.job_count`)
    .run(runId, tenantSlug, jobCount, now());
}

export function addAlert(db, runId, tenantSlug, kind, detail) {
  db.prepare('INSERT INTO alerts (run_id, tenant_slug, kind, detail, created_at) VALUES (?,?,?,?,?)')
    .run(runId, tenantSlug, kind, detail, now());
}

/**
 * Compare this run's per-tenant counts with the previous run's and flag sharp
 * drops -- usually a crawl problem (throttling, markup change) rather than a
 * customer that really closed 80% of its jobs.
 */
export function detectDrops(db, runId, threshold = config.dropThreshold) {
  const prevRun = db.prepare(`SELECT run_id FROM tenant_snapshots WHERE run_id < ?
    GROUP BY run_id ORDER BY run_id DESC LIMIT 1`).get(runId);
  if (!prevRun) return [];
  const rows = db.prepare(`SELECT c.tenant_slug, p.job_count AS before, c.job_count AS after
    FROM tenant_snapshots c JOIN tenant_snapshots p
      ON p.tenant_slug = c.tenant_slug AND p.run_id = ?
    WHERE c.run_id = ? AND p.job_count > 0`).all(prevRun.run_id, runId);

  const drops = [];
  for (const r of rows) {
    const delta = (r.before - r.after) / r.before;
    if (delta > threshold) {
      drops.push({ ...r, dropPct: Math.round(delta * 100) });
      addAlert(db, runId, r.tenant_slug, 'job_count_drop',
        `${r.before} -> ${r.after} (-${Math.round(delta * 100)}%)`);
    }
  }
  return drops;
}

export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    tenants: one('SELECT COUNT(*) n FROM tenants').n,
    tenantsLive: one('SELECT COUNT(*) n FROM tenants WHERE live=1').n,
    byPlatform: db.prepare('SELECT platform, COUNT(*) n FROM tenants WHERE live=1 GROUP BY platform').all(),
    jobsOpen: one('SELECT COUNT(*) n FROM jobs WHERE is_open=1').n,
    jobsClosed: one('SELECT COUNT(*) n FROM jobs WHERE is_open=0').n,
    withDescription: one("SELECT COUNT(*) n FROM jobs WHERE is_open=1 AND description_text IS NOT NULL AND description_text<>''").n,
    countries: db.prepare('SELECT country, COUNT(*) n FROM jobs WHERE is_open=1 AND country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 10').all(),
    topTenants: db.prepare(`SELECT j.tenant_slug, t.company_name, COUNT(*) n FROM jobs j
      LEFT JOIN tenants t ON t.slug=j.tenant_slug WHERE j.is_open=1
      GROUP BY j.tenant_slug ORDER BY n DESC LIMIT 15`).all(),
    lastRuns: db.prepare('SELECT id, mode, started_at, finished_at, ok, jobs_seen, jobs_new, jobs_closed, details_ok FROM runs ORDER BY id DESC LIMIT 5').all(),
    openAlerts: db.prepare('SELECT tenant_slug, kind, detail, created_at FROM alerts ORDER BY id DESC LIMIT 20').all(),
  };
}
