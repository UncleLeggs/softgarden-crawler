import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllWidgetJobs } from '../src/sources/widget.js';

/**
 * Pagination is pinned against real measured behaviour: a 1049-job tenant
 * reports jobsLength=1049 and pagination.dataSource.length=11 at pageSize 100,
 * and page 11 is short (49 rows). jobsLength is authoritative -- the career
 * page's own context.jobAds.count disagrees (1058 vs 1049).
 */
function stubFetch(totalJobs, pageSize, { brokenPageCount = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const page = Number(body.pageNumber);
    calls.push({ page, pageSize: body.numberOfJobsOnPage });
    const start = (page - 1) * pageSize;
    const jobs = [];
    for (let i = start; i < Math.min(start + pageSize, totalJobs); i++) jobs.push({ id: 1000 + i, title: `Job ${i}` });
    return new Response(JSON.stringify({
      jobs,
      jobsLength: totalJobs,
      pagination: { dataSource: brokenPageCount ? [1] : Array.from({ length: Math.ceil(totalJobs / pageSize) }, (_, i) => i + 1) },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

const tenant = { slug: 't', host: 't.career.softgarden.de', userId: 'u', projectId: 'p', pageId: 'g', locale: 'de' };
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('collects every job across pages with no duplicates', async () => {
  const calls = stubFetch(1049, 100);
  const { jobs, total, pagesFetched } = await fetchAllWidgetJobs(tenant, { pageSize: 100 });
  assert.equal(total, 1049);
  assert.equal(jobs.length, 1049);
  assert.equal(new Set(jobs.map((j) => j.id)).size, 1049, 'ids must be unique');
  assert.equal(pagesFetched, 11);
  assert.deepEqual(calls.map((c) => c.page), [1,2,3,4,5,6,7,8,9,10,11]);
});

test('a single full page does not trigger a wasted second request', async () => {
  const calls = stubFetch(100, 100);
  const { jobs } = await fetchAllWidgetJobs(tenant, { pageSize: 100 });
  assert.equal(jobs.length, 100);
  assert.equal(calls.length, 1, 'total reached, so stop');
});

test('stops on a short page even if the reported page count lies', async () => {
  stubFetch(150, 100, { brokenPageCount: true });
  const { jobs } = await fetchAllWidgetJobs(tenant, { pageSize: 100 });
  assert.equal(jobs.length, 150);
});

test('an empty tenant costs exactly one request', async () => {
  const calls = stubFetch(0, 100);
  const { jobs, total } = await fetchAllWidgetJobs(tenant, { pageSize: 100 });
  assert.equal(jobs.length, 0);
  assert.equal(total, 0);
  assert.equal(calls.length, 1);
});

test('maxPages caps a runaway tenant', async () => {
  stubFetch(1_000_000, 100);
  const { jobs } = await fetchAllWidgetJobs(tenant, { pageSize: 100, maxPages: 3 });
  assert.equal(jobs.length, 300);
});
