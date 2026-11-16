import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage/index.js';
import { summary } from '../src/dashboard/server.js';

const freshStore = () => createStore({
  url: null, path: join(mkdtempSync(join(tmpdir(), 'sgfresh-')), 'test.db'), migrate: true,
});

const addRun = (store, { mode = 'crawl+details', started, finished = null, ok = null }) =>
  store.run(
    'INSERT INTO runs (mode, started_at, finished_at, ok) VALUES (?, ?, ?, ?)',
    [mode, started, finished, ok]);

// The dashboard footer used to print the request time as the freshness, which
// made a stale deploy look identical to one that had just finished crawling.
test('dataAsOf is the newest run that actually finished and succeeded', async () => {
  const store = await freshStore();
  await addRun(store, { started: '2026-11-02T03:17:00Z', finished: '2026-11-02T04:00:00Z', ok: 1 });
  await addRun(store, { started: '2026-11-09T03:17:00Z', finished: '2026-11-09T04:00:00Z', ok: 1 });
  const s = await summary(store);
  assert.equal(s.dataAsOf, '2026-11-09T04:00:00Z');
  await store.close();
});

test('a run still in flight does not advance the freshness', async () => {
  const store = await freshStore();
  await addRun(store, { started: '2026-11-09T03:17:00Z', finished: '2026-11-09T04:00:00Z', ok: 1 });
  // Exactly the state during a weekly crawl: newest row, no finish, no verdict.
  await addRun(store, { started: '2026-11-16T11:08:00Z', finished: null, ok: null });
  const s = await summary(store);
  assert.equal(s.dataAsOf, '2026-11-09T04:00:00Z');
  await store.close();
});

test('a failed run does not advance the freshness', async () => {
  const store = await freshStore();
  await addRun(store, { started: '2026-11-09T03:17:00Z', finished: '2026-11-09T04:00:00Z', ok: 1 });
  await addRun(store, { started: '2026-11-16T03:17:00Z', finished: '2026-11-16T03:19:00Z', ok: 0 });
  const s = await summary(store);
  assert.equal(s.dataAsOf, '2026-11-09T04:00:00Z');
  await store.close();
});

test('dataAsOf is null when nothing has ever completed, not the current time', async () => {
  const store = await freshStore();
  await addRun(store, { started: '2026-11-16T11:08:00Z', finished: null, ok: null });
  const s = await summary(store);
  assert.equal(s.dataAsOf, null);
  // generatedAt still exists, but it describes the response, not the data.
  assert.ok(s.generatedAt);
  await store.close();
});

// lastRuns stops at 10 rows. Reading the freshness out of that window would
// report "nothing ever completed" for a database that plainly has a success in
// it -- the same class of false claim this field exists to remove.
test('a success older than the ten-run window is still found', async () => {
  const store = await freshStore();
  await addRun(store, { started: '2026-01-05T03:17:00Z', finished: '2026-01-05T04:00:00Z', ok: 1 });
  for (let i = 1; i <= 12; i++) {
    await addRun(store, { started: `2026-02-${String(i).padStart(2, '0')}T03:17:00Z`,
      finished: `2026-02-${String(i).padStart(2, '0')}T03:19:00Z`, ok: 0 });
  }
  const s = await summary(store);
  assert.equal(s.dataAsOf, '2026-01-05T04:00:00Z');
  await store.close();
});
