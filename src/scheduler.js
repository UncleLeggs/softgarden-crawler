import { log } from './logger.js';

/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), UTC.
 * Supports *, lists (1,3), ranges (1-5), steps (*\/15 and 1-9/2). Day-of-week
 * 0 and 7 both mean Sunday. No seconds field, no @weekly aliases -- this exists
 * so the scheduler has no dependency, not to reimplement cron.
 */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.map((field, i) => parseField(field, ranges[i][0], ranges[i][1], i === 4));
}

function parseField(field, min, max, isDow) {
  const allowed = new Set();
  for (const chunk of field.split(',')) {
    const [body, stepRaw] = chunk.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${chunk}"`);

    let lo, hi;
    if (body === '*') { lo = min; hi = max; }
    else if (body.includes('-')) {
      const [a, b] = body.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`bad range "${body}"`);
      lo = a; hi = b;
    } else {
      const v = Number(body);
      if (!Number.isInteger(v)) throw new Error(`bad value "${body}"`);
      lo = hi = v;
    }
    for (let v = lo; v <= hi; v += step) {
      const norm = isDow && v === 7 ? 0 : v;
      if (norm < min || norm > max) throw new Error(`value ${v} out of range ${min}-${max}`);
      allowed.add(norm);
    }
  }
  return allowed;
}

export function matches(sets, date) {
  const [min, hr, dom, mon, dow] = sets;
  return min.has(date.getUTCMinutes()) && hr.has(date.getUTCHours())
    && dom.has(date.getUTCDate()) && mon.has(date.getUTCMonth() + 1)
    && dow.has(date.getUTCDay());
}

export function nextRun(expr, from = new Date()) {
  const sets = parseCron(expr);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    from.getUTCHours(), from.getUTCMinutes(), 0, 0));
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  // Four years covers every Feb-29 case.
  for (let i = 0; i < 366 * 24 * 60 * 4; i++) {
    if (matches(sets, d)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`cron "${expr}" never fires`);
}

/**
 * Long-running scheduler. Sleeps until the next match, runs the task, and
 * never overlaps runs -- if a crawl overruns its window, the next tick is
 * skipped rather than queued.
 */
export async function schedule(expr, task, { signal } = {}) {
  parseCron(expr); // fail fast on a bad expression
  log.info(`scheduler armed: "${expr}" (UTC), next run ${nextRun(expr).toISOString()}`);
  let running = false;

  while (!signal?.aborted) {
    const next = nextRun(expr);
    const waitMs = next.getTime() - Date.now();
    await sleepAbortable(Math.max(1000, waitMs), signal);
    if (signal?.aborted) break;

    if (running) { log.warn('previous run still going; skipping this tick'); continue; }
    running = true;
    const started = Date.now();
    try {
      log.info(`scheduled run starting (${next.toISOString()})`);
      await task();
      log.info(`scheduled run finished in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      log.error(`scheduled run failed: ${err.message}`);
    } finally {
      running = false;
    }
  }
  log.info('scheduler stopped');
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
