import { env } from 'node:process';

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  dbPath: env.SG_DB || 'data/softgarden.db',
  // Set SG_DB_URL to use Postgres instead of SQLite; SQLite needs no install.
  dbUrl: env.SG_DB_URL || null,
  dashboardPort: num(env.SG_PORT, 8080),
  cacheDir: env.SG_CACHE_DIR || '.cc-cache',

  // The career hosts sit behind Cloudflare and start returning 429 above ~3
  // concurrent requests. These defaults are deliberately conservative.
  concurrency: num(env.SG_CONCURRENCY, 3),
  rps: num(env.SG_RPS, 4),

  crawls: num(env.SG_CRAWLS, 1),
  cron: env.SG_CRON || '17 3 * * 1', // Mondays 03:17 UTC
  dropThreshold: num(env.SG_DROP_THRESHOLD, 0.3),

  // Common Crawl asks for a descriptive agent. Career sites serve different
  // markup to non-browser agents, so those requests need a browser UA.
  scriptUA: env.SG_USER_AGENT || 'softgarden-crawler/1.0 (+https://github.com/example/softgarden-crawler)',
  browserUA: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',

  dataHost: 'https://data.commoncrawl.org',
  collinfo: 'https://index.commoncrawl.org/collinfo.json',
  widgetApi: 'https://pcw-api.softgarden.de/widgets/job-list/job-ads',

  pageSize: num(env.SG_PAGE_SIZE, 100), // widget rows per page
  detailLimit: num(env.SG_DETAIL_LIMIT, 0), // 0 = no cap
};

// SURT keys are reversed-domain: acme.career.softgarden.de -> de,softgarden,career,acme)
export const TARGETS = [
  { surt: 'de,softgarden,career,', domain: 'career.softgarden.de' },
  { surt: 'io,softgarden,', domain: 'softgarden.io' },
];

// Subdomains that belong to Softgarden itself, not to customers.
export const IGNORE_SLUGS = new Set(['www', 'api', 'app', 'cdn', 'static', 'assets', 'pcw-api',
  'career', 'dev', 'help', 'status', 'mail', 'certificate', 'referral', 'social-apply']);
