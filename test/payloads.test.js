import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage/index.js';
import { upsertTenant, upsertJob, putPayload } from '../src/repository.js';

const freshStore = () => createStore({
  url: null, path: join(mkdtempSync(join(tmpdir(), 'sgraw-')), 'test.db'), migrate: true,
});
const tenant = { slug: 'acme', platform: 'career-next', host: 'h', customDomain: null,
  companyName: 'Acme', locale: 'de', userId: 'u', projectId: 'p', pageId: 'g',
  live: true, note: null, feedAvailable: true };

const detail = {
  jobId: '1', title: 'Dev', descriptionText: 'body', versionId: 10, detailOk: true,
  sourceCreatedAt: '2026-11-12T07:26:03.000Z', sourceUpdatedAt: '2026-11-12T07:26:23.000Z',
  sourceHash: 'abc123', published: true, imported: true, jobBoardType: 'extern',
  totalApplications: 4, projectNumber: 2427722, additionalLocations: ['Wien', 'Graz'],
};

test('the fields the dashboard never shows are still stored', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', detail);
  const r = await store.get('SELECT * FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(r.source_updated_at, '2026-11-12T07:26:23.000Z');
  assert.equal(r.source_hash, 'abc123');
  assert.equal(Number(r.published), 1);
  assert.equal(Number(r.total_applications), 4);
  assert.equal(Number(r.project_number), 2427722);
  assert.deepEqual(JSON.parse(r.additional_locations), ['Wien', 'Graz']);
  await store.close();
});

/**
 * The gap this guards: upsertJob returns early for an unchanged job, so a
 * column added to the schema would stay NULL on every stable listing -- which
 * for most jobs is forever. The first run after an upgrade must backfill.
 */
test('an unchanged job still gets newly added fields backfilled', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  // Stored before the fields existed.
  await upsertJob(store, 'acme', { jobId: '1', title: 'Dev', descriptionText: 'body', versionId: 10, detailOk: true });
  await store.run('UPDATE jobs SET source_updated_at = NULL, total_applications = NULL WHERE job_id = ?', ['1']);

  // Same content, so this is 'unchanged' -- and must still fill the gaps.
  assert.equal(await upsertJob(store, 'acme', detail), 'unchanged');
  const r = await store.get('SELECT source_updated_at, total_applications FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(r.source_updated_at, '2026-11-12T07:26:23.000Z');
  assert.equal(Number(r.total_applications), 4);
  await store.close();
});

test('backfill fills gaps without overwriting what is already there', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', detail);
  assert.equal(await upsertJob(store, 'acme', { ...detail, sourceHash: 'DIFFERENT' }), 'unchanged');
  const r = await store.get('SELECT source_hash FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(r.source_hash, 'abc123', 'the unchanged path must not overwrite');
  await store.close();
});

test('a payload round-trips and unmapped fields stay queryable', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', detail);
  await putPayload(store, 'acme', '1', 'career', { category: 'Verkauf', coords: { lat: '48.24' } });
  const r = await store.get(
    `SELECT json_extract(payload, '$.category') AS cat,
            json_extract(payload, '$.coords.lat') AS lat
     FROM job_payloads WHERE tenant_slug = ? AND job_id = ?`, ['acme', '1']);
  assert.equal(r.cat, 'Verkauf');
  assert.equal(r.lat, '48.24');
  await store.close();
});

test('overwrite:false keeps the stored payload, overwrite:true replaces it', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', detail);
  await putPayload(store, 'acme', '1', 'career', { v: 'first' });
  await putPayload(store, 'acme', '1', 'career', { v: 'second' }, { overwrite: false });
  let r = await store.get("SELECT json_extract(payload,'$.v') AS v FROM job_payloads WHERE job_id = ?", ['1']);
  assert.equal(r.v, 'first', 'an unchanged job must not rewrite its blob');

  await putPayload(store, 'acme', '1', 'career', { v: 'third' }, { overwrite: true });
  r = await store.get("SELECT json_extract(payload,'$.v') AS v FROM job_payloads WHERE job_id = ?", ['1']);
  assert.equal(r.v, 'third');
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM job_payloads')).n), 1, 'one row per source');
  await store.close();
});
