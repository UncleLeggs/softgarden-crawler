import { config } from '../config.js';
import { requestJson } from '../http.js';
import { log } from '../logger.js';

const EMPTY_FILTERS = { careerLevel: [], category: [], location: [], company: [], partnership: [],
  region: [], country: [], workTime: [], remoteStatus: [], workExperience: [], employmentType: [] };

function buildBody(tenant, { pageSize, pageNumber, withFilters = false }) {
  return {
    userId: tenant.userId, projectId: tenant.projectId, pageId: tenant.pageId,
    locale: tenant.locale || 'de',
    listState: {
      search: '', disableSearchInDescription: false,
      location: { osmLocation: '', range: 25, coords: [] },
      filters: { ...EMPTY_FILTERS },
    },
    isActiveCustomJobPages: true, isUseLayoutsOfSubsidiaries: false,
    filterStatus: { careerLevel: true, category: true, partnership: false, region: false,
      location: true, company: false, country: false, workTime: false, remoteStatus: false,
      workExperience: false, employmentType: false },
    numberOfJobsOnPage: pageSize,
    pageNumber: String(pageNumber),
    isForCurrentLocale: false,
    isGetFilters: withFilters,
  };
}

export async function fetchWidgetPage(tenant, { pageSize = config.pageSize, pageNumber = 1, withFilters = false } = {}) {
  const j = await requestJson(config.widgetApi, {
    method: 'POST', ua: config.browserUA, timeoutMs: 45_000,
    label: `widget ${tenant.slug} p${pageNumber}`,
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/plain, */*',
      origin: `https://${tenant.host}`, referer: `https://${tenant.host}/`,
    },
    body: JSON.stringify(buildBody(tenant, { pageSize, pageNumber, withFilters })),
  });
  return {
    jobs: j.jobs ?? [],
    total: Number.isFinite(j.jobsLength) ? j.jobsLength : null,
    pages: j.pagination?.dataSource?.length ?? null,
  };
}

/**
 * All job listings for a tenant, paginated.
 *
 * The endpoint honours numberOfJobsOnPage well past 200 (a 1049-job tenant
 * returns all of them at 2000), but relying on an unbounded page size is
 * fragile, so we page at config.pageSize and stop on: collected >= total, an
 * empty page, or the reported page count. `jobsLength` is the authoritative
 * total -- the career page's own context.jobAds.count disagrees with it
 * (1058 vs 1049 on one tenant), so never use that for completeness checks.
 */
export async function fetchAllWidgetJobs(tenant, { pageSize = config.pageSize, maxPages = 500 } = {}) {
  const byId = new Map();
  let total = null, pages = null, pageNumber = 1;

  while (pageNumber <= maxPages) {
    const page = await fetchWidgetPage(tenant, { pageSize, pageNumber, withFilters: pageNumber === 1 });
    if (pageNumber === 1) { total = page.total; pages = page.pages; }
    if (!page.jobs.length) break;

    for (const job of page.jobs) {
      const id = job.id ?? job.jobPostingId;
      if (id != null) byId.set(String(id), job);
    }

    if (total != null && byId.size >= total) break;
    // `pages` is only a stop condition when the total is unknown: jobsLength is
    // authoritative, and a page count that contradicts it must not cost us rows.
    if (total == null && pages != null && pageNumber >= pages) break;
    if (page.jobs.length < pageSize) break; // short page = last page
    pageNumber++;
  }

  if (total != null && byId.size !== total) {
    log.warn(`${tenant.slug}: collected ${byId.size} of ${total} listings`);
  }
  return { jobs: [...byId.values()], total: total ?? byId.size, pagesFetched: pageNumber };
}
