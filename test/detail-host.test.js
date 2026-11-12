import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detailHostCandidates, absoluteJobUrl } from '../src/sources/detail.js';
import { createStore } from '../src/storage/index.js';
import { upsertTenant, upsertJob, setDetailHost, getTenants } from '../src/repository.js';

const freshStore = () => createStore({
  url: null, path: join(mkdtempSync(join(tmpdir(), 'sgdh-')), 'test.db'), migrate: true,
});
const tenant = { slug: 'acme', platform: 'career-next', host: 'acme.career.softgarden.de',
  customDomain: null, companyName: 'Acme', locale: 'de', userId: 'u', projectId: 'p',
  pageId: 'g', live: true, note: null, feedAvailable: true };

/**
 * A landing-role career page lists jobs it cannot serve: every /jobs/<id>/ URL
 * 404s because the landing app has no job route. The postings live on the
 * company board under a shorter slug, so candidates drop leading segments.
 */
test('candidates start with the tenant itself, then drop leading slug segments', () => {
  assert.deepEqual(detailHostCandidates('ueber-uns-schuelerhilfe'), [
    'ueber-uns-schuelerhilfe.softgarden.io',
    'uns-schuelerhilfe.softgarden.io',
    'schuelerhilfe.softgarden.io',
  ]);
  assert.deepEqual(detailHostCandidates('jdsports'), ['jdsports.softgarden.io']);
  assert.deepEqual(detailHostCandidates(''), []);
  assert.deepEqual(detailHostCandidates(null), []);
});

test('candidates are de-duplicated and never empty-segmented', () => {
  const c = detailHostCandidates('a--b');
  assert.deepEqual(c, ['a-b.softgarden.io', 'b.softgarden.io']);
  assert.equal(new Set(c).size, c.length);
});

test('a job URL prefers the custom domain, which the .io host may 404', () => {
  const t = { host: 'jdsports.softgarden.io', customDomain: 'jobs.jdsports.de' };
  assert.equal(absoluteJobUrl(t, { url: '/jobs/1/x/' }), 'https://jobs.jdsports.de/jobs/1/x/');
  assert.equal(absoluteJobUrl({ host: 'h', customDomain: null }, { url: '/jobs/1/' }), 'https://h/jobs/1/');
});

test('relative dot segments collapse instead of being stored literally', () => {
  const t = { host: 'x.softgarden.io', customDomain: null };
  assert.equal(absoluteJobUrl(t, { url: './jobs/1/x/' }), 'https://x.softgarden.io/jobs/1/x/');
  assert.equal(absoluteJobUrl(t, { url: '../job/1' }), 'https://x.softgarden.io/job/1');
  assert.equal(absoluteJobUrl(t, { url: 'https://other/job/9' }), 'https://other/job/9');
});

test('a resolved detail host round-trips so later runs skip resolution', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  assert.equal((await getTenants(store, { liveOnly: true }))[0].detailHost, null);
  await setDetailHost(store, 'acme', 'acme.softgarden.io');
  assert.equal((await getTenants(store, { liveOnly: true }))[0].detailHost, 'acme.softgarden.io');
  await store.close();
});

/**
 * The reason a detail fetch failed used to be produced and then dropped,
 * because `jobs` had no column for it -- 1,288 failures in one run left no
 * trace and had to be re-diagnosed against the live sites.
 */
test('a detail failure records why, and succeeding later clears it', async () => {
  const store = await freshStore();
  await upsertTenant(store, tenant, 'career.softgarden.de');
  await upsertJob(store, 'acme', { jobId: '1', title: 'A', detailOk: false, detailNote: 'HTTP 404' });
  let row = await store.get('SELECT detail_ok, detail_note FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(Number(row.detail_ok), 0);
  assert.equal(row.detail_note, 'HTTP 404');

  await upsertJob(store, 'acme', { jobId: '1', title: 'A', descriptionText: 'body', versionId: 7, detailOk: true });
  row = await store.get('SELECT detail_ok, detail_note FROM jobs WHERE job_id = ?', ['1']);
  assert.equal(Number(row.detail_ok), 1);
  assert.equal(row.detail_note, null, 'the note must be cleared once the detail arrives');
  await store.close();
});
