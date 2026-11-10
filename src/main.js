import { config } from './config.js';
import { log } from './logger.js';
import * as db from './db.js';
import { runDiscover, runCrawl, runDetails, runWeekly } from './pipeline.js';
import { schedule, nextRun } from './scheduler.js';
import { exportCsv, exportNdjson } from './export.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const num = (name, d) => { const v = flag(name); return v === undefined || v === true ? d : Number(v); };

const USAGE = `softgarden-crawler

  discover            Find customer slugs in Common Crawl and detect each one's front end
  crawl               Crawl listings for every live tenant (+ details unless --no-details)
  details             Backfill details for jobs that have none
  weekly              discover + crawl with details (what the schedule runs)
  schedule            Stay running and execute "weekly" on SG_CRON (default: Mon 03:17 UTC)
  stats               Print database summary
  alerts              Print recent alerts
  export              Write jobs/tenants to CSV or NDJSON

Options
  --crawls <n>        Common Crawl snapshots to merge (default ${config.crawls})
  --no-details        Skip per-job detail fetching during crawl
  --slug <a,b>        Restrict crawl to these tenants
  --limit <n>         details: how many jobs to backfill (default 500)
  --detail-limit <n>  crawl: cap details per tenant (0 = all)
  --what <jobs|tenants>  export: which table (default jobs)
  --format <csv|ndjson>  export: output format (default csv)
  --out <path>        export: destination file
  --open-only         export: only open jobs (default true for jobs)

Environment: SG_DB, SG_CONCURRENCY, SG_RPS, SG_CRON, SG_PAGE_SIZE, SG_LOG_LEVEL,
SG_DROP_THRESHOLD, SG_CACHE_DIR, SG_USER_AGENT  (see .env.example)
`;

async function main() {
  switch (cmd) {
    case 'discover': {
      await runDiscover({ crawls: num('crawls', config.crawls) });
      break;
    }
    case 'crawl': {
      const slugs = flag('slug') && flag('slug') !== true ? String(flag('slug')).split(',') : null;
      await runCrawl({
        withDetails: !argv.includes('--no-details'),
        slugs,
        detailLimit: num('detail-limit', config.detailLimit),
      });
      break;
    }
    case 'details': {
      await runDetails({ limit: num('limit', 500) });
      break;
    }
    case 'weekly': {
      await runWeekly({ crawls: num('crawls', config.crawls) });
      break;
    }
    case 'schedule': {
      const controller = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { log.info(`${sig} received; shutting down`); controller.abort(); });
      }
      await schedule(config.cron, () => runWeekly({ crawls: config.crawls }), { signal: controller.signal });
      break;
    }
    case 'stats': {
      const s = db.stats(db.openDb());
      console.log(`\nTenants      ${s.tenantsLive} live / ${s.tenants} known`);
      for (const r of s.byPlatform) console.log(`  ${String(r.platform).padEnd(16)} ${r.n}`);
      console.log(`Jobs         ${s.jobsOpen} open, ${s.jobsClosed} closed`);
      console.log(`Descriptions ${s.withDescription}/${s.jobsOpen} open jobs`);
      if (s.countries.length) console.log(`Countries    ${s.countries.map((c) => `${c.country}:${c.n}`).join('  ')}`);
      console.log('\nTop tenants by open jobs');
      for (const t of s.topTenants) {
        console.log(`  ${String(t.n).padStart(5)}  ${t.tenant_slug.padEnd(34)} ${(t.company_name ?? '').slice(0, 40)}`);
      }
      console.log('\nRecent runs');
      for (const r of s.lastRuns) {
        console.log(`  #${r.id} ${r.mode.padEnd(14)} ${r.started_at} ok=${r.ok ?? '-'} seen=${r.jobs_seen} new=${r.jobs_new} closed=${r.jobs_closed} details=${r.details_ok}`);
      }
      if (s.openAlerts.length) {
        console.log('\nRecent alerts');
        for (const a of s.openAlerts) console.log(`  ${a.created_at} ${a.tenant_slug} ${a.kind} ${a.detail}`);
      }
      console.log(`\nNext scheduled run: ${nextRun(config.cron).toISOString()} (SG_CRON="${config.cron}")\n`);
      break;
    }
    case 'alerts': {
      const d = db.openDb();
      const rows = d.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 100').all();
      if (!rows.length) { console.log('no alerts'); break; }
      for (const a of rows) console.log(`${a.created_at}  ${a.tenant_slug.padEnd(34)} ${a.kind.padEnd(16)} ${a.detail}`);
      break;
    }
    case 'export': {
      const d = db.openDb();
      const what = flag('what', 'jobs');
      const format = flag('format', 'csv');
      const out = flag('out', `out/${what}.${format === 'ndjson' ? 'ndjson' : 'csv'}`);
      const rows = what === 'tenants'
        ? d.prepare('SELECT * FROM tenants ORDER BY slug').all()
        : d.prepare(`SELECT * FROM jobs ${argv.includes('--all') ? '' : 'WHERE is_open=1'} ORDER BY tenant_slug, job_id`).all();
      const n = format === 'ndjson' ? await exportNdjson(rows, out) : await exportCsv(rows, out);
      console.log(`wrote ${n} ${what} rows to ${out}`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => { log.error(err); process.exit(1); });
