import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, matches, nextRun } from '../src/scheduler.js';

test('the default weekly expression is Mondays 03:17 UTC', () => {
  const sets = parseCron('17 3 * * 1');
  assert.ok(matches(sets, new Date('2026-11-16T03:17:00Z'))); // a Monday
  assert.ok(!matches(sets, new Date('2026-11-17T03:17:00Z'))); // Tuesday
  assert.ok(!matches(sets, new Date('2026-11-16T04:17:00Z'))); // wrong hour
});

test('nextRun lands on the next matching minute', () => {
  const next = nextRun('17 3 * * 1', new Date('2026-11-10T12:00:00Z')); // Tuesday
  assert.equal(next.toISOString(), '2026-11-16T03:17:00.000Z');
});

test('steps, lists and ranges parse', () => {
  assert.ok(matches(parseCron('*/15 * * * *'), new Date('2026-01-01T00:30:00Z')));
  assert.ok(!matches(parseCron('*/15 * * * *'), new Date('2026-01-01T00:31:00Z')));
  assert.ok(matches(parseCron('0 9 * * 1-5'), new Date('2026-11-13T09:00:00Z'))); // Friday
  assert.ok(!matches(parseCron('0 9 * * 1-5'), new Date('2026-11-14T09:00:00Z'))); // Saturday
  assert.ok(matches(parseCron('0 0,12 * * *'), new Date('2026-01-01T12:00:00Z')));
});

test('day-of-week 7 means Sunday, like 0', () => {
  assert.ok(matches(parseCron('0 0 * * 7'), new Date('2026-11-15T00:00:00Z'))); // a Sunday
});

test('malformed expressions are rejected', () => {
  assert.throws(() => parseCron('17 3 * *'), /5 fields/);
  assert.throws(() => parseCron('99 3 * * 1'), /out of range/);
  assert.throws(() => parseCron('a 3 * * 1'), /bad value/);
  assert.throws(() => parseCron('*/0 3 * * 1'), /bad step/);
});
