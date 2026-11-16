import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import { createStore } from '../storage/index.js';
import * as repo from '../repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const json = (res, body, status = 200) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
};

/** Everything the dashboard draws, in one round trip. */
export async function summary(store) {
  const s = await repo.stats(store);
  // Oldest-first for the run-history chart; stats returns newest-first.
  const runs = [...s.lastRuns].reverse().map((r) => ({
    id: Number(r.id), mode: r.mode, startedAt: r.started_at, finishedAt: r.finished_at,
    ok: r.ok == null ? null : Number(r.ok) === 1,
    tenantsLive: Number(r.tenants_live ?? 0), jobsSeen: Number(r.jobs_seen ?? 0),
    jobsNew: Number(r.jobs_new ?? 0), jobsUpdated: Number(r.jobs_updated ?? 0),
    jobsClosed: Number(r.jobs_closed ?? 0), detailsOk: Number(r.details_ok ?? 0),
  }));
  // The newest run that both finished and succeeded is how old the data on the
  // page actually is. `generatedAt` only says when the page was assembled, so
  // showing that as the freshness makes a stale deploy -- or a missed schedule
  // -- indistinguishable from a run that completed a minute ago.
  // Queried rather than taken from lastRuns, which stops at 10: ten consecutive
  // failures would otherwise report no successful run at all, which is a
  // different and false claim from "the data is ten weeks old".
  const lastOk = await store.get(
    `SELECT finished_at FROM runs WHERE ok = 1 AND finished_at IS NOT NULL
     ORDER BY id DESC LIMIT 1`);

  return {
    generatedAt: new Date().toISOString(),
    dataAsOf: lastOk?.finished_at ?? null,
    dialect: store.dialect,
    kpis: {
      tenantsLive: s.tenantsLive, tenantsKnown: s.tenants, jobsOpen: s.jobsOpen,
      jobsClosed: s.jobsClosed, withDescription: s.withDescription,
      brandedDomains: s.brandedDomains, remote: s.remote,
    },
    platforms: s.byPlatform.map((p) => ({ platform: p.platform ?? 'unknown', count: Number(p.n) })),
    topTenants: s.topTenants.map((t) => ({
      slug: t.tenant_slug, company: t.company_name, platform: t.platform, jobs: Number(t.n),
    })),
    countries: s.countries.map((c) => ({ country: c.country, jobs: Number(c.n) })),
    runs,
    alerts: s.recentAlerts.map((a) => ({
      slug: a.tenant_slug, kind: a.kind, detail: a.detail, createdAt: a.created_at,
    })),
    // Why descriptions are missing. The point of recording a reason is that
    // somebody sees it, so it belongs here and not only in the CLI.
    detailFailures: s.detailFailures.map((d) => ({ reason: d.reason, jobs: Number(d.n) })),
  };
}

async function serveStatic(res, urlPath) {
  // Contain path traversal: resolve inside PUBLIC and verify the prefix.
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

export async function startDashboard({ port = config.dashboardPort } = {}) {
  const store = await createStore();

  const server = createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/healthz') return json(res, { ok: true, dialect: store.dialect });
      if (pathname === '/api/summary') return json(res, await summary(store));
      if (pathname === '/api/jobs') {
        const limit = Math.min(Number(searchParams.get('limit') ?? 50) || 50, 500);
        const tenant = searchParams.get('tenant');
        const rows = await store.all(
          `SELECT tenant_slug, job_id, title, city, region, country, remote_status, career_level,
             employment_type, date_posted, detail_ok, url
           FROM jobs WHERE is_open = 1 ${tenant ? 'AND tenant_slug = ?' : ''}
           ORDER BY date_posted DESC LIMIT ?`,
          tenant ? [tenant, limit] : [limit]);
        return json(res, { rows });
      }
      if (req.method === 'GET') return serveStatic(res, pathname);
      res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
    } catch (err) {
      log.error(`dashboard ${pathname}: ${err.message}`);
      json(res, { error: err.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  log.info(`dashboard on http://localhost:${port} (storage: ${store.dialect})`);

  const shutdown = async () => {
    log.info('dashboard shutting down');
    server.close();
    await store.close();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown().then(() => process.exit(0)); });
  return { server, store };
}
