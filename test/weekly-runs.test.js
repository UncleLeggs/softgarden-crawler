import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyRuns } from '../src/dashboard/server.js';

// Rows arrive newest-first, as `ORDER BY id DESC` returns them.
const run = (o) => ({ mode: 'crawl+details', ok: 1, tenants_live: 0, jobs_seen: 0,
  jobs_new: 0, jobs_updated: 0, jobs_closed: 0, details_ok: 0, finished_at: null, ...o });

// The real shape of a week: the scheduled job writes a discover row and a
// crawl row, which used to plot as two points for one Monday.
const MONDAY_WEEK = [
  run({ started_at: '2026-11-16T11:15:44Z', finished_at: '2026-11-16T13:39:47Z',
    jobs_seen: 29759, jobs_new: 744, jobs_updated: 3867, jobs_closed: 177,
    details_ok: 29717, tenants_live: 761 }),
  run({ mode: 'discover', started_at: '2026-11-16T11:09:10Z',
    finished_at: '2026-11-16T11:15:44Z' }),
];

test('a discover pass and a crawl pass are one week, not two points', () => {
  const [w] = weeklyRuns(MONDAY_WEEK);
  assert.equal(weeklyRuns(MONDAY_WEEK).length, 1);
  assert.equal(w.week, '2026-11-16');
  assert.equal(w.runs, 2);
  assert.deepEqual(w.modes, ['crawl+details', 'discover']);
  assert.equal(w.startedAt, '2026-11-16T11:09:10Z');
  assert.equal(w.finishedAt, '2026-11-16T13:39:47Z');
  assert.equal(w.jobsSeen, 29759);
  assert.equal(w.ok, true);
});

test('a Thursday and the following Monday are different weeks', () => {
  const weeks = weeklyRuns([
    ...MONDAY_WEEK,
    run({ started_at: '2026-11-12T11:09:19Z', finished_at: '2026-11-12T12:06:48Z',
      jobs_seen: 29897, jobs_new: 29897 }),
  ]);
  assert.equal(weeks.length, 2);
  // Oldest first, which is the order the chart plots in.
  assert.deepEqual(weeks.map((w) => w.week), ['2026-11-09', '2026-11-16']);
  assert.deepEqual(weeks.map((w) => w.label), ['9 Nov', '16 Nov']);
});

test('events add up across passes but levels take the largest pass', () => {
  // A week that needed a second crawl: summing `seen` would count the 1,246
  // listings of the re-run on top of the full pass that already covered them.
  const [w] = weeklyRuns([
    run({ started_at: '2026-11-12T12:59:39Z', finished_at: '2026-11-12T13:14:49Z',
      jobs_seen: 1246, jobs_new: 3, jobs_updated: 1243, jobs_closed: 3, details_ok: 1246 }),
    run({ started_at: '2026-11-12T11:09:19Z', finished_at: '2026-11-12T12:06:48Z',
      jobs_seen: 29897, jobs_new: 29897, details_ok: 28609 }),
  ]);
  assert.equal(w.jobsSeen, 29897);      // level: the larger pass
  assert.equal(w.detailsOk, 28609);     // level: the larger pass
  assert.equal(w.jobsNew, 29900);       // event: 29,897 + 3
  assert.equal(w.jobsUpdated, 1243);
  assert.equal(w.jobsClosed, 3);
});

test('a week with a run still in flight has no verdict yet', () => {
  const [w] = weeklyRuns([run({ started_at: '2026-11-16T11:08:00Z', ok: null }),
    run({ started_at: '2026-11-16T10:00:00Z', finished_at: '2026-11-16T10:30:00Z', ok: 1 })]);
  assert.equal(w.ok, null);
});

test('one failed pass makes the whole week an error', () => {
  const [w] = weeklyRuns([run({ started_at: '2026-11-16T11:08:00Z', ok: 0,
    finished_at: '2026-11-16T11:10:00Z' }),
    run({ started_at: '2026-11-16T10:00:00Z', finished_at: '2026-11-16T10:30:00Z', ok: 1 })]);
  assert.equal(w.ok, false);
});

test('a Sunday belongs to the week that began on the Monday before it', () => {
  // Sunday 2026-11-15 must not open a week of its own; JS getUTCDay() is 0 on
  // Sunday, so a naive Monday offset puts it six days into the future.
  const weeks = weeklyRuns([run({ started_at: '2026-11-15T23:59:59Z' }),
    run({ started_at: '2026-11-09T00:00:00Z' })]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].week, '2026-11-09');
});

test('only the most recent weeks are kept, newest retained', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(run({ started_at: `2026-${String(1 + Math.floor(i / 4)).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}T03:17:00Z` }));
  }
  const weeks = weeklyRuns(rows, 5);
  assert.equal(weeks.length, 5);
  assert.deepEqual([...weeks].sort((a, b) => (a.week < b.week ? -1 : 1)), weeks);
});

test('a row with no start time is skipped rather than crashing', () => {
  assert.deepEqual(weeklyRuns([run({ started_at: null })]), []);
});
