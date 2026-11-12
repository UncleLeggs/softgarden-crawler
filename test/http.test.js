import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../src/http.js';

/**
 * These two tests exist because the live run exposed what unit tests had not:
 * ~31,000 requests went out in 3,450s -- about 9/s -- while SG_RPS was 4. The
 * limiter was pacing each *batch* of concurrent callers rather than each
 * request, so the real ceiling was concurrency x rps.
 */
test('the global rate is rps, not concurrency x rps', async () => {
  const rps = 20;          // 50ms apart
  const n = 8;
  const lim = new Limiter(4, rps);  // 4 concurrent: the old code fired in batches of 4
  const fired = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, () => lim.run(async () => { fired.push(Date.now() - t0); })));

  assert.equal(fired.length, n);
  // n requests at 50ms spacing cannot finish sooner than (n-1) gaps.
  const floor = (n - 1) * (1000 / rps);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= floor * 0.9,
    `${n} requests at ${rps}/s took ${elapsed}ms, expected >= ~${floor}ms. `
    + 'A faster time means the limiter is pacing batches, not requests.');

  // And no two starts should be bunched at the same instant.
  fired.sort((a, b) => a - b);
  const gaps = fired.slice(1).map((t, i) => t - fired[i]);
  assert.ok(gaps.every((g) => g >= 1000 / rps * 0.5),
    `starts were bunched: gaps ${JSON.stringify(gaps)}ms at ${rps}/s`);
});

test('in-flight requests never exceed the concurrency ceiling', async () => {
  const lim = new Limiter(3, 0); // no rate gap: isolate the concurrency gate
  let active = 0, peak = 0;
  // Stagger arrivals so newcomers show up while others are waiting -- that is
  // the interleaving in which a woken waiter could barge past the ceiling.
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, i));
    return lim.run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  }));
  assert.equal(peak, 3, `peak in-flight was ${peak}, ceiling is 3`);
});

test('rps 0 disables pacing but keeps the concurrency ceiling', async () => {
  const lim = new Limiter(2, 0);
  assert.equal(lim.minGap, 0);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, () => lim.run(async () => {})));
  assert.ok(Date.now() - t0 < 200, 'with rps 0 there should be no added delay');
});
