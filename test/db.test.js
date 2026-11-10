import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertTenant, upsertJob, missingJobs, closeJob, snapshot, detectDrops, startRun } from '../src/db.js';

const freshDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'sgdb-')), 'test.db'));

const tenant = { slug: 'acme', platform: 'career-next', host: 'acme.career.softgarden.de',
  customDomain: null, companyName: 'Acme GmbH', locale: 'de', userId: 'u', projectId: 'p',
  pageId: 'g', live: true, note: null, feedAvailable: true };

test('a listing with no detail fields stores as NULL, not a bind error', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  // Exactly what the widget returns before a detail fetch: no description keys.
  const listing = { jobId: '123', url: 'https://x/y', title: 'Dev', city: 'Berlin', detailOk: false };
  assert.doesNotThrow(() => upsertJob(db, 'acme', listing));
  const row = db.prepare('SELECT * FROM jobs WHERE job_id=?').get('123');
  assert.equal(row.description_html, null);
  assert.equal(row.valid_through, null);
  assert.equal(row.detail_ok, 0);
  assert.equal(row.is_open, 1);
});

test('re-seeing an unchanged job does not count as new or updated', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  const job = { jobId: '1', title: 'A', descriptionText: 'body', versionId: 10, detailOk: true };
  assert.equal(upsertJob(db, 'acme', job), 'new');
  assert.equal(upsertJob(db, 'acme', job), 'unchanged');
});

test('a changed versionId marks the job updated', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  upsertJob(db, 'acme', { jobId: '1', title: 'A', versionId: 10, detailOk: true });
  assert.equal(upsertJob(db, 'acme', { jobId: '1', title: 'A2', versionId: 11, detailOk: true }), 'updated');
  assert.equal(db.prepare('SELECT title FROM jobs WHERE job_id=?').get('1').title, 'A2');
});

test('without versionId, a content change is still detected', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  upsertJob(db, 'acme', { jobId: '1', title: 'A', descriptionText: 'one', detailOk: true });
  assert.equal(upsertJob(db, 'acme', { jobId: '1', title: 'A', descriptionText: 'one', detailOk: true }), 'unchanged');
  assert.equal(upsertJob(db, 'acme', { jobId: '1', title: 'A', descriptionText: 'two', detailOk: true }), 'updated');
});

test('a detail fetch never erases a description it could not read', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  upsertJob(db, 'acme', { jobId: '1', title: 'A', descriptionText: 'kept', versionId: 1, detailOk: true });
  // A later listing-only pass bumps the version but carries no description.
  upsertJob(db, 'acme', { jobId: '1', title: 'A', versionId: 2, detailOk: false });
  assert.equal(db.prepare('SELECT description_text FROM jobs WHERE job_id=?').get('1').description_text, 'kept');
});

test('missingJobs reports only jobs absent from this run', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  for (const id of ['1', '2', '3']) upsertJob(db, 'acme', { jobId: id, title: id, detailOk: false });
  const missing = missingJobs(db, 'acme', ['1', '3']);
  assert.deepEqual(missing.map((m) => m.job_id), ['2']);
  closeJob(db, 'acme', '2');
  assert.equal(missingJobs(db, 'acme', ['1', '3']).length, 0, 'closed jobs drop out');
});

test('a sharp job-count drop raises an alert; a mild one does not', () => {
  const db = freshDb();
  upsertTenant(db, tenant, 'career.softgarden.de');
  const r1 = startRun(db, 'crawl');
  snapshot(db, r1, 'acme', 100);
  const r2 = startRun(db, 'crawl');
  snapshot(db, r2, 'acme', 20); // -80%
  const drops = detectDrops(db, r2, 0.3);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].dropPct, 80);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);

  const r3 = startRun(db, 'crawl');
  snapshot(db, r3, 'acme', 19); // -5% from 20
  assert.equal(detectDrops(db, r3, 0.3).length, 0);
});
