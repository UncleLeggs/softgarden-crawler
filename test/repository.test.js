import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage/index.js';
import { upsertTenant, upsertJob, missingJobs, closeJob, snapshot, detectDrops,
  startRun, finishRun, getTenants, jobsNeedingDetail, stats } from '../src/repository.js';

const freshStore = () => createStore({
  url: null, path: join(mkdtempSync(join(tmpdir(), 'sgdb-')), 'test.db'), migrate: true,
});

const tenant = { slug: 'acme', platform: 'career-next', host: 'acme.career.softgarden.de',
  customDomain: null, companyName: 'Acme GmbH', locale: 'de', userId: 'u', projectId: 'p',
  pageId: 'g', live: true, note: null, feedAvailable: true };

test('a listing with no detail fields stores as NULL, not a bind error', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  // Exactly what the widget returns before a detail fetch: no description keys.
  const listing = { jobId: '123', url: 'https://x/y', title: 'Dev', city: 'Berlin', detailOk: false };
  await assert.doesNotReject(() => upsertJob(store, 'acme', listing));
  const row = await store.get('SELECT * FROM jobs WHERE job_id = ?', ['123']);
  assert.equal(row.description_html, null);
  assert.equal(row.valid_through, null);
  assert.equal(Number(row.detail_ok), 0);
  assert.equal(Number(row.is_open), 1);
  await store.close();
});

test('re-seeing an unchanged job counts as neither new nor updated', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  const job = { jobId: '1', title: 'A', descriptionText: 'body', versionId: 10, detailOk: true };
  assert.equal(await upsertJob(store, 'acme', job), 'new');
  assert.equal(await upsertJob(store, 'acme', job), 'unchanged');
  await store.close();
});

test('a changed versionId marks the job updated', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', versionId: 10, detailOk: true });
  assert.equal(await upsertJob(store, 'acme', { jobId: '1', title: 'A2', versionId: 11, detailOk: true }), 'updated');
  const row = await store.get('SELECT title FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(row.title, 'A2');
  await store.close();
});

test('without versionId, a content change is still detected', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', descriptionText: 'one', detailOk: true });
  assert.equal(await upsertJob(store, 'acme', { jobId: '1', title: 'A', descriptionText: 'one', detailOk: true }), 'unchanged');
  assert.equal(await upsertJob(store, 'acme', { jobId: '1', title: 'A', descriptionText: 'two', detailOk: true }), 'updated');
  await store.close();
});

test('a listing-only pass never erases a description already stored', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', descriptionText: 'kept', versionId: 1, detailOk: true });
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', versionId: 2, detailOk: false });
  const row = await store.get('SELECT description_text, detail_ok FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(row.description_text, 'kept');
  assert.equal(Number(row.detail_ok), 1, 'detail_ok must not regress to 0');
  await store.close();
});

test('missingJobs reports only jobs absent from this run', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  for (const id of ['1', '2', '3']) await upsertJob(store, 'acme', { jobId: id, title: id, detailOk: false });
  const missing = await missingJobs(store, 'acme', ['1', '3']);
  assert.deepEqual(missing.map((m) => m.job_id), ['2']);
  await closeJob(store, 'acme', '2');
  assert.equal((await missingJobs(store, 'acme', ['1', '3'])).length, 0, 'closed jobs drop out');
  await store.close();
});

test('reopening a closed job clears closed_at', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', versionId: 1, detailOk: true });
  await closeJob(store, 'acme', '1');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', versionId: 1, detailOk: true });
  const row = await store.get('SELECT is_open, closed_at FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(Number(row.is_open), 1);
  assert.equal(row.closed_at, null);
  await store.close();
});

test('jobsNeedingDetail returns only open jobs lacking detail', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'has detail', descriptionText: 'x', detailOk: true });
  await upsertJob(store, 'acme', { jobId: '2', title: 'no detail', detailOk: false });
  const rows = await jobsNeedingDetail(store, 10);
  assert.deepEqual(rows.map((r) => r.job_id), ['2']);
  await store.close();
});

test('a sharp job-count drop raises an alert; a mild one does not', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  const r1 = await startRun(store, 'crawl');
  await snapshot(store, r1, 'acme', 100);
  const r2 = await startRun(store, 'crawl');
  await snapshot(store, r2, 'acme', 20); // -80%
  const drops = await detectDrops(store, r2, 0.3);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].dropPct, 80);
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM alerts')).n), 1);

  const r3 = await startRun(store, 'crawl');
  await snapshot(store, r3, 'acme', 19); // -5% from 20
  assert.equal((await detectDrops(store, r3, 0.3)).length, 0);
  await store.close();
});

test('the first run has no baseline, so it cannot raise a drop alert', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  const r1 = await startRun(store, 'crawl');
  await snapshot(store, r1, 'acme', 5);
  assert.equal((await detectDrops(store, r1, 0.3)).length, 0);
  await store.close();
});

test('run bookkeeping records errors and flips ok to 0', async () => {
  const store = await freshStore();
  const runId = await startRun(store, 'crawl');
  await finishRun(store, runId, { jobsSeen: 10, jobsNew: 3 }, ['acme: HTTP 429']);
  const row = await store.get('SELECT ok, jobs_seen, jobs_new, errors FROM runs WHERE id = ?', [runId]);
  assert.equal(Number(row.ok), 0);
  assert.equal(Number(row.jobs_seen), 10);
  assert.match(row.errors, /429/);
  await store.close();
});

test('tenant upsert preserves a known company name against a later blank', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertTenant(store, { ...tenant, companyName: null }, 'career.softgarden.de');
  const rows = await getTenants(store, { liveOnly: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].companyName, 'Acme GmbH');
  await store.close();
});

test('stats shapes the numbers the dashboard reads', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', descriptionText: 'x', country: 'DE', detailOk: true });
  await upsertJob(store, 'acme', { jobId: '2', title: 'B', country: 'AT', detailOk: false });
  const s = await stats(store);
  assert.equal(s.tenantsLive, 1);
  assert.equal(s.jobsOpen, 2);
  assert.equal(s.withDescription, 1);
  assert.deepEqual(s.byPlatform.map((p) => p.platform), ['career-next']);
  assert.equal(s.countries.length, 2);
  await store.close();
});

/**
 * `stats()` is the one object two different front ends destructure: the CLI
 * printer and the dashboard's /api/summary. A renamed key there is invisible to
 * the unit tests above but crashes both at runtime, so pin the shape itself.
 */
test('stats returns every key its consumers read, including recentAlerts', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  const s = await stats(store);
  for (const key of ['tenants', 'tenantsLive', 'brandedDomains', 'byPlatform', 'jobsOpen',
    'jobsClosed', 'withDescription', 'remote', 'countries', 'topTenants', 'lastRuns',
    'recentAlerts']) {
    assert.ok(key in s, `stats() must expose "${key}"`);
  }
  for (const key of ['byPlatform', 'countries', 'topTenants', 'lastRuns', 'recentAlerts']) {
    assert.ok(Array.isArray(s[key]), `stats().${key} must be an array, not ${typeof s[key]}`);
  }
  await store.close();
});

test('an alert raised by detectDrops shows up in stats().recentAlerts', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  const r1 = await startRun(store, 'crawl');
  await snapshot(store, r1, 'acme', 100);
  const r2 = await startRun(store, 'crawl');
  await snapshot(store, r2, 'acme', 10);
  await detectDrops(store, r2, 0.3);
  const s = await stats(store);
  assert.equal(s.recentAlerts.length, 1);
  assert.equal(s.recentAlerts[0].kind, 'job_count_drop');
  await store.close();
});
